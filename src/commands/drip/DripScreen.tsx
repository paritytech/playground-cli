// Copyright (C) Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: Apache-2.0

// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { Header, Section, Row, Callout, Hint } from "../../utils/ui/theme/index.js";
import { VERSION_LABEL } from "../../utils/version.js";
import { getNetworkLabel } from "../../config.js";
import { findSession, deriveSessionAddresses } from "../../utils/auth.js";
import { getConnection, destroyConnection } from "../../utils/connection.js";
import {
    dripToProductAccount,
    DevFunderExhaustedError,
    formatPas,
    DRIP_AMOUNT,
    DRIP_CAP,
} from "../../utils/account/drip.js";

/**
 * Terminal outcome of a drip run. Reported to the command wrapper so it can
 * set the right exit code: only `error` is a genuine failure (exit 1); every
 * other outcome — including "log in first" and "dev funder out of tokens" — is
 * a soft, expected result the user can act on, so it exits 0.
 */
export type DripOutcome =
    | "done"
    | "skipped"
    | "needLogin"
    | "corruptSession"
    | "exhausted"
    | "error";

type Phase =
    | { kind: "checking" }
    | { kind: "dripping"; recipient: string }
    | { kind: "done"; recipient: string; balance: bigint }
    | { kind: "skipped"; recipient: string; balance: bigint }
    | { kind: "needLogin" }
    | { kind: "corruptSession" }
    | { kind: "exhausted"; funder: string }
    | { kind: "error"; message: string };

export function DripScreen({ onDone }: { onDone: (outcome: DripOutcome) => void }) {
    const [phase, setPhase] = useState<Phase>({ kind: "checking" });

    useEffect(() => {
        let cancelled = false;

        const describe = (err: unknown): string =>
            err instanceof Error ? err.message : String(err);

        (async () => {
            // ── Who is signed in? ───────────────────────────────────────────
            let handle: Awaited<ReturnType<typeof findSession>>;
            try {
                handle = await findSession();
            } catch (err) {
                if (cancelled) return;
                setPhase({ kind: "error", message: describe(err) });
                onDone("error");
                return;
            }
            if (cancelled) return;
            if (!handle) {
                // findSession() already released its adapter on the null path.
                setPhase({ kind: "needLogin" });
                onDone("needLogin");
                return;
            }

            // Resolve the recipient by deriving the product account directly
            // from the session — NOT `handle.address`. That field comes from
            // the logout-oriented `sessionLogoutAddress()`, whose failure
            // fallback returns the ROOT account (or a non-address string); for
            // a command that MOVES FUNDS we must never silently fund the wrong
            // account, so we derive `playground.dot/0` explicitly and fail safe
            // if the session can't be derived. `deriveSessionAddresses` is the
            // single source of the product address used across the CLI.
            let recipient: string | null;
            try {
                recipient = (await deriveSessionAddresses(handle.session)).productAddress;
            } catch {
                recipient = null;
            }
            // We only need the address; the session signer is not used (the dev
            // funder signs the transfer). Release the adapter so its WebSocket
            // doesn't keep the event loop alive — on EVERY branch below.
            await handle.adapter.destroy().catch(() => {});
            if (cancelled) return;
            if (recipient === null) {
                setPhase({ kind: "corruptSession" });
                onDone("corruptSession");
                return;
            }

            // ── Connect + drip ──────────────────────────────────────────────
            let client: Awaited<ReturnType<typeof getConnection>>;
            try {
                client = await getConnection();
            } catch (err) {
                if (cancelled) return;
                setPhase({ kind: "error", message: describe(err) });
                onDone("error");
                return;
            }
            if (cancelled) return;

            setPhase({ kind: "dripping", recipient });
            try {
                const result = await dripToProductAccount(client, recipient);
                if (cancelled) return;
                if (result.skipped) {
                    setPhase({ kind: "skipped", recipient, balance: result.balance });
                    onDone("skipped");
                } else {
                    setPhase({
                        kind: "done",
                        recipient,
                        balance: result.balance + (result.transferred ?? 0n),
                    });
                    onDone("done");
                }
            } catch (err) {
                if (cancelled) return;
                if (err instanceof DevFunderExhaustedError) {
                    setPhase({ kind: "exhausted", funder: err.address });
                    onDone("exhausted");
                } else {
                    setPhase({ kind: "error", message: describe(err) });
                    onDone("error");
                }
            }
        })();

        return () => {
            cancelled = true;
            // The shared connection is owned process-wide; tearing it down here
            // lets the event loop drain. The hard-exit safety net covers any
            // straggler sockets.
            destroyConnection();
        };
    }, [onDone]);

    return (
        <Box flexDirection="column">
            <Header
                cmd="playground drip"
                subtitle="polkadot playground"
                network={getNetworkLabel()}
                right={VERSION_LABEL}
            />
            <Body phase={phase} />
        </Box>
    );
}

function Body({ phase }: { phase: Phase }) {
    switch (phase.kind) {
        case "checking":
            return (
                <Section gapBelow={false}>
                    <Row mark="run" label="account" value="checking…" tone="muted" />
                </Section>
            );

        case "needLogin":
            return (
                <Callout tone="warning" title="Log in first">
                    <Text>
                        {"`playground drip`"} tops up the account paired with your phone, so you
                        need to be signed in.
                    </Text>
                    <Text> </Text>
                    <Text>
                        Run <Text bold>playground login</Text> and scan the QR code with your
                        Polkadot mobile app, then try again.
                    </Text>
                </Callout>
            );

        case "dripping":
            return (
                <Section gapBelow={false}>
                    <Row
                        mark="run"
                        label="drip"
                        value={`sending ${formatPas(DRIP_AMOUNT)}…`}
                        tone="muted"
                        hint={phase.recipient}
                    />
                </Section>
            );

        case "done":
            return (
                <Box flexDirection="column">
                    <Section gapBelow={false}>
                        <Row
                            mark="ok"
                            label="drip"
                            value={`sent ${formatPas(DRIP_AMOUNT)}`}
                            tone="muted"
                            hint={phase.recipient}
                        />
                    </Section>
                    <Hint>
                        Balance is now about {formatPas(phase.balance)} (cap {formatPas(DRIP_CAP)}).
                        Run it again to add another {formatPas(DRIP_AMOUNT)}.
                    </Hint>
                </Box>
            );

        case "skipped":
            return (
                <Box flexDirection="column">
                    <Section gapBelow={false}>
                        <Row
                            mark="ok"
                            label="drip"
                            value="already topped up"
                            tone="muted"
                            hint={phase.recipient}
                        />
                    </Section>
                    <Hint>
                        Your account already holds {formatPas(phase.balance)}, at or above the{" "}
                        {formatPas(DRIP_CAP)} cap. No top-up needed.
                    </Hint>
                </Box>
            );

        case "corruptSession":
            return (
                <Callout tone="warning" title="Couldn't read your account">
                    <Text>
                        You're signed in, but we couldn't work out your account from the stored
                        session. It may be out of date.
                    </Text>
                    <Text> </Text>
                    <Text>
                        Run <Text bold>playground logout</Text>, then{" "}
                        <Text bold>playground login</Text> to pair again, and try once more.
                    </Text>
                </Callout>
            );

        case "exhausted":
            return (
                <Callout tone="warning" title="Dev funder is out of tokens">
                    <Text>
                        The shared testnet dev funder is temporarily empty, so there is nothing to
                        drip right now. This is on our side, not your account.
                    </Text>
                    <Text> </Text>
                    <Text>Please try again later, or let the Playground team know.</Text>
                </Callout>
            );

        case "error":
            return (
                <Callout tone="danger" title="Couldn't drip tokens">
                    <Text>{phase.message}</Text>
                    <Text> </Text>
                    <Text>Check your internet connection and try again.</Text>
                </Callout>
            );
    }
}
