---
"playground-cli": patch
---

Ask the personhood verifier the registry actually uses before blocking a
command.

`playground deploy`, `deploy-all`, `mod` and `decentralize` refused with
"Join the competition first" for users whose publish the chain would have
accepted. The gate read `getRootAccount` from the identity spine, but the
registry does not consult the spine — it consults whatever `set_verifier`
names, which on the current deployment is an open verifier that accepts every
account. The CLI was enforcing a stricter rule than the chain, against a
different contract.

The gate now resolves `registry.getVerifier()` and calls `isVerified` on that
address, so it is correct both today and on a competition deployment that
wires the spine, with no flag to keep in sync. It asks the verifier a
question rather than comparing its address — an address comparison would be
correct only until the next verifier implementation.
