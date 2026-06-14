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
 * `playground deploy-all` — deploy several `.dot` apps in ONE invocation, with
 * builds/uploads running in parallel and on-chain signing serialized per signer
 * account (see `utils/deploy/signingGate.ts`). This is the parallel counterpart
 * to `playground deploy`: the single-app command is unchanged.
 *
 * The command is intentionally non-interactive — N concurrent Ink TUIs are
 * unreadable, so output is line-oriented and a `--json` summary is emitted on
 * completion for orchestrators. Apps are described in a JSON manifest; shared
 * options (signer, env, --playground) come from flags and apply to every app.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Command, Option } from "commander";
import { captureWarning, errorMessage, withSpan } from "../../telemetry.js";
import { resolveSigner, SignerNotAvailableError, type ResolvedSigner } from "../../utils/signer.js";
import { getConnection, destroyConnection } from "../../utils/connection.js";
import { checkMapping } from "../../utils/account/mapping.js";
import { readLoginStampMs, staleSessionWarning } from "../../utils/loginStamp.js";
import { onProcessShutdown } from "../../utils/process-guard.js";
import { runCliCommand } from "../../cli-runtime.js";
import {
    resolveSignerSetup,
    resolveDotnsOwnerAddress,
    type SignerMode,
} from "../../utils/deploy/signerMode.js";
import { checkDomainAvailability, formatAvailability } from "../../utils/deploy/availability.js";
import {
    runParallelDeploys,
    type ParallelDeployApp,
    type ParallelDeployResult,
} from "../../utils/deploy/parallel.js";
import type { DeployEvent, RunDeployOptions } from "../../utils/deploy/run.js";
import {
    DEFAULT_BUILD_DIR,
    DEFAULT_ENV,
    ENV_FLAG_CHOICES,
    type Env,
    resolveLegacyEnv,
    setActiveEnv,
} from "../../config.js";
import { NO_SESSION_HEADLESS_ERROR } from "../deploy/signerNotice.js";
import { parseManifest, type ManifestApp } from "./manifest.js";

interface DeployAllOpts {
    manifest: string;
    signer: SignerMode;
    buildDir?: string;
    build?: boolean;
    playground?: boolean;
    private?: boolean;
    suri?: string;
    concurrency?: string;
    json?: boolean;
    env?: Env;
}

const DEFAULT_CONCURRENCY = 3;

export const deployAllCommand = new Command("deploy-all")
    .description(
        "Deploy multiple .dot apps from a manifest in one run — builds in parallel, signs serially per account",
    )
    .requiredOption("--manifest <path>", "JSON manifest listing the apps to deploy")
    .addOption(
        new Option("--signer <mode>", "Signer mode (applied to every app)").choices([
            "dev",
            "phone",
        ]),
    )
    .option(
        "--buildDir <path>",
        `Default build-artifacts dir for apps that don't set their own (default: ${DEFAULT_BUILD_DIR})`,
    )
    .option("--no-build", "Skip the build step for every app and deploy existing artifacts")
    .option("--playground", "Publish every app to the playground registry")
    .option(
        "--private",
        "Publish to the playground with private visibility. Requires --playground.",
    )
    .option("--suri <suri>", "Secret URI for the user signer (e.g. //Alice for dev)")
    .option(
        "--concurrency <n>",
        `Max apps to build/upload at once (default: ${DEFAULT_CONCURRENCY})`,
    )
    .option("--json", "Emit a machine-readable JSON summary to stdout on completion")
    .addOption(
        new Option("--env <env>", "Target environment")
            // Single-sourced in config.ts (env IDs + legacy aliases) so it stays
            // in lockstep with the active network and the Env type.
            .choices([...ENV_FLAG_CHOICES])
            .default(DEFAULT_ENV),
    )
    .action(async (opts: DeployAllOpts) =>
        runCliCommand("deploy-all", { watchdog: true, hardExit: true }, async () => {
            await runDeployAll(opts);
        }),
    );

async function runDeployAll(opts: DeployAllOpts): Promise<void> {
    const env: Env = resolveLegacyEnv(opts.env ?? DEFAULT_ENV);
    // Make --env active before any chain access (see deploy/index.ts + config.ts).
    setActiveEnv(env);
    const mode = opts.signer;
    if (mode !== "dev" && mode !== "phone") {
        throw new Error("deploy-all requires --signer dev or --signer phone.");
    }
    const publishToPlayground = opts.playground === true;
    const defaultBuildDir = opts.buildDir ?? DEFAULT_BUILD_DIR;
    const skipBuildDefault = opts.build === false;
    const concurrency = opts.concurrency ? Number(opts.concurrency) : DEFAULT_CONCURRENCY;

    const manifestPath = resolve(opts.manifest);
    const manifestDir = dirname(manifestPath);
    const { apps: manifestApps } = parseManifest(readFileSync(manifestPath, "utf8"));

    // Resolve the shared signer ONCE for the whole batch (one session / one dev
    // key), so every app signs as the same account and shares the signing gate.
    let userSigner: ResolvedSigner | null = null;
    const cleanupOnce = onceCleanup(() => {
        try {
            userSigner?.destroy();
        } catch {}
        try {
            destroyConnection();
        } catch {}
    });
    onProcessShutdown(cleanupOnce);

    try {
        userSigner = await preflightSigner({ env, mode, suri: opts.suri, publishToPlayground });

        if (mode === "phone" && userSigner?.source !== "session") {
            throw new Error(NO_SESSION_HEADLESS_ERROR);
        }

        const apps: ParallelDeployApp[] = manifestApps.map((m) =>
            toParallelApp(m, { manifestDir, defaultBuildDir, skipBuildDefault }),
        );

        process.stdout.write(
            `\nDeploying ${apps.length} app(s) — concurrency ${Math.min(concurrency, apps.length)}, ` +
                `signing serialized per account.\n\n`,
        );

        const summary = await withSpan(
            "cli.deploy.parallel",
            "run parallel deploys",
            { "cli.deploy.app_count": String(apps.length), "cli.deploy.mode": mode },
            () =>
                runParallelDeploys({
                    apps,
                    concurrency,
                    // Same signer for every app ⇒ one shared gate ⇒ fully
                    // serialized signing. (Per-app keys would parallelize across
                    // distinct accounts, but deploy-all uses one batch signer.)
                    signerKey: () => batchSignerKey(mode, userSigner),
                    buildRunOptions: (app) =>
                        buildRunOptions(app, {
                            env,
                            mode,
                            userSigner,
                            publishToPlayground,
                            playgroundPrivate: opts.private === true,
                        }),
                    onEvent: (name, event) => logAppEvent(name, event),
                    onAppSettled: (result) => logSettled(result),
                }),
        );

        if (opts.json) {
            process.stdout.write(`${JSON.stringify(toJsonSummary(summary.results), null, 2)}\n`);
        }
        printSummary(summary.results);

        if (summary.failed > 0) {
            process.exitCode = 1;
            throw new Error(`${summary.failed} of ${apps.length} app(s) failed to deploy.`);
        }
    } catch (err) {
        process.stderr.write(`\n✖ ${errorMessage(err)}\n`);
        if (process.exitCode === undefined || process.exitCode === 0) process.exitCode = 1;
        throw err;
    } finally {
        cleanupOnce();
    }
}

// ── Per-app option assembly ────────────────────────────────────────────────

function toParallelApp(
    m: ManifestApp,
    ctx: { manifestDir: string; defaultBuildDir: string; skipBuildDefault: boolean },
): ParallelDeployApp {
    const projectDir = resolve(ctx.manifestDir, m.dir);
    return {
        name: m.name,
        projectDir,
        // polkadot-app-deploy + the build step take buildDir relative to the project
        // dir; resolve it here so each app's output is isolated to its own dir.
        buildDir: resolve(projectDir, m.buildDir ?? ctx.defaultBuildDir),
        domain: m.domain,
        skipBuild: m.skipBuild ?? ctx.skipBuildDefault,
    };
}

async function buildRunOptions(
    app: ParallelDeployApp,
    ctx: {
        env: Env;
        mode: SignerMode;
        userSigner: ResolvedSigner | null;
        publishToPlayground: boolean;
        playgroundPrivate: boolean;
    },
): Promise<Omit<RunDeployOptions, "signingGate" | "onEvent">> {
    // Per-app availability check, mirroring `deploy`'s headless preflight: fail
    // an individual app fast on a Reserved/taken name without wasting its upload.
    const dotnsOwnerSs58Address = resolveDotnsOwnerAddress(ctx.mode, ctx.userSigner);
    const availability = await checkDomainAvailability(app.domain, {
        env: ctx.env,
        ownerSs58Address: dotnsOwnerSs58Address,
    });
    if (availability.status !== "available") {
        throw new Error(formatAvailability(availability));
    }

    // Validate the signer matrix up front (e.g. phone with no session) so the
    // error surfaces per-app rather than deep inside runDeploy.
    resolveSignerSetup({
        mode: ctx.mode,
        userSigner: ctx.userSigner,
        publishToPlayground: ctx.publishToPlayground,
        plan: availability.plan,
    });

    return {
        projectDir: app.projectDir,
        buildDir: app.buildDir,
        skipBuild: app.skipBuild,
        domain: app.domain,
        mode: ctx.mode,
        publishToPlayground: ctx.publishToPlayground,
        playgroundPrivate: ctx.playgroundPrivate,
        userSigner: ctx.userSigner,
        plan: availability.plan,
        env: ctx.env,
    };
}

/**
 * The key that decides which apps share a signing gate. deploy-all always uses
 * one batch signer, so this returns one stable string ⇒ all signing serialized.
 * (`?? "phone"` only guards phone mode with no resolved session address, which
 * the preflight already rejects — it keeps the return type a plain string.)
 */
function batchSignerKey(mode: SignerMode, userSigner: ResolvedSigner | null): string {
    return resolveDotnsOwnerAddress(mode, userSigner) ?? "phone";
}

// ── Signer preflight (batch-level, mirrors deploy/index.ts) ─────────────────

async function preflightSigner(opts: {
    env: Env;
    mode: SignerMode;
    suri?: string;
    publishToPlayground: boolean;
}): Promise<ResolvedSigner | null> {
    // Pure dev with no publish + no suri needs no signer at all.
    if (opts.mode === "dev" && opts.suri === undefined && !opts.publishToPlayground) return null;

    let signer: ResolvedSigner;
    try {
        signer = await resolveSigner({ suri: opts.suri });
    } catch (err) {
        if (err instanceof SignerNotAvailableError) {
            // Mirror `deploy`'s footgun warning: dev + --playground with no
            // session publishes every app under the dev account, not the user.
            if (opts.mode === "dev" && opts.publishToPlayground) {
                process.stderr.write(
                    "warning: --signer dev --playground with no session and no --suri — " +
                        "publishing under the dev account. Run `playground login` first if you " +
                        "want the apps to appear in your MyApps view.\n",
                );
                captureWarning("dev mode playground publish with no user identity", {
                    attempted: "pure-dev-publish",
                });
            }
            return null;
        }
        throw err;
    }
    if (signer.source !== "session") return signer;

    const client = await getConnection();
    const mapped = await checkMapping(client, signer.address);
    if (!mapped) {
        signer.destroy();
        throw new Error(
            'Account is not mapped in Revive. Run "playground login" first to finish account setup.',
        );
    }
    // Release the idle client — runDeploy / publish reopen their own.
    destroyConnection();

    // Warn-only staleness heuristic for the statement-store allowance (the
    // channel every phone tap rides). Mirrors `deploy`'s preflight — a batch of
    // N phone-signed apps multiplies the cost of a silently-expired session.
    if (opts.mode !== "dev") {
        const warning = staleSessionWarning(await readLoginStampMs(), Date.now());
        if (warning) process.stderr.write(`${warning}\n`);
    }
    return signer;
}

// ── Output ──────────────────────────────────────────────────────────────────

function logAppEvent(name: string, event: DeployEvent): void {
    if (event.kind === "phase-start") {
        process.stdout.write(`[${name}] ▸ ${event.phase}…\n`);
    } else if (event.kind === "phase-complete" && event.phase !== "done") {
        process.stdout.write(`[${name}] ✔ ${event.phase}\n`);
    } else if (event.kind === "error") {
        process.stderr.write(`[${name}] ✖ ${event.phase}: ${event.message}\n`);
    }
}

function logSettled(result: ParallelDeployResult): void {
    if (result.status === "success") {
        process.stdout.write(`[${result.name}] ✔ deployed → ${result.outcome.appUrl}\n`);
    } else {
        process.stderr.write(`[${result.name}] ✖ failed: ${result.error}\n`);
    }
}

function printSummary(results: ParallelDeployResult[]): void {
    const ok = results.filter((r) => r.status === "success").length;
    process.stdout.write(`\n── Deploy-all summary: ${ok}/${results.length} succeeded ──\n`);
    for (const r of results) {
        if (r.status === "success") {
            process.stdout.write(`  ✔ ${r.name.padEnd(18)} ${r.outcome.fullDomain}\n`);
        } else {
            process.stdout.write(`  ✖ ${r.name.padEnd(18)} ${r.error}\n`);
        }
    }
    process.stdout.write("\n");
}

function toJsonSummary(results: ParallelDeployResult[]) {
    return {
        version: 1 as const,
        apps: results.map((r) =>
            r.status === "success"
                ? {
                      name: r.name,
                      status: "success" as const,
                      domain: r.outcome.fullDomain,
                      appUrl: r.outcome.appUrl,
                      appCid: r.outcome.appCid,
                      ipfsCid: r.outcome.ipfsCid,
                      metadataCid: r.outcome.metadataCid,
                  }
                : { name: r.name, status: "failed" as const, domain: r.domain, error: r.error },
        ),
    };
}

// ── Misc ──────────────────────────────────────────────────────────────────

function onceCleanup(fn: () => void): () => void {
    let ran = false;
    return () => {
        if (ran) return;
        ran = true;
        fn();
    };
}
