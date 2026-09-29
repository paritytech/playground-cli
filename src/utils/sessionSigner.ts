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
 * Session-backed `PolkadotSigner` for the playground product account.
 *
 * Thin wrapper over `@parity/product-sdk-terminal@0.3.0`'s
 * `createSessionSignerForAccount`, which routes transaction signing through
 * host-papp's `createTransaction` SSO pair: the paired wallet builds and signs
 * the extrinsic itself, so every signed extension the chain declares (AsPgas,
 * AsRingAlias, AuthorizeValueTransfer, whatever comes next) is forwarded
 * verbatim — no PJS bridge, no relaxed-extension allow-list. `signBytes`
 * keeps the `signRaw({ tag: "Bytes" })` anti-phishing envelope for raw
 * user data.
 *
 * The ONE thing we add on top of the SDK: we always pass the derived
 * product-account public key. The SDK's fallback (`session.remoteAccount
 * .accountId`) is the wallet's currently-selected account, which is NOT the
 * product account that signs on-chain — PAPI stamps `publicKey` into the
 * extrinsic and verifies against it, so omitting it breaks every signature
 * whenever the product account isn't the selected account (i.e. always, for
 * this CLI).
 */

import {
    AllowanceExpiredError,
    createSessionSignerForAccount,
    deriveProductPublicKey,
    type ProductAccountRef,
    type UserSession,
} from "@parity/product-sdk-terminal";
import type { PolkadotSigner } from "polkadot-api";

export type { ProductAccountRef };

export const INCOMPLETE_SESSION_MESSAGE =
    'Stored login session is missing the root account public key. Run "playground logout" and then "playground login" to pair again.';

export function sessionRootPublicKey(session: UserSession): Uint8Array {
    const rootAccountId = (session as { rootAccountId?: Uint8Array }).rootAccountId;
    const publicKey = rootAccountId ? new Uint8Array(rootAccountId) : new Uint8Array();
    if (publicKey.length !== 32) {
        throw new Error(INCOMPLETE_SESSION_MESSAGE);
    }
    return publicKey;
}

/**
 * Derive the playground product account public key (RFC-0022).
 *
 * It used to be three SOFT junctions (`product`/`playground.dot`/`0`) off
 * `session.rootAccountId`, computed locally with no network. RFC-0022 makes
 * `//product//{productId}` two HARD junctions, and a public key cannot cross a
 * hard junction — so the parent must be the product SUBTREE key, which only
 * the wallet can produce (`session.getProductSubtree`; consent-free, and the
 * SDK caches it at `{appId}_ProductSubtrees.json`, reaching the phone only on
 * a cold cache).
 *
 * Three consequences worth knowing:
 *   - it takes a SESSION, not a root public key;
 *   - it is ASYNC, and on a cold cache it needs the phone reachable;
 *   - the address differs from the pre-RFC-0022 one, so every product account
 *     moved when this landed (see the migration note in CLAUDE.md).
 *
 * `deriveProductPublicKey` is the SDK's single source of truth for this math,
 * so we delegate rather than re-derive. Cross-host agreement (CLI vs phone) is
 * pinned at the primitive in `sessionSigner.test.ts` against host-rust-core's
 * own vector — never against our own output.
 */
export async function derivePlaygroundProductPublicKey(
    session: UserSession,
    ref: Pick<ProductAccountRef, "productId" | "derivationIndex">,
): Promise<Uint8Array> {
    return deriveProductPublicKey(session, ref);
}

export async function createPlaygroundSessionSigner(
    session: UserSession,
    ref: Pick<ProductAccountRef, "productId" | "derivationIndex">,
): Promise<PolkadotSigner> {
    // `publicKey` omitted on purpose: the SDK fetches the subtree and derives
    // it through the same cached path as the display address, so the signer and
    // what we print cannot desync.
    return wrapSignerWithSssFastFail(await createSessionSignerForAccount(session, ref));
}

export const SESSION_EXPIRED_MESSAGE =
    "Phone session expired: the statement-store allowance lapses ~2-3 days after login " +
    "and cannot be renewed remotely (renewal requests travel over the expired channel). " +
    'Run "playground logout" and then "playground login" to pair again.';

/**
 * Whether an error means the statement-store allowance has lapsed.
 *
 * Name-based as well as `instanceof`, deliberately: a pnpm tree can hold more
 * than one copy of the SDK, and `instanceof` across copies silently returns
 * false. Getting this wrong loses the actionable message, so it fails safe
 * toward recognising the error.
 */
export function isAllowanceExpired(err: unknown): boolean {
    if (err instanceof AllowanceExpiredError) return true;
    if (!(err instanceof Error)) return false;
    return (
        err.name === "AllowanceExpiredError" || err.constructor?.name === "AllowanceExpiredError"
    );
}

/**
 * Fast-fail for expired statement-store (SSS) allowances.
 *
 * Phone signing rides the statement store: `session.createTransaction` /
 * `session.signRaw` submit a statement on the People chain that the phone
 * subscribes to. The SSS allowance is a 1-day renewable resource (plus a
 * grace window, ~2-3 days total after login), and it cannot be renewed
 * remotely, so the only remedy is re-pairing.
 *
 * There are TWO expiry shapes to catch, because the SDK changed:
 *   - since product-sdk-terminal 0.10.0 it REJECTS with
 *     `AllowanceExpiredError`, handled in the catch below;
 *   - before that the statement-store adapter logged `NoAllowanceError` to
 *     `console.error` and did NOT reject — the call hung for the SDK's 180s
 *     queue timeout while the outer watcher gave up at 90s with a misleading
 *     "transaction watcher silent" error, times 3 retries. The console
 *     interception still covers that, and any path that still only logs.
 *
 * This wrapper intercepts `console.error` for the duration of each signing
 * call, detects the NoAllowanceError line, and rejects within ~200ms with an
 * actionable message. Renewal genuinely requires re-pairing: the
 * `requestResourceAllocation` that would extend the allowance itself travels
 * over SSS, and only the QR login flow has a direct WebSocket channel.
 * Mirrors polkadot-app-deploy's vendored `sessionSigner.ts` fast-fail, which does
 * not cover us because we inject our own signer.
 *
 * Re-entrancy: the deploy pipeline (`deploy/storage.ts::interceptConsoleLog`)
 * also swaps `console.error`. We capture whatever `console.error` is at call
 * time and restore exactly that in `finally`, so the interceptions nest.
 * Overlapping signing calls cannot interleave restores in practice —
 * host-papp serializes all session operations through a poolSize-1 queue.
 * A matched line is suppressed (the thrown error IS the user-facing
 * message); everything else is forwarded.
 *
 * On a fast-fail the underlying signing promise is intentionally abandoned
 * (it never settles in this failure mode — that's the bug). If it ever does
 * settle later, Promise.race has both arms handled, so no unhandled
 * rejection escapes; any post-restore NoAllowanceError lines simply land on
 * the regular console.error.
 */
export function wrapSignerWithSssFastFail(signer: PolkadotSigner): PolkadotSigner {
    function wrap<Args extends unknown[], R>(
        fn: (...args: Args) => Promise<R>,
    ): (...args: Args) => Promise<R> {
        return async (...args: Args): Promise<R> => {
            let sawNoAllowance = false;
            const previousError = console.error;
            console.error = (...errArgs: unknown[]) => {
                const line = errArgs.map(String).join(" ");
                if (line.includes("NoAllowanceError") || line.includes("no allowance set")) {
                    sawNoAllowance = true;
                    return; // suppressed — SESSION_EXPIRED_MESSAGE replaces the raw stack
                }
                previousError(...errArgs);
            };

            let poll: ReturnType<typeof setInterval> | null = null;
            try {
                return await Promise.race([
                    fn(...args),
                    new Promise<never>((_, reject) => {
                        poll = setInterval(() => {
                            if (sawNoAllowance) reject(new Error(SESSION_EXPIRED_MESSAGE));
                        }, 200);
                    }),
                ]);
            } catch (err) {
                // Since product-sdk-terminal 0.10.0 the SDK REJECTS with
                // `AllowanceExpiredError` instead of logging `NoAllowanceError`
                // and hanging, so the console interception above never fires on
                // the primary expiry path. Without this branch the user gets a
                // raw SDK error instead of the one message that states the only
                // remedy (logout + login — the renewal request itself would
                // travel over the expired channel).
                //
                // Matched by name as well as `instanceof`: duplicate copies of
                // the package in a pnpm tree make `instanceof` unreliable, and
                // failing open here would lose the remedy.
                if (isAllowanceExpired(err)) {
                    throw new Error(SESSION_EXPIRED_MESSAGE, { cause: err });
                }
                throw err;
            } finally {
                // Both arms are settled or abandoned here: the interval must
                // die (it would otherwise keep the event loop alive — see
                // process-guard), and console.error must be restored to
                // whatever interceptor was active when we started.
                if (poll !== null) clearInterval(poll);
                console.error = previousError;
            }
        };
    }

    return {
        publicKey: signer.publicKey,
        signTx: wrap(signer.signTx.bind(signer)),
        signBytes: wrap(signer.signBytes.bind(signer)),
    };
}
