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

const { getCachedAllocationMock, requestResourceAllocationMock } = vi.hoisted(() => ({
    getCachedAllocationMock: vi.fn(),
    requestResourceAllocationMock: vi.fn(),
}));

vi.mock("@parity/product-sdk-terminal/host", () => ({
    getCachedAllocation: getCachedAllocationMock,
    requestResourceAllocation: requestResourceAllocationMock,
}));

import { ensureSmartContractAllowance } from "./smartContracts.js";

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

beforeEach(() => {
    getCachedAllocationMock.mockReset();
    requestResourceAllocationMock.mockReset();
});

describe("ensureSmartContractAllowance", () => {
    it("skips local dev signers without any SDK calls", async () => {
        const deploySigner: ResolvedSigner = {
            source: "dev",
            address: "5Dev",
            signer: {} as any,
            destroy() {},
        };

        await expect(ensureSmartContractAllowance({ deploySigner })).resolves.toBeUndefined();
        expect(getCachedAllocationMock).not.toHaveBeenCalled();
        expect(requestResourceAllocationMock).not.toHaveBeenCalled();
    });

    it("throws the login hint when there is no session/adapter", async () => {
        await expect(
            ensureSmartContractAllowance({
                deploySigner: {
                    source: "session",
                    address: "5Owner",
                    signer: {} as any,
                    destroy() {},
                },
            }),
        ).rejects.toThrow(/playground login/);
    });

    it("uses a cached allocation without going over the wire", async () => {
        getCachedAllocationMock.mockResolvedValue({ tag: "SmartContractAllowance", dest: 0 });

        await ensureSmartContractAllowance({ deploySigner: sessionSigner() });

        expect(requestResourceAllocationMock).not.toHaveBeenCalled();
    });

    it("requests a missing smart-contract allowance and succeeds on Allocated", async () => {
        getCachedAllocationMock.mockResolvedValue(null);
        requestResourceAllocationMock.mockResolvedValue([
            { tag: "Allocated", value: { tag: "SmartContractAllowance", value: undefined } },
        ]);

        await ensureSmartContractAllowance({ deploySigner: sessionSigner() });

        expect(requestResourceAllocationMock).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            [{ tag: "SmartContractAllowance", value: { tag: "Index", value: 0 } }],
        );
    });

    it("throws an actionable error when mobile denies the allowance", async () => {
        getCachedAllocationMock.mockResolvedValue(null);
        requestResourceAllocationMock.mockResolvedValue([{ tag: "Rejected", value: undefined }]);

        await expect(
            ensureSmartContractAllowance({ deploySigner: sessionSigner() }),
        ).rejects.toThrow(/Smart-contract gas allowance allocation Rejected/);
    });
});
