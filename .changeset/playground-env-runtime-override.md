---
"playground-cli": minor
---

Resolve the active environment at runtime from a `PLAYGROUND_ENV` env var.

`getChainConfig()`, `getNetworkLabel()`, `getTokenSymbol()`, and `getPgasAssetId()` now
default to a new `getActiveEnv()` helper, which reads `PLAYGROUND_ENV` (validated against
the wired `CONFIGS`) and falls back to the build-time `DEFAULT_ENV` when it is unset or
unknown. This makes the direct-chain layer (`getConnection`, pairing, registry, drip)
follow the selected network, so a single build can target any wired env (e.g. Summit or
Paseo) at runtime without flipping `ACTIVE_TESTNET_ENV` and rebuilding. Existing callers
are unaffected: with `PLAYGROUND_ENV` unset, behaviour is identical to before.
