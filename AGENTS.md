# AGENTS.md

## Project Overview

`playground-cli` is a TypeScript ESM CLI for Polkadot Playground, installed as the `playground`
command (short alias `pg` — both invoke the same binary). The CLI uses Commander and Ink/React for
its terminal UI, is compiled with Bun, and is tested with Vitest.

`CLAUDE.md` is the authoritative source for repo-specific invariants and rationale. Read it
alongside this file; where the two differ, `CLAUDE.md` wins.

## Commands

- Install dependencies: `pnpm install`
- Build compiled CLI: `pnpm build`
- Run tests: `pnpm test`
- Watch tests: `pnpm test:watch`
- Type check: `pnpm exec tsc --noEmit`
- Format: `pnpm format`
- Check formatting: `pnpm format:check`
- Check license headers: `pnpm lint:license`
- Install local binary: `pnpm cli:install`

## Verification before committing

Run all three before claiming work is done, opening a PR, or merging. The first two are enforced by
CI; the third catches regressions:

```bash
pnpm format:check
pnpm lint:license
pnpm test
```

`pnpm build` compiles with Bun, which strips types **without** checking them — it is NOT a type
signal, and there is no `tsc` step in CI. The tree carries a known baseline of pre-existing
`tsc --noEmit` errors; before claiming a change complete, run
`pnpm exec tsc --noEmit 2>&1 | grep -c "error TS"` and confirm the count did not grow. If
`lint:license` flags a file you authored, run `./scripts/check-license-headers.sh --fix` to prepend
the Parity Apache-2.0 block (SPDX line + Parity copyright line, both required) — every tracked
`.ts` / `.tsx` / `.rs` file must carry it.

## Repository Conventions

- Tests live next to the source as `*.test.ts`. `vitest.config.ts` only picks up `.test.ts`; update
  it before adding `.tsx` tests.
- Pure logic embedded in `.tsx` components should be lifted into sibling `.ts` files so tests can
  import it without pulling React and Ink into the runner.
- Every user-facing PR needs a changeset in `.changeset/*.md`. Refactors, tests, and internal
  tooling-only changes can skip one.
- Do not add AI/tool attribution, signatures, or provenance to commits, PRs, generated files, or
  repo content.
- Do not commit design docs, brainstorming notes, context dumps, or scratch files.
- Do not mock `polkadot-api` primitives such as `Enum` or encoders in tests.
- Long-lived resources such as `TerminalAdapter`, session signers, and chain clients must be
  explicitly destroyed in cleanups — the WebSocket keeps the event loop alive, so a forgotten
  `destroy()` manifests as `playground <cmd>` hanging after the work visibly finishes.

## Dependency Rules

- Direct imports come from `@parity/product-sdk-*`, never `@polkadot-apps/*`. `@polkadot-apps/*` is
  fully out of the lockfile and CI's `Format` job greps `src/ e2e/ scripts/ tools/` and fails the
  build on any direct `@polkadot-apps/*` import.
- The CDM contract packages are `@parity/cdm-*` (migrated from `@dotdm/*`, June 2026):
  `@parity/cdm-codegen` and `@parity/cdm-builder` are pinned EXACT (this line has shipped breaking
  changes in patch releases), `@parity/cdm-env` rides a caret. CI greps for `['"]@dotdm/` to block
  re-introduction.
- `@parity/product-sdk-*` packages use caret ranges (`^0.x.y`); on a 0.x line `^` only widens
  patches, so a real breaking change still needs an explicit `package.json` bump.
- `@novasamatech/*` resolves through `@parity/product-sdk-terminal` (host-papp ≥ 0.8.6). Do NOT
  re-pin to 0.7.x or 0.8.5 — pairing compatibility is purely which host-papp version resolves. See
  `CLAUDE.md` for the full pairing-version rationale.
- Keep `polkadot-app-deploy` pinned to an explicit version — never `latest`. When bumping, check public
  API changes for `deploy()`, DotNS methods, `DeployOptions`, `jsMerkle`, the signer/storageSigner
  options, RPC handling, and attributes.
- Two local pnpm patches remain (statement-store, sdk-statement); they are local-only and version
  pinned. See `CLAUDE.md`.

## Architecture Boundaries

- All chain URLs and contract addresses belong in `src/config.ts`. Do not inline websocket URLs or
  `0x...` addresses elsewhere — mainnet launch flips one switch.
- Signer mode selection lives in `src/utils/deploy/signerMode.ts`; keep mainnet/testnet signer
  changes isolated there.
- `src/utils/deploy/*` and `src/utils/build/*` are SDK-facing surfaces for WebContainer consumers
  (e.g. RevX) and must not import React or Ink.
- CLI/TUI code lives under `src/commands/*`.
- `src/bootstrap.ts` is the first import in `src/index.ts` and owns the ambient Sentry handoff to
  `polkadot-app-deploy`. Keep `DOT_TELEMETRY` as the privacy gate for both CLI telemetry and
  `PAD_TELEMETRY`.
- The Bun compiled-binary stdin warm-up in `src/index.ts` is intentional. Do not remove it until
  Bun compiled TTY stdin works reliably with Ink.

## Deploy And Storage Invariants

- Deploy delegates storage hardening to `polkadot-app-deploy`: chunking, retries, pool accounts, nonce
  fallback, DAG-PB, and DotNS commit-reveal stay there.
- The CLI owns `registry.publish()` because the registry contract must record the user as the app
  owner. See `CLAUDE.md` for the `Option<Address> owner` / `env::caller()` ownership detail.
- Bulletin storage chunks must never sign with the phone session signer (the statement-store
  request cap is far below chunk size); phone mode threads a `storageSigner` slot key instead.
- Do not call `polkadot-app-deploy.deploy()` just to store playground metadata JSON. Submit
  `TransactionStorage.store` directly via PAPI using `calculateCid` from
  `@parity/product-sdk-bulletin` (see `src/utils/deploy/playground.ts::publishToPlayground`).
  `deploy()` would also run a DotNS register/setContenthash pass on a random `test-domain-*` label,
  which reverts opaquely.
- Dev mode must pass EXPLICIT auth options to `polkadot-app-deploy.deploy()` — never `{}` — or it probes
  for a persisted SSO session and turns a 0-tap dev deploy into multiple phone approvals.
- Metadata uploads need a dedicated Bulletin client with `heartbeatTimeout: 300_000`, destroyed
  immediately after upload.
- `playground deploy` currently relies on the Kubo binary path and must not pass `jsMerkle: true`
  until polkadot-app-deploy's pure-JS merkleizer preserves DAG-PB directory/file blocks correctly.
  `playground login` installs `ipfs` so deploys can rely on the Kubo CLI after setup.

## Runtime Safety

- On paseo-next-v2, transaction signing routes through
  `@parity/product-sdk-terminal@0.3.x`'s `createSessionSignerForAccount` →
  `session.createTransaction` (the wallet builds and signs the full extrinsic, no `<Bytes>`
  envelope), so every signed extension the chain declares survives end-to-end. Don't reach for
  `signRaw` to sign extrinsic payloads.
- `getSessionSigner()` returns an adapter that keeps the Node event loop alive. Every caller must
  call the returned `destroy()`.
- The memory watchdog is ON by default for every command and is the only guard that survives
  event-loop starvation — do not opt a command out. The default kill cap is 8 GB and can be
  overridden with `DOT_MEMORY_LIMIT_GB`; use `DOT_MEMORY_LIMIT_GB=0` only as an intentional
  emergency bypass for a known-large deploy.
- New long-running commands should register cleanup through the process guard
  (`src/utils/process-guard.ts`).
- TUI info updates must be throttled or coalesced. Do not stream raw high-volume logs directly into
  Ink state.
- `DeployLogParser.feed()` must not emit catch-all events per log line. Keep events limited to
  meaningful phase/progress matches.

## Mod And GitHub Behavior

- `playground mod` is GitHub-tarball-only (downloads from `codeload.github.com`). Do not reintroduce
  `git clone`, `gh repo fork`, or any tooling requirement for the public-repo path.
- `playground` never invokes `gh`. `playground deploy --moddable` reads an existing `origin` and
  validates it's a public GitHub URL via `HEAD https://github.com/{o}/{r}`; missing `origin`,
  private repos, and non-GitHub URLs hard-fail with actionable messages from
  `src/utils/deploy/moddable.ts`. The user sets up the public GitHub repo themselves.
- `metadata.repository` is written only when `--moddable` is explicitly opted in.

## Sentry Telemetry

- Helpers in `src/telemetry.ts`, `src/utils/deploy/phase.ts`, `src/cli-runtime.ts`. Every command
  wraps with `runCliCommand`; every deploy phase wraps with `withDeployPhase`. Don't reimplement the
  boilerplate.
- Dashboards are JSON snapshots in `sentry/dashboards/`. Run `./sentry/backup-dashboards.sh` before
  any change. Use `./sentry/patch-dashboard.py` and `./sentry/create-dashboard.py` for edits and new
  dashboards.
- E2E test runs are tagged `cli.tag:e2e-*`. Production widgets exclude `cli.tag:e2e-*`; the E2E
  Health dashboard targets it.
