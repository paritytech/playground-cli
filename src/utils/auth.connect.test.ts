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
 * Regression coverage for the `connect()` adapter lifecycle.
 *
 * `connect()` creates a TerminalAdapter to probe for an existing session.
 * On the existing-session path it returns plain address data — the adapter
 * is not part of the result, so `connect()` itself is the only place that
 * can release it. Forgetting the destroy leaks a live statement-store
 * WebSocket + subscriptions for the rest of the process lifetime; that
 * leaked machinery is exactly the kind that can enter the polkadot-api
 * microtask-flood state (see `process-guard.ts`) and grow a zombie process
 * to tens of GB. `getSessionSigner()` and `findSession()` already destroy
 * their probe adapters on early-return paths — this pins `connect()` to the
 * same contract.
 *
 * Lives in its own file (not `auth.test.ts`) because it module-mocks
 * `@parity/product-sdk-terminal`, and the sibling suite exercises the real
 * exports.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { createTerminalAdapterMock, waitForSessionsMock } = vi.hoisted(() => ({
    createTerminalAdapterMock: vi.fn(),
    waitForSessionsMock: vi.fn(),
}));

vi.mock("@parity/product-sdk-terminal", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@parity/product-sdk-terminal")>();
    return {
        ...actual,
        createTerminalAdapter: createTerminalAdapterMock,
        waitForSessions: waitForSessionsMock,
        // RFC-0022: the product account is derived from a subtree key the
        // WALLET owns, which the SDK fetches over the statement store and
        // caches on disk under the default storage dir. Unmocked, these tests
        // would hang waiting for a phone and write a bogus key into the real
        // ~/.polkadot-apps subtree cache — corrupting the developer's live
        // session. Any 32-byte value works here; the address math itself is
        // pinned in sessionSigner.test.ts against host-rust-core's vector.
        deriveProductPublicKey: deriveProductPublicKeyMock,
        createSessionSignerForAccount: createSessionSignerForAccountMock,
    };
});

// waitForLogin records the login stamp with its default storage dir; mock it
// so tests never write to the real ~/.polkadot-apps.
const { deriveProductPublicKeyMock, createSessionSignerForAccountMock } = vi.hoisted(() => ({
    deriveProductPublicKeyMock: vi.fn(async () => new Uint8Array(32).fill(0x5a)),
    createSessionSignerForAccountMock: vi.fn(async () => ({
        publicKey: new Uint8Array(32).fill(0x5a),
        signTx: async () => new Uint8Array(),
        signBytes: async () => new Uint8Array(),
    })),
}));

const { recordLoginStampMock } = vi.hoisted(() => ({
    recordLoginStampMock: vi.fn(async () => undefined),
}));
vi.mock("./loginStamp.js", () => ({
    recordLoginStamp: recordLoginStampMock,
}));

// connect() rotates the device identity before a fresh QR pairing. Mock it so
// the unit tests assert the wiring without touching the real ~/.polkadot-apps;
// the rotation's own behaviour is covered in sessionReset.test.ts.
const { resetDeviceIdentityMock } = vi.hoisted(() => ({
    resetDeviceIdentityMock: vi.fn(async () => undefined),
}));
vi.mock("./sessionReset.js", () => ({
    resetDeviceIdentityForFreshPairing: resetDeviceIdentityMock,
}));

import { connect, getSessionSigner, waitForLogin } from "./auth.js";

// A valid ristretto255 point — same frozen vector as `auth.test.ts`'s
// deriveSessionAddresses block. `connect()` derives display addresses from
// the session root, and arbitrary 32-byte buffers won't decode.
const TEST_ROOT_BYTES = Uint8Array.from([
    0x9a, 0x76, 0x3d, 0x8d, 0x7d, 0xb9, 0x5e, 0xbd, 0xeb, 0x8f, 0xe2, 0x60, 0xb8, 0x90, 0xf3, 0x5a,
    0x25, 0x3d, 0xb8, 0x27, 0x74, 0xf6, 0x34, 0x46, 0x6c, 0xed, 0x38, 0x7a, 0xa1, 0x4e, 0xfd, 0x29,
]);

function fakeAdapter() {
    return {
        destroy: vi.fn().mockResolvedValue(undefined),
        sso: {
            authenticate: vi.fn(() => new Promise(() => {})),
            pairingStatus: {
                subscribe: vi.fn(
                    (_cb: (status: { step: string; payload: string }) => void) => () => {},
                ),
            },
        },
    };
}

describe("connect() adapter lifecycle", () => {
    beforeEach(() => {
        createTerminalAdapterMock.mockReset();
        waitForSessionsMock.mockReset();
        resetDeviceIdentityMock.mockClear();
    });

    it("destroys the probe adapter on the existing-session path", async () => {
        const adapter = fakeAdapter();
        createTerminalAdapterMock.mockReturnValue(adapter);
        waitForSessionsMock.mockResolvedValue([{ rootAccountId: TEST_ROOT_BYTES }]);

        const result = await connect();

        expect(result.kind).toBe("existing");
        // The adapter is not part of the "existing" result, so connect()
        // must release it itself — a leak here keeps the statement-store
        // WebSocket (and the event loop) alive for the whole process.
        expect(adapter.destroy).toHaveBeenCalledTimes(1);
        // A valid existing session must be reused as-is — rotating the device
        // identity here would needlessly invalidate a working pairing.
        expect(resetDeviceIdentityMock).not.toHaveBeenCalled();
    });

    it("destroys the adapter when the session probe throws", async () => {
        const adapter = fakeAdapter();
        createTerminalAdapterMock.mockReturnValue(adapter);
        waitForSessionsMock.mockRejectedValue(new Error("statement store unreachable"));

        await expect(connect()).rejects.toThrow("statement store unreachable");
        expect(adapter.destroy).toHaveBeenCalledTimes(1);
    });

    it("rotates the device identity then pairs on a fresh adapter (QR path)", async () => {
        // No existing session ⇒ fresh QR pairing. connect() must: probe with
        // adapter #1, destroy it, rotate the device identity, then build a
        // fresh adapter #2 that pairs on a clean (un-poisoned) topic and is
        // handed to the caller still alive (authenticate() is in flight).
        const probe = fakeAdapter();
        const fresh = fakeAdapter();
        createTerminalAdapterMock.mockReturnValueOnce(probe).mockReturnValueOnce(fresh);
        waitForSessionsMock.mockResolvedValue([]);
        fresh.sso.pairingStatus.subscribe.mockImplementation(
            (cb: (status: { step: string; payload: string }) => void) => {
                cb({ step: "pairing", payload: "pairing-payload" });
                return () => {};
            },
        );

        const result = await connect();

        expect(result.kind).toBe("qr");
        // The probe adapter is torn down before the identity is deleted...
        expect(probe.destroy).toHaveBeenCalledTimes(1);
        // ...the rotation runs exactly once, between probe and pairing...
        expect(resetDeviceIdentityMock).toHaveBeenCalledTimes(1);
        // ...and pairing happens on the fresh adapter, handed to the caller.
        expect(fresh.sso.authenticate).toHaveBeenCalledTimes(1);
        expect(fresh.destroy).not.toHaveBeenCalled();
        if (result.kind === "qr") {
            expect(result.login.adapter).toBe(fresh);
        }
    });

    it("does not rotate the device identity when the session probe throws", async () => {
        // A transient statement-store outage must not be mistaken for "no
        // session" and trigger a destructive identity rotation.
        const adapter = fakeAdapter();
        createTerminalAdapterMock.mockReturnValue(adapter);
        waitForSessionsMock.mockRejectedValue(new Error("statement store unreachable"));

        await expect(connect()).rejects.toThrow("statement store unreachable");
        expect(resetDeviceIdentityMock).not.toHaveBeenCalled();
    });
});

// A second valid ristretto255 point, distinct from TEST_ROOT_BYTES, so the
// two sessions derive different display addresses. Frozen output of
// `scure.getPublicKey(scure.secretFromSeed(new Uint8Array(32).fill(2)))`.
const OTHER_ROOT_BYTES = Uint8Array.from([
    0x1a, 0x4f, 0xee, 0x48, 0xc1, 0xba, 0x1a, 0x48, 0xe8, 0xcd, 0x43, 0x78, 0x2a, 0x84, 0x85, 0xd6,
    0x35, 0xaa, 0x91, 0xcf, 0xb8, 0x2c, 0xbb, 0x47, 0x7f, 0x0c, 0x1c, 0x57, 0x6b, 0xc4, 0x03, 0x1c,
]);

describe("multi-session selection", () => {
    beforeEach(() => {
        createTerminalAdapterMock.mockReset();
        waitForSessionsMock.mockReset();
        recordLoginStampMock.mockClear();
    });

    it("getSessionSigner uses the NEWEST session, not the oldest", async () => {
        // The session repository APPENDS: after a re-pair the array holds
        // [stale, fresh]. Requests sent on the stale session reach a channel
        // the phone may no longer serve — the silent "nothing shows up on the
        // phone" failure. Selection must always be the most recent pairing.
        const stale = { id: "old", rootAccountId: TEST_ROOT_BYTES };
        const fresh = { id: "new", rootAccountId: OTHER_ROOT_BYTES };
        const adapter = fakeAdapter();
        createTerminalAdapterMock.mockReturnValue(adapter);
        waitForSessionsMock.mockResolvedValue([stale, fresh]);

        const handle = await getSessionSigner();

        expect(handle).not.toBeNull();
        expect(handle!.userSession).toBe(fresh);
        handle!.destroy();
    });

    it("waitForLogin reports the newest session and NEVER disconnects on login", async () => {
        // Regression: a previous version pruned older sessions here by calling
        // `adapter.sessions.disconnect(stale)`. That submits a `Disconnected`
        // statement to the phone, which echoes it back across EVERY tracked
        // session — including the freshly paired one — and the SDK then filters
        // each out of `SsoSessionsV3`, leaving an empty session repository the
        // moment login finished (secret blobs survive). `pg deploy` then read
        // zero sessions and failed with "No signer available". Selection is
        // handled entirely by `newestSession()`, so login must touch no
        // disconnect path at all.
        const stale = { id: "old", rootAccountId: TEST_ROOT_BYTES };
        const fresh = { id: "new", rootAccountId: OTHER_ROOT_BYTES };
        const disconnect = vi.fn(async () => ({ isOk: () => true }));
        const adapter = {
            ...fakeAdapter(),
            sessions: { disconnect },
        };
        waitForSessionsMock.mockResolvedValue([stale, fresh]);

        const statuses: Array<{ step: string; address?: string }> = [];
        const authPromise = Promise.resolve({
            match: (ok: (s: unknown) => void) => ok(fresh),
        });

        const address = await waitForLogin({ adapter, authPromise } as any, (status) =>
            statuses.push(status as { step: string; address?: string }),
        );

        // The reported identity is the JUST-PAIRED session's, never a stale one.
        const success = statuses.find((s) => s.step === "success");
        expect(success?.address).toBe(address);
        expect(address).toBeTruthy();

        // The destructive prune is gone: login disconnects nothing.
        expect(disconnect).not.toHaveBeenCalled();
        expect(recordLoginStampMock).toHaveBeenCalledTimes(1);
    });
});
