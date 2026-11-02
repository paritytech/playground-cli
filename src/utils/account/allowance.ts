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
 * Bulletin storage allowance — check and grant authorization.
 *
 * Testnet-only: Alice grants allowance. On mainnet this will
 * be handled differently (e.g. user pays or is pre-authorized).
 */

import { Enum } from "polkadot-api";
import { submitAndWatch, createDevSigner } from "@parity/product-sdk-tx";
import { unwrapResult } from "../tx.js";
import type { PaseoClient } from "../connection.js";
import { remainingAuthorizationExtent } from "./authorizationExtent.js";

const AT_BEST = { at: "best" as const };

/** Number of transactions to authorize. */
export const BULLETIN_TRANSACTIONS = 1000;

/** Bytes to authorize (100 MB). */
export const BULLETIN_BYTES = 100_000_000n;

/** Re-authorize when remaining transactions drop below this. */
export const LOW_TX_THRESHOLD = 10;

export interface AllowanceStatus {
    /** An authorization exists AND has not expired — the only state the chain accepts. */
    authorized: boolean;
    remainingTxs: number;
    remainingBytes: bigint;
}

/**
 * Bulletin storage authorization for `address`.
 *
 * An EXPIRED authorization reads as unauthorized. The entry stays in
 * `TransactionStorage.Authorizations` after it lapses, with its quota intact,
 * but the chain rejects every `store` from the account with `Invalid.Payment`
 * — so checking existence and quota alone reported a dead authorization as
 * healthy, `ensureAllowance` never renewed it, and the E2E deployer's metadata
 * uploads failed for two weeks (Oct 2026). Same predicate as the CLI's own
 * `isAuthorizationActive`: exists and `expiration > current block`.
 */
export async function checkAllowance(
    client: PaseoClient,
    address: string,
): Promise<AllowanceStatus> {
    const [raw, currentBlock] = await Promise.all([
        client.bulletin.query.TransactionStorage.Authorizations.getValue(
            Enum("Account", address),
            AT_BEST,
        ),
        client.bulletin.query.System.Number.getValue(AT_BEST),
    ]);

    if (!raw || raw.expiration <= currentBlock) {
        return { authorized: false, remainingTxs: 0, remainingBytes: 0n };
    }

    const remaining = remainingAuthorizationExtent(raw.extent);
    return {
        authorized: true,
        remainingTxs: remaining.transactions,
        remainingBytes: remaining.bytes,
    };
}

/**
 * Grant (or renew) the testnet Bulletin authorization when it is missing,
 * expired, or nearly used up. On an expired entry `authorize_account` replaces
 * it with a fresh one (`expiry = now + AuthorizationPeriod`, counters reset);
 * on a live one it adds to the caps without moving the expiry.
 */
export async function ensureAllowance(client: PaseoClient, address: string): Promise<void> {
    const status = await checkAllowance(client, address);
    if (status.authorized && status.remainingTxs >= LOW_TX_THRESHOLD) return;

    const alice = createDevSigner("Alice");
    unwrapResult(
        await submitAndWatch(
            client.bulletin.tx.TransactionStorage.authorize_account({
                who: address,
                transactions: BULLETIN_TRANSACTIONS,
                bytes: BULLETIN_BYTES,
            }),
            alice,
        ),
    );
}
