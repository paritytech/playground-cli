---
"playground-cli": patch
---

Fix deploys failing with `Contract execution would revert during startingPrice on POP_RULES`.

The DotNS contracts ship in ABI *generations* that are redeployed behind the same
contract addresses, and roll out per environment rather than per release. Generation
`v0.5.8-rc1` removed `PopRules.startingPrice()`, so the pinned `bulletin-deploy@0.15.0`
— which only knows the older generation and calls that function unconditionally — hit a
revert on paseo-next-v2 for every deploy, dev mode included. Because the addresses never
changed, this was invisible to any version diff of `environments.json`.

Bumps `bulletin-deploy` to `0.18.4`, which probes the live generation at connect time and
supports all three.

Also fixes the domain-availability preflight, which constructed `DotNS` and connected with
only an RPC URL. Without a contract map it fell back to built-in defaults whose `POP_RULES`
has no code on this network, so 0.16+'s generation probe failed with "No contract deployed
at this address". It now resolves the env's contracts from bulletin-deploy's own
`environments.json` and passes them (plus `environmentId`) to `connect()`, matching what the
deploy path already did. The divergence guard in `config.test.ts` now asserts that contract
map exists upstream, so a catalog change fails in CI rather than mid-deploy.
