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
 * Pure stage-machine + helpers for `dot decentralize`'s interactive TUI.
 *
 * Lives in a `.ts` (not `.tsx`) so tests can exercise the prompt ordering
 * without importing Ink / React. Mirrors the layout convention used by
 * `login/completion.ts`, `login/identityLine.ts`, etc.
 */

import { getEnvTld } from "../../config.js";
import { normalizeDomain } from "../../utils/deploy/playground.js";
import { prepareLocalDirectory } from "../../utils/decentralize/local.js";
import type { DecentralizeOutcome } from "../../utils/decentralize/run.js";
import type { SignerMode } from "../../utils/deploy/signerMode.js";

export type SourceKind = "url" | "path";

export type Stage =
    | { kind: "prompt-source" }
    | { kind: "prompt-url" }
    | { kind: "prompt-path" }
    | { kind: "prompt-signer" }
    | { kind: "prompt-domain" }
    | { kind: "validate-domain"; raw: string }
    | { kind: "prompt-publish" }
    | { kind: "prompt-moddable" }
    | { kind: "moddable-preflight" }
    // Entered imperatively by the screen when the preflight fails (missing /
    // private / non-GitHub origin) — never returned by `pickNextStage`.
    | { kind: "moddable-error"; message: string }
    | { kind: "prompt-tags" }
    | { kind: "confirm" }
    | { kind: "running" }
    | { kind: "done"; outcome: DecentralizeOutcome }
    | { kind: "error"; message: string };

export interface PickStageInput {
    /**
     * Where the site content comes from: a live URL (mirrored) or a local
     * build directory (uploaded as-is). `null` until the user picks in the
     * source prompt; pre-set to `"url"` when the caller passed a site URL.
     */
    sourceKind: SourceKind | null;
    /** Site URL once submitted. Only relevant when `sourceKind === "url"`. */
    siteUrl: string | null;
    /** Local directory once submitted. Only relevant when `sourceKind === "path"`. */
    localPath: string | null;
    /**
     * `null` when neither --suri nor a session signer has resolved one yet
     * AND the user hasn't picked a mode in the TUI. `"phone" | "dev"` once a
     * choice is locked in.
     */
    signerMode: SignerMode | null;
    /** Normalized `.dot` label (without `.dot`) once the validate step has accepted it. */
    domainLabel: string | null;
    /** Raw user input from the domain prompt. `null` if the prompt hasn't happened yet. */
    domainRaw: string | null;
    /**
     * Whether to publish to the playground registry after the storage upload.
     * `null` ⇒ user hasn't answered the prompt yet; `true`/`false` locks the
     * choice and unblocks the confirm stage. Pre-set when the caller passed
     * `--playground` so the prompt is skipped.
     */
    publishToPlayground: boolean | null;
    /**
     * Whether to record the path directory's public GitHub origin so others
     * can `playground mod` the app. Only asked for `path` sources that
     * publish to the playground (mirrored URL sites have no git source).
     * `null` ⇒ not answered yet; pre-set to `true` when the caller passed
     * `--moddable` so the prompt is skipped and the preflight runs directly.
     */
    moddable: boolean | null;
    /**
     * Public GitHub URL resolved by the moddable preflight. `null` until the
     * preflight succeeds; `moddable === true` without it keeps the preflight
     * stage up.
     */
    repositoryUrl: string | null;
    /**
     * Category tag for the playground listing (tri-state, mirroring deploy):
     * `undefined` ⇒ not asked yet (the tag prompt runs when publishing);
     * `null` ⇒ explicitly skipped (untagged); a string ⇒ a chosen tag. Pre-set
     * to a string when `--tag` was passed so the prompt is skipped. Only
     * consulted when publishing — omitted entirely when not.
     */
    tag?: string | null;
}

/**
 * Decide which prompt stage to show next given the inputs collected so far.
 * source → URL|path → signer → domain → validate-domain → publish? →
 * moddable? (path-only) → tag? → confirm. Each missing piece surfaces its
 * prompt; once everything is filled the `confirm` stage gates the actual run.
 * Moddable and tag are publish-only follow-ups (mirroring deploy): moddable is
 * asked first and only for `path` sources, then the tag prompt runs unless
 * `--tag` pre-filled it.
 *
 * `domainRaw` exists so the screen can distinguish "user hasn't been
 * asked yet" from "user typed input but validation hasn't finished".
 */
export function pickNextStage(input: PickStageInput): Stage {
    if (input.sourceKind === null) return { kind: "prompt-source" };
    if (input.sourceKind === "url" && input.siteUrl === null) return { kind: "prompt-url" };
    if (input.sourceKind === "path" && input.localPath === null) return { kind: "prompt-path" };
    if (input.signerMode === null) return { kind: "prompt-signer" };
    if (input.domainLabel === null) {
        if (input.domainRaw === null) return { kind: "prompt-domain" };
        return { kind: "validate-domain", raw: input.domainRaw };
    }
    if (input.publishToPlayground === null) return { kind: "prompt-publish" };
    // Moddable applies only to local-directory publishes — a mirrored URL has
    // no git source to record. The screen, not this picker, transitions to
    // `moddable-error` when the preflight fails.
    if (input.sourceKind === "path" && input.publishToPlayground === true) {
        if (input.moddable === null) return { kind: "prompt-moddable" };
        // --moddable via flag: skip the prompt, drive straight into preflight.
        if (input.moddable === true && input.repositoryUrl === null) {
            return { kind: "moddable-preflight" };
        }
    }
    // Tag is the last publish-only choice: asked after the moddable decision is
    // resolved, only when publishing and no `--tag` flag already set it
    // (`undefined` = not asked yet).
    if (input.publishToPlayground && input.tag === undefined) return { kind: "prompt-tags" };
    return { kind: "confirm" };
}

/**
 * Allow callers to validate a typed site URL before submission. Matches
 * `mirror.ts`'s tolerance: bare hostnames (`example.com`) are accepted —
 * `mirrorSite` will prepend `https://` itself — but anything with a
 * non-http(s) scheme is rejected up front.
 *
 * Returns `null` when the input is acceptable, an error message otherwise.
 */
export function validateSiteUrlInput(raw: string): string | null {
    const trimmed = raw.trim();
    if (!trimmed) return "enter a URL";
    if (/^https?:\/\//i.test(trimmed)) return null;
    if (/^[a-z]+:\/\//i.test(trimmed)) return "only http(s) URLs are supported";
    // Bare hostname — mirror.ts will normalise it.
    if (/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(\/.*)?$/i.test(trimmed)) return null;
    return "doesn't look like a URL";
}

/**
 * Inline TUI gate for the local-directory prompt. Delegates the real checks
 * (exists, is a directory, contains an index.html somewhere) to
 * `prepareLocalDirectory` — the same validation the run itself applies — and
 * surfaces its actionable message inline. Sync fs is fine here: the theme
 * `Input` runs `validate` only on submit, never per keystroke.
 *
 * Returns `null` when the input is acceptable, an error message otherwise.
 */
export function validateLocalPathInput(raw: string): string | null {
    const trimmed = raw.trim();
    if (!trimmed) return "enter a directory path";
    try {
        prepareLocalDirectory(trimmed);
        return null;
    } catch (err) {
        return err instanceof Error ? err.message : String(err);
    }
}

/**
 * Inline TUI gate for the domain prompt. Delegates to `normalizeDomain` (the
 * same TLD-aware canonicalization `dot deploy` applies), tolerating an
 * optional `.<tld>` suffix for the env's TLD and rejecting a wrong-TLD suffix
 * (e.g. `.dot` on a `.paseo` env) with the same actionable message the deploy
 * path produces. Availability + reservation are decided by the chain in the
 * validate-domain stage; this just rejects names the chain would reject so
 * the user sees the error inline rather than after submit.
 */
export function validateDomainInput(raw: string, tld: string = getEnvTld()): string | null {
    const trimmed = raw.trim();
    if (!trimmed) return null; // empty = "auto-generate from URL"
    try {
        normalizeDomain(trimmed, tld);
        return null;
    } catch (err) {
        return err instanceof Error ? err.message : String(err);
    }
}
