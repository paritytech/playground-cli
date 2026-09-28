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
// verifier dry-run (registry.ts). We never want a real adapter / network here.
const { findSessionMock, deriveSessionAddressesMock, getVerifierContractMock } = vi.hoisted(() => ({
    findSessionMock: vi.fn(),
    deriveSessionAddressesMock: vi.fn(),
    getVerifierContractMock: vi.fn(),
}));

vi.mock("../auth.js", () => ({
    findSession: findSessionMock,
    deriveSessionAddresses: deriveSessionAddressesMock,
}));

vi.mock("../registry.js", () => ({
    getVerifierContract: getVerifierContractMock,
}));

import { checkIdentityGate } from "./identityGate.js";

const ZERO = ("0x" + "00".repeat(32)) as `0x${string}`;
const REVEALED = ("0x" + "11".repeat(32)) as `0x${string}`;
const H160 = "0xbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef" as `0x${string}`;

function fakeHandle() {
    const destroy = vi.fn().mockResolvedValue(undefined);
    return { adapter: { destroy }, address: "5x", session: { rootAccountId: new Uint8Array(32) } };
}

// Stands in for whatever `registry.getVerifier()` names — the gate must ask
// THAT contract's `isVerified`, never the identity spine's `getRootAccount`
// (the spine said "anonymous" while the wired open verifier said "yes",
// so the CLI refused publishes the chain would have accepted).
function fakeVerifier(
    query: (addr: `0x${string}`) => Promise<{ success: boolean; value?: unknown }>,
) {
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
    it("returns not-logged-in and never reads the verifier when no session exists", async () => {
        findSessionMock.mockResolvedValue(null);

        const result = await checkIdentityGate({} as any, FAST);

        expect(result).toEqual({ status: "not-logged-in" });
        expect(getVerifierContractMock).not.toHaveBeenCalled();
    });

    it("returns revealed when the wired verifier accepts the caller, and releases the adapter", async () => {
        const handle = fakeHandle();
        findSessionMock.mockResolvedValue(handle);
        getVerifierContractMock.mockResolvedValue(
            fakeVerifier(async () => ({ success: true, value: true })),
        );

        const result = await checkIdentityGate({} as any, FAST);

        expect(result).toEqual({ status: "revealed", productH160: H160 });
        expect(handle.adapter.destroy).toHaveBeenCalledTimes(1);
    });

    it("returns anonymous when the wired verifier rejects the caller, and releases the adapter", async () => {
        const handle = fakeHandle();
        findSessionMock.mockResolvedValue(handle);
        getVerifierContractMock.mockResolvedValue(
            fakeVerifier(async () => ({ success: true, value: false })),
        );

        const result = await checkIdentityGate({} as any, FAST);

        expect(result).toEqual({ status: "anonymous", productH160: H160 });
        expect(handle.adapter.destroy).toHaveBeenCalledTimes(1);
    });

    it("returns unverifiable when the dry-run fails on every attempt", async () => {
        const handle = fakeHandle();
        findSessionMock.mockResolvedValue(handle);
        const verifier = fakeVerifier(async () => ({ success: false }));
        getVerifierContractMock.mockResolvedValue(verifier);

        const result = await checkIdentityGate({} as any, FAST);

        expect(result.status).toBe("unverifiable");
        expect(verifier.isVerified.query).toHaveBeenCalledTimes(2); // retried
        expect(handle.adapter.destroy).toHaveBeenCalledTimes(1);
    });

    it("returns unverifiable when the query throws", async () => {
        const handle = fakeHandle();
        findSessionMock.mockResolvedValue(handle);
        getVerifierContractMock.mockResolvedValue(
            fakeVerifier(async () => {
                throw new Error("RPC down");
            }),
        );

        const result = await checkIdentityGate({} as any, FAST);

        expect(result.status).toBe("unverifiable");
        expect(handle.adapter.destroy).toHaveBeenCalledTimes(1);
    });

    /**
     * There is no way to hand the gate a pre-resolved contract, by design: the
     * verifier it must query is named by `registry.getVerifier()`, so no handle
     * a caller already holds is the right one. `mod` used to inject its registry
     * (a cast, so tsc stayed silent) and the gate reported "couldn't verify your
     * builder status" on a healthy chain. This pins that it always resolves the
     * verifier itself.
     */
    it("always resolves the verifier itself — there is no injection seam", async () => {
        const handle = fakeHandle();
        findSessionMock.mockResolvedValue(handle);
        getVerifierContractMock.mockResolvedValue(
            fakeVerifier(async () => ({ success: true, value: true })),
        );

        const result = await checkIdentityGate({} as any, FAST);

        expect(result).toEqual({ status: "revealed", productH160: H160 });
        expect(getVerifierContractMock).toHaveBeenCalledTimes(1);
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
        expect(getVerifierContractMock).not.toHaveBeenCalled();
    });
});
