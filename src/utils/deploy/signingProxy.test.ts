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

import { describe, it, expect } from "vitest";
import type { PolkadotSigner } from "polkadot-api";
import {
    createSigningCounter,
    createApprovalPrompt,
    wrapDotnsSigner,
    wrapSignerWithEvents,
    type SigningEvent,
} from "./signingProxy.js";

describe("createSigningCounter", () => {
    it("returns bare sequential step numbers with no predicted total", () => {
        // Regression: the counter used to carry a plan-derived total, and a
        // plan that over-predicted (e.g. a `setUserPopStatus` tx that runtime
        // skipped) stranded users on "step 4 of 5" with no fifth step. The
        // counter now just numbers taps as they happen.
        const c = createSigningCounter();
        expect(c.next("a")).toEqual({ step: 1, attempt: 1 });
        expect(c.next("b")).toEqual({ step: 2, attempt: 1 });
        expect(c.next("c")).toEqual({ step: 3, attempt: 1 });
        expect(c.count()).toBe(3);
    });

    /**
     * Seen live: a user who had approved NOTHING saw "step 3: Link content" on
     * a deploy that needs two approvals — each unanswered request was re-sent
     * and numbered as the next step.
     */
    it("numbers a re-send of an uncompleted request as the same step, next attempt", () => {
        const c = createSigningCounter();
        expect(c.next("Link content")).toEqual({ step: 1, attempt: 1 });
        expect(c.next("Link content")).toEqual({ step: 1, attempt: 2 });
        expect(c.next("Link content")).toEqual({ step: 1, attempt: 3 });
        expect(c.count()).toBe(1);
    });

    it("starts a new step for a repeated label once the previous one completed", () => {
        // A legitimately repeated operation (e.g. the fallback DotNS label when
        // bulletin-deploy fires more signatures than planned) is progress.
        const c = createSigningCounter();
        const { step } = c.next("DotNS step");
        c.complete(step);
        expect(c.next("DotNS step")).toEqual({ step: 2, attempt: 1 });
    });

    it("moves on to a new step when the label changes", () => {
        const c = createSigningCounter();
        c.next("Link content");
        expect(c.next("Publish to Playground registry")).toEqual({ step: 2, attempt: 1 });
    });

    it("ignores a late completion of an earlier step", () => {
        const c = createSigningCounter();
        c.complete(c.next("Link content").step);
        c.next("Publish to Playground registry");
        c.complete(1);
        expect(c.next("Publish to Playground registry")).toEqual({ step: 2, attempt: 2 });
    });
});

/** A phone signer whose calls stay pending until the test settles them. */
function fakePhoneSigner() {
    const pending: { resolve: (v: Uint8Array) => void; reject: (e: Error) => void }[] = [];
    const signer: PolkadotSigner = {
        publicKey: new Uint8Array(32),
        signTx: () =>
            new Promise<Uint8Array>((resolve, reject) => pending.push({ resolve, reject })),
        signBytes: () =>
            new Promise<Uint8Array>((resolve, reject) => pending.push({ resolve, reject })),
    };
    return { signer, pending };
}

const signTxArgs = [new Uint8Array(), {}, new Uint8Array(), 0] as unknown as Parameters<
    PolkadotSigner["signTx"]
>;
const flush = () => new Promise((r) => setTimeout(r, 0));
const requests = (events: SigningEvent[]) =>
    events
        .filter((e) => e.kind === "sign-request")
        .map(({ label, step, attempt }: any) => ({
            label,
            step,
            attempt,
        }));

describe("wrapSignerWithEvents", () => {
    it("reports a re-send while the first request is still pending as a retry", async () => {
        // bulletin-deploy times out and calls signTx again WITHOUT the first
        // call ever settling, so "not completed" — not a rejection — is the signal.
        const events: SigningEvent[] = [];
        const { signer, pending } = fakePhoneSigner();
        const wrapped = wrapSignerWithEvents(signer, {
            label: "Publish to Playground registry",
            counter: createSigningCounter(),
            onEvent: (e) => events.push(e),
        });

        void wrapped.signTx(...signTxArgs);
        const retry = wrapped.signTx(...signTxArgs);
        pending[1]!.resolve(new Uint8Array([1]));
        await retry;

        expect(events).toEqual([
            { kind: "sign-request", label: "Publish to Playground registry", step: 1, attempt: 1 },
            { kind: "sign-request", label: "Publish to Playground registry", step: 1, attempt: 2 },
            { kind: "sign-complete", label: "Publish to Playground registry", step: 1 },
        ]);
    });

    it("reports a re-send after a rejected request as a retry", async () => {
        const events: SigningEvent[] = [];
        const { signer, pending } = fakePhoneSigner();
        const wrapped = wrapSignerWithEvents(signer, {
            label: "Link content",
            counter: createSigningCounter(),
            onEvent: (e) => events.push(e),
        });

        const first = wrapped.signTx(...signTxArgs);
        pending[0]!.reject(new Error("timed out"));
        await expect(first).rejects.toThrow("timed out");
        void wrapped.signTx(...signTxArgs);

        expect(requests(events)).toEqual([
            { label: "Link content", step: 1, attempt: 1 },
            { label: "Link content", step: 1, attempt: 2 },
        ]);
    });
});

describe("wrapDotnsSigner", () => {
    const REGISTER = ["Reserve domain", "Finalize domain", "Link content"];

    it("keeps a re-sent DotNS request on its own label instead of the next one", async () => {
        // Regression: labels advanced per signTx CALL, so a re-sent commitment
        // was shown as "Finalize domain".
        const events: SigningEvent[] = [];
        const { signer, pending } = fakePhoneSigner();
        const wrapped = wrapDotnsSigner(signer, REGISTER, createSigningCounter(), (e) =>
            events.push(e),
        );

        void wrapped.signTx(...signTxArgs); // never answered
        const retry = wrapped.signTx(...signTxArgs);
        pending[1]!.resolve(new Uint8Array([1]));
        await retry;
        void wrapped.signTx(...signTxArgs);

        expect(requests(events)).toEqual([
            { label: "Reserve domain", step: 1, attempt: 1 },
            { label: "Reserve domain", step: 1, attempt: 2 },
            { label: "Finalize domain", step: 2, attempt: 1 },
        ]);
    });

    it("reproduces the live report: three unanswered Link content requests are ONE step", async () => {
        const events: SigningEvent[] = [];
        const counter = createSigningCounter();
        const { signer, pending } = fakePhoneSigner();
        const dotns = wrapDotnsSigner(signer, ["Link content"], counter, (e) => events.push(e));
        const publish = wrapSignerWithEvents(signer, {
            label: "Publish to Playground registry",
            counter,
            onEvent: (e) => events.push(e),
        });

        void dotns.signTx(...signTxArgs);
        void dotns.signTx(...signTxArgs);
        const third = dotns.signTx(...signTxArgs);
        pending[2]!.resolve(new Uint8Array([1]));
        await third;
        void publish.signTx(...signTxArgs);

        expect(requests(events)).toEqual([
            { label: "Link content", step: 1, attempt: 1 },
            { label: "Link content", step: 1, attempt: 2 },
            { label: "Link content", step: 1, attempt: 3 },
            { label: "Publish to Playground registry", step: 2, attempt: 1 },
        ]);
    });

    it("does not skip a label when an abandoned attempt completes late", async () => {
        const events: SigningEvent[] = [];
        const { signer, pending } = fakePhoneSigner();
        const wrapped = wrapDotnsSigner(signer, REGISTER, createSigningCounter(), (e) =>
            events.push(e),
        );

        const abandoned = wrapped.signTx(...signTxArgs);
        const retry = wrapped.signTx(...signTxArgs);
        pending[1]!.resolve(new Uint8Array([1]));
        await retry;
        pending[0]!.resolve(new Uint8Array([2]));
        await abandoned;
        await flush();
        void wrapped.signTx(...signTxArgs);

        expect(requests(events).at(-1)).toEqual({ label: "Finalize domain", step: 2, attempt: 1 });
    });

    it("repeats the last label past the end of the plan", async () => {
        const events: SigningEvent[] = [];
        const { signer, pending } = fakePhoneSigner();
        const wrapped = wrapDotnsSigner(signer, ["Link content"], createSigningCounter(), (e) =>
            events.push(e),
        );

        const first = wrapped.signTx(...signTxArgs);
        pending[0]!.resolve(new Uint8Array([1]));
        await first;
        void wrapped.signTx(...signTxArgs);

        expect(requests(events)).toEqual([
            { label: "Link content", step: 1, attempt: 1 },
            { label: "Link content", step: 2, attempt: 1 },
        ]);
    });
});

describe("createApprovalPrompt", () => {
    it("emits sign-request on open and sign-complete on complete(), sharing the counter", () => {
        const events: SigningEvent[] = [];
        const counter = createSigningCounter();
        const prompt = createApprovalPrompt(counter, (e) => events.push(e));

        // A signing tap reserves step 1 elsewhere…
        counter.next("Link content");
        // …so the allowance tap continues the same sequence at step 2.
        const handle = prompt("Grant Bulletin storage allowance");
        handle.complete();

        expect(events).toEqual([
            {
                kind: "sign-request",
                label: "Grant Bulletin storage allowance",
                step: 2,
                attempt: 1,
            },
            { kind: "sign-complete", label: "Grant Bulletin storage allowance", step: 2 },
        ]);
    });

    it("emits sign-error with the failure message on fail()", () => {
        const events: SigningEvent[] = [];
        const prompt = createApprovalPrompt(createSigningCounter(), (e) => events.push(e));

        const handle = prompt("Grant Bulletin storage allowance");
        handle.fail("declined on phone");

        expect(events).toEqual([
            {
                kind: "sign-request",
                label: "Grant Bulletin storage allowance",
                step: 1,
                attempt: 1,
            },
            {
                kind: "sign-error",
                label: "Grant Bulletin storage allowance",
                step: 1,
                message: "declined on phone",
            },
        ]);
    });
});
