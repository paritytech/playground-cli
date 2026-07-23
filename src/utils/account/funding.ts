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
 * Account funding — check balance and fund the user from a testnet funder
 * chain on Paseo Asset Hub.
 *
 * The funder chain is walked in order: the dedicated funder first (our own
 * controlled account, when `MASTER_FUNDER_SEED` is set), then public Alice as
 * the fallback. If every funder is below the required threshold, callers
 * receive `AllFundersExhaustedError` carrying the user's address so they can
 * render a faucet link.
 *
 * Testnet-only: will be replaced for mainnet where users fund themselves.
 */

import { Enum } from "polkadot-api";
import { submitAndWatch } from "@parity/product-sdk-tx";
import { unwrapTx } from "../tx.js";
import type { PaseoClient } from "../connection.js";
import { FUNDER_CHAIN, type Funder } from "./funder.js";
import { AllFundersExhaustedError } from "./errors.js";

const AT_BEST = { at: "best" as const };

/** 1 PAS — below this we consider the account underfunded. */
export const MIN_BALANCE = 10_000_000_000n;

/** 10 PAS — amount sent when funding. */
export const FUND_AMOUNT = 100_000_000_000n;

/**
 * Headroom on top of the transfer amount a funder must carry — covers the
 * Balances.transfer_keep_alive fee and keeps the funder above its own
 * existential deposit. 0.1 PAS is an order of magnitude above observed fees.
 */
export const FUNDER_FEE_BUFFER = 1_000_000_000n;

export interface BalanceStatus {
    free: bigint;
    sufficient: boolean;
}

export async function checkBalance(
    client: PaseoClient,
    address: string,
    minBalance: bigint = MIN_BALANCE,
): Promise<BalanceStatus> {
    const account = await client.assetHub.query.System.Account.getValue(address, AT_BEST);
    const free = account.data.free;
    return { free, sufficient: free >= minBalance };
}

/**
 * Walk `FUNDER_CHAIN` in order and return the first funder whose free balance
 * covers `requiredBalance`. Returns `null` when every funder is low. Once
 * selected, callers should use the returned funder as-is; we do NOT retry
 * across funders if its submission fails at tx-submit time (the error there
 * is not a balance problem and deserves to surface unchanged).
 */
export async function pickFunder(
    client: PaseoClient,
    requiredBalance: bigint,
): Promise<Funder | null> {
    for (const funder of FUNDER_CHAIN) {
        const { free } = await checkBalance(client, funder.address, requiredBalance);
        if (free >= requiredBalance) return funder;
    }
    return null;
}

export async function ensureFunded(
    client: PaseoClient,
    address: string,
    minBalance: bigint = MIN_BALANCE,
    fundAmount: bigint = FUND_AMOUNT,
): Promise<void> {
    const { sufficient } = await checkBalance(client, address, minBalance);
    if (sufficient) return;

    const funder = await pickFunder(client, fundAmount + FUNDER_FEE_BUFFER);
    if (!funder) {
        throw new AllFundersExhaustedError(
            address,
            FUNDER_CHAIN.map((f) => f.name),
        );
    }

    unwrapTx(
        await submitAndWatch(
            client.assetHub.tx.Balances.transfer_keep_alive({
                dest: Enum("Id", address),
                value: fundAmount,
            }),
            funder.signer,
        ),
    );
}
