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
 * from `registry.ts`. This module only owns the registry contract NAME and the
 * helpers that hide the known `ReviveApi_trace_call` dry-run noise on Paseo
 * Asset Hub.
 */

export const PLAYGROUND_REGISTRY_CONTRACT = "@w3s/playground-registry";

/**
 * Identity lives in its OWN contract since the registry split (registry #525).
 * `getRootAccount` — the builder-identity gate's only read — used to be on the
 * registry and is not there any more: calling it on the registry handle now
 * reverts. The split is invisible to `tsc` wherever a call site narrows the
 * handle to a local structural interface, so keep identity reads pointed at
 * this name explicitly.
 */
export const PLAYGROUND_IDENTITY_CONTRACT = "@w3s/playground-identity";

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
