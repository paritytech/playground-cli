#!/usr/bin/env bun

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
 * Register the fixed E2E playground-registry entries against the active chain.
 *
 * Uses the same publish path as `dot deploy --playground`: metadata is stored
 * through `publishToPlayground()`, then the registry entry is written by the
 * fixture signer. Re-running is idempotent for domains already owned by that
 * signer.
 */

import { parseArgs } from "node:util";
import { getEnvTld } from "../src/config.js";
import { destroyConnection } from "../src/utils/connection.js";
import { checkAllowance, ensureAllowance } from "../src/utils/account/allowance.js";
import { publishToPlayground, normalizeDomain } from "../src/utils/deploy/playground.js";
import { getReadOnlyRegistryContract } from "../src/utils/registry.js";
import { resolveSigner } from "../src/utils/signer.js";
import { SIGNER, E2E_DOMAINS } from "../e2e/cli/fixtures/accounts.js";
import { destroyTestClient, getTestClient } from "../e2e/cli/helpers/chain.js";
import { fundAccountIfLow } from "../e2e/cli/setup/fund.js";

// This script publishes against the default env, so its TLD is the one every
// fixture name carries (`.paseo` on paseo-next-v2).
const TLD = getEnvTld();
const DEFAULT_TEMPLATE_DOMAIN = `dot-cli-mod-fixture.${TLD}`;
const DEFAULT_TEMPLATE_REPO = "https://github.com/paritytech/Rock-Paper-Scissors";
const REGISTRY_READBACK_ATTEMPTS = 5;
const REGISTRY_READBACK_DELAY_MS = 2_000;

interface Fixture {
	domain: string;
	repositoryUrl: string | null;
}

const FIXTURES: readonly Fixture[] = [
	{
		domain: process.env.TEST_TEMPLATE_DOMAIN ?? DEFAULT_TEMPLATE_DOMAIN,
		repositoryUrl: process.env.TEST_TEMPLATE_REPO ?? DEFAULT_TEMPLATE_REPO,
	},
	...[
		E2E_DOMAINS.preflight,
		E2E_DOMAINS.storage,
		E2E_DOMAINS.redeploy,
		E2E_DOMAINS.collision,
		E2E_DOMAINS.foundry,
		E2E_DOMAINS.cdm,
		E2E_DOMAINS.hardhat,
		E2E_DOMAINS.multi,
	].map((domain) => ({ domain, repositoryUrl: null })),
];

function usage(): string {
	return [
		"Usage: bun tools/register-e2e-fixtures.ts [--domain <domain>] [--suri <suri>]",
		"",
		"Fixtures:",
		...FIXTURES.map((fixture) => `  ${normalizeDomain(fixture.domain, TLD).fullDomain}`),
	].join("\n");
}

function selectedFixtures(domain?: string): readonly Fixture[] {
	if (!domain) return FIXTURES;

	const requested = normalizeDomain(domain, TLD).fullDomain.toLowerCase();
	return FIXTURES.filter(
		(fixture) => normalizeDomain(fixture.domain, TLD).fullDomain.toLowerCase() === requested,
	);
}

function describeFixture(fixture: Fixture): string {
	const fullDomain = normalizeDomain(fixture.domain, TLD).fullDomain;
	return `${fullDomain}  repo=${fixture.repositoryUrl ?? "(none)"}`;
}

function logPlan(fixtures: readonly Fixture[]): void {
	console.log(`registering ${fixtures.length} fixture(s) as private Playground apps:`);
	for (const fixture of fixtures) {
		console.log(`  - ${describeFixture(fixture)}`);
	}
	console.log();
}

function errorText(error: unknown): string {
	if (error instanceof Error) return `${error.name}: ${error.message}`;
	return String(error);
}

function isBulletinTeardownNoise(error: unknown): boolean {
	const text = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ""}` : String(error);
	return (
		text.includes("ChainHead disjointed") ||
		(text.includes("UnsubscriptionError") && text.includes("Not connected"))
	);
}

function suppressStandaloneBulletinTeardownNoise(): () => void {
	const onUncaught = (error: unknown) => {
		if (isBulletinTeardownNoise(error)) {
			console.warn(`ignored Bulletin client teardown noise: ${errorText(error)}`);
			return;
		}
		process.off("uncaughtException", onUncaught);
		throw error;
	};

	process.prependListener("uncaughtException", onUncaught);
	return () => process.off("uncaughtException", onUncaught);
}

async function delay(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

function formatAllowance(status: Awaited<ReturnType<typeof checkAllowance>>): string {
	if (!status.authorized) return "not authorized";
	return `${status.remainingTxs} tx / ${status.remainingBytes} bytes`;
}

async function ensureFixtureStorageAllowance(address: string): Promise<void> {
	const client = await getTestClient();
	const before = await checkAllowance(client, address);
	console.log(`Bulletin allowance ${formatAllowance(before)}`);

	await ensureAllowance(client, address);

	const after = await checkAllowance(client, address);
	if (formatAllowance(after) !== formatAllowance(before)) {
		console.log(`Bulletin allowance ${formatAllowance(after)}`);
	}
	console.log();
}

async function verifyRegistryEntry(domain: string, metadataCid: string): Promise<void> {
	const client = await getTestClient();
	const registry = await getReadOnlyRegistryContract(client.raw.assetHub);

	for (let attempt = 1; attempt <= REGISTRY_READBACK_ATTEMPTS; attempt++) {
		const result = await registry.getMetadataUri.query(domain);
		const value = result.value as { isSome?: boolean; value?: string } | undefined;
		if (result.success && value?.isSome && value.value === metadataCid) return;

		if (attempt < REGISTRY_READBACK_ATTEMPTS) await delay(REGISTRY_READBACK_DELAY_MS);
	}

	throw new Error(`Registry readback failed for ${domain}: expected metadata CID ${metadataCid}`);
}

async function registerFixture(
	fixture: Fixture,
	signer: Awaited<ReturnType<typeof resolveSigner>>,
	index: number,
	total: number,
): Promise<void> {
	const fullDomain = normalizeDomain(fixture.domain, TLD).fullDomain;
	const start = Date.now();
	console.log(`[${index}/${total}] ${fullDomain}`);
	console.log(`  repository  ${fixture.repositoryUrl ?? "(none)"}`);
	console.log("  visibility  private");

	const result = await publishToPlayground({
		domain: fixture.domain,
		publishSigner: signer,
		repositoryUrl: fixture.repositoryUrl,
		isPrivate: true,
		onLogEvent: (event) => {
			if (event.kind === "info") console.log(`  ${event.message}`);
		},
	});

	await verifyRegistryEntry(result.fullDomain, result.metadataCid);

	const elapsed = ((Date.now() - start) / 1000).toFixed(1);
	console.log("  verified    registry readback");
	console.log(`  published   ${result.metadataCid} (${elapsed}s)`);
	console.log();
}

async function main(): Promise<number> {
	const { values } = parseArgs({
		options: {
			domain: { type: "string" },
			help: { type: "boolean", short: "h" },
			suri: { type: "string" },
		},
	});

	if (values.help) {
		console.log(usage());
		return 0;
	}

	let fixtures: readonly Fixture[];
	try {
		fixtures = selectedFixtures(values.domain);
	} catch (err) {
		console.error(err instanceof Error ? err.message : String(err));
		console.error(usage());
		return 2;
	}

	if (fixtures.length === 0) {
		console.error(`No fixture matches "${values.domain}".`);
		console.error(usage());
		return 2;
	}

	const signer = await resolveSigner({ suri: values.suri ?? SIGNER.suri });
	const restoreErrorHandling = suppressStandaloneBulletinTeardownNoise();
	try {
		logPlan(fixtures);
		console.log(`signer ${signer.address} (${signer.source})`);
		await fundAccountIfLow({ name: "fixture signer", address: signer.address });
		console.log();
		await ensureFixtureStorageAllowance(signer.address);

		for (const [index, fixture] of fixtures.entries()) {
			await registerFixture(fixture, signer, index + 1, fixtures.length);
		}
		console.log(`registered ${fixtures.length} fixture(s)`);
		return 0;
	} finally {
		restoreErrorHandling();
		signer.destroy();
		destroyTestClient();
		destroyConnection();
	}
}

main()
	.then((code) => process.exit(code))
	.catch((err) => {
		console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
		process.exit(2);
	});
