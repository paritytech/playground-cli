#!/usr/bin/env bash
# Launch the E2E suite locally with the same env defaults CI uses.
#
# Mirrors .github/workflows/e2e.yml so a local run reproduces CI bit-for-bit:
#   - sets TEST_TEMPLATE_DOMAIN / TEST_TEMPLATE_REPO so the chain-dependent
#     mod test isn't silently skipped via test.skipIf(!TEST_DOMAIN);
#   - sets DOT_DEPLOY_VERBOSE=1 to surface deploy-pipeline detail on failure;
#   - allocates a temp HOME so session state from ~/.polkadot-apps/ doesn't
#     leak into tests (matches the runner's clean home).
#
# Usage:
#   tools/e2e-local.sh                          # full suite (smoke mode)
#   tools/e2e-local.sh smoke                    # smoke mode (explicit)
#   tools/e2e-local.sh pr                       # pr mode
#   tools/e2e-local.sh nightly                  # nightly mode
#   tools/e2e-local.sh e2e/cli/mod.test.ts      # filter (forwarded to vitest)
#   tools/e2e-local.sh -t "registry-miss"       # name filter
#
# Override any default by exporting it before invoking, e.g.:
#   TEST_TEMPLATE_DOMAIN=foo.dot tools/e2e-local.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Keep pnpm's managed CLI cache outside the isolated test HOME. pnpm 10 uses
# packageManager self-switching and stores shims under PNPM_HOME; if HOME is
# replaced first, local runs can fail before Vitest starts.
if [ -z "${PNPM_HOME:-}" ]; then
    case "$(uname -s)" in
        Darwin)
            export PNPM_HOME="$HOME/Library/pnpm"
            ;;
        Linux)
            export PNPM_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/pnpm"
            ;;
    esac
fi
export CARGO_HOME="${CARGO_HOME:-$HOME/.cargo}"
export RUSTUP_HOME="${RUSTUP_HOME:-$HOME/.rustup}"

if ! command -v ipfs >/dev/null 2>&1; then
    echo "warning: ipfs (kubo) not found on PATH — deploy-pipeline tests that publish to Bulletin will fail." >&2
    echo "         install with: brew install ipfs   (macOS), or follow https://docs.ipfs.tech/install/" >&2
    echo "" >&2
fi

if ! cargo pvm-contract help >/dev/null 2>&1; then
    echo "warning: cargo-pvm-contract not found — CDM contract tests will be skipped." >&2
    echo "         install with: rustup toolchain install nightly --component rust-src && rustup default nightly" >&2
    echo "                       cargo install cargo-pvm-contract --git https://github.com/paritytech/cargo-pvm-contract --rev 917a573ea9bf919e107290fd047827cf604049ff --locked" >&2
    echo "" >&2
fi

# Derive DOT_TAG from an optional leading mode keyword (smoke|pr|nightly).
# e2e/cli/helpers/dot.ts defaults DOT_TAG to "e2e-local"; we override that
# here so local runs are tagged by mode and stay distinct in Sentry dashboards.
_MODE="${1:-smoke}"
case "$_MODE" in
	smoke|pr|nightly)
		export DOT_TAG="${DOT_TAG:-e2e-local-${_MODE}}"
		shift
		;;
	--)
		export DOT_TAG="${DOT_TAG:-e2e-local-smoke}"
		shift
		;;
	*)
		export DOT_TAG="${DOT_TAG:-e2e-local-smoke}"
		;;
esac

export TEST_TEMPLATE_DOMAIN="${TEST_TEMPLATE_DOMAIN:-dot-cli-mod-fixture.paseo}"
export TEST_TEMPLATE_REPO="${TEST_TEMPLATE_REPO:-https://github.com/paritytech/Rock-Paper-Scissors}"
export DOT_DEPLOY_VERBOSE="${DOT_DEPLOY_VERBOSE:-1}"

ISOLATED_HOME="$(mktemp -d -t dot-e2e-home-XXXXXX)"
trap 'rm -rf "$ISOLATED_HOME"' EXIT
export HOME="$ISOLATED_HOME"

# Bootstrap a fresh IPFS repo in the isolated HOME. The deploy tests shell
# out to `ipfs add` (via polkadot-app-deploy's Kubo path), and IPFS resolves the
# repo location from `$HOME/.ipfs` by default. Without this, the deploy
# tests fail with "no IPFS repo found in <isolated home>/.ipfs". CI does
# the same thing in the workflow's `ipfs init --profile=test` step.
if command -v ipfs >/dev/null 2>&1; then
    ipfs init --profile=test >/dev/null 2>&1 || true
fi

echo "→ DOT_TAG               $DOT_TAG"
echo "→ TEST_TEMPLATE_DOMAIN  $TEST_TEMPLATE_DOMAIN"
echo "→ TEST_TEMPLATE_REPO    $TEST_TEMPLATE_REPO"
echo "→ DOT_DEPLOY_VERBOSE    $DOT_DEPLOY_VERBOSE"
echo "→ HOME                  $HOME (isolated, removed on exit)"
echo

# Invoke vitest directly. Going through `pnpm test:e2e -- <filter>` swallows
# the positional filter (the trailing `--` reaches vitest as end-of-options
# and the filter never narrows the run).
exec pnpm exec vitest run --config e2e/vitest.config.ts "$@"
