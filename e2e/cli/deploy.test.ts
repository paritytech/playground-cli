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
 * E2E tests for `dot deploy`.
 *
 * These tests verify the deploy pipeline behavior. Tests that require
 * full network connectivity (Paseo testnet + IPFS) are marked accordingly.
 *
 * All headless deploys require: --signer, --domain, --buildDir, --playground, --contracts/--no-contracts
 * to trigger the non-interactive path (see isFullySpecified() in deploy/index.ts).
 *
 */

import { describe, test, expect } from "vitest";
import { resolve } from "node:path";
import { dot } from "./helpers/dot.js";
import { setupModdableFixture } from "./helpers/moddable-setup.js";
import { SIGNER, BOB, E2E_DOMAINS, E2E_TLD } from "./fixtures/accounts.js";
import { fixturePath } from "./fixtures/templates.js";
import { getApp, getOwnerAppCount, getOwnerH160 } from "./fixtures/registry.js";

/** Pull the metadata CID out of the headless deploy summary. The CLI
 *  prints `  Metadata CID    bafy...` once per successful deploy
 *  (see src/commands/deploy/index.ts printFinalResult). Returns null
 *  if absent — that itself is a meaningful signal. */
function extractMetadataCid(stdout: string): string | null {
	const m = stdout.match(/Metadata CID\s+(\S+)/);
	return m ? m[1] : null;
}

const frontendOnly = fixturePath("frontend-only");

/** buildDir must be absolute — it's resolved relative to cwd, not --dir */
function absBuildDir(fixture: string, dir = "dist"): string {
	return resolve(fixture, dir);
}

/**
 * Assertion notes for the preflight tests below:
 * - "Checking availability" is printed by `src/commands/deploy/index.ts` ONLY
 *   after preflight (signer + mapping + balance) has succeeded. Asserting on
 *   it is a real checkpoint — a deploy that crashes earlier won't print it.
 * - Avoid loose regexes like `/deploy/i`: the literal word "deploy" appears
 *   in the command banner, error-help text, and stack traces, so it matches
 *   even when nothing meaningful happened.
 * - For tests that expect failure, assert `exitCode !== 0` so an early crash
 *   that prints something tangentially matching the regex can't slip through.
 */

describe("dot deploy — preflight and validation", () => {
	test("reports mainnet not yet supported", async () => {
		const result = await dot([
			"deploy",
			"--no-contracts",
			"--signer", "dev",
			"--domain", E2E_DOMAINS.preflight,
			"--buildDir", absBuildDir(frontendOnly),
			"--playground",
			"--private",
			"--env", "mainnet",
			"--suri", SIGNER.suri,
			"--dir", frontendOnly,
		], { timeout: 400_000 });
		const output = result.stdout + result.stderr;
		expect(
			result.exitCode,
			`expected non-zero exit for --env mainnet, got 0\n${output}`,
		).not.toBe(0);
		// Wording from src/config.ts::getChainConfig():
		//   "--env polkadot is not yet supported. Use --env <DEFAULT_ENV> (default)."
		// Assert the shape, not the specific default env, so this survives a
		// network switch (ACTIVE_TESTNET_ENV flip).
		expect(output).toContain("not yet supported");
		expect(output).toContain("Use --env");
		expect(output).toContain("(default)");
	});

	test("domain availability check runs before build/upload", { timeout: 300_000 }, async () => {
		const domain = E2E_DOMAINS.preflight;
		const result = await dot([
			"deploy",
			"--no-contracts",
			"--signer", "dev",
			"--domain", domain,
			"--buildDir", absBuildDir(frontendOnly),
			"--playground",
			"--private",
			"--suri", SIGNER.suri,
			"--dir", frontendOnly,
		], { timeout: 400_000 });
		const output = result.stdout + result.stderr;
		// Availability banner names the domain; this is the strongest signal we
		// have that the availability check actually executed against this run's
		// domain (rather than echoing the arg in a usage/error string).
		const availIdx = output.indexOf(`Checking availability of ${domain}.${E2E_TLD}`);
		expect(
			availIdx,
			`availability banner not found:\n${output}`,
		).toBeGreaterThan(-1);
		// Verify the *ordering* claim in the test name: availability must
		// precede any build-runner output. The dot CLI's build banner is
		// `\n> ${config.description}\n` from src/commands/build.ts:15, and
		// `config.description` is always one of `pnpm/npm/yarn/bun/npx <verb>`
		// (see src/utils/build/detect.ts). Anchoring on that exact prefix
		// avoids matching unrelated `> ` lines that build-tool stdout itself
		// can produce — pnpm prints `> @scope/pkg@1 build /path` for every
		// run-script, vite logs `> built in 234ms`, etc.
		const buildIdx = output.search(/\n> (?:pnpm|npm|yarn|bun|npx) /);
		const storageIdx = output.indexOf("▸ storage-and-dotns");
		if (buildIdx > -1) {
			expect(
				availIdx,
				`build header appeared before availability check:\n${output}`,
			).toBeLessThan(buildIdx);
		}
		if (storageIdx > -1) {
			expect(
				availIdx,
				`storage phase started before availability check:\n${output}`,
			).toBeLessThan(storageIdx);
		}
	});
});

describe("dot deploy --playground — full pipeline (requires Paseo + IPFS)", () => {
	test("frontend-only deploy completes end-to-end", { timeout: 450_000 }, async () => {
		const domain = E2E_DOMAINS.storage;
		// Snapshot the on-chain state BEFORE the deploy so we can tell
		// fresh-publish from re-publish at assert time. The contract
		// preserves the per-owner index on re-publish (owner is immutable
		// after first publish), so the expected delta depends on this.
		const beforeCount = await getOwnerAppCount(SIGNER.h160);
		const wasAlreadyPublished = (await getApp(`${domain}.${E2E_TLD}`)) !== null;
		const result = await dot([
			"deploy",
			"--no-contracts",
			"--signer", "dev",
			"--domain", domain,
			"--buildDir", absBuildDir(frontendOnly),
			"--playground",
			"--private",
			"--suri", SIGNER.suri,
			"--dir", frontendOnly,
		], { timeout: 400_000 });

		expect(
			result.exitCode,
			`deploy failed: ${result.stdout}\n${result.stderr}`,
		).toBe(0);
		expect(result.stdout).toContain("Deploy complete");
		expect(result.stdout).toContain("URL");
		expect(result.stdout).toContain(domain);

		// Don't trust the CLI's own success message — query the registry
		// independently to prove the entry was actually written. A regression
		// where deploy prints "Deploy complete" but never sends the registry
		// extrinsic would otherwise pass.
		const cliCid = extractMetadataCid(result.stdout);
		expect(cliCid, "CLI did not print Metadata CID").not.toBeNull();
		const entry = await getApp(`${domain}.${E2E_TLD}`);
		expect(entry, `registry has no entry for ${domain}.${E2E_TLD}`).not.toBeNull();
		// Belt-and-braces: the on-chain CID should match what the CLI claims
		// it published. A divergence here means the CLI is reporting one CID
		// to the user while writing a different one to the chain.
		expect(entry!.metadataUri).toContain(cliCid!);

		// Ownership assertion — the `owner` recorded by `publish(...)` must
		// match the signing account when no claimed-owner is passed (dev +
		// --suri path). This is the headline-coverage stand-in for the
		// dev+session+claimed-owner flow, which can't be e2e-tested without
		// session mocking. The contract change MUST preserve "caller becomes
		// owner when owner=None" — regression here would silently break
		// existing dev-mode deploys.
		//
		// Both `getOwnerH160` (fixtures/registry.ts) and `deriveH160`
		// (via SIGNER.h160 in fixtures/accounts.ts) emit lowercase, so
		// no normalisation is needed at the comparison site.
		const ownerH160 = await getOwnerH160(`${domain}.${E2E_TLD}`);
		expect(ownerH160).toBe(SIGNER.h160);

		// MyApps query path: the per-owner index must include this domain
		// after publish. Contract preserves the per-owner slot on
		// re-publish (owner is immutable after first publish), so the
		// expected count delta depends on whether this deploy wrote a
		// fresh entry:
		//   - Fresh-publish: count incremented by exactly 1.
		//   - Re-publish: count is flat.
		// Asserting a strict equality (not >=) is the regression catch —
		// "publish doesn't write the per-owner index" used to slip through
		// the older `>= max(beforeCount, 1)` shape any time a domain was
		// pre-existing in the registry.
		const afterCount = await getOwnerAppCount(SIGNER.h160);
		if (wasAlreadyPublished) {
			expect(afterCount).toBe(beforeCount);
		} else {
			expect(afterCount).toBe(beforeCount + 1);
		}
	});

	// The dev-mode + active-session flow (Alice signs the publish tx but the
	// session's H160 is passed as the `owner` arg via Option<Address>) is the
	// headline behaviour of the fully-dev-deploy change. We can't e2e-test
	// it here because spinning up a real Polkadot-app SSO session against
	// Paseo would require running the mobile app or replicating its session-
	// pairing handshake against the live SSO endpoint. The unit-level coverage
	// lives in run.test.ts ("dev mode with playground: ZERO planned approvals
	// AND user H160 is claimed as owner") which asserts the publishToPlayground
	// call is dispatched with the right `claimedOwnerH160`, and in
	// playground.test.ts which asserts the registry.publish.tx receives the
	// right Option<Address> tuple. Skip-gated contract tests in playground-app
	// (tests/contract/registry.test.ts "publish with owner=Some(...)") will
	// close the on-chain end of this once the local revive-dev-node wiring
	// lands. See docs/superpowers/specs/2026-05-20-fully-dev-deploy-design.md.
	test.skip("dev + session: Alice signs but session H160 ends up as registry owner", () => {
		expect.fail("requires SSO session mocking infrastructure — see comment above");
	});

	test("re-deploy same domain succeeds for same owner", { timeout: 900_000 }, async () => {
		const domain = E2E_DOMAINS.redeploy;
		const first = await dot([
			"deploy",
			"--no-contracts",
			"--signer", "dev",
			"--domain", domain,
			"--buildDir", absBuildDir(frontendOnly),
			"--playground",
			"--private",
			"--suri", SIGNER.suri,
			"--dir", frontendOnly,
		], { timeout: 400_000 });
		expect(first.exitCode, `first deploy failed: ${first.stdout}\n${first.stderr}`).toBe(0);
		expect(first.stdout).toContain("Deploy complete");
		const firstCid = extractMetadataCid(first.stdout);
		expect(firstCid, "first deploy did not print Metadata CID").not.toBeNull();

		const second = await dot([
			"deploy",
			"--no-contracts",
			"--signer", "dev",
			"--domain", domain,
			"--buildDir", absBuildDir(frontendOnly),
			"--no-build",
			"--playground",
			"--private",
			"--suri", SIGNER.suri,
			"--dir", frontendOnly,
		], { timeout: 400_000 });
		expect(
			second.exitCode,
			`re-deploy failed: ${second.stdout}\n${second.stderr}`,
		).toBe(0);
		expect(second.stdout).toContain("Deploy complete");
		const secondCid = extractMetadataCid(second.stdout);
		expect(secondCid, "re-deploy did not print Metadata CID").not.toBeNull();
		// NOTE: do NOT assert `secondCid !== firstCid`. The metadata JSON only
		// includes `{repository, readme}` (see buildMetadata in src/utils/
		// deploy/playground.ts) — neither changes on a same-fixture redeploy,
		// so the CID is content-addressed to the same value both times. That's
		// correct behaviour: a same-CID re-publish means the registry already
		// has what the user wants.
		//
		// Independent registry check: the on-chain entry must contain the CID
		// the CLI claims it published. This catches regressions where the CLI
		// prints "Deploy complete" but never sent the registry extrinsic.
		const entry = await getApp(`${domain}.${E2E_TLD}`);
		expect(entry).not.toBeNull();
		expect(entry!.metadataUri).toContain(secondCid!);
	});

	test("domain taken by another account shows unavailable", { timeout: 900_000 }, async () => {
		const domain = E2E_DOMAINS.collision;
		const ownerDeploy = await dot([
			"deploy",
			"--no-contracts",
			"--signer", "dev",
			"--domain", domain,
			"--buildDir", absBuildDir(frontendOnly),
			"--playground",
			"--private",
			"--suri", SIGNER.suri,
			"--dir", frontendOnly,
		], { timeout: 400_000 });
		expect(
			ownerDeploy.exitCode,
			`owner deploy failed: ${ownerDeploy.stdout}\n${ownerDeploy.stderr}`,
		).toBe(0);

		const bobDeploy = await dot([
			"deploy",
			"--no-contracts",
			"--signer", "dev",
			"--domain", domain,
			"--buildDir", absBuildDir(frontendOnly),
			"--playground",
			"--private",
			"--suri", BOB.suri,
			"--dir", frontendOnly,
		], { timeout: 400_000 });
		// Must fail — domain is owned by SIGNER, not Bob.
		const output = bobDeploy.stdout + bobDeploy.stderr;
		expect(
			bobDeploy.exitCode,
			`bob deploy unexpectedly succeeded: ${bobDeploy.stdout}\n${bobDeploy.stderr}`,
		).not.toBe(0);
		expect(output.toLowerCase()).toMatch(/revert|taken|registered|owned|unavailable|already/);
	});
});

// `dot deploy --moddable` — the tagging half of the moddable round-trip.
// Pre-creates a public GH repo in test setup, runs `--moddable`, and
// asserts the deploy succeeds + the registry entry exists. The import
// half (`dot mod <domain>`) is covered separately in mod.test.ts.
//
// Coverage focus: this is the only cell that exercises the
// `gh repo create → push → dot deploy --moddable` cold-start sequence
// — the exact path a Summit attendee takes. The deploy reads
// `git remote get-url origin` from the test's temp working dir, HEADs
// the GH URL, stamps it into bulletin metadata, and writes the registry
// entry. Requires `GH_TOKEN` on the runner (see e2e.yml — moddable cell
// only).
describe("dot deploy — moddable (requires Paseo + IPFS + GH)", () => {
	test(
		"--moddable deploy stamps origin URL into registry metadata",
		{ timeout: 600_000 },
		async () => {
			const runId = process.env.GITHUB_RUN_ID ?? `local-${Date.now()}`;
			const repoName = `e2e-cli-moddable-${runId}`;
			const repoUrl = `https://github.com/paritytech/${repoName}`;
			const domain = E2E_DOMAINS.moddable;

			// Sets up a temp working dir with the frontend-only fixture +
			// freshly-created paritytech/<repoName> with `origin` pointing
			// to it. Throws (loudly) on `gh repo create` / push failures so
			// the cell fails with the actual gh error rather than a
			// downstream "no origin configured" red herring.
			const workDir = setupModdableFixture(repoName, frontendOnly);

			const result = await dot(
				[
					"deploy",
					"--no-contracts",
					"--signer", "dev",
					"--domain", domain,
					"--buildDir", absBuildDir(workDir),
					"--moddable",
					"--playground",
					"--private",
					"--suri", SIGNER.suri,
					"--dir", workDir,
				],
				{ timeout: 500_000, cwd: workDir },
			);

			expect(
				result.exitCode,
				`moddable deploy failed: ${result.stdout}\n${result.stderr}`,
			).toBe(0);
			expect(result.stdout).toContain("Deploy complete");
			expect(result.stdout).toContain(domain);
			// The post-deploy summary at src/commands/deploy/summary.ts:76
			// prints `Moddable: yes — <url>` only when --moddable resolved
			// successfully. Catches regressions where --moddable is
			// silently downgraded (e.g. origin read but URL stamping
			// skipped). The literal `yes — ${url}` reproduces the summary
			// line shape; loosening to `/yes/` would match the boolean
			// "yes" in unrelated rows (e.g. private=yes).
			expect(result.stdout).toContain(`yes — ${repoUrl}`);

			// Belt-and-braces: the registry entry must exist on-chain.
			// `metadata.repository` lives inside the bulletin-stored JSON
			// — the `getApp` helper today only returns the CID, not the
			// JSON contents. The stdout assertion above + the entry
			// existence here give sufficient coverage; a future
			// enhancement can fetch the metadata JSON from bulletin and
			// assert `metadata.repository === repoUrl` directly.
			const entry = await getApp(`${domain}.${E2E_TLD}`);
			expect(entry, `registry has no entry for ${domain}.${E2E_TLD}`).not.toBeNull();

			// Deliberately no test-side `gh repo delete` — the weekly
			// cleanup cron (e2e-cleanup.yml) sweeps repos older than 7
			// days by topic filter. A `finally` cleanup here would race
			// the bulletin upload serialisation: deleting the GH repo
			// before bulletin commits the metadata could in theory
			// invalidate the URL the CLI just stamped on-chain. Crashed
			// runs still get cleaned up by the cron.
		},
	);
});
