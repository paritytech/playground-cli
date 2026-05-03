---
"playground-cli": patch
---

Remove unreachable null-signer guard in `resolveSignerSetup` (`signerMode.ts`). The dead `throw` could never fire because `shouldResolveUserSigner()` guarantees a signer is resolved before `resolveSignerSetup` is called when `--playground` is set. No user-visible behaviour change.
