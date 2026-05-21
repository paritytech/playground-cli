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
 * Test account helpers for E2E tests.
 *
 * `SIGNER` is the account that pays substrate-side fees for the user-signed
 * extrinsic in every deploy: `registry.publish()`. It's a dedicated test-only
 * keypair derived from a hardcoded mnemonic — globalSetup tops it up to a
 * known balance from the production CLI's funder chain at the start of every
 * run, so the tests don't share fee state with //Alice (which gets drained by
 * anyone using the polkadot.js Apps dropdown) or with the production CLI's
 * own dedicated funder.
 *
 * BOB stays a dev account — the cross-ownership test only needs a *different*
 * signer than SIGNER, and Bob's deploy fails at the read-only availability
 * check (no fees needed) so its substrate balance doesn't matter.
 */

import { ss58Encode, deriveH160, type HexString } from "@parity/product-sdk-address";
import { getDevPublicKey, type DevAccountName } from "@parity/product-sdk-tx";
import { seedToAccount } from "@parity/product-sdk-keys";

export interface TestAccount {
	name: string;
	suri: string;
	address: string;
	h160: HexString;
}

function devAccount(name: DevAccountName): TestAccount {
	const publicKey = getDevPublicKey(name);
	return {
		name,
		suri: `//${name}`,
		address: ss58Encode(publicKey),
		h160: deriveH160(publicKey),
	};
}

/**
 * Hardcoded BIP-39 mnemonic for the E2E deployer account. Test-only:
 * globalSetup re-funds it from the CLI's funder chain at the start of every
 * run, so it doesn't matter that the seed is in plaintext — anyone who tries
 * to "drain" it just hands their PAS back to the next CI run when the
 * funder tops it up again.
 *
 * Phrase chosen as the canonical Substrate dev mnemonic; the `//e2e-deployer`
 * derivation produces an account distinct from //Alice/Bob/etc.
 */
export const DEDICATED_E2E_DEPLOYER_MNEMONIC =
	"bottom drive obey lake curtain smoke basket hold race lonely fit walk";

const E2E_DEPLOYER_DERIVATION = "//e2e-deployer";

function deployerAccount(): TestAccount {
	const account = seedToAccount(DEDICATED_E2E_DEPLOYER_MNEMONIC, E2E_DEPLOYER_DERIVATION);
	return {
		name: "e2e-deployer",
		suri: `${DEDICATED_E2E_DEPLOYER_MNEMONIC}${E2E_DEPLOYER_DERIVATION}`,
		address: ss58Encode(account.publicKey),
		h160: deriveH160(account.publicKey),
	};
}

export const SIGNER: TestAccount = deployerAccount();
export const ALICE: TestAccount = devAccount("Alice");
export const BOB: TestAccount = devAccount("Bob");

/**
 * Fixed `.dot` domain names for deploy tests. SIGNER owns all of these after
 * the first CI run; subsequent runs re-publish to the same domains, which the
 * registry contract permits for the same owner. This keeps the playground
 * registry from accumulating a new entry on every CI run.
 *
 * Use a separate domain per test that exercises a meaningfully different
 * publish path (storage / re-deploy / cross-owner collision); reuse a single
 * domain for the preflight / validation tests.
 *
 * DotNS classifies names with a base of ≥ 9 chars plus exactly two trailing
 * digits as NoStatus (no PoP required). Keep these labels in that shape so
 * the E2E deployer (NoStatus signer) can register them on any environment,
 * including paseo-next-v2 where setUserPopStatus is owner-gated and
 * self-attestation is not available.
 *
 * NOTE: do not assert on the registry state of `preflight` — it's shared by
 * six tests in the same file and the metadata at any moment reflects whichever
 * one ran last. Stdout assertions are fine. If you need to assert on registry
 * state for a new test, give it its own dedicated domain here.
 */
export const E2E_DOMAINS = {
	/**
	 * Shared by the validation tests in `dot deploy — preflight and validation`.
	 * `--no-build` only skips the build step, not the publish — so some of these
	 * tests do reach `registry.publish`. SIGNER ends up owning this domain
	 * regardless; subsequent runs are same-owner re-publishes.
	 */
	preflight: "e2eprefly00",
	/** Used by the storage-phase happy path. */
	storage: "e2estorag00",
	/** Used by the same-owner re-deploy test. */
	redeploy: "e2eredepl00",
	/** Used by the cross-owner collision test (BOB tries to take SIGNER's). */
	collision: "e2ecollis00",
	/**
	 * Phase 3 cell domains — registered by `tools/register-e2e-fixtures.ts`.
	 * Owned by SIGNER; subsequent runs are same-owner re-publishes.
	 * Not yet wired to any test — see Phase 4 of docs-internal/2026-05-02-e2e-test-suite-design.md.
	 */
	foundry: "e2efoundry00",
	cdm: "e2ecdmapp00",
	hardhat: "e2ehardhat00",
	multi: "e2emultip00",
	/**
	 * Phase 5e — `nightly-deploy-moddable` cell. Same-owner re-publishes
	 * across nightlies; each run pre-creates a fresh `paritytech/e2e-cli-
	 * moddable-<runId>` GH repo and the test points the deploy's `origin`
	 * at it. The on-chain registry entry's `metadata.repository` changes
	 * per run; the domain itself is fixed (NoStatus-compatible label so
	 * the NoStatus deployer can re-publish without PoP).
	 */
	moddable: "e2emoddab00",
	/**
	 * Used by the nightly-chaos-sigint cell only. The deploy is interrupted by
	 * SIGINT before it completes, so this domain is never actually registered.
	 * It is kept separate from `storage` to avoid any race with the happy-path
	 * storage test in test-publish when both run in a nightly that triggers all
	 * matrices.
	 */
	chaos: "e2echaosp00",
} as const;
