---
"playground-cli": patch
---

The Bulletin store preflight now asks the chain's `BulletinTransactionStorageApi::can_store` runtime API whether a store will land, instead of reading the chain height and comparing the authorization's `expiration` client-side. A single-byte `can_store` probe folds existence and non-expiry into one on-chain verdict (quota stays a soft limit — never gated, no `Increase` prompt). Mirrors paritytech/bulletin-deploy#693.
