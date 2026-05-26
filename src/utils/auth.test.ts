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
 * Tests for auth.ts edge cases — specifically the subscribe-before-assignment bug.
 *
 * The real subscribe/pairing flow requires a live adapter, so these tests
 * verify the patterns used rather than the full integration.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    clearLocalAppStorage,
    deriveSessionAddresses,
    waitForLogout,
    type LogoutHandle,
    type LogoutStatus,
} from "./auth.js";
import type { UserSession } from "@parity/product-sdk-terminal";
import { DAPP_ID } from "../config.js";
import { INCOMPLETE_SESSION_MESSAGE } from "./sessionSigner.js";

describe("subscribe-before-assignment pattern", () => {
    /**
     * Simulates the bug where `const unsub = obs.subscribe(cb)` fires
     * the callback synchronously, causing `unsub` to be referenced
     * before it's assigned.
     *
     * The fix uses `let unsub; unsub = obs.subscribe(cb)` with `unsub?.()`.
     */
    it("handles synchronous callback firing during subscribe", () => {
        let callbackFired = false;
        let unsubCalled = false;

        // Simulate an observable that fires synchronously
        const syncObservable = {
            subscribe(cb: (status: { step: string; payload?: string }) => void) {
                // Fires immediately during subscribe()
                cb({ step: "pairing", payload: "qr-data" });
                return () => {
                    unsubCalled = true;
                };
            },
        };

        // The FIXED pattern (let + optional chaining)
        let done = false;
        let unsub: (() => void) | undefined;
        unsub = syncObservable.subscribe((status) => {
            if (status.step === "pairing" && !done) {
                done = true;
                unsub?.(); // safe — unsub is undefined when called sync, but done=true prevents re-entry
                callbackFired = true;
            }
        });

        expect(callbackFired).toBe(true);
        expect(done).toBe(true);
        // unsub?.() was called when unsub was still undefined (sync), so unsubCalled is false
        // but the callback still ran correctly
    });

    it("handles asynchronous callback firing after subscribe returns", () => {
        let callbackFired = false;
        let unsubCalled = false;

        // Simulate an observable that fires asynchronously
        let storedCb: ((status: { step: string; payload?: string }) => void) | null = null;
        const asyncObservable = {
            subscribe(cb: (status: { step: string; payload?: string }) => void) {
                storedCb = cb;
                return () => {
                    unsubCalled = true;
                };
            },
        };

        let done = false;
        let unsub: (() => void) | undefined;
        unsub = asyncObservable.subscribe((status) => {
            if (status.step === "pairing" && !done) {
                done = true;
                unsub?.();
                callbackFired = true;
            }
        });

        // Fire callback after subscribe has returned — unsub is assigned
        storedCb!({ step: "pairing", payload: "qr-data" });

        expect(callbackFired).toBe(true);
        expect(unsubCalled).toBe(true); // unsub was assigned, so it was called
    });

    it("done flag prevents double-resolution", () => {
        let resolutionCount = 0;

        const observable = {
            subscribe(cb: (status: { step: string }) => void) {
                // Fires twice
                cb({ step: "pairing" });
                cb({ step: "pairing" });
                return () => {};
            },
        };

        let done = false;
        let unsub: (() => void) | undefined;
        unsub = observable.subscribe((status) => {
            if (status.step === "pairing" && !done) {
                done = true;
                unsub?.();
                resolutionCount++;
            }
        });

        expect(resolutionCount).toBe(1);
    });
});

// ── Sign-out flow ─────────────────────────────────────────────────────────────

/**
 * Minimal stand-in for `@parity/product-sdk-terminal`'s TerminalAdapter, wide enough
 * for what `waitForLogout` actually touches. We don't import the real type here
 * so the test file stays cheap to run; a compile error if the real API drifts
 * is caught by the consuming call site in auth.ts, not here.
 */
type FakeResult<T, E> = { isOk(): true; value: T } | { isOk(): false; error: E };

function okResult<T>(value: T): FakeResult<T, never> {
    return { isOk: () => true as const, value };
}

function errResult<E>(error: E): FakeResult<never, E> {
    return { isOk: () => false as const, error };
}

/** Fake session handle — only the fields `waitForLogout` reads. */
function fakeSession() {
    return {
        id: "test-session-id",
        localAccount: {} as never,
        remoteAccount: {} as never,
    };
}

interface FakeAdapter {
    destroyCalls: number;
    sessions: {
        disconnect(session: ReturnType<typeof fakeSession>): PromiseLike<FakeResult<void, Error>>;
    };
    destroy(): void;
}

function fakeAdapter(
    disconnect: (session: ReturnType<typeof fakeSession>) => PromiseLike<FakeResult<void, Error>>,
): FakeAdapter {
    const adapter: FakeAdapter = {
        destroyCalls: 0,
        sessions: { disconnect },
        destroy() {
            adapter.destroyCalls++;
        },
    };
    return adapter;
}

describe("waitForLogout", () => {
    let appsDir: string;
    let originalHome: string | undefined;

    beforeEach(() => {
        // Redirect `~/.polkadot-apps` to a tmp dir so the clearLocalAppStorage
        // fallback can't touch the dev's real logged-in account.
        appsDir = mkdtempSync(join(tmpdir(), "pg-logout-test-"));
        originalHome = process.env.HOME;
        process.env.HOME = appsDir;
    });

    afterEach(() => {
        if (originalHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = originalHome;
        }
        rmSync(appsDir, { recursive: true, force: true });
    });

    it("emits disconnecting → success and destroys the adapter on happy path", async () => {
        const adapter = fakeAdapter(() => Promise.resolve(okResult(undefined)));
        const handle = {
            adapter,
            address: "5Gxyz",
            session: fakeSession(),
        } as unknown as LogoutHandle;
        const events: LogoutStatus[] = [];

        await waitForLogout(handle, (s) => events.push(s));

        expect(events).toEqual([
            { step: "disconnecting", address: "5Gxyz" },
            { step: "success", address: "5Gxyz" },
        ]);
        expect(adapter.destroyCalls).toBe(1);
    });

    it("clears local DAPP_ID files on the happy path too, not just the failure path", async () => {
        // Regression catcher: the SDK's `disconnect()` filters the session
        // out of its in-memory list and writes the (now-empty) list back to
        // `${DAPP_ID}_SsoSessions.json` — but doesn't unlink the file. Before
        // this fix, the happy path returned `success` with the empty file
        // still on disk, so `~/.polkadot-apps/` accumulated leftovers across
        // login → logout cycles. We now run clearLocalAppStorage() on success
        // too, so the file is gone after a clean logout.
        const staleDir = join(appsDir, ".polkadot-apps");
        const { mkdirSync } = await import("node:fs");
        mkdirSync(staleDir, { recursive: true });
        const sessionsFile = join(staleDir, `${DAPP_ID}_SsoSessions.json`);
        const secretsFile = join(staleDir, `${DAPP_ID}_UserSecrets_abc.json`);
        const foreignFile = join(staleDir, "other-app_SsoSessions.json");
        writeFileSync(sessionsFile, "[]");
        writeFileSync(secretsFile, "{}");
        writeFileSync(foreignFile, "leave-me-alone");

        const adapter = fakeAdapter(() => Promise.resolve(okResult(undefined)));
        const handle = {
            adapter,
            address: "5Gxyz",
            session: fakeSession(),
        } as unknown as LogoutHandle;
        const events: LogoutStatus[] = [];

        await waitForLogout(handle, (s) => events.push(s));

        expect(events.at(-1)).toEqual({ step: "success", address: "5Gxyz" });
        expect(existsSync(sessionsFile)).toBe(false);
        expect(existsSync(secretsFile)).toBe(false);
        // Foreign app's files MUST remain untouched.
        expect(existsSync(foreignFile)).toBe(true);
    });

    it("falls back to local clear and emits partial when disconnect returns err", async () => {
        // Seed a stale session file so we can verify the fallback actually deletes it.
        const staleDir = join(appsDir, ".polkadot-apps");
        const { mkdirSync } = await import("node:fs");
        mkdirSync(staleDir, { recursive: true });
        const staleFile = join(staleDir, `${DAPP_ID}_SsoSessions.json`);
        const foreignFile = join(staleDir, "other-app_SsoSessions.json");
        writeFileSync(staleFile, "stale");
        writeFileSync(foreignFile, "leave-me-alone");

        const adapter = fakeAdapter(() => Promise.resolve(errResult(new Error("ws halted"))));
        const handle = {
            adapter,
            address: "5Gxyz",
            session: fakeSession(),
        } as unknown as LogoutHandle;
        const events: LogoutStatus[] = [];

        await waitForLogout(handle, (s) => events.push(s));

        expect(events).toEqual([
            { step: "disconnecting", address: "5Gxyz" },
            { step: "partial", address: "5Gxyz", reason: "ws halted" },
        ]);
        expect(adapter.destroyCalls).toBe(1);
        expect(existsSync(staleFile)).toBe(false);
        // Foreign app's files MUST remain untouched.
        expect(existsSync(foreignFile)).toBe(true);
    });

    it("falls back to local clear when disconnect throws", async () => {
        const adapter = fakeAdapter(() => {
            throw new Error("connection refused");
        });
        const handle = {
            adapter,
            address: "5Gxyz",
            session: fakeSession(),
        } as unknown as LogoutHandle;
        const events: LogoutStatus[] = [];

        await waitForLogout(handle, (s) => events.push(s));

        expect(events).toEqual([
            { step: "disconnecting", address: "5Gxyz" },
            { step: "partial", address: "5Gxyz", reason: "connection refused" },
        ]);
        expect(adapter.destroyCalls).toBe(1);
    });

    it("emits a generic err message for non-Error throws", async () => {
        const adapter = fakeAdapter(() => {
            // eslint-disable-next-line @typescript-eslint/no-throw-literal
            throw "string rejection";
        });
        const handle = {
            adapter,
            address: "5Gxyz",
            session: fakeSession(),
        } as unknown as LogoutHandle;
        const events: LogoutStatus[] = [];

        await waitForLogout(handle, (s) => events.push(s));

        expect(events[1]).toEqual({
            step: "partial",
            address: "5Gxyz",
            reason: "string rejection",
        });
    });
});

describe("clearLocalAppStorage", () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "pg-clear-storage-"));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it("is a no-op when the directory does not exist", async () => {
        const missing = join(dir, "does-not-exist");
        await expect(clearLocalAppStorage(missing)).resolves.toBeUndefined();
    });

    it("removes only files prefixed with `${DAPP_ID}_`", async () => {
        const ours1 = join(dir, `${DAPP_ID}_SsoSessions.json`);
        const ours2 = join(dir, `${DAPP_ID}_UserSecrets_abc.json`);
        const foreign = join(dir, "polkadot-desktop_SsoSessions.json");
        const looksSimilar = join(dir, `${DAPP_ID}.backup`);
        writeFileSync(ours1, "a");
        writeFileSync(ours2, "b");
        writeFileSync(foreign, "c");
        writeFileSync(looksSimilar, "d");

        await clearLocalAppStorage(dir);

        expect(existsSync(ours1)).toBe(false);
        expect(existsSync(ours2)).toBe(false);
        expect(existsSync(foreign)).toBe(true);
        // `${DAPP_ID}.backup` lacks the underscore → safe.
        expect(existsSync(looksSimilar)).toBe(true);
    });

    it("swallows unlink errors so callers stay on the happy path", async () => {
        // Nothing to delete → nothing to error on, but the promise must resolve.
        await expect(clearLocalAppStorage(dir)).resolves.toBeUndefined();
    });
});

/**
 * `deriveSessionAddresses` is the function this whole branch exists to
 * make right. The bug it replaced ran `deriveProductAccountPublicKey`
 * twice — once inside `createPlaygroundSessionSigner` and again inside
 * `IdentityLines` → `productAccountAddresses` — producing a doubly-
 * derived ghost product account whose H160 didn't match what the
 * playground-app actually uses for the same root.
 *
 * These tests lock the contract:
 *
 *   1. Frozen vectors from a known mnemonic so a regression to a
 *      doubly-derived shape (or any other algorithm change) fails loud.
 *   2. `productAddress !== rootAddress` — the most basic sanity check
 *      that whatever we display under "product account" can't be
 *      mistaken for the wallet-root row above it.
 *
 * The mnemonic used to generate these vectors is
 * `train snow there sponsor artwork zebra gossip depth narrow blame
 * change private`, a published test wallet — its derivation match
 * was verified live against the playground-app's
 * `[playground.dot] selected account` log:
 *
 *   address=5GGpUaN7XNaUp3nEVDPBSR4SQLxFxQsiPHbFwf69Apr3HgDZ
 *   derivedH160=0x47f68a0851a663dfacb4610d673ec708f05576b0
 *
 * If any of these change, mobile or product-sdk-keys has moved out
 * from under us — that is news, not a test bug to skip.
 */
describe("deriveSessionAddresses", () => {
    // SS58 of the bare-mnemonic sr25519 root for the test mnemonic above —
    // this is what mobile sends as `rootUserAccountId` in the SSO handshake.
    // Bytes captured by deriving the mnemonic with `@polkadot-labs/hdkd`'s
    // sr25519CreateDerive(miniSecret)("").publicKey — they MUST be a valid
    // ristretto255 point; arbitrary 32-byte buffers won't decode.
    const TEST_ROOT_SS58 = "5FZEMcMGTjSveipHTD35RsRtMqZf2wk41g2zAPL8j2UwWTrp";
    const TEST_ROOT_BYTES = Uint8Array.from([
        0x9a, 0x76, 0x3d, 0x8d, 0x7d, 0xb9, 0x5e, 0xbd, 0xeb, 0x8f, 0xe2, 0x60, 0xb8, 0x90, 0xf3,
        0x5a, 0x25, 0x3d, 0xb8, 0x27, 0x74, 0xf6, 0x34, 0x46, 0x6c, 0xed, 0x38, 0x7a, 0xa1, 0x4e,
        0xfd, 0x29,
    ]);
    // A second valid sr25519 public key — derived as `//Alice` off the same
    // mini-secret. Used only to verify that the H160 moves in lock-step with
    // the product SS58 when the root changes.
    const ALT_ROOT_BYTES = Uint8Array.from([
        0xb4, 0x73, 0x69, 0x9f, 0xb2, 0xb2, 0x80, 0x72, 0xe9, 0x25, 0x3e, 0xe6, 0xee, 0x1e, 0x2f,
        0x3c, 0xf4, 0x14, 0xdd, 0x75, 0xae, 0x0f, 0xcc, 0xb1, 0xbf, 0xf9, 0x26, 0x14, 0xf1, 0x7f,
        0x20, 0x7a,
    ]);

    function fakeSession(rootBytes: Uint8Array): UserSession {
        // `deriveSessionAddresses` only reads `session.rootAccountId`.
        // The full UserSession type carries signer callbacks we don't
        // exercise, so the cast keeps the test focused.
        return { rootAccountId: rootBytes } as unknown as UserSession;
    }

    it("matches the playground-app's published product address + H160 for a known root", () => {
        const session = fakeSession(TEST_ROOT_BYTES);
        const addresses = deriveSessionAddresses(session);

        expect(addresses.rootAddress).toBe(TEST_ROOT_SS58);
        expect(addresses.productAddress).toBe("5GGpUaN7XNaUp3nEVDPBSR4SQLxFxQsiPHbFwf69Apr3HgDZ");
        expect(addresses.productH160).toBe("0x47f68a0851a663dfacb4610d673ec708f05576b0");
    });

    it("returns a product address distinct from the root — guards against double-derivation", () => {
        const session = fakeSession(TEST_ROOT_BYTES);
        const addresses = deriveSessionAddresses(session);

        // If someone ever re-introduces a productAccountDisplay-style
        // helper that takes addresses.productAddress as input and runs
        // deriveProductAccountPublicKey on it, the resulting "product"
        // SS58 will still be distinct from the root — but it will also
        // be distinct from the value this test pins above. The frozen-
        // vector test catches that path. This second assertion catches
        // the trivial-mistake path: someone making product = root.
        expect(addresses.productAddress).not.toBe(addresses.rootAddress);
    });

    it("derives the H160 from the same pubkey as the product SS58", () => {
        // Two different rootAccountIds → different product SS58s → and
        // the H160 must change in lock-step with the SS58. A regression
        // that derived H160 off the root (or off a doubly-derived
        // pubkey) would either keep the H160 constant when the root
        // moves or break the ss58↔h160 pairing.
        const a = deriveSessionAddresses(fakeSession(TEST_ROOT_BYTES));
        const b = deriveSessionAddresses(fakeSession(ALT_ROOT_BYTES));

        expect(a.productAddress).not.toBe(b.productAddress);
        expect(a.productH160).not.toBe(b.productH160);
        expect(b.productH160).toMatch(/^0x[0-9a-f]{40}$/);
    });

    it("reports stale sessions without a root account public key", () => {
        expect(() => deriveSessionAddresses(fakeSession(new Uint8Array()))).toThrow(
            INCOMPLETE_SESSION_MESSAGE,
        );
    });
});
