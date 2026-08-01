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
 * Orchestrator for the full `dot deploy` flow.
 *
 * The function is deliberately pure-ish: it takes an already-resolved signer,
 * emits a typed event stream, and leaves UI concerns (Ink, spinners) to the
 * caller. RevX can import this module in a WebContainer and drive its own UI
 * off the same events.
 */

import { resolve } from "node:path";
import { runBuild, loadDetectInput, detectBuildConfig, type BuildConfig } from "../build/index.js";
import { publishToPlayground, normalizeDomain } from "./playground.js";
import { assertBuildDirExists } from "./buildDir.js";
import {
    isKnownDevPublishSigner,
    resolveSignerSetup,
    resolveStorageSignerOptions,
    type SignerMode,
    type DeployApproval,
} from "./signerMode.js";
import {
    wrapSignerWithEvents,
    createSigningCounter,
    createApprovalPrompt,
    type SigningCounter,
    type SigningEvent,
} from "./signingProxy.js";
import type { DeployLogEvent } from "./progress.js";
import { createBulletinAuthContext } from "./bulletinAuthContext.js";
import { withDeployPhase } from "./phase.js";
import type { ResolvedSigner } from "../signer.js";
import type { Env } from "../../config.js";
import type { DeployPlan } from "./availability.js";
import type { SigningGate } from "./signingGate.js";

// ── Events ───────────────────────────────────────────────────────────────────

export type DeployPhase = "build" | "storage-and-dotns" | "playground" | "done";

export type DeployEvent =
    | { kind: "plan"; approvals: DeployApproval[] }
    | { kind: "phase-start"; phase: DeployPhase }
    | { kind: "phase-complete"; phase: DeployPhase }
    | { kind: "phase-skipped"; phase: DeployPhase; reason: string }
    | { kind: "build-log"; line: string }
    | { kind: "build-detected"; config: BuildConfig }
    | { kind: "storage-event"; event: DeployLogEvent }
    | { kind: "signing"; event: SigningEvent }
    | { kind: "error"; phase: DeployPhase; message: string };

// ── Inputs & outputs ─────────────────────────────────────────────────────────

export interface RunDeployOptions {
    /** Project root — where the build runs. */
    projectDir: string;
    /** Relative path inside `projectDir` that holds the built artifacts. */
    buildDir: string;
    /** Skip the build step (e.g. if the caller already built). */
    skipBuild?: boolean;
    /** DotNS label (with or without `.dot`). */
    domain: string;
    /** Signer mode — `dev` uses polkadot-app-deploy defaults, `phone` uses the user's session. */
    mode: SignerMode;
    /** Whether to publish to the playground registry after DotNS succeeds. */
    publishToPlayground: boolean;
    /** Publish to the playground with private visibility (owner-only). Ignored when `publishToPlayground` is false. */
    playgroundPrivate?: boolean;
    /** Whether the deploy should publish source as moddable. */
    moddable?: boolean;
    /** Resolved public repository URL to record in metadata (moddable=true) or `null` (moddable=false). */
    repositoryUrl?: string | null;
    /**
     * Domain (`<label>.dot`) this deploy was modded from. For SDK/RevX
     * consumers that perform the clone themselves and therefore never run the
     * `dot mod` TUI step that writes `moddedFrom` into `dot.json`: pass the
     * source domain here so the contract credits the right owner. When set
     * (non-empty) it takes precedence over any (possibly stale) `moddedFrom`
     * in the project's `dot.json` — see `publishToPlayground` and
     * playground-app#335. Omit for the normal `dot deploy` path, which reads
     * the value `dot mod` captured in `dot.json`. Ignored when
     * `publishToPlayground` is false.
     */
    moddedFrom?: string | null;
    /** Single playground tag to record in metadata, or `null`/omitted to publish untagged. Ignored when `publishToPlayground` is false. */
    tag?: string | null;
    /** The logged-in phone signer. Required for `mode === "phone"` or `publishToPlayground`. */
    userSigner: ResolvedSigner | null;
    /** Event sink — consumed by the TUI / RevX. */
    onEvent: (event: DeployEvent) => void;
    /** Target environment. Defaults to `testnet`. */
    env?: Env;
    /**
     * DotNS plan from the availability check — shapes the approvals list.
     * Optional; the signing counter falls back to "register, no PoP upgrade"
     * (3 DotNS taps) if absent and auto-corrects at runtime.
     */
    plan?: DeployPlan;
    /**
     * Optional mutex that serializes this deploy's on-chain SIGNING phases
     * (Bulletin upload + DotNS, then the playground publish) against other
     * concurrent deploys sharing the same signer account. Required for safe
     * parallel deploys: every extrinsic re-reads the account's on-chain nonce
     * at submission time, so two concurrent same-account deploys would collide
     * on the same nonce. The gate ensures at most one is submitting at a time,
     * while builds (the slow part) still run in parallel. Absent ⇒ the legacy
     * single-deploy path runs unguarded (no contention to serialize against).
     * See `signingGate.ts` for the full rationale.
     */
    signingGate?: SigningGate;
}

export interface DeployOutcome {
    /** Canonical `<label>.dot` string. */
    fullDomain: string;
    /** Bulletin storage CID of the app bundle. */
    appCid: string;
    /** IPFS CID of the directory root, if polkadot-app-deploy computed one. */
    ipfsCid?: string;
    /** Metadata CID when `publishToPlayground` was true. */
    metadataCid?: string;
    /** Approvals the user actually went through, useful for final summary. */
    approvalsRequested: DeployApproval[];
    /** URL the user can visit to view their deployed app. */
    appUrl: string;
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

export async function runDeploy(options: RunDeployOptions): Promise<DeployOutcome> {
    // Universal preflight backstop for every caller (headless, interactive TUI,
    // and SDK/RevX consumers): when skipping the build, the artifacts must
    // already exist, or the storage phase fails opaquely with `Path not found`.
    // We only check on skip-build — a real build produces `buildDir` itself.
    // (`--contracts` always forces a rebuild, so skipBuild and contracts can
    // never both be set; nothing on-chain runs ahead of this check.)
    if (options.skipBuild) {
        assertBuildDirExists(options.projectDir, options.buildDir);
    }

    const { label, fullDomain } = normalizeDomain(options.domain);

    const setup = resolveSignerSetup({
        mode: options.mode,
        userSigner: options.userSigner,
        publishToPlayground: options.publishToPlayground,
        plan: options.plan,
    });

    options.onEvent({ kind: "plan", approvals: setup.approvals });

    const counter = createSigningCounter();
    // "Check your phone" surface for RFC-0010 allocation taps (the first-use
    // Bulletin slot grant). These ride the statement store outside any
    // PolkadotSigner, so the signing proxy below can't see them — without
    // this the phone shows an approval dialog the TUI never mentions.
    const allowancePrompt = createApprovalPrompt(counter, (event) =>
        options.onEvent({ kind: "signing", event }),
    );

    // Resolve against projectDir, NOT the process cwd. The build writes to
    // `projectDir/<buildDir>` (build runs with `cwd: projectDir`), but
    // polkadot-app-deploy resolves a relative `content` against `process.cwd()`
    // (`path.resolve(content)`). Passing the raw relative path would make a
    // `--dir`-from-another-cwd deploy upload the wrong directory (or fail with
    // `Path not found`). An absolute `buildDir` is unchanged (resolve is a
    // no-op), so the common `projectDir === cwd` case is byte-for-byte identical.
    const buildAbs = resolve(options.projectDir, options.buildDir);

    // Build first, OUTSIDE any signing gate — tsc+vite is the slow part and must
    // stay parallel across concurrent deploys. Only the on-chain signing phases
    // below are serialized via `options.signingGate` (when set).
    if (!options.skipBuild) {
        await withDeployPhase("build", "cli.deploy.build", {}, options.onEvent, async () => {
            const config = detectBuildConfig(loadDetectInput(options.projectDir));
            options.onEvent({ kind: "build-detected", config });
            await runBuild({
                cwd: options.projectDir,
                config,
                onData: (line) => options.onEvent({ kind: "build-log", line }),
            });
        });
    }

    // Everything from here on signs and submits on-chain extrinsics. Run it
    // under the signing gate so concurrent same-account deploys never read the
    // same nonce. `runGated` is a no-op passthrough when no gate is supplied
    // (the single-deploy path), preserving existing behaviour exactly.
    const runGated = <T>(fn: () => Promise<T>): Promise<T> =>
        options.signingGate ? options.signingGate.runExclusive(fn) : fn();

    const { storageResult, metadataCid } = await runGated(async () => {
        const storageAuth = maybeWrapAuthForSigning(
            setup.bulletinDeployAuthOptions,
            options,
            counter,
            setup.approvals,
        );
        // Bulletin storage chunks must sign with the local BulletInAllowance
        // slot key, never the phone signer — 2 MiB chunk txs blow the phone's
        // statement-store message cap. Resolved AFTER the wrap so the slot
        // signer never goes through the phone-approval event proxy.
        //
        // A dedicated Bulletin client lets the slot's on-chain authorization
        // be verified BEFORE the upload starts: a missing/expired grant fails
        // fast with a "re-run login" message instead of the upload dying
        // mid-flight. We do NOT gate on tx/byte quota — Bulletin `store` treats
        // those as soft limits. Best-effort: a null context just skips the
        // check. Built only for phone-mode sessions — dev mode never uses the
        // slot key.
        const authContext =
            options.mode === "phone" && options.userSigner?.source === "session"
                ? createBulletinAuthContext(options.env)
                : null;
        let storageSignerOptions: Awaited<ReturnType<typeof resolveStorageSignerOptions>>;
        try {
            storageSignerOptions = await resolveStorageSignerOptions(
                options.mode,
                options.userSigner,
                authContext?.bulletinApi,
                allowancePrompt,
            );
        } finally {
            authContext?.destroy();
        }
        const storage = await withDeployPhase(
            "storage-and-dotns",
            "cli.deploy.storage-dotns",
            { "cli.deploy.domain": label },
            options.onEvent,
            async () => {
                const { runStorageDeploy } = await import("./storage.js");
                return await runStorageDeploy({
                    content: buildAbs,
                    domainName: label,
                    auth: { ...storageAuth, ...storageSignerOptions },
                    onLogEvent: (event) => options.onEvent({ kind: "storage-event", event }),
                    env: options.env,
                });
            },
        );

        // ── Playground publish ───────────────────────────────────────────
        // Kept inside the same gated section as storage+DotNS so a single
        // app holds the signing gate for its entire on-chain run — its
        // nonces advance to completion before the next concurrent deploy
        // reads the account next-index.
        const publishedMetadataCid = await runPlaygroundPublish();
        return { storageResult: storage, metadataCid: publishedMetadataCid };
    });

    // ── Playground publish (definition, executed inside the gate above) ────
    async function runPlaygroundPublish(): Promise<string | undefined> {
        if (!setup.publishSigner) return undefined;
        // Capture the non-null signer so its narrowing survives into the
        // `publishToPlayground` closure below — TS drops property narrowing
        // across closure boundaries.
        const publishSigner = setup.publishSigner;
        // Only emit sign-request / sign-complete events for signers that
        // need user interaction (real phone sessions). When dev-mode
        // synthesises an in-process Alice signer there's no human in the
        // loop — wrapping with the signing proxy would flash a "check
        // your phone" UI callout between the synchronous request and
        // completion, contradicting the 0-approvals summary.
        const isInteractiveSigner = publishSigner.source === "session";
        const wrappedPublishSigner = isInteractiveSigner
            ? wrapResolvedSigner(
                  publishSigner,
                  "Publish to Playground registry",
                  counter,
                  (event) => options.onEvent({ kind: "signing", event }),
              )
            : publishSigner;

        const pub = await withDeployPhase(
            "playground",
            "cli.deploy.playground",
            { "cli.deploy.domain": fullDomain },
            options.onEvent,
            () =>
                publishToPlayground({
                    domain: fullDomain,
                    publishSigner: wrappedPublishSigner,
                    claimedOwnerH160: setup.claimedOwnerH160,
                    repositoryUrl: options.repositoryUrl ?? null,
                    tag: options.tag ?? null,
                    cwd: options.projectDir,
                    moddedFrom: options.moddedFrom ?? undefined,
                    onLogEvent: (event) => options.onEvent({ kind: "storage-event", event }),
                    onAllowancePrompt: allowancePrompt,
                    env: options.env,
                    isPrivate: options.playgroundPrivate,
                    isModdable: options.moddable ?? false,
                    // Route by on-chain identity, not by `--suri` provenance:
                    // only the contract's known dev signers may `publishDev`;
                    // any other local key publishes as a (reveal-gated) user.
                    isDevSigner: isKnownDevPublishSigner(publishSigner),
                }),
        );
        return pub.metadataCid;
    }

    const appUrl = buildAppUrl(fullDomain, options.env);
    const outcome: DeployOutcome = {
        fullDomain,
        appCid: storageResult.cid,
        ipfsCid: storageResult.ipfsCid,
        metadataCid,
        approvalsRequested: setup.approvals,
        appUrl,
    };
    options.onEvent({ kind: "phase-complete", phase: "done" });
    return outcome;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * When polkadot-app-deploy is about to use the user's phone signer for DotNS, wrap
 * it so each `signTx` call surfaces a lifecycle event with the right label.
 *
 * Labels are pulled from the DotNS-phase entries of `setup.approvals`, in
 * order. `resolveSignerSetup` built that list to match polkadot-app-deploy's
 * actual on-chain call sequence (the DotNS commitment / register /
 * setContenthash steps), so `seen === N` → phone shows
 * the Nth entry. If polkadot-app-deploy ever fires *more* sigs than approvals
 * anticipated, we fall back to the last known label — better than emitting
 * a bogus index. The step counter itself is plan-independent (bare
 * sequential numbers, no predicted total), so extra or skipped sigs can't
 * desync the displayed count.
 */
function maybeWrapAuthForSigning(
    auth: ReturnType<typeof resolveSignerSetup>["bulletinDeployAuthOptions"],
    options: RunDeployOptions,
    counter: SigningCounter,
    approvals: DeployApproval[],
) {
    if (!auth.signer || !auth.signerAddress) return auth;

    const labels = approvals.filter((a) => a.phase === "dotns").map((a) => a.label);
    const fallbackLabel = labels[labels.length - 1] ?? "DotNS step";
    let seen = 0;
    const wrapped = {
        publicKey: auth.signer.publicKey,
        signTx: (...args: Parameters<typeof auth.signer.signTx>) => {
            const label = labels[seen] ?? fallbackLabel;
            seen += 1;
            const proxy = wrapSignerWithEvents(auth.signer!, {
                label,
                counter,
                onEvent: (event) => options.onEvent({ kind: "signing", event }),
            });
            return proxy.signTx(...args);
        },
        signBytes: (...args: Parameters<typeof auth.signer.signBytes>) => {
            const proxy = wrapSignerWithEvents(auth.signer!, {
                label: "DotNS signBytes",
                counter,
                onEvent: (event) => options.onEvent({ kind: "signing", event }),
            });
            return proxy.signBytes(...args);
        },
    };

    return { ...auth, signer: wrapped };
}

function wrapResolvedSigner(
    resolved: ResolvedSigner,
    label: string,
    counter: SigningCounter,
    onEvent: (event: SigningEvent) => void,
): ResolvedSigner {
    return {
        ...resolved,
        signer: wrapSignerWithEvents(resolved.signer, { label, counter, onEvent }),
    };
}

function buildAppUrl(fullDomain: string, _env: Env | undefined): string {
    // Today's dot.li viewer handles both testnet and mainnet; revisit once a
    // dedicated mainnet viewer domain is announced.
    return `https://${fullDomain}.li`;
}
