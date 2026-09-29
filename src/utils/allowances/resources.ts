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
 * CLI-local glue around `@parity/product-sdk-terminal/host`'s RFC-0010 types.
 * The wire call, slot-key caching (`~/.polkadot-apps/<appId>_AllowanceKeys.json`)
 * and slot signers all live in the SDK now — the only things kept here are the
 * playground's resource set and pure display helpers.
 */

import type { AllocatableResource, ApAllocationOutcome } from "@parity/product-sdk-terminal/host";
import { PLAYGROUND_PRODUCT_ID } from "../../config.js";

/**
 * Scope a terminal adapter to the PLAYGROUND PRODUCT for RFC-0010 allowance
 * calls. Every allowance entry point in the CLI must go through this wrapper —
 * never hand the raw `dot-cli` adapter to `requestResourceAllocation` /
 * `getCachedAllocation` / `ensureSlotAccountSigner` / `createSlotAccountSigner`.
 *
 * Why this is load-bearing: the SDK sends `callingProductId: adapter.appId` on
 * the wire, and the phone derives every per-product artifact from that id. For
 * `SmartContractAllowance` the phone MINTS PGAS ON-CHAIN to the soft-derived
 * `/product/<callingProductId>/<dest>` account (Android
 * `RealAccountsProtocol.allocate` -> `Pgas.claim_pgas{ target }`). With the raw
 * adapter id (`dot-cli`, the terminal's storage namespace) the 50-PGAS claim
 * landed on `dot-cli/0` — a real account, created + auto-mapped by the mint —
 * while the CLI signs, deploys, and checks mapping as `playground.dot/0`,
 * which stayed empty and unmapped (root-caused on paseo-next-v2, 2026-06-11:
 * `dot-cli/0` = 5CB4TWnRyoBe54... holds the PGAS + mapping that belonged to
 * `playground.dot/0` = 5CwUu5...). Scoping the adapter to the product id makes
 * the claim land on the account the CLI actually uses, which (PGAS being a
 * sufficient asset) also creates + auto-maps it — no dev funding needed.
 *
 * The SDK reads only `appId` + `storageDir` from the adapter in its host
 * helpers, and `createTerminalAdapter` returns a plain own-property object, so
 * a shallow spread view is safe. Side effect: the SDK's allowance cache moves
 * to `~/.polkadot-apps/playground.dot_AllowanceKeys.json` — semantically right
 * (RFC-0010 resources belong to products, not host binaries) and safe: the
 * old shared-`dot-cli`-cache interop with polkadot-app-deploy is explicitly
 * defused (we always inject explicit signer/storageSigner). Existing sessions
 * re-grant once on next login: the cache namespace moved, so both resources
 * re-request in the usual single approval dialog, and the phone re-claims PGAS
 * to the correct account.
 *
 * Mirrors the signing-side split the SDK already acknowledges:
 * `createSessionSignerForAccount` exists precisely for "a productId different
 * from the adapter's appId" — the allowance API just lacks the same override,
 * so we scope the adapter instead. Replace this wrapper with an explicit
 * `callingProductId` option if `@parity/product-sdk-terminal` ever grows one.
 */
export function productScopedAdapter<A extends { appId: string }>(adapter: A): A {
    return { ...adapter, appId: PLAYGROUND_PRODUCT_ID };
}

/**
 * The mobile-granted resource set the playground product actually consumes:
 * Bulletin storage (metadata + chunk uploads) and PGAS sponsoring for Revive
 * contract calls (derivation index 0 = the default playground account). Both
 * are requested in ONE `requestResourceAllocation` call so the user sees a
 * single approval dialog during `playground login`.
 *
 * `StatementStoreAllowance` is deliberately NOT requested. The CLI never
 * consumes a product Statement Store slot key: every phone interaction
 * (`session.createTransaction` / `signRaw` / `requestResourceAllocation`
 * itself) rides the SSO channel, whose prover is derived from the QR-login
 * `ssSecret` (`@novasamatech/host-papp`'s `createSsoStatementProver`), not
 * from a `StatementStoreAllowance` allocation. The product slot key is only
 * consumed by `papp.allowance.getStatementStoreProver`, an opt-in API the CLI
 * never calls; polkadot-app-deploy's storage path likewise reads only the Bulletin
 * slot key (we always inject explicit signer/storageSigner). Requesting it was
 * pure overhead AND a failure source: it is the one resource that needs the
 * phone to seat a slot in the scarce on-chain SSS ring, so for users whose ring
 * is full of still-unexpired slots the phone returns `NotAvailable`, which the
 * old code surfaced as a hard `denied: Statement Store` and aborted account
 * setup over a grant nothing uses.
 */
export const PLAYGROUND_RESOURCES: AllocatableResource[] = [
    { tag: "BulletInAllowance", value: undefined },
    // The destination is a TAGGED union (`Index` | `Raw`), not a bare number.
    // A bare `0` still reaches the phone and grants correctly, so the grant
    // looks fine — but the SDK sub-keys its allowance cache by destination
    // (`cacheKey` -> `smartContractDest`), and an untagged value falls through
    // to the `Raw` branch and hexes `undefined`. Every later cache read then
    // dies with `undefined is not an object (evaluating 'bytes.length')`,
    // which surfaces as `playground login` reporting "allowances ✕" on a
    // perfectly healthy account. Index 0 is the default product account.
    { tag: "SmartContractAllowance", value: { tag: "Index", value: 0 } },
];

export interface AllocationSummary {
    granted: AllocatableResource[];
    rejected: AllocatableResource[];
    unavailable: AllocatableResource[];
}

/**
 * Bucket allocation outcomes by tag. Order-sensitive: `outcomes[i]` maps to
 * `resources[i]`. Outcomes without a matching resource are silently dropped.
 */
export function summarizeOutcomes(
    outcomes: ApAllocationOutcome[],
    resources: AllocatableResource[],
): AllocationSummary {
    const granted: AllocatableResource[] = [];
    const rejected: AllocatableResource[] = [];
    const unavailable: AllocatableResource[] = [];
    outcomes.forEach((outcome, i) => {
        const resource = resources[i];
        if (!resource) return;
        if (outcome.tag === "Allocated") granted.push(resource);
        else if (outcome.tag === "Rejected") rejected.push(resource);
        else unavailable.push(resource);
    });
    return { granted, rejected, unavailable };
}

/** Human-readable name for a resource tag, used in failure messages. */
export function describeResource(resource: AllocatableResource): string {
    switch (resource.tag) {
        case "BulletInAllowance":
            return "Bulletin storage";
        case "StatementStoreAllowance":
            return "Statement Store";
        case "SmartContractAllowance":
            return `smart-contract gas (idx ${resource.value})`;
        case "AutoSigning":
            return "auto-signing";
    }
}

/**
 * Compose the user-facing failure line for an allocation summary, or null when
 * every requested resource was granted.
 *
 * `Rejected` and `NotAvailable` need DIFFERENT remedies and must not be
 * conflated (the old code surfaced both as one "denied ... approve on your
 * phone" line). `Rejected` is a user decline on the phone, so re-running and
 * approving genuinely fixes it. `NotAvailable` means the wallet could not
 * provision the resource at all: an out-of-date mobile build that does not
 * implement the grant (the way AutoSigning returns NotAvailable on every
 * current wallet), or a full on-chain slot ring. "Approve on your phone" is a
 * dead end there, because the dialog never offers the resource; the real fix is
 * updating the app. Each bucket gets its own sentence so the printed guidance
 * is actionable for whichever outcome occurred.
 */
export function describeAllocationFailure(summary: AllocationSummary): string | null {
    const parts: string[] = [];
    if (summary.rejected.length > 0) {
        const names = summary.rejected.map(describeResource).join(", ");
        parts.push(`declined: ${names}. Re-run \`playground login\` and approve on your phone.`);
    }
    if (summary.unavailable.length > 0) {
        const names = summary.unavailable.map(describeResource).join(", ");
        const noun = summary.unavailable.length > 1 ? "these allowances" : "this allowance";
        parts.push(
            `unavailable: ${names}. Your Polkadot mobile app could not grant ${noun}. ` +
                "Make sure you're on the latest version of the app, then re-run `playground login`.",
        );
    }
    return parts.length > 0 ? parts.join(" ") : null;
}
