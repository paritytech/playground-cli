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
 * fresh git repo, and force-pushes it into ONE permanent public repo,
 * `paritytech/e2e-cli-moddable-fixture`, so the subsequent
 * `dot deploy --moddable` call has an `origin` URL that
 * `assertPublicGitHubRepo()` will accept.
 *
 * The repo is reused by every run on purpose. Creating a repo per run made
 * the CI token need org-wide repo creation and `delete_repo` (plus a weekly
 * sweep that deleted the leftovers). With one fixed repo, `E2E_GH_PAT` is a
 * fine-grained token scoped to this single repo with Contents: write, and
 * can neither create nor delete anything. The repo is created once by a
 * maintainer (see docs/e2e-bootstrap.md); this helper never creates it.
 * Overlapping runs force-push identical fixture content, which is harmless.
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORG = "paritytech";

/** The permanent fixture repo every moddable run pushes to. */
export const MODDABLE_FIXTURE_REPO = "e2e-cli-moddable-fixture";

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
 * Prepare a moddable test fixture: temp dir, git-init'd source, force-pushed
 * to `main` of the permanent `paritytech/<repoName>` repo. Returns the temp
 * dir path; the caller runs `dot deploy --moddable --dir <returned>` from
 * there.
 *
 * Requires `gh` on PATH and `GH_TOKEN` set in the environment (the CI cell
 * sets it via `${{ secrets.E2E_GH_PAT }}`), with push access to the repo.
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
	if (!ghRepoExists(qualifiedName)) {
		// Deliberately no `gh repo create` fallback: the CI token is scoped to
		// this one repo and cannot create repositories. Fail with the fix.
		throw new Error(
			`Moddable fixture repo ${qualifiedName} not found (or GH_TOKEN cannot see it). ` +
				`Create it once: gh repo create ${qualifiedName} --public — see docs/e2e-bootstrap.md.`,
		);
	}

	// Force-push: the fixture content is identical on every run, so the
	// previous commit is irrelevant. This matches what the CLI itself does on
	// re-run ("using existing origin (...)").
	//
	// `gh auth setup-git` wires gh's credential helper into git globally so
	// the raw `git push` can authenticate to github.com via GH_TOKEN.
	// `setup-git` is idempotent.
	sh("gh", ["auth", "setup-git"]);
	sh("git", ["remote", "add", "origin", `https://github.com/${qualifiedName}.git`], workDir);
	sh("git", ["push", "-u", "origin", "main", "--force"], workDir);

	return workDir;
}
