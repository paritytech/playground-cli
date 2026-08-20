# Running E2E Tests

How to trigger the E2E suite locally and on GitHub. For one-time maintainer setup
(SIGNER funding, fixture domain registration) see `docs/e2e-bootstrap.md`.

---

## 1. Quick reference

### Local commands

| Command | What it runs | When to use |
|---|---|---|
| `pnpm test:e2e:smoke` | smoke mode — same as `tools/e2e-local.sh smoke` | quick sanity check before a push |
| `pnpm test:e2e:pr` | pr mode — sequential run of the 6 per-PR cells | reproduce exactly what CI runs on every PR |
| `pnpm test:e2e:nightly` | nightly mode — full 13-cell suite sequentially | broader local check before a merge to main |
| `tools/e2e-local.sh cell <name>` | single named cell by vitest pattern | iterating on one failing cell |
| `tools/e2e-local.sh -- <vitest args>` | raw passthrough to vitest | one test file, one `-t` name filter, etc. |

### GitHub triggers

| Trigger | What runs | Auto-issue on fail? |
|---|---|---|
| PR push / PR open | 6-cell per-PR matrix + `E2E Report` comment | No |
| Push to `main` | same 6-cell matrix | No |
| Schedule (06:00 UTC daily) | full 13-cell nightly cube | Yes — `Nightly E2E failure: YYYY-MM-DD` |
| `workflow_dispatch` on `e2e.yml` | full 13-cell nightly cube | No |
| `release: prereleased` | `e2e-release.yml` — SEA-binary smoke (`published.test.ts`) | No |
| `release: published` (stable only) | `e2e-post-release.yml` — `install.sh` consumer-path smoke | No |
| `workflow_dispatch` on `e2e-release.yml` | SEA-binary smoke for a given tag | No |
| `workflow_dispatch` on `e2e-post-release.yml` | post-release install smoke for a given tag | No |

---

## 2. Local execution

### 2a. Pre-flight (one time per machine)

1. **Install dependencies:** `pnpm install`
2. **IPFS must be on PATH.** The deploy-flavour cells call `ipfs add` internally.
   Check with `which ipfs`; install via `brew install ipfs` on macOS or
   https://docs.ipfs.tech/install/ on Linux.
   The script warns but does not abort if `ipfs` is missing — non-deploy cells
   will still run.
3. **SIGNER balance.** `globalSetup` (`e2e/cli/setup/fund.ts`) auto-tops-up the
   E2E deployer from the CLI funder chain before the first run. No manual step
   needed; subsequent runs skip top-up if balance is above the threshold.

### 2b. Modes

`tools/e2e-local.sh` accepts an optional leading keyword that controls which cells
run and sets the Sentry tag for that run.

| Mode | pnpm alias | Cells | DOT_TAG |
|---|---|---|---|
| `smoke` (default) | `pnpm test:e2e:smoke` | `pr-mod` (mod-clone only — fast) | `e2e-local-smoke` |
| `pr` | `pnpm test:e2e:pr` | all 6 per-PR cells, sequential | `e2e-local-pr` |
| `nightly` | `pnpm test:e2e:nightly` | all 13 cells, sequential | `e2e-local-nightly` |

**What the script sets up for you:**

- `TEST_TEMPLATE_DOMAIN=dot-cli-mod-fixture.paseo` and `TEST_TEMPLATE_REPO` — prevents
  chain-dependent mod tests from being silently skipped.
- `DOT_DEPLOY_VERBOSE=1` — surfaces deploy-pipeline detail on failure.
- An isolated temp `HOME` — session state from `~/.polkadot-apps/` cannot leak
  into the test run. Removed automatically on exit.
- `ipfs init --profile=test` inside the isolated HOME — the deploy tests call
  `ipfs add` and IPFS resolves the repo from `$HOME/.ipfs`. CI does the same in
  its `setup-e2e` action.

Override any default by exporting before invoking:

```bash
TEST_TEMPLATE_DOMAIN=my-fixture.dot tools/e2e-local.sh pr
```

### 2c. Running a single cell

The script forwards everything after the mode keyword (or a leading `--`) to vitest.
To run a single named cell, pass its vitest pattern:

```bash
# Run just the foundry deploy cell
tools/e2e-local.sh pr -t "deploy — foundry"

# Run just login + session
tools/e2e-local.sh pr -t "dot login|session management"
```

### 2d. Raw vitest passthrough

Use `--` to pass arbitrary arguments directly to `pnpm exec vitest run`:

```bash
# A single test file
tools/e2e-local.sh -- e2e/cli/deploy.test.ts

# A single test by name
tools/e2e-local.sh -- -t "frontend-only"

# A specific file scoped to a name pattern
tools/e2e-local.sh -- e2e/cli/chaos.test.ts -t "chaos RPC failover"
```

The `--` separator is needed because `pnpm test:e2e:pr -- <filter>` swallows the
positional filter — the script invokes `pnpm exec vitest run` directly to avoid this.

### 2e. Reading results

After a local run:

| Path | Contents |
|---|---|
| `e2e-reports/junit.xml` | Machine-readable JUnit report |
| `e2e-reports/dot-runs.log` | Full stdout/stderr of every `dot` subprocess invoked by the tests |

Both paths are gitignored. They accumulate across runs in the same checkout —
delete them to start fresh.

---

## 3. GitHub execution

### 3a. Per-PR and push-to-main (6 cells)

Triggers: every `pull_request` event and every push to `main`.

Two job matrices run in parallel:

**test-no-publish** (up to 5 jobs in parallel, 25 min timeout each):

| Cell | Pattern | Source |
|---|---|---|
| `pr-install` | `dot install` | `e2e/cli/install.test.ts` |
| `pr-preflight` | `dot build\|preflight and validation` | `build.test.ts` + `deploy.test.ts` |
| `pr-mod` | `dot mod — clone` | `e2e/cli/mod.test.ts` |
| `pr-login-session` | `dot login\|session management` | `login.test.ts` + `session.test.ts` |

**test-publish** (max-parallel: 1 — SIGNER is shared, 55 min timeout each):

| Cell | Pattern | Source |
|---|---|---|
| `pr-deploy-frontend` | `full pipeline` | `e2e/cli/deploy.test.ts` |
| `pr-deploy-foundry` | `deploy — foundry` | `e2e/cli/deploy.test.ts` |

Each cell gets one automatic retry on transient testnet failures (30 s delay).

### 3b. Nightly cube (13 cells)

Triggers: `schedule` (06:00 UTC daily) and `workflow_dispatch`.

Adds four more cells on top of the 6 per-PR cells:

**test-nightly-no-publish** (parallel, nightly-only):

| Cell | Pattern | Source |
|---|---|---|
| `nightly-mod-miss` | `dot mod — registry miss` | `e2e/cli/mod.test.ts` |
| `nightly-diagnostic` | `diagnostic mode` | `e2e/cli/diagnostic.test.ts` |
| `nightly-rejections` | `rejects --no-contract-build` | `e2e/cli/deploy.test.ts` |
| `nightly-chaos-sigint` | `dot deploy — chaos` | `e2e/cli/chaos.test.ts` |

**test-nightly-publish** (max-parallel: 1, nightly-only):

| Cell | Pattern | Source |
|---|---|---|
| `nightly-deploy-hardhat` | `deploy — hardhat` | `e2e/cli/deploy.test.ts` |
| `nightly-deploy-multi` | `deploy — multi` | `e2e/cli/deploy.test.ts` |
| `nightly-chaos-rpc` | `chaos RPC failover` | `e2e/cli/chaos.test.ts` |

### 3c. Release smokes

**e2e-release.yml** (`release: prereleased` or `workflow_dispatch`):
Downloads the `dot-linux-x64` SEA asset from the GitHub release and runs
`e2e/cli/published.test.ts` against it. Validates the published binary before
a stable release is cut. Tag: `e2e-ci-release`.

**e2e-post-release.yml** (`release: published`, stable only — `prerelease != true`,
or `workflow_dispatch`):
Runs `install.sh` using the pinned tag (`VERSION=<tag> curl … | bash`), verifies
the binary lands at `~/.polkadot/bin/playground`, then runs `published.test.ts` against
the installed binary. Catches `install.sh` regressions that the SEA-download path
doesn't exercise. Tag: `e2e-ci-post-release`.

### 3d. Watching results on a PR

- **Sticky comment titled "E2E Test Pass"** appears on the PR after the `E2E Report`
  job finishes. It updates in place on subsequent pushes (keyed by the
  `<!-- e2e-pr-report -->` marker). Contains: per-cell pass/fail table with
  durations, collapsed failure detail block, Sentry traces link for this run.
- **Inline forensic block** — the "Surface failure detail" step prints
  `dot-runs.log` content and JUnit failure summary directly into the failing
  cell's job log. You normally don't need to download the artefact.
- **Downloadable artefacts** — each cell uploads `e2e-reports/` as
  `e2e-reports-<cell>` (7-day retention). Download via the Actions UI if you need
  the raw log outside GitHub.
- **Sentry traces** — the PR comment includes a deep link scoped to the
  `cli.tag` value for that run (e.g. `cli.tag:e2e-ci-pr`). Use the
  **Playground CLI E2E Health** dashboard (ID 2216096) for cross-run trends.

### 3e. Manual workflow_dispatch

Fire a full nightly run on demand (on any ref):

```bash
gh workflow run e2e.yml --ref main
```

Fire the release smoke against a specific RC tag:

```bash
gh workflow run e2e-release.yml --ref main -f tag=v0.16.0-rc.1
```

Fire the post-release install smoke against a specific stable tag:

```bash
gh workflow run e2e-post-release.yml --ref main -f tag=v0.16.0
```

### 3f. Auto-issue on failure

| Trigger | Issue opened? | Title format |
|---|---|---|
| `schedule` fail | Yes | `Nightly E2E failure: YYYY-MM-DD` |
| `workflow_dispatch` fail | No | — (human is watching) |
| `release` trigger fail | Yes (via the same report job) | `Nightly E2E failure: YYYY-MM-DD` |
| PR/push fail | No | — (PR comment covers it) |

Issues are opened per-failure run; there is no de-duplication across consecutive
nightly fails. Check the issue list for open `Nightly E2E failure:` issues before
filing a new one.

---

## 4. Common operations

**"My PR's E2E is red — what do I do?"**

1. Open the failing job in the Actions UI.
2. Look for the "Surface failure detail" step — it prints the relevant log lines
   and JUnit failure summary inline. In most cases this is enough.
3. If the failure looks like a testnet blip (connection timeout, chain not
   producing blocks), click **Re-run failed jobs** in the Actions UI.
4. If the failure persists across retries, reproduce locally:
   `tools/e2e-local.sh pr -t "<failing pattern>"`.
5. For SIGNER funding or fixture issues, see `docs/e2e-bootstrap.md` §3.

**"How do I run just one test?"**

```bash
tools/e2e-local.sh -- -t "<exact test name or partial match>"
```

**"How do I run a single test file?"**

```bash
tools/e2e-local.sh -- e2e/cli/mod.test.ts
```

**"How do I add a new cell to the nightly?"**

1. Write the test, grouped under a `describe("…")` block in the appropriate
   `e2e/cli/*.test.ts` file.
2. Add an entry to the relevant `matrix.include` block in
   `.github/workflows/e2e.yml`. Include a `# source:` comment naming the
   describe block and a `pattern:` that matches it exactly.
3. If the cell calls `registry.publish()`, add it to `test-nightly-publish`
   (max-parallel: 1). Otherwise use `test-nightly-no-publish`.
4. Register a fixture domain if needed — see `docs/e2e-bootstrap.md` §4.
5. Update the cell count in `CLAUDE.md` § E2E Tests.

**"How long does each surface take?"**

| Surface | Approximate wall-clock time |
|---|---|
| Smoke (local, single cell) | ~2–3 min |
| PR matrix (CI, critical path) | ~14 min |
| Full nightly (CI, critical path) | ~25–30 min |
| Release smoke | ~3 min |
| Post-release smoke | ~5 min |

**"The cleanup cron — what does it do?"**

`.github/workflows/e2e-cleanup.yml` runs Sunday 04:00 UTC. It is currently a stub
— there is nothing to sweep until Phase 5e (moddable deploy testing) ships. When
that lands, it will sweep `e2e-cli-moddable-*` GH repos and registry domains older
than 14 days.

---

## 5. Cross-links

- **One-time setup and recovery** (SIGNER funding, fixture domain registration,
  branch protection): `docs/e2e-bootstrap.md`
- **Design rationale and scenario list**: `docs-internal/2026-05-02-e2e-test-suite-design.md`
  (gitignored, not committed to the repo)
- **CI invariants and Sentry tagging rules**: `CLAUDE.md` § E2E Tests
