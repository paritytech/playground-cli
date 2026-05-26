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
 * E2E tests for session management.
 *
 * Tests session persistence, corruption handling, and logout behavior.
 * Uses HOME override to isolate session state in a temp directory.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestSession } from "@parity/product-sdk-terminal/testing";
import { dot } from "./helpers/dot.js";
import { fixturePath } from "./fixtures/templates.js";

function makeTempHome(): string {
	const dir = mkdtempSync(join(tmpdir(), "dot-e2e-session-"));
	mkdirSync(join(dir, ".polkadot-apps"), { recursive: true });
	return dir;
}

function getSessionFiles(dir: string): string[] {
	try {
		return readdirSync(dir).filter((f: string) => f.startsWith("dot-cli_")).sort();
	} catch {
		return [];
	}
}

describe("session management", () => {
	let tempHome: string;

	beforeEach(() => {
		tempHome = makeTempHome();
	});

	afterEach(() => {
		rmSync(tempHome, { recursive: true, force: true });
	});

	test("corrupted session file does not produce a valid signer", async () => {
		const sessionFile = join(tempHome, ".polkadot-apps", "dot-cli_SsoSessions.json");
		writeFileSync(sessionFile, "CORRUPT_DATA_HERE");

		const result = await dot(
			["deploy", "--signer", "phone", "--domain", "test", "--playground", "--buildDir", "dist"],
			{ home: tempHome, timeout: 30_000 },
		);
		// Must fail with a signer-resolution error. Match the exact
		// SignerNotAvailableError text from src/utils/signer.ts so a generic
		// "session" mention in an unrelated stack trace can't satisfy this.
		expect(result.exitCode).not.toBe(0);
		const output = result.stdout + result.stderr;
		expect(output).toContain("No signer available");
	});

	test("build does not create or modify session files", async () => {
		const frontendOnly = fixturePath("frontend-only");
		const sessionDir = join(tempHome, ".polkadot-apps");

		// Verify each build actually succeeds — otherwise "no session files
		// were touched" is a tautology (a crashed build can't write any file).
		const first = await dot(["build", "--dir", frontendOnly], { home: tempHome });
		expect(
			first.exitCode,
			`first build failed: ${first.stdout}\n${first.stderr}`,
		).toBe(0);
		const afterFirst = getSessionFiles(sessionDir);

		const second = await dot(["build", "--dir", frontendOnly], { home: tempHome });
		expect(
			second.exitCode,
			`second build failed: ${second.stdout}\n${second.stderr}`,
		).toBe(0);
		const afterSecond = getSessionFiles(sessionDir);

		// build doesn't need auth — no session files should be created
		expect(afterFirst).toEqual([]);
		expect(afterSecond).toEqual([]);
	});

	test("logout with no session reports no account signed in", async () => {
		const result = await dot(["logout"], { home: tempHome, timeout: 30_000 });
		expect(
			result.exitCode,
			`logout crashed: ${result.stdout}\n${result.stderr}`,
		).toBe(0);
		// Exact wording from src/commands/logout/index.ts:
		//   console.log("  No account is signed in.\n");
		expect(result.stdout).toContain("No account is signed in");
	});

	test("logout clears local session files left by a previous login", async () => {
		// Synthesize a session on disk as if QR pairing had completed.
		// `createTestSession` is a "dev utility, not a stable contract" per the
		// SDK — it hand-rolls the on-disk SCALE codec — so a minor bump of
		// `@parity/product-sdk-terminal` could break this test if the format
		// drifts. The SDK's own `testing.interop.test.ts` round-trip catches
		// that upstream first.
		const storageDir = join(tempHome, ".polkadot-apps");
		await createTestSession({ appId: "dot-cli", storageDir });
		const before = getSessionFiles(storageDir);
		expect(before.length, "createTestSession should write at least one dot-cli_* file").toBeGreaterThan(0);

		// `waitForLogout` runs `clearLocalAppStorage()` on both the success and
		// failure paths of `adapter.sessions.disconnect()` — so this test
		// passes regardless of whether the disconnect statement actually
		// round-trips on the testnet. The synthesized session has no real
		// mobile peer, so the disconnect call's behaviour is implementation
		// defined (statement-store may accept it as a fire-and-forget,
		// or reject if Bulletin allowance is missing). What we're locking
		// in here is the local-cleanup invariant: after a clean logout no
		// `${DAPP_ID}_*` files remain in `~/.polkadot-apps/`, regardless of
		// whether the user's phone is reachable.
		const result = await dot(["logout"], { home: tempHome, timeout: 90_000 });
		expect(
			result.exitCode,
			`logout exited non-zero: ${result.stdout}\n${result.stderr}`,
		).toBe(0);

		const after = getSessionFiles(storageDir);
		expect(after, "logout should remove all dot-cli_* files").toEqual([]);
	});
});
