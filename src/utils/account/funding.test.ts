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
 * Tests for balance checks and funder-chain selection.
 *
 * We mock:
 *   - `./funder.js` to expose two named funders with predictable signer
 *     identities (so `submitAndWatch` assertions can check which funder was
 *     picked without dragging sr25519 derivation into the test).
 *   - `@parity/product-sdk-tx`'s `submitAndWatch` to observe what got submitted
 *     without touching the network.
 *
 * The real `polkadot-api` `Enum(...)` is used so the `transfer_keep_alive({
 * dest: Enum("Id", …) })` call fails loudly if anyone changes the variant
 * name ("Id" → "Index", etc.) without updating tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSubmitAndWatch = vi
    .fn<(tx: unknown, signer: unknown) => Promise<unknown>>()
    .mockResolvedValue({ ok: true });

vi.mock("@parity/product-sdk-tx", () => ({
    submitAndWatch: (...args: unknown[]) => mockSubmitAndWatch(args[0], args[1] as unknown),
}));

const ALICE_SIGNER = { __funder: "Alice" };
const DEDICATED_SIGNER = { __funder: "dedicated" };
const ALICE_ADDRESS = "5Alice";
const DEDICATED_ADDRESS = "5Dedicated";

vi.mock("./funder.js", () => ({
    // Production order: dedicated funder first (primary), Alice as fallback.
    FUNDER_CHAIN: [
        { name: "dedicated", address: DEDICATED_ADDRESS, signer: DEDICATED_SIGNER },
        { name: "Alice", address: ALICE_ADDRESS, signer: ALICE_SIGNER },
    ],
    DEDICATED_FUNDER_ADDRESS: DEDICATED_ADDRESS,
    faucetUrlFor: (addr: string) => `https://faucet.polkadot.io/?parachain=1500&address=${addr}`,
}));

const { checkBalance, ensureFunded, pickFunder, FUND_AMOUNT, FUNDER_FEE_BUFFER } = await import(
    "./funding.js"
);
const { AllFundersExhaustedError } = await import("./errors.js");

const USER_ADDRESS = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

/**
 * Build a fake `PaseoClient`-ish object whose `System.Account.getValue` mock
 * looks up the queried address in `balances` (defaulting to 0 for unknown
 * addresses). Returns the transfer factory mock so callers can assert the
 * arguments handed to `transfer_keep_alive`.
 */
function makeClient(balances: Record<string, bigint>) {
    const transferFactory = vi.fn().mockImplementation((args: unknown) => ({
        __kind: "transfer_keep_alive",
        args,
    }));
    const getValue = vi.fn().mockImplementation(async (address: string) => ({
        data: { free: balances[address] ?? 0n, reserved: 0n, frozen: 0n },
    }));
    return {
        client: {
            assetHub: {
                query: {
                    System: {
                        Account: { getValue },
                    },
                },
                tx: {
                    Balances: {
                        transfer_keep_alive: transferFactory,
                    },
                },
            },
        } as any,
        transferFactory,
        getValue,
    };
}

beforeEach(() => {
    mockSubmitAndWatch.mockClear();
});

describe("checkBalance", () => {
    it("reports sufficient when balance >= default MIN_BALANCE (1 PAS)", async () => {
        const { client } = makeClient({ [USER_ADDRESS]: 10_000_000_000n });
        const result = await checkBalance(client, USER_ADDRESS);
        expect(result.sufficient).toBe(true);
        expect(result.free).toBe(10_000_000_000n);
    });

    it("reports insufficient when balance < default MIN_BALANCE (1 PAS)", async () => {
        const { client } = makeClient({ [USER_ADDRESS]: 5_000_000_000n });
        const result = await checkBalance(client, USER_ADDRESS);
        expect(result.sufficient).toBe(false);
    });

    it("reports insufficient when balance is zero", async () => {
        const { client } = makeClient({ [USER_ADDRESS]: 0n });
        const result = await checkBalance(client, USER_ADDRESS);
        expect(result.sufficient).toBe(false);
        expect(result.free).toBe(0n);
    });

    it("respects an explicit minBalance override (below default)", async () => {
        const { client } = makeClient({ [USER_ADDRESS]: 6_000_000_000n });
        const result = await checkBalance(client, USER_ADDRESS, 5_000_000_000n);
        expect(result.sufficient).toBe(true);
    });

    it("respects an explicit minBalance override (above default)", async () => {
        const { client } = makeClient({ [USER_ADDRESS]: 10_000_000_000n });
        const result = await checkBalance(client, USER_ADDRESS, 50_000_000_000n);
        expect(result.sufficient).toBe(false);
    });
});

describe("pickFunder", () => {
    const required = FUND_AMOUNT + FUNDER_FEE_BUFFER;

    it("returns the dedicated funder when it has enough (and never queries Alice)", async () => {
        const { client, getValue } = makeClient({ [DEDICATED_ADDRESS]: required + 1n });
        const funder = await pickFunder(client, required);
        expect(funder?.name).toBe("dedicated");
        // Short-circuits: only the dedicated funder's balance was queried.
        const addresses = getValue.mock.calls.map((c) => c[0]);
        expect(addresses).toEqual([DEDICATED_ADDRESS]);
    });

    it("falls through to Alice when the dedicated funder is low", async () => {
        const { client } = makeClient({
            [DEDICATED_ADDRESS]: 0n,
            [ALICE_ADDRESS]: required + 1n,
        });
        const funder = await pickFunder(client, required);
        expect(funder?.name).toBe("Alice");
    });

    it("returns null when every funder is below the threshold", async () => {
        const { client } = makeClient({
            [ALICE_ADDRESS]: 0n,
            [DEDICATED_ADDRESS]: 0n,
        });
        expect(await pickFunder(client, required)).toBeNull();
    });
});

describe("ensureFunded", () => {
    it("skips funding when balance is sufficient", async () => {
        const { client } = makeClient({ [USER_ADDRESS]: 50_000_000_000n });
        await ensureFunded(client, USER_ADDRESS);
        expect(mockSubmitAndWatch).not.toHaveBeenCalled();
    });

    it("funds with FUND_AMOUNT via the dedicated funder when it has balance", async () => {
        const { client, transferFactory } = makeClient({
            [USER_ADDRESS]: 0n,
            [DEDICATED_ADDRESS]: FUND_AMOUNT + FUNDER_FEE_BUFFER + 1n,
        });
        await ensureFunded(client, USER_ADDRESS);

        expect(mockSubmitAndWatch).toHaveBeenCalledTimes(1);
        const [, signer] = mockSubmitAndWatch.mock.calls[0];
        expect(signer).toBe(DEDICATED_SIGNER);

        expect(transferFactory).toHaveBeenCalledTimes(1);
        const callArgs = transferFactory.mock.calls[0][0] as {
            dest: { type: string };
            value: bigint;
        };
        // We don't mock polkadot-api — Enum() actually builds the runtime
        // tag. If the caller ever changes "Id" to "Index", this assertion
        // breaks even though the variable name looks correct.
        expect(callArgs.value).toBe(FUND_AMOUNT);
        expect(callArgs.dest).toMatchObject({ type: "Id" });
    });

    it("falls through to Alice when the dedicated funder is low", async () => {
        const { client } = makeClient({
            [USER_ADDRESS]: 0n,
            [DEDICATED_ADDRESS]: 0n,
            [ALICE_ADDRESS]: FUND_AMOUNT + FUNDER_FEE_BUFFER + 1n,
        });
        await ensureFunded(client, USER_ADDRESS);

        expect(mockSubmitAndWatch).toHaveBeenCalledTimes(1);
        const [, signer] = mockSubmitAndWatch.mock.calls[0];
        expect(signer).toBe(ALICE_SIGNER);
    });

    it("throws AllFundersExhaustedError carrying the user address + tried list when every funder is low", async () => {
        const { client } = makeClient({
            [USER_ADDRESS]: 0n,
            [ALICE_ADDRESS]: 0n,
            [DEDICATED_ADDRESS]: 0n,
        });
        await expect(ensureFunded(client, USER_ADDRESS)).rejects.toSatisfy((err: unknown) => {
            if (!(err instanceof AllFundersExhaustedError)) return false;
            return err.userAddress === USER_ADDRESS && err.tried.join(",") === "dedicated,Alice";
        });
        expect(mockSubmitAndWatch).not.toHaveBeenCalled();
    });

    it("uses caller-supplied minBalance + fundAmount when passed", async () => {
        const { client, transferFactory } = makeClient({
            [USER_ADDRESS]: 3_000_000_000n,
            [DEDICATED_ADDRESS]: 40_000_000_000n, // covers 20 PAS + buffer
        });
        await ensureFunded(client, USER_ADDRESS, 5_000_000_000n, 20_000_000_000n);
        expect(mockSubmitAndWatch).toHaveBeenCalledTimes(1);
        const callArgs = transferFactory.mock.calls[0][0] as { value: bigint };
        expect(callArgs.value).toBe(20_000_000_000n);
    });

    it("skips funding when balance is above the caller-supplied minBalance", async () => {
        const { client } = makeClient({ [USER_ADDRESS]: 6_000_000_000n });
        await ensureFunded(client, USER_ADDRESS, 5_000_000_000n);
        expect(mockSubmitAndWatch).not.toHaveBeenCalled();
    });
});
