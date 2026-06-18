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

import { describe, expect, it } from "vitest";
import {
    isBenignUnsubscriptionError,
    resolveMemoryWatchdogLimitBytes,
    setProcessGuardWarningHandler,
} from "./process-guard.js";

// Construct an object shaped like rxjs's `UnsubscriptionError` — rxjs builds
// it via `createErrorClass`, so in practice all we rely on is (a) `name ===
// "UnsubscriptionError"` and (b) an `errors` array. Mirror that here rather
// than import rxjs (the CLI doesn't depend on it directly; polkadot-app-deploy
// does, transitively).
function makeUnsubscriptionError(innerMessages: string[]): Error {
    const err = new Error(
        `${innerMessages.length} errors occurred during unsubscription:\n${innerMessages
            .map((m, i) => `${i + 1}) Error: ${m}`)
            .join("\n  ")}`,
    );
    err.name = "UnsubscriptionError";
    (err as Error & { errors: unknown[] }).errors = innerMessages.map((m) => new Error(m));
    return err;
}

describe("isBenignUnsubscriptionError", () => {
    it("matches a single-error Not connected UnsubscriptionError (the dotns.disconnect() case)", () => {
        expect(isBenignUnsubscriptionError(makeUnsubscriptionError(["Not connected"]))).toBe(true);
    });

    it("matches multi-error payloads where every inner error is Not connected", () => {
        expect(
            isBenignUnsubscriptionError(
                makeUnsubscriptionError(["Not connected", "Not connected"]),
            ),
        ).toBe(true);
    });

    it("is case-insensitive on the inner message", () => {
        expect(isBenignUnsubscriptionError(makeUnsubscriptionError(["NOT CONNECTED"]))).toBe(true);
    });

    it("rejects UnsubscriptionError with at least one non-Not-connected inner error", () => {
        // A real RPC error mixed in means something genuinely went wrong mid
        // teardown — don't swallow it.
        expect(
            isBenignUnsubscriptionError(makeUnsubscriptionError(["Not connected", "ECONNREFUSED"])),
        ).toBe(false);
    });

    it("rejects UnsubscriptionError with an empty errors array", () => {
        // Empty array has no signal of what went wrong — don't assume benign.
        const err = new Error("empty");
        err.name = "UnsubscriptionError";
        (err as Error & { errors: unknown[] }).errors = [];
        expect(isBenignUnsubscriptionError(err)).toBe(false);
    });

    it("matches a bare Error with exactly Not connected (host-papp 0.8 teardown shape)", () => {
        // The 0.8 statement-store stack surfaces the raw-client teardown
        // throw as a floating bare rejection instead of wrapping it in an
        // rxjs UnsubscriptionError. Same benign family, new shape — without
        // this match a successful `pg login` exits 1. (Pre-0.8 this test
        // pinned the opposite: the bare form never occurred at teardown.)
        const err = new Error("Not connected");
        expect(isBenignUnsubscriptionError(err)).toBe(true);
    });

    it("rejects bare Errors whose message merely CONTAINS Not connected", () => {
        // Contextual messages indicate a real failure from an active request
        // path — only the exact raw-client teardown throw is benign.
        expect(isBenignUnsubscriptionError(new Error("RPC failed: Not connected to peer"))).toBe(
            false,
        );
        expect(isBenignUnsubscriptionError(new Error("Not connected: retry later"))).toBe(false);
    });

    it("rejects non-Error inputs", () => {
        expect(isBenignUnsubscriptionError(null)).toBe(false);
        expect(isBenignUnsubscriptionError(undefined)).toBe(false);
        expect(isBenignUnsubscriptionError("Not connected")).toBe(false);
        expect(isBenignUnsubscriptionError({ name: "UnsubscriptionError" })).toBe(false);
    });

    it("suppresses DestroyedError('Client destroyed') — fire-and-forget destroy races pending unsubs", () => {
        // The 0.2.0 product-sdk-terminal fix made adapter.destroy() awaitable
        // and drains pending statement-subscription unsubscribes — but only
        // when callers await. Our `SessionHandle.destroy()` returns void (so
        // useEffect cleanup and other sync sites can call it), and we
        // `void adapter.destroy()` inside — fire-and-forget. The drain
        // therefore still races and surfaces this exact rejection shape on
        // some `dot login` / `dot logout` paths. Underlying work has already
        // succeeded; suppress.
        const err = new Error("Client destroyed");
        err.name = "DestroyedError";
        expect(isBenignUnsubscriptionError(err)).toBe(true);
    });

    it("does NOT suppress DestroyedError with an unrelated message", () => {
        // Defensive: only the "Client destroyed" shape is benign. A future
        // DestroyedError with a different message should still escalate.
        const err = new Error("Something else");
        err.name = "DestroyedError";
        expect(isBenignUnsubscriptionError(err)).toBe(false);
    });

    it("accepts string entries inside the errors array (rxjs permits them)", () => {
        const err = new Error("x");
        err.name = "UnsubscriptionError";
        (err as Error & { errors: unknown[] }).errors = ["Not connected"];
        expect(isBenignUnsubscriptionError(err)).toBe(true);
    });
});

describe("process guard warning handler", () => {
    it("swallows warning handler failures", () => {
        setProcessGuardWarningHandler(() => {
            throw new Error("telemetry failed");
        });
        expect(() => setProcessGuardWarningHandler(undefined)).not.toThrow();
    });
});

describe("resolveMemoryWatchdogLimitBytes", () => {
    const gib = 1024 * 1024 * 1024;

    it("defaults to 8 GiB", () => {
        expect(resolveMemoryWatchdogLimitBytes(undefined)).toBe(8 * gib);
        expect(resolveMemoryWatchdogLimitBytes("   ")).toBe(8 * gib);
    });

    it("accepts positive GiB values", () => {
        expect(resolveMemoryWatchdogLimitBytes("12")).toBe(12 * gib);
        expect(resolveMemoryWatchdogLimitBytes("0.5")).toBe(0.5 * gib);
    });

    it("disables the kill threshold with explicit off values", () => {
        expect(resolveMemoryWatchdogLimitBytes("0")).toBeNull();
        expect(resolveMemoryWatchdogLimitBytes("false")).toBeNull();
        expect(resolveMemoryWatchdogLimitBytes("OFF")).toBeNull();
        expect(resolveMemoryWatchdogLimitBytes("disabled")).toBeNull();
    });

    it("falls back to the default for invalid values", () => {
        expect(resolveMemoryWatchdogLimitBytes("-1")).toBe(8 * gib);
        expect(resolveMemoryWatchdogLimitBytes("not-a-number")).toBe(8 * gib);
    });
});
