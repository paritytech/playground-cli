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
 * Session-backed `PolkadotSigner` for the playground product account.
 *
 * **Why `getPolkadotSigner` with `signRaw(Payload)` instead of
 * `getPolkadotSignerFromPjs` with `signPayload`?**
 *
 * The PJS-based approach sent the full 2 MB chunk calldata as the `method`
 * field of `signPayload`. Android rejects payloads exceeding a size limit with
 * "message too big", causing every large-chunk deploy to fail on mobile wallets.
 *
 * PAPI's `getPolkadotSigner` hashes payloads >256 bytes before calling the raw
 * sign function, so the mobile wallet only ever receives ≤32 bytes. The
 * `Payload` tag tells Android to sign without the `<Bytes>…</Bytes>`
 * anti-phishing envelope (which would break the signature for extrinsic
 * payloads).
 *
 * Replace this whole file with a `product-sdk-terminal` re-export once that
 * package's signer uses the same approach and ships natively.
 */

import { getPolkadotSigner } from "polkadot-api/signer";
import { toHex } from "polkadot-api/utils";
import type { UserSession } from "@parity/product-sdk-terminal";
import type { PolkadotSigner } from "polkadot-api";
import { deriveProductAccountPublicKey } from "@parity/product-sdk-keys";

export interface ProductAccountRef {
    productId: string;
    derivationIndex: number;
}

export const INCOMPLETE_SESSION_MESSAGE =
    'Stored login session is missing the root account public key. Run "playground logout" and then "playground init" to pair again.';

export function sessionRootPublicKey(session: UserSession): Uint8Array {
    const rootAccountId = (session as { rootAccountId?: Uint8Array }).rootAccountId;
    const publicKey = rootAccountId ? new Uint8Array(rootAccountId) : new Uint8Array();
    if (publicKey.length !== 32) {
        throw new Error(INCOMPLETE_SESSION_MESSAGE);
    }
    return publicKey;
}

/**
 * Soft-derive the product account public key off a wallet root.
 *
 * This is the single source of truth for product-account math in the CLI.
 * Both `createPlaygroundSessionSigner` (which builds the signer used to
 * actually sign on-chain) and `auth.ts::deriveSessionAddresses` (which
 * builds the display triple for `dot init`) go through here so a future
 * change to derivation params can't silently desync the signer from
 * what we print.
 *
 * sr25519 soft derivation is composable on public keys alone, so deriving
 * from `rootAccountId` locally produces the SAME public key the mobile
 * derives privately via `mnemonic + "/product/...{idx}"`. Algorithm
 * parity with mobile/desktop is locked by the frozen vectors in
 * `@parity/product-sdk-keys`'s `product-account.test.ts`.
 */
export function derivePlaygroundProductPublicKey(
    rootAccountId: Uint8Array,
    ref: ProductAccountRef,
): Uint8Array {
    return deriveProductAccountPublicKey(rootAccountId, ref.productId, ref.derivationIndex);
}

export function createPlaygroundSessionSigner(
    session: UserSession,
    ref: ProductAccountRef,
): PolkadotSigner {
    // `session.rootAccountId` is the handshake-time `rootUserAccountId` —
    // the user's bare-mnemonic keypair public key on current mobile builds
    // (`deriveRootAccount()` = `derivationPath = null`). See the "Accounts"
    // section in CLAUDE.md for the host-vs-mobile derivation map.
    const publicKey = derivePlaygroundProductPublicKey(sessionRootPublicKey(session), ref);

    // Wire-shape identifier passed to host-papp's `signRaw`.
    // Has to be assembled here (not in derive) because the host-papp message
    // codec wants the productId/derivationIndex as a separate tuple field.
    const productAccountId: [string, number] = [ref.productId, ref.derivationIndex];

    const txSign = async (toSign: Uint8Array): Promise<Uint8Array> => {
        // PAPI has already hashed toSign if >256 bytes — mobile receives ≤32 bytes.
        const result = await session.signRaw({
            productAccountId,
            data: { tag: "Payload", value: toHex(toSign) },
        });
        if (result.isErr()) {
            throw new Error(`Mobile signing rejected: ${result.error.message}`);
        }
        return result.value.signature;
    };

    const bytesSign = async (data: Uint8Array): Promise<Uint8Array> => {
        const result = await session.signRaw({
            productAccountId,
            data: { tag: "Bytes", value: data },
        });
        if (result.isErr()) {
            throw new Error(`Mobile signing rejected: ${result.error.message}`);
        }
        return result.value.signature;
    };

    const base = getPolkadotSigner(publicKey, "Sr25519", txSign);
    return { ...base, signBytes: bytesSign };
}
