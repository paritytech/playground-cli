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
 * "Revealed" is decided exactly as the playground-app decides it
 * (`hasRevealedIdentity`): `playground-identity.getRootAccount(productH160)`
 * returns a NON-zero bytes32. The contract `unwrap_or`s a missing binding to 32
 * zero bytes and never reverts, so the zero sentinel IS the "anonymous" answer.
 *
 * This module is pure logic (no React/Ink). The session's product H160 is
 * derived signer-free from the persisted login (`findSession` ->
 * `deriveSessionAddresses`), and the read uses the keyless revive origin
 * (`getReadOnlyIdentityContract`), so evaluating the gate needs neither a phone
 * tap nor a mapped/funded account.
 */

import type { PolkadotClient } from "polkadot-api";
import { ss58ToH160 } from "@parity/product-sdk-address";
import { findSession, deriveSessionAddresses } from "../auth.js";
import { resolveSigner } from "../signer.js";
import { DEV_PUBLISH_ADDRESS } from "../deploy/signerMode.js";
import { getVerifierContract } from "../registry.js";

export type IdentityGateResult =
    | { status: "revealed"; productH160: `0x${string}` }
    | { status: "not-logged-in" }
    | { status: "anonymous"; productH160: `0x${string}` }
    | { status: "unverifiable"; detail: string };

/** Blocked outcomes — everything except `revealed`. */
export type BlockedIdentityStatus = "not-logged-in" | "anonymous" | "unverifiable";

interface VerifiedQueryResult {
    success: boolean;
    /** `true` when the wired verifier accepts this account. */
    value?: unknown;
}

/**
 * Minimal structural view of the VERIFIER handle. `getVerifierContract`
 * returns a runtime Proxy (via `suppressReviveTraceNoise`) whose full typing we
 * don't want to depend on here; we narrow to the one read method we call.
 *
 * ⚠️ This narrowing is a cast, so `tsc` CANNOT tell you when the underlying
 * contract stops having the method. Identity moved off the registry in registry
 * #525, and the gate then asked the spine rather than the verifier the registry
 * consults — blocking publishes the chain would have accepted. Whatever this is
 * pointed at, it must be the contract `registry.getVerifier()` names.
 */
export interface PersonhoodVerifier {
    isVerified: { query(account: `0x${string}`): Promise<VerifiedQueryResult> };
}

/**
 * The signer a command was explicitly told to act as. The registry decides
 * `require_revealed` on `env::caller()` — the account that actually publishes —
 * so when the caller picked a local key the gate must ask about THAT key, not
 * about whatever phone session happens to be logged in (there may be none).
 */
export interface ActingAs {
    suri?: string;
    signer?: "dev" | "phone";
}

/**
 * H160 of the explicitly chosen local signer, or `undefined` when the command
 * acts as the logged-in phone user (the default) and the session decides.
 */
export async function resolveActingH160(acting?: ActingAs): Promise<`0x${string}` | undefined> {
    if (!acting) return undefined;
    if (acting.suri) {
        const resolved = await resolveSigner({ suri: acting.suri });
        try {
            return ss58ToH160(resolved.address) as `0x${string}`;
        } finally {
            resolved.destroy();
        }
    }
    if (acting.signer === "dev") return ss58ToH160(DEV_PUBLISH_ADDRESS) as `0x${string}`;
    return undefined;
}

interface GateOptions {
    /** Check this account instead of the phone session's (see {@link ActingAs}). */
    account?: `0x${string}`;
    /** Dry-run retry budget. Defaults to 2 (a transient RPC blip shouldn't lock out a builder). */
    attempts?: number;
    /** Delay between retries in ms. Defaults to 250. */
    delayMs?: number;
}

/**
 * ⚠️ There is deliberately NO option to inject a pre-resolved contract here.
 *
 * There used to be one, so a caller holding a registry handle could skip a
 * second meta-registry resolution. It cannot work any more: the gate must read
 * `registry.getVerifier()` and then query a DIFFERENT contract, so no handle a
 * caller already has is the right one. `mod` passed its registry anyway — the
 * narrowing is a cast, so `tsc` saw nothing — and the gate collapsed to
 * "unverifiable", telling users their builder status couldn't be checked on a
 * perfectly healthy chain. Resolving internally makes that unrepresentable.
 * Tests mock `getVerifierContract` instead.
 */

function describe(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function queryVerified(
    verifier: PersonhoodVerifier,
    account: `0x${string}`,
    attempts: number,
    delayMs: number,
): Promise<unknown> {
    let lastError: unknown;
    for (let i = 0; i < attempts; i++) {
        try {
            const res = await verifier.isVerified.query(account);
            if (res.success) return res.value;
            lastError = new Error("verifier.isVerified dry-run was rejected (success=false)");
        } catch (err) {
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

    let productH160: `0x${string}`;
    if (opts.account) {
        productH160 = opts.account;
    } else {
        const handle = await findSession();
        if (!handle) return { status: "not-logged-in" };

        try {
            productH160 = (await deriveSessionAddresses(handle.session)).productH160;
        } catch (err) {
            return { status: "unverifiable", detail: describe(err) };
        } finally {
            // The signer is never used here — release the adapter so its WebSocket
            // doesn't keep the event loop alive (mirrors `drip`/`status`).
            await handle.adapter.destroy().catch(() => {});
        }
    }

    try {
        // Ask the verifier the registry itself consults — NOT the identity
        // spine. `registry::require_revealed()` delegates to whatever
        // `getVerifier()` names, so querying anything else means the CLI can
        // refuse a publish the chain would accept (which it did: the open
        // verifier returns true for everyone while the spine had no binding).
        const verifier = (await getVerifierContract(
            rawAssetHubClient,
        )) as unknown as PersonhoodVerifier;
        const verified = await queryVerified(verifier, productH160, attempts, delayMs);
        return verified === true
            ? { status: "revealed", productH160 }
            : { status: "anonymous", productH160 };
    } catch (err) {
        return { status: "unverifiable", detail: describe(err) };
    }
}
