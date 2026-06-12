---
"playground-cli": patch
---

`playground deploy --contracts` on a project with no smart contracts now fails fast with an actionable message (naming the directory it scanned) instead of the cryptic "No library specified and no dependencies found in cdm.json." The interactive TUI also no longer mislabels non-signing contract-phase errors under a "Signing Failed" banner, and `playground contract install` with no libraries and an empty cdm.json now explains where it looked and what to do.
