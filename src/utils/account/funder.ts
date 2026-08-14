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
 * Testnet funder accounts used to top up users and session keys on Paseo
 * Asset Hub. We try the dedicated account first — our own controlled funder
 * whose seed is supplied at runtime via the `MASTER_FUNDER_SEED` environment
 * variable (NOT one of the well-known dev dropdowns in polkadot.js Apps, so
 * random drainers don't target it the way they target Alice) — and fall back
 * to the public Alice dev account (free tokens while she lasts).
 *
 * The seed is deliberately NOT hardcoded so it can never be extracted from the
 * published binary. CI injects it from the `MASTER_FUNDER_SEED` repository
 * secret; locally an operator exports it before running the E2E suite or the
 * funder tooling. The funder chain is exercised ONLY by the E2E suite and
 * operator tooling — no end-user command funds from it — so when the env var
 * is absent the dedicated funder is simply dropped from the chain and
 * everything still works off Alice.
 *
 * Even when set this is not a hard security boundary: anyone holding the seed
 * can spend it. Acceptable on testnet; the whole module is retired on mainnet
 * where users fund themselves.
 */

import type { PolkadotSigner } from "polkadot-api";
import { createDevSigner, getDevPublicKey } from "@parity/product-sdk-tx";
import { seedToAccount } from "@parity/product-sdk-keys";
import { ss58Encode } from "@parity/product-sdk-address";
import { type Env, getChainConfig } from "../../config.js";

/**
 * Dedicated testnet funder, derived at the bare root (empty derivation path)
 * from the `MASTER_FUNDER_SEED` env var (a BIP-39 mnemonic). `null` when the
 * var is unset/blank — callers then fall back to Alice alone. Derived once at
 * module load so we don't re-run BIP-39 + sr25519 on every access.
 */
const dedicatedSeed = process.env.MASTER_FUNDER_SEED?.trim();
const dedicated = dedicatedSeed ? seedToAccount(dedicatedSeed, "") : null;
const dedicatedAddress = dedicated ? ss58Encode(dedicated.publicKey) : null;

export interface Funder {
    /** Log-friendly name — included in `AllFundersExhaustedError.tried`. */
    name: string;
    /** SS58 address used to query the funder's current balance. */
    address: string;
    /** Signer used when this funder is selected for a transfer. */
    signer: PolkadotSigner;
}

/**
 * Ordered chain of funders. Callers walk this list and pick the first funder
 * whose free balance ≥ required amount. The dedicated funder (our own
 * controlled account) comes first so we draw it down before touching public
 * Alice — she's a shared dev account others drain unpredictably, so she's the
 * fallback, not the primary. The dedicated funder is present only when
 * `MASTER_FUNDER_SEED` is configured; without it the chain is Alice-only.
 */
export const FUNDER_CHAIN: readonly Funder[] = [
    ...(dedicated && dedicatedAddress
        ? [
              {
                  name: "dedicated",
                  address: dedicatedAddress,
                  signer: dedicated.signer,
              },
          ]
        : []),
    {
        name: "Alice",
        address: ss58Encode(getDevPublicKey("Alice")),
        signer: createDevSigner("Alice"),
    },
];

/**
 * Public address of the dedicated funder, or `null` when `MASTER_FUNDER_SEED`
 * is unset. Used by the balance-check CI job, which always runs with the
 * secret configured.
 */
export const DEDICATED_FUNDER_ADDRESS: string | null = dedicatedAddress;

/**
 * Faucet URL for the env, pre-filled with the user's address — one click to
 * self-fund — or null when the env (`getChainConfig().faucetUrl`) has no public
 * faucet. The base URL is single-sourced in `src/config.ts`, not here.
 */
export function faucetUrlFor(address: string, env?: Env): string | null {
    const base = getChainConfig(env).faucetUrl;
    if (!base) return null;
    // Separator-aware: every current base carries a query string (`?parachain=…`),
    // but don't silently compose an invalid URL if a future env's base doesn't.
    return `${base}${base.includes("?") ? "&" : "?"}address=${address}`;
}
