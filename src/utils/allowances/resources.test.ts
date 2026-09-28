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

import type { ApAllocationOutcome } from "@parity/product-sdk-terminal/host";
import { describe, expect, test } from "vitest";
import {
    PLAYGROUND_RESOURCES,
    describeAllocationFailure,
    describeResource,
    summarizeOutcomes,
} from "./resources.js";

// `ApAllocationOutcome`'s `Allocated.value` is the materialized resource
// payload (not `undefined`), so we build minimal valid literals. Only the
// `tag` matters to `summarizeOutcomes`; the inner payload is never read.
const allocated: ApAllocationOutcome = {
    tag: "Allocated",
    value: { tag: "BulletInAllowance", value: { slotAccountKey: new Uint8Array(32) } },
};
const rejected: ApAllocationOutcome = { tag: "Rejected", value: undefined };
const notAvailable: ApAllocationOutcome = { tag: "NotAvailable", value: undefined };

describe("PLAYGROUND_RESOURCES", () => {
    test("requests only the resources the CLI consumes: Bulletin, SmartContract(0)", () => {
        // StatementStoreAllowance is intentionally absent — the CLI never
        // consumes a product Statement Store slot key (see resources.ts), and
        // requesting it blocked `playground login` for users whose on-chain SSS
        // ring was full (phone returns NotAvailable).
        expect(PLAYGROUND_RESOURCES.map((r) => r.tag)).toEqual([
            "BulletInAllowance",
            "SmartContractAllowance",
        ]);
        // The destination must be the TAGGED form. A bare `0` grants fine on
        // the phone, so the failure is invisible at grant time — but the SDK
        // sub-keys its allowance cache by destination, and an untagged value
        // takes the `Raw` branch and hexes `undefined`, so every later read
        // throws `undefined is not an object (evaluating 'bytes.length')` and
        // `playground login` reports "allowances ✕" on a healthy account.
        // `tsc` DOES reject the bare number, so this test is belt-and-braces
        // rather than the only guard — but run tsc directly, not through
        // `pnpm exec`: if pnpm's deps-status check fails first (e.g. the
        // release-age policy), it exits before tsc runs and an unwary grep for
        // "error TS" reports a clean typecheck that never happened.
        const sc = PLAYGROUND_RESOURCES.find((r) => r.tag === "SmartContractAllowance");
        expect(sc?.value).toEqual({ tag: "Index", value: 0 });
    });
});

describe("summarizeOutcomes", () => {
    test("buckets outcomes by tag, order-sensitive", () => {
        // Explicit resource list so this stays independent of PLAYGROUND_RESOURCES.
        const resources: typeof PLAYGROUND_RESOURCES = [
            { tag: "BulletInAllowance", value: undefined },
            { tag: "StatementStoreAllowance", value: undefined },
            { tag: "SmartContractAllowance", value: { tag: "Index", value: 0 } },
        ];
        const summary = summarizeOutcomes([allocated, rejected, notAvailable], resources);
        expect(summary.granted.map((r) => r.tag)).toEqual(["BulletInAllowance"]);
        expect(summary.rejected.map((r) => r.tag)).toEqual(["StatementStoreAllowance"]);
        expect(summary.unavailable.map((r) => r.tag)).toEqual(["SmartContractAllowance"]);
    });

    test("drops outcomes without a matching resource", () => {
        const summary = summarizeOutcomes([allocated, allocated], [PLAYGROUND_RESOURCES[0]]);
        expect(summary.granted).toHaveLength(1);
    });
});

describe("describeResource", () => {
    test("human labels", () => {
        expect(describeResource({ tag: "BulletInAllowance", value: undefined })).toMatch(
            /bulletin/i,
        );
    });
});

describe("describeAllocationFailure", () => {
    const bulletin: typeof PLAYGROUND_RESOURCES = [{ tag: "BulletInAllowance", value: undefined }];
    const sc: typeof PLAYGROUND_RESOURCES = [
        { tag: "SmartContractAllowance", value: { tag: "Index", value: 0 } },
    ];

    test("returns null when nothing failed", () => {
        const summary = summarizeOutcomes([allocated], bulletin);
        expect(describeAllocationFailure(summary)).toBeNull();
    });

    test("Rejected gets the approve-on-phone remedy, not the update-app one", () => {
        const summary = summarizeOutcomes([rejected], bulletin);
        const message = describeAllocationFailure(summary);
        expect(message).toMatch(/declined: Bulletin storage/);
        expect(message).toMatch(/approve on your phone/);
        // Guard against the unavailable remedy leaking into the declined
        // message: assert on the phrase the unavailable branch actually emits.
        expect(message).not.toMatch(/latest version of the app/);
    });

    test("singular vs plural noun agrees with the unavailable count", () => {
        const single = describeAllocationFailure(summarizeOutcomes([notAvailable], bulletin));
        expect(single).toMatch(/grant this allowance/);
        expect(single).not.toMatch(/these allowances/);

        const resources: typeof PLAYGROUND_RESOURCES = [...bulletin, ...sc];
        const both = describeAllocationFailure(
            summarizeOutcomes([notAvailable, notAvailable], resources),
        );
        expect(both).toMatch(/grant these allowances/);
        expect(both).not.toMatch(/this allowance/);
    });

    test("NotAvailable gets the update-app remedy, not the approve-on-phone one", () => {
        // The reported bug: a wallet that can't provision Bulletin returns
        // NotAvailable, and "re-run and approve" is a dead end. The guidance
        // must point at updating the mobile app instead.
        const summary = summarizeOutcomes([notAvailable], bulletin);
        const message = describeAllocationFailure(summary);
        expect(message).toMatch(/unavailable: Bulletin storage/);
        expect(message).toMatch(/latest version of the app/);
        expect(message).not.toMatch(/approve on your phone/);
    });

    test("a mix of Rejected and NotAvailable surfaces both remedies", () => {
        const resources: typeof PLAYGROUND_RESOURCES = [...bulletin, ...sc];
        const summary = summarizeOutcomes([notAvailable, rejected], resources);
        const message = describeAllocationFailure(summary);
        expect(message).toMatch(/unavailable: Bulletin storage/);
        expect(message).toMatch(/declined: smart-contract gas/);
        expect(message).toMatch(/latest version of the app/);
        expect(message).toMatch(/approve on your phone/);
    });
});
