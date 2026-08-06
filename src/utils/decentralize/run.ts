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
 * Pure runner for `dot decentralize` — takes a site (mirrored from a live
 * URL, or an already-built local directory via `--path`), uploads it via
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
import {
    type DeployApproval,
    DEV_PUBLISH_ADDRESS,
    isKnownDevPublishSigner,
    resolveSignerSetup,
    resolveStorageSignerOptions,
    type SignerMode,
} from "../deploy/signerMode.js";
import {
    createSigningCounter,
    createApprovalPrompt,
    type SigningCounter,
    type SigningEvent,
    wrapSignerWithEvents,
} from "../deploy/signingProxy.js";
import { runStorageDeploy } from "../deploy/storage.js";
import type { ResolvedSigner } from "../signer.js";
import { findProjectRoot, prepareLocalDirectory } from "./local.js";
import { mirrorSite } from "./mirror.js";

/**
 * What the site content comes from: a live URL (mirrored with wget into a
 * temp dir) or an already-built local directory (`--path`, uploaded in
 * place — never deleted). Both converge on `runStorageDeploy({ content })`.
 */
export type DecentralizeSource = { kind: "url"; url: string } | { kind: "path"; directory: string };

/**
 * Emit a "this is a large site" warning once the mirror crosses this many
 * downloaded files. wget runs with `--no-verbose`, so it prints roughly one
 * line per saved file — counting `mirror-line` events approximates the file
 * count without parsing. A user (issue #333) mirrored a big site and waited
 * minutes with no indication it would take a while; this surfaces that the
 * download is large and reminds the user Ctrl+C cancels.
 */
export const LARGE_SITE_FILE_THRESHOLD = 200;

export type DecentralizeLogEvent =
    | { kind: "mirror-start"; url: string }
    | { kind: "mirror-line"; line: string }
    // Fired once, mid-mirror, when the downloaded-file count crosses
    // `LARGE_SITE_FILE_THRESHOLD`. Surfaces a "large site, this may take a
    // while — Ctrl+C to cancel" warning.
    | { kind: "mirror-large"; fileCount: number }
    | { kind: "mirror-done"; fileCount: number; directory: string }
    // `--path` flow: local directory validated and ready to upload. Mirrors
    // `mirror-done`'s shape; no start/line/large events precede it (there is
    // no download to wait for).
    | { kind: "local-done"; fileCount: number; directory: string }
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
 * Translate a polkadot-app-deploy `DeployLogEvent` into a single human-readable
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
    source: DecentralizeSource;
    label: string;
    fullDomain: string;
    /**
     * Mirrors deploy's signer contract. "phone" requires a session in
     * `userSigner`; "dev" uses either the SURI-resolved signer (when
     * `userSigner.source === "dev"`) or the polkadot-app-deploy default
     * mnemonic, with the session's H160 claimed as owner when present.
     */
    mode: SignerMode;
    /**
     * The user's existing signer — either a session (from `dot login`) or
     * a SURI-resolved dev signer (when `--suri` was passed). `null` when
     * neither exists; only valid for `mode: "dev"`.
     */
    userSigner: ResolvedSigner | null;
    /**
     * When true, after the storage upload + DotNS register the runner
     * publishes a minimal AppInfo entry to the playground registry. For
     * `path` sources the directory's README.md (if any) is inlined as the
     * app's detail page; URL sources have no project root so no README is
     * recorded.
     */
    publishToPlayground?: boolean;
    /**
     * Single playground category tag for the listing. `null`/omitted publishes
     * untagged. Only consulted when `publishToPlayground` is true. Mirrors
     * deploy's `--tag`; values come from `PLAYGROUND_TAGS`.
     */
    tag?: string | null;
    /**
     * Public GitHub URL to record in the playground metadata so others can
     * `playground mod` the app. Callers preflight it (`resolveRepositoryUrl`
     * — git origin exists, public, GitHub) before passing it in; the runner
     * just threads it through. Only meaningful for `path` sources — mirrored
     * URL sites have no git source, so URL-mode callers always pass
     * null/omit, and `isModdable` stays false.
     */
    repositoryUrl?: string | null;
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
    const { source, label, fullDomain, mode, userSigner, env, onEvent } = options;
    const wantPlayground = options.publishToPlayground === true;

    // Compose the storage + publish identities through deploy's single
    // source of truth. Same call shape as `runDeploy` so the mainnet rewrite
    // (which lives in signerMode.ts) flows through unchanged.
    const setup = resolveSignerSetup({
        mode,
        userSigner,
        publishToPlayground: wantPlayground,
    });

    // Pick the signer used for the DotNS register tx. polkadot-app-deploy gets
    // `{ signer, signerAddress }` (phone / `--suri`) or `{ mnemonic }` (dev —
    // always explicit, never `{}`: empty options make 0.8.x resolve the
    // persisted phone session). Either way we surface a single visible
    // address for the outcome; the dev mnemonic's bare root is
    // `DEV_PUBLISH_ADDRESS`.
    const storageSignerAddress =
        setup.bulletinDeployAuthOptions.signerAddress ??
        (setup.bulletinDeployAuthOptions.mnemonic ? DEV_PUBLISH_ADDRESS : null) ??
        setup.publishSigner?.address ??
        // Defensive fallback: should never hit because dev mode synthesises
        // a signer for the publish phase even when one isn't strictly
        // needed; we keep the address visible to the user either way.
        userSigner?.address ??
        "(polkadot-app-deploy default)";
    // Phone mode signs every on-chain phase with the session; dev mode always
    // signs with a dev key (polkadot-app-deploy default mnemonic or `--suri`).
    // This drives the "owned by a development account" callout — which speaks
    // to DotNS *domain* ownership (dev-signed in dev mode regardless of any
    // registry-level `claimedOwnerH160`).
    const storageSignerSource: ResolvedSigner["source"] = mode === "phone" ? "session" : "dev";

    // Shared counter across every phone tap (DotNS commitment/finalize/link,
    // RFC-0010 allowance grants, the optional playground publish) so the
    // callout reads "step 1", "step 2", … — bare sequential numbers, no
    // predicted total (plans drifted from runtime and stranded users on
    // "step 4 of 5").
    const counter = createSigningCounter();
    const emitSigning = (event: SigningEvent) => onEvent?.({ kind: "signing", event });
    // "Check your phone" surface for allocation taps (the first-use Bulletin
    // slot grant) — they happen outside any PolkadotSigner, so the signer
    // wrap below can't see them.
    const allowancePrompt = createApprovalPrompt(counter, emitSigning);

    // Set ONLY by the url branch — it's the temp dir the `finally` cleanup
    // deletes. The path branch must leave it null: the upload root there is
    // the user's own directory.
    let mirrorDir: string | null = null;

    try {
        let uploadRoot: string;
        if (source.kind === "url") {
            onEvent?.({ kind: "mirror-start", url: source.url });
            // Count wget output lines (≈ one per saved file under `--no-verbose`)
            // so we can warn once when the mirror turns out to be large.
            let mirrorLineCount = 0;
            let largeSiteWarned = false;
            const mirror = await mirrorSite({
                url: source.url,
                onLine: (line) => {
                    onEvent?.({ kind: "mirror-line", line });
                    mirrorLineCount += 1;
                    if (!largeSiteWarned && mirrorLineCount >= LARGE_SITE_FILE_THRESHOLD) {
                        largeSiteWarned = true;
                        onEvent?.({ kind: "mirror-large", fileCount: mirrorLineCount });
                    }
                },
            });
            mirrorDir = mirror.directory;
            // Upload from the resolved index.html parent, NOT from
            // `mirror.directory`. See `findIndexHtmlRoot` in mirror.ts.
            uploadRoot = mirror.uploadRoot;
            onEvent?.({
                kind: "mirror-done",
                fileCount: mirror.fileCount,
                directory: mirror.uploadRoot,
            });
        } else {
            const local = prepareLocalDirectory(source.directory);
            uploadRoot = local.uploadRoot;
            onEvent?.({
                kind: "local-done",
                fileCount: local.fileCount,
                directory: local.uploadRoot,
            });
        }

        // Bulletin storage chunks must sign with the local BulletInAllowance
        // slot key, never the phone signer — chunk txs blow the phone's
        // statement-store message cap. See resolveStorageSignerOptions.
        const storageSignerOptions = await resolveStorageSignerOptions(
            mode,
            userSigner,
            undefined,
            allowancePrompt,
        );

        onEvent?.({ kind: "storage-start", fullDomain });
        const result = await runStorageDeploy({
            content: uploadRoot,
            domainName: label,
            // Wrap the DotNS auth signer so each phone tap surfaces a
            // "check your phone" lifecycle event. No-op in dev mode (auth
            // carries a mnemonic, not a signer — signed in-process).
            auth: {
                ...wrapAuthForSigning(
                    setup.bulletinDeployAuthOptions,
                    setup.approvals,
                    counter,
                    emitSigning,
                ),
                ...storageSignerOptions,
            },
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

            // Preflighted by the caller; null/omitted for mirrored URL sites
            // (no git source) and for path publishes that declined moddable.
            const repositoryUrl = options.repositoryUrl ?? null;
            onEvent?.({ kind: "playground-start", fullDomain });
            const publishResult = await publishToPlayground({
                domain: label,
                publishSigner,
                claimedOwnerH160: setup.claimedOwnerH160,
                repositoryUrl,
                tag: options.tag ?? null,
                // Path sources have a real project root — its README.md (if
                // any) becomes the app's playground detail page. Resolve the
                // repo root from the typed dir (which is usually a build output
                // like ./dist whose README sits one level up), so the README
                // and the moddable `repository` metadata share one anchor. URL
                // sources upload a temp mirror with no project root.
                cwd: source.kind === "path" ? findProjectRoot(source.directory) : undefined,
                env,
                isPrivate: false,
                isModdable: repositoryUrl !== null,
                // Route by on-chain identity, not by `--suri` provenance —
                // same rule as deploy/run.ts: only the contract's known dev
                // signers may `publishDev`; any other local key publishes as
                // a (reveal-gated) user.
                isDevSigner: isKnownDevPublishSigner(setup.publishSigner),
                onLogEvent: (event) => onEvent?.({ kind: "playground-event", event }),
                onAllowancePrompt: allowancePrompt,
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
 * Wrap the polkadot-app-deploy DotNS auth signer so each `signTx` call surfaces a
 * "check your phone" lifecycle event labelled by the matching DotNS approval.
 * Mirrors deploy's `maybeWrapAuthForSigning`. Returns `auth` unchanged when
 * there's no signer (dev mode → explicit dev mnemonic signed in-process,
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
