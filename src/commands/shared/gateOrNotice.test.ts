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

// Mock the gate decision + the Ink render so the test exercises only the
// mapping contract enforceIdentityGate owns. withSpan is collapsed to a
// pass-through so the span wrapper doesn't pull in Sentry.
const { checkIdentityGateMock, renderNoticeMock } = vi.hoisted(() => ({
    checkIdentityGateMock: vi.fn(),
    renderNoticeMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../utils/identity/identityGate.js", () => ({
    checkIdentityGate: checkIdentityGateMock,
}));

vi.mock("./IdentityGateNotice.js", () => ({
    renderIdentityGateNotice: renderNoticeMock,
}));

vi.mock("../../telemetry.js", () => ({
    withSpan: (_op: string, _name: string, fn: () => unknown) => fn(),
}));

import { enforceIdentityGate } from "./gateOrNotice.js";

const RAW = {} as any;
const H160 = "0xbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef" as `0x${string}`;

beforeEach(() => {
    vi.clearAllMocks();
    renderNoticeMock.mockResolvedValue(undefined);
});

describe("enforceIdentityGate", () => {
    it("does not block a revealed builder and prints nothing", async () => {
        checkIdentityGateMock.mockResolvedValue({ status: "revealed", productH160: H160 });

        const blocked = await enforceIdentityGate(RAW);

        expect(blocked).toBe(false);
        expect(renderNoticeMock).not.toHaveBeenCalled();
    });

    it.each(["not-logged-in", "anonymous", "unverifiable"] as const)(
        "blocks and renders the %s notice",
        async (status) => {
            checkIdentityGateMock.mockResolvedValue(
                status === "unverifiable" ? { status, detail: "x" } : { status, productH160: H160 },
            );

            const blocked = await enforceIdentityGate(RAW);

            expect(blocked).toBe(true);
            expect(renderNoticeMock).toHaveBeenCalledTimes(1);
            expect(renderNoticeMock).toHaveBeenCalledWith(status);
        },
    );

    it("forwards a pre-resolved identity-spine handle to the gate (so mod doesn't re-resolve)", async () => {
        checkIdentityGateMock.mockResolvedValue({ status: "revealed", productH160: H160 });
        const identity = { isVerified: { query: vi.fn() } };

        await enforceIdentityGate(RAW, identity as any);

        expect(checkIdentityGateMock).toHaveBeenCalledWith(RAW, { identity });
    });
});
