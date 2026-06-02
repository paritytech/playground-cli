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
 * Pure runner for `dot decentralize` — mirrors a live site, uploads it via
 * `runStorageDeploy` (Bulletin chunked store + DotNS register), and
 * optionally publishes a minimal AppInfo entry to the playground registry.
 *
 * Signer matrix mirrors `dot deploy`: callers pass `(mode, userSigner)` and
 * the runner threads them through `resolveSignerSetup` so dev-mode-with-
 * session correctly records the user's H160 as `owner` while the dev key
 * signs the on-chain phases.
 *
 * No React/Ink imports — this file lives under `src/utils/decentralize/*`
 * which the RevX WebContainer consumes as the SDK surface.
 */

import { rmSync } from "node:fs";
import { getChainConfig, type Env } from "../../config.js";
import { publishToPlayground } from "../deploy/playground.js";
import type { DeployLogEvent } from "../deploy/progress.js";
import { type DeployApproval, resolveSignerSetup, type SignerMode } from "../deploy/signerMode.js";
import {
    createSigningCounter,
    type SigningCounter,
    type SigningEvent,
    wrapSignerWithEvents,
} from "../deploy/signingProxy.js";
import { runStorageDeploy } from "../deploy/storage.js";
import type { ResolvedSigner } from "../signer.js";
import { mirrorSite } from "./mirror.js";
import { getBulletinAllowanceSigner } from "../allowances/bulletin.js";
import { getSlotAccountAddress, readSlotAccountKey } from "../allowances/slotKeys.js";

export type DecentralizeLogEvent =
    | { kind: "mirror-start"; url: string }
    | { kind: "mirror-line"; line: string }
    | { kind: "mirror-done"; fileCount: number; directory: string }
    | { kind: "storage-start"; fullDomain: string }
    | { kind: "storage-event"; event: DeployLogEvent }
    | { kind: "storage-done"; cid: string }
    | { kind: "playground-start"; fullDomain: string }
    | { kind: "playground-event"; event: DeployLogEvent }
    | { kind: "playground-done"; metadataCid: string }
    // Phone-signing lifecycle — drives the "check your phone" callout. Only
    // emitted in phone mode (dev signers sign in-process with no human tap).
    | { kind: "signing"; event: SigningEvent };

/**
 * Translate a bulletin-deploy `DeployLogEvent` into a single human-readable
 * progress line. `chunk-progress` becomes "uploading chunk X/Y"; phase banners
 * are dropped (the TUI's step rows / the headless phase headers convey those).
 * Shared by the interactive RunningStage and the headless stdout path so both
 * surfaces read the same — no raw `event.kind` dumps.
 */
export function describeDeployEvent(event: DeployLogEvent): string | null {
    switch (event.kind) {
        case "chunk-progress":
            return `uploading chunk ${event.current}/${event.total}`;
        case "info":
            return event.message;
        case "phase-start":
            return null;
    }
}

export interface RunDecentralizeOptions {
    siteUrl: string;
    label: string;
    fullDomain: string;
    /**
     * Mirrors deploy's signer contract. "phone" requires a session in
     * `userSigner`; "dev" uses either the SURI-resolved signer (when
     * `userSigner.source === "dev"`) or the bulletin-deploy default
     * mnemonic, with the session's H160 claimed as owner when present.
     */
    mode: SignerMode;
    /**
     * The user's existing signer — either a session (from `dot init`) or
     * a SURI-resolved dev signer (when `--suri` was passed). `null` when
     * neither exists; only valid for `mode: "dev"`.
     */
    userSigner: ResolvedSigner | null;
    /**
     * When true, after the storage upload + DotNS register the runner
     * publishes a minimal AppInfo entry to the playground registry. No
     * `repository` is recorded (decentralized sites aren't moddable from
     * GitHub) and `isModdable` is forced to false.
     */
    publishToPlayground?: boolean;
    env: Env;
    onEvent?: (event: DecentralizeLogEvent) => void;
}

export interface DecentralizeOutcome {
    appUrl: string;
    fullDomain: string;
    ipfsCid: string;
    gatewayUrl: string;
    /** Present iff publishToPlayground was true and the publish succeeded. */
    metadataCid: string | null;
    /** The actual signer source used to sign the on-chain phases. */
    signerSource: ResolvedSigner["source"];
    signerAddress: string;
}

export async function runDecentralize(
    options: RunDecentralizeOptions,
): Promise<DecentralizeOutcome> {
    const { siteUrl, label, fullDomain, mode, userSigner, env, onEvent } = options;
    const wantPlayground = options.publishToPlayground === true;

    // Compose the storage + publish identities through deploy's single
    // source of truth. Same call shape as `runDeploy` so the mainnet rewrite
    // (which lives in signerMode.ts) flows through unchanged.
    const setup = resolveSignerSetup({
        mode,
        userSigner,
        publishToPlayground: wantPlayground,
    });

    // Pick the signer used for the DotNS register tx. bulletin-deploy
    // accepts `{ signer, signerAddress }` or `{}` (falls back to its
    // DEFAULT_MNEMONIC). Either way we surface a single visible address
    // for the outcome.
    const storageSignerAddress =
        setup.bulletinDeployAuthOptions.signerAddress ??
        setup.publishSigner?.address ??
        // Defensive fallback: should never hit because dev mode synthesises
        // a signer for the publish phase even when one isn't strictly
        // needed; we keep the address visible to the user either way.
        userSigner?.address ??
        "(bulletin-deploy default)";
    // Phone mode signs every on-chain phase with the session; dev mode always
    // signs with a dev key (bulletin-deploy default mnemonic or `--suri`).
    // This drives the "owned by a development account" callout — which speaks
    // to DotNS *domain* ownership (dev-signed in dev mode regardless of any
    // registry-level `claimedOwnerH160`).
    const storageSignerSource: ResolvedSigner["source"] = mode === "phone" ? "session" : "dev";

    // Shared counter across every phone tap (DotNS commitment/finalize/link
    // + the optional playground publish) so the callout reads "step N of M".
    const counter = createSigningCounter(setup.approvals.length);
    const emitSigning = (event: SigningEvent) => onEvent?.({ kind: "signing", event });

    let mirrorDir: string | null = null;

    try {
        onEvent?.({ kind: "mirror-start", url: siteUrl });
        const mirror = await mirrorSite({
            url: siteUrl,
            onLine: (line) => onEvent?.({ kind: "mirror-line", line }),
        });
        mirrorDir = mirror.directory;
        onEvent?.({
            kind: "mirror-done",
            fileCount: mirror.fileCount,
            directory: mirror.uploadRoot,
        });

        // Phone mode: attempt to resolve a BulletIn slot-account signer so
        // chunk uploads use the user's own allowance instead of the shared
        // pool. Falls back silently to pool if absent or resolution fails.
        if (mode === "phone" && userSigner) {
            try {
                onEvent?.({
                    kind: "signing",
                    event: { label: "Approve Bulletin storage allowance" },
                } as any);
                const slotSigner = await getBulletinAllowanceSigner({
                    env,
                    ownerAddress: userSigner.address,
                    publishSigner: userSigner,
                });
                const slotKey = await readSlotAccountKey(
                    env,
                    userSigner.address,
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

        onEvent?.({ kind: "storage-start", fullDomain });
        const result = await runStorageDeploy({
            // Upload from the resolved index.html parent, NOT from
            // `mirror.directory`. See `findIndexHtmlRoot` in mirror.ts.
            content: mirror.uploadRoot,
            domainName: label,
            // Wrap the DotNS auth signer so each phone tap surfaces a
            // "check your phone" lifecycle event. No-op in dev mode (auth
            // has no signer — bulletin-deploy uses its default mnemonic).
            auth: wrapAuthForSigning(
                setup.bulletinDeployAuthOptions,
                setup.approvals,
                counter,
                emitSigning,
            ),
            env,
            onLogEvent: (event) => onEvent?.({ kind: "storage-event", event }),
        });
        onEvent?.({ kind: "storage-done", cid: result.cid });

        let metadataCid: string | null = null;
        if (wantPlayground) {
            if (!setup.publishSigner) {
                // `resolveSignerSetup` always returns a `publishSigner` when
                // `publishToPlayground: true` (constructs a dev signer when
                // needed). If this ever fires, the matrix in signerMode.ts
                // has drifted out from under us.
                throw new Error(
                    "Internal error: resolveSignerSetup returned no publishSigner despite publishToPlayground=true",
                );
            }
            // Only wrap interactive (session) signers — a dev signer signs
            // in-process with no human in the loop, so flashing "check your
            // phone" would contradict the 0-taps reality.
            const publishSigner =
                setup.publishSigner.source === "session"
                    ? {
                          ...setup.publishSigner,
                          signer: wrapSignerWithEvents(setup.publishSigner.signer, {
                              label: "Publish to playground registry",
                              counter,
                              onEvent: emitSigning,
                          }),
                      }
                    : setup.publishSigner;

            onEvent?.({ kind: "playground-start", fullDomain });
            const publishResult = await publishToPlayground({
                domain: label,
                publishSigner,
                claimedOwnerH160: setup.claimedOwnerH160,
                // Mirrored sites have no git source — `repository` is omitted
                // from the metadata JSON and `is_moddable` is forced false.
                repositoryUrl: null,
                env,
                isPrivate: false,
                isModdable: false,
                isDevSigner: setup.publishSigner.source === "dev",
                onLogEvent: (event) => onEvent?.({ kind: "playground-event", event }),
            });
            metadataCid = publishResult.metadataCid;
            onEvent?.({ kind: "playground-done", metadataCid });
        }

        const cfg = getChainConfig(env);
        return {
            appUrl: `https://${fullDomain}.li`,
            fullDomain,
            ipfsCid: result.cid,
            gatewayUrl: `${cfg.bulletinGateway}${result.cid}`,
            metadataCid,
            signerSource: storageSignerSource,
            signerAddress: storageSignerAddress,
        };
    } finally {
        if (mirrorDir) {
            try {
                rmSync(mirrorDir, { recursive: true, force: true });
            } catch {
                // best-effort cleanup; tmpdir is OS-managed anyway
            }
        }
    }
}

/**
 * Wrap the bulletin-deploy DotNS auth signer so each `signTx` call surfaces a
 * "check your phone" lifecycle event labelled by the matching DotNS approval.
 * Mirrors deploy's `maybeWrapAuthForSigning`. Returns `auth` unchanged when
 * there's no signer (dev mode → bulletin-deploy uses its default mnemonic,
 * no human tap).
 */
function wrapAuthForSigning(
    auth: ReturnType<typeof resolveSignerSetup>["bulletinDeployAuthOptions"],
    approvals: DeployApproval[],
    counter: SigningCounter,
    onEvent: (event: SigningEvent) => void,
) {
    if (!auth.signer || !auth.signerAddress) return auth;

    const labels = approvals.filter((a) => a.phase === "dotns").map((a) => a.label);
    const fallbackLabel = labels[labels.length - 1] ?? "DotNS step";
    const signer = auth.signer;
    let seen = 0;

    return {
        ...auth,
        signer: {
            publicKey: signer.publicKey,
            signTx: (...args: Parameters<typeof signer.signTx>) => {
                const label = labels[seen] ?? fallbackLabel;
                seen += 1;
                return wrapSignerWithEvents(signer, { label, counter, onEvent }).signTx(...args);
            },
            signBytes: (...args: Parameters<typeof signer.signBytes>) =>
                wrapSignerWithEvents(signer, {
                    label: "DotNS signBytes",
                    counter,
                    onEvent,
                }).signBytes(...args),
        },
    };
}
