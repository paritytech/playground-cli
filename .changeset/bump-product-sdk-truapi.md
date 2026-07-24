---
"playground-cli": minor
---

Bump the full `@parity` dependency stack to latest published and migrate to the
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
