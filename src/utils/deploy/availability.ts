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

/**
 * Preflight domain availability check.
 *
 * Classification is local and pure — `classifyLabel` from the canonical
 * `dotnsRules` module (no chain read). One view-only DotNS RPC remains:
 *
 *   - classification (`classifyLabel`):
 *       - `Reserved` → hard block (nobody can register).
 *       - `PoP Lite/Full` → advisory note. PoP-gated names require the
 *         SIGNING account to already be a verified person on the target
 *         chain — nothing in the deploy path can grant personhood, so the
 *         `register()` tx simply fails on-chain if the signer's tier is
 *         insufficient.
 *   - `checkOwnership(label, userH160?)` — catches names registered to
 *     a different account *before* we build + upload. When the caller
 *     passes their own H160 (derived from SS58 via `ss58ToH160`), a
 *     domain owned BY them returns `status: "available"` with a note —
 *     this is the re-deploy / update path, not a block.
 */

import { ss58ToH160 } from "@parity/product-sdk-address";
import { normalizeDomain } from "./playground.js";
import { classifyLabel, POP_STATUS } from "./dotnsRules.js";
import { getChainConfig, getEnvTld, type Env } from "../../config.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

type DotNSInstance = InstanceType<typeof import("bulletin-deploy").DotNS>;

let bulletinDeployPromise: Promise<typeof import("bulletin-deploy")> | null = null;

async function createDotNS(): Promise<DotNSInstance> {
    bulletinDeployPromise ??= import("bulletin-deploy");
    const { DotNS } = await bulletinDeployPromise;
    return new DotNS();
}

/**
 * What polkadot-app-deploy will submit on-chain, used to render a correct phone-tap
 * count BEFORE the user confirms.
 *
 * `register` = new domain (commit + reveal + setContenthash).
 * `update`   = already owned by us; only setContenthash fires.
 *
 * NOTE: there is no PoP-grant tap. polkadot-app-deploy reads the signer's PoP tier
 * and fails if it is insufficient — it never submits a setUserPopStatus tx — so
 * the prediction does not include one.
 */
export interface DeployPlan {
    action: "register" | "update";
}

export type AvailabilityResult =
    | {
          status: "available";
          label: string;
          fullDomain: string;
          note?: string;
          plan: DeployPlan;
      }
    | { status: "reserved"; label: string; fullDomain: string; message: string }
    | { status: "taken"; label: string; fullDomain: string; owner: string }
    | { status: "unknown"; label: string; fullDomain: string; message: string };

export interface CheckAvailabilityOptions {
    env?: Env;
    /** Optional timeout in ms. Each RPC call has its own internal timeout. */
    timeoutMs?: number;
    /**
     * SS58 address of the account that will SIGN the DotNS `register()` /
     * `setContenthash` extrinsics — NOT necessarily the currently logged-in
     * user. When provided we derive its H160 via `ss58ToH160` and treat
     * "owned by you" as an update path rather than a `taken` block.
     *
     * Must match whoever polkadot-app-deploy will use as its DotNS signer:
     *   - Phone mode → user's signer address.
     *   - Dev mode   → omit entirely (polkadot-app-deploy falls back to its
     *     built-in `DEFAULT_MNEMONIC`, and we have no easy way to derive
     *     that H160 without replicating polkadot-app-deploy internals). When
     *     omitted we skip the preflight ownership check; polkadot-app-deploy's
     *     own preflight during `deploy()` is run with the right signer and
     *     classifies the re-deploy correctly.
     *
     * Passing the wrong address (e.g. the phone session's H160 in dev mode)
     * mis-reports re-deploys as `taken` because the on-chain owner is the
     * dev account, not the user.
     */
    ownerSs58Address?: string;
}

export async function checkDomainAvailability(
    domain: string,
    options: CheckAvailabilityOptions = {},
): Promise<AvailabilityResult> {
    const { label, fullDomain } = normalizeDomain(domain, getEnvTld(options.env));
    const cfg = getChainConfig(options.env);

    // DotNS connect pings RPC + does an `ensureAccountMapped` tx if the dev
    // account isn't mapped yet. On testnet the default account is already
    // mapped, so this is effectively a pure read path — no phone prompts.
    //
    // We do not pass a signer here, so polkadot-app-deploy falls back to its
    // `DEFAULT_MNEMONIC` to build a keyring just for the read-only RPC
    // client. That fallback prints lines like
    //   `   SS58 Address: 5DfhG…`
    //   `   H160 Address: 0x…`
    //   `   Account: mapped`
    // to stdout, which look — confusingly — like the deploying account. They
    // are not: nothing here signs anything. Silence them so the only address
    // the user sees is the one polkadot-app-deploy logs from the *actual* deploy
    // (which uses the user's signer and we don't suppress).
    //
    // Silence is narrowed to the `connect()` call ONLY — `checkOwnership`
    // below runs with normal console semantics so any unexpected log surfaces.
    const dotns = await createDotNS();
    try {
        const restore = silenceConsole();
        try {
            await withTimeout(
                dotns.connect({ rpc: cfg.assetHubRpc }),
                options.timeoutMs ?? 30_000,
                "DotNS connect",
            );
        } finally {
            restore();
        }

        // Classification is local + pure via the canonical `dotnsRules`
        // module — no RPC. It mirrors the on-chain dotns contract rules.
        const classification = classifyLabel(label);
        if (classification.status === POP_STATUS.Reserved) {
            return {
                status: "reserved",
                label,
                fullDomain,
                message: classification.message || "Reserved for Governance",
            };
        }

        // Ownership check — pass the user's H160 so "owned by you" is
        // correctly identified as an update path rather than a block.
        // When the caller doesn't know (dev mode with no session), we skip
        // the ownership check and let polkadot-app-deploy's own preflight
        // (which always has the right signer) make the final call.
        const userH160 = options.ownerSs58Address ? ss58ToH160(options.ownerSs58Address) : null;

        if (userH160) {
            const { owned, owner } = await dotns.checkOwnership(label, userH160);
            if (owner && owner.toLowerCase() !== ZERO_ADDRESS && !owned) {
                return { status: "taken", label, fullDomain, owner };
            }
            if (owned) {
                return {
                    status: "available",
                    label,
                    fullDomain,
                    note: "Already owned by you — will update the existing deployment.",
                    plan: { action: "update" },
                };
            }
        }

        const plan: DeployPlan = { action: "register" };

        // PoP-gated names (base length 6-8) require the SIGNING account to
        // already be a verified person on the target chain. Nothing in the
        // deploy path can grant personhood — polkadot-app-deploy reads the tier and
        // the register() tx fails on-chain if it is insufficient. So this is an
        // advisory note (the rule varies per environment and we don't read the
        // signer's tier here), not a hard block.
        if (
            classification.status === POP_STATUS.Lite ||
            classification.status === POP_STATUS.Full
        ) {
            const requirement = classification.status === POP_STATUS.Full ? "Full" : "Lite";
            const noStatusHint = `${label}-app`;
            return {
                status: "available",
                label,
                fullDomain,
                note:
                    `Requires ${requirement} Proof of Personhood — the signing account must already be ` +
                    `verified on this network, or registration will fail. ` +
                    `Tip: a name with a 9+ character base (e.g. "${noStatusHint}") is open to everyone.`,
                plan,
            };
        }

        return { status: "available", label, fullDomain, plan };
    } catch (err) {
        return {
            status: "unknown",
            label,
            fullDomain,
            message: err instanceof Error ? err.message : String(err),
        };
    } finally {
        try {
            dotns.disconnect();
        } catch {
            // best-effort — disconnect is idempotent in practice
        }
    }
}

/**
 * Replace `console.log` / `console.info` / `console.warn` with no-ops, returning
 * a restore() that puts the originals back. Used only in narrow windows where a
 * dependency prints state we don't want surfaced (polkadot-app-deploy's preflight
 * fallback signer is the canonical example). Errors still go through —
 * `console.error` is intentionally not silenced so genuine failures surface.
 *
 * Nested or duplicate `silenceConsole()` calls are a no-op past the first: if
 * `console.log` already IS our no-op, we capture the no-op as "original" and
 * `restore()` would replace the no-op with itself — leaving the outer caller's
 * restore correctly pointing at the true original. Each restore is also
 * idempotent: calling it twice doesn't re-silence.
 */
const NOOP = (): void => {};
function silenceConsole(): () => void {
    const originals = {
        log: console.log,
        info: console.info,
        warn: console.warn,
    };
    console.log = NOOP;
    console.info = NOOP;
    console.warn = NOOP;
    let restored = false;
    return () => {
        if (restored) return;
        restored = true;
        console.log = originals.log;
        console.info = originals.info;
        console.warn = originals.warn;
    };
}

/** Human-readable single-line summary for the TUI / CLI. */
export function formatAvailability(result: AvailabilityResult): string {
    switch (result.status) {
        case "available":
            return result.note
                ? `${result.fullDomain} is available — ${result.note}`
                : `${result.fullDomain} is available`;
        case "reserved":
            return `${result.fullDomain} is reserved — ${result.message}`;
        case "taken":
            return `${result.fullDomain} is already registered by ${result.owner} — transfer it or use a different name`;
        case "unknown":
            return `Could not verify ${result.fullDomain}: ${result.message}`;
    }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) =>
            setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
        ),
    ]);
}
