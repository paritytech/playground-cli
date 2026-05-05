---
"playground-cli": patch
---

`dot deploy --modable` now rejects private GitHub repositories at preflight with a clear error message instead of silently failing later. `dot mod` also surfaces a more actionable error when it encounters a private or non-existent repository instead of the misleading "pin one in metadata.branch" hint.
