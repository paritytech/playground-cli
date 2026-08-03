---
"playground-cli": patch
---

Contract deploy now shows an actionable message when `cargo metadata` fails, instead of dumping the raw `Command failed: cargo metadata … --no-deps` command. The message explains the likely causes (missing Rust toolchain, offline git-dependency fetch, or an invalid Cargo.toml) and still surfaces cargo's own diagnostic (e.g. the offending `Cargo.toml` line) so a malformed manifest stays fixable.
