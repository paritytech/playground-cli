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
 * Idempotent on the GH repo: if `paritytech/<repoName>` already exists
 * (e.g. from a previous retry attempt within the same workflow run, or a
 * leftover from a crashed prior run), the helper reuses it instead of
 * crashing on "Name already exists". This mirrors the real-user re-run
 * path the CLI itself handles via "using existing origin" — and lets
 * `nick-fields/retry` actually retry without colliding on the run-scoped
 * repo name. The weekly cleanup cron sweeps repos by topic, so test
 * crashes still get tidied up later.
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

// `sh` throws on non-zero exit (execFileSync default). For the
// existence probe we want exit code, not throw — `gh repo view` exits 1
// when the repo doesn't exist, which is a normal branch here, not a
// failure.
function ghRepoExists(qualifiedName: string): boolean {
	try {
		execFileSync("gh", ["repo", "view", qualifiedName, "--json", "url"], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		return true;
	} catch {
		return false;
	}
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

	const qualifiedName = `${ORG}/${repoName}`;
	if (ghRepoExists(qualifiedName)) {
		// Reuse path — repo already exists (retry attempt within the same
		// workflow run, or leftover from a crashed earlier run). Add origin
		// manually and force-push: fixture content is identical between
		// attempts, so the prior commit SHA is irrelevant. This matches
		// what the CLI itself does on re-run ("using existing origin (...)").
		//
		// `gh auth setup-git` wires gh's credential helper into git globally
		// so the subsequent raw `git push` can authenticate to github.com
		// via GH_TOKEN. `gh repo create --push` does this implicitly; we
		// have to do it explicitly when bypassing gh repo create.
		// `setup-git` is idempotent.
		sh("gh", ["auth", "setup-git"]);
		sh("git", ["remote", "add", "origin", `https://github.com/${qualifiedName}.git`], workDir);
		sh("git", ["push", "-u", "origin", "main", "--force"], workDir);
	} else {
		// Cold path — fresh `gh repo create --source --push` does origin-add
		// + initial push in one round-trip, matching the Summit-user flow.
		sh("gh", [
			"repo",
			"create",
			qualifiedName,
			"--public",
			"--description",
			"playground-cli E2E moddable test fixture (auto-cleaned)",
			"--source",
			workDir,
			"--push",
		]);
	}

	// Topic-tag (idempotent — `--add-topic` is a no-op if already tagged).
	// `gh repo create` doesn't accept a `--topic` flag today, and the
	// cleanup cron filters by `--topic e2e-test-fixture` — so without this
	// edit, the repo would never get swept and would accumulate indefinitely.
	// Belt-and-braces: if `gh repo edit` fails (rate limit, transient), the
	// cleanup fallback to name-prefix matching is NOT implemented today, so
	// this throw is load-bearing.
	sh("gh", [
		"repo",
		"edit",
		qualifiedName,
		"--add-topic",
		TOPIC,
	]);

	return workDir;
}
