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

import { Box } from "ink";
import { useState, useEffect } from "react";
import { Row, Section, PhoneApprovalCallout, type MarkKind } from "../../utils/ui/theme/index.js";
import { getConnection } from "../../utils/connection.js";
import { getSessionSigner, type SessionHandle } from "../../utils/auth.js";
import { checkMapping } from "../../utils/account/mapping.js";
import { resourcesToRequest } from "./allowanceStep.js";
import { getCachedAllocation, requestResourceAllocation } from "@parity/product-sdk-terminal/host";
import {
    PLAYGROUND_RESOURCES,
    describeAllocationFailure,
    productScopedAdapter,
    summarizeOutcomes,
} from "../../utils/allowances/resources.js";
import {
    asCloudStorageApi,
    cachedBulletinSlotAuthorization,
} from "../../utils/allowances/bulletin.js";

type Status = "pending" | "active" | "ok" | "failed" | "skipped";

interface StepState {
    label: string;
    status: Status;
    value?: string;
    valueTone?: "default" | "danger" | "warning" | "muted" | "accent";
    hint?: string;
    error?: string;
}

function toMark(status: Status): MarkKind | undefined {
    switch (status) {
        case "active":
            return "run";
        case "ok":
            return "ok";
        case "failed":
            return "fail";
        case "skipped":
            return "idle";
        default:
            return "idle";
    }
}

interface PhonePrompt {
    step: number;
    total: number;
    label: string;
}

// Grace period to wait after a fresh QR pairing before sending the RFC-0010
// resource-allocation request to the phone. The mobile app sends the
// host-facing `HandshakeResponse.Success` (which resolves our login) PART-WAY
// through its pairing flow — during the "Registering" step — then runs a
// "Syncing data" step before it dismisses its non-cancellable "Connecting
// device" modal. As of polkadot-app-android-v2 that sync step is a stubbed
// `delay(800ms)` (RealSyncDeviceUseCase). If we fire the allowance request in
// that window, the phone opens the approval dialog on the SAME NavController
// that still holds the pairing modal: the approval sheet is obscured, and the
// pairing flow's `router.back()` (top-of-stack pop) then dismisses the
// approval sheet instead of the pairing modal — so the request is silently
// lost and our `requestResourceAllocation` hangs to its queue timeout.
// Waiting comfortably past the 800ms stub lets the phone dismiss its modal
// first, so our request lands on a clean navigation stack. This is a stopgap
// keyed to that stub delay; the durable fix is phone-side (send Success only
// after pairing completes / pop a specific destination). See the android
// issue tracked for this race.
const PHONE_PAIRING_MODAL_GRACE_MS = 2000;

export function AccountSetup({
    address,
    freshlyPaired,
    onDone,
}: {
    address: string;
    freshlyPaired: boolean;
    onDone: (success: boolean) => void;
}) {
    const [steps, setSteps] = useState<StepState[]>([
        { label: "allowances", status: "pending" },
        { label: "mapping", status: "pending" },
    ]);
    const [phonePrompt, setPhonePrompt] = useState<PhonePrompt | null>(null);

    useEffect(() => {
        let cancelled = false;
        let session: SessionHandle | null = null;
        let graceTimer: ReturnType<typeof setTimeout> | undefined;

        const update = (idx: number, patch: Partial<StepState>) => {
            if (cancelled) return;
            setSteps((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));
        };

        const finish = (success: boolean) => {
            if (cancelled) return;
            setPhonePrompt(null);
            onDone(success);
        };

        const describe = (err: unknown): string =>
            err instanceof Error ? err.message : String(err);

        (async () => {
            let client: Awaited<ReturnType<typeof getConnection>>;
            try {
                client = await getConnection();
            } catch (err) {
                const msg = describe(err);
                setSteps((prev) => prev.map((s) => ({ ...s, status: "failed", error: msg })));
                finish(false);
                return;
            }
            if (cancelled) return;

            session = await getSessionSigner();
            if (cancelled) return;
            if (!session) {
                setSteps((prev) =>
                    prev.map((s) => ({
                        ...s,
                        status: "failed",
                        error: "no session — run playground login to log in",
                    })),
                );
                finish(false);
                return;
            }

            // ── Step 0: Resource allowances ─────────────────────────────────
            // The CLI acts as the Host for terminal sessions: RFC-0010
            // allocations are requested over the paired session and the SDK
            // caches granted slot keys at
            // ~/.polkadot-apps/<appId>_AllowanceKeys.json. A cache entry is
            // only written after the wallet returns Allocated, but it is keyed
            // by product id, not by account, and survives logout — so a cached
            // grant can belong to a previous phone account. Each cached entry
            // is checked against the chain (`resourcesToRequest`): Bulletin by
            // its slot authorization, smart contracts by the account's Revive
            // mapping. We do NOT re-prompt on low tx/byte quota — Bulletin
            // `store` treats those counters as soft limits, so a live,
            // unexpired slot is usable regardless of how exhausted they read.
            update(0, { status: "active", value: "checking…", valueTone: "muted" });
            let accountSetupOk = true;
            try {
                const { adapter: rawAdapter, userSession } = session;
                // Product-scoped on purpose: the wire `callingProductId` is what
                // the phone derives the PGAS claim TARGET from. The raw adapter's
                // `dot-cli` id minted the PGAS to `dot-cli/0` instead of
                // `playground.dot/0` — see `productScopedAdapter`.
                const adapter = productScopedAdapter(rawAdapter);
                const cached = await Promise.all(
                    PLAYGROUND_RESOURCES.map((r) => getCachedAllocation(adapter, r)),
                );
                const [bulletinAuth, accountMapped] = await Promise.all([
                    cachedBulletinSlotAuthorization(
                        adapter,
                        asCloudStorageApi(client.bulletin),
                    ).catch(() => null),
                    // A read error counts as unmapped: the worst case is one
                    // extra approval dialog, never a skipped grant.
                    checkMapping(client, address, { attempts: 2, delayMs: 1000 }),
                ]);
                const toRequest = resourcesToRequest(PLAYGROUND_RESOURCES, {
                    cached: cached.map(Boolean),
                    bulletinUsable: bulletinAuth?.usable === true,
                    accountMapped,
                });

                if (toRequest.length === 0) {
                    update(0, {
                        status: "ok",
                        value: "already granted",
                        valueTone: "muted",
                    });
                } else {
                    // Only a fresh QR pairing puts the phone's "Connecting
                    // device" modal up; on a re-run with an existing session
                    // there is nothing to wait for, so skip the grace.
                    if (freshlyPaired) {
                        update(0, {
                            status: "active",
                            value: "finishing pairing on your phone…",
                            valueTone: "muted",
                        });
                        await new Promise((resolve) => {
                            graceTimer = setTimeout(resolve, PHONE_PAIRING_MODAL_GRACE_MS);
                        });
                        if (cancelled) return;
                    }
                    update(0, {
                        status: "active",
                        value: "approve on your Polkadot mobile app…",
                        valueTone: "muted",
                    });
                    setPhonePrompt({
                        step: 1,
                        total: 1,
                        label: "grant resource allowances",
                    });
                    const outcomes = await requestResourceAllocation(
                        userSession,
                        adapter,
                        toRequest,
                    );
                    if (cancelled) return;
                    setPhonePrompt(null);
                    const summary = summarizeOutcomes(outcomes, toRequest);

                    const failure = describeAllocationFailure(summary);
                    if (failure) {
                        // Diagnostic-only stderr line distinguishing a user
                        // decline (Rejected) from the wallet being unable to
                        // provision (NotAvailable, e.g. an out-of-date mobile
                        // build or a full on-chain slot ring). Positional:
                        // outcomes[i] ↔ toRequest[i]. Verbose-gated:
                        // the user-facing `failure` line already gives each
                        // bucket its own remedy, and raw tag dumps confuse
                        // users.
                        if (process.env.DOT_DEPLOY_VERBOSE === "1") {
                            const detail = toRequest
                                .map((r, i) => `${r.tag}=${outcomes[i]?.tag ?? "missing"}`)
                                .join(" ");
                            console.error(`[allowances] resource allocation outcomes: ${detail}`);
                        }
                        accountSetupOk = false;
                        update(0, {
                            status: "failed",
                            error: failure,
                            valueTone: "danger",
                        });
                    } else {
                        update(0, {
                            status: "ok",
                            value: `granted (${summary.granted.length})`,
                            valueTone: "muted",
                        });
                    }

                    if (cancelled) return;
                }
            } catch (err) {
                setPhonePrompt(null);
                accountSetupOk = false;
                update(0, {
                    status: "failed",
                    error: describe(err),
                    valueTone: "danger",
                });
            }

            // ── Step 1: Verify Revive H160 mapping (read-only) ──────────────
            // No funding, no `map_account`: the `SmartContractAllowance` grant
            // in Step 0 makes the phone submit `Pgas.claim_pgas`, minting PGAS
            // (a `sufficient` asset) to the product account — which creates it
            // in `frame_system` and fires `pallet_revive::AutoMapper`, mapping
            // SS58 -> H160 with zero native funding (verified on-chain on
            // paseo-next-v2, 2026-06-11). This step only READS the mapping.
            //
            // The retry window absorbs node propagation: the phone confirms
            // the claim in-block on ITS node before answering Allocated, and
            // this read can hit a different RPC node a moment behind.
            // `checkMapping` reads the BEST head — finalization lags ~80 s
            // here and must not gate this check.
            update(1, { status: "active", value: "checking…", valueTone: "muted" });
            try {
                const mapped = await checkMapping(client, address, { attempts: 6, delayMs: 2000 });
                if (cancelled) return;
                update(
                    1,
                    mapped
                        ? { status: "ok", value: "ready", valueTone: "muted" }
                        : {
                              status: "failed",
                              value: "not ready yet",
                              valueTone: "warning",
                              hint: "Your account isn't ready for smart contracts yet — this usually resolves on its own. Wait a minute, then run `playground login` again; if the account is still not set up, it asks your phone to approve the allowance again.",
                          },
                );
            } catch (err) {
                update(1, {
                    status: "failed",
                    error: describe(err),
                    valueTone: "danger",
                });
            }

            finish(accountSetupOk);
        })();

        // Cleanup is the SOLE owner of `session?.destroy()`. Calling destroy()
        // from a `.finally()` AND here races them — both fire near-instantly on
        // success/failure, and the second one trips a half-torn-down adapter
        // into surfacing `DestroyedError: Client destroyed` from
        // polkadot-api's raw-client. Even though the wrapped `destroy()` has an
        // idempotency flag, the inner `adapter.destroy()` is fire-and-forget,
        // so the second invocation sees `destroyed=true` while the first's
        // async drain is still in flight, and rejections leak as
        // unhandledRejection (the process-guard's stderr write then corrupts
        // Ink's cursor anchor and the whole screen re-renders stacked).
        return () => {
            cancelled = true;
            // Clear a pending grace timer so an unmount mid-wait doesn't keep
            // the Node event loop alive — `login` runs `hardExit: false` and
            // relies on the loop draining naturally after teardown.
            if (graceTimer) clearTimeout(graceTimer);
            session?.destroy();
        };
    }, [address, freshlyPaired, onDone]);

    return (
        <Box flexDirection="column">
            <Section title="account">
                {steps.map((step) => (
                    <Row
                        key={step.label}
                        mark={toMark(step.status)}
                        label={step.label}
                        value={step.value}
                        tone={step.valueTone ?? "default"}
                        hint={step.error ?? step.hint}
                    />
                ))}
            </Section>
            {phonePrompt && (
                <PhoneApprovalCallout
                    step={phonePrompt.step}
                    total={phonePrompt.total}
                    label={phonePrompt.label}
                />
            )}
        </Box>
    );
}
