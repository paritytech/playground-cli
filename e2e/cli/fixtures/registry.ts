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
 * Registry contract query helpers for E2E tests.
 *
 * Queries the on-chain playground registry to verify deploy outcomes.
 */

import { getTestClient } from "../helpers/chain.js";
import {
	getReadOnlyRegistryContract,
	queryMetadataUri,
	type MetadataUriRegistry,
} from "../../../src/utils/registry.js";
import { resolveSigner } from "../../../src/utils/signer.js";
import { publishToPlayground } from "../../../src/utils/deploy/playground.js";
import { SIGNER } from "./accounts.js";

export interface AppEntry {
	domain: string;
	owner: string;
	metadataUri: string;
}

type Registry = Awaited<ReturnType<typeof getReadOnlyRegistryContract>>;

let registryPromise: Promise<Registry> | null = null;

async function getRegistry(): Promise<Registry> {
	if (!registryPromise) {
		registryPromise = (async () => {
			const client = await getTestClient();
			// Registry-only resolution: these fixtures never touch the
			// identity spine, so don't couple them to its availability.
			return getReadOnlyRegistryContract(client.raw.assetHub);
		})().catch((err) => {
			// Reset so the next call can retry instead of replaying the error
			registryPromise = null;
			throw err;
		});
	}
	return registryPromise;
}

/**
 * Query the registry for an app entry by domain.
 * Returns null if not found (queryMetadataUri owns the ""-sentinel decode;
 * dry-run failures collapse to null here — fixtures treat them as "absent").
 */
export async function getApp(domain: string): Promise<AppEntry | null> {
	try {
		const registry = await getRegistry();
		// Cast = the codegen seam: this tree typechecks without the gitignored
		// .cdm augmentation, where the handle is the un-augmented
		// Contract<ContractDef> (see MetadataUriRegistry's doc comment).
		const metadataUri = await queryMetadataUri(
			registry as unknown as MetadataUriRegistry,
			domain,
		);
		if (!metadataUri) return null;
		return { domain, owner: "", metadataUri };
	} catch {
		return null;
	}
}

/**
 * Query the on-chain `owner` H160 for a published domain. Used by tests
 * that need to assert the registry recorded the right owner — distinct
 * from "who signed the tx", which matters for the dev-mode claimed-owner
 * flow (Alice signs, user's H160 is owner).
 *
 * Returns `null` if the domain isn't published, otherwise the lowercase
 * 0x-prefixed 20-byte address. The contract returns the zero address for
 * missing entries; we normalise that to `null` so callers don't have to
 * special-case it.
 */
export async function getOwnerH160(domain: string): Promise<string | null> {
	const registry = await getRegistry();
	const res = await registry.getOwner.query(domain);
	if (!res.success) return null;
	const owner = String(res.value).toLowerCase();
	const zero = "0x" + "0".repeat(40);
	return owner === zero ? null : owner;
}

/**
 * Get the count of apps owned by an H160. Mirrors what playground-app's
 * MyApps view uses (`registry.getOwnerAppCount(account.h160Address)`).
 */
export async function getOwnerAppCount(owner: string): Promise<number> {
	const registry = await getRegistry();
	const res = await registry.getOwnerAppCount.query(owner as `0x${string}`);
	if (!res.success) {
		throw new Error(`getOwnerAppCount query failed: ${JSON.stringify(res.value)}`);
	}
	return Number(res.value);
}

/**
 * Get the total number of apps in the registry.
 */
export async function getAppCount(): Promise<number> {
	const registry = await getRegistry();
	const res = await registry.getApps.query(0, 1);
	if (!res.success) {
		throw new Error(`getApps query failed at dry-run: ${JSON.stringify(res.value)}`);
	}
	const value = res.value as Record<string, unknown> | undefined;
	if (!value || typeof value.total !== "number") {
		throw new Error(`Unexpected getApps response shape: ${JSON.stringify(res.value)}`);
	}
	return value.total;
}

/**
 * Poll getApp until an entry appears or timeout.
 */
export async function waitForApp(domain: string, timeoutMs = 30_000): Promise<AppEntry> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const entry = await getApp(domain);
		if (entry) return entry;
		await new Promise((r) => setTimeout(r, 2_000));
	}
	throw new Error(`waitForApp: "${domain}" not found in registry after ${timeoutMs}ms`);
}

/**
 * Ensure the test template fixture is registered against the live playground
 * registry contract. The mod test is read-only (it does not publish), so unlike
 * the deploy fixtures — which the deploy tests re-publish on every run — this
 * fixture would otherwise drift out of existence whenever the registry contract
 * is redeployed. Register-if-missing keeps the suite self-healing across
 * registry redeploys without ever burning a fresh DotNS entry: same domain,
 * same owner, idempotent re-publish (no-op if already registered).
 *
 * Soft-fails into globalSetup's catch — non-mod tests should still run on a
 * degraded chain. The mod test will fail loudly downstream if the registration
 * itself failed.
 */
export async function ensureTemplateRegistered(): Promise<void> {
	const domain = process.env.TEST_TEMPLATE_DOMAIN;
	if (!domain) {
		console.warn("[e2e setup] TEST_TEMPLATE_DOMAIN not set — skipping template check");
		return;
	}

	const existing = await getApp(domain);
	if (existing) {
		console.log(`[e2e setup] Template "${domain}" already registered`);
		return;
	}

	const repositoryUrl = process.env.TEST_TEMPLATE_REPO;
	if (!repositoryUrl) {
		throw new Error(
			`Test template "${domain}" is not registered and TEST_TEMPLATE_REPO is unset — ` +
				`cannot bootstrap. Set TEST_TEMPLATE_REPO to the upstream source repository.`,
		);
	}

	console.log(
		`[e2e setup] Template "${domain}" missing — registering against the live registry contract…`,
	);
	// Same SIGNER the rest of the suite uses — it's already funded by
	// fundDeployerIfLow() earlier in globalSetup, so no extra balance check
	// here. Mirrors tools/register-e2e-fixtures.ts.
	const signer = await resolveSigner({ suri: SIGNER.suri });
	try {
		const result = await publishToPlayground({
			domain,
			publishSigner: signer,
			repositoryUrl,
		});
		console.log(`[e2e setup] Template "${domain}" registered (cid ${result.metadataCid})`);
	} finally {
		signer.destroy();
	}
}
