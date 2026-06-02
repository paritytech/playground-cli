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

import { runBuild, loadDetectInput, detectBuildConfig, type BuildConfig } from "../build/index.js";
import { publishToPlayground, normalizeDomain } from "./playground.js";
import { resolveSignerSetup, type SignerMode, type DeployApproval } from "./signerMode.js";
import {
    getBulletinAllowanceSigner,
} from "../allowances/bulletin.js";
import { getSlotAccountAddress, readSlotAccountKey } from "../allowances/slotKeys.js";
import {
    wrapSignerWithEvents,
    createSigningCounter,
    type SigningCounter,
    type SigningEvent,
} from "./signingProxy.js";
import type { DeployLogEvent } from "./progress.js";
import { withDeployPhase } from "./phase.js";
import type { ResolvedSigner } from "../signer.js";
import { DEFAULT_ENV, type Env } from "../../config.js";
import type { DeployPlan } from "./availability.js";

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
    /** Signer mode — `dev` uses bulletin-deploy defaults, `phone` uses the user's session. */
    mode: SignerMode;
    /** Whether to publish to the playground registry after DotNS succeeds. */
    publishToPlayground: boolean;
    /** Publish to the playground with private visibility (owner-only). Ignored when `publishToPlayground` is false. */
    playgroundPrivate?: boolean;
    /** Whether the deploy should publish source as moddable. */
    moddable?: boolean;
    /** Resolved public repository URL to record in metadata (moddable=true) or `null` (moddable=false). */
    repositoryUrl?: string | null;
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
}

export interface DeployOutcome {
    /** Canonical `<label>.dot` string. */
    fullDomain: string;
    /** Bulletin storage CID of the app bundle. */
    appCid: string;
    /** IPFS CID of the directory root, if bulletin-deploy computed one. */
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
    const { label, fullDomain } = normalizeDomain(options.domain);

    const setup = resolveSignerSetup({
        mode: options.mode,
        userSigner: options.userSigner,
        publishToPlayground: options.publishToPlayground,
        plan: options.plan,
    });

    options.onEvent({ kind: "plan", approvals: setup.approvals });

    // Phone mode: attempt to resolve a BulletIn slot-account signer so chunk
    // uploads use the user's own allowance instead of the shared pool. Falls
    // back silently to pool if the key is absent or resolution fails for any
    // reason — bulletin-deploy handles the pool path internally.
    if (options.mode === "phone" && options.userSigner) {
        const resolvedEnv = options.env ?? DEFAULT_ENV;
        try {
            options.onEvent({
                kind: "signing",
                event: { label: "Approve Bulletin storage allowance" },
            } as any);
            const slotSigner = await getBulletinAllowanceSigner({
                env: resolvedEnv,
                ownerAddress: options.userSigner.address,
                publishSigner: options.userSigner,
            });
            const slotKey = await readSlotAccountKey(
                resolvedEnv,
                options.userSigner.address,
                "BulletInAllowance",
            );
            const slotSs58 = slotKey ? getSlotAccountAddress(slotKey) : undefined;
            if (slotSs58) {
                setup.bulletinDeployAuthOptions = {
                    ...setup.bulletinDeployAuthOptions,
                    storageSigner: slotSigner,
                    storageSignerAddress: slotSs58,
                };
            }
        } catch {
            // Slot signer resolution failed — pool fallback handled by bulletin-deploy.
        }
    }

    const counter = createSigningCounter(setup.approvals.length);

    const buildAbs = options.buildDir;

    const frontendPromise = (async () => {
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

        const storageAuth = maybeWrapAuthForSigning(
            setup.bulletinDeployAuthOptions,
            options,
            counter,
            setup.approvals,
        );
        return await withDeployPhase(
            "storage-and-dotns",
            "cli.deploy.storage-dotns",
            { "cli.deploy.domain": label },
            options.onEvent,
            async () => {
                const { runStorageDeploy } = await import("./storage.js");
                return await runStorageDeploy({
                    content: buildAbs,
                    domainName: label,
                    auth: storageAuth,
                    onLogEvent: (event) => options.onEvent({ kind: "storage-event", event }),
                    env: options.env,
                });
            },
        );
    })();

    const storageResult = await frontendPromise;

    // ── Playground publish ───────────────────────────────────────────────
    let metadataCid: string | undefined;
    if (setup.publishSigner) {
        // Only emit sign-request / sign-complete events for signers that
        // need user interaction (real phone sessions). When dev-mode
        // synthesises an in-process Alice signer there's no human in the
        // loop — wrapping with the signing proxy would flash a "check
        // your phone" UI callout between the synchronous request and
        // completion, contradicting the 0-approvals summary.
        const isInteractiveSigner = setup.publishSigner.source === "session";
        const wrappedPublishSigner = isInteractiveSigner
            ? wrapResolvedSigner(
                  setup.publishSigner,
                  "Publish to Playground registry",
                  counter,
                  (event) => options.onEvent({ kind: "signing", event }),
              )
            : setup.publishSigner;

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
                    cwd: options.projectDir,
                    onLogEvent: (event) => options.onEvent({ kind: "storage-event", event }),
                    env: options.env,
                    isPrivate: options.playgroundPrivate,
                    isModdable: options.moddable ?? false,
                    isDevSigner: setup.publishSigner.source === "dev",
                }),
        );
        metadataCid = pub.metadataCid;
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
 * When bulletin-deploy is about to use the user's phone signer for DotNS, wrap
 * it so each `signTx` call surfaces a lifecycle event with the right label.
 *
 * Labels are pulled from the DotNS-phase entries of `setup.approvals`, in
 * order. `resolveSignerSetup` built that list to match bulletin-deploy's
 * actual on-chain call sequence (including the optional `setUserPopStatus`
 * at the start when a PoP upgrade is needed), so `seen === N` → phone shows
 * the Nth entry. If bulletin-deploy ever fires *more* sigs than approvals
 * anticipated, we fall back to the last known label — better than emitting
 * a bogus index — and `createSigningCounter` simultaneously extends `total`
 * so the TUI shows "step N of N" instead of "N of N-1".
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
