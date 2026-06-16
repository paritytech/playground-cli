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
 * QR login flow — pure business logic, no UI.
 *
 * Flow:
 *   1. `connect()` — starts adapter + auth, returns existing address OR QR code
 *   2. Print QR code to stdout (if needed) — before Ink mounts
 *   3. `waitForLogin()` — awaits the already-running auth to complete
 *   4. `getSessionSigner()` — gets a working signer for tx signing (separate adapter)
 *   5. `findSession()` / `waitForLogout()` — sign out flow, mirror image of connect/waitForLogin
 */

import type { Dirent } from "node:fs";
import { readdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { deriveH160, ss58Encode } from "@parity/product-sdk-address";
import {
    createTerminalAdapter,
    waitForSessions,
    renderQrCode,
    type TerminalAdapter,
    type PairingStatus,
    type UserSession,
} from "@parity/product-sdk-terminal";
import type { PolkadotSigner } from "polkadot-api";
import pkg from "../../package.json" with { type: "json" };
import {
    DAPP_ID,
    PLAYGROUND_PRODUCT_ID,
    TERMINAL_HOST_METADATA,
    getChainConfig,
} from "../config.js";
import { recordLoginStamp } from "./loginStamp.js";
import { resetDeviceIdentityForFreshPairing } from "./sessionReset.js";
import {
    createPlaygroundSessionSigner,
    derivePlaygroundProductPublicKey,
    sessionRootPublicKey,
} from "./sessionSigner.js";

/** How long we wait for the statement store to publish the pairing QR. */
const QR_TIMEOUT_MS = 60_000;

/**
 * The three addresses we surface from a paired session.
 *
 * - `rootAddress` — SS58 of `session.rootAccountId`. This is the
 *   `rootUserAccountId` the mobile app sent over the SSO handshake. On
 *   current mobile builds this is the bare-mnemonic sr25519 root (no
 *   junction). It is NOT the same address the phone shows as "Wallet
 *   account" on its debug screen — that uses the hard-junction
 *   `//wallet` path which the host cannot reproduce from a public key
 *   alone.
 * - `productAddress` — SS58 of the playground product account derived
 *   via `product/playground.dot/0` from `rootAccountId`. This is what
 *   actually signs on-chain transactions from the CLI.
 * - `productH160` — the same product pubkey rendered as a 20-byte EVM
 *   address (for the Revive / contracts view). Derived from the SAME
 *   pubkey as `productAddress`; the two MUST stay in lock-step.
 */
export interface SessionAddresses {
    rootAddress: string;
    productAddress: string;
    productH160: `0x${string}`;
}

function createAdapter(): TerminalAdapter {
    return createTerminalAdapter({
        appId: DAPP_ID,
        endpoints: getChainConfig().peopleEndpoints,
        // Rendered on the phone's Sign-In pair sheet. Travels inline in the
        // V2 pairing proposal (host-papp 0.8+) — the phone only accepts V2
        // offers since its Handshake V2 rewrite, so the @novasamatech 0.7.9
        // pin (V1 QR) had to go.
        hostMetadata: { ...TERMINAL_HOST_METADATA, hostVersion: pkg.version },
    });
}

export const STALE_SESSION_MESSAGE =
    'Stored login session could not be read — it may have been written by a different app version. Run "playground logout" and then "playground login" to pair again.';

/**
 * Classify a `waitForSessions` failure: decode/shape failures (a stored
 * session the current codec can't read) get the stale-session hint;
 * transport-level failures (statement store unreachable) re-throw verbatim.
 * Deliberately matches on message text — host-papp doesn't expose typed
 * decode errors. Exported for tests.
 *
 * @internal
 */
export function isStaleSessionDecodeError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /decode|scale|unexpected|invalid|parse/i.test(msg);
}

/**
 * `waitForSessions` with stale-session translation. Mostly defensive on
 * host-papp 0.8+: its session repository swallows decode failures and returns
 * an empty list (so pre-0.8 session blobs written by older CLIs silently
 * disappear and the user just re-pairs), but a future wire/storage bump may
 * throw again — surface that as an actionable message instead of a raw
 * SCALE/decode error.
 */
async function loadSessions(adapter: TerminalAdapter, timeoutMs?: number): Promise<UserSession[]> {
    try {
        return await waitForSessions(adapter, timeoutMs);
    } catch (err) {
        if (isStaleSessionDecodeError(err)) {
            throw new Error(STALE_SESSION_MESSAGE, {
                cause: err instanceof Error ? err : undefined,
            });
        }
        throw err;
    }
}

/**
 * Pick the session every flow should operate on: the MOST RECENT pairing.
 *
 * The SDK's session repository APPENDS (`ssoSessionRepository.add`), so after
 * a re-pair the persisted list is `[stale, ..., fresh]`. The phone keeps a
 * session map keyed by id and serves whichever sessions it still knows about,
 * but a stale local entry may map to a channel the phone dropped — requests
 * sent on it disappear without an error (the "scanned the QR but nothing
 * shows on the phone" failure). `sessions[0]` selected exactly that stale
 * entry. Callers must use this helper, never index the array directly.
 */
function newestSession(sessions: UserSession[]): UserSession {
    return sessions[sessions.length - 1];
}

function createPlaygroundSigner(session: UserSession): PolkadotSigner {
    return createPlaygroundSessionSigner(session, {
        productId: PLAYGROUND_PRODUCT_ID,
        derivationIndex: 0,
    });
}

/**
 * Compute the three display addresses from a paired session.
 *
 * Shares `derivePlaygroundProductPublicKey` with `createPlaygroundSessionSigner`
 * so the signer used for signing and the display SS58/H160 are computed by
 * exactly one function. Re-running `deriveProductAccountPublicKey` on the
 * SS58 we just produced (the previous `productAccountAddresses` helper did
 * exactly this) silently double-derives and yields a ghost address — that
 * was the bug this refactor exists to prevent.
 *
 * Exported for tests; `IdentityLines` reads addresses off the
 * `ConnectResult` / `LoginStatus` / `SessionHandle` already-resolved
 * triples, never by calling this directly.
 *
 * @internal
 */
export function deriveSessionAddresses(session: UserSession): SessionAddresses {
    const rootBytes = sessionRootPublicKey(session);
    const productPubkey = derivePlaygroundProductPublicKey(rootBytes, {
        productId: PLAYGROUND_PRODUCT_ID,
        derivationIndex: 0,
    });
    return {
        rootAddress: ss58Encode(rootBytes),
        productAddress: ss58Encode(productPubkey),
        productH160: deriveH160(productPubkey),
    };
}

function sessionRemoteAddress(session: UserSession): string | null {
    const raw = (session as { remoteAccount?: { accountId?: Uint8Array } }).remoteAccount
        ?.accountId;
    const accountId = raw ? new Uint8Array(raw) : new Uint8Array();
    return accountId.length === 32 ? ss58Encode(accountId) : null;
}

function sessionLogoutAddress(session: UserSession): string {
    try {
        return deriveSessionAddresses(session).productAddress;
    } catch {
        return sessionRemoteAddress(session) ?? "(stored session)";
    }
}

export type ConnectResult =
    | { kind: "existing"; address: string; addresses: SessionAddresses }
    | { kind: "qr"; qrCode: string; link: string; login: LoginHandle };

export type LoginStatus =
    | { step: "waiting" }
    | { step: "paired" }
    /**
     * Intermediate step the host walks through after pairing — e.g. attestation,
     * session derivation. `stage` is a free-form label from the SDK that we
     * surface to the user verbatim.
     */
    | { step: "pending"; stage: string }
    | { step: "success"; address: string; addresses: SessionAddresses }
    | { step: "error"; message: string };

export interface LoginHandle {
    adapter: TerminalAdapter;
    /** The authenticate() promise — already running since connect(). */
    authPromise: ReturnType<TerminalAdapter["sso"]["authenticate"]>;
}

/**
 * Connect to the statement store and resolve the login state.
 * Returns immediately if an existing session is found (address only).
 * Otherwise kicks off authenticate(), waits for the QR payload,
 * and returns the QR code + a handle to await the auth result.
 */
export async function connect(): Promise<ConnectResult> {
    let adapter = createAdapter();

    let sessions: UserSession[];
    try {
        sessions = await loadSessions(adapter);
    } catch (err) {
        // Probe failed (statement store unreachable, stale session, …) —
        // release the WebSocket before propagating, mirroring the QR-wait
        // catch below.
        adapter.destroy().catch(() => {});
        throw err;
    }

    if (sessions.length > 0) {
        const addresses = deriveSessionAddresses(newestSession(sessions));
        // The "existing" result carries plain address data only — the
        // adapter is not part of it, so this is the last place that can
        // release it. Leaking it keeps a statement-store WebSocket +
        // subscriptions alive for the rest of the process: the event
        // loop never drains, and the leaked subscription machinery is
        // the kind that can enter the polkadot-api microtask-flood
        // state (see process-guard.ts) and grow the process unbounded.
        // Same fire-and-forget + `.catch()` rationale as
        // `getSessionSigner()`'s no-session path below.
        adapter.destroy().catch(() => {});
        // `address` is kept for back-compat with callers that only need
        // the product-account SS58 (signer flows). UI consumers should
        // read the richer `addresses` field instead.
        return { kind: "existing", address: addresses.productAddress, addresses };
    }

    // No existing session — we are about to do a fresh QR pairing. Rotate the
    // host device identity FIRST so the new session lands on a pristine
    // statement-store topic. Re-pairing otherwise reuses the same topic (the
    // phone reuses its account; the host account comes from the persisted
    // DeviceIdentity), and a stale phone-sent `Disconnected` statement there —
    // 7-day TTL — is replayed by `createSession.init()` and silently tears the
    // freshly paired session back out of `SsoSessionsV3`, which is exactly the
    // "login succeeds but `deploy` says No signer available" failure. See
    // `sessionReset.ts` for the full mechanism. We destroy the probe adapter
    // (it loaded the OLD identity) before deleting the identity, then build a
    // fresh adapter that loads/creates a brand-new one.
    adapter.destroy().catch(() => {});
    await resetDeviceIdentityForFreshPairing();
    adapter = createAdapter();

    // Start authenticate — this triggers the pairing flow and QR emission
    const authPromise = adapter.sso.authenticate();

    // Wait for the QR payload (with timeout)
    try {
        const { qrCode, link } = await Promise.race([
            new Promise<{ qrCode: string; link: string }>((resolve) => {
                let done = false;
                let unsub: (() => void) | undefined;
                unsub = adapter.sso.pairingStatus.subscribe(async (status: PairingStatus) => {
                    if (status.step === "pairing" && !done) {
                        done = true;
                        unsub?.();
                        // `status.payload` is the pairing deeplink
                        // (polkadotapp://pair?handshake=…); expose it raw so the
                        // command layer can offer a scan-free, single-device login.
                        resolve({ qrCode: await renderQrCode(status.payload), link: status.payload });
                    }
                });
            }),
            new Promise<never>((_, reject) =>
                setTimeout(
                    () =>
                        reject(
                            new Error(
                                `Login service did not respond within ${Math.round(
                                    QR_TIMEOUT_MS / 1000,
                                )}s — try again`,
                            ),
                        ),
                    QR_TIMEOUT_MS,
                ),
            ),
        ]);

        return { kind: "qr", qrCode, link, login: { adapter, authPromise } };
    } catch (err) {
        // Release the WebSocket so we don't leak on the error path. SDK's
        // destroy() returns Promise<void>; `.catch()` swallows the
        // `DestroyedError: Client destroyed` rejection that polkadot-api's
        // raw-client surfaces when a pending chainHead unsubscribe races the
        // WS close. Bun's compiled binaries print unhandled rejections
        // regardless of `process.on('unhandledRejection')`, so we silence at
        // the source.
        adapter.destroy().catch(() => {});
        throw err;
    }
}

/**
 * Wait for the already-running login to complete.
 * Call this after the QR code is displayed. Reports status via callback.
 * Returns the SS58 address on success, or null on failure.
 */
export async function waitForLogin(
    { adapter, authPromise }: LoginHandle,
    onStatus: (status: LoginStatus) => void,
): Promise<string | null> {
    onStatus({ step: "waiting" });

    // host-papp 0.7.9 collapsed the separate `pairingStatus` + `attestationStatus`
    // streams into a single `pairingStatus` with a `pending` step that carries a
    // free-form `stage` string for whatever the host is doing next (attestation,
    // derivation, etc.). We forward `pending` to the UI as `LoginStatus.pending`
    // so the spinner can swap from "scan QR" to a stage-specific message.
    const unsubPairing = adapter.sso.pairingStatus.subscribe((status: PairingStatus) => {
        if (status.step === "finished") {
            onStatus({ step: "paired" });
        } else if (status.step === "pending") {
            onStatus({ step: "pending", stage: status.stage });
        } else if (status.step === "pairingError") {
            onStatus({ step: "error", message: status.message });
        }
    });

    let authenticated = false;
    let address: string | null = null;
    try {
        const result = await authPromise;
        result.match(
            (session) => {
                if (session) {
                    authenticated = true;
                }
            },
            (error) => {
                onStatus({ step: "error", message: error.message });
            },
        );
        if (authenticated) {
            const sessions = await loadSessions(adapter, 3000);
            if (sessions.length > 0) {
                const addresses = deriveSessionAddresses(newestSession(sessions));
                address = addresses.productAddress;
                // Do NOT prune older sessions here by calling
                // `adapter.sessions.disconnect`. It submits a `Disconnected`
                // statement on the (shared) session topic, adding to exactly the
                // kind of stale-Disconnected litter that poisons re-pairing for
                // 7 days (see `sessionReset.ts`). Pruning is also unnecessary:
                // fresh pairings rotate onto a clean topic with a single session,
                // and `newestSession()` already guarantees correct selection, so
                // any residual entries are inert. They're cleared by
                // `playground logout` (clearLocalAppStorage). Regression coverage
                // in src/utils/auth.connect.test.ts.
                // Best-effort, never throws: powers the stale-session warning
                // in deploy's preflight (the SSS allowance has no on-chain
                // query, so "when did we last pair" is the only signal).
                void recordLoginStamp();
                onStatus({ step: "success", address, addresses });
            } else {
                onStatus({
                    step: "error",
                    message: "Login succeeded but the local session was not available",
                });
            }
        }
    } finally {
        // Always clear subscription, even if authPromise rejects.
        unsubPairing();
    }

    return address;
}

/**
 * A session signer bundle — the signer plus an explicit `destroy()` that
 * tears down the long-lived adapter the signer depends on. Callers MUST
 * invoke `destroy()` once they're done (typically inside a `useEffect`
 * cleanup or `try/finally`) — the WebSocket keeps the event loop alive.
 *
 * `userSession` is the raw `UserSession` from product-sdk-terminal. We retain
 * it so callers that need the host-channel API (e.g. RFC-0010 resource
 * allocation via `session.requestResourceAllocation(...)`) can use it without
 * re-running `waitForSessions`. Don't call `userSession.dispose()` directly —
 * always go through the handle's `destroy()` so the adapter teardown happens
 * in the right order.
 */
export interface SessionHandle {
    /**
     * Product-account SS58. Kept as a top-level field for back-compat with
     * `signer.ts::resolveSigner` and its downstream consumers
     * (`ResolvedSigner.address` ends up here). Equal to
     * `addresses.productAddress`. UI code should prefer `addresses`.
     */
    address: string;
    addresses: SessionAddresses;
    signer: PolkadotSigner;
    userSession: UserSession;
    /**
     * The live terminal adapter that owns the session. RFC-0010 host calls
     * (`requestResourceAllocation`, `ensureSlotAccountSigner`, ...) from
     * `@parity/product-sdk-terminal/host` take `(session, adapter)` — the
     * adapter carries the appId + storage dir for the SDK's allowance cache.
     * Owned by this handle: do NOT call `adapter.destroy()` directly, go
     * through `destroy()`.
     */
    adapter: TerminalAdapter;
    destroy(): void;
}

/**
 * Get a working signer from a persisted session.
 *
 * The returned handle owns a terminal adapter that stays alive for as long
 * as the signer is in use (signing goes through the adapter's WebSocket).
 * Call `destroy()` on the handle when you're done — otherwise the event
 * loop will not exit on its own and you'll have to `process.exit()`.
 *
 * Returns null if no session exists (user hasn't logged in).
 */
export async function getSessionSigner(): Promise<SessionHandle | null> {
    const adapter = createAdapter();

    const sessions = await loadSessions(adapter, 3000);
    if (sessions.length === 0) {
        // SDK destroy() is async and fire-and-forget is fine here because we
        // have nothing else to await — pending statement-subscription
        // unsubscribes are drained inside the SDK before the lazy client tears
        // down. We attach `.catch()` to swallow post-destroy
        // `DestroyedError: Client destroyed` rejections from polkadot-api's
        // raw-client (the chainHead unfollow racing the WS close); Bun's
        // runtime prints unhandled rejections REGARDLESS of
        // `process.on('unhandledRejection')` handlers in compiled SEA
        // binaries, so the `isBenignUnsubscriptionError` filter in
        // `process-guard.ts` doesn't help — the only way to silence them is
        // to handle the rejection at the source.
        adapter.destroy().catch(() => {});
        return null;
    }

    const session = newestSession(sessions);
    const signer = createPlaygroundSigner(session);
    const addresses = deriveSessionAddresses(session);

    let destroyed = false;
    const destroy = () => {
        if (destroyed) return;
        destroyed = true;
        // Fire-and-forget. SDK destroy() is async but the SessionHandle
        // contract returns void; the pending-unsubscribe drain happens inside
        // the SDK regardless of whether we await. The `.catch()` swallows
        // post-destroy `DestroyedError: Client destroyed` artifacts from
        // polkadot-api's raw-client — Bun's compiled binaries print
        // unhandled rejections regardless of `process.on('unhandledRejection')`
        // handlers, so the only effective silence is at the rejection source.
        adapter.destroy().catch(() => {});
    };

    return {
        address: addresses.productAddress,
        addresses,
        signer,
        userSession: session,
        adapter,
        destroy,
    };
}

// ── Sign-out flow ─────────────────────────────────────────────────────────────
//
// Mirror image of connect() + waitForLogin(). `findSession()` does the I/O to
// decide if there's anything to sign out of; `waitForLogout()` performs the
// disconnect and takes ownership of the adapter's `destroy()`.

export type LogoutStatus =
    | { step: "disconnecting"; address: string }
    | { step: "success"; address: string }
    | { step: "partial"; address: string; reason: string }
    | { step: "error"; message: string };

export interface LogoutHandle {
    adapter: TerminalAdapter;
    address: string;
    session: UserSession;
}

/**
 * Look up the currently paired session, if any.
 *
 * Returns a handle ready for `waitForLogout()`, or `null` when no session is
 * signed in. On the null path the adapter is destroyed here so callers don't
 * have to care.
 */
export async function findSession(): Promise<LogoutHandle | null> {
    const adapter = createAdapter();
    const sessions = await loadSessions(adapter, 3000);
    if (sessions.length === 0) {
        // Awaiting the async destroy() lets the SDK drain its pending
        // statement-subscription unsubscribes before we return null. Wrapped
        // in try/catch (mirroring `waitForLogout`'s teardown) so a hypothetical
        // post-destroy artifact doesn't bubble up to `lookupSession` and
        // misreport "no account is signed in" as "Could not reach the login
        // service".
        try {
            await adapter.destroy();
        } catch {
            // best-effort
        }
        return null;
    }
    const session = newestSession(sessions);
    const address = sessionLogoutAddress(session);
    return { adapter, address, session };
}

/**
 * Disconnect the given session. Reports progress via callback.
 *
 * Happy path: `adapter.sessions.disconnect()` sends a `Disconnected` statement
 * so the paired mobile app drops its side of the connection, then we run
 * `clearLocalAppStorage()` to unlink the `${DAPP_ID}_*` files. The SDK's
 * `disconnect()` itself only filters the session out of the in-memory list
 * and writes the (possibly-empty) list back to disk — without the explicit
 * cleanup the SsoSessions file would linger as `[]`.
 *
 * If the remote notification fails (statement store unreachable, WebSocket
 * torn down, …) we still run `clearLocalAppStorage()` — strictly narrower
 * than `rm -rf ~/.polkadot-apps` and keeps the user unblocked. The mobile
 * app will show a stale pairing until it reconnects, which we surface via
 * `partial`.
 *
 * Always releases the adapter before returning.
 */
export async function waitForLogout(
    handle: LogoutHandle,
    onStatus: (status: LogoutStatus) => void,
): Promise<void> {
    const { adapter, address, session } = handle;

    // Everything that can throw — including the consumer's onStatus — lives
    // inside this try so the finally is guaranteed to run and release the
    // WebSocket. Losing the destroy() would turn the CLI into a zombie.
    try {
        onStatus({ step: "disconnecting", address });
        const result = await adapter.sessions.disconnect(session);
        if (result.isOk()) {
            // Run the local cleanup pass on success too. The SDK's
            // `disconnect()` filters the session out of `ssoSessionRepository`
            // and writes the (now-empty) list back to disk, but it doesn't
            // unlink the file — so `${DAPP_ID}_SsoSessions.json` lingers as
            // `[]` on the filesystem. `clearLocalAppStorage()` removes it
            // outright so `~/.polkadot-apps/` ends up tidy regardless of
            // whether the mobile notification round-tripped.
            await clearLocalAppStorage();
            onStatus({ step: "success", address });
            return;
        }
        const reason = result.error.message || "remote unreachable";
        await clearLocalAppStorage();
        onStatus({ step: "partial", address, reason });
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        try {
            await clearLocalAppStorage();
            onStatus({ step: "partial", address, reason });
        } catch (cleanupErr) {
            const msg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
            onStatus({ step: "error", message: msg });
        }
    } finally {
        // Awaiting destroy() lets the SDK drain its pending
        // statement-subscription unsubscribes before our `dot logout`
        // process exits — which is exactly the path the upstream
        // 0.2.0 fix was made for.
        try {
            await adapter.destroy();
        } catch {
            // best-effort
        }
    }
}

/**
 * Best-effort removal of this app's persisted state under `~/.polkadot-apps/`.
 *
 * Scoped by `${DAPP_ID}_` prefix so files belonging to other polkadot apps
 * sharing the directory (e.g. polkadot-desktop, other CLI tools) are left
 * alone. Errors are swallowed — this is a fallback, not a guarantee.
 *
 * Exported for tests; not part of the public API.
 * @internal
 */
export async function clearLocalAppStorage(
    dir: string = join(homedir(), ".polkadot-apps"),
): Promise<void> {
    // @parity/product-sdk-terminal's node-storage only writes flat `${appId}_${key}.json`
    // files, never subdirectories. Filter by isFile() anyway so a future change
    // up-stack (or an unrelated user stash) can't trip this helper.
    let entries: Dirent[];
    try {
        entries = await readdir(dir, { withFileTypes: true });
    } catch {
        return;
    }
    const prefix = `${DAPP_ID}_`;
    await Promise.all(
        entries
            .filter((entry) => entry.isFile() && entry.name.startsWith(prefix))
            .map((entry) =>
                unlink(join(dir, entry.name)).catch(() => {
                    // best-effort
                }),
            ),
    );
}
