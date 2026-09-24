---
"playground-cli": minor
---

Fix QR pairing, and sign as the RFC-0022 product account.

`playground login` has been unable to pair with current phones since
mid-August: `@novasamatech/host-papp` 0.9.0 moved the pairing envelope from
P-256/AES-GCM to X25519/ChaCha20-Poly1305, shrinking the device key from 65 to
32 bytes. The handshake codec is fixed-width, so there was no graceful
degrade — iOS reported "Something went wrong" and Android "invalid QR code".
Moving to `@parity/product-sdk-terminal@0.10.0` (host-papp 0.10.0) puts the CLI
back on the wire both shipping apps speak.

The same release changes how the product account is derived. RFC-0022 places it
at `//product//{productId}/{index}`, where the two `//product//{productId}`
junctions are HARD — and a public key cannot cross a hard junction, so the
account is now derived from a subtree key the wallet provides rather than from
the session's root key locally.

**Your product account address changes, and you must pair again.** Run
`playground logout` and then `playground login`. Apps published from the old
address stay owned by it; allowances and PGAS are re-granted at the next login.
The new derivation is what current phones and the playground web app already
use, so this brings the CLI back into agreement with them rather than away.

Deploy also stops presenting a retry as progress. The phone-approval counter
was counting signature *requests*, so a request that timed out and was re-sent
appeared as the next step — and contradicted the "Phone approvals expected"
plan, which counts operations. A deploy could print "step 2: Link content"
while the plan said step 2 was the registry publish. Repeats are now labelled
as retries, with the remedy worth checking when no prompt appeared at all.
