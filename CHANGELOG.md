# playground-cli

## 0.46.2

### Patch Changes

- f05c69d: Update the `@parity/product-sdk-*` dependencies to the 0.21.0 release line (contracts 0.10.1, descriptors 0.9.0, host 0.15.1, tx 0.4.1, cloud-storage 0.10.0, keys 0.3.18, terminal 0.7.1; chain-client 0.10.0, local-storage 0.3.4, signer 0.12.1 transitively). The motivating change is `descriptors@0.9.0`, which regenerates the paseo-bulletin descriptors for the upcoming v0.0.22-paseo Bulletin runtime (spec 1_000_022, new `DataRenewal` pallet) — fixing commands that broke against the upgraded Bulletin chain. The rest of the line is additive: `tx@0.4` adds `TxValidityError`, `contracts@0.10` adds `isContractAccountMapped` + origin validation, `terminal@0.7` adds `AllowanceExpiredError` and optional explicit `productId` on the allocation APIs.

  Also upgrade the CDM packages to match: `@parity/cdm-builder` 3.2.0 → 5.0.1, `@parity/cdm-codegen` 0.6.23 → 0.6.26, `@parity/cdm-env` ^2.1.0 → ^2.4.0. cdm-builder 5.x is built against the same `descriptors@0.9.0` / `contracts@0.10.x`, so all five cdm-builder version-skew cast seams in the contract pipeline (`asCdmAssetHubApi`, `asCdmAssetHubDescriptor`, `asCdmBulletinApi`, `asCdmBulletinDescriptor`, `asCdmRegistryContract`) are deleted — the types now align directly. cdm-env 2.3.0 moves the paseo preset's meta-registry address to the new-generation proxy registry (`0xc1a73a4f93fde65b1cb1680baead248073566cb0`), so contract installs and playground publishes now resolve against the current registry.

## 0.46.1

### Patch Changes

- 2ce7c9b: Contract deploy now shows an actionable message when `cargo metadata` fails, instead of dumping the raw `Command failed: cargo metadata … --no-deps` command. The message explains the likely causes (missing Rust toolchain, offline git-dependency fetch, or an invalid Cargo.toml) and still surfaces cargo's own diagnostic (e.g. the offending `Cargo.toml` line) so a malformed manifest stays fixable.

## 0.46.0

### Minor Changes

- 56be8d2: Bump the full `@parity` dependency stack to latest published and migrate to the
  `Result`-based SDK error API.

  - `@parity/product-sdk-*` to latest: host 0.14.1 (now built on `@parity/truapi`
    instead of the former `@novasamatech` in-container host-api), cloud-storage
    0.8.1, contracts 0.9.2, descriptors 0.8.0, keys 0.3.16, terminal 0.6.2, tx
    0.3.2. Dropped the temporary vendored headless-host prerelease.
  - `@parity/polkadot-app-deploy` 0.11.0 → 0.13.1, `@parity/dotns-cli` 0.7.2 →
    0.8.0, `@parity/cdm-builder` 3.1.7 → 3.2.0, `@parity/cdm-codegen` 0.6.20 →
    0.6.23, `@parity/cdm-env` 2.0.6 → 2.1.0, and `polkadot-api` aligned to 2.2.1
    (single runtime instance).
  - Migrated command handlers to the `Result` API (`submitAndWatch`, contract
    `.tx`, cloud-storage `checkAuthorization`, `ContractManager.fromLiveClient`),
    preserving user-facing error messages — and a failed registry publish now
    surfaces the on-chain revert reason (e.g. `Unauthorized`, `NotRevealed`)
    instead of a generic "reverted", failing fast on deterministic reverts.
  - Retired the `summit` / `w3s` environment: polkadot-app-deploy 0.13.x removed
    it from `environments.json` and product-sdk-descriptors 0.8.0 dropped the
    `summit-*` descriptors. Only `paseo-next-v2` is wired.

## 0.45.0

### Minor Changes

- 16ab67f: Switch the active testnet back to paseo-next-v2 (reverting the Web3 Summit switch).

## 0.44.2

### Patch Changes

- 978e9f5: Fix `playground login` hanging during the IPFS (Kubo) install step. The installer now runs `install.sh` without sudo first (falling through to `~/.local/bin`) and uses `sudo -n` as a fallback so it no longer blocks on a sudo password prompt.

## 0.44.1

### Patch Changes

- bf8e403: Use the active Playground contract registry for contract installs instead of stale `cdm.json` registry snapshots.

## 0.44.0

### Minor Changes

- 316ebff: Switch the active testnet to Web3 Summit. Balances and drips now read in SUM, and all chain interactions (Asset Hub, Bulletin, People, registry) target the summit endpoints. The playground registry contract resolves live from the summit CDM meta-registry.

### Patch Changes

- f3bb0ba: Fix every UI-rendering command crashing with `jsx_dev_runtime.jsxDEV is not a function` (`--version`/`--help` were unaffected). The compiled binary's `--define process.env.NODE_ENV='"production"'` forced React's JSX runtime to its production build (which omits `jsxDEV`), while bun's bundler still emits `jsxDEV` calls — so every Ink render threw. Drop the define from all `bun build --compile` invocations (build, cli:install, and the three release workflows) so the runtime and the emitted JSX transform agree again.

## 0.43.6

### Patch Changes

- 6ae57ab: Refresh the `@w3s/playground-registry` snapshot in `cdm.json` to v17. The registry contract was redeployed at a new address (`0x4a32e0FB190112F169308Ebc8aC5A4e624263035`), so contract deploys and playground publishes now target the current contract. The v17 ABI drops the unused `rateApp`, `removeRating`, `getContextId`, and `refreshReputationReference` functions.

## 0.43.5

### Patch Changes

- b3923b0: Build the compiled CLI binary with `process.env.NODE_ENV=production` so React ships in production mode. This removes the spurious React development warnings (e.g. "Cannot update a component while rendering a different component") that surfaced during `playground deploy`, and makes React faster and smaller in the shipped binary.

## 0.43.4

### Patch Changes

- 3afef57: Prepare direct chain clients for Summit descriptors when the active environment is switched.

## 0.43.3

### Patch Changes

- fc1ddd3: The dedicated testnet funder seed is no longer hardcoded in the binary. It is
  read from the `MASTER_FUNDER_SEED` environment variable (CI injects it from a
  repository secret); when unset, funding falls back to Alice alone. The dedicated
  funder is now the primary account (drawn down ahead of public Alice) and is
  derived at the bare root (empty derivation path). This affects only the E2E
  suite and operator tooling — no end-user command funds from this chain.

## 0.43.2

### Patch Changes

- 562d024: Bump CDM contract packages to use the fixed contract metadata Bulletin publish path.

## 0.43.1

### Patch Changes

- 3c16fbd: Reword the builder-identity gate notice for signed-in-but-not-joined users to "You're signed in, but you haven't joined the competition yet." for consistent "join the competition" wording across all gate messages.

## 0.43.0

### Minor Changes

- b6d21f5: Gate `mod`, `init`, `deploy`, `decentralize`, and `deploy-all` behind a revealed
  builder identity. These commands now require you to be signed in (`playground
login`) and to have joined the competition at playground.dot in your desktop
  app — the CLI reads your product account's on-chain identity binding from the
  playground registry (via the keyless read-only origin, no phone tap) and refuses
  to act for anonymous accounts. When you haven't joined yet, the command prints a
  friendly yellow notice explaining how to become a builder and exits without
  error. The check is signer-mode-agnostic: dev and `--suri` runs are gated too,
  but once you've revealed yourself they work as before.

## 0.42.2

### Patch Changes

- 31f55f5: Clarify the `contract` command help: replace the opaque "Run CDM contract workflows" description with "Install and deploy smart contract libraries for your app" and add a `<command> [options]` usage hint so its subcommands are discoverable from `playground --help`.

## 0.42.1

### Patch Changes

- a30a276: Update bundled dependencies to their latest stable releases:

  - `@parity/polkadot-app-deploy` 0.10.0 → 0.11.0 — headline reliability fix:
    resolves the nonce-collision / GRANDPA re-upload reconnect bug (upstream
    #946), so a WebSocket halt mid re-upload now recovers via `doReconnect()`
    instead of failing the deploy. Additive drop-in otherwise (`deploy()`
    signature and the `DeployOptions` we use are unchanged).
  - `@parity/cdm-builder` 3.1.5 → 3.1.6 (exact), `@parity/cdm-codegen`
    0.6.18 → 0.6.19 (exact), `@parity/cdm-env` ^2.0.5 → ^2.0.6 — the cdm-env
    bump ships the Summit `w3s` meta-registry address.
  - `@parity/dotns-cli` 0.6.8 → 0.7.2 (exact) — bundled-binary refresh; the
    CLI consumes only `dist/cli.js`.
  - Refreshed the `@parity/product-sdk-*` caret floors: contracts ^0.7.7,
    cloud-storage ^0.6.4, keys ^0.3.10, tx ^0.2.14.

## 0.42.0

### Minor Changes

- 5d9cbfc: Add `playground init` to start a new project from the playground starter template. It's a shorthand for `playground mod playground-template`, giving new users a one-command way to scaffold an app to build on.

## 0.41.1

### Patch Changes

- ce94485: install.sh now prints a shell-specific reload hint (`source ~/.zshrc` / `~/.bashrc` / fish config, or open a new terminal) on a fresh install, so users aren't left with a `playground`/`pg` command that isn't found until they manually reload their shell.

## 0.41.0

### Minor Changes

- 6397a65: `playground mod` now detects the package manager a project uses (pnpm/yarn/bun/npm)
  and, when it (or Node.js) is missing, offers to install it with one confirmation
  before running the project's setup, instead of failing with a confusing error.
  `playground deploy` and `playground build` install a missing manager automatically
  as part of the build step. macOS and Linux are supported; non-interactive runs
  install without prompting.

## 0.40.2

### Patch Changes

- 0b9a7af: Polish the deploy and mod prompt copy: the mod next-step text now refers to your AI agent generically, and the deploy build prompt explains that pressing enter keeps the default rebuild choice.

## 0.40.1

### Patch Changes

- 3df9e22: `playground login` now clears the pairing QR code from the screen once the phone scans it and finishes signing in, leaving a clean logged-in summary. Previously the QR stayed on screen for the rest of setup; it is no longer rendered inside the live UI region (which could also cause it to duplicate on shorter terminals).

## 0.40.0

### Minor Changes

- f830ec0: Add `playground status`: show your signed-in product account (SS58 + H160), native and PGAS balances, Bulletin authorization validity (with a time estimate), and how recently you paired your phone — all read-only, with no phone interaction.

  Fix the native token decimal scale: PAS/SUM are 10 decimals (verified live against the chain), not 12. This corrects every balance display (amounts were under-shown 100x) and makes `playground drip` transfer the documented 1 PAS per run (10 PAS cap) instead of 100 PAS (1000 PAS cap). PGAS is shown at the same 10-decimal scale.

## 0.39.1

### Patch Changes

- 1000519: `playground mod` now always prints the "Next steps" footer for a successful mod. It was previously hidden whenever the app shipped a `setup.sh`, which left apps whose setup script does not print its own next-steps guidance (e.g. the tutorial app) with no footer at all.

## 0.39.0

### Minor Changes

- b71124b: Replace the `defi` app tag with `site`. The `site` tag is now the first option offered in the deploy/decentralize tag picker and the `--tag` flag, and `defi` is no longer accepted.

## 0.38.8

### Patch Changes

- 3a4b9e2: Remove the username step from `playground login`. The flow no longer prompts you to claim a registry handle and no longer displays a username in the header.

## 0.38.7

### Patch Changes

- bda42ed: The post-mod "Next steps" block now nudges toward the prepopulated `(prompt: "start tutorial")` AI prompt only when modding the `playground-tutorial.dot` app, rather than whenever a quest track was started.

## 0.38.6

### Patch Changes

- fcf2269: When a mistyped command or option is too far off for commander's built-in "Did you mean …?" suggestion, the error now tails with a pointer to `playground --help` (matching git's behavior). Covers the root program and every subcommand, including option typos on `login`, `deploy`, etc.

## 0.38.5

### Patch Changes

- ed098be: Distinguish a wrong working directory from a genuinely unrecognised project in `dot build` / `dot deploy`. When no `package.json` is found, the error now points at the current directory ("Are you in your project directory? cd into it first, or point the command at it with --dir <path>.") instead of the misleading "No build strategy detected" message that suggested editing a package.json that isn't there.

## 0.38.4

### Patch Changes

- 8026977: `playground mod`: stop showing a warning when an app has no `setup.sh`. Apps without a setup script are the common case, and surfacing it as a yellow warning row alarmed users. The step is now skipped silently and the usual "Next steps" footer is printed as before.

## 0.38.3

### Patch Changes

- 942f045: deploy: warn before redeploying contracts that CDM package names are owned by their first deployer. When you choose "yes, I changed contracts", `playground deploy` now shows an acknowledgement explaining that if the app is a mod (or you edited contracts someone else authored), the names in `cdm.json` belong to the original author and the deploy will fail unless you rename them first. Press Enter to continue or Esc to exit and rename.

## 0.38.2

### Patch Changes

- 8ba2804: `playground mod` now nudges users toward the guided tutorial: when a quest track is started from the picker, the post-clone "Next steps" hint reads `edit with claude (prompt: "start tutorial")` instead of the plain `edit with claude`. The quest and app pickers also tear down their Ink instance fully before the next screen mounts, so a half-unmounted picker can no longer swallow the following screen's keystrokes or leave a stale frame on top of it.

## 0.38.1

### Patch Changes

- 5a6e09b: When deploying without a logged-in session, the `playground deploy` signer picker now shows the phone signer greyed out and unselectable (instead of hiding it), so users can see the option exists. The "mobile signing unavailable" notice moved below the options.

## 0.38.0

### Minor Changes

- 116964a: `playground decentralize --path` can now publish moddable apps: the interactive flow asks "let others remix (mod) this app?" when publishing a local directory to the playground (with the same git-origin preflight and recovery menu as `playground deploy`), and headless mode accepts a `--moddable` flag. Publishing a local directory also inlines the project's README.md as the app's playground detail page — resolved from the enclosing git repo root, so it's found even when `--path` points at a build dir like `./dist` (the same anchor the moddable git-origin preflight walks up to) — and the TUI now says so up front at the publish prompt. Mirrored URL sites are unchanged (no git source — never moddable, no README).
- 7319eb6: Interactive `playground decentralize` can now deploy a local directory: a new first prompt asks whether to mirror a live URL or upload an already-built static site (e.g. `./dist`), then both flows share the same signer/domain/publish steps. The confirm screen shows the resolved upload root and file count for local directories.
- 78b8fee: `playground decentralize --path <dir>` deploys a local static directory (e.g. `./dist`) to Bulletin + DotNS without mirroring a URL. Mutually exclusive with `--site`; auto-generated `.dot` names derive from the directory basename.

## 0.37.2

### Patch Changes

- 86ac724: Rework the `playground mod` quest picker so the start action is the first row ("START:" + the first unlocked level) and locked levels render greyed out below it, instead of a read-only level list with a separate Start button underneath. Enter now starts the tutorial immediately; removing cursor navigation also fixes rapid arrow keypresses getting lost.

## 0.37.1

### Patch Changes

- ebc64b5: Sync the `playground decentralize` prompts with `playground deploy`:

  - The signer pickers in both commands list your phone signer first and start the cursor on it (when logged in). The "dev signer earns no XP" warning now appears below the options, only while the dev signer is highlighted, and disappears when you move back to the phone signer.
  - `playground decentralize` now shows the same magenta help boxes as deploy above its signer, domain, publish, and (new) tags prompts, and its intro box uses the same accent style.
  - The "publish to the playground registry?" prompt now lists "yes" first and selects it by default.
  - `playground decentralize` gained a category-tag step and a `--tag` flag (whitelisted to the playground tags, requires `--playground`), matching deploy; the chosen tag is written to the published app metadata and shown in the confirm summary.

- ebc64b5: Clarify the "update available" banner: it now reads `Run pg update to update the CLI.` (previously "playground update to upgrade") so the suggested command matches the wording.

## 0.37.0

### Minor Changes

- 9e380a6: `playground login` now ends with a "Try one of these next" box suggesting the commands to run after signing in (`pg decentralize`, `pg mod`, `pg deploy`), each with a short description, so newly paired users know where to go next.

### Patch Changes

- 2a4e81e: `playground login` no longer prints a "Statement subscription error: … Not connected" stack trace after a successful sign-in. When the login adapter is destroyed, an in-flight statement-store subscription can surface a bare `Error: Not connected` from the just-closed websocket. That benign teardown artifact was already swallowed as an unhandled rejection, but the statement-store package also logs it directly from its subscription error callback; the local patch that silences that log now matches the bare "Not connected" shape in addition to `DestroyedError`, mirroring `isBenignUnsubscriptionError`.

## 0.36.8

### Patch Changes

- eab0a33: `install.sh` no longer shadows an existing `~/.profile` (or `~/.bash_login`) for bash users. The installer creates a `~/.bash_profile` bridge so the `~/.bashrc` PATH entry loads in login shells (every macOS terminal tab). Previously, creating that file from scratch silently took precedence over a pre-existing `~/.profile`/`~/.bash_login` — which login bash reads only as the first existing of `~/.bash_profile` → `~/.bash_login` → `~/.profile` — so the user's login-shell config stopped loading. When the installer now has to create `~/.bash_profile`, it first carries forward a sourcing line for the file bash would otherwise have read. An already-existing `~/.bash_profile` is left untouched apart from appending the `~/.bashrc` source line.

## 0.36.7

### Patch Changes

- 47c8399: `playground deploy` no longer crashes with an opaque `Raw mode is not supported on the current process.stdin` error when run without an interactive terminal (agents, CI, piped input). A new `-y, --yes` flag runs the deploy non-interactively using defaults (requires `--domain`; `--signer` defaults to `dev`). When prompts are needed but stdin is not a TTY and `--yes` was not passed, the command now exits with an actionable message pointing at `--yes` instead of the internal Ink crash.

## 0.36.6

### Patch Changes

- 7b649f6: `playground deploy --no-build` now validates the build directory up front. A missing or mistyped `--buildDir` fails immediately with an actionable message (`Build directory not found: …`) before the availability check, summary, and any on-chain work, instead of surfacing late as an opaque `Path not found` inside the storage phase.

  The build directory is now resolved against `--dir` (the project root) for the storage upload as well, so deploys run with `--dir` pointing outside the current working directory upload the directory the build actually wrote to.

## 0.36.5

### Patch Changes

- 1e51790: Long status-row messages no longer fuse into their label when they wrap (e.g. "deploy failedNo smart contracts…"). The label and value now live in separate flex boxes so a wrapping value can't swallow the label's trailing space.

## 0.36.4

### Patch Changes

- fd7f49f: Fix a confusing `pg deploy` failure when the contract pre-step runs against a project with no contracts. Previously, requesting contract deploy (via `--contracts` or the TUI prompt) in a frontend-only project or from the wrong directory failed with the cryptic "No library specified and no dependencies found in cdm.json", surfaced in the TUI under a misleading "Signing Failed" banner. Deploy now reports an actionable error naming the directory and the likely cause, the standalone `pg contract install` error message points at the cdm.json it inspected, and non-signing contract failures are no longer mislabeled as signing failures.

## 0.36.3

### Patch Changes

- 7009f4e: `deploy`: warn that the dev signer earns no XP before you pick it.

  - The signer-choice screen now shows a yellow callout above the options, when phone signing is available, explaining that the dev signer publishes from a shared test account and so earns no XP, and that picking your phone signer publishes from your own account and earns XP.
  - When you are not logged in, the existing "Mobile signing unavailable" notice now also mentions that logging in lets your deploys earn XP.

- 7009f4e: `login`: show that setting a username earns 25 XP.

  - The "set a username?" step at the end of `playground login` now shows a green callout above the choice, telling users that setting a username grants them 25 XP and claims their handle, so the incentive is visible before they decide to skip.

## 0.36.2

### Patch Changes

- c3f84eb: `decentralize`: explain the auto-generated domain suffix, warn on large sites, and document cancel.

  - Auto-generated free `.dot` names (e.g. `dominique-io-urcn30`) now show an inline note explaining the random suffix lets anyone register the name without a proof-of-personhood credential — it was previously unexplained and read as a bug.
  - Mirroring a large site now surfaces a "large site — this may take several minutes" warning once the download crosses 200 files, in both the interactive TUI and headless output.
  - The TUI and headless output now document that Ctrl+C cancels at any time.

## 0.36.1

### Patch Changes

- aa6fdd2: Handle the IPFS "repo needs migration" failure during deploys.

  - `playground login` now detects a stale local Kubo repo (older on-disk format than the installed `ipfs` binary) and runs the one-time `ipfs repo migrate` as part of setup, so deploys don't later crash inside `ipfs add`.
  - When a deploy still hits the migration error (e.g. the IPFS binary was upgraded after login), the cryptic `Command failed: ipfs add … repo needs migration` is replaced with a clear instruction to run `ipfs repo migrate` or re-run `playground login`.

## 0.36.0

### Minor Changes

- ceab059: Upgrade the product-sdk / triangle-js-sdks / DotNS dependency stack and add the
  Summit network token symbol.

  - **`@parity/product-sdk-terminal` `^0.4.0` → `^0.5.0`**, which pulls the
    `@novasamatech/*` host stack (host-papp, statement-store, host-api, …) from
    `0.8.6` to `0.8.7`. Also bumps the within-caret product-sdk floors
    (`contracts` `0.7.4`, `cloud-storage` `0.6.1`, `descriptors` `0.6.1`, `keys`
    `0.3.7`, `tx` `0.2.11`) and `@parity/dotns-cli` `0.6.6` → `0.6.8`.
  - **You will need to re-pair your phone once after this upgrade.** host-papp
    0.8.7 renamed the on-disk session storage key (`SsoSessionsV2` →
    `SsoSessionsV3`) and added a required field to the persisted session; there is
    no migration, so existing pairings are invisible until you run `playground
login` again. Cached allowance slot keys are unaffected.
  - **New `SUM` token symbol for the Summit network.** Token amounts (balances,
    `playground drip`) now read the active env's symbol, so flipping the network to
    Summit relabels every amount from `PAS` to `SUM` automatically.

## 0.35.5

### Patch Changes

- 9b0ab99: Surface the real cargo-pvm-contract build error during `pg` install instead of a
  generic "Command failed (set -euo pipefail …)". `runShell` now accepts an optional
  `description`/`failurePrefix`, and the cargo-pvm-contract toolchain step uses them so
  failures report a readable label plus the underlying build output.

## 0.35.4

### Patch Changes

- 274f022: deploy: the "Moddable Setup Needed" screen is no longer a dead end. When the source check fails (for example, no GitHub origin is configured), the deploy now offers "continue without moddable" and a clean exit (exit 0 with a friendly nudge), instead of forcing the whole deploy to abort with an error. The interactive message also no longer references CLI flags.

## 0.35.3

### Patch Changes

- e1413f5: Fix mod-of-a-mod XP attribution for SDK/RevX deploys. The `moddedFrom` lineage
  field was only rewritten by the `dot mod` TUI, while SDK consumers that clone a
  source app themselves (RevX in a WebContainer) and deploy via `runDeploy` re-published
  whatever `moddedFrom` the cloned repo's `dot.json` carried. Because a moddable app
  that was itself modded from the tutorial ships `moddedFrom: <tutorial>` in its
  committed `dot.json`, modding such an app credited the tutorial's owner instead of
  the immediate parent's owner (playground-app#335).

  `runDeploy` now accepts an explicit `moddedFrom`, and an explicit value takes
  precedence over the (possibly stale) `dot.json` field so callers that just performed
  the mod record the true immediate parent. The resolved value drives both the on-chain
  lineage edge and the metadata JSON `moddedFrom` (so the badge and the XP credit can't
  disagree), and is canonicalized to `<label>.dot` — an empty or malformed explicit value
  falls through to `dot.json` rather than recording garbage on-chain.

## 0.35.2

### Patch Changes

- b658814: `pg mod` now checks that a project's `setup.sh` can find a JavaScript package manager (npm, pnpm, yarn, or bun) before running it. If the script references package managers but none of them are installed, setup stops early with a clear message instead of failing partway through with an opaque error. Scripts that fall back across managers (try bun, else pnpm, else npm) pass as long as any one is installed.

## 0.35.1

### Patch Changes

- 1b30c98: Handle missing system prerequisites on clean Linux installs (#248): `playground init` now checks for `curl` and a C linker and installs them (via `apt`) before the steps that need them, `install.sh` fails fast with the exact remedy when `curl` is absent, and the README documents the Debian/Ubuntu prerequisite line (`build-essential curl`).

## 0.35.0

### Minor Changes

- d166579: Add `playground drip` — top up your signed-in account with a little testnet PAS (1 PAS per run, up to a 10 PAS cap) when you're running low. It funds only your own product account (the one paired via `playground login`), not arbitrary addresses. If you're not signed in, or the shared dev funder is temporarily empty, it shows a clear note instead of an error.

### Patch Changes

- d166579: Fix PGAS smart-contract allowance landing on the wrong account, and fix the login mapping check reporting false "NOT mapped". RFC-0010 allowance requests now send `playground.dot` as the calling product id instead of the terminal's `dot-cli` namespace, so the phone's `Pgas.claim_pgas` mints to the playground product account (`playground.dot/0`) — creating, auto-mapping, and gas-funding it in one step, with no dev-account funding. Previously the claim targeted `dot-cli/0`, leaving the real product account unmapped. The login mapping verification now reads the best head (finalization on paseo-next-v2 lags ~80 s behind the just-included claim, so the old finalized-head read missed freshly-mapped accounts) with a short retry window. Existing sessions re-grant once on the next `playground login` (single approval dialog); the phone's approval prompt now also names the playground product instead of `dot-cli`.

## 0.34.7

### Patch Changes

- 7a50517: Give `playground login` accurate guidance when a resource allowance can't be granted. A wallet that declines a request (`Rejected`) and one that cannot provision it at all (`NotAvailable`, e.g. an out-of-date mobile build) now produce different messages: the former still says to re-run and approve on your phone, while the latter tells you to make sure you're on the latest version of the app. Previously both were reported as a generic "denied ... approve on your phone", which sent users into a re-run loop that could never succeed.

## 0.34.6

### Patch Changes

- 360cf07: Remove the Bulletin storage quota check and the per-deploy "Increase allowance" phone tap. The Bulletin `store` extrinsic treats the tx/byte allowance counters as soft limits — the chain only requires that an authorization exists and has not expired — so a quota-exhausted-but-valid slot uploads fine. Deploy and login now verify existence + non-expiry only, removing an approval many users hit unnecessarily.

## 0.34.5

### Patch Changes

- ec6fba8: Add the Web3 Summit network to the env catalog. The active network is now selected by a single `ACTIVE_TESTNET_ENV` constant in `src/config.ts`, so pointing a release at Summit is a one-line change. The `deploy`, `deploy-all`, and `decentralize` commands now honour that constant as the `--env` default (previously hardcoded to `paseo-next-v2`) and accept `--env summit`; valid `--env` values are single-sourced in `config.ts` so they can't drift from the env list. A new `config.test.ts` guard keeps every env's endpoints in lockstep with polkadot-app-deploy's `environments.json` and blocks the switch until the target env's CDM meta-registry address exists. The CDM meta-registry address is resolved per-env from `@parity/cdm-env` (never hardcoded), the faucet URL is single-sourced in `config.ts`, and connection/funder error messages now name the active network instead of always saying "Paseo".

## 0.34.4

### Patch Changes

- a58e9f3: Switch the deploy engine dependency from the closed-source `bulletin-deploy` to its open-source twin `@parity/polkadot-app-deploy` (code-identical at 0.10.0). No behavior change.

## 0.34.3

### Patch Changes

- 13008c8: Polish the `playground deploy` interactive prompts: drop the confusing `my-app` placeholder on the domain input (people tried to backspace it), default the "publish to the playground?" question to "yes", and order every prompt so the default option sits on top.
- 13008c8: `playground deploy` now opens with a short acknowledgement that your README.md becomes your app's detail page on the playground. Press enter to continue into the normal flow, or esc to exit cleanly and update the README first. The screen only appears in interactive mode, so scripted/headless deploys are unaffected.

## 0.34.2

### Patch Changes

- 96e8fa1: Refresh the bundled `@w3s/playground-registry` contract snapshot to version 7 (new contract address + metadata CID). The ABI is unchanged, so this only updates the fallback snapshot that backs live address resolution.

## 0.34.1

### Patch Changes

- e8c74b9: `decentralize` now works on deep page URLs (e.g. a Wikipedia article) instead
  of failing with "none was index.html". Page URLs are fetched with their
  requisites but without link recursion, so they no longer risk crawling an
  entire site, and a root `index.html` is materialised from the page itself (with
  a `<base>` so its asset links resolve) so the viewer renders the real page
  directly. A mirror is also no longer aborted just because a single requisite
  asset returned an HTTP error.

  Known limitation: sites that load their CSS through query-string URLs (e.g.
  Wikipedia's `load.php?modules=…`) render unstyled, because a file whose name
  contains `?`/`|` cannot be served faithfully over a static path.

## 0.34.0

### Minor Changes

- 08ced4c: Rename the `init` command to `login`. Setup and mobile QR pairing now run via `playground login` (or `pg login`); the old `init` name is no longer available. `install.sh` and all in-CLI hints, warnings, and help text refer to `login`.

## 0.33.1

### Patch Changes

- 5439702: Add an info box to the `playground deploy` domain prompt explaining how name length maps
  to the Proof-of-Personhood requirement: a name with a 9-character-or-longer base is open
  to everyone and deploys with no personhood check, names of 6 to 8 characters need Proof of
  Personhood, and names of 5 or fewer are reserved. The validation rules themselves are
  unchanged (a digit suffix must still be exactly two digits).

  Upgrade dependencies to latest: `bulletin-deploy` 0.9.0 → 0.10.0, `@parity/product-sdk-terminal`
  0.3.2 → 0.4.0, `@parity/product-sdk-descriptors`/`-cloud-storage` 0.5 → 0.6 (brings in the Summit
  Network env/descriptors ahead of wiring that chain into `CONFIGS`), the
  `@parity/product-sdk-contracts`/`-keys`/`-tx` patch releases, `@parity/dotns-cli` 0.6.1 → 0.6.6,
  and refreshed `@parity/cdm-*` lockfile entries. host-papp/host-api stay on the 0.8.6 mobile-pairing
  line (the only newer release is an 0.8.7 prerelease that would force a no-migration re-pairing).
  The descriptors 0.6.0 bump introduces a nominal `DotnsGateway` type-skew against `cdm-builder`,
  bridged with a cast seam in `contract.ts` (the contract pipeline never touches that pallet).

## 0.33.0

### Minor Changes

- b25efa2: Add `playground deploy-all` for deploying multiple `.dot` apps in one invocation.

  Apps are listed in a JSON manifest and built in parallel (`--concurrency N`), while all
  on-chain work (Bulletin upload, DotNS, and the playground publish) is serialized per signer
  account via a shared signing gate so concurrent same-account deploys never collide on a nonce.
  Output is non-interactive and line-oriented with an optional `--json` per-app status summary.
  The single-app `playground deploy` command is unchanged.

## 0.32.2

### Patch Changes

- 1aa0a94: Install git before cargo-pvm-contract in `playground init` so clean Linux installs no longer fail at the `git clone` step (the git dependency used to be installed two steps after the first step that needs it)

## 0.32.1

### Patch Changes

- 888eda5: `playground deploy`: the interactive prompts now show a plain-language info box above each conceptual choice explaining what the decision means and what each option does, and the labels/hints are reworded for non-technical users. For example "changed contracts?" is now "did you change your smart contracts?" with options "I only changed the website" / "I changed contract code too", and "make this app moddable?" explains what modding is and what gets shared. The prompt order and behavior are unchanged.
- a79d84b: `playground mod`: when an app's published source repository is no longer publicly available (the publisher made it private, deleted, or renamed it), show a friendly "Source unavailable" notice instead of a raw GitHub 404. In the interactive picker the notice appears at the bottom and the picker stays open so you can choose another app; the direct `playground mod <domain>` path shows the same notice in place of the red "setup failed" error.

## 0.32.0

### Minor Changes

- 7d8fd24: `playground deploy` can now tag a published app so people can filter for it in the playground. When publishing to the playground, the interactive flow asks you to pick one of the predefined tags (social, chat, defi, utility, gaming, marketplace, irl) or skip. Headless deploys accept `--tag <tag>` (requires `--playground`). The tag is written to the app's metadata as `tag`, which the playground-app filter reads.

## 0.31.3

### Patch Changes

- 11d6a07: `playground init` no longer requests a Statement Store allowance. The CLI never
  consumes the resulting slot key (all phone interactions ride the SSO channel keyed
  on the QR-login secret, and storage uploads use the Bulletin slot key), but
  requesting it was the one grant that needs the phone to seat a slot in the
  scarce on-chain Statement Store ring. Users whose ring was full hit
  `denied: Statement Store` and saw account setup fail over a grant nothing
  consumes. Account setup now requests only the Bulletin and smart-contract gas
  allowances it actually needs.

## 0.31.2

### Patch Changes

- 73bd76b: Refresh the bundled `@w3s/playground-registry` contract manifest from the CDM meta-registry, syncing the committed `cdm.json` snapshot to the current on-chain deployment (generation 6, `0x82db2A7013ee5bDC69e12CC998dDb3A3eca1Ce4F`). The ABI is byte-identical to the previous generation and the CLI already resolves the registry address live from the meta-registry at runtime, so this is a snapshot-honesty update with no behavioral change.

## 0.31.1

### Patch Changes

- b4e0f57: Refresh contract deploy/install orchestration and add an optional `playground deploy` contracts pre-step (`--contracts` / `--no-contracts`, or an interactive prompt). Headless deploys now require an explicit `--contracts` or `--no-contracts` answer. Contract deploys now preflight CDM registry package ownership so users get a direct rename/use-owner-account error before a deploy batch reverts.

## 0.31.0

### Minor Changes

- 0f50f27: Add an interactive quest browser to `playground mod`. When a track app's source repo ships a `quests.json` at its root, the CLI lists the tutorial quests (id, title, difficulty, dependencies, summary) and waits for you to press "Start tutorial" before continuing into the existing clone flow. The manifest is read from the app's default branch; apps without a `quests.json` (or with an empty quest list) skip the picker silently. The picker is interactive-only — non-TTY runs of `playground mod <domain>` stay fully non-interactive.

## 0.30.4

### Patch Changes

- ed851d5: Validate DotNS domain names against the canonical on-chain rules (length 3-63, lowercase only, no leading/trailing dash, digit suffix of exactly 0 or 2, no dash before the digit suffix), correct the Proof-of-Personhood tier classification (names with a 9+ character base are open to everyone), and replace the misleading "set up automatically" message with truthful guidance about personhood requirements. Also upgrade bulletin-deploy to 0.9.0.

## 0.30.3

### Patch Changes

- ad7f1f9: Fix `playground init` appearing to succeed while the mobile session vanished, so every subsequent `playground deploy` failed with "No signer available".

  Root cause: the mobile SSO statement-store topic is derived from the phone's (reused) session account and the host's persisted device identity, so re-pairing the same phone reused the same topic. The phone posts a `Disconnected` statement on that topic when it supersedes a session, and statements live 7 days; on the next pairing the SDK replayed that stale `Disconnected` from the topic history and immediately tore the freshly paired session back out of the local repository (leaving the secret blobs behind). `playground init` now rotates the host device identity before a fresh QR pairing, so each pairing lands on a clean topic immune to stale disconnects — which also recovers an already-poisoned install without waiting out the 7-day TTL or a manual `playground logout`.

  `playground deploy` also degrades gracefully when no session exists: the interactive signer picker shows a yellow "Mobile signing unavailable" notice and offers the dev signer instead of crashing, and an explicit headless `--signer phone` without a session fails with a clear instruction to run `playground init`.

## 0.30.2

### Patch Changes

- 854f5fb: Fix `playground init` losing the resource-allowance approval after a fresh QR pairing. The CLI fired the allowance request the instant pairing completed, but the phone is still showing its (non-cancellable) "Connecting device" modal at that point, so the approval dialog was obscured and then dismissed when the pairing modal closed — leaving the CLI stuck on "approve on your phone". The CLI now waits a short grace period after a fresh pairing before sending the request, so it lands once the phone has dismissed its modal. Re-runs with an existing session are unaffected.

## 0.30.1

### Patch Changes

- 60022f1: Migrate contract tooling from the deprecated `@dotdm/*` packages to their `@parity/cdm-*` republished equivalents, adopting the flattened `CdmJson` shape (dependencies and contracts are now flat library-keyed maps with a single top-level registry). A project carrying a pre-migration multi-target `cdm.json` now gets a clear error asking it to regenerate, instead of failing opaquely. `playground init` now installs `cargo-pvm-contract` from a pinned upstream `main` commit instead of a feature branch.

## 0.30.0

### Minor Changes

- 3aad1a9: Upgrade the mobile pairing stack to host-papp 0.8.6 (via @parity/product-sdk-terminal 0.3.2). QR pairing now requires Polkadot mobile app build 1231 or newer: the handshake success message carries `rootEntropySource` (RFC-0007), which older builds do not send, so pairing against a phone on build 1230 or older fails at the QR step. Existing paired sessions are not migrated. Run `playground logout` and then `playground init` to pair again after upgrading.

## 0.29.0

### Minor Changes

- 7f63214: Fix "Invalid QR code" on `playground init` against current Polkadot mobile builds: the mobile app's Handshake V2 update only accepts V2 pairing offers, so the CLI now pairs over SSO v2 (host-papp 0.8). The `@novasamatech/*` 0.7.9 mobile-compat pins and the V1 metadata-URL patch are removed; host metadata (name, icon, CLI version) now travels inline in the pairing QR. host-papp 0.8.5 ships with a broken post-handshake session transport (the spec'd ECDH session key is never computed, so allowance and signing requests never reach the phone) - a local patch derives the correct key and also silences host-papp's unconditional `[sso-v2]` console logging (set `DOT_DEBUG=1` to re-enable). Post-success teardown noise from the 0.8 stack is silenced as well: a statement-store patch skips logging the expected `DestroyedError` on subscription teardown, and the benign-rejection filter now recognises the bare `Error("Not connected")` teardown shape - previously a successful `playground init` could print a scary stack and exit with code 1. A `@novasamatech/sdk-statement` patch fixes a crash (`ReferenceError: Cannot access 'unsubscribe' before initialization`) when exiting with Ctrl+C during an active pairing. Existing sessions written by older CLI versions are not readable by the new wire format - run `playground logout` and then `playground init` to pair again. The local slot-signer derivation workaround was removed in favour of the upstream fix in `@parity/product-sdk-terminal` 0.3.1.

## 0.28.9

### Patch Changes

- 9103f2b: Dev-signer deploys no longer ask for phone approvals. bulletin-deploy 0.8.x resolves the persisted `playground init` login session whenever it is called without explicit auth options, which silently routed dev-mode DotNS signing through the phone and signed storage chunks with the user's phone-granted Bulletin quota. `--signer dev` now pins bulletin-deploy to its dev mnemonic and dev storage key explicitly, restoring zero-tap dev deploys. `--suri` deploys likewise pin chunk-upload signing to the suri key instead of silently using the cached slot key. Apps still appear in the owner's MyApps view when a session exists, and dev deploys still earn no XP.

## 0.28.8

### Patch Changes

- a037e29: Title-case all bordered callout titles ("Moddable Setup Needed", "Check Your Phone", etc.) and show a "Keep Your Phone Ready" heads-up when a phone-signed deploy starts, so users have their mobile app ready before the first approval prompt.

## 0.28.7

### Patch Changes

- 20d6d15: Surface Bulletin allowance approvals in the deploy TUI and drop the guessed step total from phone-approval prompts.

  - `playground deploy` and `playground decentralise` now show a "check your phone" callout when an RFC-0010 Bulletin allowance request (first-use grant or quota top-up) is waiting on the phone. Previously these requests rode the statement store outside the signing proxy, so the phone showed an approval dialog while the terminal sat silent.
  - Phone approval prompts now read "approve step 1", "approve step 2", … instead of "step N of M". The predicted total regularly drifted from what actually ran (e.g. a planned PoP upgrade the runtime skipped left users on "step 4 of 5" with no fifth step), and allowance taps are demand-driven so they can never be counted up front. The pre-deploy summary now labels its count as "expected" and notes that an extra Bulletin allowance approval may appear.

## 0.28.6

### Patch Changes

- ad52ae6: Fix the deploy/TUI header breadcrumb garbling when a long domain overflows the row: the command no longer gets clipped ("playground deplo"), the domain keeps its ".dot" suffix, and the version label keeps a gap instead of gluing onto the network name. The header now degrades gracefully (narrower separators, then middle-truncation that preserves the ".dot" suffix) instead of letting the layout engine shrink every piece.

## 0.28.5

### Patch Changes

- 7305c73: Fix phone-mode `playground deploy` and `playground decentralise` failing with "Mobile transaction signing rejected: message too big" during the Bulletin upload. Bulletin storage chunks (up to 2 MiB each) are now signed with the local Bulletin allowance slot key instead of being routed to the phone, whose signing channel caps messages far below chunk size. The phone is still used for DotNS and registry publish approvals. Also bumps bulletin-deploy to 0.8.3, the first release with `storageSigner` support. If the slot key is missing, deploy now fails fast with a hint to re-run `playground init` instead of retrying chunks against an impossible signer.

  Also handles expired phone sessions cleanly. The statement-store allowance that carries every phone interaction lapses ~2 days after login and cannot be renewed remotely; previously an expired session made phone signing hang for minutes and fail with a cryptic "transaction watcher silent" error. Phone signing now fails within a second with a clear "run `playground logout` then `playground init`" message, and `playground deploy` warns up front when the last login is more than 2 days old.

  Fixes the Bulletin slot account derivation: the SDK derives the wrong public key from phone-issued 64-byte slot keys (missing schnorrkel scalar normalization), so storage and metadata uploads signed as an address the chain never authorized. This silently dropped phone-mode deploys onto the shared pool account, where transactions race other users' nonces and die with `AncientBirthBlock`. Uploads now sign as the address the phone actually granted the allowance to.

  Phone-mode deploys also check the slot's remaining quota against the estimated upload size before starting. An undersized allowance triggers a single Increase approval on the phone up front; if the quota still looks short after that, the deploy warns and proceeds rather than blocking, since the authorization itself is what the chain checks.

  Fixes session selection after repeated pairings: the CLI used to operate on the OLDEST persisted session, so after a re-pair, requests (including the `playground init` allowance approval) could be sent into a session the phone no longer serves, disappearing without an error. All flows now use the most recent pairing, and a successful login disconnects leftover stale sessions.

## 0.28.4

### Patch Changes

- af06348: Read-only registry queries (`playground mod` browse/metadata, registry username lookups) now dry-run with pallet-revive's keyless pallet account as origin instead of Alice's dev account, matching `@parity/product-sdk-contracts`' query fallback origin.

## 0.28.3

### Patch Changes

- f4d9846: Fix runaway memory growth in lingering `playground init` processes. The 4 GB memory watchdog now runs for every command by default (previously only `deploy`, `mod`, and `contract`), so a process whose event loop gets starved by a leaked subscription is killed with an actionable message instead of growing to tens of GB and freezing the machine. Also plugs the session-probe adapter leak in `playground init`: the login adapter's WebSocket is now released on the already-logged-in path, on probe failure, and after the QR login completes.

## 0.28.2

### Patch Changes

- 1ce9610: Sync the `@w3s/playground-registry` CDM snapshot to v3 (`0x9938255f40485B25641C9bc263aa8E0bAE8c202d`), picking up the registry's new on-chain sorted-index read methods (`getTopStarred` / `getTopModded`) added for the most-starred and most-modded Apps-tab sorts.

## 0.28.1

### Patch Changes

- f5c9395: `playground mod` now shows a community-code notice before downloading an app: a callout above the interactive picker list, and the same notice on the setup screen for the direct `playground mod <domain>` path. It tells users that apps are community-published open source, not reviewed, and that modding runs the app's setup script on their machine. Also, the moddable prompt in `playground deploy` now defaults its cursor to yes.

## 0.28.0

### Minor Changes

- c104fb2: Sign transactions through the Polkadot app's native transaction builder (product-sdk 0.9, RFC-0020 `createTransaction`). The wallet now decodes and displays what it signs, and chain-declared signed extensions (`AsPgas`, `AuthorizeValueTransfer`, …) are forwarded to the wallet verbatim — eliminating the "PJS does not support this signed-extension" failures on username claim, deploy, and account mapping.

  Existing logins keep working — no re-pair needed. Resource allowances (Bulletin, Statement Store, smart-contract gas) are re-requested once in a single phone dialog the next time they're needed (the allowance cache moved to the SDK's store).

## 0.27.1

### Patch Changes

- 371889d: Refine the post-install prompt: the "next step" box now surfaces a single canonical command (`playground init`) and notes the `pg` alias once on a dimmed tip line, instead of presenting `playground init` and `pg init` as co-equal commands with a "both work the same" line.

## 0.27.0

### Minor Changes

- b9929d8: Rename the CLI command from `dot` to `playground`, with `pg` as a short alias. Both `playground` and `pg` invoke the same binary, so `playground init` and `pg init` (and every other subcommand) are interchangeable. The curl installer now symlinks both names onto your PATH and prints a yellow "next step" box showing that either command works. Release artifacts are still published as `dot-<os>-<arch>`; only the installed command names changed. The old `dot` command is no longer installed.

## 0.26.2

### Patch Changes

- 372a332: Bump `bulletin-deploy` from `0.7.24` to `0.7.29`. The API surface the CLI
  consumes (`deploy()`, `DeployContent`/`DeployOptions`/`DeployResult`,
  `DEFAULT_MNEMONIC`, and the `DotNS` methods `connect`/`checkOwnership`/
  `getUserPopStatus`/`isTestnet`/`disconnect`) is unchanged across the bump;
  all upstream changes are additive (new manifest-publish exports, new optional
  fields). No CLI code changes were required.

## 0.26.1

### Patch Changes

- 0d13595: Point `dot deploy --playground` and `dot mod` at the current CDM meta-registry.
  The playground-app and playground-constellation migrated to a freshly deployed
  meta-registry (`0xf62c…`) where the playground-registry contract was redeployed
  with additive lineage methods (`getLineage`/`getLineageCount`). The CLI was still
  resolving live contract addresses from the old meta-registry (`0xa7ae…`), so it
  published to a stale registry the app no longer reads from. The bundled `cdm.json`
  now targets the new meta-registry and the latest `@w3s/playground-registry` ABI,
  and `@dotdm/env` is bumped to `2.0.2` so `dot contract` defaults match. The
  `publish()` signature is unchanged, so mod lineage continues to flow through the
  `modded_from` argument.
- 6d2d6dd: Fix `dot deploy --playground` not recording mod lineage on-chain. The
  `modded_from` argument to the registry `publish()` call was read from a
  never-set option instead of the `moddedFrom` value `dot mod` captures in
  `dot.json`, so the contract always received `""` and never awarded the source
  owner the "your app is modded" XP. The deploy now passes the captured source
  domain through to the registry.

## 0.26.0

### Minor Changes

- b8ed87f: `dot decentralize` is now interactive when invoked with no `--site` flag.
  Running `dot decentralize` on its own opens a TUI that walks through a
  short flow — a yellow "about this command" callout explaining that the
  command mirrors a live static site (https URL) and republishes it as a
  .dot site, then prompts for the site URL, a signer (dev / your phone),
  and a `.dot` name. Domain availability is checked inline against the
  chain (same path as `dot deploy`); leaving the name blank auto-generates
  a free hostname-derived label as before. The pipeline then runs the same
  mirror + Bulletin upload + DotNS register the headless path uses, and
  prints a final summary card with the live URL, IPFS CID, and gateway.

  `dot decentralize --site=…` (with or without `--dot` / `--suri`) keeps
  the existing headless contract — the demo service that passes
  `--suri=//Bob` is unchanged.

## 0.25.0

### Minor Changes

- 439ae1c: `dot init` now prompts you to claim a playground.dot username when one
  isn't already set on the registry. If you accept, the CLI signs a
  `setUsername` tx against the registry contract and surfaces the chosen
  name in the top breadcrumb alongside the command, network, and version.
  Runs that find an existing username read it from the registry (best-block
  freshness, same as the playground-app) and skip the prompt — your handle
  just shows in the header.

  Declining is non-destructive: pick "No" and `dot init` continues as
  before. The choice is not persisted, so re-running `dot init` will prompt
  again until a name is claimed.

## 0.24.0

### Minor Changes

- 77b5241: `dot mod` now records the source app's domain in `dot.json`, and `dot deploy --playground` publishes it as a `moddedFrom` field in the on-chain metadata. The playground-app can use this to display "Modded from: <domain>" attribution on app detail pages. The value is shape-validated through the same `normalizeDomain` rules as the deploying domain, so a hand-edited `dot.json` can't sneak XSS payloads into shared metadata.

### Patch Changes

- 82afc4d: `dot init` now shows the user's registry username (the handle set on the
  playground.dot profile) when one has been claimed, falling back to the
  People-parachain identity name and then to the H160, same precedence as
  the playground-app. Also surfaces an "account in use" row with the
  derivation path + H160 so the user can verify the exact account that
  signs on their behalf.

  `dot deploy --playground` now matches the v11 registry contract's 7-arg
  `publish()` signature (adds `modded_from`, `is_moddable`, `is_dev_signer`),
  which unblocks publishes against the freshly deployed playground registry
  on Paseo Asset Hub Next. `cdm.json` is refreshed to the v11 manifest; the
  runtime keeps resolving the live contract address from the on-chain
  meta-registry.

## 0.23.0

### Minor Changes

- 9459445: `dot deploy --signer dev --playground` now requires zero phone taps when an active phone session exists. The CLI signs every on-chain step with a synthesised Alice signer (matching bulletin-deploy's default identity) but passes the user's session H160 as the registry contract's new `owner` argument, so the published app still appears in the user's MyApps view in playground-app. Phone mode is unchanged; dev mode with `--suri` is unchanged. Requires the redeployed playground registry contract (new `publish(domain, metadata_uri, visibility, owner: Option<Address>)` signature) on Paseo Next v2.

## 0.22.9

### Patch Changes

- bd4bf44: Run `dot contract install` through dot's native TUI and the released CDM install backend instead of spawning the CDM CLI. `dot init` now installs `cargo-pvm-contract` directly instead of running the CDM CLI installer.

## 0.22.8

### Patch Changes

- eb02538: Move contract deployment out of `dot deploy` and add CDM-backed `dot contract deploy/install` commands. `dot contract deploy` now calls CDM's deploy pipeline with dot's signer and Bulletin allowance signer, uses CDM's current registry defaults from `@dotdm/env`, renders a CDM-style Ink progress table using dot's shared TUI primitives, and `dot contract install` delegates to CDM's installer.

## 0.22.7

### Patch Changes

- Request Bulletin allowance through the mobile resource-allocation flow, normalize returned slot-account keys before caching/signing, and point users back to mobile approval when the returned account is not usable on-chain.

## 0.22.6

### Patch Changes

- 481d08b: `dot deploy` and `dot build` now run `pnpm install` (or the project's package manager equivalent) before every build, not just when `node_modules/` is missing. A stale `node_modules/` left over from a branch switch or a lockfile bump used to slip past the missing-folder guard and produce opaque Vite/Rollup errors like `"X is not exported by ..."`; the only fix was to re-run `pnpm install` by hand. The install step is idempotent (~1s when nothing has changed), so the happy path is essentially unaffected.

  Also surfaces more of the failing build's output in the CLI error message (40 lines instead of 10), so when a build does fail the actual error line — not just the trailing stack trace — makes it into the rendered output. And the same error no longer renders twice in the deploy TUI: the per-section row marks which step failed with `✕`, and the bottom `deploy failed` row carries the message once.

## 0.22.5

### Patch Changes

- 3b73614: Keep Bulletin out of the mobile allowance request, show the Bulletin authorization faucet for the locally cached Bulletin account, and let `dot logout` recover from stale sessions missing the product-derivation root key.

## 0.22.4

### Patch Changes

- 9f1e4dc: Make `dot init` survive Bulletin allowance propagation lag, and fix a React setState warning that landed in the previous account-derivation PR.

  - **`dot init` no longer aborts** when the RFC-0010 Bulletin slot account is returned by mobile but the on-chain authorization hasn't propagated to Bulletin Chain yet. The slot key + marker are persisted regardless (so the next `dot deploy` picks them up), and the funding/mapping step continues to run. The row shows a soft-failure warning with the slot account SS58 and a faucet URL.
  - New `BULLETIN_AUTHORIZATION_URL` + `bulletinAuthorizationHelp(slotAddress)` so timeout / cached-key-not-authorized errors point at `https://paritytech.github.io/polkadot-bulletin-chain/authorizations` with the exact slot SS58 to authorize manually.
  - `requestAndStoreBulletinAllowanceSigner` persists the slot key before waiting for chain confirmation. A propagation timeout no longer discards a valid key the mobile already derived.
  - `storeSlotAccountKeysFromOutcomes` is now a single read-modify-write so two slot keys returned in one call (e.g. BulletInAllowance + StatementStoreAllowance) can't race-clobber each other in `allowance-keys.json`.
  - Fix a "Cannot update a component while rendering a different component" warning from `QrLogin`: it was calling the parent's `onDone(setState)` from inside `setStatus(updater)`. The handler now captures the resolved addresses in a `useRef` and calls `onDone` after the promise resolves, outside any updater function.

## 0.22.3

### Patch Changes

- b6cbcc2: Fix the `dot init` identity block:

  - Stop double-deriving the product account. The "product account" line previously ran `deriveProductAccountPublicKey` on the already-product-derived SS58, producing a ghost address whose SS58 + H160 didn't match what the playground-app actually uses. Both are now taken straight off the auth-derived pubkey via a shared `derivePlaygroundProductPublicKey` helper, so the signer that signs on-chain and the display the user sees can no longer drift.
  - Show the SSO wallet root on the "logged in" line instead of the product account. The product account is on its own row underneath with the full SS58 + H160. The root is also what the username lookup is keyed on.
  - Fix the username lookup key. Usernames live at `Resources.Consumers[<rootAccountId>]` on the People parachain; the lookup was previously running against the product account and would never find a match. It now uses the wallet root, matching polkadot-desktop's `useSessionIdentity`.

## 0.22.2

### Patch Changes

- 6f97144: Fix `dot init` identity block: print the full product-account SS58 and 0x-prefixed H160 instead of truncated `5DHk4g...CzE1 (0x8849...29dc)`, and fix the username lookup so it actually queries `Resources.Consumers` correctly. The previous code routed the SS58 through `AccountId().dec(...)` (which is meant for `0x`-hex input, not SS58) and silently corrupted the storage key, so every lookup surfaced as `(lookup failed)`. Now the SS58 is passed straight to `getValues`, matching the polkadot-desktop / dotli / triangle-js-sdks pattern.

## 0.22.1

### Patch Changes

- 7d7e7eb: Internal: bump `@parity/product-sdk-*` packages and `bulletin-deploy` to current latest, and consume `deriveProductAccountPublicKey` from `@parity/product-sdk-keys` instead of a local mirror. No user-visible behaviour change; output is byte-identical for production inputs.

## 0.22.0

### Minor Changes

- f618038: `dot init` now shows your username and your product account address alongside the existing "logged in" confirmation.

  - **Username** comes from your on-chain identity on People parachain (`Resources.Consumers` storage). If you haven't registered a username yet you'll see `(no username set on chain)`; if the lookup fails or times out (5s) it falls back to `(lookup failed)`.
  - **Product account** is the SS58 + truncated H160 derived locally from your root account via the same sr25519 soft-derivation path that the mobile wallet uses privately. The address you see here is the SAME one `playground-app` resolves for "My apps" and the SAME one your CLI signs as on-chain — so a quick eyeball is enough to confirm both clients agree on your identity.

## 0.21.5

### Patch Changes

- d8fbc44: Use cached RFC-0010 Bulletin allowance keys for Playground metadata uploads instead of signing Bulletin storage with the product account.

## 0.21.4

### Patch Changes

- 2ad4a8e: Fix `dot init` and `dot deploy --signer phone` to target the same product-derived account that actually signs on-chain.

  `session.remoteAccount.accountId` carries the user's wallet account, not the per-app product account the mobile signs with. The CLI was funding / allowance-marking / displaying the wallet address while the chain saw a different `From`. The CLI now soft-derives the product-account public key locally from `session.rootAccountId` using the same `"/product/{productId}/{derivationIndex}"` path the mobile wallet derives privately, so all three flows (`dot init`, `dot deploy --signer phone`, and the deployed playground-app's `HostProvider.getProductAccount`) resolve to the SAME SS58 for a given user. `PLAYGROUND_PRODUCT_ID` is also aligned to `"playground.dot"` to match the deployed playground-app.

  The deploy summary now shows the signing SS58 (e.g. `Signer  Your phone signer (5HRBs5…)`) so users can verify the account before approving. Bulletin-deploy's preflight log line that showed the dev-master fallback address (`SS58 Address: 5DfhG…`) during the availability check is silenced; only the real deploy's signing address surfaces.

## 0.21.3

### Patch Changes

- efca48c: Bump `bulletin-deploy` from `0.7.20-rc.4` to `0.7.20` stable. The notable change vs rc.4 is PR #369, which lands inside bulletin-deploy the same testnet pre-funding pattern `dot init` adopted in the previous release: `DotNS.connect({ autoAccountMapping: true })` now internally tops up a low-balance signer (`attemptTestnetTopUp` from the bare-master / `//Bob` of the standard dev mnemonic) before submitting the Revive auto-map trigger on paseo-next-v2. Users who skip `dot init` and run `dot deploy` directly will now get the funding just-in-time from bulletin-deploy; users who run `dot init` first get the same outcome front-loaded by the CLI. Both paths no-op when the recipient already holds ≥0.1 PAS, so they don't double-transfer.

## 0.21.2

### Patch Changes

- 4526267: `dot init` now funds the product-derived account from the shared bulletin-deploy dev signer (1 PAS, idempotent: skipped when the recipient already holds ≥0.1 PAS) instead of submitting an explicit `Revive.map_account`. paseo-next-v2's `pallet_revive::AutoMapper` handles the SS58 ↔ H160 mapping on the first state-changing tx; the funding step gives that tx enough PAS to land. A belt-and-braces `Revive.map_account` still fires if `checkMapping` returns false after funding, so cold-start accounts that pre-existed the AutoMapper runtime upgrade aren't left stuck.

  Also silences the recurring `DestroyedError: Client destroyed` block printed on every `dot init` exit. Root cause was `@sentry/node`'s default `OnUnhandledRejection` integration printing the rejection via `console.warn` + `console.error`; we now override it with `mode: 'none'` so Sentry still captures the rejection with the full `mechanism: onunhandledrejection` metadata but skips the print. Benign polkadot-api teardown artifacts are dropped via `beforeSend` so they don't reach the Failures dashboard either.

## 0.21.1

### Patch Changes

- baa84fa: Pass the selected deploy environment through to `bulletin-deploy`, pin the paseo-next-v2 capable `bulletin-deploy` prerelease, resolve live CDM contracts through the active `cdm.json` target registry, pass the Asset Hub descriptor to playground registry handles, use the paseo-next-v2 IPFS gateway path for playground metadata reads, use `--suri` signers for DotNS in dev-mode deploys, and treat bare mnemonic SURIs as the root account.

## 0.21.0

### Minor Changes

- b228817: Migrate to paseo-next-v2 (Asset Hub Next 1500, Bulletin Next 1501, People Next System 1502). `dot init` now requests RFC-0010 resource allowances (Bulletin + Statement Store + smart-contract gas) from the user's mobile wallet before mapping the account; PAS funding from a dedicated funder account is gone. Grants are cached at `~/.polkadot/allowances.json` (per env, per address, per resource) so repeat `dot init` runs don't re-prompt. `dot mod` no longer requires login or account-mapping to browse moddable apps.

  Behind the scenes: bumped `bulletin-deploy` to 0.7.19 (ships the paseo-next-v2 env with `autoAccountMapping`/`bulletinAuthorizeV2`/`skipDotnsCli` flags), `@parity/product-sdk-*` to the 0.5.0 facade release (PAPI-native signer fixes `AsPgas` signed-extension support), `@dotdm/contracts` to ^2.0.3, `@novasamatech/*` overrides to 0.7.9-4.

## 0.20.3

### Patch Changes

- 6bf3e42: install.sh now runs `dot init --yes` (non-interactive dep setup) instead of blocking on the mobile QR scan. A follow-up hint tells users to run `dot init` for the full login flow.

## 0.20.2

### Patch Changes

- 40d860b: License the CLI under Apache-2.0. Adds the canonical `LICENSE` text, declares `"license": "Apache-2.0"` in `package.json`, and applies the standard Parity SPDX + copyright header to every tracked source file. CI now runs `scripts/check-license-headers.sh` on every PR (`License Headers` workflow); contributors can run `pnpm lint:license` locally and `./scripts/check-license-headers.sh --fix` to add the header to new files.

## 0.20.1

### Patch Changes

- a66d4a1: Bump `bulletin-deploy` to `0.7.14`. Internal hardening of the chunked-storage path against WS-halt allocation storms: per-deploy retry-budget circuit breaker, recovery batch-size drop (2→1 in flight after first reconnect), and a synchronous WS-close hook that destroys the PAPI client before its broadcast-replay loop can OOM. No public-API changes.

## 0.20.0

### Minor Changes

- 0b5960c: Migrate the CLI runtime from `@polkadot-apps/*` packages to `@parity/product-sdk-*`, including terminal product-account signing for `playground.dot`. The QR-paired session signer routes transaction signing through `session.signPayload` (no `<Bytes>` envelope) so the chain accepts the produced signature, and arbitrary-byte signing through `session.signRaw` (envelope applied by mobile, correct for free-form data). Product-SDK packages use caret ranges so upstream patch and minor releases land automatically on a fresh `pnpm install`.

### Patch Changes

- dc9eead: Purge `@polkadot-apps/*` from the dependency tree. `@dotdm/contracts` is pinned to `1.1.1-dev.1778274929` (the dev release from the CDM monorepo's product-sdk migration PR; the `latest` stable still pulls the legacy stack), and `@novasamatech/*` is forced to `0.7.8-2` via `pnpm.overrides` so transitive consumers come along. `grep '@polkadot-apps/' pnpm-lock.yaml` now returns zero hits. The runtime is effectively PAPI 2.x-only — the lockfile still mentions `polkadot-api@1.23.3` but only as a vestigial declaration of the bundled `@parity/dotns-cli` CLI binary, which inlines its deps and never resolves them at runtime.
- ac4aaaa: Migrate the diagnostic tools (`tools/list-registry-apps.ts`, `tools/probe-registry-resolution.ts`) off direct `@polkadot-apps/*` imports onto `@parity/product-sdk-{contracts,tx,address}`. The list-registry-apps script now hits Paseo's public IPFS gateway directly (since `@parity/product-sdk-bulletin`'s `queryJson` is host-only and these tools run as plain Bun processes). Adds a CI grep guard so direct `@polkadot-apps/*` imports under `src/`, `e2e/`, `scripts/`, `tools/` fail the Format job.
- 2398dce: Upgrade `bulletin-deploy` from `0.7.12` to `0.7.13`. The new release adds a `--env <id>` selector to the upstream CLI binary plus additive deploy span attributes (`deploy.env`, `deploy.network`, `deploy.environments_source`); library consumers see zero behaviour change and the default endpoint resolves to the same paseo-next WSS as before.
- cfc487c: Upgrade `@parity/product-sdk-terminal` to `^0.2.0` and the rest of `@parity/product-sdk-*` to their latest patch releases. The new terminal release includes both fixes the CLI was working around: (1) `createSessionSignerForAccount` now uses a split-callback PJS signer (tx → `session.signPayload`, bytes → `session.signRaw`), so the local PJS-based replacement we'd inlined is gone; (2) `destroy()` is now async and drains pending statement-subscription unsubscribes before tearing down the lazy client, eliminating the `DestroyedError: Client destroyed` unhandled rejection on `dot logout`. The CLI's local helpers and the `DestroyedError` entry in `isBenignUnsubscriptionError` are removed accordingly.

## 0.19.5

### Patch Changes

- a5385ba: Upgrade bulletin-deploy from 0.7.10 to 0.7.12.

## 0.19.4

### Patch Changes

- 33bef5c: Improve error reporting when the CDM meta-registry fails to return a live contract address.

## 0.19.3

### Patch Changes

- e3c587f: Read current Bulletin authorization allowance fields correctly during deploy preflight.

## 0.19.2

### Patch Changes

- 1dfc53d: Rename the deploy source-publishing option and related CLI language to moddable.

## 0.19.1

### Patch Changes

- 8f1007c: Preserve explicit installer VERSION overrides such as dev branch release tags.

## 0.19.0

### Minor Changes

- 10b2abf: `dot deploy --moddable` no longer auto-creates a GitHub repository. The CLI now requires the user to set up a public GitHub `origin` themselves and fails with a clear message if `origin` is unset, points to a private repo, or points to a non-GitHub URL. The `--repo-name` flag is removed, the `gh` CLI dependency is dropped (no longer installed by `dot init`, no longer probed for authentication), and `dot mod` now initialises an empty git history without a baseline commit so users can stage and commit their first revision however they like.

## 0.18.2

### Patch Changes

- a4ef800: Fix two telemetry correctness issues in the deploy pipeline: E2E runs now tag bulletin-deploy spans with an `e2e-cli-*` label so test traffic is filterable in dashboards, and `deploy.source` no longer gets incorrectly overwritten with `"playground-cli"` (it correctly reports `"ci"` or `"local"` as intended).

## 0.18.1

### Patch Changes

- 7373966: Update `bulletin-deploy` to 0.7.10 for the latest DotNS/deploy fixes.

## 0.18.0

### Minor Changes

- 82036ef: Eliminates every remaining `api.github.com` call from the unauthenticated path so `dot mod`, `dot deploy --moddable`, and `dot update` no longer contribute to GitHub's 60 req/hour anonymous-IP rate limit. On shared networks (hackathon WiFi, conference NATs) the CLI now works regardless of how many other users are on the same public IP.

  - `dot deploy --moddable` writes the deploying branch to metadata as `meta.branch` (read via `git rev-parse --abbrev-ref HEAD`). `dot mod` reads that field and constructs the codeload tarball URL directly, skipping the previous `api.github.com/repos/{o}/{r}` lookup. Old apps without `meta.branch` fall back to `main`.
  - `assertPublicGitHubRepo` now issues a `HEAD https://github.com/{o}/{r}` against the regular HTML page rather than the API. Same public/private signal (200 vs 404) at zero API quota cost. Anti-abuse limits on the HTML surface are orders of magnitude more generous.
  - `dot update` resolves the latest CLI version through jsDelivr's `/resolved` endpoint instead of `api.github.com/.../releases/latest`. The binary download stays on `github.com/.../releases/download/...` (also non-API).

  The `gh auth token` opportunistic-header utility and the end-of-`dot init` rate-limit advisory banner are removed — both were workarounds for API quota issues that no longer exist on the unauthenticated path. `gh auth login` is still required for the one remaining authenticated call site (`gh repo create --public --push` when a fresh moddable repo is created), and `dot init`'s dependency-list row continues to advise it.

  `install.sh` is updated to resolve the latest tag through jsDelivr first (with the github.com `releases/latest` redirect probe as fallback) so concurrent first-time installs at a hackathon — every attendee on the same NAT — never touch `api.github.com` at all. The previous `api.github.com/repos/.../releases?per_page=1` fallback is removed entirely.

## 0.17.0

### Minor Changes

- eb9760c: Every `dot` invocation now shows a one-line "Update available" banner at the bottom when a newer release exists. The check resolves the latest version through jsDelivr's free public CDN (not GitHub's rate-limited API) with a 1 s timeout, so a flaky network never delays the command. Suppressed in CI / piped output, when running `dot update` itself, and when `DOT_NO_UPDATE_CHECK=1`.

  `dot mod` and `dot deploy --moddable` now opportunistically pass an `Authorization: Bearer <token>` header read from `gh auth token` when available — logged-in users get GitHub's per-user 5000/hour quota instead of contributing to the shared 60/hour anonymous-IP quota that gets exhausted quickly on hackathon WiFi. Anonymous users continue to work as before.

  `dot deploy --moddable` now fails with an explicit "GitHub rate limit exceeded — run `gh auth login`" error when the public-repo preflight is denied by the rate limiter, instead of silently passing the check and risking a private repo being published as moddable. Ambiguous 403s and transient 5xx responses still skip the check (unchanged).

  `dot init` ends with an explicit advisory banner (visually consistent with the new "Update available" banner) explaining the IP-based GitHub rate limit and recommending `gh auth login`, but only when the user is not currently authed. The single-row dependency-list warning was too terse to convey why this matters on hackathon / shared-network setups.

### Patch Changes

- fe6fe64: `dot mod` no longer prints a misleading `[contracts] No origin configured — using dev fallback (Alice) for query dry-run` warning when the user is signed in via `dot init`. The CDM meta-registry lookup that resolves the live playground registry address now receives the signer's address as `defaultOrigin`. `dot mod` also lazy-probes the picked app's repository between picker dismount and the setup steps, surfacing a clear "private or does not exist" error before any files are written when a publisher has flipped repo visibility after deploying.

## 0.16.17

### Patch Changes

- 88d78d3: `dot deploy --moddable` now rejects private GitHub repositories at preflight with a clear error message instead of silently failing later. `dot mod` also surfaces a more actionable error when it encounters a private or non-existent repository instead of the misleading "pin one in metadata.branch" hint.

## 0.16.16

### Patch Changes

- d742e7d: Fix `dot init` failing on a clean macOS/Linux machine where `rustup` isn't yet installed. The rustup installer writes its binaries to `~/.cargo/bin` and adds that directory to PATH only via shell rc files, which doesn't reach the running `dot` process. The next two steps (`Rust nightly`, `rust-src`) then fail with `bash: rustup: command not found`. After installing rustup we now prepend `$CARGO_HOME/bin` (default `~/.cargo/bin`) to `process.env.PATH` so the rest of `dot init` can resolve `rustup` immediately.

## 0.16.15

### Patch Changes

- 1988832: Remove unreachable null-signer guard in `resolveSignerSetup` (`signerMode.ts`). The dead `throw` could never fire because `shouldResolveUserSigner()` guarantees a signer is resolved before `resolveSignerSetup` is called when `--playground` is set. No user-visible behaviour change.

## 0.16.14

### Patch Changes

- b071fff: Adds `docs/e2e-running-tests.md` covering how to trigger the E2E suite locally and on GitHub. Tables of triggers, modes, flag passthrough, and result-reading. Complements `docs/e2e-bootstrap.md` (maintainer one-time setup).

## 0.16.13

### Patch Changes

- 8af7042: Fixed misleading "📱 Approve on your phone" log line during `dot deploy --signer dev --suri X --playground`. The session-key funding step now signs directly with the dev keypair instead of wrapping it in the phone-mode signing-event proxy. Phone-session deploys are unchanged.

## 0.16.12

### Patch Changes

- b9044f0: Fixed an intermittent `Revive::AccountUnmapped` failure during contract deploys. The per-deploy session key is now persisted to `~/.config/dot/accounts.json` only AFTER its `map_account` extrinsic is confirmed on chain. Previously the persist happened first, so a failing `map_account` (e.g. nonce race, transient chain error) left the on-disk state lying — the retry would find the existing key, skip the mapping step, and fail at the dry-run with AccountUnmapped. Fixes #94.

## 0.16.11

### Patch Changes

- 635ca56: CI now validates the consumer install path after every stable release: `e2e-post-release.yml` fires on `release: published`, runs `install.sh`, and runs the same smoke tests as `e2e-release.yml` (Phase 7) but against the installed binary at `~/.polkadot/bin/dot`. Catches `install.sh` regressions that the prerelease/SEA-download path doesn't.
- e56f7a9: Adds `docs/e2e-bootstrap.md` (public maintainer-facing doc covering pre-conditions, idempotent bootstrap commands, and recovery procedures for the E2E suite) and `.github/workflows/e2e-cleanup.yml` (Sunday 04:00 UTC cron stub for sweeping rotating E2E state — actual sweep logic lands with Phase 5e).

## 0.16.10

### Patch Changes

- df38cfa: Adds `DOT_BULLETIN_RPC` env-var override to `getChainConfig()`, allowing tests (or operators in an emergency) to prepend a custom Bulletin RPC endpoint while keeping the built-in URL as a fallback. The new `nightly-chaos-rpc` cell exercises this by setting an unroutable primary URL and asserting the deploy still completes via failover.

## 0.16.9

### Patch Changes

- c5bcff6: CI now validates published RC binaries: a new `e2e-release.yml` workflow fires on `release: prereleased`, downloads the `dot-linux-x64` SEA asset, and runs `e2e/cli/published.test.ts` smoke tests (`--version`, `--help`). Catches packaging regressions before stable release.

## 0.16.8

### Patch Changes

- b591ef3: E2E test setup and bootstrap-tool log strings now correctly use PAS (Paseo's native token symbol) instead of DOT. The numeric values are unchanged (1 PAS = 10^10 plancks); only the displayed unit symbol changes. Closes #96.

## 0.16.7

### Patch Changes

- 492ace6: Failed E2E cells now surface forensic detail (CLI subprocess stdout/stderr from `dot-runs.log`, junit.xml failure messages, and `::error::` annotations at the top of the run page) directly in the GH Actions UI. Previously a triager had to download the artefact and untar it locally to see the real root cause. Closes #98.
- 68f6417: `dot update` now creates its install directory if missing instead of failing with ENOENT. Previously the directory was assumed to exist (created by `install.sh` during `dot init`), causing `dot update` to fail on environments that didn't run the installer (e.g. CI runners spawning the CLI directly). Fixes #97.

## 0.16.6

### Patch Changes

- 22c0e59: Nightly E2E now exercises the SIGINT cleanup path: a new `nightly-chaos-sigint` cell sends SIGINT to `dot deploy` mid-flight and asserts the process-guard's runAllCleanupAndExit handler exits cleanly within 5s with code 130 (or SIGINT signal).

## 0.16.5

### Patch Changes

- 5c4b491: Nightly E2E now exercises the `--no-contract-build` error path: a new `nightly-rejections` cell asserts the integration-level error message when a Foundry project requests skip-build but ships no pre-built artefacts under `out/`.

## 0.16.4

### Patch Changes

- 3751335: Nightly E2E now exercises the multi-contract publish path: `nightly-deploy-multi` cell publishes both `TokenA.sol` and `TokenB.sol` from the multi-contract fixture to the `e2e-cli-multi.dot` domain, exercising the batch contract-instantiate path. Refactored the 3 near-identical contract-deploy tests (foundry, hardhat, multi) into a shared `runContractDeployTest` helper.

## 0.16.3

### Patch Changes

- e5b1b19: Nightly E2E now exercises the Hardhat (EVM) full-deploy path: a new `nightly-deploy-hardhat` cell publishes the hardhat fixture's pre-built `Lock.sol` bytecode to the `e2e-cli-hardhat.dot` domain on Paseo. Runs on schedule/dispatch only (max-parallel: 1 with `pr-deploy-frontend`/`pr-deploy-foundry` since they share SIGNER), so per-PR runtime is unaffected.

## 0.16.2

### Patch Changes

- ac3addc: E2E suite now has a `test-nightly-no-publish` matrix that runs only on the daily schedule (06:00 UTC) and `workflow_dispatch`. Adds two nightly-only cells: `nightly-mod-miss` (registry-miss path for unknown domains) and `nightly-diagnostic` (DOT_DEPLOY_VERBOSE / DOT_MEMORY_TRACE coverage). Per-PR runs are unaffected.

## 0.16.1

### Patch Changes

- 28d7c30: E2E suite now runs as a 7-cell matrix on CI: 4 no-publish cells in parallel + 3 publish cells serial (sharing the registry signer to avoid nonce races). Adds full-deploy tests for the Foundry and CDM backends. Per-cell pass/fail is visible in the sticky PR comment with cell-specific JUnit + forensic logs.

## 0.16.0

### Minor Changes

- 8d02aa4: Add `--no-contract-build` flag to `dot deploy`. When set alongside `--contracts`, the deploy uses pre-existing contract artifacts (foundry `out/`, hardhat `artifacts/contracts/`, cdm `target/<crate>.release.polkavm`) instead of running the build toolchain. Useful for CI environments where `forge` / `cargo-contract` aren't installed.

## 0.15.5

### Patch Changes

- 7696da3: CI now posts a sticky E2E test-pass comment on every PR with per-test pass/fail counts and Sentry triage links. Nightly schedule failures auto-open a GitHub issue. Per-cell forensic logs (`dot-runs.log`) and JUnit XML are uploaded as workflow artefacts. Test traffic is tagged with `cli.tag:e2e-ci-{pr|nightly|dispatch}` so production Sentry dashboards can filter it out.

## 0.15.4

### Patch Changes

- 7151157: Avoid GitHub auth and `git push` during `dot deploy --moddable` when the project already has an `origin`; the existing repository URL is recorded directly.

## 0.15.3

### Patch Changes

- 9d0a0ba: Load the logged-in account for `dot deploy --signer dev --playground` so Playground registry publishes can be signed by the app owner.

## 0.15.2

### Patch Changes

- f2f43c4: Suppress the non-fatal `ReviveApi_trace_call` compatibility stack during Playground registry contract dry-runs.

## 0.15.1

### Patch Changes

- 2de1408: Resolve the Playground registry address from the live CDM meta-registry before publishing or browsing apps.

## 0.15.0

### Minor Changes

- 86abd07: `dot --suri` now accepts a BIP-39 mnemonic in addition to the dev names (Alice, Bob, Charlie, Dave, Eve, Ferdie). An optional `//<path>` derivation suffix is supported, e.g. `dot deploy --suri "<12-word phrase>//0"`. The dev-name fast path is unchanged.

### Patch Changes

- 934c0db: Add E2E integration test suite covering install, build, init, session, deploy, mod, and diagnostic commands. Tests spawn the CLI as a child process via execa and assert on stdout/stderr/exit codes. Deploy tests verify contract detection for Foundry, Hardhat, and CDM backends. Includes CI workflow, fixture projects, and chain query helpers for Paseo testnet validation.
- 21481ba: Fix `dot deploy` exiting 1 after a successful deploy. polkadot-api's `client.destroy()` can fire a `DisjointError: ChainHead disjointed` from a still-in-flight chainHead operation after the WS has closed, which surfaces as an unhandled rejection and forced the process to exit 1 even though the deploy completed and printed "Deploy complete". Now suppressed alongside the existing benign-teardown filter for `UnsubscriptionError: Not connected`.
- ba63fec: Fix `dot deploy` and `dot mod` exiting 0 on failures. Previously the CLI's entry point unconditionally called `process.exit(0)` after the action returned, overwriting the non-zero `process.exitCode` set by `scheduleHardExit()` (deploy preflight, e.g. `SignerNotAvailableError` from a corrupt session) and never set by `dot mod` at all on `runSetup` failures (e.g. registry miss). Both paths now propagate a non-zero exit code so shell scripts and CI pipelines can rely on the result.

## 0.14.1

### Patch Changes

- 90f51d4: Fix bundled DotNS CLI dispatch so compiled deploys can run DotNS subprocess commands.

## 0.14.0

### Minor Changes

- 1349115: Add privacy-gated Sentry telemetry for `dot` commands and route `bulletin-deploy` spans through the CLI's ambient Sentry client.

## 0.13.2

### Patch Changes

- 6715aa2: Bumped `bulletin-deploy` 0.7.2 → 0.7.6. The new release ships heartbeat-consistency fixes on the WS clients used during preflight tx submission (eliminates the no-heartbeat `withAliceApi` path) plus a new bounded reconnect-status handler. Includes a temporary `pnpm.overrides` workaround for a transitive publish bug in `@parity/dotns-cli@0.5.6` that prevents pnpm from installing 0.7.4+ cleanly; see CLAUDE.md for context and removal criteria.
- 9d3be83: The memory-watchdog abort message now reliably reaches stderr when the output is redirected to a file. Previously, on a SIGKILL-on-memory-cap path, the `✖ Memory use exceeded …` message could be lost from a redirected stderr buffer because `process.stderr.write()` queues through the writable-stream layer. The watchdog now uses `fs.writeSync(2, …)`, a blocking syscall that completes before the kill, so users diagnosing memory issues see the full abort context.

## 0.13.1

### Patch Changes

- f2e09bd: Bump `@w3s/playground-registry` to v6 to match the first release of playground.dot.

## 0.13.0

### Minor Changes

- b9ec23b: `dot mod` now downloads source as a fresh project from GitHub via HTTPS — multiple mods of the same starter no longer collide via GitHub's one-fork-per-account limit. `git` and `gh` are no longer required to mod an app.

  `dot deploy --playground` now asks before publishing source. Pass `--moddable` (or answer "yes" to the prompt) to publish a public GitHub source repo alongside the deploy so others can `dot mod` it. Use `--no-moddable` to skip the prompt non-interactively. The default is non-moddable. Pass `--repo-name <name>` to skip the repo-name prompt when creating a fresh repo.

  The interactive registry picker (`dot mod` with no domain) now hides apps that aren't moddable.

  Removed: `dot mod --clone`, `--repo-name`, `--yes` flags (no longer needed).

## 0.12.0

### Minor Changes

- f6e5adf: `dot mod` now keeps the tail of `setup.sh` visible after the step completes — the script's "next steps" / quest progression / doc pointers no longer disappear when the step turns green. The full unfiltered output is also tee'd to `<targetDir>/.dot-mod-setup.log` for any output that doesn't fit the on-screen tail. The generic "edit with claude / dot deploy" footer now only prints when the app didn't ship a `setup.sh`.

## 0.11.1

### Patch Changes

- 0dfb9b5: `dot mod` no longer leaves an `upstream` remote behind after fork+clone, so `git checkout quest/level-N` (and the commands printed by tutorial `setup.sh` scripts) work without `--track origin/<name>` workarounds.

## 0.11.0

### Minor Changes

- 60463f7: Add `dot logout` to sign out of the account paired via `dot init` — no more `rm -rf ~/.polkadot-apps`. Notifies the mobile app so the paired-connection entry is removed there too, with a best-effort local-only cleanup fallback when the network is unreachable.

## 0.10.4

### Patch Changes

- 20bdd11: Refresh remaining `@polkadot-apps/*` direct dependencies to their current latest. PR #44 narrowly bumped `chain-client`; this widens to pick up the siblings that the monorepo had already co-released via its `workspace:*` + changesets patch cascade:

  - `@polkadot-apps/bulletin` 0.6.9 → 0.6.10
  - `@polkadot-apps/contracts` 0.3.2 → 0.4.0

  Also eliminates the duplicate `chain-client@2.0.4` that was being pulled transitively by the old bulletin — single resolved version now (`2.0.5`).

## 0.10.3

### Patch Changes

- 899ca18: Bump `@polkadot-apps/chain-client` to 2.0.5, which rotates the Paseo Asset Hub preset RPC list to live endpoints. Fixes `dot init` hanging on the funding step with repeated "Unable to connect to …" errors when both previously-configured endpoints (Dwellir, `sys.ibp.network`) were simultaneously unhealthy.

## 0.10.2

### Patch Changes

- b854eae: Upgrade `bulletin-deploy` pin to `0.7.2`. Fewer spurious upload failures now that the default chunk timeout covers Bulletin's 24s Aura slots, and a Bun-safe memory-report teardown upstream. No API changes on our side.

## 0.10.1

### Patch Changes

- f39d0aa: `dot init` now falls back to a dedicated testnet funder account if Alice is drained on Paseo Asset Hub — so new users aren't blocked the moment someone drains Alice. If both funders are low, the UI points users at `https://faucet.polkadot.io/` prefilled with their own address so they can self-fund and move on. `dot deploy --signer dev` gets the same fallback and, on exhaustion, guides the user to switch to the mobile signer instead. Adds a scheduled GitHub Actions workflow that files an issue when the dedicated funder needs topping up.

## 0.10.0

### Minor Changes

- c6cdc06: Add optional contract deploy step to `dot deploy`. When the project root contains a `foundry.toml`, a `hardhat.config.*`, or a `Cargo.toml` with a `pvm_contract` dep, the TUI now asks "deploy contracts?" (default no), and `dot deploy --contracts` runs it non-interactively. All three paths compile locally (foundry via `forge build --resolc`, hardhat via `npx hardhat compile`, cdm via `@dotdm/contracts`) and then hand the PolkaVM bytecode to cdm's `ContractDeployer.deployBatch`, which weight-aware-chunks the deploys into `Utility.batch_all` extrinsics. No constructor args, no contract registry publish, no on-chain metadata in this first cut — they'll land in a follow-up.

  Contract extrinsics are signed by a persistent on-disk **session key** at `~/.polkadot/accounts.json`, not the mobile signer — today's mobile flow can't handle the encoded size of a batched contract deploy, and the failure is miscategorised as a user-cancel. On first deploy the session key is funded by the user's main signer (one phone tap) or by Alice in pure dev mode; subsequent runs skip funding when the balance is already above the threshold.

  `dot init` gains a `foundry (polkadot)` dependency check that installs `foundryup-polkadot`.

## 0.9.1

### Patch Changes

- 73ad29b: Fix `dot deploy` crashing on Bun-compiled binaries with `node:v8 getHeapSpaceStatistics is not yet implemented in Bun.` when running from an internal Parity repo. Move the `bulletin-deploy` telemetry opt-out into a dedicated `src/bootstrap.ts` side-effect module imported before any other module, and additionally force `BULLETIN_DEPLOY_MEM_REPORT=0` so bulletin-deploy's diagnostic memory-report path can never reach Bun's unimplemented `v8.getHeapSpaceStatistics`. Explicit `BULLETIN_DEPLOY_TELEMETRY=1` / `BULLETIN_DEPLOY_MEM_REPORT=1` overrides are preserved.

## 0.9.0

### Minor Changes

- faae2ed: `dot deploy --playground` now inlines the project's `README.md` into the playground metadata so published apps show a rendered readme on their detail page. Readmes up to 20 KB are included automatically; if the file is larger the confirm screen shows a warning ("readme will not be uploaded") and the deploy proceeds without it. No action required — this works for any repo that already has a `README.md` at its root.

## 0.8.0

### Minor Changes

- e113540: `dot build` (and the build phase of `dot deploy`) now auto-installs the project's dependencies when `node_modules/` is missing. The package manager is inferred from the lockfile (`pnpm`/`yarn`/`bun`), falling back to `npm`. Previously, an uninstalled project fell through to `npx <framework> build`, which ephemerally downloaded the framework binary but then failed with a confusing `ERR_MODULE_NOT_FOUND` while loading the project's own config file (e.g. `vite.config.ts` importing `vite`).

## 0.7.2

### Patch Changes

- fdac80d: Bump `bulletin-deploy` pin from `0.6.16` to `0.7.0`. The only breaking change in 0.7.0 is the removal of the `--playground` CLI flag and the `playground?: boolean` `DeployOption`; playground-cli already owns registry publishing via its own `publishToPlayground()` flow, so this is a no-op for the deploy path.

## 0.7.1

### Patch Changes

- e77932d: Fix `dot deploy` reporting "already registered" on re-deploys made in dev mode when a phone session was also present.

  The domain-availability preflight was passing the logged-in user's SS58 address as the reference owner for the on-chain ownership check regardless of signer mode. In dev mode bulletin-deploy signs DotNS with its built-in `DEFAULT_MNEMONIC`, so the domain is owned by the dev account — not the user — and the preflight incorrectly reported the re-deploy as taken by a different account. We now only pass the user's address when `--signer phone` (where bulletin-deploy actually uses the user's signer). In dev mode we skip the ownership check and let bulletin-deploy's own preflight classify the re-deploy with the right signer.

## 0.7.0

### Minor Changes

- 4cdf839: `dot deploy` now asks whether to run the build step before deploying, defaulting to "yes" so the common case is still a single Enter press. Pass `--no-build` to skip the build non-interactively (useful when you've already built the project and just want to re-upload existing artifacts from `buildDir`). The confirm screen and headless summary both show whether the run will rebuild or reuse existing artifacts.

## 0.6.2

### Patch Changes

- c9c4bcd: Bump `bulletin-deploy` pin from 0.6.9 → 0.6.16.

  Picks up a fix for `merkleizeJS` (CIDs now preserve their codec so DAG-PB blocks are correctly indexed in the CAR body — the upstream bug our `jsMerkle` workaround was avoiding), on-chain verification after every DotNS `setContenthash`, clearer preflight messages on sanitized-to-Reserved labels, chain-time commit-age waits, and an idempotent pool `topUpBy`. No API changes required on our side.

## 0.6.1

### Patch Changes

- e27c1be: Suppress the cosmetic `UnsubscriptionError: Not connected` stack trace that appeared during `dot deploy`'s domain-availability check. It came from polkadot-api tearing down its chainHead follow subscription after `dotns.disconnect()` had already closed the WebSocket — expected, benign, and surfaced as either an `unhandledRejection` or `uncaughtException` depending on the runtime. The process now filters that specific rxjs error (UnsubscriptionError whose inner errors are all "Not connected") instead of logging a 40-line stack trace and tearing the deploy down. Unrelated rejections and exceptions still escalate as before; run with `DOT_DEPLOY_VERBOSE=1` to get a one-line note when a filter fires. Also adds a Troubleshooting section to the README pointing users at `DOT_MEMORY_TRACE=1` + `DOT_DEPLOY_VERBOSE=1` for memory / OOM bug reports.

## 0.6.0

### Minor Changes

- 440bd12: `dot mod` now prompts for the fork repository name after you pick (or pass) an app, with the previously random-suffixed default prefilled — press Enter to keep it, or type your own. The prompt is skipped with `--clone` (the target is only a local directory anyway), with `-y` / `--yes` (non-interactive default), or when you pass `--repo-name <name>` (which also doubles as the scripted override). Supplied names are validated against GitHub's repository-name rules and against existing directories on disk.

## 0.5.1

### Patch Changes

- 13a6c4e: Harden the deploy memory watchdog, add diagnostic logging for freezes / runaway RSS, and fix the phone-signer approval counter when a PoP upgrade is required.

  - **Watchdog now runs in a `worker_threads` Worker**, not a `setInterval` on the main thread. Under heavy microtask load (polkadot-api block subscriptions, bulletin-deploy retry loops) the main thread's macrotask queue can be starved for long enough that RSS climbs to 10+ GB between samples — at which point macOS jetsam delivers SIGKILL and the user sees a mystery `zsh: killed` with no guidance. The worker has its own event loop that can't be starved by the main thread, so the 4 GB cap now actually fires with a clear abort message. Sampling rate is also tightened from 5 s → 1 s now that it's off the hot path.
  - **New `DOT_DEPLOY_VERBOSE=1` env var** writes every bulletin-deploy log line (chunk progress, broadcast / included / finalized transitions, nonce traces, RPC reconnects) to stderr with a `[+<seconds>s]` timestamp. Previously the interceptor swallowed everything that wasn't a phase banner or `[N/M]` chunk line to keep the TUI clean; that made "deploy froze at chunk 2/6" reports diagnostically opaque. Pair with `DOT_MEMORY_TRACE=1` to correlate log events with RSS growth.
  - **Asset Hub client is now destroyed immediately after preflight** instead of lingering until deploy cleanup. Nothing in the deploy flow (build, bulletin-deploy's storage + DotNS, our playground publish) uses it between preflight and the publish step — and holding an idle polkadot-api client with a live best-block subscription for the full deploy window was measurable background pressure. Playground publish calls `getConnection()` which auto-re-establishes a fresh client at that point.
  - **Phone-signer approval count now matches reality.** For a PoP-gated name registered with a signer below the required tier, bulletin-deploy submits an extra `setUserPopStatus` tx before `register()` — so `dot deploy --signer phone --playground` actually fires 5 sigs, not 4. The summary card used to advertise "4 approvals" and the phone prompt later said "approve step 5 of 4". Fixed by predicting `needsPopUpgrade` during the availability check (via `getUserPopStatus` + mirrored `simulateUserStatus` logic) and threading that prediction into `resolveSignerSetup`, so the approvals list (and the derived summary, and the signing-proxy labels) are variable-length. Added: a belt-and-braces clamp in `createSigningCounter` that grows `total` when `step > total`, so even if our prediction mis-estimates for any reason the TUI never shows "step 5 of 4" again.
  - **Re-deploy path now shows a minimal phone tap count.** When the availability check reports the domain is already owned by the signer, bulletin-deploy skips `register()` entirely and only fires `setContenthash`. The summary card and counter now reflect that (1 DotNS tap instead of 3).

## 0.5.0

### Minor Changes

- a289cb9: New editorial TUI: every screen now renders through a single theme plug
  (`src/utils/ui/theme/`) — swap that folder to reskin the CLI, stub it to
  strip styling, zero styling leaks into commands.

  `dot init` now surfaces bulletin attestation status on every run — even
  for already-signed-in users — showing how long your upload quota is valid
  for in human-readable form (e.g. `~13d 4h · #14,582,331`), with warning
  color when expiry drops under 24 h.

  Bonus: the terminal tab title updates during long deploys, so
  `dot deploy` shows build / upload / publish / ✓ in your tab strip while
  you tab away to the browser.

## 0.4.1

### Patch Changes

- 8944350: Bump `bulletin-deploy` from `0.6.9-rc.6` to `0.6.9` (stable). Upstream changes:

  - **fix(dotns)** — Lite signers are now correctly rejected on `NoStatus` labels, matching the on-chain `PopRules` contract (upstream #101). Previously the check was missing the requirement clause and could let a Lite user through the classifier, only to have the register tx revert later.
  - **feat(dotns)** — bulletin-deploy now runs its own `DotNS.preflight(label)` before any Bulletin upload (upstream #102). Deploys that were going to fail DotNS registration (wrong label class, reserved base name, domain owned by someone else, unresolvable PoP gate) now abort with **zero Bulletin bytes paid**, saving users a failed multi-MB upload. A new public `DotNS.preflight()` view-only method and `simulateUserStatus()` / `popStatusName()` helpers are also exported.

  Our code surface (the `deploy()` entrypoint + `DotNS.connect` / `classifyName` / `checkOwnership` / `disconnect`) is unchanged, so the bump is drop-in. 147/147 tests pass.

## 0.4.0

### Minor Changes

- dede259: - New `dot build` command — auto-detects pnpm/yarn/bun/npm from the project's lockfile and runs the `build` script. Falls back to direct vite/next/tsc invocation when no build script is defined.
  - New interactive `dot deploy` flow. Prompts in order: signer (`dev` default / `phone`), build directory (default `dist/`), domain, and publish-to-playground (y/n). After inputs are chosen the TUI shows a dynamic summary card announcing exactly how many phone approvals will be requested and what each one is for.
  - Two signer modes for deploy:
    - `--signer dev` — `0` phone approvals if you don't publish to Playground, `1` if you do. Upload and DotNS are done with shared dev keys.
    - `--signer phone` — `3` approvals (DotNS commitment, finalize, setContenthash) + `1` for Playground publish if enabled.
  - Flags: `--signer`, `--domain`, `--buildDir`, `--playground`, `--suri`, `--env`. Passing all four of `--signer`, `--domain`, `--buildDir`, and `--playground` runs non-interactively.
  - Publishing to the Playground registry is always signed by the user, so the contract records their address as the app owner. This is what drives the playground-app "my apps" view.
  - Domain availability preflight — after you type a domain we hit DotNS's `classifyName` + `checkOwnership` (view calls, no phone taps) so names reserved for governance or already registered by a different account are caught BEFORE we build and upload. Headless mode fails fast with the reason; interactive mode shows the reason inline and lets you type a different name without restarting.
  - Re-deploying the same domain now works. The availability check used to fall back to bulletin-deploy's default dev mnemonic for the ownership comparison, so a domain owned by the user's own phone signer came back as `taken` — blocking every legitimate content update. The caller now passes their SS58 address, we derive the H160 via `@polkadot-apps/address::ss58ToH160`, and `checkOwnership(label, userH160)` returns `owned: true` when the user is the owner → we surface it as an `available` with the note "Already owned by you — will update the existing deployment.".
  - All chain URLs, contract addresses, and the `testnet`/`mainnet` switch consolidated into a single `src/config.ts`.
  - Deploy SDK is importable from `src/utils/deploy` without pulling in React/Ink so WebContainer consumers (RevX) can drive their own UI off the same event stream.
  - Workaround for Bun compiled-binary TTY stdin bug that prevented `useInput`-driven TUIs from receiving keystrokes or Ctrl+C. A no-op `readable` listener is attached at CLI entry as a warm-up.
  - Bumped `bulletin-deploy` from 0.6.7 to 0.6.9-rc.4. Fixes `WS halt (3)` during chunk upload (heartbeat bumped from 40s to 300s to exceed the 60s chunk timeout) and eliminates nonce-hopping on retries that used to duplicate chunk storage and trigger txpool readiness timeouts. Pin is deliberately on the RC tag — the `latest` npm tag still points at the broken 0.6.8.
  - Fixed runaway memory use (observed 20+ GB) during long deploys. The TUI was calling `setState` on every build-log and bulletin-deploy console line; verbose frameworks and retry storms produced enough React update backpressure to balloon the process. Info updates are now coalesced to ≤10/sec and capped at 160 chars.
  - Fixed `Contract execution would revert` failure in the Playground publish step. The metadata-JSON upload was routed through `bulletin-deploy.deploy()`, which unconditionally runs a second DotNS `register()` + `setContenthash()` on a randomly generated `test-domain-<id>` label — that's what was reverting. We now upload the metadata via `@polkadot-apps/bulletin::upload()` (pure `TransactionStorage.store`, no DotNS) and only invoke DotNS for the user's real domain. The user's phone signer is now correctly driven when `registry.publish()` fires, so the "Check your phone" panel appears as expected.
  - Fixed `WS halt (3)` recurrence after switching the metadata upload to `@polkadot-apps/bulletin`. That path went through the shared `@polkadot-apps/chain-client` Bulletin WS, which uses polkadot-api's 40 s default heartbeat — shorter than a single `TransactionStorage.store` submission. The upload now uses a dedicated Bulletin client built with `heartbeatTimeout: 300 s` and destroyed immediately after (same value `bulletin-deploy` uses for its own clients).
  - Added a multi-layer process-guard (`src/utils/process-guard.ts`) to eliminate zombie `dot` processes that had been observed accumulating to 25+ GB of RSS and triggering OS swap-death. (1) SIGINT/SIGTERM/SIGHUP and `unhandledRejection` all run cleanup hooks and force-exit within 3 s; (2) after the deploy's main flow returns, an `unref`'d hard-exit timer kills the process if a leaked WebSocket keeps the event loop alive past a grace period; (3) a 4 GB absolute RSS watchdog aborts the deploy before the machine swaps to death; (4) `BULLETIN_DEPLOY_TELEMETRY` is defaulted to `"0"` so Sentry can no longer buffer breadcrumbs; (5) the stdin warmup listener is `unref`'d so it doesn't hold the loop open on exit. Set `DOT_MEMORY_TRACE=1` to stream per-sample memory stats (RSS / heap / external) when diagnosing a real leak.
  - Bumped `bulletin-deploy` from 0.6.9-rc.4 to 0.6.9-rc.6 (picks up DotNS commit-reveal + commitment-age fixes).
  - Cut the log-event firehose: `DeployLogParser` now only emits events for phase banners and `[N/M]` chunk progress — NOT for every info prose line bulletin-deploy prints. Previously every line allocated an event object + traversed the orchestrator→TUI pipeline, compounding heap pressure during long chunk uploads.
  - Fixed deployed sites returning `{"message":"404: Not found"}` in Polkadot Desktop. Bulletin-deploy's pure-JS merkleizer (`jsMerkle: true` path) produces CARs containing only the raw leaf blocks — the DAG-PB directory/file structural nodes are silently dropped by `blockstore-core/memory`'s `getAll()` iterator. Desktop fetches the CAR, sees the declared root CID, finds no block for it in the CAR, parses zero files, renders 404. We now leave `jsMerkle` off so bulletin-deploy uses the Kubo binary path (`ipfs add -r ...`) which produces a complete, parseable CAR. `dot init` installs `ipfs`, so this works out of the box. Note: this temporarily regresses the RevX WebContainer story for the main storage upload — we'll flip `jsMerkle: true` back on once the upstream merkleizer is fixed to collect all blocks, not just leaves.

## 0.3.0

### Minor Changes

- ba4f091: - `dot init` now runs account setup after QR login + toolchain install: funds the account from Alice (testnet), signs `Revive.map_account` via the mobile wallet, and grants bulletin allowance.
  - New `dot update` command — self-updates from GitHub releases with atomic write-then-rename, safe to run over the live binary.
  - Session signer now routes transactions through `signPayload` to avoid the mobile's `<Bytes>` wrap that produced `BadProof` on-chain.
  - Connection singleton with a 30 s timeout and preserved `Error.cause` for debugging.
  - `install.sh` propagates the exit code of the auto-run `dot init`.
  - Introduced a vitest suite (73 tests across 9 files).

## 0.2.0

### Minor Changes

- 23abf79: Scaffold init, mod, build, and deploy commands

## 0.1.1

### Patch Changes

- 8a0e3cc: Initial CLI setup
