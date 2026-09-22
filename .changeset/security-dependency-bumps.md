---
"playground-cli": patch
---

Clear the outstanding dependency security advisories that are actually
reachable from the CLI.

The one that mattered: `tar` was on 7.5.16, carrying a critical
decompression/parse DoS. `playground mod` extracts GitHub tarballs of
community-published apps with it, so that parser runs on attacker-controllable
input by design — this was in the threat path, not theoretical. It now resolves
to 7.5.22, and `@types/tar` (a deprecated stub; `tar` ships its own types, and
it was the only thing still pulling a vulnerable 7.5.16) is removed.

Also updated within the ranges their parents already declare, so no forced
resolutions were needed: `@libp2p/peer-store`, `browserslist`, `postcss`,
`brace-expansion`, `undici`, `axios`, `shell-quote`, `form-data`,
`baseline-browser-mapping`, and `vitest` (with `@vitest/mocker`).
