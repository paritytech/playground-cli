# CLAUDE.md

Refer to the **Contributing** and **Architecture Highlights** sections of [README.md](./README.md) for development workflows, the release process, and repo conventions.

## Verification before committing

Before claiming a task complete, opening a PR, or merging, run all three. The first two are enforced by CI; the third catches regressions:

```bash
pnpm format:check
pnpm lint:license
pnpm test
```

`pnpm build` compiles with bun, which STRIPS types without checking them — it is NOT a type signal, and there is no tsc step in CI. The tree carries a known baseline of pre-existing `tsc --noEmit` errors (13 as of June 2026, including the `TypedApi<Paseo_bulletin>` vs `BulletinTypedApi` mismatches in `playground.ts`/`AccountSetup.tsx` and a possibly-null access in `deploy/run.ts`). Before claiming a change complete, run `pnpm exec tsc --noEmit 2>&1 | grep -c "error TS"` and confirm the count did not grow — new errors hide silently otherwise. Burning the baseline down to zero and adding a tsc CI step is an open follow-up. If `lint:license` flags a file you authored, run `./scripts/check-license-headers.sh --fix` to prepend the standard Parity Apache-2.0 header (`SPDX-License-Identifier: Apache-2.0` + `Copyright (C) Parity Technologies (UK) Ltd.`, both lines required). The check script keeps shebangs on line 1 and places the header below them.

## Non-obvious invariants

These aren't self-evident from reading the code and have bitten us before. Treat each one as a load-bearing gotcha — don't undo without checking the failure mode it prevents.

### Dependency pins / lockfile

- **Import from `@parity/product-sdk-*`, never `@polkadot-apps/*`.** The CLI runtime is fully on product-sdk. `@polkadot-apps/*` is gone from the lockfile and CI's `Format` job runs `grep -rnE "['\"]@polkadot-apps/" src/ e2e/ scripts/ tools/` as a guard. Product-sdk uses caret ranges (`^0.x.y`); on a 0.x line `^` only widens patches, so a true breaking change still needs an explicit `package.json` bump.
- **`@dotdm/contracts` tracks the `^3.x` line.** The legacy `1.1.1` stable still depends on `@polkadot-apps/*` + PAPI 1.x — do NOT downgrade.
- **`@novasamatech/host-papp@0.8.5` carries a load-bearing local patch** (`patches/@novasamatech__host-papp@0.8.5.patch`). Upstream 0.8.5 never computes the spec'd ECDH session key: it stores the raw 65-byte `deviceEncPubKey` as `remoteAccount.publicKey` (which also gets truncated by the `Bytes(32)` session codec on disk), so the statement topic + AES key the host uses for EVERY post-handshake session request (`requestResourceAllocation`, `createTransaction`, `signRaw`) never match what the phone subscribes to — requests silently vanish and hang out the 180s queue timeout. The patch derives `createSharedSecret(host encryptionPrivateKey, phone ssoEncPubKey)` (the 32-byte ECDH X-coordinate; symmetric with the phone's `ECDH(//wallet//sso private, host QR encryptionPublicKey)`) in `persistAndNotify`, and gates host-papp's unconditional `[sso-v2]` console.info logging behind `DOT_DEBUG`/`HOST_PAPP_DEBUG`. Remove the patch when host-papp ships both fixes; sessions paired before the patch carry a garbage key on disk — `playground logout` + `playground init` is the remedy. A sibling patch on `@novasamatech/statement-store@0.8.5` silences its unconditional `console.error` for the expected post-destroy `DestroyedError` in the subscription error callback (real subscription errors still log). A third patch on `@novasamatech/sdk-statement@0.6.0` fixes a TDZ crash in `getStatements` (`const unsubscribe` referenced from its own callbacks — when the observable settles synchronously at subscribe time, e.g. a poll firing after client destroy, it threw `ReferenceError: Cannot access 'unsubscribe' before initialization` as an uncaughtException; hit on Ctrl+C during an active pairing). All three patches are local-only (applied at install into node_modules, never published), version-pinned, marked `PATCH(playground-cli)`, and should be dropped as upstream ships the fixes.
- **`@novasamatech/*` resolves through `@parity/product-sdk-terminal@^0.3.1` (host-papp 0.8.x) — do NOT re-pin to 0.7.x.** The mobile app's Handshake V2 rewrite accepts ONLY the V2 pairing offer (SCALE discriminant 1); host-papp 0.7.x emits V1 (discriminant 0), which the phone rejects as the generic "Invalid QR code". There is no version-negotiation knob anywhere in the stack — compatibility is purely which host-papp version resolves. The old `0.7.9` pnpm overrides + the `patches/@parity__product-sdk-terminal.patch` (V1 `metadataUrl` forwarding) were exactly that mistake in reverse and were removed together. host-papp must resolve EXACTLY 0.8.5 for now: Android sends the 226-byte handshake success body (spec v0.2.2); 226-byte decode landed in 0.8.5 (not 0.8.4), and **0.8.6 REMOVED it** — its `HandshakeSuccessV2` is a fixed 258-byte struct requiring `rootEntropySource` (RFC-7, the SDK side of Android PR #752, which current mobile builds do NOT send). Upgrading to 0.8.6 before a #752-bearing mobile release breaks pairing (success decode throws); the version-pinned patch makes accidental drift to 0.8.6 fail the install loudly. Once mobile ships #752: bump to ≥ 0.8.6, DELETE `patches/@novasamatech__host-papp@0.8.5.patch` entirely (0.8.6 contains both the ECDH session-key fix (#206) and a default-off `__DEBUG` gate on the `[sso-v2]` logging), and re-pin the statement-store patch to the version that then resolves (its `DestroyedError` logging is still unfixed at 0.8.6). bulletin-deploy's own subtree independently resolves host-papp 0.7.x (its `0.7.9-4` "pins" are an npm `overrides` field, inert for non-root packages); that split tree is fine because we pass explicit auth/signers into bulletin-deploy in every mode. host-papp 0.8 silently wipes pre-0.8 `SsoSessions` blobs (decode failure → empty list), so users re-pair after upgrading.
- **`@polkadot-api/json-rpc-provider: ^0.2.0` override is load-bearing.** Removing it splits the lockfile across three versions of `json-rpc-provider` (`0.0.1`/`0.0.4`/`0.2.0`) — different PAPI 2.x transitive consumers ask for different versions. Forcing everyone onto `0.2.0` avoids subtle wire-shape divergence and reduces bundle/process memory.
- **`@parity/dotns-cli@0.6.1` ships a broken publish manifest** declaring `"@polkadot-api/descriptors": "file:.papi/descriptors"` — a workspace path missing from the tarball. pnpm refuses; we redirect that sub-dep to `stubs/papi-descriptors-stub/` (an empty `{}` export). dotns-cli's `dist/cli.js` is a fully-bundled Bun build, so the stub is functionally correct. Remove the override + stub when `@parity/dotns-cli` republishes a clean manifest.
- **`bulletin-deploy` is pinned to an explicit version (`0.8.3`), not `latest`.** A previous `latest` (0.6.8) had a WebSocket-heartbeat bug that tore chunk uploads down mid-flight. The pin avoids ever silently sliding onto a broken `latest`. When bumping, read release notes for changes to `deploy()`, DotNS methods, or the `DeployOptions` we use (`jsMerkle`, `signer`, `signerAddress`, `storageSigner`, `storageSignerAddress`, `mnemonic`, `rpc`, `attributes`). Newer releases now also export environment helpers (`loadEnvironments`, `resolveEndpoints`, etc.); we don't consume them — our env table lives in `src/config.ts::CONFIGS`. Do NOT downgrade below 0.8.3: 0.7.30-rc/0.8.0 changed storage routing to use the injected `signer` (so phone-mode chunk uploads would phone-sign and die with "message too big"), and 0.8.3 is the first release with the `storageSigner` slot-key escape hatch.
- **`polkadot-api` is `^2.1.3`** and effectively the only PAPI version in the runtime: the lockfile contains `polkadot-api@1.x` only because `@parity/dotns-cli` declares it, and dotns-cli ships as a single fully-bundled `dist/cli.js` with all deps inlined — never resolved at runtime.

### Network / env

- **`ACTIVE_TESTNET_ENV = "paseo-next-v2"`** (`src/config.ts`). It's the only env wired up; the others throw "not supported" from `getChainConfig()`. The deploy `--env` flag accepts both the new ids and the legacy `testnet|mainnet` aliases (mapped via `resolveLegacyEnv`). When adding an env, populate `CONFIGS` and verify descriptors exist in `@parity/product-sdk-descriptors`. The `paseo-*` descriptor exports we use today are generated against paseo-next-v2 endpoints despite the unversioned names. The Summit devnet (planned, ~week of Summit) will be a separate `CONFIGS` entry — don't pin `paseo-next-v2` as the permanent network.
- **All chain URLs / contract addresses live in `src/config.ts`.** Never inline a websocket URL or `0x…` address anywhere else — at mainnet launch we'll flip one switch, not grep the tree.
- **Username lookup hits `Resources.Consumers` on the People parachain** (`src/utils/username.ts`). Mirrors `@novasamatech/host-papp`'s `createIdentityRpcAdapter`. Pass the SS58 string directly to `getValues([[ss58]])` — do NOT round-trip through `AccountId().dec(ss58)`. The upstream code only does that because its callers pass `0x…` hex; on an SS58 string `Bytes(32).dec` silently corrupts it into a different 32-byte sequence and the lookup fails opaquely as `(lookup failed)`.

### Deploy / Bulletin

- **Bulletin storage chunks must NEVER sign with the phone session signer.** Chunk txs carry up to 2 MiB of callData; the phone path (`session.createTransaction`) forwards the full callData over the statement store, whose host-side request cap is 4 KiB (`DEFAULT_MAX_REQUEST_SIZE = 4096`, unchanged through host-papp 0.8.x; Android's own statement cap grew to 256 KiB in May 2026 but 2 MiB chunks exceed both), so every chunk dies client-side with "Mobile transaction signing rejected: message too big" and the phone never even shows a prompt. Since bulletin-deploy 0.8.x, passing `signer` routes STORAGE through it too (not just DotNS), so phone mode must also pass `storageSigner`/`storageSignerAddress` (the local BulletInAllowance slot key, which takes precedence for storage routing only). `src/utils/deploy/signerMode.ts::resolveStorageSignerOptions` is the single place that resolves it; both `runDeploy` and `runDecentralize` thread it into `runStorageDeploy`. bulletin-deploy 0.8.3 can auto-resolve the same slot key from the shared `dot-cli` allowance cache, but silently falls back to phone-signing the chunks when it misses, so don't rely on it.
- **Deploy delegates to `bulletin-deploy` for everything storage-related** — chunking, retries, pool accounts, nonce fallback, DAG-PB, DotNS commit-reveal. Don't reimplement. The one thing we own is `registry.publish()`. The contract takes an `Option<Address> owner` parameter — when None, it falls back to `env::caller()`; when Some, that H160 is recorded as the app owner regardless of who signed. Phone mode passes None (caller IS the user). Dev mode with an active session passes the session's `productH160` so Alice can sign the tx while the user still appears in MyApps. The `publisher` field on `AppInfo` always stores `env::caller()`, so `is_authorized_to_republish` lets the original signer iterate without rewriting ownership. See `src/utils/deploy/playground.ts` and `src/utils/deploy/signerMode.ts::resolveSignerSetup`.
- **Do NOT call `bulletin-deploy.deploy()` just to store a metadata JSON.** `deploy()` unconditionally runs a DotNS `register()` + `setContenthash()`, and for `domainName: null` invents a `test-domain-<random>` label and registers THAT — the side-trip reverts cryptically. For metadata storage we submit `TransactionStorage.store` directly via PAPI using `calculateCid` from `@parity/product-sdk-bulletin`. The metadata `store` is signed with the product-scoped RFC-0010 Bulletin allowance account cached in `allowance-keys.json` (not Alice, not the product account). Asset Hub `registry.publish` is signed with the user's product account in phone mode, and with a dev signer in dev mode (claimed-owner H160 carries the user identity, per the bullet above). See `src/utils/deploy/playground.ts::publishToPlayground`.
- **Dev mode must pass EXPLICIT auth options to `bulletin-deploy.deploy()` — never `{}`.** Since 0.8.x (the "#411 login UX"), `deploy()` called with no `mnemonic`, no `signer`, and no `suri` probes for a persisted SSO session file (`~/.polkadot-apps/dot-cli_SsoSessions.json` — the SAME namespace `playground init` writes, because bulletin-deploy reuses `DOT_DAPP_ID = "dot-cli"`) and, when found, loads the SSO stack and phone-signs DotNS with the user's session — turning a "0 taps" dev deploy into 3-4 phone approvals for every logged-in user. Independently, an absent `storageSigner` makes it auto-read the user's cached BulletInAllowance slot key and burn their small phone-granted quota on chunk uploads, in every mode including `--suri`. `resolveSignerSetup` therefore pins `mnemonic: DEFAULT_MNEMONIC` for dev mode and `resolveStorageSignerOptions` pins `storageSigner` to the dev bare-root (dev) or the `--suri` key (suri) — the bare-root carries its own Bulletin authorization on paseo-next-v2, and bulletin-deploy's committed-signer wrapper falls back to the shared pool if it ever lapses. Tests in `signerMode.test.ts`, `run.test.ts`, and `decentralize/run.test.ts` pin the contract.
- **The "dev signer" used in dev mode is bulletin-deploy's `DEFAULT_MNEMONIC` bare-root account, not Substrate's `//Alice`.** The bare-root SS58 (`5DfhGyQd…`) is what bulletin-deploy uses internally for its DEFAULT_MNEMONIC storage + DotNS signing, so the CLI's `createDevPublishSigner` derives from the same `(mnemonic, path="")` pair via `seedToAccount`. Storage, DotNS, and registry publish all sign as one identity. Substrate's `//Alice` (`5Grwva…`) is a DIFFERENT account — `createDevSigner("Alice")` from `@parity/product-sdk-tx` returns that one. Don't mix them; the `signerModeAlice.test.ts` snapshot guards against regression.
- **Dev-mode re-publish only works on apps that were first published from dev mode.** `is_authorized_to_republish` accepts `caller == owner OR caller == publisher`. In dev mode the publisher is always Alice (`5DfhGyQd…`), so dev-mode re-deploys of a dev-published app succeed. But an app first published from phone mode has `caller == publisher == user H160`; Alice is neither, so a dev-mode re-deploy reverts `Unauthorized`. To iterate on a phone-published app in dev mode the user must unpublish it from phone mode first. Intentional asymmetry: once a user "owns" an app from their phone, a shared dev key can't touch it.
- **Build a dedicated Bulletin client with `heartbeatTimeout: 300_000` for the metadata upload.** The shared client from `getConnection()` uses `@parity/product-sdk-chain-client`'s default 40 s heartbeat; a single `TransactionStorage.store` round-trip can exceed that and the socket tears down as `WS halt (3)`. We mirror bulletin-deploy's 300 s heartbeat with a one-off client that gets destroyed immediately after the upload.
- **`playground deploy` does NOT pass `jsMerkle: true` today.** bulletin-deploy's pure-JS merkleizer produces CARs containing only raw leaves (DAG-PB blocks are silently dropped by `blockstore-core/memory`'s `getAll()` under `rawLeaves: true` + `wrapWithDirectory: true`) → polkadot-desktop parses zero files → sites return 404. We rely on the Kubo binary path until the upstream merkleizer collects all blocks, not just leaves. `playground init` installs `ipfs`. Trade-off: this temporarily breaks the RevX WebContainer story for the main storage upload — flip `jsMerkle: true` back once `merkleizeJS` is fixed.
- **The mobile app wraps `signRaw` data with `<Bytes>…</Bytes>`** (anti-phishing envelope). On paseo-next-v2 this doesn't matter for tx signing: `@parity/product-sdk-terminal@0.3.x`'s `createSessionSignerForAccount` routes transaction signing through `session.createTransaction` — the wallet builds and signs the full extrinsic from a structured `ProductAccountTransaction`, no `<Bytes>` envelope — so every signed extension declared by the chain (including paseo-next-v2's `AsPgas`) survives end-to-end. Don't reach for `signRaw` to sign extrinsic payloads from anywhere outside the signer; raw-message signing keeps the `Bytes` tag for arbitrary user data. (History: 0.2.1 used `session.signRaw({ data: { tag: "Payload", … } })`; the pre-0.2.1 PJS path failed on v2 with `PJS does not support this signed-extension: AsPgas`.)
- **Signer mode selection lives in one file** (`src/utils/deploy/signerMode.ts`). The mainnet rewrite is a single-file swap; keep that boundary clean.
- **`src/utils/account/bulletinTopUp.ts` mirrors bulletin-deploy's internal `attemptTestnetTopUp`** so `playground init` front-loads the dev-funder top-up at setup time rather than waiting for the just-in-time call inside `deploy()`. Both flows no-op once the recipient is ≥ 0.1 PAS, so running them back-to-back doesn't double-transfer. Delete the local mirror only once bulletin-deploy surfaces `attemptTestnetTopUp` at the package root — today it's an internal `DotNS` method.

### Accounts: root, product, and what the mobile app shows

- **`session.rootAccountId` is whatever the mobile app published as `rootUserAccountId` in the SSO handshake.** On current mobile builds (`polkadot-app-android-v2`, see `feature/sso/impl/.../RealSsoHandshakeUseCase.kt:34` → `deriveRootAccount() = derivationPath = null`) it's the bare-mnemonic sr25519 root with no junction. The host-papp SDK does not derive it — it just decodes the 32 bytes from `HandshakeResponseSensitiveData.rootUserAccountId` (`triangle-js-sdks/packages/host-papp/src/sso/auth/scale/handshake.ts:23-27`) and forwards them. If a future mobile release changes the path, our display will silently change with it — the source of truth is the phone, not the CLI.
- **The mobile's "Wallet account address" and "Candidate account address" debug rows are NOT reachable from the host.** They're sr25519 of mnemonic + `//wallet` and mnemonic + `//candidate` respectively (`feature/account/impl/.../RealAccountRepository.kt:166-173`, hard junctions). Hard derivations can't be reproduced from a public key, so the CLI never sees those SS58s. Don't try to surface a "wallet address that matches mobile" — it isn't possible without the mnemonic.
- **The playground product account is derived by exactly one function** (`src/utils/sessionSigner.ts::derivePlaygroundProductPublicKey`), called by both `createPlaygroundSessionSigner` (signer construction) and `auth.ts::deriveSessionAddresses` (display triple). The math is `deriveProductAccountPublicKey(rootAccountId, "playground.dot", 0)` from `@parity/product-sdk-keys`. Do NOT call `deriveProductAccountPublicKey` (or any helper that wraps it) on an already-product-derived SS58 — that yields a doubly-derived ghost account. The `productAccountDisplay` / `productAccountAddresses` helpers that used to live in `src/commands/init/identityLine.ts` had exactly this bug and were deleted; resist re-introducing them. A frozen-vector regression test in `src/utils/auth.test.ts` (`deriveSessionAddresses` block) locks the pubkey/H160 the playground-app expects.
- **Username storage is keyed on `session.rootAccountId`, not on the product account.** `Resources.Consumers[<rootAccountId>]` on the People parachain is populated by mobile's `Resources.register_person` call (signed by `//wallet`-derived key, but the storage key is the root). `lookupUsername` MUST be called with `addresses.rootAddress`, not the product SS58. Polkadot-desktop's `useSessionIdentity(session)` does the same — both read off the SSO `rootAccountId`.
- **`SessionAddresses` triples are computed once in `auth.ts` and threaded through.** `ConnectResult`, `LoginStatus.success`, and `SessionHandle` all carry the `{ rootAddress, productAddress, productH160 }` bundle. `SessionHandle.address` is kept as a back-compat alias for `addresses.productAddress` because `signer.ts::resolveSigner` spreads the handle into `ResolvedSigner` and downstream deploy code (`signerMode.ts`, `playground.ts`, `registry.ts`, `DeployScreen.tsx`) reads `.address` for the signing key. UI code should prefer `addresses` so the root vs product distinction stays explicit.

### Allowances / session

- **Slot-account signers come straight from `@parity/product-sdk-terminal/host` — and the terminal floor is `^0.3.1` for exactly this reason.** The mobile returns `slotAccountKey` as 64 bytes of schnorrkel `SecretKey::to_bytes()` material and grants the on-chain allowance to the address it derives natively (Android `SlotAccountKey.kt::deriveAccountId`). `@scure/sr25519` expects the ed25519-expanded form (scalar ×8); terminal < 0.3.1 fed the raw bytes through and derived a DIFFERENT address the chain never granted anything to — signatures "worked" but every `TransactionStorage.store` was unauthorized, and bulletin-deploy silently fell back to the shared pool account (nonce races → `AncientBirthBlock` chunk deaths). 0.3.1 fixed the derivation upstream (`canonicalSr25519SecretToEd25519Bytes`, same ×8 math), verified address-equivalent against the CLI's old frozen vectors before the local `slotSigner.ts` workaround was deleted. If the derivation ever regresses, the symptom is grants landing on a different address than the signer uses; the live proof is on paseo-next-v2.
- **Phone-mode storage quota is checked BEFORE the upload, but NEVER blocks** (`deploy/storageQuota.ts` + `resolveStorageSignerOptions`'s `quota` param). Slot grants are small (observed: 10 txs / 4 MiB per claim) while CARs run 2 MiB per chunk; mid-upload Payment failures do NOT fall back to the pool (only a first-connection failure does), so the extent is verified up front — an undersized grant triggers one `Increase` tap via `getBulletinAllowanceSigner`. A shortfall after that is WARN-AND-PROCEED: whether the chain enforces the extent at `store()` time is unconfirmed (bulletin-deploy's author: "the allowance doesn't mean anything anymore, the authorization is what counts"), so blocking on those numbers could fail deploys that would succeed. Only a total resolution failure (no slot key, grant declined) aborts. The context itself is best-effort: estimate or client failures return null and skip the check.
- **The statement-store (SSS) allowance is a 1-day renewable resource and is the CHANNEL for every phone interaction**, not a signing permission. `session.createTransaction` / `signRaw` / `requestResourceAllocation` all travel as statements on the People chain; the host's locally derived SSS account needs an on-chain ring slot to submit them. The slot is granted at QR login (the only flow with a direct WebSocket channel) and lapses ~2-3 days later (1-day period + `StmtStoreGraceWindow` of 2 days, runtime PR individuality#1022). It CANNOT be renewed remotely: the renewal request itself rides SSS (circular dependency), so the only remedy is `playground logout` + `playground init`. There is NO on-chain query for SSS ring membership. When expired, the adapter logs `NoAllowanceError` to console.error but never rejects, so calls hang for the SDK's 180s queue timeout (observed on host-papp 0.7.9; 0.8.x has no `NoAllowanceError` symbol — it has `AllowanceError` with reason codes — so the expired-SSS log line needs live re-verification on 0.8 and the fast-fail match strings may need extending). Defenses: `sessionSigner.ts::wrapSignerWithSssFastFail` (intercepts the log line, rejects in ~200ms with the logout/init message) and `loginStamp.ts` + deploy preflight (warn-only when the recorded login is >2 days old; the stamp lives at `~/.polkadot-apps/dot-cli_LoginStamp.json` so logout clears it). Don't add a "renew SSS on error" path: it cannot work.
- **`getSessionSigner()` returns an adapter that keeps the Node event loop alive.** Every caller must invoke the returned `destroy()` when done. Forgetting it manifests as `playground <cmd>` hanging after the work visibly finishes.
- **`requestResourceAllocation` comes from `@parity/product-sdk-terminal/host`** (the `./host` subpath — it is still NOT re-exported at the package root as of 0.3.1). The old CLI-local shim (`src/utils/allowances/host.ts`) is gone; only the playground's resource set + display helpers remain in `src/utils/allowances/resources.ts`. `@parity/product-sdk-host`'s `requestResourceAllocation` is the in-container variant (browser globals required) and won't work from the CLI. Note the resource tag spelling on this path is still `BulletInAllowance` (capital I) — the `BulletinAllowance` rename in host-api 0.8 was only in the in-container protocol, not host-papp's SSO codec.
- **Allowance grant markers live at `~/.polkadot/allowances.json`** (`src/utils/allowances/marker.ts`), mode 0600, sibling to `accounts.json`. RFC-0010 has no on-chain query for allowance status, so we persist `{ env: { ss58Address: { resourceTag: { grantedAt, source } } } }` after a successful host grant. Slot-account private keys for Bulletin / Statement Store live separately in `~/.polkadot/allowance-keys.json` (`src/utils/allowances/slotKeys.ts`), also mode 0600. A marker alone isn't enough to skip `playground init` for slot resources — confirm the matching key exists too. Markers and keys are isolated per env. Keep `source: "host"` as the only value emitted from production code.
- **Bulletin is not requested through mobile resource allocation in `playground init`.** Until product-sdk exposes the proper terminal host/preimage path, the CLI creates or reuses a locally cached Bulletin slot key and surfaces `bulletinAuthorizationHelp(slot)` against the env's `bulletinAuthorizationUrl`. Always check usability via `hasUsableBulletinSlotAuthorization`, never just `hasSlotAccountKey`.
- **`playground init --yes` auto-runs at the end of `install.sh`** to skip the interactive QR-scan so non-interactive installers don't block. It installs prerequisites and prints "setup complete", then `install.sh` prints a hint to run `playground init` for the full mobile login. Dep-setup failures surface their exit code so CI runs don't silently pass.

### CLI surface boundaries

- **`src/utils/deploy/*` and `src/utils/build/*` must not import React or Ink.** They form the SDK surface RevX consumes from a WebContainer. TUI code lives in `src/commands/*/`.
- **`playground mod` runs signer-less.** `runModCommand` does not call `resolveSigner` — it uses `getReadOnlyRegistryContract(rawClient)` (origin = pallet-revive's keyless pallet account, `5EYCAe5ij…`, matching product-sdk's query fallback) for browse + metadata-uri lookup. The `--suri` flag is a deprecated no-op. Users browse + clone moddable apps without `playground init` / mapping their account. The signed `getRegistryContract(rawClient, signer)` is used only for `registry.publish.tx(...)` in `src/utils/deploy/playground.ts`. Don't drag a user signer back into `playground mod`.
- **`playground mod` is GitHub-tarball-only and must stay that way.** `src/utils/mod/source.ts` downloads from `codeload.github.com` (no auth, no `git`/`gh` for public repos) and extracts via `node:zlib` + the pure-JS `tar` package. Do NOT re-introduce `git clone` or `gh repo fork` — both re-add a hard tooling dep, and the fork path was specifically removed because GitHub caps you to one fork per source-repo per account. The interactive picker filters out non-moddable apps. The picker does NOT pre-probe each app's repo visibility (would burn the 60 req/hr anonymous GitHub quota); instead `runModCommand` lazy-probes the picked app once via `assertPublicGitHubRepo()` between picker dismount and `SetupScreen` mount.
- **`playground` never invokes `gh`.** `playground deploy --moddable` reads an existing `origin`, validates it's a public GitHub URL via `HEAD https://github.com/{o}/{r}`, and records it in metadata. No auto-create path. Missing `origin`, private repos, and non-GitHub URLs all hard-fail with actionable messages from `src/utils/deploy/moddable.ts::resolveRepositoryUrl()`. We deliberately do NOT add an interactive `gh auth login` handoff — Ink owns stdout + raw-mode stdin and a `stdio: "inherit"` child would race `useInput` for keystrokes.
- **`metadata.repository` is set ONLY when `--moddable` is opted in.** `runDeploy` takes an explicit `repositoryUrl: string | null` and `publishToPlayground` writes the field iff that param is non-null. Earlier code silently probed `git remote get-url origin` and surprised users — don't reintroduce that behaviour.

### Runtime / memory

- **Bun compiled-binary stdin quirk** — Ink's `useInput` silently drops every keystroke in `bun build --compile` binaries unless `process.stdin.on('readable', …)` is touched before Ink's `render()`. We install a no-op `readable` listener at the top of `src/index.ts` as a warm-up. Symptom if this breaks: TUI renders but nothing responds, including Ctrl+C.
- **Process-guard safety net** (`src/utils/process-guard.ts`) — deploy pipelines open long-lived WebSockets + child processes; any one can keep the event loop alive after the TUI finishes, turning `dot` into a zombie. We defend in depth: (1) `installSignalHandlers()` catches SIGINT/TERM/HUP + `unhandledRejection` and forces cleanup + exit within 3 s. The rejection handler runs each rejection through `isBenignUnsubscriptionError`, which suppresses four known post-destroy artifacts (rxjs `UnsubscriptionError("Not connected")`, PAPI `DisjointError` from a chainHead unfollow race, PAPI's `DestroyedError("Client destroyed")`, and — since the host-papp 0.8 stack — a BARE `Error` whose message is exactly "Not connected", the raw-client teardown throw escaping as a floating rejection; contextual "Not connected: …" messages still escalate). Our `SessionHandle.destroy()` returns void (so React `useEffect` cleanups can call it) and fires `adapter.destroy().catch(() => {})` — fire-and-forget with the rejection silenced at the source. The source-side `.catch()` is load-bearing because Bun's SEA binary prints `unhandledRejection` events regardless of any process listener — the catch is the only way to suppress it. (2) `scheduleHardExit()` installs an `unref`'d timer that kills the process if the loop doesn't drain in time. (3) `startMemoryWatchdog()` aborts if RSS exceeds 4 GB. Do NOT re-add a per-window growth detector — we tried 300 MB / 3 s and it false-positived on the single-burst metadata-loading spike. Set `DOT_MEMORY_TRACE=1` to stream per-sample RSS/heap/external stats.
- **Telemetry bootstrap** (`src/bootstrap.ts`) is the FIRST import in `src/index.ts`. It sets `BULLETIN_DEPLOY_USE_AMBIENT_SENTRY=1` and `BULLETIN_DEPLOY_HOST_APP=playground-cli` before `bulletin-deploy` evaluates, then maps `DOT_TELEMETRY`/internal-context detection to `BULLETIN_DEPLOY_TELEMETRY`. Don't leave `BULLETIN_DEPLOY_TELEMETRY` unset while setting the host app: `bulletin-deploy` treats `playground-cli` as an internal host, which would enable deploy telemetry for external users.
- **Throttle TUI info updates.** bulletin-deploy logs per-chunk, builds stream thousands of lines/sec. `setState`-per-event floods React's reconciler with backpressure (can balloon past 20 GB and freeze the OS). `RunningStage` coalesces "latest info" updates to ≤10/sec via a ref + timer and caps line length at 160 chars. Don't hook raw per-line streams directly into Ink state.
- **`DeployLogParser.feed()` MUST NOT emit an event per log line.** It's called for every console line bulletin-deploy prints. We emit only for phase-banner matches and `[N/M]` chunk progress; everything else returns `null`. A catch-all `info` emit allocates ~200 bytes × thousands of lines and was a measurable contributor to chunk-upload memory pressure.
- **The memory watchdog runs for EVERY command by default** (`runCliCommand`'s `watchdog` option defaults to true). It is the only guard that survives event-loop starvation: when a leaked polkadot-api subscription enters the microtask-flood state, signal handlers, `hardExit` timers, and `src/index.ts`'s final `process.exit()` all stop firing — the process looks finished but lingers invisibly and grows unbounded. We shipped exactly that in June 2026: `playground init` ran watchdog-less, and three zombie `playground` processes reached 40+ GB each, swapping the laptop to death. Do NOT opt a command out to save the worker thread — it costs one 1 Hz `memoryUsage()` sample. The related session-probe rule: every `createAdapter()` call site must destroy the adapter on EVERY path that doesn't transfer ownership to the caller (`connect()`'s existing-session and probe-throw paths leaked it; `src/utils/auth.connect.test.ts` pins the contract).
- **`QueryResult<T>` from `@parity/product-sdk-contracts@0.5+` is a discriminated union.** Narrow on `.success` before reading `.value`. On the failure branch `.value` is the runtime's dispatch-error payload (`unknown`). On the success branch `gasRequired` is non-optional. We apply this in `src/utils/contractManifest.ts::resolveLiveContractAddresses`, `src/commands/mod/AppBrowser.tsx`, and `src/commands/mod/SetupScreen.tsx`.

## Repo conventions

- **Every user-facing PR must include a changeset.** Releases are automated via `.github/workflows/release.yml`, which is a no-op unless a `.changeset/*.md` file exists on merge. Create one with `pnpm changeset` or by hand (frontmatter: `"playground-cli": patch|minor|major`, body: user-visible summary). Pure refactors / test-only changes can skip it.
- Tests are `*.test.ts` next to the source. `vitest.config.ts` only picks up `.test.ts`; if you add `.tsx` tests update the config too.
- Pure logic inside a `.tsx` should be lifted into a sibling `.ts` file (`completion.ts` next to `InitScreen.tsx`; `identityLine.ts` next to `IdentityLines.tsx`; `formatPas`/`formatMb` exports in `AccountSetup.tsx`). Tests can then import it without dragging React + Ink into vitest.
- Do NOT add AI/tool attribution (`Co-Authored-By: Claude`, "Made with Cursor", emoji signatures) to commits, PRs, or generated files. Never embed your name, identity, or tooling provenance anywhere in the repo.
- Do NOT commit design docs, brainstorming notes, or context dumps (e.g. `context.md`) to the repo — tickets or scratch files outside the tree.
- Don't mock primitives from `polkadot-api` (`Enum`, encoders) in tests — doing so turns intended coverage into tautology.
- Long-lived resources (`TerminalAdapter`, `PaseoClient`) have explicit `destroy()` / `destroyConnection()` — always release them, especially from React `useEffect` cleanups. The WebSocket keeps the event loop alive; forgetting a destroy manifests as `playground <cmd>` hanging after the work is visibly finished.

## Sentry telemetry

- DSN: `src/telemetry-config.ts::PLAYGROUND_SENTRY_DSN`. Region: EU (`https://de.sentry.io`). Attribute prefix: `cli.`. Spec: `sentry-instrumentation-spec.md` at the repo root (untracked).
- Org slug: `paritytech`. API token: macOS keychain service `sentry-api-token`.
- **Helpers — don't reimplement.** `src/telemetry.ts` exports `withCommandTelemetry`, `withRootSpan`, `withSpan` (3-arg `(op, name, fn)` and 4-arg `(op, name, attrs, fn)` overloads), `captureWarning`, `captureException`, `errorMessage`, `sanitizedErrorMessage`. `src/utils/deploy/phase.ts` exports `withDeployPhase`. `src/cli-runtime.ts` exports `runCliCommand` — every command's `.action()` body should be one `runCliCommand(name, options, async () => { ... })` call. The memory watchdog is ON by default for every command (see the Runtime / memory invariant below — do not opt out); `hardExit` defaults to true and is currently disabled only for `init` (its event loop drains naturally after `destroyConnection()` + the QR login-adapter destroy).
- **Dashboards** are JSON snapshots under `sentry/dashboards/<id>.json`: `2143100` (Health, prod filter `!cli.tag:e2e-*`), `2216067` (Failures), `2216096` (E2E Health, inverse filter `cli.tag:e2e-*`).
- **Workflow:** run `./sentry/backup-dashboards.sh` BEFORE any change. Use `./sentry/patch-dashboard.py <id> <patch.json>` for surgical edits or `./sentry/create-dashboard.py <payload.json>` for new dashboards. PUT replaces the whole widget list — backup first. Don't include a `projects` field in POST payloads.
- **E2E tagging:** every spawn from `e2e/cli/helpers/dot.ts` injects `DOT_TAG=e2e-local` (fallback), `DOT_TELEMETRY=1`, and `DEPLOY_TAG=e2e-cli-local` (derived from `DOT_TAG` with an `e2e-cli-` prefix). `tools/e2e-local.sh` overrides `DOT_TAG` to `e2e-local-{smoke|pr|nightly}`; CI sets `DOT_TAG=e2e-ci-{pr|nightly|dispatch}`. The `e2e-cli-` prefix on `DEPLOY_TAG` distinguishes our E2E traffic from bulletin-deploy's own. Production health widgets filter cleanly via `!cli.tag:e2e-*`.
- **SAD% propagation** is verified by a regression test in `src/telemetry.test.ts` ("SAD% propagation through transaction envelope"). It confirms `captureWarning` flips `cli.sad="true"` on the root transaction. If it fails, the SAD% dashboard widget will silently degrade to a duplicate of the unexpected-failure rate.

## E2E Tests

- **Local launcher:** `tools/e2e-local.sh [smoke|pr|nightly]`, also `pnpm test:e2e:{smoke,pr,nightly}`.
- **CI workflow:** `.github/workflows/e2e.yml` — runs on PR / push:main / cron 06:00 UTC / workflow_dispatch. 13 cells across four matrices (`test-no-publish`, `test-publish`, `test-nightly-no-publish`, `test-nightly-publish`); publish legs run `max-parallel: 1` to avoid stomping a shared deployer account.
- **Release smoke:** `.github/workflows/e2e-release.yml` (on `release: prereleased`) and `.github/workflows/e2e-post-release.yml` (on `release: published`) run `published.test.ts` against the SEA asset and the `install.sh` consumer path respectively.
- **Test files:** `e2e/cli/*.test.ts`. Reports: `e2e-reports/junit.xml` + `e2e-reports/dot-runs.log` (gitignored). CI report job is `E2E Report` — sticky PR comment marker `<!-- e2e-pr-report -->`.
- **Guides:** `docs/e2e-running-tests.md` (running + reading), `docs/e2e-bootstrap.md` (maintainer setup), design spec at `docs-internal/2026-05-02-e2e-test-suite-design.md`.

---

# Product context: playground.dot

Source: Playground Full Spec v0.45, June 2026. Team: Ionut (TL), Rebecca (PM), Charles, Utkarsh, Todor, Reinhard, Sveta (Design), Karim (Dept), RevX team (parallel). Kanban: https://github.com/orgs/paritytech/projects/278.

## What it is

playground.dot is a mobile-first quest platform for the Web3 Summit Developer Lab (18–19 June 2026, Berlin). A developer scans a QR or visits the URL, picks a tutorial or sample app, mods it with AI help, and deploys their own version live on Polkadot Hub — target time-to-deploy is ~30 minutes from a cold start, with no prior Polkadot experience.

**V1 is the only active build target.** V2+ are directional ideas — do not implement unless an issue or PR explicitly requests it.

**North-star KPI (Gav):** quality of human interactions and engagement. Fewer apps is fine — total app count is a secondary metric. A smaller registry of quality apps beats a large registry padded with spam.

## App structure

Three tabs in the playground-app (not a single "registry browser"). All three are V1 scope:

| Tab | Purpose |
|---|---|
| **Playground** | Quest-forward onboarding. Tutorial hero, sample apps, how it works, leaderboard. |
| **Apps** | Registry browser. All deployed apps, search, category filters, sort, featured section. |
| **Profile** | Personal hub. Deployed apps, starred apps, rank, storage info, name. |

**Vocabulary:** the registry tab is "Apps" — never "dAppStore" / "store" / "dApp store". Pinning badge is "Pinned" — never "Staff pick".

## Key repositories

| Repo | Role |
|---|---|
| `paritytech/playground-app` | Registry + Playground tab + Profile |
| `paritytech/playground-cli` (this repo) | playground CLI (binary: `playground`, short alias `pg`) |
| `paritytech/Rock-Paper-Scissors` | Rock Paper Scissors tutorial (4 levels) |
| `paritytech/playground-app-template` | Blank-canvas starter |
| `paritytech/product-sdk` | Publishes `@parity/product-sdk-*` |
| `paritytech/triangle-js-sdks` | Publishes `@novasamatech/host-api` + `@novasamatech/product-sdk` (TrUAPI) — separate from the Parity SDK |
| `paritytech/attestation-protocol` | Used for stars/ratings in V2 |

## How the pieces fit together

| Component | Owned by | Role |
|---|---|---|
| **playground-app** | Frontend/contract team | Three tabs, App Detail Page, publish pipeline |
| **playground CLI** (this repo) | CLI team | Local IDE path: `playground init`, `playground mod`, `playground build`, `playground deploy --playground`, `playground decentralise`, `playground logout`, `playground update`. `pg` is interchangeable everywhere (`pg init` == `playground init`). |
| **RevX** | Talles / RevX | Browser IDE; opens via `revx.dev/editor?mod=<domain>&quest=<level>` (`quest=` for tutorial only) |
| **Tutorial** | Todor | Rock Paper Scissors (4 levels, ~30 min) |
| **Sample apps** (~4 for V1, ≥10 for V2) | Various | Each is its own repo with `setup.sh` + `.claude/skills/`. Quest ideas live in the README — no `quests.json`. Feedback Board (Todor) is built; The Ballot, Kudos, Countdown, Pact are candidates. |
| **`@parity/product-sdk-*`** | Parity platform | All chain interactions. Depends on Nova Spektr's `@novasamatech/host-api` + `@novasamatech/product-sdk` (TrUAPI). |
| **Bulletin Chain** | Bulletin/infra | Decentralised storage for app metadata, icons, assets. Mainnet live 7 May 2026. |
| **DotNS** | DotNS team | `.dot` domain reservation during publish. |
| **Polkadot app + PoP** | Mobile / Gav | Sign-in via QR; provisions session keys; PoUD/PoP enable PGAS claims. |

## Network

**Current:** Paseo Next v2 — migrated from PreviewNet (`ACTIVE_TESTNET_ENV = "paseo-next-v2"` in `src/config.ts`). Bulletin Chain went live on Polkadot mainnet 7 May 2026.

**Summit network:** the event itself runs on a **Summit-specific closed devnet** operated by Parity. All participants get pre-allocated allowances — **no storage or PGAS constraints during the event**. The devnet switches off at the closing ceremony and apps cease to exist. "Save your repo to GitHub" is the consistent message. **Don't hardcode "Paseo Next v2" as the permanent network** — the Summit devnet is a separate deployment, gated by `src/config.ts::CONFIGS`.

**Production storage** (outside the Summit devnet): Bulletin storage is time-limited and requires renewal. Frame this as a feature — time-bound deployments encourage active curation.

## PoP auth + session key model

Sign-in is **never** described as "wallet" in the product — it's an **account**.

1. User taps sign-in → desktop shows a QR; mobile triggers the Polkadot app directly.
2. Scanning authenticates via PoP and creates a session key locally.
3. The session key is pre-loaded via a single `host_request_resource_allocation([BulletinAllowance, StatementStoreAllowance, SmartContractAllowance])` call: one authorisation dialog, then the session flows.
4. From then until logout, publish + on-chain interactions are signed by the session key. The user is never asked to top up, fund, or acquire tokens.

`playground logout` signs out, notifies the mobile app, and clears the local session.

**The CLI must not present fee-acquisition UX.** If you find yourself designing a "buy tokens" or "top up" flow, something has gone wrong upstream. Session keys are confirmed kept for Summit — without them every action needs phone approval and batching breaks PGAS.

## PGAS and fees

**PGAS (People Gas)** is a burnable sufficient asset on Asset Hub covering all playground on-chain actions. Claimed via ZK ring-VRF PoP — privacy-preserving, sybil-resistant, no prior token ownership.

- Lite PoP / PoUD: 40 claims/day × 0.005 DOT = 0.2 DOT/day
- Full PoP: 100 claims/day × 0.005 DOT = 0.5 DOT/day
- PGAS pegged 1:1 to DOT for fees

Budget is sufficient for ~180–200 transactions across 2 days. PGAS claim path is **v5 extrinsic only** (mobile-only); spending PGAS is v4 and works everywhere. **Batching transactions breaks PGAS fee payment** — the publish flow must remain sequential individual transactions.

Summit devnet allowances are pre-allocated. Vouchers, soft-limit messaging, Bulletin expiry countdown UI, and `playground voucher` are all **removed from V1** — don't reintroduce.

## The publish flow (5 steps, all paid by the session key)

| # | Step | CLI / UI message |
|---|---|---|
| 1 | Upload frontend assets + metadata to Bulletin | "Uploading to Bulletin..." |
| 2 | Reserve `.dot` domain on Polkadot Hub | "Registering your .dot domain..." |
| 3 | Register on the playground registry | "Publishing to playground registry..." |
| 4 | Live URL ready | "Your app is live at `yourapp.dot.li`." |
| 5 | Share link ready | "Share: `playground.dot/app/yourapp.dot`" (copyable) |

Steps 4 and 5 are the two links the user copies/pastes to share — the live `.dot.li` Bulletin URL (to *open* the app) and the playground detail page deep link (to let others *mod* it). Internally Bulletin upload and registry publish run in parallel; the user-facing pipeline preserves the 5-tick mental model.

Plain-English error messages — never hex revert codes. Retries are safe: Bulletin uploads dedupe by content, DotNS skips if already owned, registry updates existing entry. Re-deploys show "Updating myapp.dot", not "Publishing myapp.dot". Account switch mid-publish aborts with `Account changed mid-publish — please re-run from the new account`.

**Current state vs spec.** Pipeline runs end-to-end, but only 4 statuses surface in the UI today (`preparing` / `uploading` / `publishing` / `done`); the spec's 5 named steps aren't all distinctly labelled yet. Treat the table above as target, not current implementation.

**Publish validation (V1):** domain uniqueness (DotNS contract, first on-chain tx wins) and required fields. Image format/size limits deferred to V2.

**Post-deploy CLI output target:** live URL (`yourapp.dot.li`) + playground detail link + share CTA ("Share your app — let others mod it") + sovereignty line ("Your app is live on Bulletin Chain, registered on Polkadot Hub, accessible at yourapp.dot.li. Nobody controls this but you.") + name reveal ("You're live as [current display name]. To set a different username for playground.dot, go to My Profile in playground.dot.") + moddable nudge + docs link.

## Content tiers

Three tiers share the same contract; the frontend differentiates via pinning + App Detail Page variant.

**Tier 1 — Rock Paper Scissors tutorial.** Single repo (`paritytech/Rock-Paper-Scissors`), one app entry, pinned. Decentralised Rock Paper Scissors built by Todor. ~30 min total across all levels.

| Level | Name | Scope | Mobile |
|---|---|---|---|
| 1 | Local Challenger | Mod UI/theming. No contract changes | Yes — fully supported |
| 2 | On-Chain Record | Save game results to Bulletin | Yes — RevX (no contracts — frontend only) |
| 3 | The Leaderboard | Deploy leaderboard smart contract | No — CLI + laptop only (RevX dropped Solidity/Rust support) |
| 4 | Multiplayer | P2P via Statement Store. Challenge via link/QR | No — CLI + laptop only |

**XP:** +100 XP on each of your first two deploys (gated on `get_owner_app_count`); 3rd+ deploys earn 0. In practice deploy #1 is the tutorial deploy, deploy #2 the first solo app. Reward then shifts to social signal (stars + mods received). See the XP section. IslandPortal popup framing should say "your first deploy earns 100 XP" (not "tutorial = 100 XP") — the +100 bonus applies to your first two deploys whichever path you take.

**Tier 2 — Sample apps** (~4 V1, ≥10 V2). Each is its own repo, pinned. **No `quests.json`** — quest ideas live in the README. Once the user has used their two first-deploy bonuses, sample app deploys earn 0 XP (see XP section). **Feedback Board** (Todor) is built. The Ballot, Kudos, Countdown, Pact are candidates — 3 more sample apps need commissioning + builders.

Sample app spec: start from `playground-app-template`, ship a README (quest ideas + SDK packages + key files), idempotent `setup.sh`, `.claude/skills/app-context.md` (~10 lines). Must be moddable (public GitHub). Size limit: one Bulletin chunk (~10 MB, TBC). Naming `sample-<name>-app`.

**Tier 3 — Participant apps.** Everything modded and deployed by Summit attendees, growing through the event. Shown below pinned items.

The empty/starter template (`paritytech/playground-app-template`) is **pinned alongside** the tutorial and sample apps for blank-canvas builds.

## XP and stars

Points are referred to as **XP** throughout V1.

**XP = leaderboard score (Top Builders).** Stored on-chain as a per-account running balance. XP only goes up.

| Action | XP | Cap / dedupe |
|---|---|---|
| Each of your first two deploys | +100 | First 2 only; 3rd+ = 0. Gated on `get_owner_app_count` (monotonic — farm-safe). Deploy #1 is in practice the tutorial, #2 the first solo app. |
| Someone mods your app | +50 | Per `(modder, source_domain)` pair, deduped. Strongest single-signal award. |
| Someone stars your app | +10 | Per star awarded to your app. |
| Setting a registry username | +25 | One-time, guarded by `username_bonus_awarded` flag. |
| Moddable deploy bonus | 0 | Moddability no longer adds deploy XP — the payoff is the +50 someone-mods-your-app award. |

**Contract awards absolute XP directly — no client multiplier (June 2026 rework).** The contract writes the displayed values straight into `account_points`. There is **no 10× multiplier, no client-side derivation, no per-row leaderboard fetch**. `get_top_builders` is directly usable for ranking, and CLI output that surfaces XP should render the contract value as-is. The old "raw values × 10 on display" model is gone — delete any code that multiplies contract reads.

**Why first-two-deploys instead of a tutorial flag.** Earlier scoring used a per-deploy `is_tutorial` flag worth 100 XP; it was gameable (any caller could set it true and farm). Gating on `get_owner_app_count` is ungameable (a count is a count). Anything in code/docs referring to a "tutorial flag", `is_tutorial`, or a separate `deploy_count` field is stale.

**Contract rework rides the v14 redeploy. Tracking issues:** #286 (umbrella), **#287 P0** (star 1→10, mod-credit 1→50 — two one-line bumps, must-land), **#288 P0** (first-two-deploys +100, drop moddable bonus, gate on `get_owner_app_count` — must-land), **#289 P1** (username +25 — can slip without blocking Summit; if it slips the username action just awards no bonus). CR1/CR6/CR7 are closed (folded into this rework). If #287/#288 don't land in v14, prize behaviour won't match the spec.

**Stars = what users award.** Binary, one-way, permanent. Cumulative count displayed (never average X.X / 5). Self-starring forbidden at the contract level. Unlimited per user. Each star earns the app owner +10 XP.

**CR2 status: `unstar` is still in the contract source AND the UI still has `handleUnstar`.** Spec position: stars should be one-way / permanent — the unstar path is a points-removal griefing vector (much easier to organise removing points from a competitor than awarding them). Both contract and UI changes pending. Interim policy until CR2 lands: `unstar` must NOT call `refund_points()` — `star_count` decrements (visible), but `account_points` stays at the earned value (don't deduct XP off the leaderboard).

**`modded_from` is a transient `publish()` parameter, BUT lineage IS recorded on-chain.** v11 of the registry added `get_lineage(start, count)` / `get_lineage_count()`: each `(child, source)` edge is recorded in `lineage_at` with `lineage_recorded` per-domain dedupe. The CLI passes `modded_from` to award the "your app is modded" XP to the source owner and update `mod_credited`, then the contract also writes the lineage edge. The "Modded from: domain01.dot" string rendered on the App Detail Page still reads from the off-chain Bulletin metadata blob — pick whichever fits the call site.

**Leaderboard is V1.** Top Builders reads `get_top_builders` and renders the score as-is (no multiplier). "Most starred" / "most modded" sort options on the Apps grid shipped June 2026 (V2 #16 — Built, on-chain sort indexes).

## Prize logistics

**€5,000 total prize pool, finalised June 2026:**

| Prize | Award | Determined by |
|---|---|---|
| Leaderboard 1st / 2nd / 3rd (most XP) | €1,000 / €500 / €250 | On-chain `get_top_builders` at closing |
| Most Modded App | €1,000 | On-chain per-app `mod_count` at closing |
| Most Starred App | €1,000 | On-chain per-app `star_count` at closing |
| Wildcards (innovation / interesting use cases) | €500 × 2 | Judges at venue, off-chain — walk up and show them, no nomination form |

Ties on per-app prizes are split equally. No "tutorial completion" verification step — eligibility reads directly from on-chain XP and per-app `mod_count` / `star_count`. Judges' briefing weights coordinated work (pair-deploys, onboarding others, multi-author, modders building on each other). *(The earlier ~$2k pool and the "Spark" longest-mod-chain prize are dropped — don't reference them.)*

## Display names

Precedence (implemented in playground-app via `displayNameForAccount`):

1. **Registry username** — claimed by the user via the in-app `SetUsernameModal`. Stored on the registry contract via `set_username`. Lowercase-normalised, case-insensitive uniqueness enforced.
2. **Wallet name from host** — the OS-level account label the user set in their Polkadot mobile app. Read via Host API at runtime. No on-chain footprint.
3. **Truncated H160** — fallback, e.g. `0x4a3b…f2d1`. Used when the user has neither claimed a username nor named the account on their phone.

CLI output that surfaces the user's display name should match the precedence — read the registry first, fall back to wallet name, fall back to truncated H160. The "You're live as [current display name]" line in post-deploy output uses the same lookup.

**V1 prompts to upgrade** (in the playground-app, not CLI): first-star auto-prompt and leaderboard banner. V2 adds polish (#22a-d): auto-prompt SetUsernameModal, leaderboard banner copy, adjective-adjective-noun handle fallback for users with no registry username AND no wallet name (`quiet-curious-otter`-style, stored on Bulletin off-chain), and first-encounter name reveal.

**Out of scope for V1:** adjective-noun name generation (V2 #22c), Bulletin storage for names (V2), first-encounter ceremony reveal moment (V2 #22d). The wallet-name fallback handles the common case; the modal handles the upgrade path.

## RevX deep-link contract

`revx.dev/editor?mod=<domain>&quest=<level>` — `mod=` required; `quest=` only for the tutorial (RevX reads `quests.json`, checks out the right branch, loads the per-level AI skill). Single "Open in RevX" button per app, same for tutorial / sample / participant apps.

RevX downloads source as HTTPS tarball (same as the CLI). After load: PoP auth (QR on desktop, direct on mobile), AI chat pre-loaded with the template's `CLAUDE.md` + Product SDK skills, CLI bridge maps RevX UI actions to `playground build`, `playground deploy --playground`. RevX should default to working RPC config so testers don't need to manually switch network.

**RevX deep-link prepopulated prompts (built June 2026, V2 #86).** RevX accepts `?prompt=<url-encoded-text>` (clears project, loads starter Rust template, opens `src/starter.rs`, activates `polkavm` skill, auto-submits the prompt). Companion params: `?import=<cid>` (load by Bulletin CID), `?example=<name>`, `?fresh=1`, plus the original `?mod=<domain>`. So an IslandPortal CTA can open RevX with `?prompt=start%20tutorial` and the user is immediately in a building-with-AI state.

**Web container constraint:** the RevX browser web container is Node/TS/JS only — cannot run the IPFS binary. The CLI's Kubo-binary path (see `jsMerkle: false` invariant) blocks RevX's main storage upload until bulletin-deploy's pure-JS merkleizer is fixed.

## CLI deep-link contract (`playground mod`)

`playground mod` downloads source as an HTTPS tarball via `codeload.github.com` — no git, no `gh`, no clone. Forms: `playground mod` (interactive picker over moddable apps), `playground mod <domain>` (direct). After download, `setup.sh` runs and stays visible/logged. `playground mod` writes the source domain into deploy metadata; at publish time the CLI passes it as the transient `modded_from` parameter to the registry's `publish()`, which awards the source owner the "your app is modded" XP and updates `mod_credited`. The contract also records the lineage edge in `lineage_at` (v11+).

Before `playground mod` touches the user's machine it shows a community-code disclaimer (`src/commands/mod/communityNotice.ts`, June 2026) — marketplace-standard "apps published by community, unreviewed; downloads source and runs setup script." This is the interim mitigation for #90 (setup.sh deprecation); the full setup.sh replacement is deferred.

Subsequent commands: `playground build` (auto-detects Rust/Solidity/EVM + frontend, picks the package manager), `playground deploy --playground` (full 5-step pipeline). The moddable-by-default fix (#24) is V1 P0 — the interactive prompt now defaults to Yes (June 2026, CLI v0.28.x), but the non-interactive default is still non-moddable; Session 02 testers (Will, others) had hit `--moddable requires a GitHub origin` and been stopped from deploying.

## Moddable default flow

`playground deploy --playground` should default to moddable. **Partial fix landed (June 2026, CLI v0.28.x):** the interactive prompt cursor now defaults to Yes. The non-interactive default (the `--no-moddable` behaviour in `src/commands/deploy/index.ts`) is still non-moddable — the full flip (#24) is pending. The spec intent is to read an existing public GitHub origin, deploy moddable automatically, and prompt only if missing. **The CLI itself never invokes `gh`** (see invariants above) — that's the playground-app's job, not the CLI's. Non-moddable apps still get DotNS + Bulletin links; they just can't be cloned.

## quests.json (tutorial only)

Only the tutorial ships a `quests.json` — it's the manifest RevX reads to check out per-level branches and load per-level AI skill files (`.claude/skills/level-N-*.md`). Sample apps do NOT have a `quests.json` — quest ideas in their README are plain text inspiration. The CLI `--quest` flag was removed because the picker happens inside the editor (RevX's QuestPickerDialog or `playground mod`'s SetupScreen), not because quests are gone.

```json
{
  "schema_version": 1,
  "track_id": "unique-track-id",
  "title": "App Name",
  "description": "Brief description",
  "quests": [
    {
      "id": "quest-id",
      "title": "Quest Title",
      "difficulty": 1,
      "estimated_minutes": 15,
      "branch": "quest/branch-name",
      "required_tools": ["dot-cli"],
      "ai_skill_hints": [".claude/skills/skill-file.md"],
      "teaches": ["concept 1", "concept 2"],
      "summary": "What the developer will do and mod",
      "acceptance": ["Specific, testable criterion 1", "..."]
    }
  ]
}
```

The tutorial repo also ships `setup.sh` + `.claude/skills/`. Generic Product SDK skills are propagated into templates and sample apps via `playground-app-template`.

## V1 CLI feature scope

- `playground init` — first-time setup, QR auth, session key, dependency install (login + toolchain run concurrently), funding, account mapping, Bulletin allowance, optional playground username claim. Alice grants 1000 tx / 100MB. Alice sends 10 PAS if balance < 1 PAS. `Revive.map_account` signed by user.
- `playground mod` — HTTPS tarball via `codeload.github.com`, interactive picker over moddable apps, source-domain capture, moddable preflight check.
- `playground build` — auto-detect Rust/Solidity/EVM + frontend, picks the package manager.
- `playground deploy --playground` — full 5-step pipeline. Flags: `--signer dev|phone`, `--domain`, `--buildDir`, `--no-build`, `--playground`, `--private`, `--moddable`/`--no-moddable`, `--suri`, `--env` (defaults to `paseo-next-v2`). Deploy-time metadata prompt (#203) supports tags but is unpolished (June 2026) — name/description/README prompting still pending.
- `playground contract` — contract install + deploy.
- `playground decentralise <url>` (CLI v0.26.0+) — point at a live static site URL (e.g. a GitHub Pages page), get back a `.dot` URL hosted on Bulletin. Interactive TUI: URL → signer → name → publish to Bulletin + .dot. Optional `--playground` flag also publishes to the playground registry. Powers the IslandPortal "Launch your first .dot site" quest on the Playground tab. Note: spelling is `decentralise` (British, matches spec); some earlier code references `decentralize`.
- `playground logout`, `playground update` (self-update from GitHub releases).
- **Signer behaviour:** `--signer dev` requires 0-1 phone approvals (Alice signs); `--signer phone` requires 3-4. Interactive prompt if omitted.
- **`--env` flag** defaults to `paseo-next-v2`. Other envs throw "not supported" until wired into `CONFIGS`.
- Plain-English error messages for all common on-chain failures. Session 02 raw-error blockers: PoP/DotNS ~100-word unrecoverable error, chunk-verification `Missing CIDs: bafkrei...` mid-deploy, raw npm EEXIST and JSON Parse EOF errors.
- Mobile signing hang detection — inline fallback prompt if mobile signing has no response after N seconds: "Mobile signing hasn't responded — retry, or use a dev signer? [y/N]". (V2 — #21b)
- Up-front phone approval count on `playground deploy`: "This will need 3 approvals on your phone — keep it ready." (V2 — #21c)
- `playground mod` post-clone UX — auto-`cd` into cloned dir or surface a clear copyable `cd <name>` line; detect when `playground deploy` is run from outside a project and print a helpful message. (V2 — #21a)

**Removed from V1, do not reintroduce:** `playground voucher`, conditional voucher prompt at `playground init`, soft-limit communication, Bulletin expiry countdown / two-week expiry narrative.

## CLI binary name (closed)

Closed in spec v0.25. Binary is **`playground`** with short alias **`pg`** — both interchangeable (`playground init` == `pg init` for every subcommand). Old `dot` binary no longer installed. CLI v0.27.0 (1 June 2026). Old code paths, comments, file/dir names referring to `dot` should be renamed opportunistically; user-facing strings ARE renamed in current code per the Session 02 sweep.

## Vocabulary the product uses

CLI output, error messages, and command names should follow:

| Concept | Term used | Avoided |
|---|---|---|
| Taking on a challenge | accept a quest / join a quest | try / attempt / do |
| Modifying an app | mod (verb and noun) | remix / fork / clone |
| The modified version | your mod / your app | your fork / your remix |
| Full deploy + publish | `playground deploy --playground` | dot ship |
| Publishing to the registry | deploy / publish | submit / upload / release |
| The structured tutorial | Rock Paper Scissors tutorial / the tutorial | The Stadium / Polkadot Games Tutorial |
| Open-ended modding challenge | quest idea | hackathon / challenge |
| Working apps with quest ideas | sample apps | templates / starter apps |
| User identity | account | wallet |
| Deployment network | Polkadot Hub | mainnet (sparingly), Paseo never in user-facing copy |
| Host ↔ product transport layer | TrUAPI | TruAPI / Host API / triangle-js-sdk / host-api |
| App others can mod | **moddable** (two d's) | modable (one d) |
| Leaderboard score | **XP** | points (legacy term) |
| The registry browser tab | **Apps** | dAppStore / store / dApp store |
| The command-line tool | playground CLI (binary `playground`, alias `pg`) | DOT CLI / Polkadot CLI / the dot CLI |

## Out of scope (per spec)

- Building from scratch (entry is always tutorial / sample app / empty starter).
- Multiple tutorial tracks (Rock Paper Scissors is the only structured tutorial).
- DeFi quests (regulatory).
- Permanent deletion by owners (visibility toggle only; admin hard delete is admin-only).
- Account creation outside the Polkadot app / PoP flow.
- Contract-modding on mobile (Level 1 / UI-only quests on phone).
- Chat Extensions sharing.
- Vouchers / `playground voucher` / soft-limit messaging / Bulletin expiry countdown UI.
- Account status component — parked, intentional given the devnet.
- DOT airdrop as a W3S mechanism.
- Display name generation — no adjective-noun generator, no Bulletin storage for names, no first-encounter ceremony.
