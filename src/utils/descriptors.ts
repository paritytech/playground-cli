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

import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import { paseo_bulletin } from "@parity/product-sdk-descriptors/paseo-bulletin";
import { paseo_individuality } from "@parity/product-sdk-descriptors/paseo-individuality";
import type { Env } from "../config.js";

export type AssetHubDescriptor = typeof paseo_asset_hub;
export type BulletinDescriptor = typeof paseo_bulletin;
export type IndividualityDescriptor = typeof paseo_individuality;

/**
 * Descriptor selection.
 *
 * `@parity/product-sdk-descriptors@0.8.0` dropped the `summit-*` descriptor
 * subpaths upstream — only the paseo-next-v2 (`paseo-*`) descriptors ship today.
 * Direct PAPI reads touch common pallets only (System, Revive,
 * TransactionStorage), which are identical across the wired chains, so every env
 * resolves to the paseo descriptor shape — the same effect as the previous
 * cast-through-`unknown` selectors, minus the (now non-existent) summit branch.
 * The `env` parameter is retained for call-site compatibility and so per-env
 * selection can be restored here the moment another env regains dedicated
 * descriptors.
 */
export function getAssetHubDescriptor(_env: Env | undefined): AssetHubDescriptor {
    return paseo_asset_hub;
}

export function getBulletinDescriptor(_env: Env | undefined): BulletinDescriptor {
    return paseo_bulletin;
}

export function getIndividualityDescriptor(_env: Env | undefined): IndividualityDescriptor {
    return paseo_individuality;
}
