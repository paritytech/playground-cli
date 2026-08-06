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
 * Builder-identity gate.
 *
 * The value-creating commands (`mod`/`init`, `deploy`, `decentralize`,
 * `deploy-all`) are reserved for users who have "revealed themselves" — bound
 * a verified identity on-chain via the playground-app's "Become a builder"
 * flow. Anonymous accounts earn no competition points, so the CLI refuses to
 * act for them.
 *
 * "Revealed" is decided by the identity spine (`@w3s/playground-identity`):
 * `isVerified(productH160)` returns true. This is the EXACT predicate the
 * registry's fail-closed publish gate (`require_revealed`) delegates to
 * on-chain, so for PHONE-mode publishes (where the session's product account
 * IS `env::caller()`) the gate's verdict predicts scored-publish success
 * precisely. In `--suri` mode it does NOT: the gate still checks the
 * session's product H160 while the chain checks the suri key's H160, so a
 * revealed session + unrevealed suri key passes here and reverts NotRevealed
 * at publish (and vice versa). The spine `unwrap_or`s a missing binding to
 * false and never reverts, so `false` IS the "anonymous" answer.
 *
 * This module is pure logic (no React/Ink). The session's product H160 is
 * derived signer-free from the persisted login (`findSession` ->
 * `deriveSessionAddresses`), and the read uses the keyless revive origin
 * (`getReadOnlyIdentityContract`), so evaluating the gate needs neither a
 * phone tap nor a mapped/funded account.
 */

import type { PolkadotClient } from "polkadot-api";
import { findSession, deriveSessionAddresses } from "../auth.js";
import { getReadOnlyIdentityContract } from "../registry.js";

export type IdentityGateResult =
    | { status: "revealed"; productH160: `0x${string}` }
    | { status: "not-logged-in" }
    | { status: "anonymous"; productH160: `0x${string}` }
    | { status: "unverifiable"; detail: string };

/** Blocked outcomes — everything except `revealed`. */
export type BlockedIdentityStatus = "not-logged-in" | "anonymous" | "unverifiable";

interface VerifiedQueryResult {
    success: boolean;
    value?: unknown;
}

/**
 * Minimal structural view of the identity-spine handle.
 * `getReadOnlyIdentityContract` returns a runtime Proxy (via
 * `suppressReviveTraceNoise`) whose full typing we don't want to depend on
 * here. The generated ABI does expose `isVerified` (`.cdm/contracts.d.ts`,
 * `response: boolean`); we narrow to just the one read method we call.
 *
 * NOTE on the `as unknown as IdentitySpine` seam below: it looks removable
 * (locally the `.cdm` augmentation makes the handle structurally assignable
 * with no cast) but is NOT — `.cdm` is gitignored and CI typechecks without
 * it, where `getContract` returns the un-augmented `Contract<ContractDef>`,
 * whose string-index methods satisfy property ACCESS but not structural
 * ASSIGNABILITY. Compile-time drift protection therefore can't exist in CI;
 * the real guard is queryVerified's runtime AbiDriftError.
 */
export interface IdentitySpine {
    isVerified: { query(account: `0x${string}`): Promise<VerifiedQueryResult> };
}

interface GateOptions {
    /** Dry-run retry budget. Defaults to 2 (a transient RPC blip shouldn't lock out a builder). */
    attempts?: number;
    /** Delay between retries in ms. Defaults to 250. */
    delayMs?: number;
    /**
     * Pre-resolved identity-spine handle. Callers that already built one (e.g.
     * `mod`) pass it to avoid a second meta-registry resolution + Revive
     * dry-run. When omitted, the gate resolves its own from
     * `rawAssetHubClient`.
     */
    identity?: IdentitySpine;
}

function describe(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

/** Deterministic bundled-ABI vs live-contract mismatch — retrying can't help. */
class AbiDriftError extends Error {}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function queryVerified(
    spine: IdentitySpine,
    account: `0x${string}`,
    attempts: number,
    delayMs: number,
): Promise<boolean> {
    let lastError: unknown;
    for (let i = 0; i < attempts; i++) {
        try {
            const res = await spine.isVerified.query(account);
            if (res.success) {
                // Anything but a strict boolean means the ABI we bundle and
                // the live contract disagree — deterministic, so fail straight
                // to `unverifiable` upstream instead of burning the retry
                // budget (which exists for transient RPC blips) on an answer
                // that cannot change between attempts.
                if (typeof res.value !== "boolean") {
                    throw new AbiDriftError(
                        `Unrecognized isVerified response (${typeof res.value}): ` +
                            `${JSON.stringify(res.value)} — bundled ABI vs live contract drift?`,
                    );
                }
                return res.value;
            }
            lastError = new Error("identity.isVerified dry-run was rejected (success=false)");
        } catch (err) {
            // Drift is deterministic — skip the remaining retry budget.
            if (err instanceof AbiDriftError) throw err;
            lastError = err;
        }
        if (i < attempts - 1 && delayMs > 0) await sleep(delayMs);
    }
    throw lastError instanceof Error ? lastError : new Error(describe(lastError));
}

/**
 * Evaluate the builder-identity gate for the currently signed-in session.
 *
 * Never throws: any failure to read the binding collapses to `unverifiable`
 * (fail-closed — the caller blocks, but softly). Always releases the session
 * adapter it opens, on every path (we only need the derived address, never the
 * signer).
 */
export async function checkIdentityGate(
    rawAssetHubClient: PolkadotClient,
    opts: GateOptions = {},
): Promise<IdentityGateResult> {
    const attempts = Math.max(1, opts.attempts ?? 2);
    const delayMs = opts.delayMs ?? 250;

    const handle = await findSession();
    if (!handle) return { status: "not-logged-in" };

    let productH160: `0x${string}`;
    try {
        productH160 = deriveSessionAddresses(handle.session).productH160;
    } catch (err) {
        return { status: "unverifiable", detail: describe(err) };
    } finally {
        // The signer is never used here — release the adapter so its WebSocket
        // doesn't keep the event loop alive (mirrors `drip`/`status`).
        await handle.adapter.destroy().catch(() => {});
    }

    try {
        // Codegen seam — see the IdentitySpine doc comment for why this cast
        // must stay (CI typechecks without the gitignored .cdm augmentation).
        const spine =
            opts.identity ??
            ((await getReadOnlyIdentityContract(rawAssetHubClient)) as unknown as IdentitySpine);
        const verified = await queryVerified(spine, productH160, attempts, delayMs);
        return verified
            ? { status: "revealed", productH160 }
            : { status: "anonymous", productH160 };
    } catch (err) {
        return { status: "unverifiable", detail: describe(err) };
    }
}
