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

import {
    getCachedAllocation,
    requestResourceAllocation,
    type AllocatableResource,
} from "@parity/product-sdk-terminal/host";
import type { ResolvedSigner } from "../signer.js";
import { productScopedAdapter } from "./resources.js";

const SMART_CONTRACT_ALLOWANCE: AllocatableResource = {
    tag: "SmartContractAllowance",
    // Tagged destination, not a bare number — see PLAYGROUND_RESOURCES in
    // resources.ts for what an untagged value breaks in the SDK's cache.
    value: { tag: "Index", value: 0 },
};

export interface SmartContractAllowanceOptions {
    deploySigner: ResolvedSigner;
}

/**
 * Make sure the session has a PGAS smart-contract allowance for the default
 * playground product account. The SDK cache entry doubles as the grant
 * marker — it's only written after the wallet returns `Allocated`.
 */
export async function ensureSmartContractAllowance({
    deploySigner,
}: SmartContractAllowanceOptions): Promise<void> {
    if (deploySigner.source === "dev") return;

    const { userSession, adapter: rawAdapter } = deploySigner;
    if (!userSession || !rawAdapter) {
        throw new Error(
            'No smart-contract gas allowance available. Run "playground login" to grant allowances.',
        );
    }
    // Product-scoped on purpose: the wire `callingProductId` is what the phone
    // derives the PGAS claim TARGET from — see `productScopedAdapter`.
    const adapter = productScopedAdapter(rawAdapter);

    if (await getCachedAllocation(adapter, SMART_CONTRACT_ALLOWANCE)) return;

    const outcomes = await requestResourceAllocation(userSession, adapter, [
        SMART_CONTRACT_ALLOWANCE,
    ]);
    const outcome = outcomes[0];
    if (outcome?.tag === "Allocated") return;

    throw new Error(
        `Smart-contract gas allowance allocation ${outcome?.tag ?? "returned no outcome"}. Re-run \`playground login\` and approve on your phone.`,
    );
}
