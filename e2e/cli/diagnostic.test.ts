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
 * E2E tests for diagnostic/verbose modes.
 *
 * Tests that environment variables like DOT_DEPLOY_VERBOSE and DOT_MEMORY_TRACE
 * produce additional diagnostic output without breaking normal operation.
 */

import { describe, test, expect } from "vitest";
import { resolve } from "node:path";
import { dot } from "./helpers/dot.js";
import { SIGNER, E2E_DOMAINS } from "./fixtures/accounts.js";
import { fixturePath } from "./fixtures/templates.js";

const frontendOnly = fixturePath("frontend-only");

describe("diagnostic mode", () => {
	test(
		"DOT_DEPLOY_VERBOSE=1 produces timestamped log lines during storage phase",
		{ timeout: 300_000 },
		async () => {
			// Need a deploy that actually reaches the storage phase — that's
			// where polkadot-app-deploy logs and verbose-mode wraps its output
			// with "[+<seconds>s] " timestamps (see src/utils/deploy/storage.ts).
			// Re-deploying a domain SIGNER already owns is the cheapest way
			// to get there. No `--no-build`: the fixture's dist/ is gitignored
			// and nothing else in this cell builds it, so the CLI must (the
			// fixture's build is a one-line copy).
			const result = await dot([
				"deploy",
				"--no-contracts",
				"--signer", "dev",
				"--domain", E2E_DOMAINS.preflight,
				"--buildDir", resolve(frontendOnly, "dist"),
				"--playground",
				"--private",
				"--suri", SIGNER.suri,
				"--dir", frontendOnly,
			], {
				env: { DOT_DEPLOY_VERBOSE: "1" },
				timeout: 280_000,
			});
			const output = result.stdout + result.stderr;
			// Real preflight checkpoint — only printed after signer/mapping
			// passes.
			expect(
				output,
				`expected to reach availability check with verbose on\n${output}`,
			).toContain("Checking availability");
			// Verbose-only marker. Format: "[+12.3s] <line>". This prefix
			// appears nowhere else, so matching it is the only way to prove
			// DOT_DEPLOY_VERBOSE wasn't silently ignored.
			expect(
				output,
				`expected verbose-only "[+Ns] ..." marker in output\n${output}`,
			).toMatch(/\[\+\d+\.\d+s\]/);
		},
	);

	test("DOT_MEMORY_TRACE=1 produces RSS sample lines during a real command", async () => {
		// `--help` exits before the memory watchdog has a chance to sample.
		// Run a deploy preflight instead — the watchdog samples once per
		// second and writes RSS/heap/external lines to stderr when the env
		// var is set (see src/utils/process-guard.ts startMemoryWatchdog).
		const result = await dot([
			"deploy",
			"--no-contracts",
			"--signer", "dev",
			"--domain", E2E_DOMAINS.preflight,
			"--buildDir", resolve(frontendOnly, "dist"),
			"--playground",
			"--private",
			"--suri", SIGNER.suri,
			"--dir", frontendOnly,
		], {
			env: { DOT_MEMORY_TRACE: "1" },
			timeout: 120_000,
		});
		const output = result.stdout + result.stderr;
		// Verbose-only prefix from src/utils/process-guard.ts watchdog worker:
		//   "[mem +<seconds>s] rss=<bytes> heap=<used>/<total> external=... peak=..."
		// That bracketed prefix is unique to this code path, so matching it
		// proves DOT_MEMORY_TRACE actually engaged the sampler — not just
		// that some other code wrote the word "rss" somewhere.
		expect(
			output,
			`expected memory-trace markers in output\n${output}`,
		).toMatch(/\[mem \+\d+\.\d+s\]/);
	});
});
