---
"playground-cli": patch
---

Fix phone signing on paseo-next-v2. Every transaction approved on the phone
(registering a domain, publishing to Playground, deploying contracts) was
rejected with `Invalid.UnknownOrigin`, because the CLI asked the Polkadot app to
sign on a transaction format that has no room for the signature. The CLI now
requests the format that carries the signature and PGAS fee sponsorship.
