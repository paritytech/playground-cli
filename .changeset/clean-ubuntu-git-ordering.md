---
"playground-cli": patch
---

Install git before cargo-pvm-contract in `playground init` so clean Linux installs no longer fail at the `git clone` step (the git dependency used to be installed two steps after the first step that needs it)
