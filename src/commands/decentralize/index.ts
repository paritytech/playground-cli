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
 * `dot decentralize` — point at a live static site, get back a .dot URL.
 *
 *   dot decentralize --site=shawntabrizi.github.io --dot=shawntabrizi.dot
 *
 * Zero-account by default: we sign with //Bob on paseo-next-v2 so a first-time
 * user can see end-to-end value with no wallet setup. The migration story is
 * surfaced in the success footer — re-deploy from `dot deploy` with their own
 * --suri or QR session and the same domain check at availability.ts:261 will
 * recognise the "owned by you" path and update in place.
 *
 * Site cloning is `wget --mirror` (see utils/decentralize/mirror.ts). The
 * upload + DotNS register flow re-uses `runStorageDeploy` exactly like
 * `dot deploy`, so any improvements to the underlying primitives flow into
 * this command for free.
 */

import { Command } from "commander";
import { rmSync } from "node:fs";
import { runCliCommand } from "../../cli-runtime.js";
import { errorMessage, withSpan } from "../../telemetry.js";
import {
    DEFAULT_ENV,
    type Env,
    getChainConfig,
    resolveLegacyEnv,
} from "../../config.js";
import { resolveSigner, type ResolvedSigner } from "../../utils/signer.js";
import { runStorageDeploy } from "../../utils/deploy/storage.js";
import {
    checkDomainAvailability,
    formatAvailability,
} from "../../utils/deploy/availability.js";
import { normalizeDomain } from "../../utils/deploy/playground.js";
import { mirrorSite } from "../../utils/decentralize/mirror.js";
import { findAvailableRandomName } from "../../utils/decentralize/randomName.js";

interface DecentralizeOpts {
    site: string;
    dot?: string;
    env: string;
    suri?: string;
}

/**
 * //Bob is a hard-coded dev SURI. It only has funds / authorisation on the
 * paseo-next-v2 testnet — using it on mainnet would silently fail at the
 * funding step. Refusing here gives a friendly error instead.
 */
const DEFAULT_SURI = "//Bob";

export const decentralizeCommand = new Command("decentralize")
    .description(
        "Mirror a live static site to Polkadot Bulletin and register a .dot name pointing at it",
    )
    .requiredOption("--site <url>", "URL of the static site to clone (http/https)")
    .option(
        "--dot <name>",
        "DotNS domain (with or without `.dot`). Omit to auto-generate a free random name.",
    )
    .option(
        "--env <env>",
        "Target environment (default: paseo-next-v2)",
        DEFAULT_ENV,
    )
    .option(
        "--suri <suri>",
        "Sign with this SURI instead of the default //Bob test account",
    )
    .action(async (opts: DecentralizeOpts) =>
        runCliCommand("decentralize", { hardExit: true }, async () => {
            const env: Env = resolveLegacyEnv(opts.env);
            const usingDefaultBob = !opts.suri;

            if (usingDefaultBob && getChainConfig(env).network !== "testnet") {
                throw new Error(
                    `--env ${env} is a non-testnet network; //Bob has no funds there. ` +
                        `Pass --suri <your-mnemonic-or-key> or use --env paseo-next-v2.`,
                );
            }

            let signer: ResolvedSigner | null = null;
            let mirrorDir: string | null = null;

            try {
                signer = await withSpan(
                    "cli.decentralize.signer",
                    "resolve signer",
                    () => resolveSigner({ suri: opts.suri ?? DEFAULT_SURI }),
                );

                process.stdout.write(
                    `\n▸ Signing as ${signer.address} (${signer.source})\n`,
                );

                // ── 1. Pick a domain ────────────────────────────────────────
                let label: string;
                let fullDomain: string;
                if (opts.dot) {
                    const normalized = normalizeDomain(opts.dot);
                    label = normalized.label;
                    fullDomain = normalized.fullDomain;

                    process.stdout.write(`\n▸ Checking ${fullDomain}…\n`);
                    const availability = await withSpan(
                        "cli.decentralize.availability",
                        "check domain availability",
                        () =>
                            checkDomainAvailability(label, {
                                env,
                                ownerSs58Address: signer?.address,
                            }),
                    );
                    if (
                        availability.status === "reserved" ||
                        availability.status === "taken"
                    ) {
                        throw new Error(formatAvailability(availability));
                    }
                    if (availability.status === "unknown") {
                        process.stderr.write(
                            `\n⚠ ${formatAvailability(availability)} — continuing anyway.\n`,
                        );
                    }
                } else {
                    process.stdout.write(
                        `\n▸ Picking a free random .dot name…\n`,
                    );
                    const chosen = await withSpan(
                        "cli.decentralize.random-name",
                        "find available random name",
                        () =>
                            findAvailableRandomName({
                                env,
                                ownerSs58Address: signer?.address,
                            }),
                    );
                    label = chosen.label;
                    fullDomain = chosen.availability.fullDomain;
                    process.stdout.write(`  → ${fullDomain}\n`);
                }

                // ── 2. Mirror the site ──────────────────────────────────────
                process.stdout.write(`\n▸ Mirroring ${opts.site}…\n`);
                const mirror = await withSpan(
                    "cli.decentralize.mirror",
                    "mirror site",
                    () =>
                        mirrorSite({
                            url: opts.site,
                            onLine: (line) =>
                                process.stdout.write(`  ${line}\n`),
                        }),
                );
                mirrorDir = mirror.directory;
                process.stdout.write(
                    `  → ${mirror.fileCount} files in ${mirror.directory}\n`,
                );

                // ── 3. Upload to Bulletin + register DotNS ──────────────────
                process.stdout.write(
                    `\n▸ Uploading to Bulletin and registering ${fullDomain}…\n`,
                );
                const result = await withSpan(
                    "cli.decentralize.storage",
                    "bulletin upload + dotns register",
                    () =>
                        runStorageDeploy({
                            content: mirror.directory,
                            domainName: label,
                            auth: {
                                signer: signer?.signer,
                                signerAddress: signer?.address,
                            },
                            env,
                            onLogEvent: (event) =>
                                process.stdout.write(`  • ${event.kind}\n`),
                        }),
                );

                // ── 4. Print success ────────────────────────────────────────
                const cfg = getChainConfig(env);
                const appUrl = `https://${fullDomain}.li`;
                const gatewayUrl = `${cfg.bulletinGateway}${result.cid}`;
                process.stdout.write(
                    "\n✔ Decentralized!\n" +
                        `  Site         ${appUrl}\n` +
                        `  IPFS CID     ${result.cid}\n` +
                        `  Gateway      ${gatewayUrl}\n`,
                );
                if (usingDefaultBob) {
                    process.stdout.write(
                        "\n  Owned by //Bob (testnet demo). To claim a name under your own\n" +
                            "  account, run `dot init` to pair a wallet, then re-deploy with\n" +
                            "  `dot deploy --domain <your-name>.dot` from a project of your own.\n",
                    );
                }
                process.stdout.write("\n");
            } catch (err) {
                process.stderr.write(`\n✖ ${errorMessage(err)}\n`);
                process.exitCode = 1;
                throw err;
            } finally {
                signer?.destroy();
                if (mirrorDir) {
                    try {
                        rmSync(mirrorDir, { recursive: true, force: true });
                    } catch {
                        // best-effort cleanup; tmpdir is OS-managed anyway
                    }
                }
            }
        }),
    );

