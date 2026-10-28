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
 * The signer every chain write takes since polkadot-api 3.
 *
 * papi 3 replaced `PolkadotSigner` (an object with `signTx` / `signBytes`) with
 * a transaction CREATOR: the signer is itself a function that papi calls to
 * build the signed extrinsic, with `publicKey` and `signBytes` attached by
 * convention. `CommonSignerTxCreator` is the flavour the product-sdk and
 * bulletin-deploy produce and accept (it carries the nonce / asset / mortality
 * options), so it is the one type this CLI passes around.
 */

import type { CommonSignerTxCreator } from "@polkadot-api/signers-common";

export type TxSigner = CommonSignerTxCreator;

/** Arguments papi passes when it invokes a signer to create a transaction. */
export type TxCreateArgs = Parameters<TxSigner>;

/**
 * Whether papi is invoking the signer only to SIZE a transaction.
 *
 * `getPaymentInfo` / `getEstimatedFees` call the creator with
 * `mockedSignature: true` (the 4th argument) to build a dummy-signed extrinsic
 * for fee estimation; `create` / `createAndSubmit` / `createSubmitAndWatch`
 * pass `false`. A mocked call never reaches a wallet or a phone, so anything
 * that reports signing to the user must ignore it, or a fee estimate would show
 * up as a phantom approval step.
 */
export function isMockedCreate(args: TxCreateArgs): boolean {
    return args[3] === true;
}

/**
 * Build a signer that behaves like `inner` but routes transaction creation
 * through `create` and raw signing through `signBytes`.
 *
 * A papi-3 signer IS the creation call, so a wrapper has to be a function too:
 * spreading `inner` into a plain object (the papi-2 idiom) yields something
 * papi and bulletin-deploy reject as "not callable". `txCreatorArgSpecs` is a
 * type-only brand with no runtime property, so `publicKey` and `signBytes` are
 * all that need carrying over.
 */
export function rebuildTxSigner(
    inner: TxSigner,
    create: (...args: TxCreateArgs) => Promise<string>,
    signBytes: (data: Uint8Array) => Promise<Uint8Array>,
): TxSigner {
    return Object.assign(create, { publicKey: inner.publicKey, signBytes }) as unknown as TxSigner;
}
