# CLAUDE.md

Refer to the **Contributing** and **Architecture Highlights** sections of [README.md](./README.md) for development workflows, release process, and repo conventions.

## Verification before committing

Before claiming a task complete, opening a PR, or merging, run these three checks. The first two are enforced by CI; the third catches regressions:

```bash
pnpm format:check
pnpm lint:license
pnpm test
```

`pnpm build` is the canonical type signal — there is no separate `tsc` step. If `lint:license` flags a file you authored, run `./scripts/check-license-headers.sh --fix` to prepend the standard Parity Apache-2.0 header. Every tracked `.ts` / `.tsx` / `.rs` file must carry both the `SPDX-License-Identifier: Apache-2.0` line and the `Copyright (C) Parity Technologies (UK) Ltd.` line — a bare SPDX line alone is rejected, and the `License Headers` workflow fails closed on missing headers. The check script handles shebanged scripts (`#!/usr/bin/env node|bun`) by keeping the shebang on line 1 and placing the header below it.

## Non-obvious invariants

These are things that aren't self-evident from reading the code and have bitten us before:

- **Direct imports come from `@parity/product-sdk-*`, not `@polkadot-apps/*`.** The CLI runtime is on product-sdk packages (`-address`, `-bulletin`, `-chain-client`, `-contracts`, `-descriptors`, `-keys`, `-storage`, `-terminal`, `-tx`, `-utils`). `@polkadot-apps/*` is fully gone from the lockfile (`grep '@polkadot-apps/' pnpm-lock.yaml` returns 0 hits) since `@dotdm/contracts` shipped its own product-sdk migration. Don't reintroduce direct `@polkadot-apps/*` imports — there's a `grep -rnE "['\"]@polkadot-apps/" src/ e2e/ scripts/ tools/` guard in CI's `Format` job that fails the build. Product-sdk packages use caret ranges (`^0.x.y`) so minor/patch upstream releases land on a fresh `pnpm install`; the lockfile pins the actually-resolved version. The SDK is pre-1.0 and `^` on a 0.x range only widens patches (`^0.2.0` → `>=0.2.0 <0.3.0`), so a true breaking change still requires an explicit bump in `package.json`.
- **`@dotdm/contracts` is on a caret range** (`^2.0.3`). The 2.0 line ships with `resolveTargetRegistryAddress` + re-exports `REGISTRY_ADDRESS` from `@dotdm/utils`, which `src/config.ts::CDM_REGISTRY_ADDRESS` consumes. Earlier dev-tag pins (e.g. `1.1.1-dev.…`) predated `@dotdm/contracts`'s own product-sdk migration; the legacy `1.1.1` stable still depends on `@polkadot-apps/*` + PAPI 1.x and must NOT be downgraded to. Patch bumps within 2.x are safe.
- **`@novasamatech/*` packages are forced to `0.7.9-4` via `pnpm.overrides`.** They're transitive (pulled in by `@parity/product-sdk-terminal`'s `^0.7.7` ranges) and pnpm doesn't bump transitives across patches automatically. The override aligns the whole tree on the latest published Novasama line so we get the most recent host-papp + statement-store fixes (including RFC-0010 `requestResourceAllocation` on `UserSession`). Drop the override once product-sdk-terminal bumps its caret to `^0.7.9-4` natively, or once we move our pins forward.
- **`@polkadot-api/json-rpc-provider: ^0.2.0` override is still load-bearing.** Removing it splits the lockfile across three versions of `json-rpc-provider`: `0.0.1` (optional), `0.0.4`, and `0.2.0` — different transitive consumers in the PAPI 2.x ecosystem ask for different versions. Forcing everyone onto `0.2.0` keeps a single version in the tree, which avoids subtle wire-shape divergence and reduces bundle/process memory. Originally added to consolidate `@polkadot-apps/*` consumers (now gone), but the consolidation still benefits the PAPI 2.x consumers. Drop only when every transitive consumer uplifts to a unified range.
- **Only `@parity/dotns-cli` still declares `polkadot-api@1.x`**, and that's a bundled Bun-built CLI binary (`dist/cli.js`) — its `polkadot-api@1.x` is sealed inside the bundle, never resolved from `node_modules` at runtime. We're effectively a PAPI 2.x-only process.
- **The mobile app wraps `signRaw` data with `<Bytes>…</Bytes>`** (anti-phishing envelope, see `polkadot-app-android-v2/.../MessageSigningContext.kt::generalUntrustedMessage` — still load-bearing on Android nightly/v1198). On paseo-next-v2 this no longer matters for tx signing: `@parity/product-sdk-terminal@0.2.1`'s `createSessionSignerForAccount` switched from the PJS bridge to a PAPI-native signer that routes tx payloads through `session.signRaw({ data: { tag: "Payload", value: hex(toSign) } })` — opaque bytes, no `<Bytes>` envelope — so every signed extension declared by the chain (including paseo-next-v2's `AsPgas`) survives end-to-end. Don't reach for `signRaw` to sign extrinsic payloads from anywhere outside the signer; raw-message signing keeps the `Bytes` tag so the anti-phishing wrap stays in place for arbitrary user data. The pre-0.2.1 PJS path failed on v2 with `PJS does not support this signed-extension: AsPgas`; don't downgrade past `^0.2.1`.
- **`getSessionSigner()` returns an adapter that keeps the Node event loop alive**. Every caller must invoke the returned `destroy()` when done. If you add a new top-level command that signs on behalf of the user, wire up the cleanup or the process will hang after the work is done.
- **`dot init --yes` auto-runs at the end of `install.sh`**. The `--yes` flag skips the interactive QR-scan so non-interactive installers (CI, Docker, curl-pipe) don't block. It installs prerequisites and prints "setup complete", then `install.sh` prints a hint to run `dot init` for the full mobile login. If the dep-setup step fails, the exit code is surfaced so CI runs don't silently pass.
- **All chain URLs / contract addresses live in `src/config.ts`**. Never inline a websocket URL or an `0x…` address anywhere else — when mainnet launches we'll be flipping one switch, not grepping the tree.
- **Env model mirrors bulletin-deploy's environment ids**: `preview | paseo-next | paseo-review | paseo-next-v2 | polkadot | kusama`. `ACTIVE_TESTNET_ENV = "paseo-next-v2"` is the only env fully wired today; the rest throw "not supported" from `getChainConfig()`. The deploy command's `--env` flag accepts both the new ids AND legacy `testnet|mainnet` aliases (mapped via `resolveLegacyEnv` — `testnet` → `paseo-next-v2`, `mainnet` → `polkadot`). When adding a second env, populate the entry in `CONFIGS` (`src/config.ts`) and verify the descriptor for that chain exists in `@parity/product-sdk-descriptors` — the `paseo-asset-hub`/`paseo-bulletin`/`paseo-individuality` exports we use today are generated against paseo-next-v2 endpoints + matching genesis hashes (despite the unversioned name).
- **Allowance grant markers live at `~/.polkadot/allowances.json`** (`src/utils/allowances/marker.ts`), mode 0600, sibling to `accounts.json`. RFC-0010 has no on-chain query for allowance status, so we persist `{ env: { ss58Address: { resourceTag: { grantedAt, source } } } }` after a successful host grant. Slot-account private keys for Bulletin / Statement Store live separately in `~/.polkadot/allowance-keys.json` (`src/utils/allowances/slotKeys.ts`), also mode 0600. A marker alone is not enough to skip `dot init` for slot resources — callers must confirm the matching key exists too. Markers and keys are isolated per env so switching networks doesn't accidentally short-circuit re-grants. Keep `source: "host"` as the only value emitted from production code — the type allows `"alice"` for backfill / legacy tooling, but the v2 init flow has no Alice fallback.
- **`requestResourceAllocation` lives in a CLI-local shim** (`src/utils/allowances/host.ts`). `@parity/product-sdk-terminal@0.2.1` does NOT yet re-export the RFC-0010 host call at the package root, but the underlying `UserSession` (from `@novasamatech/host-papp`) exposes `session.requestResourceAllocation()`. We call it directly via the raw session retained on `SessionHandle.userSession`. `@parity/product-sdk-host`'s `requestResourceAllocation` is the in-container variant (uses browser globals like `window.__HOST_WEBVIEW_MARK__`) and won't work from the CLI — don't swap to it. Replace the shim with the SDK call once product-sdk-terminal surfaces it externally.
- **Deploy delegates to `bulletin-deploy` for everything storage-related** (chunking, retries, pool accounts, nonce fallback, DAG-PB, DotNS commit-reveal). We intentionally do NOT reimplement any of that here. The one thing we own is `registry.publish()` — because the contract records `env::caller()` as app owner and that needs to be the user, not a shared dev key. See `src/utils/deploy/playground.ts`.
- **Do NOT call `bulletin-deploy.deploy()` just to store a metadata JSON.** `deploy()` unconditionally runs a DotNS `register()` + `setContenthash()` for whatever name you hand it — and for `domainName: null` it invents a `test-domain-<random>` label and registers THAT. That second DotNS pass reverts cryptically (`Contract execution would revert: 0x…`). For plain storage of the playground metadata we submit `TransactionStorage.store` directly via PAPI (`bulletinApi.tx.TransactionStorage.store({ data })`) using `calculateCid` from `@parity/product-sdk-bulletin` for the content-addressing. The metadata `store` is signed with the product-scoped RFC-0010 Bulletin allowance account cached in `allowance-keys.json`, not the product account signer and not Alice. Asset Hub `registry.publish` is still signed with the user's product account so the registry owner is correct. No DotNS side-trip. See `src/utils/deploy/playground.ts::publishToPlayground`.
- **Build a dedicated Bulletin client with `heartbeatTimeout: 300_000` for the metadata upload.** The shared client from `getConnection()` uses `@parity/product-sdk-chain-client`, which calls `getWsProvider(rpcs)` with no options → polkadot-api's 40 s default heartbeat. A single `TransactionStorage.store` round-trip can exceed 40 s and the socket tears down as `WS halt (3)`. `bulletin-deploy` sidesteps this with its own 300 s heartbeat; we mirror that with a one-off client in `src/utils/deploy/playground.ts` that we destroy immediately after the upload.
- **`dot deploy` does NOT pass `jsMerkle: true` to `bulletin-deploy` right now.** bulletin-deploy's pure-JS merkleizer produces CARs that only contain raw leaves — the DAG-PB directory/file blocks are silently dropped by `blockstore-core/memory`'s `getAll()` under `rawLeaves: true` + `wrapWithDirectory: true`. Proof: a real deployed CAR we fetched from `paseo-ipfs.polkadot.io` contained 157 raw blocks and zero DAG-PB, with the declared root absent → polkadot-desktop parses zero files → sites show `{"message":"404: Not found"}`. Until the upstream merkleizer is fixed we rely on the Kubo binary path (the default), which is reliable. `dot init` installs `ipfs`, so this Just Works for anyone who ran setup. **Trade-off**: this temporarily breaks the RevX WebContainer story for the main storage upload — flip `jsMerkle: true` back once bulletin-deploy fixes `merkleizeJS` to collect all blocks, not just leaves.
- **Signer mode selection lives in one file** (`src/utils/deploy/signerMode.ts`). The mainnet rewrite is a single-file swap; keep that boundary clean.
- **`src/utils/deploy/*` and `src/utils/build/*` must not import React or Ink.** They form the SDK surface that RevX consumes from a WebContainer. TUI code lives in `src/commands/*/`.
- **Bun compiled-binary stdin quirk** — Ink's `useInput` silently drops every keystroke (arrows, Enter, Ctrl+C) in `bun build --compile` binaries unless `process.stdin.on('readable', …)` is touched before Ink's `render()`. We install a no-op `readable` listener at the top of `src/index.ts` as a warm-up. Do NOT remove it until Bun's compiled-binary TTY stdin behaves like Node's. Symptom if this breaks: TUI renders but nothing responds, including Ctrl+C.
- **`bulletin-deploy` 0.7.4+ pulls in a transitive dep with a broken publish manifest** that pnpm refuses to install. `@parity/dotns-cli` (0.6.0 and 0.6.1 both) publishes a `package.json` declaring `"@polkadot-api/descriptors": "file:.papi/descriptors"` — a workspace-only path that doesn't exist in the published tarball. npm tolerates the dangling `file:` reference (creates a broken symlink and continues); pnpm's strict resolver fails with `ERR_PNPM_LINKED_PKG_DIR_NOT_FOUND`. We work around it with a `pnpm.overrides` entry in `package.json` pointing the offending sub-dep at a tiny stub package (`stubs/papi-descriptors-stub/`) so resolution succeeds. The dep is functionally vestigial — dotns-cli's `dist/cli.js` is fully-bundled (Bun build, no externals) and never imports `@polkadot-api/descriptors` at runtime, so the stub exporting `{}` is correct. **Remove the override + stub once `@parity/dotns-cli` republishes a clean manifest.** Tracked upstream against `paritytech/dotns-sdk`. Our direct pin is at the same exact version `bulletin-deploy@0.7.13` declares (`^0.6.1` → `0.6.1`) so both top-level resolution (used by Bun's file-import bundling in `src/dotns-cli-dispatch.ts`) and bulletin-deploy's runtime `_require.resolve("@parity/dotns-cli")` land on the same tarball.
- **`bulletin-deploy` is pinned to an explicit version, not `latest`.** We're on `0.7.20` stable today. The `latest` npm dist-tag is a moving target and previously pointed at 0.6.8, which has a WebSocket heartbeat bug (default 40s < chunk timeout 60s) that tears down uploads mid-flight as `WS halt (3)`. Keep the pin explicit so we never silently slide onto a broken `latest`. When upgrading, read the release notes for any public-API changes to `deploy()`, `DotNS` methods, or the `DeployOptions` we rely on (`jsMerkle`, `signer`, `signerAddress`, `mnemonic`, `rpc`, `attributes`). Note: 0.7.0 removed the `playground?: boolean` `DeployOption` (registry publishing now lives here in `src/utils/deploy/playground.ts`), which is a no-op for us since we never passed that flag. 0.7.1 made the memory-report teardown Bun-safe upstream. 0.7.2 bumped the default `CHUNK_TIMEOUT_MS` 60s → 180s to match Bulletin's new 24s Aura slot duration; `BULLETIN_CHUNK_TIMEOUT_MS` override still works. 0.7.4 extracted the dotns logic into a separate `@parity/dotns-cli` subprocess (forked via `_require.resolve("@parity/dotns-cli")`); see the publish-bug workaround note above. 0.7.4 also moved label classification off the `DotNS` instance — the previously-instance method `dotns.classifyName(label)` is now the top-level pure function `classifyDotnsLabel(label)`, and the result field renamed `requiredStatus` → `status`. The function isn't re-exported from the package root, so `src/utils/deploy/availability.ts` mirrors the (small, stable) logic locally as `classifyLabel` — same precedent as `simulateUserStatus`. 0.7.6 added ambient Sentry mode for host apps; keep the CLI-owned privacy gate in `src/bootstrap.ts`. 0.7.9 includes the DotNS/deploy fixes needed by the CDM E2E path. 0.7.13 added a `--env <id>` selector to the `bulletin-deploy` CLI binary (paseo-next default; preview, paseo-review, polkadot, kusama) plus three additive deploy span attributes (`deploy.env`, `deploy.network`, `deploy.environments_source`); zero behaviour change for library consumers like us — we keep using `--rpc` / `BULLETIN_RPC` precedence and the default endpoint resolves to the same paseo-next WSS as before. 0.7.14 hardens the chunked-storage path against WS-halt allocation storms (issues #142/#216/#287): a per-deploy retry-budget circuit breaker (defaults: 5 events / 30s, tunable via `BULLETIN_RETRY_BUDGET_MAX` and `BULLETIN_RETRY_BUDGET_WINDOW_MS`) bails with a clear `Retry budget exhausted: …` error rather than letting GC fall behind; recovery batch size drops from 2-in-flight to 1-in-flight after the first reconnect; and a synchronous `onStatusChanged(CLOSE|ERROR)` hook destroys the PAPI client before its `activeBroadcasts.forEach` loop can mutate-while-iterating into OOM. Public surface (`deploy`, `DeployContent`, `DeployOptions`, `DeployResult`) is unchanged; the new exports `setWsHaltCallback` / `retryBudgetExhausted` / `isConnectionError` are internal utilities we don't import. Telemetry now sets `deploy.status="ok"` on the success path (we already get `error`/`killed` from #289). The previously-suspect `new Uint8Array(fs.readFileSync(...))` double-wrap is gone (perf-only). Our metadata-upload bypass via PAPI's `TransactionStorage.store` is unaffected — these changes only live inside `storeChunkedContent` / `deploy()`. 0.7.15–0.7.18 are internal hardening / Sentry instrumentation; no public API changes. 0.7.19 added the `paseo-next-v2` environment to `assets/environments.json` (Asset Hub Next paraId 1500, Bulletin Next 1501, People Next System 1502, identity backend at `identity-backend-next.parity-testnet.parity.io`) with `autoAccountMapping: true`, `bulletinAuthorizeV2: true`, `skipDotnsCli: true` (so `deploy()` runs DotNS register/setContenthash directly via on-chain contracts at the v2 addresses rather than spawning the `dotns-cli` subprocess — `dotns-cli@0.6.1` has stable-Paseo addresses hardcoded). The `paseo-next-v2` env flows through `deploy({ env: "paseo-next-v2" })` from `src/utils/deploy/run.ts`; bulletin-deploy reads the env entry to pick endpoints, contract addresses, and feature flags. 0.7.20 (PRs #357 + #369) hardens the v2 path in two ways relevant to us. First, the environment catalog is now embedded into the built JS bundle as a fallback, so `loadEnvironments()` still resolves full v2 metadata (DotNS contract addresses, `autoAccountMapping`, `bulletinAuthorizeV2`, `skipDotnsCli`) when the package's `assets/environments.json` can't be read from disk (Bun SEA contexts, sandboxed deploys, etc.). Second, `DotNS.connect({ autoAccountMapping: true })` now extracts the trigger logic into `ensureAutoMappedAccountReady()`, which on testnets first reads the signer's free balance and, if it's below `FEE_FLOOR_REGISTER` (0.1 PAS), calls `attemptTestnetTopUp(addr, TOP_UP_TARGET=0.5 PAS)` — iterating bare-master ("Alice") then `//Bob` from the standard dev mnemonic with a 1 PAS source-buffer floor — BEFORE submitting the Revive.call auto-map trigger. If mapping still doesn't take, the error message points at `https://faucet.polkadot.io`. The bare-master source is the SAME account our `src/utils/account/bulletinTopUp.ts` uses in `dot init`, so the two flows are aligned: our `dot init` front-loads the top-up at setup time, and bulletin-deploy now does it just-in-time during `dot deploy` for users who skip `dot init`. Both no-op when the recipient is already ≥ 0.1 PAS, so running both back-to-back doesn't double-transfer. Replace `src/utils/account/bulletinTopUp.ts` with the in-SDK call only if bulletin-deploy ever surfaces `attemptTestnetTopUp` at the package root — it's currently an internal method on `DotNS`. 0.7.20 also exports environment helpers from the package root for the first time: `loadEnvironments`, `resolveEndpoints`, `listEnvironments`, `formatEnvironmentTable`, `defaultBundledPath`, `DEFAULT_ENV_ID` (plus matching types `Chain`, `ChainEndpoint`, `Environment`, `EnvironmentListing`, `EnvironmentsDoc`, `EnvironmentsSource`, `LoadOptions`, `LoadResult`, `ResolvedEndpoints`). We don't consume these today (our env table lives in `src/config.ts::CONFIGS`), but they're available if we ever want to drop the parallel config and read v2 endpoints / contract addresses directly from bulletin-deploy's catalog.

### product-sdk 0.5.0 (2026-05-13 workspace release)

- **`@parity/product-sdk-terminal@0.2.1`** ships the PAPI-native signer (#81), unblocking paseo-next-v2's `AsPgas` signed extension. Call sites are unchanged.
- **`@parity/product-sdk-contracts@0.5.0`** makes `QueryResult<T>` a **discriminated union**: callers MUST narrow on `.success` before reading `.value`. On the failure branch `.value` is the runtime's dispatch-error payload (`unknown`). On the success branch `gasRequired` is now non-optional. We apply this in `src/utils/contractManifest.ts::resolveLiveContractAddresses`, `src/commands/mod/AppBrowser.tsx` (failed `getApps.query` → empty list, stop paginating), and `src/commands/mod/SetupScreen.tsx` (failed `getMetadataUri.query` → clear error).
- **`@parity/product-sdk-host@0.3.0`** is a new package exposing `requestResourceAllocation` for in-container apps (browser globals required). We list it as a dep for type reference but **do not import** it from runtime code; the CLI is external to the host container and goes through the `UserSession`-based shim in `src/utils/allowances/host.ts` instead.
- **Throttle TUI info updates** — bulletin-deploy logs per-chunk and builds (vite/next) stream thousands of lines/sec. Calling `setState` on every log event floods React's reconciler with so much backpressure the process can balloon past 20 GB and freeze the OS. `RunningStage` coalesces "latest info" updates to ≤10/sec via a ref + timer and caps line length at 160 chars. Any new hot-path event sink should do the same; don't hook raw per-line streams directly into Ink state.
- **Process-guard safety net** (`src/utils/process-guard.ts`) — deploy pipelines open several long-lived WebSockets + child processes and any one of them can keep the event loop alive after the TUI visibly finishes, turning `dot` into a zombie that accumulates retry buffers indefinitely (seen climbing past 25 GB). We defend in depth: (1) `installSignalHandlers()` catches SIGINT/TERM/HUP + `unhandledRejection` and forces cleanup + exit within 3 s. The `unhandledRejection` handler runs each rejection through `isBenignUnsubscriptionError`, which suppresses three known post-destroy artifacts: rxjs `UnsubscriptionError` wrapping `Not connected`, polkadot-api `DisjointError` from a chainHead unfollow race, and PAPI's `DestroyedError("Client destroyed")` raised when a stray subscription tries to send a final RPC after the lazy client has already been torn down. The 0.2.0 `@parity/product-sdk-terminal::destroy()` fix drains pending unsubscribes — but ONLY when the caller awaits. Our `SessionHandle.destroy()` returns void (so React `useEffect` cleanup can call it), and inside it we do `adapter.destroy().catch(() => {})` — fire-and-forget with the rejection silenced at the source. The source-side `.catch()` is load-bearing: Bun's compiled SEA binary prints `unhandledRejection` events REGARDLESS of any `process.on('unhandledRejection')` listener, so the `isBenignUnsubscriptionError` filter only stops our own additional stderr write — it does NOT stop Bun from printing the rejection itself. The duplicated suppression in `isBenignUnsubscriptionError` covers Node-runtime tests; the `.catch(() => {})` at each `adapter.destroy()` callsite (`src/utils/auth.ts:146,252,268` style) covers Bun runtime. Drop the source-side `.catch()` only once `SessionHandle.destroy()` is fully awaitable end-to-end, or once Bun respects `process.on('unhandledRejection')` in SEA binaries; (2) `scheduleHardExit()` installs an `unref`'d timer that kills the process if the event loop doesn't drain within a grace period; (3) `startMemoryWatchdog()` aborts if RSS exceeds 4 GB — a generous cap because legit deploys on Bun SEA binaries routinely touch 1–1.5 GB from runtime-metadata decoding + Bun's JSC heap + Ink yoga. Do NOT re-add a per-window growth detector: we tried 300 MB / 3 s and it false-positived on the single-burst metadata-loading spike, aborting deploys that would have succeeded. Set `DOT_MEMORY_TRACE=1` to stream per-sample RSS/heap/external stats — useful when diagnosing a real leak report. **Telemetry bootstrap** (`src/bootstrap.ts`) is the FIRST import in `src/index.ts`. It sets `BULLETIN_DEPLOY_USE_AMBIENT_SENTRY=1` and `BULLETIN_DEPLOY_HOST_APP=playground-cli` before `bulletin-deploy` can evaluate, then maps `DOT_TELEMETRY`/internal-context detection to `BULLETIN_DEPLOY_TELEMETRY`. Do not leave `BULLETIN_DEPLOY_TELEMETRY` unset while setting the host app: `bulletin-deploy` treats `playground-cli` as an internal host, which would enable deploy telemetry for external users. `BULLETIN_DEPLOY_MEM_REPORT` is not forced off by default anymore because upstream guards the Bun-incompatible memory-report path. Any new long-running command should register a cleanup hook via `onProcessShutdown()`.
- **Parser MUST NOT emit an event per log line.** `DeployLogParser.feed()` is called for every console line bulletin-deploy prints — hundreds per deploy on the happy path, thousands if retries fire. We intentionally emit events ONLY for phase-banner matches and `[N/M]` chunk progress. Everything else returns `null`. Adding a catch-all `info` emit turns the parser into a firehose that allocates ~200 bytes × thousands of lines, and was a measurable contributor to chunk-upload memory pressure.
- **`dot mod` runs signer-less.** `runModCommand` does not call `resolveSigner` — it gets a read-only handle via `getReadOnlyRegistryContract(rawClient)` (origin = Alice's SS58 derived from `getDevPublicKey("Alice")`) and uses it for both browse + metadata-uri lookup. The `--suri` flag is retained as a deprecated no-op for back-compat. Users can browse and clone moddable apps without first running `dot init` / mapping their account. The signed `getRegistryContract(rawClient, signer)` is used only for `registry.publish.tx(...)` in `src/utils/deploy/playground.ts`. Don't drag a user signer back into `dot mod` — it adds a login + map-account gate before the user has even decided whether to mod the app.
- **`dot mod` is GitHub-tarball-only and must stay that way.** `src/utils/mod/source.ts` downloads from `codeload.github.com` (no auth, no `git`/`gh` required for the public-repo case) and extracts via `node:zlib` + the pure-JS `tar` package. Do NOT re-introduce `git clone` or `gh repo fork` paths — both would re-add a hard tooling requirement and the fork path was specifically removed because GitHub caps you to one fork per source-repo per account, which broke "mod the same starter twice." A non-moddable app (no `metadata.repository`) returns a hard error from `dot mod`; the interactive picker filters those out so the user never sees an unmoddable option. The picker does NOT pre-probe each app's repo visibility, because that would burn the 60 req/hr anonymous GitHub API quota on every `dot mod`. Instead, `runModCommand` lazy-probes the picked app once via `assertPublicGitHubRepo()` between picker dismount and `SetupScreen` mount; `dot deploy --moddable` already rejects private repos at deploy time, so this fires only when a publisher has flipped visibility post-publish.
- **`dot` never invokes `gh`.** `dot deploy --moddable` reads an existing `origin`, validates it's a public GitHub URL via `HEAD https://github.com/{o}/{r}`, and records it in metadata. There is no auto-create path: no `gh` install, no `gh auth status` check, no `gh repo create`. Missing `origin`, private repos, and non-GitHub URLs all hard-fail with actionable messages from `src/utils/deploy/moddable.ts::resolveRepositoryUrl()`. We deliberately do NOT add an interactive `gh auth login` handoff — Ink owns stdout + raw-mode stdin and a `stdio: "inherit"` child would race `useInput` for keystrokes. The user is expected to set up the public GitHub repo themselves before re-running. Do not re-introduce a `gh` dependency or any auto-create path: it tangles `dot` with one source-host's CLI, surprises users with public repos created on their account, and the interactive-auth handoff is a known footgun.
- **`metadata.repository` is set ONLY when `--moddable` is opted in.** Older code in `publishToPlayground` would silently probe `git remote get-url origin` and stuff whatever it found into the metadata, which surprised users who didn't realise their fork was being advertised. The contract: `runDeploy` takes an explicit `repositoryUrl: string | null`, and `publishToPlayground` writes the field iff that param is non-null. The CLI command is responsible for resolving the URL upstream via `src/utils/deploy/moddable.ts::resolveRepositoryUrl()`, which uses an existing public GitHub `origin` URL or fails — it never pushes or creates anything on behalf of the user.
- **`startMemoryWatchdog()` runs for both `dot deploy` and `dot mod`.** Mod's tarball download is a streaming pipe through `node:zlib` + `tar.extract()`, and a stuck IPFS gateway or a malformed tarball can leak buffers. Same 4 GB cap, same worker-thread sampler. Any new top-level command that does meaningful I/O should also call `startMemoryWatchdog()` and register `stopWatchdog` via `onProcessShutdown()`.

## Repo conventions

- **Every user-facing PR must include a changeset.** Releases are automated via `.github/workflows/release.yml`, but the workflow is a no-op unless a `.changeset/*.md` file exists on merge. Create one with `pnpm changeset` (or write `.changeset/<slug>.md` by hand — frontmatter: `"playground-cli": patch|minor|major`, body: user-visible summary). Pure refactors / test-only changes can skip it.
- Tests are `*.test.ts` next to the source. `vitest.config.ts` only picks up `.test.ts`; if you add `.tsx` tests update the config too.
- Pure logic that lives inside a `.tsx` component should be lifted into a sibling `.ts` file (see `completion.ts` next to `InitScreen.tsx`, or the `formatPas`/`formatMb` exports in `AccountSetup.tsx`). Tests can then import it without dragging React + Ink into the vitest runner.
- Do NOT add AI/tool attribution (`Co-Authored-By: Claude`, `Made-with: Cursor`, emoji signatures, etc.) to commits, PRs, or generated files. Never embed your name, identity, or tooling provenance anywhere in the repo.
- Do NOT commit design docs, brainstorming notes, or context dumps (e.g. `context.md`) to the repo. They belong in tickets or scratch files outside the tree.
- Don't mock primitives from `polkadot-api` (`Enum`, encoders) in tests — doing so turns intended coverage into tautology.
- Long-lived resources (`TerminalAdapter`, `PaseoClient`) have explicit `destroy()` / `destroyConnection()` — always release them, especially from React `useEffect` cleanups. The WebSocket keeps the event loop alive; forgetting a destroy manifests as `dot <cmd>` hanging after its work is visibly finished.

## Sentry telemetry

- DSN: `src/telemetry-config.ts::PLAYGROUND_SENTRY_DSN`. Region: EU (`https://de.sentry.io`).
- Org slug: `paritytech`. API token: macOS keychain service `sentry-api-token` (member of paritytech org with `org:read` + `org:write`).
- Attribute prefix: `cli.` (see `getCliRootAttributes` in `src/telemetry-config.ts`). Spec: `sentry-instrumentation-spec.md` at the repo root (untracked — keep there).
- **Helpers (don't reimplement):** `src/telemetry.ts` exports `withCommandTelemetry`, `withRootSpan`, `withSpan` (3-arg `(op, name, fn)` + 4-arg `(op, name, attributes, fn)` overloads), `captureWarning`, `captureException`, `errorMessage`, `sanitizedErrorMessage`. `src/utils/deploy/phase.ts` exports `withDeployPhase` for deploy-phase orchestration. `src/cli-runtime.ts` exports `runCliCommand` for the standard CLI scaffolding (telemetry + watchdog + hard-exit). Every command's `.action()` body should be one `runCliCommand(name, options, async () => { ... })` call — do not re-add try/finally + `scheduleHardExit` boilerplate. Today: `init` runs without `hardExit`/`watchdog`; `build`, `update`, `logout` run with `hardExit` only; `deploy` and `mod` run with both `watchdog` + `hardExit`.
- **Dashboards** live as JSON snapshots under `sentry/dashboards/<id>.json`:
  - `2143100.json` — **Playground CLI Health** (production filter `!cli.tag:e2e-*`).
  - `2216067.json` — **Playground CLI Failures** (per-error-type drill-downs).
  - `2216096.json` — **Playground CLI E2E Health** (inverse filter, `cli.tag:e2e-*`).
- **Workflow:** run `./sentry/backup-dashboards.sh` BEFORE any change. Use `./sentry/patch-dashboard.py <id> <patch.json>` for surgical edits (supports `replace`, `patch_query`, `set_description` ops) or full widget replacement. Use `./sentry/create-dashboard.py <payload.json>` for new dashboards. Per spec §15f, do NOT include a `projects` field in POST payloads. Per spec §15g, PUT replaces the whole widget list — backup first.
- **E2E tagging:** every spawn from `e2e/cli/helpers/dot.ts` injects `DOT_TAG=e2e-local` (fallback), `DOT_TELEMETRY=1`, and `DEPLOY_TAG=e2e-cli-local` (derived from `DOT_TAG` with an `e2e-cli-` prefix). `tools/e2e-local.sh` overrides `DOT_TAG` to `e2e-local-{smoke|pr|nightly}`, which makes `DEPLOY_TAG` become `e2e-cli-local-{smoke|pr|nightly}`. CI sets `DOT_TAG=e2e-ci-{pr|nightly|dispatch}`, making `DEPLOY_TAG=e2e-cli-ci-{pr|nightly|dispatch}`. The `e2e-cli-` prefix on `DEPLOY_TAG` distinguishes playground-CLI E2E traffic from bulletin-deploy's own E2E suite (which uses bare `e2e-*` tags) in bulletin-deploy's telemetry dashboards. Production health widgets filter cleanly via `!cli.tag:e2e-*` (playground-CLI's Sentry) and `!deploy.tag:e2e-*` (bulletin-deploy's Sentry).
- **SAD% propagation** is verified by a regression test in `src/telemetry.test.ts` ("SAD% propagation through transaction envelope"). It confirms `captureWarning` flips `cli.sad="true"` on the root transaction. If that test fails, the SAD% dashboard widget on Dashboard 1 will silently degrade to a duplicate of the unexpected-failure rate.

## E2E Tests

- **Local launcher:** `tools/e2e-local.sh [smoke|pr|nightly]` — also callable via `pnpm test:e2e:smoke`, `pnpm test:e2e:pr`, `pnpm test:e2e:nightly`.
- **CI workflow:** `.github/workflows/e2e.yml` — runs on PR / push:main / cron 06:00 UTC / workflow_dispatch.
- **CI matrix:** 13 cells across four matrices — `test-no-publish` (parallel: pr-install, pr-preflight, pr-mod, pr-init-session) + `test-publish` (max-parallel: 1: pr-deploy-frontend, pr-deploy-foundry) + `test-nightly-no-publish` (parallel, schedule/dispatch only: nightly-mod-miss, nightly-diagnostic, nightly-rejections, nightly-chaos-sigint) + `test-nightly-publish` (max-parallel: 1, schedule/dispatch only: nightly-deploy-hardhat, nightly-deploy-multi, nightly-chaos-rpc). Each cell runs a subset via `vitest -t "<pattern>"`.
- **Release smoke:** `.github/workflows/e2e-release.yml` fires on `release: prereleased`, downloads the `dot-linux-x64` SEA asset, and runs `e2e/cli/published.test.ts` against it. Validates the published binary before stable release.
- **Post-release smoke:** `.github/workflows/e2e-post-release.yml` fires on `release: published` (stable only — `prerelease != true`), waits for the SEA asset, runs `install.sh` (consumer install path via `VERSION=<tag> curl … | bash`), then runs `published.test.ts` against the installed `~/.polkadot/bin/dot`. Catches `install.sh` regressions that the prerelease/SEA-download path doesn't.
- **Test files:** `e2e/cli/*.test.ts` (vitest, spawned via `bun run src/index.ts`).
- **Reports directory:** `e2e-reports/junit.xml` + `e2e-reports/dot-runs.log` (gitignored).
- **Tag prefix:** `DOT_TAG=e2e-{ci|local}-{trigger}` so Sentry dashboards filter test traffic. The CLI plumbs `DOT_TAG` into the `cli.tag` root-span attribute via `src/telemetry-config.ts`.
- **CI report job name:** `E2E Report` — aggregates per-leg conclusions, posts a sticky PR comment with marker `<!-- e2e-pr-report -->`, opens an auto-issue on schedule/release fail.
- **Running tests:** see `docs/e2e-running-tests.md` for the full guide — local modes, vitest passthrough, reading results, GitHub triggers, and common operations FAQ.
- **Bootstrap:** see `docs/e2e-bootstrap.md` for the maintainer-facing setup + recovery procedures. The tool itself is `tools/register-e2e-fixtures.ts`.
- **Cleanup cron:** `.github/workflows/e2e-cleanup.yml` runs Sunday 04:00 UTC. Stub today; will sweep rotating moddable state when Phase 5e ships.
- **Design spec:** `docs-internal/2026-05-02-e2e-test-suite-design.md`.

---

# Product context: playground.dot

Source: Playground Full Spec v0.12, May 2026. TL: Ionut. PM: Rebecca. Team: Charles, Utkarsh, Todor, Reinhard, Sveta (Designer), Karim (Dept Head), RevX team (parallel workstream). LGTMs: Karim / Gav / Pierre. Kanban: https://github.com/orgs/paritytech/projects/278. The summary below captures the mechanics that affect frontend / contract / CLI decisions.

## What playground.dot does, end-to-end

playground.dot is a mobile-first quest platform for the Web3 Summit Developer Lab (18–19 June 2026, Berlin). A developer arrives at the venue, scans a QR or visits the URL, picks a tutorial or sample app, mods it with AI assistance, and deploys their own version live on Polkadot Hub — target time-to-deploy is about thirty minutes from a cold start, with no prior Polkadot experience.

The "definition of done" for V1 is exactly that loop: open → tutorial → live deployed app on Polkadot Hub, in about thirty minutes, by a developer who's never touched Polkadot before. The app must be reliable and performant.

**V1 is the only active build target.** V2 and beyond are directional ideas — do not implement unless a specific issue or PR explicitly requests it.

## App structure: three tabs

The playground-app has three tabs (not a single "registry browser"). All three are V1 scope:

| Tab | Purpose |
|---|---|
| **Playground** | Quest-forward onboarding. Tutorial hero, sample apps, how it works, ideas to try, leaderboard |
| **Apps** | Registry browser. All deployed apps, search, category filters, sort options, featured section |
| **Profile** | Personal hub. Deployed apps, starred apps, rank, storage info, name |

**Tab naming:** the registry tab is **"Apps"** — **not** "dAppStore", "store", or "dApp store". Pinning badge is **"Pinned"** — **not** "Staff pick".

## Key repositories

| Repo | URL | Purpose |
|---|---|---|
| Playground app | https://github.com/paritytech/playground-app | Registry browser + Playground tab + Profile |
| Playground CLI (this repo) | https://github.com/paritytech/playground-cli | DOT CLI |
| Tutorial (The Stadium / RPS) | https://github.com/paritytech/Rock-Paper-Scissors | Rock Paper Scissors, 4 levels |
| Empty/starter template | https://github.com/paritytech/playground-app-template | Blank-canvas starter |
| Product SDK (Parity) | https://github.com/paritytech/product-sdk | Publishes `@parity/product-sdk-*` |
| triangle-js-sdks (Nova Spektr) | https://github.com/paritytech/triangle-js-sdks | Publishes `@novasamatech/host-api` + `@novasamatech/product-sdk` (TrUAPI low-level transport) — separate from the Parity Product SDK |
| Attestation Protocol | https://github.com/paritytech/attestation-protocol | Polkadot Attestation Protocol — used for stars/ratings in V2 |

## How the pieces fit together

This CLI is one of several components. The user-visible flow stitches together other components owned by other teams:

| Component | Owned by | Role in the flow |
|---|---|---|
| **playground-app** | Frontend / contract team | Three tabs (Playground / Apps / Profile), App Detail Page, publish pipeline |
| **DOT CLI** (this repo, `dot` binary) | CLI team | Local IDE path: `dot init`, `dot mod`, `dot build`, `dot deploy --playground`, `dot logout`, `dot update` |
| **RevX** | Leo / RevX team | Browser IDE; opens via deep-link `revx.dev/editor?mod=<domain>` (no quest param — level picker lives inside RevX) |
| **Tutorial** | Todor | The single structured tutorial (Decentralised Rock, Paper, Scissors, 4 levels, ~30 min) — separate template repo |
| **Sample apps** (~4 for V1, ≥10 for V2) | Various, TBC | Each is its own repo with `setup.sh`, `.claude/skills/`. The Ballot is the first. **No `quests.json`** — quest ideas live in the README |
| **`@parity/product-sdk-*` (Product SDK)** | Parity platform team | All chain interactions go through these packages. Parity-maintained, dapp-facing. Depends at runtime on Nova Spektr's `@novasamatech/host-api` + `@novasamatech/product-sdk` (TrUAPI), published from `paritytech/triangle-js-sdks` — separate Nova project, not a rebrand. This CLI is fully on `@parity/product-sdk-*`; `@polkadot-apps/*` is gone (see Non-obvious invariants for guard details) |
| **Bulletin Chain** | Bulletin / infra | Decentralised storage for app metadata, icons, frontend assets. Mainnet live 7 May 2026 |
| **DotNS** | DotNS team | `.dot` domain reservation during publish |
| **Polkadot app + PoP** | Mobile app team / Gav | Sign-in via QR scan; provisions session keys; PoUD/PoP enable PGAS claims |

## Network

**Current network:** Paseo Next v2 (`ACTIVE_TESTNET_ENV = "paseo-next-v2"` in `src/config.ts`). The earlier PreviewNet stop has been completed; the three-stage transition language is retired.

**Summit network:** the event itself runs on a **Summit-specific closed devnet** operated by Parity. All participants get pre-allocated allowances — **no storage or PGAS constraints during the event**. The devnet switches off at the closing ceremony and apps cease to exist. Communicate this clearly in pre-event comms, deploy flow, and on the day. "Save your repo to GitHub" is the consistent message throughout.

**Don't hardcode** "PreviewNet" or "Paseo Next v2" as the permanent network — the Summit devnet is a separate deployment. The chain-config-in-one-file invariant (`src/config.ts::CONFIGS`) keeps the Summit devnet swap to a single switch.

**Storage in production** (outside the Summit devnet): Bulletin storage is time-limited and requires renewal. Frame this as a feature, not a limitation — time-bound deployments encourage active curation, and renewal is how you signal an app is still worth keeping alive.

## PoP auth + session key model

Sign-in is **never** described as "wallet" in the product — it's an **account**. The flow:

1. User taps sign-in → desktop shows a QR; mobile triggers the Polkadot app directly.
2. Scanning authenticates via PoP (Proof of Personhood) and creates a **session key** locally.
3. The session key is **pre-loaded** via a single `host_request_resource_allocation([BulletinAllowance, StatementStoreAllowance, SmartContractAllowance])` call: one authorisation dialog, then the session flows without interruption.
4. From that point until logout, the publish flow + on-chain interactions are signed by the session key. The user is never asked to top up, fund, or manually acquire tokens.

A brief QR scan explanation is shown before sign-in: "You'll need the Polkadot App on your phone — this is how you prove you're a real person."

`dot logout` (CLI) signs out, notifies the mobile app, and cleans up the local session.

The CLI must not present fee-acquisition UX — the session key model means fees are invisible to the user. If you find yourself designing a "buy tokens" or "top up" flow, something has gone wrong upstream.

**Session keys confirmed KEEP for Summit.** Reasons: without them every on-chain action needs phone approval (3–5+ per publish); mobile signing has had reliability issues; batching breaks PGAS; the RevX browser path needs them for signing without constant phone round-trips.

## PGAS and fees

**PGAS (People Gas)** is a burnable sufficient asset on Asset Hub that covers all playground on-chain actions — DotNS registration, registry calls, contract deploys, star/unstar, visibility toggle. Claimed via a ZK ring-VRF proof of personhood — privacy-preserving, sybil-resistant, no prior token ownership required.

**Confirmed values (PR #880, merged 4 May 2026):**
- Lite PoP / PoUD: 40 claims/day × 0.005 DOT = 0.2 DOT/day
- Full PoP: 100 claims/day × 0.005 DOT = 0.5 DOT/day
- PGAS pegged 1:1 to DOT for fee payment

**Budget is sufficient:** ~180–200 transactions across 2 days for an active developer needs ~0.2 DOT — comfortably inside the Lite PoP 2-day budget (0.4 DOT).

**PoUD → PGAS flow:** downloading the Polkadot App automatically grants PoUD → can claim PGAS via the mobile app. `host_request_resource_allocation([SmartContractAllowance])` at session start → phone submits v5 claim → PGAS in product account → all transactions paid automatically.

**Claim path vs spend path:** PGAS claiming is **v5 extrinsic only** — the mobile app handles it, not the CLI/Product SDK. Spending PGAS is v4 and works everywhere. **Batching transactions breaks PGAS fee payment** — the publish flow must remain as sequential individual transactions.

**Summit devnet:** allowances are pre-allocated. PGAS and storage constraints are **not operational concerns during the event**. Vouchers, soft-limit messaging, Bulletin expiry countdown UI, and `dot voucher` are all **removed from V1**. Don't reintroduce.

## The publish flow (5 steps, all paid by the session key)

| # | Step | CLI / UI message |
|---|---|---|
| 1 | Upload frontend assets + metadata to Bulletin | "Uploading to Bulletin..." |
| 2 | Reserve `.dot` domain on Polkadot Hub | "Registering your .dot domain..." |
| 3 | Register on the playground registry | "Publishing to playground registry..." |
| 4 | Link app to user account | "Linking to your account..." |
| 5 | Share — generate a shareable link | "Your app is live!" |

Per-step plain English error messages — never hex revert codes. Retries are safe: Bulletin uploads deduplicate by content, DotNS skips if already owned, registry updates existing entry. Re-deploys show "Updating myapp.dot" not "Publishing myapp.dot".

**Account switch during publish:** if user switches accounts mid-publish, abort with `Account changed mid-publish — please re-run from the new account`.

**Publish validation (V1):** domain uniqueness (enforced at the DotNS contract level — first on-chain transaction wins) and required fields (domain, metadata). **Image format/size limits deferred to V2.**

**Post-deploy CLI output (V1 target):**
- Live URL (`yourapp.dot.li`) as clickable deep link
- Playground detail page link (`playground.dot/app/yourapp.dot`)
- **Primary CTA:** "Share your app — let others mod it" → copies the playground detail page link
- **Sovereignty line:** "Your app is live on Bulletin Chain, registered on Polkadot Hub, accessible at yourapp.dot.li. Nobody controls this but you."
- **Name reveal:** "You're live as swift-cosmic-builder. Change your name in playground.dot → My Profile."
- **Moddable nudge:** "Make your app moddable — connect your GitHub repo so others can build on your work, and so you keep your code after the Summit ends."
- **Docs link:** "Learn more about building on Polkadot → [docs link]"

**Star prompt after mod deploy moved to Stretch** in v0.12 — was V1, now deferred. Not shown in V1 CLI/RevX.

## Content tiers in the registry

Three tiers all live in the same contract; the frontend differentiates them via pinning + App Detail Page variant.

**Tier 1 — The Stadium tutorial.** One repo (https://github.com/paritytech/Rock-Paper-Scissors), one app entry, pinned.

| Level | Name | Scope | XP | Mobile |
|---|---|---|---|---|
| 1 | Local Challenger | Mod UI/theming. No contract changes | 25 | ✅ |
| 2 | On-Chain Record | Save game results to Bulletin | 25 | Possibly via RevX (no contracts) — pending RevX-mobile confirmation |
| 3 | The Leaderboard | Deploy leaderboard smart contract | 25 | ❌ laptop required |
| 4 | Multiplayer | P2P via Statement Store. Challenge via link/QR | 25 | ❌ laptop required |

Total **100 XP** across the four levels.

**Fixes still pending in the RPS repo's `quests.json`:** XP shows 50/100/150/200 = 500 — must be 25/25/25/25 = 100. Tutorial time shown 90m — must be ~30 min. Confirm both with Todor.

**Tier 2 — Sample apps (~4 for V1, ≥10 for V2).** Each is its own repo, pinned. **No `quests.json`** — quest **ideas** live in the README. 10 XP awarded per first deploy per new domain. Re-deploys to the same domain don't re-award.

**Candidate sample apps** (full list — Rebecca actively commissioning; The Ballot is confirmed V1):

| App | Description | Key Polkadot stack | Verticals |
|---|---|---|---|
| **The Ballot** *(confirmed V1)* | PoP-gated polling | Smart contracts, PoP | governance / social |
| Dot.link | Decentralised link-in-bio on .dot | Bulletin, DotNS | personal / identity |
| Kudos | Permanent signed peer recognition | Smart contracts, PoP, account-to-account | social / professional |
| Countdown | Unstoppable event countdown tied to block height | Bulletin, DotNS, block timing | personal / creative |
| Proof Board | Signed permanent statements | Bulletin, Statement Store, PoP | social / censorship-resistance |
| Shout | Anonymous PoP-verified message board | PoP anonymity, Statement Store | social / identity |
| Pact | Public on-chain promise between two PoP accounts | Smart contracts | social / games |
| Signal | Anonymous human-verified survey via ZK PoP | ZK PoP, Statement Store | governance / identity |
| Squads | On-chain group formation with PoP membership | Smart contracts, PoP, multi-account | social / community |
| Collab | Shared docs with signed attributed edits | Smart contracts, Bulletin, PoP | productivity / creative |
| Timelock | Message sealed until future block height | Smart contracts, block timing | games / creative |
| Chronicle | Personal blog on .dot signed with PoP | Bulletin, DotNS, PoP | personal / creative |
| Minimarket | Decentralised classifieds on .dot | Bulletin, DotNS, Statement Store | commerce / social |
| Flipside | Two-sided PoP-gated debate/vote | Smart contracts, PoP voting | governance / community |
| Reputation | Mutual PoP endorsements (attestation) | Attestation protocol, PoP | professional / identity |

**Recommended V1 priorities (fastest to build):** Dot.link, Kudos, Countdown, Proof Board — alongside The Ballot.

**Sample app spec (V1):**
- Start from `playground-app-template` — not from scratch. Wait for app#101 (generic Product SDK skills in template) to land before commissioning.
- Required files: **README** (what it does, what makes it interesting, quest ideas, SDK packages used, key files, "what you just built" explanation), `setup.sh` (idempotent, prints `[setup] doing X...`, fails with actionable errors), `.claude/skills/app-context.md` (~10 lines), generic Product SDK skills via app#101.
- **No `quests.json` for sample apps.**
- Must be moddable (public GitHub repo required). Naming convention: `sample-[appname]-app`.
- **Size limit: one Bulletin chunk (~10MB, TBC with Bulletin team).** Compress images, slim the bundle.
- Use at least one element of the Polkadot product stack beyond DotNS.
- Must work on the active V1 network.

**Tier 3 — Participant apps.** Everything modded and deployed by Summit attendees, growing throughout the event. Shown below pinned items.

**Empty/starter template** (https://github.com/paritytech/playground-app-template) is **pinned alongside** the tutorial and sample apps for blank-canvas builds.

## XP and stars

Two separate concepts that are easy to conflate. Points are renamed to **XP** throughout V1 (aligns with Sveta's design).

**XP = leaderboard score (Top Builders).** Stored on-chain as a per-account running balance — consistent across all devices and venue screens in real time. XP only ever goes up.

| Action | XP | Notes |
|---|---|---|
| Tutorial level completed | 25 | Max 100 total. Once per `(account, track_id, quest_id)` — prevents farming by redeploying same level to different domains |
| New app deployed | 10 | First deploy per domain only. Re-deploys to same domain = update, no additional XP |
| Star received | 10 | Per star awarded to your app |
| **Someone mods your app** | **25** | **New in v0.12** — strongest signal, effort-based endorsement. Tracked via `mod_count` |

Sample apps award 10 XP per first deploy per domain only — **no quest-based XP**. Quest ideas in the README are inspiration, not a scoring mechanism.

**Stars = what users *award* to other apps.**
- **Binary vs max-2-stars decision pending this week.** Either way: cumulative total displayed (never as average X.X / 5), **one-way** (for 2-star: can update 1→2 but cannot remove), self-starring forbidden at contract level, **unlimited** (no per-user allocation cap — that "Stars to give: N" pattern is explicitly rejected as engagement-killer).
- Each star earns the app's owner +10 XP.
- Stars also serve as personal favourites.

**Leaderboard (now V2 in v0.12 — was V1):** the **Top Builders by XP** leaderboard UI moved from V1 to V2 in the latest spec. The underlying on-chain XP balance is still V1 — venue screens can read it directly. "Most modded" and "most starred" **sort options on the Apps grid also moved to V2**.

**Tutorial completion verification (V1):** XP awarded on deploy automatically. For prize purposes (~$2k prize pool), event admins manually verify top-leaderboard participants completed the tutorial before awarding.

## RevX deep-link contract

`revx.dev/editor?mod=<domain>`

- `mod=<domain>` — required. The .dot domain of the source app to clone.
- **No `&quest=` param.** Level/quest picker happens **inside RevX**. **Single "Open in RevX" button per app** — applies to tutorial, sample apps, and participant apps alike.

RevX downloads the source as an HTTPS tarball — same as the CLI — so no git or `gh` is required to start. After load: PoP auth (QR on desktop, direct on mobile), AI chat pre-loaded with the template's `CLAUDE.md` + Product SDK skills, and a CLI bridge that maps RevX UI actions to `dot build`, `dot deploy --playground`.

⚠️ **Web container constraint:** the RevX browser web container is Node/TS/JS only — cannot run the IPFS binary. The CLI's current Kubo-binary path (see invariant on `jsMerkle: false`) is the constraint here — until bulletin-deploy's pure-JS merkleizer is fixed, RevX's main storage upload story is blocked.

GitHub login in RevX is currently deactivated pending security review. Without it, apps deployed from RevX are non-moddable by others (the source URL isn't published).

## CLI deep-link contract (`dot mod`)

The CLI's `dot mod` command downloads the source as an **HTTPS tarball** — no git, no `gh`, no clone. Forms:

- Interactive picker: `dot mod` (lists moddable apps only)
- Direct: `dot mod <domain>`

After download, `setup.sh` runs and its output is kept visible/logged. `dot mod` also writes the source domain to a local metadata file — passed at deploy time so the registry can store "Modded from: [domain]". **Modded-from metadata capture is not yet built** (V1 P0).

Subsequent commands: `dot build` (auto-detects Rust/Solidity/EVM contracts + frontend, picks the package manager, installs if missing), `dot deploy --playground` (full 5-step pipeline, **should default to moddable** — current code defaults non-moddable, needs fixing).

`dot init` covers first-time setup. Dependencies install in parallel: the Rust chain (rustup → Rust nightly → rust-src → cdm) is sequential due to hard dependencies, but IPFS, foundry, and git run concurrently. Estimated saving: ~3 minutes on a fresh machine — not yet built. Then: PoP QR auth, session key creation. **No voucher prompt** — vouchers are removed from V1.

**CLI command naming open question:** `dot x` vs `play-dot x` vs `playdot x` — decision needed before on-site materials are printed.

## Moddable default flow

`dot deploy --playground` **should default to moddable** (current code defaults non-moddable — bug, needs fixing). Full guided flow (spec-level UX intent):

1. CLI checks `gh` auth + existing public repo.
2. **Repo found** → deploy as moddable automatically.
3. **No repo** → prompt: "Make your app moddable so others can build on it? (recommended) [Y/n] — requires GitHub".
4. If Y → "This needs a GitHub repo. Want us to create one for you? (requires gh CLI installed and logged in) [Y/n]". If Y → `gh auth login` if needed → user-initiated repo create → push → deploy as moddable.

**Important CLI invariant** (already enforced — see `src/utils/deploy/moddable.ts`): the CLI **never invokes `gh`**. `resolveRepositoryUrl()` reads existing `origin`, validates it's a public GitHub URL, and records it in metadata. There is no auto-create path; missing `origin` / private repos / non-GitHub URLs all hard-fail with actionable messages. The spec's "guided flow" above describes the intended UX in playground-app — the CLI's contract is stricter and stays user-initiated.

GitHub login is **NOT required** to deploy. Non-moddable apps still get DotNS + Bulletin links — they just can't be cloned by others.

## quests.json shape (tutorial only)

In v0.12 **only the tutorial** ships a `quests.json`. Sample apps no longer have one — quest ideas live in the README.

**Schema:**

```json
{
  "schema_version": 1,
  "track_id": "unique-track-id",
  "title": "App Name",
  "description": "Brief description",
  "total_points": 100,
  "quests": [
    {
      "id": "quest-id",
      "title": "Quest Title",
      "difficulty": 1,
      "estimated_minutes": 15,
      "branch": "quest/branch-name",
      "required_tools": ["dot-cli"],
      "ai_skill_hints": [".claude/skills/skill-file.md"],
      "points": 25,
      "teaches": ["concept 1", "concept 2"],
      "summary": "What the developer will do and mod",
      "acceptance": ["Specific, testable criterion 1", "..."]
    }
  ]
}
```

The tutorial repo also ships a `setup.sh` and a `.claude/skills/` directory. **app#101 (In Progress)** copies the generic Product SDK skills into all templates and sample apps automatically.

## Product SDK packages

The product treats this as Polkadot's equivalent of viem + wagmi. All chain interactions go through these. **Two distinct repos to keep straight:**
- **`paritytech/product-sdk`** (private) publishes `@parity/product-sdk-*` (signer, contracts, bulletin, chain-client, tx, keys, host, storage, statement-store, address, descriptors, terminal, logger, utils, etc.). Parity-maintained, dapp-facing, supersedes `@polkadot-apps/*`. **This CLI is fully migrated** to product-sdk — see the Non-obvious invariants section for the CI guard that prevents `@polkadot-apps/*` re-imports, the caret-range pin model, and load-bearing overrides.
- **`paritytech/triangle-js-sdks`** (public POC) publishes `@novasamatech/host-api` and `@novasamatech/product-sdk` (TrUAPI low-level transport). **Not** a rebrand of the Parity SDK — a separate Nova-Spektr project.

TrUAPI v0.3 — changes TBC. Watch for breaking changes.

## V1 feature scope (CLI-relevant)

CLI / DevX features that are P0 / P1 for V1:

- `dot init` — first-time setup, QR auth, session key, dependency install
- `dot init` — parallelised dependency install (IPFS/foundry/git parallel to Rust chain — ~3 min saving). Not yet built.
- `dot mod` — HTTPS tarball download (no git/gh required), interactive picker, source-domain capture for modded-from metadata
- `dot build` — auto-detects Rust/Solidity/EVM contracts + frontend
- `dot deploy --playground` — full 5-step pipeline; **must default to moddable** (bug — current default is non-moddable)
- `dot logout`
- `dot update` (works via npm for RevX)
- Plain English error messages for all common on-chain failures (see UI Copy section in the spec for the full replacement table — covers `--moddable` errors, DotNS validation, mobile signing, funder exhaustion, resource allocation, cdm/forge build failures, etc.)
- Modded-from metadata capture in CLI (`dot mod` writes source domain) — not yet built, V1 P0

**Removed from V1 (do not reintroduce):**
- `dot voucher <code>` command
- Conditional voucher prompt at `dot init`
- Soft-limit communication
- Bulletin expiry countdown / two-week expiry narrative

## Go / No-Go criteria (CLI-relevant)

**Hard blockers** (Summit cannot proceed without these):
1. End-to-end flow: `dot mod` → edit → `dot deploy --playground` → appears in registry (Internal test pass — app#36)
2. RevX path works end-to-end via the CLI bridge: deep-link → auth → edit → deploy → appears in registry
3. The Stadium — all 4 levels deployable
4. Mobile: Level 1 completable end-to-end on phone (Android + iOS)
5. Security review passed — no critical or high findings outstanding
6. Internal 30-minute test pass completed (app#36)
7. Summit devnet confirmed operational and stable

## Directional ideas (V2 / V2.5 / Stretch) — CLI-relevant items

- **V2:** `dot preview` (local preview before deploy — equivalent to `npm run dev`), lazy dependency installation (only install what current level needs), `dot deploy` defaulting to `--playground` (open question), CDM → cargo-pvm migration (Charles owns).
- **Stretch:** star prompt after mod deploy (moved from V1).

## Out of scope (per spec)

- Building from scratch (entry is always tutorial / sample app / empty starter)
- Multiple tutorial tracks (The Stadium is the only one)
- DeFi quests (regulatory)
- Permanent deletion by owners (visibility toggle only)
- Account creation outside the Polkadot app / PoP flow
- Contract-modding on mobile (Level 1 / UI-only quests on phone)
- Chat Extensions sharing (descoped)
- **Vouchers / `dot voucher` / soft-limit messaging / Bulletin expiry countdown UI** — all removed in v0.12
- **Account status component (#67)** — parked, confirmed intentional given the devnet
- DOT airdrop as a W3S mechanism (stale)

## Vocabulary the product uses

The product is consistent about its language. CLI output, error messages, and command names should follow:

| Concept | Term used | Avoided |
|---|---|---|
| Taking on a challenge | accept a quest / join a quest | "try", "attempt", "do" |
| Modifying an app | mod (verb and noun) | "remix", "fork", "clone" |
| The modified version | your mod / your app | "your fork", "your remix" |
| Full deploy + publish | `dot deploy --playground` | "dot ship" |
| Publishing to the registry | deploy / publish | "submit", "upload", "release" |
| The structured tutorial | tutorial / The Stadium | "tutorial track", "tutorial quest" |
| Open-ended modding challenge | quest idea | "hackathon", "challenge" |
| Working apps with quest ideas | sample apps | "templates", "starter apps" |
| User identity | account | "wallet" |
| Deployment network | Polkadot Hub | "mainnet" (sparingly), "Paseo" never in user-facing copy |
| Host ↔ product transport layer | TrUAPI | "TruAPI", "Host API", "triangle-js-sdk", "host-api" |
| App others can mod | **moddable** (two d's) | "modable" (one d — wrong) |
| Leaderboard score | **XP** (renamed from "points") | "points" (legacy term) |

**Plain English error messages:** the spec includes complete replacement tables for **all** current CLI error strings — refer to the UI Copy section in the playground-app CLAUDE.md (or the spec directly) before adding/changing any user-facing CLI error.

## Timeline (for context)

| Phase | Target | Scope |
|---|---|---|
| Phase 0 — Foundation | ~~18 Apr 2026~~ (passed) | CLI built. RevX deep-link agreed. Tutorial stubs |
| Phase 1 — V1 Complete | ~~2 May 2026~~ (in progress) | Core flow. ~4 sample apps. Full publish flow. Internal test pass |
| Phase 2 — V1 Audit + V2 Build | 3–16 May 2026 | Internal audit on V1 contract. V2 build in parallel |
| Phase 3 — V2 complete | 17–31 May 2026 | V2 integrated. V2.5 + Stretch only with clear runway |
| June buffer | 1–17 Jun 2026 | Venue setup, demo station prep, dress rehearsal (~9 Jun) |
| Event | 18–19 Jun 2026 | Web3 Summit Developer Lab, Berlin |

**Hard constraints:** V1 contract freeze ahead of audit. Everything done **31 May 2026**.

**Testing sessions:**
- 20 May 2026: Session 02 — Deeper Dive (Playground, getlocal, Wire)
- 3 June 2026: Session 03 — Final Regression Check

## Open questions worth knowing (parking lot)

- **CLI command naming:** `dot x` vs `play-dot x` vs `playdot x`. Decision needed before Summit.
- **Star system:** binary vs max 2 stars. Decision expected this week.
- **`(account, track_id, quest_id)` uniqueness:** confirm `quest_id` is level-scoped (not domain-scoped) to prevent tutorial farming.
- **TrUAPI v0.3:** what's changing that affects playground?
- **Session key PGAS sizing:** confirmed to cover full 2-day Summit?
- **RevX mobile capability:** does RevX support contract-modding on mobile? Determines Level 2 mobile behaviour.
- **Sample apps V1 list:** The Ballot confirmed. Which 3 others?
- **V2.5:** Option A (social/follow) or Option B (peer verification)?
- **GitHub rate limiting at Summit:** 60 unauthenticated requests/IP/hour. Decision: proxy, mandatory `gh auth`, or accept risk? (CLI already lazy-probes once per `dot mod` to conserve quota — see `runModCommand`.)
- **Session key day 2:** what happens when a developer returns and the session key has expired? Does `dot init` detect and re-initialise?
- **`dot mod` search/filter:** with 50+ apps at Summit, numbered list becomes unwieldy. In scope for V1?
- **quests.json points discrepancy:** confirm 25/25/25/25 = 100 XP with Todor, update RPS repo.
- **Tutorial time:** confirm ~30 min (not 90m in design) with Todor.
- **Sample app size:** confirm one Bulletin chunk = ~10MB with Bulletin team.
- **PGAS batch constraint:** which publish flow transactions are affected?
- **sdk-ink double dry-run calls:** ReviveApi.call + ReviveApi.trace_call doubles rate limit pressure. Monitor and fix before Summit.
