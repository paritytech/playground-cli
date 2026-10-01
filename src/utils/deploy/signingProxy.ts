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
 * Wraps a `PolkadotSigner` so the TUI can render a "check your phone" panel
 * around each signing call. We cannot infer this from polkadot-app-deploy's
 * stdout (the log is printed before the signer is invoked and gives no
 * completion hook), so the reliable place to hook is the signer itself.
 */

import type { PolkadotSigner } from "polkadot-api";
import type { AllowancePrompt } from "../allowances/bulletin.js";

export type SigningEvent =
    /** `attempt` is 1 for the first request of a step, 2+ for a re-send of the same approval. */
    | { kind: "sign-request"; label: string; step: number; attempt: number }
    | { kind: "sign-complete"; label: string; step: number }
    | { kind: "sign-error"; label: string; step: number; message: string };

export interface SigningCounter {
    /**
     * Reserve a step for a signature request labelled `label`. Repeating the
     * label of a request that has not completed is a RE-SEND of the same
     * approval — same step, next attempt — not a new step.
     */
    next(label: string): { step: number; attempt: number };
    /** Mark `step` approved, so the next request is a new step even if it repeats the label. */
    complete(step: number): void;
    /** How many distinct steps were reserved so far — useful for a final tally. */
    count(): number;
}

/**
 * Sequential tap counter shared across a whole deploy run. Deliberately has
 * NO predicted total: the pre-deploy approvals plan regularly diverged from
 * what polkadot-app-deploy actually submitted (e.g. a predicted `setUserPopStatus`
 * that runtime skipped left users on "step 4 of 5" with no fifth step), and
 * RFC-0010 allowance taps are demand-driven so they can't be counted up
 * front. The UI shows "step 1", "step 2", … and never has to guess.
 *
 * Steps count APPROVALS, not requests. When the phone does not answer (the
 * usual cause is the app not being in the foreground, which shows no prompt
 * at all), bulletin-deploy times out and calls `signTx` again — often while
 * the first call is still pending, so a "not completed" request is the signal,
 * not a rejection. Numbering each request made a stall read as progress: a
 * user who had approved nothing saw "step 3: Link content" on a deploy that
 * needs two approvals.
 */
export function createSigningCounter(): SigningCounter {
    let step = 0;
    let current: { label: string; attempt: number; done: boolean } | null = null;
    return {
        next(label) {
            if (current && !current.done && current.label === label) {
                current.attempt += 1;
                return { step, attempt: current.attempt };
            }
            step += 1;
            current = { label, attempt: 1, done: false };
            return { step, attempt: 1 };
        },
        complete(completed) {
            // A late completion of an EARLIER step must not close the current one.
            if (current && completed === step) current.done = true;
        },
        count() {
            return step;
        },
    };
}

export interface WrapOptions {
    /** Human-readable label that names what the user is approving (shown on-screen). */
    label: string;
    /** Step counter shared across a whole deploy run so "2 of 4" counts correctly. */
    counter: SigningCounter;
    /** Sink for the signing lifecycle events. */
    onEvent: (event: SigningEvent) => void;
}

/**
 * Returns a new `PolkadotSigner` that mirrors `inner` but emits lifecycle
 * events around each signing call. The wrapper does NOT swallow errors — the
 * original rejection still propagates — it only surfaces them to `onEvent`
 * so the TUI can render a red banner.
 */
export function wrapSignerWithEvents(inner: PolkadotSigner, options: WrapOptions): PolkadotSigner {
    const announce = async <T>(fn: () => Promise<T>): Promise<T> => {
        const { step, attempt } = options.counter.next(options.label);
        options.onEvent({ kind: "sign-request", label: options.label, step, attempt });
        try {
            const value = await fn();
            options.counter.complete(step);
            options.onEvent({ kind: "sign-complete", label: options.label, step });
            return value;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            options.onEvent({ kind: "sign-error", label: options.label, step, message });
            throw err;
        }
    };

    return {
        publicKey: inner.publicKey,
        signTx: (callData, signedExtensions, metadata, atBlockNumber, hasher) =>
            announce(() =>
                inner.signTx(callData, signedExtensions, metadata, atBlockNumber, hasher),
            ),
        signBytes: (data) => announce(() => inner.signBytes(data)),
    };
}

/**
 * Wraps the phone signer handed to bulletin-deploy for DotNS, labelling each
 * `signTx` with the operation it signs. `labels` lists the DotNS approvals in
 * the order bulletin-deploy fires them (`signerMode.ts::dotnsApprovals`); past
 * the end of the list we repeat the last label rather than invent an index.
 *
 * The label advances on COMPLETED signatures, not on calls: a timed-out
 * request is re-sent as another `signTx` for the SAME operation (often while
 * the first is still pending), and counting calls relabelled that retry as the
 * next operation — a re-sent commitment showed up as "Finalize domain". `max`
 * keeps a late completion of an abandoned attempt from skipping a label.
 */
export function wrapDotnsSigner(
    inner: PolkadotSigner,
    labels: string[],
    counter: SigningCounter,
    onEvent: (event: SigningEvent) => void,
): PolkadotSigner {
    const fallbackLabel = labels[labels.length - 1] ?? "DotNS step";
    let completed = 0;
    return {
        publicKey: inner.publicKey,
        signTx: async (...args) => {
            const index = completed;
            const signed = await wrapSignerWithEvents(inner, {
                label: labels[index] ?? fallbackLabel,
                counter,
                onEvent,
            }).signTx(...args);
            completed = Math.max(completed, index + 1);
            return signed;
        },
        signBytes: (data) =>
            wrapSignerWithEvents(inner, { label: "DotNS signBytes", counter, onEvent }).signBytes(
                data,
            ),
    };
}

/**
 * Prompt factory for phone taps that are NOT signer calls: RFC-0010
 * resource-allocation requests (the first-use Bulletin allowance grant). They
 * ride the statement store outside any `PolkadotSigner`, so
 * `wrapSignerWithEvents` never sees them — until this existed the phone
 * showed an approval dialog while the deploy TUI sat silent.
 *
 * The returned function implements
 * `allowances/bulletin.ts::AllowancePrompt`: call it right before sending the
 * request, then close the handle when the request resolves. Steps come from
 * the same shared counter as signing taps, so the user sees one continuous
 * "step 1, step 2, …" sequence across both kinds of approval.
 */
export function createApprovalPrompt(
    counter: SigningCounter,
    onEvent: (event: SigningEvent) => void,
): AllowancePrompt {
    return (label) => {
        const { step, attempt } = counter.next(label);
        onEvent({ kind: "sign-request", label, step, attempt });
        return {
            complete: () => {
                counter.complete(step);
                onEvent({ kind: "sign-complete", label, step });
            },
            fail: (message) => onEvent({ kind: "sign-error", label, step, message }),
        };
    };
}
