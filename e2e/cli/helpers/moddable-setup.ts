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
 * Setup helper for the `nightly-deploy-moddable` cell.
 *
 * Builds a temp working dir containing the source fixture, initialises a
 * fresh git repo, pre-creates a public GH repo at
 * `paritytech/<repoName>`, and pushes the fixture into it so the
 * subsequent `dot deploy --moddable` call has a `origin` URL that
 * `assertPublicGitHubRepo()` will accept.
 *
 * Failures bubble up cleanly so the CI cell fails loudly with the `gh`
 * error message — per the locked design decision (no retries, no
 * auto-renaming). The weekly cleanup cron sweeps repos by topic, so
 * test crashes still get tidied up later.
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOPIC = "e2e-test-fixture";
const ORG = "paritytech";

function sh(cmd: string, args: string[], cwd?: string): string {
	return execFileSync(cmd, args, {
		encoding: "utf8",
		stdio: ["pipe", "pipe", "pipe"],
		cwd,
	}).trim();
}

/**
 * Create a fresh moddable test fixture: temp dir, git-init'd source,
 * paired public GH repo with the fixture pushed to `main`. Returns the
 * temp dir path; the caller runs `dot deploy --moddable --dir <returned>`
 * from there.
 *
 * Requires `gh` on PATH and `GH_TOKEN` set in the environment (the CI cell
 * sets it via `${{ secrets.E2E_GH_PAT }}`).
 */
export function setupModdableFixture(
	repoName: string,
	sourceFixture: string,
): string {
	const workDir = mkdtempSync(join(tmpdir(), "dot-e2e-moddable-"));
	// Copy fixture contents into workDir as the new repo's initial state.
	// `recursive: true` walks dirs; not following symlinks (default).
	cpSync(sourceFixture, workDir, { recursive: true });

	// Local git setup. Pass user.email + user.name as -c overrides so we
	// don't depend on the runner's global git config (CI runners often
	// have neither set, and a missing identity makes `git commit` fail).
	sh("git", ["init", "-b", "main"], workDir);
	sh("git", ["add", "-A"], workDir);
	sh(
		"git",
		[
			"-c",
			"user.email=e2e@playground-cli.invalid",
			"-c",
			"user.name=playground-cli e2e",
			"commit",
			"-m",
			"e2e fixture",
		],
		workDir,
	);

	// `gh repo create --source --push` does the origin-add + initial push in
	// one round-trip, which is the same flow a Summit user would use
	// (`gh repo create <name> --public --source . --push`). Description
	// makes the auto-cleanup origin obvious to anyone who stumbles on the
	// repo before the cron sweeps it.
	sh("gh", [
		"repo",
		"create",
		`${ORG}/${repoName}`,
		"--public",
		"--description",
		"playground-cli E2E moddable test fixture (auto-cleaned)",
		"--source",
		workDir,
		"--push",
	]);

	// Topic-tag separately. `gh repo create` doesn't accept a `--topic`
	// flag today, and the cleanup cron filters by `--topic e2e-test-fixture`
	// — so without this edit, the repo would never get swept and would
	// accumulate indefinitely. Belt-and-braces: if `gh repo edit` fails
	// (rate limit, transient), the cleanup falls back to name-prefix
	// matching is NOT implemented today, so this throw is load-bearing.
	sh("gh", [
		"repo",
		"edit",
		`${ORG}/${repoName}`,
		"--add-topic",
		TOPIC,
	]);

	return workDir;
}
