// Copyright (C) Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0

// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/**
 * Wrapper around `polkadot-app-deploy`'s `deploy()` that:
 *   - intercepts polkadot-app-deploy's `console.log` stream and turns it into
 *     typed progress events for the TUI,
 *   - surfaces polkadot-app-deploy's returned artifact IDs unchanged.
 *
 * Note: we deliberately do NOT pass `jsMerkle: true` — polkadot-app-deploy's
 * pure-JS merkleizer drops DAG-PB structural blocks under the `rawLeaves`
 * + `wrapWithDirectory` path we use, leaving deployed sites unparseable.
 * We rely on the Kubo binary path (installed by `dot login`) until upstream
 * fixes `merkleizeJS`. See the call site below and CLAUDE.md for context.
 *
 * All retry, nonce recovery, pool authorization, and DAG-PB verification
 * stays inside polkadot-app-deploy — we do not reimplement any of it here.
 */

import {
    deploy as bulletinDeploy,
    type DeployContent,
    type DeployOptions,
    type DeployResult,
} from "bulletin-deploy";
import { DeployLogParser, type DeployLogEvent } from "./progress.js";
import { getChainConfig, type Env } from "../../config.js";
import { isIpfsMigrationError } from "../toolchain.js";

export interface StorageDeployOptions {
    /**
     * What to upload — a filesystem path (file or directory) or raw bytes.
     * Matches polkadot-app-deploy's `DeployContent` type.
     */
    content: DeployContent;
    /**
     * DotNS domain name (without `.dot`) or `null` to skip DotNS registration
     * (used for the metadata JSON upload in the playground flow).
     */
    domainName: string | null;
    /**
     * Auth options forwarded to polkadot-app-deploy. Usually produced by
     * `resolveSignerSetup()` merged with `resolveStorageSignerOptions()`.
     * Never `{}`: dev mode pins an explicit `mnemonic` + dev `storageSigner`
     * (empty options make polkadot-app-deploy 0.8.x resolve the persisted phone
     * session — see signerMode.ts). `storageSigner` (the BulletInAllowance
     * slot key in phone mode, the dev / `--suri` key otherwise) takes
     * precedence over `signer` for Bulletin storage routing inside
     * polkadot-app-deploy — chunk txs are too large for phone signing.
     */
    auth: Pick<
        DeployOptions,
        "signer" | "signerAddress" | "mnemonic" | "storageSigner" | "storageSignerAddress"
    >;
    /** Emits progress events derived from polkadot-app-deploy's log output. */
    onLogEvent?: (event: DeployLogEvent) => void;
    /** Target environment — currently only `testnet` is supported. */
    env?: Env;
    /** Extra telemetry attributes merged into polkadot-app-deploy's deploy span. */
    attributes?: Record<string, string>;
}

type EnvironmentAwareDeployOptions = DeployOptions & {
    env?: Env;
    assetHubEndpoints?: string[];
};

export async function runStorageDeploy(options: StorageDeployOptions): Promise<DeployResult> {
    const cfg = getChainConfig(options.env);
    const parser = new DeployLogParser();
    const restore = interceptConsoleLog(options.onLogEvent, parser);

    try {
        const deployOptions: EnvironmentAwareDeployOptions = {
            // Intentionally NOT setting `jsMerkle: true` — polkadot-app-deploy's
            // pure-JS merkleizer (`merkleizeJS`) produces CARs that are
            // missing their DAG-PB structural blocks (directory + file nodes)
            // because `blockstore-core/memory`'s `getAll()` iterator drops
            // them in the `rawLeaves: true` + `wrapWithDirectory: true` code
            // path. We verified this against a real deployed CAR: 157 blocks,
            // zero DAG-PB, declared root not in the blocks — polkadot-desktop
            // parses zero files.
            //
            // Falling back to the Kubo binary path (default) produces a
            // complete, parseable CAR. `dot login` installs `ipfs` so the
            // binary is present on any machine that finished setup.
            //
            // Revisit when polkadot-app-deploy's `merkleizeJS` is fixed upstream
            // — then flip `jsMerkle: true` back on for the WebContainer (RevX)
            // story. See `src/utils/deploy/playground.ts` for an ongoing
            // WebContainer-safe path for metadata upload.
            env: cfg.env,
            rpc: cfg.bulletinRpc,
            assetHubEndpoints: [cfg.assetHubRpc],
            ...options.auth,
            attributes: options.attributes,
        };
        return await bulletinDeploy(options.content, options.domainName, deployOptions);
    } catch (err) {
        throw remapIpfsMigrationError(err);
    } finally {
        restore();
    }
}

/**
 * Actionable message shown when the deploy's internal `ipfs add` aborts because
 * the local Kubo repo predates the installed binary's format. We don't migrate
 * mid-deploy (that mutates `~/.ipfs` behind the user's back) — we tell them the
 * one-time command. `playground login` migrates it automatically on its next
 * run; see `toolchain.ts::ipfsRepoNeedsMigration`.
 */
export const IPFS_MIGRATION_MESSAGE =
    "Your local IPFS repo needs a one-time migration before it can be used for uploads. " +
    "Run `ipfs repo migrate` (or re-run `playground login`), then try the deploy again.";

/**
 * Replace Kubo's cryptic `Command failed: ipfs add … repo needs migration`
 * with an actionable instruction. Non-migration errors pass through unchanged.
 * The migration marker is classified by `toolchain.ts::isIpfsMigrationError`,
 * the single source of truth shared with `playground login`'s setup probe.
 */
function remapIpfsMigrationError(err: unknown): unknown {
    if (!isIpfsMigrationError(err)) return err;
    return new Error(IPFS_MIGRATION_MESSAGE, { cause: err });
}

/**
 * Replace `console.log` / `console.error` / `console.warn` with a shim that
 * feeds each line into the progress parser. Returns a `restore()` that puts
 * the originals back — always call it from a `finally` block.
 *
 * We silence the direct prints because the TUI renders its own view derived
 * from the parsed events. If there is no `onLogEvent` sink we still parse
 * but emit nothing, so pool/DotNS log noise doesn't leak into the Ink render.
 *
 * `DOT_DEPLOY_VERBOSE=1`: in addition to parsing, write every polkadot-app-deploy
 * log line to stderr prefixed with a `[+<seconds>s]` timestamp. This is the
 * diagnostic path for OOM / freeze reports — you get the exact last line
 * polkadot-app-deploy managed to print before the process froze, plus timing for
 * every chunk state transition (`broadcasting` → `included` → `finalized`).
 * Combine with `DOT_MEMORY_TRACE=1` to correlate log events with RSS growth.
 */
function interceptConsoleLog(
    onEvent: ((event: DeployLogEvent) => void) | undefined,
    parser: DeployLogParser,
): () => void {
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    const verbose = process.env.DOT_DEPLOY_VERBOSE === "1";
    const started = Date.now();

    const feed = (parts: unknown[]) => {
        const combined = parts.map((p) => (typeof p === "string" ? p : String(p))).join(" ");
        if (verbose) {
            const elapsed = ((Date.now() - started) / 1000).toFixed(1);
            process.stderr.write(`[+${elapsed}s] ${combined}\n`);
        }
        for (const line of combined.split("\n")) {
            const event = parser.feed(line);
            if (event && onEvent) onEvent(event);
        }
    };

    console.log = (...args: unknown[]) => feed(args);
    console.warn = (...args: unknown[]) => feed(args);
    // polkadot-app-deploy only prints errors on the sad path; keep them visible on
    // stderr so diagnostics don't disappear if something unexpected happens.
    // In verbose mode `feed()` already wrote to stderr — skip the double-print.
    console.error = (...args: unknown[]) => {
        feed(args);
        if (!verbose) {
            originalError.apply(console, args as Parameters<typeof console.error>);
        }
    };

    return () => {
        console.log = originalLog;
        console.warn = originalWarn;
        console.error = originalError;
    };
}
