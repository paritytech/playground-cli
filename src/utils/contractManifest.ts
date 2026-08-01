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
 * Playground registry contract identity + Revive trace-noise suppression.
 *
 * Live contract-address resolution now lives natively in
 * `@parity/product-sdk-contracts` (`ContractManager.fromLiveClient`), consumed
 * from `registry.ts`. This module only owns the playground contract NAMEs and the
 * helpers that hide the known `ReviveApi_trace_call` dry-run noise on Paseo
 * Asset Hub.
 */

export const PLAYGROUND_REGISTRY_CONTRACT = "@w3s/playground-registry";

/**
 * The identity spine: a separate global contract the registry delegates its
 * "is this caller a revealed builder?" checks to (via its configured
 * `verifier`). The CLI reads it for the builder-identity gate (`is_verified`
 * only); the reveal itself (`set_identity`) happens in the playground-app
 * "Become a builder" flow, never here.
 */
export const PLAYGROUND_IDENTITY_CONTRACT = "@w3s/playground-identity";

/**
 * The zero H160 — the registry ABI's "none" sentinel for `Address` parameters
 * (no Option SolType): a zero `owner` on publish/publishDev means "record
 * `env::caller()`", and a zero result from owner reads means "unset".
 * Single shared constant so the sentinel can't drift per copy (a 19- or
 * 21-byte typo in a hex literal still satisfies `0x${string}`, so tsc can't
 * catch divergence).
 */
export const ZERO_H160 = "0x0000000000000000000000000000000000000000" as const;

/**
 * H160s the registry contract hardcodes as "known dev signers"
 * (`DEV_SIGNER_H160` / `BUILDER_DEV_SIGNER_H160` in the contract source).
 * ONLY these callers may use `publishDev(...)` — the dev path is authorized
 * by `env::caller()`, not by calldata — and they are the only accounts that
 * can publish without being revealed in the identity spine.
 *
 * These are part of the deployed contract's identity (compiled-in constants,
 * env-independent), which is why they live here next to the contract names
 * rather than in `config.ts`'s per-env tables. If the contract rotates or
 * adds a dev signer, update this set in the same PR that bumps `cdm.json`.
 */
export const KNOWN_DEV_SIGNER_H160S: ReadonlySet<string> = new Set(
    [
        // polkadot-app-deploy DEFAULT_MNEMONIC bare-root — the CLI's dev-mode
        // publish signer (see CLAUDE.md "dev signer" invariant).
        "0x35cdb23ff7fc86e8dccd577ca309bfea9c978d20",
        // playground-app's own builder dev signer.
        "0x41dccbd49b26c50d34355ed86ff0fa9e489d1e01",
        // Lowercased at construction so a future entry pasted as EIP-55
        // checksummed hex (the format explorers copy) can't silently fail the
        // lowercase `.has()` lookup in isKnownDevPublishSigner.
    ].map((h160) => h160.toLowerCase()),
);

const REVIVE_TRACE_CALL_COMPAT_ERROR =
    "Incompatible runtime entry RuntimeCall(ReviveApi_trace_call)";

/**
 * sdk-ink dry-runs Revive contract calls with `ReviveApi.call`, then also tries
 * `ReviveApi.trace_call` to recover emitted events. Paseo Asset Hub currently
 * rejects that trace runtime entry, but the actual dry-run result still works,
 * so sdk-ink catches the trace failure and continues after printing the stack.
 * Registry calls do not need trace-derived events, so hide this known noise.
 */
export async function withoutReviveTraceNoise<T>(fn: () => Promise<T>): Promise<T> {
    const error = console.error;
    console.error = (...args: unknown[]) => {
        if (args.some((arg) => String(arg).includes(REVIVE_TRACE_CALL_COMPAT_ERROR))) return;
        error(...args);
    };
    try {
        return await fn();
    } finally {
        console.error = error;
    }
}

export function suppressReviveTraceNoise<T extends object>(contract: T): T {
    return new Proxy(contract, {
        get(target, prop, receiver) {
            const method = Reflect.get(target, prop, receiver);
            if (method === null || typeof method !== "object") return method;

            return new Proxy(method, {
                get(methodTarget, op, opReceiver) {
                    const value = Reflect.get(methodTarget, op, opReceiver);
                    if (
                        typeof value !== "function" ||
                        (op !== "query" && op !== "tx" && op !== "prepare")
                    ) {
                        return value;
                    }

                    return (...args: unknown[]) =>
                        withoutReviveTraceNoise(() =>
                            Promise.resolve(value.apply(methodTarget, args)),
                        );
                },
            });
        },
    });
}
