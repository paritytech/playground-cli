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
 * Vitest globalSetup — runs once before all E2E tests.
 *
 * 1. Top up the deployer (SIGNER) if its substrate balance is low
 * 2. Verify test template exists in registry (if configured)
 * 3. Log test accounts
 */

import { destroyTestClient, getTestClient } from "../helpers/chain.js";
import { ensureAllowance } from "../../../src/utils/account/allowance.js";
import { fundDeployerIfLow } from "./fund.js";
import { ensureTemplateRegistered } from "../fixtures/registry.js";
import { SIGNER, BOB } from "../fixtures/accounts.js";

export async function setup() {
	console.log("[e2e setup] Playground CLI E2E test suite starting…");
	console.log(`[e2e setup] SIGNER (${SIGNER.name}): ${SIGNER.address} (h160 ${SIGNER.h160})`);
	console.log(`[e2e setup] BOB:    ${BOB.address}`);

	// Funding SIGNER is mandatory — every deploy/mod test signs with it,
	// and if it runs out of PAS the failures surface as cryptic
	// "Invalid Payment" extrinsic errors deep inside individual tests.
	// Fail the whole suite up front instead, with a clear message.
	//
	// To run only the offline-eligible tests (install, build, --help-style
	// login checks) without chain connectivity, set E2E_ALLOW_OFFLINE_SETUP=1
	// — this is for local development on a flaky network, never CI.
	const allowOffline = process.env.E2E_ALLOW_OFFLINE_SETUP === "1";
	try {
		await fundDeployerIfLow();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (allowOffline) {
			console.warn(
				`[e2e setup] Funder unreachable (E2E_ALLOW_OFFLINE_SETUP=1 set, ` +
				`continuing): ${msg}`,
			);
		} else {
			throw new Error(
				`[e2e setup] Failed to fund SIGNER ${SIGNER.address} from the ` +
				`production funder chain. All deploy and mod tests will fail ` +
				`downstream with confusing extrinsic errors. Fix the funder or ` +
				`set E2E_ALLOW_OFFLINE_SETUP=1 to skip chain-dependent tests.\n\n` +
				`Underlying error: ${msg}`,
			);
		}
	}

	// SIGNER also signs the Bulletin metadata `store` for template registration
	// and dev-mode deploys. Native PAS is not enough: with no Bulletin
	// authorization the store is rejected as `Invalid.Payment` even at a huge
	// balance. Soft-fail so a Bulletin hiccup only degrades the tests that use it.
	try {
		await ensureAllowance(await getTestClient(), SIGNER.address);
	} catch (err) {
		console.warn(`[e2e setup] Bulletin allowance check failed: ${err}`);
	}

	// Template registration is only consumed by one test (`dot mod` happy
	// path), which uses `.skipIf(!TEST_DOMAIN)`. A failure here doesn't
	// block the rest of the suite — log and continue.
	try {
		await ensureTemplateRegistered();
	} catch (err) {
		console.warn(`[e2e setup] Template registration check failed: ${err}`);
	}
}

export async function teardown() {
	try {
		destroyTestClient();
	} catch {
		// The WebSocket may already be torn down (heartbeat timeout, DisjointError).
		// Best-effort cleanup — nothing to do if it's already gone.
	}
}
