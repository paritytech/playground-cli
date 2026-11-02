---
"playground-cli": patch
---

Fix `playground login` after switching accounts in the Polkadot app. Login
could report "allowances already granted" for a new account that had never
been granted anything, because it trusted allowances cached for the previous
account; deploys then refused the account as not set up, and logging out and
back in did not help. Login now checks each cached allowance against the chain
and asks your phone again for any that do not belong to the current account.
