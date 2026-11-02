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
 * Tests for bulletin allowance checks and Alice-based granting.
 *
 * Only `@parity/product-sdk-tx` is mocked — we use the real `polkadot-api`
 * `Enum(...)` so a mistake like `Enum("User", …)` instead of `Enum("Account", …)`
 * fails the test rather than silently passing a placeholder through.
 */

import { describe, it, expect, vi } from "vitest";

const mockSubmitAndWatch = vi
    .fn<(tx: unknown, signer: unknown) => Promise<unknown>>()
    .mockResolvedValue({ ok: true });
const mockCreateDevSigner = vi
    .fn<(name: string) => unknown>()
    .mockImplementation((name) => ({ __devSigner: name }));

vi.mock("@parity/product-sdk-tx", () => ({
    submitAndWatch: (...args: unknown[]) => mockSubmitAndWatch(args[0], args[1] as unknown),
    createDevSigner: (...args: unknown[]) => mockCreateDevSigner(args[0] as string),
}));

const { checkAllowance, ensureAllowance, BULLETIN_BYTES, BULLETIN_TRANSACTIONS, LOW_TX_THRESHOLD } =
    await import("./allowance.js");

/** Bulletin best block the mock reports — below every unexpired `expiration` used here. */
const CURRENT_BLOCK = 50;

function makeClient(authResult: unknown, currentBlock = CURRENT_BLOCK) {
    const authorizeFactory = vi.fn().mockImplementation((args: unknown) => ({
        __kind: "authorize_account",
        args,
    }));
    return {
        client: {
            bulletin: {
                query: {
                    TransactionStorage: {
                        Authorizations: {
                            getValue: vi.fn().mockResolvedValue(authResult),
                        },
                    },
                    System: {
                        Number: {
                            getValue: vi.fn().mockResolvedValue(currentBlock),
                        },
                    },
                },
                tx: {
                    TransactionStorage: {
                        authorize_account: authorizeFactory,
                    },
                },
            },
        } as any,
        authorizeFactory,
    };
}

describe("checkAllowance", () => {
    it("returns unauthorized when no authorization exists", async () => {
        const { client } = makeClient(undefined);
        const result = await checkAllowance(client, "5GrwvaEF...");
        expect(result.authorized).toBe(false);
        expect(result.remainingTxs).toBe(0);
        expect(result.remainingBytes).toBe(0n);
    });

    it("returns remaining quota from current runtime allowance fields", async () => {
        const { client } = makeClient({
            extent: {
                transactions: 250,
                transactions_allowance: 1000,
                bytes: 12_500_000n,
                bytes_allowance: 100_000_000n,
            },
            expiration: 999999,
        });
        const result = await checkAllowance(client, "5GrwvaEF...");
        expect(result.authorized).toBe(true);
        expect(result.remainingTxs).toBe(750);
        expect(result.remainingBytes).toBe(87_500_000n);
    });

    it("clamps current runtime remaining quota at zero", async () => {
        const { client } = makeClient({
            extent: {
                transactions: 1000,
                transactions_allowance: 1000,
                bytes: 100_000_000n,
                bytes_allowance: 100_000_000n,
            },
            expiration: 999999,
        });
        const result = await checkAllowance(client, "5GrwvaEF...");
        expect(result.remainingTxs).toBe(0);
        expect(result.remainingBytes).toBe(0n);
    });

    it("returns authorized even with low remaining txs", async () => {
        const { client } = makeClient({
            extent: {
                transactions: 95,
                transactions_allowance: 100,
                bytes: 0n,
                bytes_allowance: 1_000_000n,
            },
            expiration: 100,
        });
        const result = await checkAllowance(client, "5GrwvaEF...");
        expect(result.authorized).toBe(true);
        expect(result.remainingTxs).toBe(5);
    });

    /**
     * The entry outlives its expiry with the quota intact, but the chain
     * rejects every store with Invalid.Payment. Reading it as healthy kept the
     * E2E deployer on a dead authorization for two weeks.
     */
    it("treats an expired authorization as unauthorized, quota notwithstanding", async () => {
        const { client } = makeClient(
            {
                extent: {
                    transactions: 778,
                    transactions_allowance: 1000,
                    bytes: 249_319n,
                    bytes_allowance: 100_000_000n,
                },
                expiration: 2_292_314,
            },
            2_503_589,
        );
        const result = await checkAllowance(client, "5GrwvaEF...");
        expect(result).toEqual({ authorized: false, remainingTxs: 0, remainingBytes: 0n });
    });

    it("treats an authorization expiring at the current block as expired", async () => {
        const { client } = makeClient(
            {
                extent: {
                    transactions: 0,
                    transactions_allowance: 1000,
                    bytes: 0n,
                    bytes_allowance: 100_000_000n,
                },
                expiration: CURRENT_BLOCK,
            },
            CURRENT_BLOCK,
        );
        expect((await checkAllowance(client, "5GrwvaEF...")).authorized).toBe(false);
    });

    it("wraps the address in Enum('Account', …) when querying Authorizations", async () => {
        const { client } = makeClient(undefined);
        await checkAllowance(client, "5GrwvaEFaddr");

        const getValueFn = client.bulletin.query.TransactionStorage.Authorizations.getValue;
        const firstArg = getValueFn.mock.calls[0][0];
        expect(firstArg).toMatchObject({ type: "Account", value: "5GrwvaEFaddr" });
    });
});

describe("ensureAllowance", () => {
    it("skips granting when allowance is sufficient", async () => {
        mockSubmitAndWatch.mockClear();
        const { client } = makeClient({
            extent: {
                transactions: 500,
                transactions_allowance: 1000,
                bytes: 50_000_000n,
                bytes_allowance: 100_000_000n,
            },
            expiration: 999999,
        });
        await ensureAllowance(client, "5GrwvaEF...");
        expect(mockSubmitAndWatch).not.toHaveBeenCalled();
    });

    it("grants allowance when not authorized", async () => {
        mockSubmitAndWatch.mockClear();
        mockCreateDevSigner.mockClear();
        const { client, authorizeFactory } = makeClient(undefined);
        await ensureAllowance(client, "5GrwvaEFaddr");

        expect(mockCreateDevSigner).toHaveBeenCalledWith("Alice");
        expect(mockSubmitAndWatch).toHaveBeenCalledTimes(1);
        expect(authorizeFactory).toHaveBeenCalledWith({
            who: "5GrwvaEFaddr",
            transactions: BULLETIN_TRANSACTIONS,
            bytes: BULLETIN_BYTES,
        });
    });

    it("re-grants an expired authorization even with quota left", async () => {
        mockSubmitAndWatch.mockClear();
        const { client, authorizeFactory } = makeClient(
            {
                extent: {
                    transactions: 10,
                    transactions_allowance: 1000,
                    bytes: 0n,
                    bytes_allowance: 100_000_000n,
                },
                expiration: CURRENT_BLOCK - 1,
            },
            CURRENT_BLOCK,
        );
        await ensureAllowance(client, "5GrwvaEFaddr");
        expect(mockSubmitAndWatch).toHaveBeenCalledTimes(1);
        expect(authorizeFactory).toHaveBeenCalledWith({
            who: "5GrwvaEFaddr",
            transactions: BULLETIN_TRANSACTIONS,
            bytes: BULLETIN_BYTES,
        });
    });

    it(`re-grants allowance when remaining txs are below LOW_TX_THRESHOLD (${LOW_TX_THRESHOLD})`, async () => {
        mockSubmitAndWatch.mockClear();
        const { client } = makeClient({
            extent: {
                transactions: 95,
                transactions_allowance: LOW_TX_THRESHOLD + 90,
                bytes: 0n,
                bytes_allowance: 1_000_000n,
            },
            expiration: 100,
        });
        await ensureAllowance(client, "5GrwvaEF...");
        expect(mockSubmitAndWatch).toHaveBeenCalledTimes(1);
    });

    it(`skips granting at exactly LOW_TX_THRESHOLD (${LOW_TX_THRESHOLD})`, async () => {
        mockSubmitAndWatch.mockClear();
        const { client } = makeClient({
            extent: {
                transactions: 90,
                transactions_allowance: LOW_TX_THRESHOLD + 90,
                bytes: 0n,
                bytes_allowance: 10_000_000n,
            },
            expiration: 100,
        });
        await ensureAllowance(client, "5GrwvaEF...");
        expect(mockSubmitAndWatch).not.toHaveBeenCalled();
    });
});
