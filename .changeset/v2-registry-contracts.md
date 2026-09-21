---
"playground-cli": minor
---

Move to the v2 playground contracts (registry + identity + verifier).

`registry.publish` now takes four arguments (`domain`, `metadata_uri`,
`visibility`, `modded_from`) and has a new selector, so this release is
required to publish at all — the previous seven-argument form reverts against
the deployed contract. The dropped `owner` parameter changes who owns an app:
the registry now always records the caller, so a dev-mode deploy is owned by
the dev signer and will not appear in your MyApps. `playground deploy` says so
explicitly in its summary instead of implying otherwise.

Also fixes `playground mod` and `playground init`, which failed with
`App "<domain>" not found in registry` for every app, including ones that
demonstrably existed. The v2 registry returns `getMetadataUri` as a plain
string (empty when absent) rather than an `Option`, and the old
`value.isSome` narrowing read `undefined` every time. Decoding now lives in
one place and treats an unexpected payload as an error rather than silently
reporting "not found".
