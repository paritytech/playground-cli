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

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedSigner } from "../signer.js";

// SDK boundary mocks — these are our wrappers over RFC-0010 + Bulletin, NOT
// polkadot-api primitives, so mocking them is allowed.
const {
    checkAuthorizationMock,
    createSlotAccountSignerMock,
    ensureSlotAccountSignerMock,
    getCachedAllocationMock,
} = vi.hoisted(() => ({
    checkAuthorizationMock: vi.fn(),
    createSlotAccountSignerMock: vi.fn(),
    ensureSlotAccountSignerMock: vi.fn(),
    getCachedAllocationMock: vi.fn(),
}));

vi.mock("@parity/product-sdk-cloud-storage", () => ({
    checkAuthorization: checkAuthorizationMock,
}));

vi.mock("@parity/product-sdk-terminal/host", () => ({
    createSlotAccountSigner: createSlotAccountSignerMock,
    ensureSlotAccountSigner: ensureSlotAccountSignerMock,
    getCachedAllocation: getCachedAllocationMock,
}));

import {
    cachedBulletinSlotAuthorization,
    getBulletinAllowanceSigner,
    getCachedBulletinAllowanceSigner,
    getBulletinSlotAuthorization,
} from "./bulletin.js";

// A 32-byte public key (filled with 1) deterministically encodes to a known
// SS58 — we only assert it is non-empty, since the encoding is the SDK's job.
const PUBLIC_KEY = new Uint8Array(32).fill(1);
const SLOT_SIGNER = { publicKey: PUBLIC_KEY } as any;

const ENV_HINT = /playground login/;

// Usability is decided by the chain's `BulletinTransactionStorageApi::can_store`
// runtime predicate (a 1-byte probe = exists + unexpired), reached through
// `bulletinApi.apis.BulletinTransactionStorageApi.can_store`. `checkAuthorization`
// is mocked separately and only feeds the expired-vs-never-authorized error
// message, so the api stub just needs to carry the can_store verdict.
function bulletinApiCanStore(verdict = true): any {
    return {
        apis: {
            BulletinTransactionStorageApi: { can_store: vi.fn(async () => verdict) },
        },
    };
}

// An authorization that exists and has not expired (the only thing that gates
// a Bulletin `store`). Quota counters are intentionally zeroed to prove they
// no longer matter.
const ACTIVE_EXHAUSTED = {
    authorized: true,
    remainingTransactions: 0,
    remainingBytes: 0n,
    expiration: 100,
};

// An authorization that exists on-chain but is past its expiry — the chain's
// can_store returns false for it, while `authorized` stays true so the error
// path reports "has expired" rather than "not authorized".
const EXPIRED = {
    authorized: true,
    remainingTransactions: 5,
    remainingBytes: 1000n,
    expiration: 10,
};

function sessionSigner(): ResolvedSigner {
    return {
        source: "session",
        address: "5Owner",
        signer: {} as any,
        userSession: {} as any,
        adapter: {} as any,
        destroy() {},
    };
}

function devSigner(): ResolvedSigner {
    return {
        source: "dev",
        address: "5Dev",
        signer: { publicKey: PUBLIC_KEY } as any,
        destroy() {},
    };
}

beforeEach(() => {
    checkAuthorizationMock.mockReset();
    createSlotAccountSignerMock.mockReset();
    ensureSlotAccountSignerMock.mockReset();
    getCachedAllocationMock.mockReset();
    // Default: slot key already in the SDK cache, so ensureSlotAccountSigner
    // resolves silently and no grant prompt fires.
    getCachedAllocationMock.mockResolvedValue({ tag: "BulletInAllowance" });
});

describe("getBulletinAllowanceSigner", () => {
    it("passes through the local signer for dev/SURI deploys without any SDK calls", async () => {
        const dev = devSigner();
        const signer = await getBulletinAllowanceSigner({ publishSigner: dev });
        expect(signer).toBe(dev.signer);
        expect(ensureSlotAccountSignerMock).not.toHaveBeenCalled();
    });

    it("throws the login hint when there is no session/adapter", async () => {
        await expect(
            getBulletinAllowanceSigner({
                publishSigner: {
                    source: "session",
                    address: "5Owner",
                    signer: {} as any,
                    destroy() {},
                },
            }),
        ).rejects.toThrow(ENV_HINT);
    });

    it("returns the slot signer when can_store accepts (exists + not expired)", async () => {
        ensureSlotAccountSignerMock.mockResolvedValue(SLOT_SIGNER);
        checkAuthorizationMock.mockResolvedValue(ACTIVE_EXHAUSTED);

        const signer = await getBulletinAllowanceSigner({
            publishSigner: sessionSigner(),
            bulletinApi: bulletinApiCanStore(true),
        });

        expect(signer).toBe(SLOT_SIGNER);
    });

    it("returns the slot signer even when the tx/byte quota counters are exhausted (soft limits)", async () => {
        // The whole point of dropping the quota gate: an authorized, unexpired
        // slot with zeroed counters still stores fine (can_store=true), so no
        // Increase, no throw.
        ensureSlotAccountSignerMock.mockResolvedValue(SLOT_SIGNER);
        checkAuthorizationMock.mockResolvedValue(ACTIVE_EXHAUSTED);

        const signer = await getBulletinAllowanceSigner({
            publishSigner: sessionSigner(),
            bulletinApi: bulletinApiCanStore(true),
        });

        expect(signer).toBe(SLOT_SIGNER);
        // Authorization is read exactly once — no re-check after an Increase.
        expect(checkAuthorizationMock).toHaveBeenCalledTimes(1);
    });

    it("returns the slot signer without checking authorization when no bulletinApi is supplied", async () => {
        ensureSlotAccountSignerMock.mockResolvedValue(SLOT_SIGNER);

        const signer = await getBulletinAllowanceSigner({ publishSigner: sessionSigner() });

        expect(signer).toBe(SLOT_SIGNER);
        expect(checkAuthorizationMock).not.toHaveBeenCalled();
    });

    it("throws the expired error when can_store rejects an authorized slot", async () => {
        ensureSlotAccountSignerMock.mockResolvedValue(SLOT_SIGNER);
        checkAuthorizationMock.mockResolvedValue(EXPIRED);

        await expect(
            getBulletinAllowanceSigner({
                publishSigner: sessionSigner(),
                bulletinApi: bulletinApiCanStore(false), // chain rejects: expired
            }),
        ).rejects.toThrow(/has expired/);
    });

    it("throws the not-authorized error when the slot is not authorized on-chain", async () => {
        ensureSlotAccountSignerMock.mockResolvedValue(SLOT_SIGNER);
        checkAuthorizationMock.mockResolvedValue({
            authorized: false,
            remainingTransactions: 0,
            remainingBytes: 0n,
            expiration: 0,
        });

        await expect(
            getBulletinAllowanceSigner({
                publishSigner: sessionSigner(),
                bulletinApi: bulletinApiCanStore(false),
            }),
        ).rejects.toThrow(/not authorized on-chain yet/);
    });

    it("degrades to the slot signer when the authorization status cannot be READ (transient error)", async () => {
        // The up-front check is an optimization, not a gate: a transient
        // failure reading on-chain status must NOT abort the deploy with a
        // misleading "re-run login" message — the auth may be perfectly valid.
        ensureSlotAccountSignerMock.mockResolvedValue(SLOT_SIGNER);
        checkAuthorizationMock.mockRejectedValue(new Error("WS halt (3)"));

        const signer = await getBulletinAllowanceSigner({
            publishSigner: sessionSigner(),
            bulletinApi: bulletinApiCanStore(true),
        });

        expect(signer).toBe(SLOT_SIGNER);
    });
});

describe("getBulletinAllowanceSigner — phone approval prompts", () => {
    // Allocation requests travel over the statement store outside any
    // PolkadotSigner, so the deploy TUI's signing proxy can't see them. The
    // onPrompt hook is the only "check your phone" surface for the first-use
    // slot grant — these tests pin when it fires and when it stays silent.
    // (There is no longer an Increase prompt: quota is a soft limit.)
    function recordingPrompt() {
        const calls: Array<{ label: string; closed: "complete" | "fail" | null }> = [];
        const prompt = (label: string) => {
            const entry = { label, closed: null as "complete" | "fail" | null };
            calls.push(entry);
            return {
                complete: () => {
                    entry.closed = "complete";
                },
                fail: () => {
                    entry.closed = "fail";
                },
            };
        };
        return { calls, prompt };
    }

    it("stays silent when the slot key is cached and the authorization is active", async () => {
        ensureSlotAccountSignerMock.mockResolvedValue(SLOT_SIGNER);
        checkAuthorizationMock.mockResolvedValue(ACTIVE_EXHAUSTED);
        const { calls, prompt } = recordingPrompt();

        await getBulletinAllowanceSigner({
            publishSigner: sessionSigner(),
            bulletinApi: bulletinApiCanStore(true),
            onPrompt: prompt,
        });

        expect(calls).toEqual([]);
    });

    it("prompts for the grant on a slot-key cache miss and completes it", async () => {
        getCachedAllocationMock.mockResolvedValue(null);
        ensureSlotAccountSignerMock.mockResolvedValue(SLOT_SIGNER);
        const { calls, prompt } = recordingPrompt();

        await getBulletinAllowanceSigner({ publishSigner: sessionSigner(), onPrompt: prompt });

        expect(calls).toEqual([{ label: "Grant Bulletin storage allowance", closed: "complete" }]);
    });

    it("fails the grant prompt when the allocation request throws", async () => {
        getCachedAllocationMock.mockResolvedValue(null);
        ensureSlotAccountSignerMock.mockRejectedValue(new Error("Rejected on phone"));
        const { calls, prompt } = recordingPrompt();

        await expect(
            getBulletinAllowanceSigner({ publishSigner: sessionSigner(), onPrompt: prompt }),
        ).rejects.toThrow("Rejected on phone");

        expect(calls).toEqual([{ label: "Grant Bulletin storage allowance", closed: "fail" }]);
    });
});

describe("getBulletinAllowanceSigner — SDK signer passthrough", () => {
    // terminal 0.3.1+ owns the schnorrkel-normalized derivation for 64-byte
    // phone-issued keys (the playground-cli slotSigner.ts workaround was
    // deleted once the fix shipped upstream). The SDK-built signer must be
    // used as-is, and the authorization check must run against ITS address.
    it("uses the SDK-built slot signer and checks authorization on its address", async () => {
        ensureSlotAccountSignerMock.mockResolvedValue(SLOT_SIGNER);
        checkAuthorizationMock.mockResolvedValue(ACTIVE_EXHAUSTED);

        const signer = await getBulletinAllowanceSigner({
            publishSigner: sessionSigner(),
            bulletinApi: bulletinApiCanStore(true),
        });

        expect(signer).toBe(SLOT_SIGNER);
        expect(ensureSlotAccountSignerMock).toHaveBeenCalledTimes(1);
        const checkedAddress = checkAuthorizationMock.mock.calls[0][1] as string;
        const { ss58Encode } = await import("@parity/product-sdk-address");
        expect(checkedAddress).toBe(ss58Encode(PUBLIC_KEY));
    });
});

describe("getCachedBulletinAllowanceSigner", () => {
    it("passes through the local signer for dev/SURI deploys without any SDK calls", async () => {
        const dev = devSigner();

        const signer = await getCachedBulletinAllowanceSigner({ publishSigner: dev });

        expect(signer).toBe(dev.signer);
        expect(createSlotAccountSignerMock).not.toHaveBeenCalled();
        expect(ensureSlotAccountSignerMock).not.toHaveBeenCalled();
    });

    it("fails with the login hint on a cache miss without requesting allocation", async () => {
        createSlotAccountSignerMock.mockResolvedValue(null);

        await expect(
            getCachedBulletinAllowanceSigner({ publishSigner: sessionSigner() }),
        ).rejects.toThrow(ENV_HINT);

        expect(ensureSlotAccountSignerMock).not.toHaveBeenCalled();
    });

    it("returns the cached slot signer when the authorization is active", async () => {
        createSlotAccountSignerMock.mockResolvedValue(SLOT_SIGNER);
        checkAuthorizationMock.mockResolvedValue(ACTIVE_EXHAUSTED);

        const signer = await getCachedBulletinAllowanceSigner({
            publishSigner: sessionSigner(),
            bulletinApi: bulletinApiCanStore(true),
        });

        expect(signer).toBe(SLOT_SIGNER);
        expect(ensureSlotAccountSignerMock).not.toHaveBeenCalled();
    });

    it("throws the expired error without requesting an allocation", async () => {
        createSlotAccountSignerMock.mockResolvedValue(SLOT_SIGNER);
        checkAuthorizationMock.mockResolvedValue(EXPIRED);

        await expect(
            getCachedBulletinAllowanceSigner({
                publishSigner: sessionSigner(),
                bulletinApi: bulletinApiCanStore(false),
            }),
        ).rejects.toThrow(/has expired/);

        expect(ensureSlotAccountSignerMock).not.toHaveBeenCalled();
    });
});

describe("cachedBulletinSlotAuthorization", () => {
    it("returns null on a cache miss without touching the wire", async () => {
        createSlotAccountSignerMock.mockResolvedValue(null);

        const result = await cachedBulletinSlotAuthorization({} as any, bulletinApiCanStore());

        expect(result).toBeNull();
        expect(checkAuthorizationMock).not.toHaveBeenCalled();
    });

    it("flags an active (exists + unexpired) authorization as usable", async () => {
        createSlotAccountSignerMock.mockResolvedValue(SLOT_SIGNER);
        checkAuthorizationMock.mockResolvedValue(ACTIVE_EXHAUSTED);

        const result = await cachedBulletinSlotAuthorization({} as any, bulletinApiCanStore(true));

        expect(result?.usable).toBe(true);
    });

    it("flags an expired authorization as not usable", async () => {
        createSlotAccountSignerMock.mockResolvedValue(SLOT_SIGNER);
        checkAuthorizationMock.mockResolvedValue(EXPIRED);

        const result = await cachedBulletinSlotAuthorization({} as any, bulletinApiCanStore(false));

        expect(result?.usable).toBe(false);
    });
});

describe("getBulletinSlotAuthorization", () => {
    it("encodes the signer public key and flags an active authorization as usable", async () => {
        checkAuthorizationMock.mockResolvedValue(ACTIVE_EXHAUSTED);
        const api = bulletinApiCanStore(true);

        const result = await getBulletinSlotAuthorization(api, SLOT_SIGNER);

        expect(result.usable).toBe(true);
        expect(result.address).toMatch(/^5/);
        expect(checkAuthorizationMock).toHaveBeenCalledWith(api, result.address);
    });

    it("flags an unexpired-but-not-authorized account as not usable", async () => {
        checkAuthorizationMock.mockResolvedValue({
            authorized: false,
            remainingTransactions: 0,
            remainingBytes: 0n,
            expiration: 0,
        });

        const result = await getBulletinSlotAuthorization(bulletinApiCanStore(false), SLOT_SIGNER);

        expect(result.usable).toBe(false);
    });
});
