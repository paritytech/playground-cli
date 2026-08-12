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
 * Pin the equivalence between (a) what `signerMode.ts` actually
 * synthesises for dev-mode playground publish, (b) polkadot-app-deploy's
 * `DEFAULT_MNEMONIC` bare-root account, and (c) the well-known canonical
 * SS58 for that account. This is load-bearing: polkadot-app-deploy uses the
 * bare-mnemonic root for storage + DotNS when no explicit signer is
 * provided, so the CLI must sign the registry publish with the SAME
 * account to keep `is_authorized_to_republish`, the DotNS name owner,
 * and the registry publisher coherent across iterations.
 *
 * The test fails closed in three independent ways:
 *   - upstream `polkadot-app-deploy` changes its default mnemonic
 *   - the CLI swaps `seedToAccount(DEFAULT_MNEMONIC, "")` for something
 *     else (e.g. `createDevSigner("Alice")`, which would be `//Alice`)
 *   - the canonical literal changes (it shouldn't — pinning the literal
 *     guards against silent equivalence drift in the SDK)
 *
 * Historical footgun: `createDevSigner("Alice")` from
 * `@parity/product-sdk-tx` uses `//Alice` derivation (`5Grwva…`). That
 * is a DIFFERENT account from polkadot-app-deploy's bare-mnemonic root
 * (`5DfhGyQd…`). The first version of this code mixed the two; this
 * test exists so the mistake can't recur silently.
 */

import { describe, it, expect } from "vitest";
import { ss58Encode } from "@parity/product-sdk-address";
import { seedToAccount } from "@parity/product-sdk-keys";
import { DEFAULT_MNEMONIC } from "bulletin-deploy";
import { DEV_PUBLISH_ADDRESS } from "./signerMode.js";

// The canonical SS58 of polkadot-app-deploy's `DEFAULT_MNEMONIC` bare-root
// account. Hard-coded here so a future SDK refactor that silently moves
// `seedToAccount(mnemonic, "")` to a different derivation path is
// caught at CI time. NOT the same as Substrate's `//Alice`
// (`5GrwvaEF…`).
const EXPECTED_DEV_PUBLISH_SS58 = "5DfhGyQdFobKM8NsWvEeAKk5EQQgYe9AydgJ7rMB6E1EqRzV";

describe("dev-mode publish signer identity", () => {
    it("signerMode.ts publishes as polkadot-app-deploy's DEFAULT_MNEMONIC bare-root account", () => {
        // The headline guarantee: signerMode's synthesised dev signer
        // address matches what polkadot-app-deploy uses for storage + DotNS.
        // If a future change swaps `createDevPublishSigner` to
        // `createDevSigner("Alice")` (= `//Alice` = `5Grwva…`), this
        // assertion fails. The previous-version of this test only
        // compared two `polkadot-app-deploy` constants against each other —
        // it would have stayed green through that regression.
        expect(DEV_PUBLISH_ADDRESS).toBe(EXPECTED_DEV_PUBLISH_SS58);
    });

    it("DEFAULT_MNEMONIC bare-root has the expected canonical SS58", () => {
        // Upstream-equivalence pin. If `polkadot-app-deploy` swaps its
        // default mnemonic for any reason, this test surfaces the
        // change before we ship a broken dev flow. `seedToAccount(_, "")`
        // is the exact derivation `createDevPublishSigner` uses,
        // so verifying it here ALSO covers the SDK side of the
        // equivalence (a future product-sdk-keys release that changes
        // "no derivation" semantics would fail this).
        const bareRoot = ss58Encode(seedToAccount(DEFAULT_MNEMONIC, "").publicKey);
        expect(bareRoot).toBe(EXPECTED_DEV_PUBLISH_SS58);
    });

    it("DEFAULT_MNEMONIC is the canonical dev-test seed phrase", () => {
        // Belt-and-braces: if polkadot-app-deploy ever switches its default
        // to a project-specific dev key (or any other mnemonic), revisit
        // CLAUDE.md's Deploy/Bulletin claim about "synthesised dev
        // signer" before this test is allowed to pass with a new value.
        expect(DEFAULT_MNEMONIC).toBe(
            "bottom drive obey lake curtain smoke basket hold race lonely fit walk",
        );
    });
});
