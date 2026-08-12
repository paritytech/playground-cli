---
"playground-cli": minor
---

Support per-network DotNS TLDs (`.paseo` on paseo-next-v2) and move the deploy library to `bulletin-deploy@0.15.0` (the renamed `@parity/polkadot-app-deploy`), which carries the post-wipe DotNS contract addresses. Deploys, decentralize, mod lookups, and all UI copy now use the environment's TLD; a name typed with the wrong TLD (e.g. `my-app.dot` on paseo-next-v2) is rejected with an actionable message. The `playground.dot` product id is unchanged by convention.
