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

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock polkadot-app-deploy's DotNS class. As of 0.7.6, label classification is
// done by a top-level `classifyDotnsLabel` that the package doesn't re-export
// from its root, so `availability.ts` mirrors the (small, stable) logic
// locally as `classifyLabel`. Tests below rely on real label characteristics
// to drive each classification branch — no `classifyName` mock anymore.
//
// Ownership check is driven by the caller's H160 (derived from SS58 via
// `@parity/product-sdk-address::ss58ToH160`), so the mock reflects the full
// `{ owned, owner }` shape. Classification is local + pure (no PoP RPC), so
// there is no `getUserPopStatus`/`isTestnet` to mock.
const checkOwnership = vi.fn();
const connect = vi.fn(async () => {});
const disconnect = vi.fn();

// Use a regular `function` (not an arrow) for the implementation: since
// vitest 4 spies forward `new.target`, `new DotNS()` invokes the
// implementation as a constructor, and arrow functions can't be constructed.
// A function that returns an object has that object override `this`.
vi.mock("bulletin-deploy", () => ({
    DotNS: vi.fn(function () {
        return {
            connect,
            checkOwnership,
            disconnect,
        };
    }),
}));

// A realistic dev SS58 → H160 pair so the tests exercise the real derivation.
// We use Alice's substrate address; its H160 is deterministic.
const ALICE_SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

// Label-classification reference (mirror of the canonical dotns rules):
//   - trailingDigits > 2          → Reserved
//   - baseLength <= 5             → Reserved
//   - baseLength 6-8, td === 2    → PoP Lite
//   - baseLength 6-8, td !== 2    → PoP Full
//   - baseLength >= 9, td === 2   → NoStatus
//   - baseLength >= 9, td !== 2   → NoStatus
//
// Labels picked below to land in each branch deterministically.
const NO_STATUS_LABEL = "my-app-test01"; // baseLength=11, td=2 → NoStatus
const POP_LITE_LABEL = "myappz12"; // baseLength=6, td=2 → Lite
const POP_FULL_8CHAR_LABEL = "myapptst"; // baseLength=8, td=0 → Full
const POP_FULL_LONG_LABEL = "my-cool-app"; // baseLength=11, td=0 → NoStatus
const RESERVED_SHORT_LABEL = "abc"; // baseLength=3 → Reserved

import { checkDomainAvailability, formatAvailability } from "./availability.js";

beforeEach(() => {
    checkOwnership.mockReset();
    connect.mockReset();
    connect.mockResolvedValue(undefined);
    disconnect.mockReset();
});

describe("checkDomainAvailability", () => {
    it("returns 'available' when classification is NoStatus", async () => {
        const result = await checkDomainAvailability(NO_STATUS_LABEL);
        // No ownerSs58Address passed → we can't check user's current PoP, so
        // we default the plan to the common path (register + no PoP upgrade).
        // The signing counter's clamp-up behavior fixes the summary at
        // runtime if we under-estimated.
        expect(result).toEqual({
            status: "available",
            label: NO_STATUS_LABEL,
            // Default env is paseo-next-v2, whose DotNS TLD is "paseo".
            fullDomain: `${NO_STATUS_LABEL}.paseo`,
            plan: { action: "register" },
        });
    });

    it("accepts the env TLD suffix and rejects a wrong-TLD one before the network", async () => {
        const suffixed = await checkDomainAvailability(`${NO_STATUS_LABEL}.paseo`);
        expect(suffixed.status).toBe("available");
        if (suffixed.status === "available") {
            expect(suffixed.fullDomain).toBe(`${NO_STATUS_LABEL}.paseo`);
        }
        connect.mockClear();
        await expect(checkDomainAvailability(`${NO_STATUS_LABEL}.dot`)).rejects.toThrow(
            /uses "\.paseo" names/,
        );
        expect(connect).not.toHaveBeenCalled();
    });

    it("returns 'reserved' when the base name is <=5 chars (governance-reserved)", async () => {
        const result = await checkDomainAvailability(RESERVED_SHORT_LABEL);
        expect(result.status).toBe("reserved");
        if (result.status === "reserved") {
            expect(result.message).toMatch(/governance/i);
        }
    });

    it("re-deploys: 'owned by you' returns available with an update note", async () => {
        // Regression: previously the availability check used the default dev
        // mnemonic's h160 as the comparison, so a domain owned by the user's
        // OWN phone signer came back as `owned: false, owner: <user h160>`
        // and we mis-classified it as `taken`, blocking every re-deploy.
        // Fix: derive the caller's H160 via `ss58ToH160` and pass it to
        // `checkOwnership`; "owned by the caller" becomes an update path.
        // DotNS computes owned = owner.toLowerCase() === checkAddress.toLowerCase().
        // The mock echoes the caller's h160 as "owner" so `owned = true`.
        checkOwnership.mockImplementation(async (_label: string, checkAddress: string) => ({
            owned: true,
            owner: checkAddress,
        }));

        const result = await checkDomainAvailability(POP_FULL_LONG_LABEL, {
            ownerSs58Address: ALICE_SS58,
        });
        expect(result.status).toBe("available");
        if (result.status === "available") {
            expect(result.note).toMatch(/Already owned by you/i);
        }

        // Lock in that the H160 we pass to DotNS really is derived from the
        // SS58 we provided. Without this, the mock would silently accept any
        // string and a broken `ss58ToH160` regression would go undetected.
        expect(checkOwnership).toHaveBeenCalledTimes(1);
        const [, passedH160] = checkOwnership.mock.calls[0];
        expect(passedH160).toMatch(/^0x[0-9a-f]{40}$/);
        expect(passedH160).not.toBe("0x0000000000000000000000000000000000000000");
    });

    it("returns 'taken' when the domain is owned by a different H160", async () => {
        const otherOwner = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        checkOwnership.mockImplementation(async () => ({ owned: false, owner: otherOwner }));

        const result = await checkDomainAvailability(POP_FULL_LONG_LABEL, {
            ownerSs58Address: ALICE_SS58,
        });
        expect(result.status).toBe("taken");
        if (result.status === "taken") expect(result.owner).toBe(otherOwner);
    });

    it("skips the ownership check when no SS58 address is provided", async () => {
        // Dev mode without a session signer: we can't do a meaningful
        // comparison, so we don't call checkOwnership at all and let
        // polkadot-app-deploy's own preflight handle it with the real signer.
        const result = await checkDomainAvailability(NO_STATUS_LABEL);
        expect(result.status).toBe("available");
        expect(checkOwnership).not.toHaveBeenCalled();
    });

    it("treats PoP Lite / Full requirements as available-with-note, not blockers", async () => {
        const lite = await checkDomainAvailability(POP_LITE_LABEL);
        expect(lite.status).toBe("available");
        if (lite.status === "available") {
            expect(lite.note).toMatch(/Lite/);
            expect(lite.note).toMatch(/verified/i);
            expect(lite.note).not.toMatch(/automatically/i);
        }

        const full = await checkDomainAvailability(POP_FULL_8CHAR_LABEL);
        expect(full.status).toBe("available");
        if (full.status === "available") {
            expect(full.note).toMatch(/Full/);
            expect(full.note).not.toMatch(/automatically/i);
        }
    });

    it("re-deploy: plan is { action: 'update' } — only setContenthash fires", async () => {
        checkOwnership.mockImplementation(async (_label: string, checkAddress: string) => ({
            owned: true,
            owner: checkAddress,
        }));

        const result = await checkDomainAvailability(POP_FULL_LONG_LABEL, {
            ownerSs58Address: ALICE_SS58,
        });
        if (result.status === "available") {
            expect(result.plan).toEqual({ action: "update" });
        }
    });

    it("returns 'unknown' and disconnects when the DotNS connect call throws", async () => {
        // Connect failure is the realistic RPC-down signal now that
        // classification is local + pure.
        connect.mockRejectedValueOnce(new Error("RPC down"));

        const result = await checkDomainAvailability(NO_STATUS_LABEL);
        expect(result.status).toBe("unknown");
        if (result.status === "unknown") expect(result.message).toMatch(/RPC down/);
        expect(disconnect).toHaveBeenCalled();
    });

    it("rejects invalid domain syntax before touching the network", async () => {
        await expect(checkDomainAvailability("NOT valid!")).rejects.toThrow(/Invalid domain/);
        // A >2-digit suffix is a syntax error caught by normalizeDomain
        // BEFORE classification, so it never reaches the network either.
        await expect(checkDomainAvailability("polkadot12345")).rejects.toThrow(/two digits/i);
        expect(connect).not.toHaveBeenCalled();
    });
});

describe("formatAvailability", () => {
    it("renders a friendly sentence for each result kind", () => {
        const freshRegisterPlan = { action: "register" as const };
        expect(
            formatAvailability({
                status: "available",
                label: "x",
                fullDomain: "x.dot",
                plan: freshRegisterPlan,
            }),
        ).toBe("x.dot is available");
        expect(
            formatAvailability({
                status: "reserved",
                label: "polkadot",
                fullDomain: "polkadot.dot",
                message: "Reserved for Governance",
            }),
        ).toMatch(/reserved/);
        expect(
            formatAvailability({
                status: "available",
                label: "x",
                fullDomain: "x.dot",
                note: "Requires Lite Proof of Personhood",
                plan: freshRegisterPlan,
            }),
        ).toMatch(/Lite Proof of Personhood/);
        expect(
            formatAvailability({
                status: "taken",
                label: "x",
                fullDomain: "x.dot",
                owner: "0xabc",
            }),
        ).toMatch(/already registered by 0xabc/);
        expect(
            formatAvailability({
                status: "unknown",
                label: "x",
                fullDomain: "x.dot",
                message: "RPC down",
            }),
        ).toMatch(/Could not verify/);
    });
});
