# E2E Bootstrap

Maintainer runbook for setting up and recovering the E2E test suite against Paseo testnet.
Run these steps once per registry-contract lifetime (not per PR).

---

## 1. Pre-conditions

### SIGNER account

The E2E deployer is derived from the canonical dev mnemonic:

```
mnemonic: bottom drive obey lake curtain smoke basket hold race lonely fit walk
derivation: //e2e-deployer
```

Source: `e2e/cli/fixtures/accounts.ts::DEDICATED_E2E_DEPLOYER_MNEMONIC`.

SIGNER must hold enough PAS to cover `registry.publish()` fees.
`globalSetup` auto-tops-up from the CLI funder chain before every test run (`e2e/cli/setup/fund.ts`);
the bootstrap tool (`tools/register-e2e-fixtures.ts`) does the same before registering fixtures.
Minimum held: 500 PAS. Top-up amount: 1000 PAS. Cost per publish: ~0.1 PAS.

**Identity-spine reveal (required since the registry/identity-spine migration).**
`registry.publish()` is gated fail-closed by `require_revealed()`: the caller's H160 must be
verified in the `@w3s/playground-identity` spine or every publish reverts `NotRevealed`.
SIGNER is neither of the registry's compiled-in dev signers (so it cannot use `publishDev`)
and, as a bare local key with no phone session, cannot use the playground-app "Become a
builder" flow — it must be seeded ONCE per spine deployment by a spine admin/sudo:
`admin_set_identity(<SIGNER H160>, <any root pubkey>)` (or `import_identities`). SIGNER's
H160 is printed by `tools/register-e2e-fixtures.ts` and derivable from the mnemonic above.
Until this is done, `ensureTemplateRegistered`, `tools/register-e2e-fixtures.ts`, and every
publish e2e leg fail at registry publish with `NotRevealed`. Re-seed after any spine
redeploy/wipe (same class of event as "Registry contract redeployed" below).

### Permanent fixture domains

Two categories. All owned by SIGNER after bootstrap.

**Tool-managed (explicit bootstrap required):**

| Domain | Purpose |
|---|---|
| `dot-cli-mod-fixture.dot` | `dot mod` fixture — has `repository` metadata pointing at Rock-Paper-Scissors |
| `e2e-cli-foundry` | `pr-deploy-foundry` / `nightly-deploy-foundry` cell |
| `e2e-cli-cdm` | `pr-deploy-cdm` cell (currently skipped pending fixture upgrade) |
| `e2e-cli-hardhat` | `nightly-deploy-hardhat` cell |
| `e2e-cli-multi` | `nightly-deploy-multi` cell |

These 5 domains are registered by `tools/register-e2e-fixtures.ts`.
Same-owner re-publish updates metadata in place — idempotent.

**Test-managed (no explicit bootstrap step):**

| Domain | Purpose |
|---|---|
| `e2e-cli-preflight` | Preflight/validation tests (shared by six tests) |
| `e2e-cli-storage` | Storage-phase happy-path test |
| `e2e-cli-redeploy` | Same-owner re-deploy test |
| `e2e-cli-collision` | Cross-owner collision test |

These 4 domains are registered organically on the first CI run that reaches `registry.publish()`.
Subsequent runs same-owner re-publish them. No manual step needed.
After a registry-contract redeploy, the next CI run restores them automatically.

### GitHub secrets

| Secret | Required for | Status |
|---|---|---|
| `MASTER_FUNDER_SEED` | Dedicated-funder seed — SIGNER top-up in globalSetup + the Funder Balance Check job | Required — must be set |
| `SENTRY_AUTH_TOKEN` | Telemetry verification (not yet implemented) | Optional |

`MASTER_FUNDER_SEED` is a BIP-39 mnemonic read at runtime by
`src/utils/account/funder.ts` (env var, never hardcoded). It derives the
dedicated funder at the bare root (empty derivation path), which is the
**primary** funder — the chain draws it down first and falls back to public
Alice only when it's empty. When unset the chain is just Alice — fine for
offline/local runs, but CI must set it. Provide it to local runs with
`export MASTER_FUNDER_SEED=…`.

`GITHUB_TOKEN` (auto-provided) is used by the report job and cleanup cron.

---

## 2. Idempotent bootstrap commands

Run these once per registry-contract lifetime (or to recover — see §3).

```bash
# Step 1: list registered apps and check whether the fixtures already exist
bun tools/list-registry-apps.ts
# If the fixture domains are absent → SIGNER not yet funded or fixtures not registered.
# If they already appear → registered (re-running step 2 is safe; it dedupes).

# Step 2: register (or re-register) all 5 tool-managed fixture domains
bun tools/register-e2e-fixtures.ts
# Output: signer balance, top-up if needed, then publishes each domain.

# Step 3: verify each tool-managed fixture is now listed
bun tools/list-registry-apps.ts | grep -E "dot-cli-mod-fixture|e2e-cli-foundry|e2e-cli-cdm|e2e-cli-hardhat|e2e-cli-multi"
# All 5 fixture domains should appear.
```

To register a single fixture (e.g. after adding a new cell):

```bash
bun tools/register-e2e-fixtures.ts --domain e2e-cli-foundry
```

To register with a custom signer (e.g. a staging key):

```bash
bun tools/register-e2e-fixtures.ts --suri "//MyStagingSigner"
```

---

## 3. Recovery procedures

### SIGNER is drained

Nothing to do manually. `globalSetup` (`e2e/cli/setup/fund.ts`) and
`tools/register-e2e-fixtures.ts` both auto-top-up when free balance is below
500 PAS — first from the dedicated funder derived from `MASTER_FUNDER_SEED`
(GitHub secret in CI; `export MASTER_FUNDER_SEED=…` locally), then from public
Alice as the fallback.

If both the dedicated funder and Alice are empty, re-fund the dedicated funder
account (the bare-root address — run `bun run scripts/check-funder-balance.ts`
with the seed exported to print it) on Paseo, and update the secret if the seed
itself changed.

### Registry contract redeployed (all domains wiped)

This happened in PR #78. Recovery:

```bash
# Re-register the 5 tool-managed fixtures in one shot:
bun tools/register-e2e-fixtures.ts

# The 4 test-managed domains (preflight/storage/redeploy/collision)
# are restored automatically on the next CI run that runs those tests.
# No manual step needed for those.
```

### A specific tool-managed fixture is missing or has wrong metadata

```bash
bun tools/register-e2e-fixtures.ts --domain <name>
# e.g.:
bun tools/register-e2e-fixtures.ts --domain dot-cli-mod-fixture.dot
bun tools/register-e2e-fixtures.ts --domain e2e-cli-foundry
```

### `dot-cli-mod-fixture.dot` repository URL changed

Edit `FIXTURES` in `tools/register-e2e-fixtures.ts` (the `repositoryUrl` field)
and re-run:

```bash
bun tools/register-e2e-fixtures.ts --domain dot-cli-mod-fixture.dot
```

Also update `TEST_TEMPLATE_REPO` in `.github/workflows/e2e.yml` and `e2e/cli/helpers/dot.ts`.

### E2E is gating a PR but the check is missing / failed for a non-code reason

**Do not bypass lightly.** Emergency admin-only procedure (auditable via org audit log):

```bash
# 1. Snapshot current required checks
gh api repos/paritytech/playground-cli/branches/main/protection \
  --jq '.required_status_checks.contexts' > /tmp/required-checks-before.txt

# 2. Temporarily remove "E2E Report" (keep all other required checks from step 1)
gh api -X PATCH repos/paritytech/playground-cli/branches/main/protection/required_status_checks \
  -f 'contexts[]=other-check-1'  # fill in from step 1 output

# 3. Merge the PR.

# 4. Restore "E2E Report" immediately.
gh api -X PATCH repos/paritytech/playground-cli/branches/main/protection/required_status_checks \
  -f 'contexts[]=other-check-1' \
  -f 'contexts[]=E2E Report'
```

Bypass reasons and preferred handling:

| Situation | Action |
|---|---|
| One cell flaked / timed out | Re-run the failed cell from the Actions UI |
| Whole workflow errored | Re-run the entire workflow |
| Real product regression | Do not bypass — fix it |
| Testnet outage (Paseo infra down) | Use admin bypass above + comment linking the testnet incident |
| Renamed check (e.g. "E2E Report" → new name) | Remove stale rule via gh-api; do not merge broken code |

---

## 4. Adding a new fixture domain

1. Add an entry to `FIXTURES` in `tools/register-e2e-fixtures.ts`.
2. Add the corresponding key to `E2E_DOMAINS` in `e2e/cli/fixtures/accounts.ts`.
3. Run `bun tools/register-e2e-fixtures.ts --domain <new-domain>` once.
4. Add the domain to the verify loop in §2 above.

---

## 5. Rotating/permanent state and cleanup

### Permanent fixtures (never swept)

The 9 domains listed in §1 are permanent. Same-owner re-publish by the tool
or by test runs keeps their metadata current without accumulating new registry
entries.

### Per-run rotating state (Phase 5e, not yet shipped)

When Phase 5e (`nightly-deploy-moddable`) ships, each run will create:
- A `e2e-cli-moddable-<runId>` registry domain
- A GitHub repo tagged `e2e-test-fixture`

These are swept by `.github/workflows/e2e-cleanup.yml` (Sunday 04:00 UTC)
after 14 days. No manual cleanup needed once that phase ships.

---

## 6. Sentry dashboards

Setup is manual, one-time. Both dashboards already exist as of 2026-05-02.

| Dashboard | ID | Filter | Purpose |
|---|---|---|---|
| Playground CLI Health | 2143100 | `!cli.tag:e2e-*` | Production signal — excludes E2E noise |
| Playground CLI E2E Health | 2216096 | `cli.tag:e2e-*` | E2E-only signal |

Dashboard JSON snapshots live in `sentry/dashboards/`. To view traces for a
specific CI run, use the Sentry link in the `E2E Report` PR comment or step
summary — it deep-links to the `cli.tag` value for that run.

No further setup required unless dashboards are reset or the Sentry project
is rotated. If you need to recreate them, see `sentry/` tooling and the
`## Sentry telemetry` section of `CLAUDE.md`.

---

## 7. Branch protection: adding `E2E Report` as a required check

Run once after the repo is freshly created or protection rules are reset:

```bash
# Read existing required checks first
gh api repos/paritytech/playground-cli/branches/main/protection \
  --jq '.required_status_checks.contexts'

# Add "E2E Report" to the list (include all existing checks + the new one)
gh api -X PUT repos/paritytech/playground-cli/branches/main/protection \
  --input - <<'EOF'
{
  "required_status_checks": {
    "strict": false,
    "contexts": ["E2E Report"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null
}
EOF
```

**Renaming the check later** (e.g. from "E2E Report" to something else) is a
three-step dance to avoid deadlocking the rename PR:

1. Add the new name to required checks.
2. Merge the PR that renames the job.
3. Remove the old name from required checks.

Never remove the old name before the rename PR merges — that leaves the branch
unprotected during the window.

---

## 8. Who has admin

```bash
# Org owners (admin on every paritytech repo)
gh api 'orgs/paritytech/members?role=admin' --jq '.[].login'

# Direct-collaborator admins on this repo
gh api repos/paritytech/playground-cli/collaborators \
  --jq '[.[] | select(.permissions.admin == true) | .login]'

# Team-based grants (requires org:read scope)
gh api repos/paritytech/playground-cli/teams \
  --jq '[.[] | select(.permission == "admin") | .name]'
```
