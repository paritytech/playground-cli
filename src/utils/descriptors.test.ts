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

// Direct coverage of the env → descriptor selectors.
//
// `@parity/product-sdk-descriptors@0.8.0` dropped the `summit-*` descriptor
// subpaths upstream, so the selectors no longer branch: every env resolves to
// the paseo descriptor (direct reads touch common pallets only). These cases
// assert that uniformity explicitly — across the active env, an arbitrary other
// wired-in-`ENV_IDS` env, and `undefined` — independent of `ACTIVE_TESTNET_ENV`.

import { describe, expect, it, vi } from "vitest";

// Identity-tagged stand-ins so the assertions can prove WHICH descriptor object
// each selector returns without importing the real (heavy) descriptors.
vi.mock("@parity/product-sdk-descriptors/paseo-asset-hub", () => ({
    paseo_asset_hub: { genesis: "0xpaseo-asset" },
}));
vi.mock("@parity/product-sdk-descriptors/paseo-bulletin", () => ({
    paseo_bulletin: { genesis: "0xpaseo-bulletin" },
}));
vi.mock("@parity/product-sdk-descriptors/paseo-individuality", () => ({
    paseo_individuality: { genesis: "0xpaseo-people" },
}));

import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import { paseo_bulletin } from "@parity/product-sdk-descriptors/paseo-bulletin";
import { paseo_individuality } from "@parity/product-sdk-descriptors/paseo-individuality";
import {
    getAssetHubDescriptor,
    getBulletinDescriptor,
    getIndividualityDescriptor,
} from "./descriptors.js";

describe("getAssetHubDescriptor", () => {
    it("returns the paseo descriptor for every env", () => {
        expect(getAssetHubDescriptor("paseo-next-v2")).toBe(paseo_asset_hub);
        expect(getAssetHubDescriptor("polkadot")).toBe(paseo_asset_hub);
        expect(getAssetHubDescriptor(undefined)).toBe(paseo_asset_hub);
    });
});

describe("getBulletinDescriptor", () => {
    it("returns the paseo descriptor for every env", () => {
        expect(getBulletinDescriptor("paseo-next-v2")).toBe(paseo_bulletin);
        expect(getBulletinDescriptor("polkadot")).toBe(paseo_bulletin);
        expect(getBulletinDescriptor(undefined)).toBe(paseo_bulletin);
    });
});

describe("getIndividualityDescriptor", () => {
    it("returns the paseo descriptor for every env", () => {
        expect(getIndividualityDescriptor("paseo-next-v2")).toBe(paseo_individuality);
        expect(getIndividualityDescriptor("polkadot")).toBe(paseo_individuality);
        expect(getIndividualityDescriptor(undefined)).toBe(paseo_individuality);
    });
});
