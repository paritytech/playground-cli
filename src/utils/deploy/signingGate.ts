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
 * A per-account mutex that serializes the on-chain signing phases of a deploy.
 *
 * ── Why this exists (the nonce-safety contract) ───────────────────────────────
 *
 * Every on-chain extrinsic in a deploy — polkadot-app-deploy's DotNS
 * register/setContenthash and Bulletin chunk `store()` calls, plus our own
 * registry publish call and metadata `store()` — derives its nonce by reading
 * the account's *current* on-chain next-index at submission time
 * (`system_accountNextIndex` inside polkadot-app-deploy; polkadot-api's
 * `createSubmitAndWatch` for the publish path). None of these accept a
 * caller-supplied incrementing nonce.
 *
 * That is fine for a single deploy, but when several apps deploy concurrently
 * **from the same signer** (e.g. the Arcade's six `.dot` apps all signed by
 * `--signer dev`), two in-flight deploys read the same next-index and submit
 * two extrinsics with the same nonce. The pool accepts one and rejects the
 * other ("nonce too low" / replaced) — the classic shared-signer race.
 *
 * Rather than reimplement polkadot-app-deploy's per-tx nonce logic, we make the
 * race impossible by construction: a `SigningGate` is a FIFO mutex keyed by
 * signer address. Each concurrent deploy still builds and prepares in parallel,
 * but acquires the gate before entering its signing phase(s) and releases it
 * after, so at most one deploy per account is ever submitting extrinsics at a
 * time. While one deploy holds the gate its nonces advance to completion before
 * the next deploy reads the next-index, so every read sees a settled value.
 *
 * Deploys signed by *different* accounts get different gates (or no gate) and
 * run fully in parallel — only same-account submission is serialized.
 *
 * The gate is intentionally tiny and dependency-free: a promise chain. It does
 * NOT throttle builds or Bulletin uploads (the slow parts) — only the signing
 * critical section, which is what the chain forces to be sequential anyway.
 */

export interface SigningGate {
    /**
     * Run `fn` while holding the gate. Acquisitions are granted in FIFO order.
     * The gate is released when `fn` settles, whether it resolves or rejects,
     * so one app's failure never strands the others.
     */
    runExclusive<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * Create a standalone FIFO mutex. Useful directly in tests; production code
 * usually goes through {@link createSigningGateRegistry} so gates are shared
 * per signer address.
 */
export function createSigningGate(): SigningGate {
    // `tail` is the promise that resolves once every previously-queued holder
    // has released the gate. Each acquisition chains onto it.
    let tail: Promise<unknown> = Promise.resolve();

    return {
        runExclusive<T>(fn: () => Promise<T>): Promise<T> {
            // Wait for everyone ahead of us, then run. We deliberately swallow
            // the predecessor's rejection here (`.catch(() => {})`) so a failed
            // deploy releases the gate for the next one instead of poisoning the
            // chain — each caller still sees its own `fn`'s result/throw.
            const result = tail.then(
                () => fn(),
                () => fn(),
            );
            // Advance the tail to the settlement of THIS run (resolve or reject)
            // so the next acquirer waits for us regardless of outcome.
            tail = result.then(
                () => undefined,
                () => undefined,
            );
            return result;
        },
    };
}

/**
 * Hands out one shared {@link SigningGate} per signer address. Deploys with the
 * same on-chain signer share a gate (serialized signing); deploys with distinct
 * signers get distinct gates (parallel signing). A registry is the unit of
 * sharing for a single `deploy-all` invocation.
 */
export interface SigningGateRegistry {
    /** Get (or lazily create) the gate for `signerAddress`. */
    forAddress(signerAddress: string): SigningGate;
}

export function createSigningGateRegistry(): SigningGateRegistry {
    const gates = new Map<string, SigningGate>();
    return {
        forAddress(signerAddress: string): SigningGate {
            let gate = gates.get(signerAddress);
            if (!gate) {
                gate = createSigningGate();
                gates.set(signerAddress, gate);
            }
            return gate;
        },
    };
}
