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

// Boundary mocks: the gate composes session lookup (auth.ts) + a read-only
// identity-spine dry-run (registry.ts). We never want a real adapter / network
// here.
const { findSessionMock, deriveSessionAddressesMock, getReadOnlyIdentityContractMock } = vi.hoisted(
    () => ({
        findSessionMock: vi.fn(),
        deriveSessionAddressesMock: vi.fn(),
        getReadOnlyIdentityContractMock: vi.fn(),
    }),
);

vi.mock("../auth.js", () => ({
    findSession: findSessionMock,
    deriveSessionAddresses: deriveSessionAddressesMock,
}));

vi.mock("../registry.js", () => ({
    getReadOnlyIdentityContract: getReadOnlyIdentityContractMock,
}));

import { checkIdentityGate } from "./identityGate.js";

const H160 = "0xbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef" as `0x${string}`;

function fakeHandle() {
    const destroy = vi.fn().mockResolvedValue(undefined);
    return { adapter: { destroy }, address: "5x", session: { rootAccountId: new Uint8Array(32) } };
}

function fakeSpine(query: (addr: `0x${string}`) => Promise<{ success: boolean; value?: unknown }>) {
    return { isVerified: { query: vi.fn(query) } };
}

const FAST = { attempts: 2, delayMs: 0 };

beforeEach(() => {
    vi.clearAllMocks();
    deriveSessionAddressesMock.mockReturnValue({
        rootAddress: "5Root",
        productAddress: "5Prod",
        productH160: H160,
    });
});

describe("checkIdentityGate", () => {
    it("returns not-logged-in and never reads the spine when no session exists", async () => {
        findSessionMock.mockResolvedValue(null);

        const result = await checkIdentityGate({} as any, FAST);

        expect(result).toEqual({ status: "not-logged-in" });
        expect(getReadOnlyIdentityContractMock).not.toHaveBeenCalled();
    });

    it("returns revealed when isVerified is true and releases the session adapter", async () => {
        const handle = fakeHandle();
        findSessionMock.mockResolvedValue(handle);
        getReadOnlyIdentityContractMock.mockResolvedValue(
            fakeSpine(async () => ({ success: true, value: true })),
        );

        const result = await checkIdentityGate({} as any, FAST);

        expect(result).toEqual({ status: "revealed", productH160: H160 });
        expect(handle.adapter.destroy).toHaveBeenCalledTimes(1);
    });

    it("returns anonymous when isVerified is false and releases the adapter", async () => {
        const handle = fakeHandle();
        findSessionMock.mockResolvedValue(handle);
        getReadOnlyIdentityContractMock.mockResolvedValue(
            fakeSpine(async () => ({ success: true, value: false })),
        );

        const result = await checkIdentityGate({} as any, FAST);

        expect(result).toEqual({ status: "anonymous", productH160: H160 });
        expect(handle.adapter.destroy).toHaveBeenCalledTimes(1);
    });

    it("fails fast to unverifiable on a non-boolean response (ABI drift guard, no retry)", async () => {
        const handle = fakeHandle();
        findSessionMock.mockResolvedValue(handle);
        const spine = fakeSpine(async () => ({ success: true, value: "0x01" }));
        getReadOnlyIdentityContractMock.mockResolvedValue(spine);

        const result = await checkIdentityGate({} as any, FAST);

        expect(result.status).toBe("unverifiable");
        // Drift is deterministic — the retry budget (attempts=2 here) must
        // NOT be spent re-querying an answer that cannot change.
        expect(spine.isVerified.query).toHaveBeenCalledTimes(1);
        expect(handle.adapter.destroy).toHaveBeenCalledTimes(1);
    });

    it("returns unverifiable when the dry-run fails on every attempt", async () => {
        const handle = fakeHandle();
        findSessionMock.mockResolvedValue(handle);
        const spine = fakeSpine(async () => ({ success: false }));
        getReadOnlyIdentityContractMock.mockResolvedValue(spine);

        const result = await checkIdentityGate({} as any, FAST);

        expect(result.status).toBe("unverifiable");
        expect(spine.isVerified.query).toHaveBeenCalledTimes(2); // retried
        expect(handle.adapter.destroy).toHaveBeenCalledTimes(1);
    });

    it("returns unverifiable when the query throws", async () => {
        const handle = fakeHandle();
        findSessionMock.mockResolvedValue(handle);
        getReadOnlyIdentityContractMock.mockResolvedValue(
            fakeSpine(async () => {
                throw new Error("RPC down");
            }),
        );

        const result = await checkIdentityGate({} as any, FAST);

        expect(result.status).toBe("unverifiable");
        expect(handle.adapter.destroy).toHaveBeenCalledTimes(1);
    });

    it("uses an injected spine handle without re-resolving its own", async () => {
        const handle = fakeHandle();
        findSessionMock.mockResolvedValue(handle);
        const spine = fakeSpine(async () => ({ success: true, value: true }));

        const result = await checkIdentityGate({} as any, { ...FAST, identity: spine });

        expect(result).toEqual({ status: "revealed", productH160: H160 });
        expect(spine.isVerified.query).toHaveBeenCalledTimes(1);
        expect(getReadOnlyIdentityContractMock).not.toHaveBeenCalled();
    });

    it("returns unverifiable (and releases the adapter) when the session can't be derived", async () => {
        const handle = fakeHandle();
        findSessionMock.mockResolvedValue(handle);
        deriveSessionAddressesMock.mockImplementation(() => {
            throw new Error("bad session");
        });

        const result = await checkIdentityGate({} as any, FAST);

        expect(result.status).toBe("unverifiable");
        expect(handle.adapter.destroy).toHaveBeenCalledTimes(1);
        expect(getReadOnlyIdentityContractMock).not.toHaveBeenCalled();
    });
});
