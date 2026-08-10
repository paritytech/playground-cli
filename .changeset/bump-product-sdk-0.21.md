---
"playground-cli": patch
---

Update the `@parity/product-sdk-*` dependencies to the 0.21.0 release line (contracts 0.10.1, descriptors 0.9.0, host 0.15.1, tx 0.4.1, cloud-storage 0.10.0, keys 0.3.18, terminal 0.7.1; chain-client 0.10.0, local-storage 0.3.4, signer 0.12.1 transitively). The motivating change is `descriptors@0.9.0`, which regenerates the paseo-bulletin descriptors for the upcoming v0.0.22-paseo Bulletin runtime (spec 1_000_022, new `DataRenewal` pallet) — fixing commands that broke against the upgraded Bulletin chain. The rest of the line is additive: `tx@0.4` adds `TxValidityError`, `contracts@0.10` adds `isContractAccountMapped` + origin validation, `terminal@0.7` adds `AllowanceExpiredError` and optional explicit `productId` on the allocation APIs.
