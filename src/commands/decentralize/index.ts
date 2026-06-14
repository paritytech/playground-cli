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
 * `dot decentralize` — point at a live static site (or a local build
 * directory), get back a .dot URL.
 *
 *   dot decentralize                                          # interactive
 *   dot decentralize --site=shawntabrizi.github.io            # headless
 *   dot decentralize --site=foo.com --dot=bar                 # headless, explicit name
 *   dot decentralize --site=foo.com --suri=//Bob              # headless, dev signer
 *   dot decentralize --site=foo.com --playground              # also publish to playground
 *   dot decentralize --path=./dist                            # headless, local directory
 *
 * Headless flow runs when `--site` or `--path` is provided (preserves the
 * existing `dot decentralize --suri=//Bob` demo-service contract). Without
 * either, the command mounts an Ink TUI that prompts for source (URL or
 * local directory) → URL/path → signer → domain → publish? → moddable?
 * (path mode only) before kicking off the same upload pipeline. The
 * publish-to-playground step delegates to deploy's `publishToPlayground`
 * helper.
 */

import { Command, Option } from "commander";
import React from "react";
import { render } from "ink";
import { runCliCommand } from "../../cli-runtime.js";
import { errorMessage, withSpan } from "../../telemetry.js";
import {
    DEFAULT_ENV,
    ENV_FLAG_CHOICES,
    type Env,
    resolveLegacyEnv,
    setActiveEnv,
} from "../../config.js";
import { resolveSigner, type ResolvedSigner, SignerNotAvailableError } from "../../utils/signer.js";
import { resolveDomain } from "../../utils/decentralize/domain.js";
import { prepareLocalDirectory } from "../../utils/decentralize/local.js";
import {
    describeDeployEvent,
    runDecentralize,
    type DecentralizeOutcome,
    type DecentralizeSource,
} from "../../utils/decentralize/run.js";
import { destroyConnection } from "../../utils/connection.js";
import {
    ensureGitInstalled,
    ModdablePreflightError,
    resolveRepositoryUrl,
} from "../../utils/deploy/moddable.js";
import type { SignerMode } from "../../utils/deploy/signerMode.js";
import { PLAYGROUND_TAGS } from "../../utils/deploy/tags.js";
import { onProcessShutdown } from "../../utils/process-guard.js";

interface DecentralizeOpts {
    site?: string;
    path?: string;
    dot?: string;
    env: string;
    suri?: string;
    /**
     * Commander coerces `--playground` (no arg) to `true` and the flag's
     * absence to `undefined`. We treat `undefined` as "ask in the TUI / skip
     * in headless" — i.e. opt-in publish.
     */
    playground?: boolean;
    /** Playground category tag (from PLAYGROUND_TAGS). Requires --playground. */
    tag?: string;
    /**
     * Record the path directory's public GitHub origin in the playground
     * metadata so others can `playground mod` the app. Path mode only
     * (`.conflicts("site")` — a mirrored URL has no git source) and requires
     * `--playground` in headless mode. `undefined` ⇒ ask in the TUI.
     */
    moddable?: boolean;
}

/**
 * A `--tag` is only meaningful alongside `--playground` (no metadata is
 * published otherwise). Mirrors deploy's `assertPublishFlagsConsistent`.
 * Exported for unit testing.
 */
export function assertTagRequiresPlayground(opts: {
    tag?: string;
    playground?: boolean;
}): void {
    if (opts.tag && opts.playground !== true) {
        throw new Error("--tag requires --playground (no metadata is published without it).");
    }
}

export const decentralizeCommand = new Command("decentralize")
    .description(
        "Mirror a live static site (or upload a local build directory) to Polkadot Bulletin " +
            "and register a .dot name pointing at it",
    )
    .option(
        "--site <url>",
        "URL of the static site to clone (http/https). Omit to launch the interactive TUI.",
    )
    .addOption(
        new Option(
            "--path <dir>",
            "Local directory containing a built static site (e.g. ./dist). Alternative to --site.",
        ).conflicts("site"),
    )
    .option(
        "--dot <name>",
        "DotNS domain (with or without `.dot`). Omit to auto-generate a free random name.",
    )
    .addOption(
        // Same single-sourced choices + DEFAULT_ENV as deploy/deploy-all so all
        // three commands validate --env identically and move together on a switch.
        new Option("--env <env>", "Target environment")
            .choices([...ENV_FLAG_CHOICES])
            .default(DEFAULT_ENV),
    )
    .option(
        "--suri <suri>",
        "Sign with this SURI (dev name like //Bob, or a BIP-39 mnemonic). " +
            "Default: the session signer paired by `playground login`.",
    )
    .option(
        "--playground",
        "After upload, also publish a minimal AppInfo entry to the playground registry " +
            "(visible in the playground-app's Apps tab). Off by default.",
    )
    .addOption(
        new Option(
            "--tag <tag>",
            "Tag the published app so people can filter for it in the playground. Requires --playground.",
        ).choices([...PLAYGROUND_TAGS]),
    )
    .addOption(
        new Option(
            "--moddable",
            "Record the public GitHub origin of --path's repo so others can " +
                "`playground mod` it. Requires --path and --playground. Off by default.",
        ).conflicts("site"),
    )
    .action(async (opts: DecentralizeOpts) =>
        runCliCommand("decentralize", { hardExit: true }, async () => {
            const env: Env = resolveLegacyEnv(opts.env);
            // Make --env active before any chain access (see deploy/index.ts + config.ts).
            setActiveEnv(env);
            if (opts.site || opts.path) {
                await runHeadless({ env, opts });
            } else {
                await runInteractive({ env, opts });
            }
        }),
    );

// ── Headless path (preserves the existing dot decentralize --site=... contract) ─

async function runHeadless({
    env,
    opts,
}: {
    env: Env;
    opts: DecentralizeOpts;
}): Promise<void> {
    assertTagRequiresPlayground(opts);

    let signer: ResolvedSigner | null = null;

    try {
        // Fail fast on a bad --path before any signer/network work —
        // otherwise the user waits out the domain availability check only to
        // learn the directory doesn't exist. runDecentralize re-validates
        // (prepareLocalDirectory is cheap and pure fs).
        if (opts.path) prepareLocalDirectory(opts.path);

        // Moddable preflight, same fail-fast rationale: resolve the public
        // GitHub origin (git walks up from the --path directory) before any
        // signer/chain work. `ModdablePreflightError`'s headless message
        // already names the fix, so it propagates as-is. `--site` is blocked
        // by commander's `.conflicts()`, so `opts.path` is set here.
        let repositoryUrl: string | null = null;
        if (opts.moddable) {
            if (opts.playground !== true) {
                throw new Error(
                    "--moddable requires --playground — the repo URL is recorded in the " +
                        "playground metadata, which is only published with --playground.",
                );
            }
            await ensureGitInstalled();
            try {
                repositoryUrl = await resolveRepositoryUrl({
                    cwd: opts.path!,
                    onLog: (line) => process.stdout.write(`  ${line}\n`),
                });
            } catch (err) {
                // The headless message in moddable.ts names deploy's
                // `--no-moddable` escape hatch, which this command doesn't
                // have — use the surface-neutral copy + the right remedy.
                if (err instanceof ModdablePreflightError) {
                    throw new Error(
                        `${err.interactiveMessage} Or omit --moddable to publish without source.`,
                    );
                }
                throw err;
            }
        }

        signer = await withSpan("cli.decentralize.signer", "resolve signer", () =>
            resolveSigner({ suri: opts.suri }),
        );

        process.stdout.write(`\n▸ Signing as ${signer.address} (${signer.source})\n`);

        // The action gates headless on `opts.site || opts.path` and commander's
        // `.conflicts()` rejects passing both, so exactly one is set here.
        const source: DecentralizeSource = opts.path
            ? { kind: "path", directory: opts.path }
            : { kind: "url", url: opts.site! };

        const { label, fullDomain } = await resolveDomain({
            env,
            providedDot: opts.dot,
            source,
            signer,
            onMessage: (line) => process.stdout.write(`${line}\n`),
        });

        // Headless mode: "dev" when --suri was passed (signer.source === "dev"),
        // "phone" when we fell back to the session signer (source === "session").
        const mode: SignerMode = signer.source === "session" ? "phone" : "dev";

        process.stdout.write(
            source.kind === "url"
                ? `\n▸ Mirroring ${source.url}… (large sites take a few minutes — press Ctrl+C to cancel)\n`
                : `\n▸ Preparing ${source.directory}…\n`,
        );
        const outcome = await runDecentralize({
            source,
            label,
            fullDomain,
            mode,
            userSigner: signer,
            publishToPlayground: opts.playground === true,
            tag: opts.tag ?? null,
            repositoryUrl,
            env,
            onEvent: (ev) => {
                switch (ev.kind) {
                    case "mirror-line":
                        process.stdout.write(`  ${ev.line}\n`);
                        break;
                    case "mirror-large":
                        process.stdout.write(
                            `  ⚠ large site (${ev.fileCount}+ files) — this may take several minutes; Ctrl+C to cancel\n`,
                        );
                        break;
                    case "mirror-done":
                    case "local-done":
                        process.stdout.write(
                            `  → ${ev.fileCount} files in ${ev.directory}\n` +
                                `\n▸ Uploading to Bulletin and registering ${fullDomain}…\n`,
                        );
                        break;
                    case "storage-event": {
                        const line = describeDeployEvent(ev.event);
                        if (line) process.stdout.write(`  • ${line}\n`);
                        break;
                    }
                    case "playground-start":
                        process.stdout.write(`\n▸ Publishing ${ev.fullDomain} to playground…\n`);
                        break;
                    case "playground-event": {
                        const line = describeDeployEvent(ev.event);
                        if (line) process.stdout.write(`  • ${line}\n`);
                        break;
                    }
                    case "signing":
                        if (ev.event.kind === "sign-request") {
                            process.stdout.write(
                                `\n  ▸ Check your phone — approve step ${ev.event.step}: ${ev.event.label}\n`,
                            );
                        } else if (ev.event.kind === "sign-error") {
                            process.stdout.write(`  ✖ signing failed: ${ev.event.message}\n`);
                        }
                        break;
                }
            },
        });

        printHeadlessSuccess(outcome);
    } catch (err) {
        process.stderr.write(`\n✖ ${errorMessage(err)}\n`);
        process.exitCode = 1;
        throw err;
    } finally {
        signer?.destroy();
        destroyConnection();
    }
}

// ── Interactive path ─────────────────────────────────────────────────────────

async function runInteractive({
    env,
    opts,
}: {
    env: Env;
    opts: DecentralizeOpts;
}): Promise<void> {
    // Preflight: resolve an explicit --suri signer if provided, otherwise try the
    // persisted session — tolerating its absence so the picker can still offer
    // the dev option.
    const preflight = await withSpan("cli.decentralize.preflight", "decentralize preflight", () =>
        resolvePreflightSigner(opts.suri),
    );

    const cleanupOnce = (() => {
        let ran = false;
        return () => {
            if (ran) return;
            ran = true;
            try {
                preflight.explicitSigner?.destroy();
            } catch {}
            try {
                preflight.sessionSigner?.destroy();
            } catch {}
            // Release the shared Asset Hub WS that publishToPlayground opens
            // via getConnection(). Without this the event loop stays alive and
            // `dot decentralize` hangs after the work visibly finishes (the
            // CLAUDE.md "hanging after work finishes" gotcha).
            try {
                destroyConnection();
            } catch {}
        };
    })();
    onProcessShutdown(cleanupOnce);

    try {
        const { DecentralizeScreen } = await import("./DecentralizeScreen.js");

        await new Promise<void>((resolvePromise, rejectPromise) => {
            let settled = false;
            const app = render(
                React.createElement(DecentralizeScreen, {
                    env,
                    initialSiteUrl: opts.site ?? null,
                    initialDot: opts.dot ?? null,
                    explicitSigner: preflight.explicitSigner,
                    sessionSigner: preflight.sessionSigner,
                    initialPublishToPlayground: opts.playground === true ? true : null,
                    initialTag: opts.tag,
                    initialModdable: opts.moddable === true ? true : null,
                    onDone: (result) => {
                        if (settled) return;
                        settled = true;
                        app.unmount();
                        // The TUI has already rendered the user-visible message —
                        // never re-log here. Cancel and success both exit 0; only
                        // a real failure throws so telemetry records the SAD% bump.
                        switch (result.kind) {
                            case "success":
                            case "cancel":
                                resolvePromise();
                                break;
                            case "error":
                                process.exitCode = 1;
                                rejectPromise(new Error(result.message));
                                break;
                        }
                    },
                }),
            );

            app.waitUntilExit().catch((err) => {
                if (!settled) {
                    settled = true;
                    rejectPromise(err);
                }
            });
        });
    } finally {
        cleanupOnce();
    }
}

interface PreflightSigners {
    /** Signer explicitly chosen by `--suri`. Picker is skipped when set. */
    explicitSigner: ResolvedSigner | null;
    /** Session signer from `dot login`, if any. Drives the "phone" picker option. */
    sessionSigner: ResolvedSigner | null;
}

async function resolvePreflightSigner(suri: string | undefined): Promise<PreflightSigners> {
    if (suri) {
        return {
            explicitSigner: await resolveSigner({ suri }),
            sessionSigner: null,
        };
    }
    try {
        return {
            explicitSigner: null,
            sessionSigner: await resolveSigner({}),
        };
    } catch (err) {
        if (err instanceof SignerNotAvailableError) {
            return { explicitSigner: null, sessionSigner: null };
        }
        throw err;
    }
}

// ── Shared helpers ───────────────────────────────────────────────────────────

export function printHeadlessSuccess(outcome: DecentralizeOutcome): void {
    const lines = [
        "\n✔ Decentralized!",
        `  Site         ${outcome.appUrl}`,
        `  IPFS CID     ${outcome.ipfsCid}`,
        `  Gateway      ${outcome.gatewayUrl}`,
    ];
    if (outcome.metadataCid) {
        lines.push(`  Metadata CID ${outcome.metadataCid}`);
    }
    process.stdout.write(`${lines.join("\n")}\n`);
    if (outcome.signerSource === "dev") {
        process.stdout.write(
            "\n  To deploy to a domain owned by you, run `playground login` and re-run\n" +
                "  `playground decentralize` with the mobile signer.\n",
        );
    }
    process.stdout.write("\n");
}
