---
"playground-cli": patch
---

Update `bulletin-deploy` to 0.20.0.

Fixes two crashes that ended a deploy after the content was already uploaded.
One of them is a crash we hit in practice: `JSON.parse` on incoming RPC data was
unguarded and threw inside the socket handler, where nothing upstream could
catch it, killing the process mid-deploy. The other is `hasIPFS()` passing when
`ipfs` is installed but was never initialised.

Also brings, from 0.19.x: the storage-deposit floor for registering a name drops
from a hardcoded 200 PAS to 5 PAS (measured cost is ~0.15), registers no longer
revert when the chain moves between dry-run and inclusion, duplicate files in a
bundle upload once instead of twice, an interrupted register no longer strands
the commitment fee, Bulletin re-authorizes on an exhausted-but-unexpired quota,
and deploying refuses to silently fall back to the public dev key when a stored
session can't be read.

Additive for us: `deploy()`'s signature is unchanged, every option we pass still
exists, and the log banners the progress bar parses are intact.
