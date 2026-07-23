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
 * Own playground-registry publish flow.
 *
 * We upload the metadata JSON through Bulletin `TransactionStorage.store`
 * with the product-scoped RFC-0010 Bulletin allowance account, then call
 * `registry.publish(...)` (with the `is_dev_signer` flag) ourselves via
 * `getRegistryContract()`.
 * Phone publishing is signed by the user's product account so the contract's
 * `env::caller()` matches their address. Dev publishing is signed by the dev
 * account and may pass a claimed owner for the playground-app "myApps" view.
 *
 * We deliberately do NOT use `polkadot-app-deploy.deploy()` for the metadata
 * upload: `deploy()` unconditionally runs a DotNS `register()` +
 * `setContenthash()` on whatever name you give it (or a randomly generated
 * `test-domain-*` when you pass `null`). That second DotNS pass is wasteful
 * and has been observed to revert with opaque contract errors.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { calculateCid } from "@parity/product-sdk-cloud-storage";
import { submitAndWatch, withRetry } from "@parity/product-sdk-tx";
import { unwrapTx } from "../tx.js";
import { getRegistryContract } from "../registry.js";
import { getConnection } from "../connection.js";
import { getChainConfig, type Env } from "../../config.js";
import { getBulletinDescriptor } from "../descriptors.js";
import { captureWarning, withSpan, errorMessage } from "../../telemetry.js";
import {
    asCloudStorageApi,
    getBulletinAllowanceSigner,
    isInvalidPaymentError,
    type AllowancePrompt,
} from "../allowances/bulletin.js";
import { BULLETIN_WS_HEARTBEAT_MS } from "../bulletinWs.js";
import { validateDomainLabel } from "./dotnsRules.js";
import type { ResolvedSigner } from "../signer.js";
import type { DeployLogEvent } from "./progress.js";

const MAX_REGISTRY_RETRIES = 3;
const REGISTRY_RETRY_DELAY_MS = 6_000;

export interface PublishToPlaygroundOptions {
    /** The DotNS label (with or without `.dot`). */
    domain: string;
    /**
     * Signer that submits the registry publish tx. In phone mode this is the
     * user's session signer and calls `publish(...)` (caller becomes owner).
     * In dev mode this is a dev signer (Alice / `--suri`) and calls
     * `publish(...)` with `is_dev_signer: true`; `claimedOwnerH160` carries the
     * H160 to record as owner.
     */
    publishSigner: ResolvedSigner;
    /**
     * Optional H160 to record as the app owner via the contract's `owner`
     * parameter. Used by dev mode + active session so the app shows in the
     * user's MyApps view even though the tx is signed by Alice. `null` or
     * omitted ⇒ contract defaults to caller (`publishSigner.address`
     * translated to H160), which is correct for phone mode and pure-dev
     * throwaway.
     */
    claimedOwnerH160?: `0x${string}` | null;
    /** Repository URL to record in metadata. `null` = omit the field entirely. */
    repositoryUrl: string | null;
    /**
     * Single playground tag to record in metadata (one of `PLAYGROUND_TAGS`).
     * Drives the playground-app tag filter. `null` or omitted ⇒ the app is
     * published untagged (the field is left out of the JSON). Untagged is a
     * safe default, so — unlike the `moddable` decision — this is not forced
     * on callers.
     */
    tag?: string | null;
    /** Project root. Used to look for a `README.md` to inline into metadata. */
    cwd?: string;
    /** Progress sink for the metadata-upload sub-step. */
    onLogEvent?: (event: DeployLogEvent) => void;
    /**
     * Surfaces "check your phone" UI when the metadata upload needs an
     * RFC-0010 allocation tap (the first-use slot grant).
     * Without it the phone shows an approval dialog the TUI never mentions.
     */
    onAllowancePrompt?: AllowancePrompt;
    /** Target environment. */
    env?: Env;
    /**
     * If true, publish with visibility=0 (private) so the app is only visible
     * to its owner in the playground. Defaults to public (visibility=1).
     */
    isPrivate?: boolean;
    /**
     * Whether the published source is moddable (a public GitHub origin is
     * recorded in metadata and listed in the `dot mod` picker). The contract
     * records this bit so the playground-app filter doesn't need to fetch
     * each metadata JSON to know.
     */
    isModdable?: boolean;
    /**
     * Domain (`<label>.dot`) the user modded this app from, or `""`/omitted if
     * this is a first-party publish. Recorded on-chain so the playground-app
     * can render a "modded from" badge AND so the contract credits the SOURCE
     * app's owner the mod XP.
     *
     * When set to a non-empty, shape-valid domain, this is AUTHORITATIVE — it
     * takes precedence over any `moddedFrom` read from `dot.json`, and drives
     * BOTH the metadata JSON field and the on-chain lineage arg. A caller that
     * just performed the mod (the `dot mod` TUI captures it in `dot.json`; an
     * SDK consumer like RevX clones the source itself and passes it here) knows
     * the true immediate parent, whereas `dot.json`'s field can be a STALE value
     * that merely rode along in a cloned repo. The value is canonicalized via
     * `normalizeModdedFrom`, so an empty/whitespace/invalid value falls through
     * to `dot.json` ("not provided", not "no parent"). See the precedence note
     * in `publishToPlayground` (playground-app#335).
     */
    moddedFrom?: string;
    /**
     * True when the publish is signed by the dev signer (Alice / `--suri`)
     * rather than the user's session. Dev publishes set the ungated
     * `is_dev_signer` flag on `publish(...)`, which records the app without
     * awarding deploy XP or source-app mod XP.
     */
    isDevSigner?: boolean;
}

export interface PublishToPlaygroundResult {
    /** CID of the metadata JSON on Bulletin. */
    metadataCid: string;
    /** Fully-qualified domain string recorded in the registry. */
    fullDomain: string;
    /** Effective metadata payload that got uploaded. */
    metadata: Record<string, string>;
}

/**
 * Cap on inlined README bytes. The metadata JSON is fetched once per listed
 * app in the playground feed; an unbounded README from any single publisher
 * would bloat every other user's feed load. 20 KB comfortably covers typical
 * repo READMEs and keeps a 20-app feed batch under ~400 KB.
 */
export const README_CAP_BYTES = 20 * 1024;

export type ReadmeStatus =
    | { kind: "ok"; content: string; size: number }
    | { kind: "oversized"; size: number }
    | { kind: "missing" };

/**
 * Look for a README at the project root. Returns a tagged union so callers
 * can both decide whether to inline and surface an oversize warning before
 * the user commits to deploy.
 *
 * We enumerate the directory rather than trying `README.md` verbatim so the
 * match is case-insensitive on every filesystem — macOS/Windows resolve
 * mismatched case implicitly, but Linux CI does not, and a repo with
 * `readme.md` on GitHub would otherwise be silently skipped.
 */
export function readReadme(cwd: string, capBytes = README_CAP_BYTES): ReadmeStatus {
    let entries: string[];
    try {
        entries = readdirSync(cwd);
    } catch {
        return { kind: "missing" };
    }
    const match = entries.find((name) => /^readme\.md$/i.test(name));
    if (!match) return { kind: "missing" };
    const path = join(cwd, match);
    let size: number;
    try {
        size = statSync(path).size;
    } catch {
        return { kind: "missing" };
    }
    if (size > capBytes) return { kind: "oversized", size };
    try {
        const content = readFileSync(path, "utf8");
        return { kind: "ok", content, size };
    } catch {
        return { kind: "missing" };
    }
}

/** Strip `.dot` suffix if present, then validate against canonical DotNS rules. */
export function normalizeDomain(domain: string): { label: string; fullDomain: string } {
    const label = domain.replace(/\.dot$/i, "");
    const result = validateDomainLabel(label);
    if (!result.ok) {
        throw new Error(`Invalid domain "${domain}" — ${result.reason}.`);
    }
    return { label, fullDomain: `${label}.dot` };
}

/**
 * Reads the currently-checked-out branch from a git workspace.
 *
 * Returns `null` for detached HEAD or any error (no `.git`, missing `git`,
 * permission issues). Callers treat `null` as "no branch metadata to record"
 * — `dot mod` defaults to `main` for that case, which matches the GitHub
 * default-branch convention.
 */
export function readGitBranch(cwd: string): string | null {
    try {
        const out = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
            cwd,
            encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe"],
        }).trim();
        // `git rev-parse --abbrev-ref HEAD` returns the literal string "HEAD"
        // when in detached-HEAD state. We deliberately don't write that to
        // metadata — it would mislead `dot mod` consumers into trying to
        // download a ref called "HEAD".
        if (!out || out === "HEAD") return null;
        return out;
    } catch {
        return null;
    }
}

export function buildMetadata(input: {
    repositoryUrl: string | null;
    branch: string | null;
    readme: ReadmeStatus | null;
    moddedFrom: string | null;
    /**
     * Single playground tag (one of `PLAYGROUND_TAGS`) the user picked at
     * deploy time, or `null` to omit. The playground-app filters apps by exact
     * match on this `tag` field — see `./tags.ts`.
     */
    tag: string | null;
}): Record<string, string> {
    const meta: Record<string, string> = {};
    if (input.repositoryUrl) meta.repository = input.repositoryUrl;
    // `branch` is recorded ONLY alongside `repositoryUrl` — without a repo
    // URL the branch is meaningless, and writing it standalone would just
    // bloat the JSON.
    if (input.repositoryUrl && input.branch) meta.branch = input.branch;
    if (input.readme && input.readme.kind === "ok") meta.readme = input.readme.content;
    if (input.moddedFrom) meta.moddedFrom = input.moddedFrom;
    if (input.tag) meta.tag = input.tag;
    return meta;
}

/**
 * Canonicalizes a caller-supplied `moddedFrom` to `<label>.dot`, or returns
 * `null` for any unusable value (omitted, empty/whitespace, or a string that
 * doesn't pass `normalizeDomain`). BOTH the explicit `moddedFrom` option and
 * the `dot.json` field flow through here so a non-canonical or invalid source
 * domain can never reach the on-chain lineage edge — the contract matches the
 * source app by its canonical domain string, so `"foo"` and `"Foo.dot"` would
 * silently miss the XP credit. See playground-app#335.
 */
export function normalizeModdedFrom(value: string | null | undefined): string | null {
    const trimmed = value?.trim();
    if (!trimmed) return null;
    try {
        return normalizeDomain(trimmed).fullDomain;
    } catch {
        return null;
    }
}

/**
 * Returns the canonical `<label>.dot` form, or `null` for any unusable value
 * (missing file, parse fail, non-string, or a value that doesn't pass
 * `normalizeDomain`). `dot.json` is user-editable, so we shape-validate before
 * publishing the field on-chain — the frontend still escapes on render, but
 * we don't propagate garbage into shared metadata.
 */
export function readModdedFrom(cwd: string): string | null {
    const path = join(cwd, "dot.json");
    let raw: string;
    try {
        raw = readFileSync(path, "utf8");
    } catch {
        return null;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!parsed || typeof parsed !== "object") return null;
    const value = (parsed as Record<string, unknown>).moddedFrom;
    if (typeof value !== "string") return null;
    return normalizeModdedFrom(value);
}

export async function publishToPlayground(
    options: PublishToPlaygroundOptions,
): Promise<PublishToPlaygroundResult> {
    const { label, fullDomain } = normalizeDomain(options.domain);

    const readme = options.cwd ? readReadme(options.cwd) : null;
    // Persist the deploying branch alongside the repo URL so `dot mod` can
    // construct the codeload tarball URL without a separate
    // `api.github.com/repos/{o}/{r}` lookup. This eliminates one anonymous
    // GitHub API call per `dot mod` invocation — see
    // `src/commands/mod/SetupScreen.tsx`.
    const branch = options.cwd && options.repositoryUrl ? readGitBranch(options.cwd) : null;
    // Resolve the mod source ONCE, canonicalized, and use it for BOTH the
    // metadata JSON and the on-chain arg so the two can never diverge. An
    // explicit `options.moddedFrom` (the SDK/RevX path, which knows the true
    // immediate parent) wins over the `dot.json` value when it is a non-empty,
    // shape-valid domain; an empty/whitespace/invalid explicit value falls
    // through to `dot.json` ("not provided", not "no parent"). Both sources go
    // through `normalizeModdedFrom`, so the on-chain lineage edge always lands
    // on the source app's canonical `<label>.dot` — see playground-app#335.
    const dotJsonModdedFrom = options.cwd ? readModdedFrom(options.cwd) : null;
    const moddedFrom = normalizeModdedFrom(options.moddedFrom) ?? dotJsonModdedFrom;
    const metadata = buildMetadata({
        repositoryUrl: options.repositoryUrl,
        branch,
        readme,
        moddedFrom,
        tag: options.tag ?? null,
    });

    const metadataBytes = new Uint8Array(Buffer.from(JSON.stringify(metadata), "utf8"));

    options.onLogEvent?.({ kind: "info", message: "Uploading playground metadata to Bulletin…" });
    // Storage-only upload using product-sdk Bulletin CID helpers. Submits
    // `TransactionStorage.store` directly — no DotNS, no `register()`, no
    // `setContenthash()`.
    //
    // We spin up a DEDICATED Bulletin client with a 300 s WS heartbeat rather
    // than reusing the shared one from `getConnection()`. The shared client
    // uses polkadot-api's 40 s default which is shorter than a single-tx
    // submission and manifests as `WS halt (3)` mid-upload.
    const metadataCid = await withSpan(
        "cli.deploy.playground.metadata-upload",
        "upload playground metadata",
        { "cli.deploy.domain": fullDomain },
        async () => {
            const cfg = getChainConfig(options.env);
            const bulletinClient = createClient(
                getWsProvider([cfg.bulletinRpc, ...cfg.bulletinRpcFallbacks], {
                    heartbeatTimeout: BULLETIN_WS_HEARTBEAT_MS,
                }),
            );
            try {
                const bulletinApi = bulletinClient.getTypedApi(getBulletinDescriptor(cfg.env));
                const cid = (await calculateCid(metadataBytes)).toString();
                const storeTx = bulletinApi.tx.TransactionStorage.store({ data: metadataBytes });
                let storageSigner = await getBulletinAllowanceSigner({
                    publishSigner: options.publishSigner,
                    bulletinApi: asCloudStorageApi(bulletinApi),
                    onPrompt: options.onAllowancePrompt,
                });
                try {
                    await withRetry(() =>
                        submitAndWatch(storeTx, storageSigner).then(unwrapTx),
                    );
                } catch (err) {
                    if (!isInvalidPaymentError(err) || options.publishSigner.source !== "session") {
                        throw err;
                    }
                    options.onLogEvent?.({
                        kind: "info",
                        message: "Checking Bulletin storage allowance…",
                    });
                    storageSigner = await getBulletinAllowanceSigner({
                        publishSigner: options.publishSigner,
                        bulletinApi: asCloudStorageApi(bulletinApi),
                        onPrompt: options.onAllowancePrompt,
                    });
                    await withRetry(() =>
                        submitAndWatch(storeTx, storageSigner).then(unwrapTx),
                    );
                }
                return cid;
            } finally {
                bulletinClient.destroy();
            }
        },
    );
    options.onLogEvent?.({ kind: "info", message: `Metadata CID: ${metadataCid}` });

    const client = await getConnection();
    const registry = await getRegistryContract(client.raw.assetHub, options.publishSigner);

    return await withSpan(
        "cli.deploy.playground.registry-publish",
        "publish playground registry entry",
        { "cli.deploy.domain": fullDomain },
        async () => {
            // Encode the Option<Address> owner parameter. None ⇒ contract
            // defaults to env::caller(). Some(h160) ⇒ recorded as the app
            // owner regardless of who signed the tx.
            const owner = options.claimedOwnerH160
                ? { isSome: true as const, value: options.claimedOwnerH160 }
                : {
                      isSome: false as const,
                      value: "0x0000000000000000000000000000000000000000" as const,
                  };

            let lastError: unknown;
            for (let attempt = 1; attempt <= MAX_REGISTRY_RETRIES; attempt++) {
                try {
                    const visibility = options.isPrivate ? 0 : 1;
                    // `moddedFrom` was resolved above (explicit option wins over
                    // `dot.json`, both canonicalized — see playground-app#335).
                    // The contract credits the source owner the mod XP off this
                    // argument, so an empty string records no lineage edge.
                    const moddedFromArg = moddedFrom ?? "";
                    const isModdable = options.isModdable ?? false;
                    const isDevSigner = options.isDevSigner ?? false;
                    // contracts@0.9 dropped the separate `publishDev` method:
                    // the dev-signer path is now the same `publish` call with
                    // the trailing `is_dev_signer` boolean set. `true` records
                    // the app without awarding mod XP (the former `publishDev`
                    // behaviour); `false` is the normal user publish.
                    const result = await registry.publish.tx(
                        fullDomain,
                        metadataCid,
                        visibility,
                        owner,
                        moddedFromArg,
                        isModdable,
                        isDevSigner,
                    );
                    if (!result.ok) {
                        throw new Error("Registry publish transaction reverted");
                    }
                    return { metadataCid, fullDomain, metadata };
                } catch (err) {
                    lastError = err;
                    if (attempt >= MAX_REGISTRY_RETRIES) break;
                    captureWarning("Playground registry publish failed, retrying", {
                        attempt,
                        maxAttempts: MAX_REGISTRY_RETRIES,
                        error: errorMessage(err),
                    });
                    await new Promise((r) => setTimeout(r, REGISTRY_RETRY_DELAY_MS));
                }
            }

            const msg = lastError instanceof Error ? lastError.message : String(lastError);
            throw new Error(
                `Failed to publish to Playground registry after ${MAX_REGISTRY_RETRIES} attempts: ${msg}`,
                {
                    cause: lastError instanceof Error ? lastError : undefined,
                },
            );
        },
    );
}
