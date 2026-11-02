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

import type { AllocatableResource } from "@parity/product-sdk-terminal/host";

/** What login knows about each resource before deciding whether to ask the phone. */
export interface AllowanceState {
    /** Per resource (same order as the resource list): does the SDK cache hold an entry? */
    cached: readonly boolean[];
    /** The cached Bulletin slot key has a live, unexpired on-chain authorization. */
    bulletinUsable: boolean;
    /** The signed-in product account is mapped in Revive (`Revive.OriginalAccount`). */
    accountMapped: boolean;
}

/**
 * The resources login still has to request from the phone. Empty means
 * "already granted".
 *
 * A cache entry alone is not proof of a grant for THIS account. The SDK's
 * allowance cache (`~/.polkadot-apps/<productId>_AllowanceKeys.json`) is keyed
 * by product id only, and it survives `logout` and re-pairing on purpose, to
 * save phone taps. So after the phone switches account, the cache still says
 * the smart-contract allowance was granted, while the new product account was
 * never claimed: no PGAS, never mapped. Login reported "already granted", the
 * mapping step failed, and following its hint (logout + login) looped forever.
 *
 * Each cached entry is therefore checked against the chain:
 *   - Bulletin: the slot authorization exists and has not expired.
 *   - Smart contracts: the account is mapped. The grant is what maps it (the
 *     phone's PGAS claim fires pallet-revive's AutoMapper), so an unmapped
 *     account means the cached grant belongs to someone else.
 *
 * Only the stale resources are returned, so a re-request asks for no more than
 * it needs. With the SDK's default `onExisting: "Ignore"`, a re-sent Bulletin
 * request returns the existing slot rather than allocating another one.
 */
export function resourcesToRequest(
    resources: readonly AllocatableResource[],
    state: AllowanceState,
): AllocatableResource[] {
    return resources.filter((resource, i) => {
        if (!state.cached[i]) return true;
        switch (resource.tag) {
            case "BulletInAllowance":
                return !state.bulletinUsable;
            case "SmartContractAllowance":
                return !state.accountMapped;
            default:
                return false;
        }
    });
}
