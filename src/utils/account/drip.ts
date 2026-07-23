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
 * `playground drip` — top up the signed-in user's product-derived account with
 * a little native PAS so deploy/contract fee paths have headroom.
 *
 * This is the dev-funder logic we removed from `playground login` (login no
 * longer funds or maps — the `SmartContractAllowance` grant mints PGAS, which
 * creates + auto-maps the product account; see
 * `src/utils/account/mapping.ts`). It is reinstated here as an EXPLICIT,
 * opt-in command rather than an automatic login side effect.
 *
 * It is deliberately NOT a faucet:
 *   - the recipient is ONLY the caller's own product account
 *     (`playground.dot/0`, the account the phone mints PGAS to) — there is no
 *     way to fund an arbitrary address; and
 *   - each invocation sends at most `DRIP_AMOUNT` (1 PAS) and stops once the
 *     account reaches `DRIP_CAP` (10 PAS), so a user tops up 1 PAS at a time
 *     and cannot accumulate beyond the cap from the shared dev funder.
 *
 * The source signer is the SAME bare-master dev account `polkadot-app-deploy`
 * funds its own `attemptTestnetTopUp` from — the bare master of the standard
 * substrate dev mnemonic with an EMPTY derivation path, NOT the canonical
 * `//Alice` derived account. paseo-next-v2 pre-funds this specific address;
 * `//Alice` (`seedToAccount(DEV_PHRASE, "//Alice")`) resolves to a different,
 * unfunded SS58 on the v2 chain.
 */

import { Enum } from "polkadot-api";
import { submitAndWatch } from "@parity/product-sdk-tx";
import { unwrapTx } from "../tx.js";
import { seedToAccount } from "@parity/product-sdk-keys";
import { getNetworkLabel, getTokenSymbol } from "../../config.js";
import type { PaseoClient } from "../connection.js";

/**
 * Substrate dev mnemonic. Mirrors `DEFAULT_MNEMONIC` in
 * `polkadot-app-deploy/src/dotns.ts`.
 */
const DEV_MNEMONIC = "bottom drive obey lake curtain smoke basket hold race lonely fit walk";

/**
 * Lazy-initialised dev master account. Empty derivation path resolves to the
 * bare master from the mnemonic, matching `keyring.addFromUri(DEFAULT_MNEMONIC)`
 * in polkadot-app-deploy. This is DIFFERENT from `seedToAccount(DEV_PHRASE,
 * "//Alice")`. paseo-next-v2's pre-funding sits on the bare-master address,
 * not on the `//Alice` derived one.
 *
 * Lazy so commands that never call `dripToProductAccount` don't pay the
 * sr25519 derivation cost during module load.
 */
let cachedDevAccount: ReturnType<typeof seedToAccount> | null = null;
function getDevAccount(): ReturnType<typeof seedToAccount> {
    if (cachedDevAccount === null) {
        cachedDevAccount = seedToAccount(DEV_MNEMONIC, "");
    }
    return cachedDevAccount;
}

/**
 * Decimal places for the native token (PAS) on Asset Hub Paseo. Verified live
 * against the chain (2026-06-16): `system_properties.tokenDecimals` is 10 on
 * both the asset hub and people chains, and `Balances.ExistentialDeposit`
 * (100_000_000 planck) is the canonical 0.01 PAS only at 10 decimals. PGAS is
 * 1:1 with PAS, so `playground status` formats PGAS balances at this same scale
 * (see `account/pgas.ts`).
 */
export const PAS_DECIMALS = 10;

/** 1 PAS in planck. */
const ONE_PAS = 10n ** BigInt(PAS_DECIMALS);

/** Amount sent per `playground drip` invocation. */
export const DRIP_AMOUNT = ONE_PAS;

/**
 * Balance cap. Once the product account holds at least this much PAS, a drip
 * is a no-op — the user is already at the ceiling. Keeping a hard cap (instead
 * of an unbounded faucet) is what makes this safe to expose: a user tops up
 * 1 PAS at a time up to 10 PAS and no further.
 */
export const DRIP_CAP = 10n * ONE_PAS;

/**
 * Headroom on top of the per-drip transfer that the dev master must carry.
 * Covers the `Balances.transfer_allow_death` fee plus a safety margin so a
 * drip run immediately after a depleting transfer doesn't see a
 * temporarily-low balance and abort. 1 PAS matches polkadot-app-deploy's
 * `SOURCE_BUFFER`.
 */
const SOURCE_BUFFER = ONE_PAS;

/**
 * Custom error surfaced when the shared dev master can no longer cover a drip.
 * Operator-facing — points at the address the next refill should target so
 * on-call doesn't have to grep the source.
 */
export class DevFunderExhaustedError extends Error {
    readonly address: string;
    readonly free: bigint;
    readonly required: bigint;
    constructor(address: string, free: bigint, required: bigint) {
        super(
            `Dev funder ${address} is too low to drip to the product account: free=${free} planck, need >=${required} planck. Refill on ${getNetworkLabel()} Asset Hub before re-running.`,
        );
        this.name = "DevFunderExhaustedError";
        this.address = address;
        this.free = free;
        this.required = required;
    }
}

export interface DripResult {
    /** True when no transfer was sent (already at/above {@link DRIP_CAP}). */
    skipped: boolean;
    /** Planck sent this invocation (absent when skipped). */
    transferred?: bigint;
    /** The recipient's free balance observed before the (possible) transfer. */
    balance: bigint;
}

/**
 * Send {@link DRIP_AMOUNT} PAS from the dev funder to `recipient` (the caller's
 * product-derived SS58) unless `recipient` already holds {@link DRIP_CAP} or
 * more. Waits for finalization before returning so a follow-up `playground
 * deploy` doesn't race a re-org that would roll back the credit.
 *
 * Throws {@link DevFunderExhaustedError} if the dev master no longer carries
 * `DRIP_AMOUNT + SOURCE_BUFFER` — the caller renders that as a friendly
 * "dev funder is out of tokens" notice rather than a stack trace.
 */
export async function dripToProductAccount(
    client: PaseoClient,
    recipient: string,
): Promise<DripResult> {
    const recipientAccount = await client.assetHub.query.System.Account.getValue(recipient, {
        at: "best",
    });
    const balance = recipientAccount.data.free;
    if (balance >= DRIP_CAP) {
        return { skipped: true, balance };
    }

    const dev = getDevAccount();
    if (dev.ss58Address === recipient) {
        // Hypothetical: a user's product account collides with the bare-master
        // dev address. Mirrors polkadot-app-deploy's self-transfer guard.
        return { skipped: true, balance };
    }

    const required = DRIP_AMOUNT + SOURCE_BUFFER;
    const devBalance = await client.assetHub.query.System.Account.getValue(dev.ss58Address, {
        at: "best",
    });
    if (devBalance.data.free < required) {
        throw new DevFunderExhaustedError(dev.ss58Address, devBalance.data.free, required);
    }

    unwrapTx(
        await submitAndWatch(
            client.assetHub.tx.Balances.transfer_allow_death({
                dest: Enum("Id", recipient),
                value: DRIP_AMOUNT,
            }),
            dev.signer,
            { waitFor: "finalized" },
        ),
    );
    return { skipped: false, transferred: DRIP_AMOUNT, balance };
}

/**
 * Format a planck amount (`PAS_DECIMALS`-decimal) as a short human string, e.g.
 * `"3.5 PAS"` (or `"3.5 SUM"` on Summit). The token symbol comes from the active
 * env's `tokenSymbol` (see `getTokenSymbol`), so flipping `ACTIVE_TESTNET_ENV`
 * re-labels every amount. Trims trailing zeros and caps at 4 fractional digits —
 * display-only, never used for on-chain math.
 */
export function formatPas(planck: bigint): string {
    const symbol = getTokenSymbol();
    const base = ONE_PAS;
    const whole = planck / base;
    const frac = planck % base;
    if (frac === 0n) return `${whole} ${symbol}`;
    const fracStr = frac.toString().padStart(PAS_DECIMALS, "0").slice(0, 4).replace(/0+$/, "");
    return fracStr ? `${whole}.${fracStr} ${symbol}` : `${whole} ${symbol}`;
}
