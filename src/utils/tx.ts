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
 * Unwrap a product-sdk `Result` (`@parity/result`'s `{ ok, value } | { ok, error }`
 * tagged union), throwing on the `err` channel.
 *
 * Several product-sdk calls moved from throw-on-failure to returning a `Result`
 * that NEVER rejects: `@parity/product-sdk-tx@0.3`'s `submitAndWatch` (dispatch
 * failure / timeout / signing rejection) and `@parity/product-sdk-contracts@0.9`'s
 * `ContractManager.fromLiveClient`. Every CLI call site was written against the
 * old contract, where a rejected promise signals failure (deploy aborts,
 * drip/fund error surfacing, the Invalid-Payment retry loop in `playground.ts`,
 * the MetaRegistryFailure wrap in `registry.ts`). Re-throw the typed error here
 * so control flow is preserved unchanged, and keep the throw semantics in this
 * one place rather than re-deriving `.ok` checks at every call site.
 */
export function unwrapResult<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
    if (!result.ok) {
        throw result.error instanceof Error ? result.error : new Error(String(result.error));
    }
    return result.value;
}
