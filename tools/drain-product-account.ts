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
 * drain-product-account.ts — move native PAS + PGAS out of one of YOUR
 * phone-controlled product accounts, signed on your phone via the live CLI
 * session. Built to put a product account below the playground-app funds
 * floors (native < 0.3 PAS AND PGAS < 5B) so the "Become a builder" resource
 * drip fires on a star — but it's a general "move funds between my own product
 * accounts" tool (set PRODUCT_ID + DEST to drain or refund).
 *
 * WHY THIS TOOL EXISTS / KEY INSIGHTS
 *  - A product account (e.g. the playground-app's `5FNup4…`) is soft-derived
 *    from the wallet root as `/product/{PRODUCT_ID}/{index}`. The SAME phone
 *    signs for ANY product account of that root — you just point the signer at
 *    the right PRODUCT_ID. Here, the playground.dot CLI session signs for a
 *    DIFFERENT app's account (`pr-472-playgroundtest.dot/0`) by passing that
 *    productId to createPlaygroundSessionSigner. Verified: same root
 *    `5Ek9owHF…` → playground.dot/0 = 5CcaUS3…, pr-472-playgroundtest.dot/0 = 5FNup4….
 *  - HARD REQUIREMENT: the CLI repo must be at a version whose host-papp can
 *    DECODE your current session. The phone app writes SsoSessionsV3 with a
 *    required `deviceEncPubKey` (host-papp 0.8.7 / product-sdk-terminal 0.5.0,
 *    CLI ≥ v0.40.x). An older repo (e.g. v0.37 / host-papp 0.8.6) silently
 *    fails to decode → getSessionSigner() returns null → "NO SESSION". If you
 *    see that, `git checkout v0.40.2 && pnpm install` (or newer) first.
 *  - Fees: paid in PGAS via ChargeAssetTxPayment (PGAS_FEE), matching how
 *    product-account txs are charged. Pattern lifted from polkadot-app-deploy's
 *    PGAS_FEE_OPTIONS (src/dotns.ts).
 *
 * RUN (from the playground-cli repo root, with the matching version installed):
 *   bun tools/drain-product-account.ts            # executes (2 phone taps)
 *   DRY_RUN=1 bun tools/drain-product-account.ts   # print plan only, no submit
 *
 * Each transfer is a phone approval — nothing moves without your tap.
 */

import { getSessionSigner } from "../src/utils/auth.ts";
import { createPlaygroundSessionSigner } from "../src/utils/sessionSigner.ts";
import { createClient, Enum } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import { ss58Encode } from "@parity/product-sdk-address";

// ── config — edit these ────────────────────────────────────────────────────
/** Which product account to move funds OUT of (its productId/index off your
 *  root). "pr-472-playgroundtest.dot" → 5FNup4… ; "playground.dot" → 5CcaUS3… */
const PRODUCT_ID = "pr-472-playgroundtest.dot";
const DERIVATION_INDEX = 0;
/** Destination — one of YOUR other product accounts (funds stay recoverable). */
const DEST = "5CcaUS3AKQyJaVLeFGTwBMJPPpoEcgS55g64Fws4UdLqbcmC";
/** What to LEAVE behind (planck / PGAS units). Defaults drop below the app's
 *  funds floors (0.3 PAS = 3e9 planck, 5B PGAS). Set 0n to sweep everything. */
const LEAVE_PAS_PLANCK = 2_000_000_000n; // 0.2 PAS
const LEAVE_PGAS = 1_000_000_000n; // ~1B PGAS (covers the in-flight tx fees)
const ASSET_HUB_RPC = "wss://paseo-asset-hub-next-rpc.polkadot.io";
// ───────────────────────────────────────────────────────────────────────────

const PGAS_ID = 2_000_000_000;
const DRY_RUN = process.env.DRY_RUN === "1";
const fmt = (p: bigint) => (Number(p) / 1e10).toFixed(4) + " PAS";

// ChargeAssetTxPayment → PGAS (PalletInstance 50, GeneralIndex = asset id).
const PGAS_FEE = {
  customSignedExtensions: {
    ChargeAssetTxPayment: {
      value: {
        tip: 0n,
        asset_id: {
          parents: 0,
          interior: {
            type: "X2",
            value: [
              { type: "PalletInstance", value: 50 },
              { type: "GeneralIndex", value: BigInt(PGAS_ID) },
            ],
          },
        },
      },
    },
  },
};

const handle = await getSessionSigner();
if (!handle) {
  console.error(
    "NO SESSION. Either run `playground login`, or the repo is too old to decode\n" +
      "your session (need host-papp 0.8.7 / CLI >= v0.40.x: `git checkout v0.40.2 && pnpm install`).",
  );
  process.exit(1);
}

const signer = createPlaygroundSessionSigner(handle.userSession, {
  productId: PRODUCT_ID,
  derivationIndex: DERIVATION_INDEX,
});
const src = ss58Encode(signer.publicKey);
console.log(`source ${PRODUCT_ID}/${DERIVATION_INDEX} -> ${src}`);
console.log(`dest                                   -> ${DEST}`);

const client = createClient(getWsProvider([ASSET_HUB_RPC]));
const api = client.getTypedApi(paseo_asset_hub);
const free = (await api.query.System.Account.getValue(src))?.data?.free ?? 0n;
const pgas = (await api.query.Assets.Account.getValue(PGAS_ID, src))?.balance ?? 0n;
console.log(`BEFORE  native ${fmt(free)}  PGAS ${pgas}`);

const pgasSend = pgas - LEAVE_PGAS;
const pasSend = free - LEAVE_PAS_PLANCK;
console.log(`PLAN    send PGAS ${pgasSend}  +  PAS ${pasSend} (${fmt(pasSend)})  ->  ${DEST}`);

if (DRY_RUN) {
  console.log("DRY_RUN=1 — nothing submitted.");
  client.destroy();
  handle.destroy();
  process.exit(0);
}

if (pgasSend > 0n) {
  console.log("→ TX1 Assets.transfer PGAS (approve on phone)…");
  const r = await api.tx.Assets
    .transfer({ id: PGAS_ID, target: Enum("Id", DEST), amount: pgasSend })
    .signAndSubmit(signer, PGAS_FEE);
  console.log(`  TX1 ${r.ok ? "OK" : "FAILED"} ${r.txHash}`);
}
if (pasSend > 0n) {
  console.log("→ TX2 Balances.transfer_keep_alive PAS (approve on phone)…");
  const r = await api.tx.Balances
    .transfer_keep_alive({ dest: Enum("Id", DEST), value: pasSend })
    .signAndSubmit(signer, PGAS_FEE);
  console.log(`  TX2 ${r.ok ? "OK" : "FAILED"} ${r.txHash}`);
}

const free2 = (await api.query.System.Account.getValue(src))?.data?.free ?? 0n;
const pgas2 = (await api.query.Assets.Account.getValue(PGAS_ID, src))?.balance ?? 0n;
console.log(`AFTER   native ${fmt(free2)}  PGAS ${pgas2}`);
console.log(
  `below app floors? native<0.3PAS:${free2 < 3_000_000_000n}  pgas<5B:${pgas2 < 5_000_000_000n}`,
);
client.destroy();
handle.destroy();
process.exit(0);
