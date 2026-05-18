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
 * Chaos tests for `dot deploy` — verifies that the process-guard cleanup
 * + SIGINT handling work end-to-end.
 *
 * These run only in the nightly-chaos-sigint cell. PR runs skip them.
 *
 * Design notes
 * ------------
 * • We spawn the CLI directly via execa (not the `dot()` helper) so we get a
 *   child handle we can signal mid-flight.
 * • The sentinel `"▸ storage-and-dotns"` appears in headless-mode stdout
 *   exactly once, from `logHeadlessEvent` in src/commands/deploy/index.ts
 *   when the storage phase starts. It is specific to the headless code path
 *   and does not rely on bulletin-deploy banner text (which is intercepted by
 *   the log parser and never reaches stdout).
 * • If the sentinel never fires within 60 s (e.g. the deploy errors during
 *   preflight), the test still sends SIGINT and asserts clean exit semantics.
 *   The 5 s wall-clock assertion still exercises the process-guard — just
 *   against a process that may already be winding down rather than one in
 *   the middle of a chunk upload.
 */

import { describe, test, expect } from "vitest";
import { execa } from "execa";
import { resolve } from "node:path";
import { SIGNER, E2E_DOMAINS } from "./fixtures/accounts.js";
import { fixturePath } from "./fixtures/templates.js";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const CLI_ENTRY = resolve(REPO_ROOT, "src/index.ts");

/** Common CLI args for a full playground deploy in chaos scenarios. */
function chaosDeployArgs(domain: string, buildDir: string, dir: string): string[] {
	return [
		"run",
		CLI_ENTRY,
		"deploy",
		"--signer",
		"dev",
		"--domain",
		domain,
		"--buildDir",
		buildDir,
		"--playground",
		"--private",
		"--suri",
		SIGNER.suri,
		"--dir",
		dir,
	];
}

/** How long to wait for the storage-phase sentinel before sending SIGINT anyway. */
const SENTINEL_WAIT_MS = 60_000;

/** Expected maximum elapsed time from SIGINT to process exit. */
const MAX_EXIT_MS = 5_000;

describe("dot deploy — chaos", () => {
	test("SIGINT mid-deploy exits with code 130 within 5s", { timeout: 120_000 }, async () => {
		const frontendOnly = fixturePath("frontend-only");

		const child = execa(
			"bun",
			chaosDeployArgs(
				E2E_DOMAINS.chaos,
				resolve(frontendOnly, "dist"),
				frontendOnly,
			),
			{
				cwd: REPO_ROOT,
				env: { ...process.env, DOT_TAG: "e2e-chaos-sigint", DEPLOY_TAG: process.env.DEPLOY_TAG ?? "e2e-cli-chaos-sigint", DOT_TELEMETRY: "1" },
				reject: false,
			},
		);

		// Accumulate output from both streams so the diagnostic tail is
		// available if the assertion fails.
		let buf = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			buf += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			buf += chunk.toString();
		});

		// Wait for the storage phase to start OR for the process to exit early
		// (e.g. availability check fails, network error during preflight, etc.)
		// OR for the 60 s sentinel budget to expire.
		//
		// Sentinel: headless logHeadlessEvent writes `▸ storage-and-dotns…\n`
		// to stdout when the storage-and-dotns phase begins.
		const sentinel = "▸ storage-and-dotns";
		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => resolve(), SENTINEL_WAIT_MS);

			const checkBuf = () => {
				if (buf.includes(sentinel)) {
					clearTimeout(timeout);
					resolve();
				}
			};

			child.stdout?.on("data", checkBuf);
			child.on("exit", () => {
				clearTimeout(timeout);
				resolve();
			});
		});

		// Send SIGINT and measure how long the process takes to exit.
		const t0 = Date.now();
		child.kill("SIGINT");
		const result = await child;
		const elapsedMs = Date.now() - t0;

		// process-guard.ts calls runAllCleanupAndExit(130) on SIGINT.
		// execa reflects this as exitCode=130. If the handler doesn't get
		// to run (e.g. bun propagates the OS signal before our handler fires),
		// execa sets signal="SIGINT" instead. Both outcomes are acceptable:
		// what we're asserting is that the process is GONE cleanly within 5 s.
		const cleanExit = result.exitCode === 130 || result.signal === "SIGINT";
		expect(
			cleanExit,
			`expected exit code 130 or signal SIGINT, got exitCode=${result.exitCode} signal=${result.signal}\nlast output:\n${buf.slice(-500)}`,
		).toBe(true);

		expect(
			elapsedMs,
			`process took ${elapsedMs} ms to exit after SIGINT (limit ${MAX_EXIT_MS} ms)\nlast output:\n${buf.slice(-500)}`,
		).toBeLessThan(MAX_EXIT_MS);
	});
});

describe("dot deploy — chaos RPC failover", () => {
	test("survives an unreachable primary bulletin RPC via failover", { timeout: 600_000 }, async () => {
		// Set DOT_BULLETIN_RPC to an unroutable address. getChainConfig() will
		// expose it as bulletinRpc and put the real endpoint in bulletinRpcFallbacks.
		// bulletin-deploy's deploy() internally builds [override, DEFAULT] as its
		// BULLETIN_ENDPOINTS list and polkadot-api's WS provider fails over
		// automatically when the primary is unreachable. The deploy MUST still
		// succeed — we're testing failover, not rejection.
		const frontendOnly = fixturePath("frontend-only");

		const result = await execa(
			"bun",
			chaosDeployArgs(
				E2E_DOMAINS.chaos,
				resolve(frontendOnly, "dist"),
				frontendOnly,
			),
			{
				cwd: REPO_ROOT,
				env: {
					...process.env,
					DOT_TAG: "e2e-chaos-rpc",
					DEPLOY_TAG: process.env.DEPLOY_TAG ?? "e2e-cli-chaos-rpc",
					DOT_TELEMETRY: "1",
					DOT_BULLETIN_RPC: "ws://127.0.0.1:1/",
				},
				reject: false,
				timeout: 580_000,
			},
		);

		expect(
			result.exitCode,
			`deploy failed: ${result.stdout}\n${result.stderr}`,
		).toBe(0);
	});
});
