---
"playground-cli": patch
---

Stop presenting an unanswered phone request as progress.

When the phone doesn't answer a signing request (usually because the Polkadot
app isn't open in the foreground, which shows no prompt at all), the deploy
re-sends it. Every re-send used to be numbered as the next step, so a user who
had approved nothing could see "step 3: Link content" on a deploy that needs
two approvals. For a new domain, a re-sent "Reserve domain" request was also
relabelled "Finalize domain".

Steps now count approvals rather than requests: a re-send keeps its step and
label and is shown as "No response yet — re-sent to your phone (attempt N)",
with a reminder to keep the app in the foreground. This applies to
`playground deploy`, `decentralize` and contract deploys, in both the
interactive screen and `--yes` output.
