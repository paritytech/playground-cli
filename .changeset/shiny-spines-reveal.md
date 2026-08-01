---
"playground-cli": minor
---

Migrate to the new playground-registry and identity-spine contracts (pvm-contract-sdk port). Dev deploys now publish through the registry's separate `publishDev` method (authorized by the known dev-signer account, exempt from the reveal gate); user publishes go through the reveal-gated `publish` and require the account to be revealed as a builder via the playground app. The builder-identity gate now reads the new `@w3s/playground-identity` spine contract, `--suri` deploys with a non-dev key publish as regular (reveal-gated) users, and a `NotRevealed` revert surfaces an actionable "Become a builder" hint instead of an opaque failure.
