---
"playground-cli": patch
---

Fix the "Join the competition first" notice shown to people who are simply not
logged in: it now says "Log in first" and points at `playground login`.

The builder-identity gate now checks the account that will actually sign when
you pass `--suri` or `--signer dev` (and `--suri` on `playground mod`), instead
of always looking for a phone login session. Headless and CI runs with a local
key are no longer blocked for having no session.
