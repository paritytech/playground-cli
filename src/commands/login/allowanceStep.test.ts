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

import { describe, expect, it } from "vitest";
import { PLAYGROUND_RESOURCES } from "../../utils/allowances/resources.js";
import { resourcesToRequest } from "./allowanceStep.js";

const tags = (state: Parameters<typeof resourcesToRequest>[1]) =>
    resourcesToRequest(PLAYGROUND_RESOURCES, state).map((r) => r.tag);

describe("resourcesToRequest", () => {
    it("asks for nothing when both grants are cached and verified on chain", () => {
        expect(tags({ cached: [true, true], bulletinUsable: true, accountMapped: true })).toEqual(
            [],
        );
    });

    /**
     * The bug: after the phone switched account, the product-id-keyed cache
     * still held the previous account's smart-contract grant. The new account
     * was never claimed or mapped, login said "already granted", and the
     * mapping step's logout + login hint looped forever.
     */
    it("re-requests a cached smart-contract grant when the account is not mapped", () => {
        expect(tags({ cached: [true, true], bulletinUsable: true, accountMapped: false })).toEqual([
            "SmartContractAllowance",
        ]);
    });

    it("re-requests a cached Bulletin slot that is no longer authorized", () => {
        expect(tags({ cached: [true, true], bulletinUsable: false, accountMapped: true })).toEqual([
            "BulletInAllowance",
        ]);
    });

    it("re-requests both when neither cached grant checks out", () => {
        expect(tags({ cached: [true, true], bulletinUsable: false, accountMapped: false })).toEqual(
            ["BulletInAllowance", "SmartContractAllowance"],
        );
    });

    it("requests everything that is not cached, whatever the chain says", () => {
        expect(tags({ cached: [false, false], bulletinUsable: true, accountMapped: true })).toEqual(
            ["BulletInAllowance", "SmartContractAllowance"],
        );
        expect(tags({ cached: [false, true], bulletinUsable: true, accountMapped: true })).toEqual([
            "BulletInAllowance",
        ]);
        expect(tags({ cached: [true, false], bulletinUsable: true, accountMapped: true })).toEqual([
            "SmartContractAllowance",
        ]);
    });

    it("keeps the request in the resource list's order", () => {
        const requested = resourcesToRequest(PLAYGROUND_RESOURCES, {
            cached: [false, false],
            bulletinUsable: false,
            accountMapped: false,
        });
        expect(requested).toEqual(PLAYGROUND_RESOURCES);
    });
});
