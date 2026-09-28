---
"playground-cli": minor
---

Derive the product account from an environment-scoped product id
(`playground.paseo` on paseo-next-v2) instead of a fixed `playground.dot`.

This is an identity migration, not a cosmetic change: the product id is an
input to the account derivation, so **your product account address changes**.
Apps published from the CLI before this release are owned by the old address
and will no longer show as yours; anything keyed to the old product id (cached
subtrees, the SDK allowance cache under `~/.polkadot-apps/`) is simply not
found under the new one and is re-granted at your next `playground login`.

The change is required for the CLI to work at all against a phone on a
`paseo` environment. The mobile host validates the product id against its own
TLD and drops a mismatch silently, so a `.dot` id produced no prompt, no error
and no reply — only a ~180 second timeout. It also keeps the CLI and the
playground web app on one identity: the app already ships the
environment-suffixed form, and two different ids for the same person would
split app ownership and XP across two accounts.
