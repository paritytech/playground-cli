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

import type { PolkadotSigner } from "polkadot-api";
import { ss58Encode } from "@parity/product-sdk-address";
import {
    checkAuthorization,
    type AuthorizationStatus,
    type CloudStorageApi,
} from "@parity/product-sdk-cloud-storage";
import {
    createSlotAccountSigner,
    ensureSlotAccountSigner,
    getCachedAllocation,
    type AllocatableResource,
} from "@parity/product-sdk-terminal/host";
import type { ResolvedSigner } from "../signer.js";

/**
 * Bridge the one nominal type skew between our bulletin chain API and
 * product-sdk's. We build the API from `@parity/product-sdk-descriptors`'
 * `bulletin` descriptor (`TypedApi<Paseo_bulletin>`); product-sdk's
 * `CloudStorageApi` is `@parity/bulletin-sdk`'s `BulletinTypedApi`, generated
 * from a different descriptor instance pinned at a slightly older product-sdk
 * version (the cdm-builder version skew documented in CLAUDE.md). The two are
 * structurally identical at runtime but nominally distinct to `tsc`. Cast
 * through this single seam so the skew lives in one deletable place — drop
 * this helper and inline its callers once the descriptor versions realign.
 *
 * The param is `unknown` on purpose: callers pass mutually-incompatible
 * nominal types (the descriptor `TypedApi<Paseo_bulletin>` from
 * `getConnection()`/`getTypedApi`, and cdm-env's `CdmBulletinApi` from the
 * contract chain client in `commands/contract.ts`). Narrowing the param to one
 * of them would re-couple the bridge to a single descriptor's structural shape
 * — the exact skew this seam exists to absorb — so leave it `unknown`.
 */
export function asCloudStorageApi(api: unknown): CloudStorageApi {
    return api as CloudStorageApi;
}

export const BULLETIN_RESOURCE: AllocatableResource = {
    tag: "BulletInAllowance",
    value: undefined,
};

const LOGIN_HINT = 'Run "playground login" to grant allowances.';

/**
 * Live handle for one in-flight phone approval. Close it exactly once: with
 * `complete()` when the wallet answered, or `fail(message)` when the request
 * threw / was declined.
 */
export interface AllowancePromptHandle {
    complete(): void;
    fail(message: string): void;
}

/**
 * Called right before a step that needs a tap on the phone (the first-use
 * slot grant). RFC-0010 allocation requests travel over the
 * statement store outside any `PolkadotSigner`, so the deploy TUI's signing
 * proxy cannot see them — without this hook the phone shows an approval
 * dialog while the terminal sits silent.
 * `deploy/signingProxy.ts::createApprovalPrompt` builds a compatible
 * implementation backed by the deploy's shared step counter.
 */
export type AllowancePrompt = (label: string) => AllowancePromptHandle;

export interface BulletinAllowanceSignerOptions {
    publishSigner: ResolvedSigner;
    bulletinApi?: CloudStorageApi;
    /** Surfaces "check your phone" UI for allocation requests. Optional: headless callers omit it. */
    onPrompt?: AllowancePrompt;
}

export interface CachedBulletinAllowanceSignerOptions {
    publishSigner: ResolvedSigner;
    bulletinApi?: CloudStorageApi;
}

/**
 * Whether a slot's Bulletin authorization will let `TransactionStorage.store`
 * land, asked directly of the chain via the
 * `BulletinTransactionStorageApi::can_store` runtime API rather than evaluated
 * client-side. The chain's only hard gate is existence + non-expiry: pallet
 * transaction-storage's `check_authorization` rejects a store ONLY when the
 * authorization is missing or expired. The `transactions` / `bytes` extent
 * counters are SOFT limits — they saturate upward on each store and feed a
 * mempool-priority boost, but never cause a rejection (the hard per-account
 * caps apply to `renew`, which this CLI never calls). So remaining quota is
 * irrelevant; we never gate on it and never request an `Increase`.
 *
 * `can_store(account, data_len)` folds existence, expiry and the per-call size
 * bound into one verdict, so we no longer read the chain height or compare
 * `expiration` ourselves. We probe with a single byte: `data_len === 0` is
 * rejected outright, and a 1-byte store passes iff the slot is authorized and
 * unexpired — exactly the gate we want. Mirrors paritytech/bulletin-deploy#693.
 */
interface BulletinRuntimeApi {
    apis: {
        BulletinTransactionStorageApi: {
            can_store(account: string, dataLen: number): Promise<boolean>;
        };
    };
}

/**
 * `CloudStorageApi` is the descriptor-typed Bulletin API; the
 * `BulletinTransactionStorageApi` runtime namespace is present at runtime but
 * outside the nominal `CloudStorageApi` surface (the hand-written
 * `BulletinTypedApi` has no `apis` member), so we reach it through a narrow
 * structural cast — the same skew the `asCloudStorageApi` seam absorbs. Drop it
 * once the SDK surfaces a `canStore` helper.
 */
async function canStore(bulletinApi: CloudStorageApi, address: string): Promise<boolean> {
    return (
        bulletinApi as unknown as BulletinRuntimeApi
    ).apis.BulletinTransactionStorageApi.can_store(address, 1);
}

function unusableAuthorizationError({ address, status }: BulletinSlotAuthorization): Error {
    return new Error(
        status.authorized
            ? `Bulletin allowance for ${address} has expired. Re-run \`playground login\` and approve on your phone.`
            : `Bulletin allowance account ${address} is not authorized on-chain yet. Re-run \`playground login\` and approve on your phone.`,
    );
}

export interface BulletinSlotAuthorization {
    address: string;
    status: AuthorizationStatus;
    usable: boolean;
}

/** On-chain authorization status of a slot signer's account (existence + non-expiry). */
export async function getBulletinSlotAuthorization(
    bulletinApi: CloudStorageApi,
    slotSigner: PolkadotSigner,
): Promise<BulletinSlotAuthorization> {
    const address = ss58Encode(slotSigner.publicKey);
    // `status` is read only for the error-message distinction (expired vs never
    // authorized); the chain's can_store predicate is the source of truth for
    // whether a store will actually land.
    const [status, usable] = await Promise.all([
        checkAuthorization(bulletinApi, address),
        canStore(bulletinApi, address),
    ]);
    return { address, status, usable };
}

/**
 * Authorization status of the CACHED Bulletin slot key, without going over
 * the wire to the phone. Returns null when no slot key is cached yet —
 * callers treat that as "needs a grant". Used by `playground login` to decide
 * whether to skip the approval dialog.
 */
export async function cachedBulletinSlotAuthorization(
    adapter: NonNullable<ResolvedSigner["adapter"]>,
    bulletinApi: CloudStorageApi,
): Promise<BulletinSlotAuthorization | null> {
    const slotSigner = await createSlotAccountSigner(adapter, BULLETIN_RESOURCE);
    if (!slotSigner) return null;
    return getBulletinSlotAuthorization(bulletinApi, slotSigner);
}

function requireSession(publishSigner: ResolvedSigner) {
    const { userSession, adapter } = publishSigner;
    if (!userSession || !adapter) {
        throw new Error(`No Bulletin allowance account available. ${LOGIN_HINT}`);
    }
    return { userSession, adapter };
}

/**
 * Resolve the signer used for Bulletin `TransactionStorage.store` calls
 * (metadata uploads). Slot allocation, key caching and signer construction
 * are all the SDK's (`@parity/product-sdk-terminal/host`); this function
 * verifies the slot's on-chain authorization is present and unexpired.
 *
 * It does NOT gate on remaining tx/byte quota and never requests an
 * `Increase`: the Bulletin `store` extrinsic treats those counters as soft
 * limits, so an authorized, unexpired slot stores fine regardless of how
 * "exhausted" its allowance counters read (see `isAuthorizationActive`).
 * Dropping the quota gate removes the per-deploy "approve an Increase on your
 * phone" friction that quota-exhausted-but-valid slots used to trigger.
 */
export async function getBulletinAllowanceSigner({
    publishSigner,
    bulletinApi,
    onPrompt,
}: BulletinAllowanceSignerOptions): Promise<PolkadotSigner> {
    // Local dev/SURI deploys are the explicit CI escape hatch: the caller
    // supplied a local key and owns making sure it has Bulletin allowance.
    if (publishSigner.source === "dev") return publishSigner.signer;

    const { userSession, adapter } = requireSession(publishSigner);

    // Cache hit → local sr25519 signer; miss → one phone approval. The SDK
    // call owns allocation, caching, and signer construction (terminal 0.3.1+
    // derives the schnorrkel-normalized address for 64-byte phone-issued
    // keys, the one the chain actually granted to). The cache probe mirrors
    // ensureSlotAccountSigner's own hit/miss decision so the prompt fires
    // only when the phone will actually be asked.
    const cachedSlot = await getCachedAllocation(adapter, BULLETIN_RESOURCE);
    const grantPrompt = cachedSlot
        ? null
        : (onPrompt?.("Grant Bulletin storage allowance") ?? null);
    let slotSigner: PolkadotSigner;
    try {
        slotSigner = await ensureSlotAccountSigner(userSession, adapter, BULLETIN_RESOURCE);
        grantPrompt?.complete();
    } catch (err) {
        grantPrompt?.fail(err instanceof Error ? err.message : String(err));
        throw err;
    }
    if (!bulletinApi) return slotSigner;

    // The up-front authorization check is an optimization — fail fast before a
    // long upload — not a hard gate. If the on-chain status can't be READ (a
    // transient WS error on the dedicated client), degrade to proceeding with
    // the slot signer, exactly as when the auth client couldn't be built at
    // all. polkadot-app-deploy reports per-chunk truth if the authorization
    // really is bad. We abort ONLY when we successfully read the status and it
    // is definitively missing/expired — the case "re-run login" actually fixes.
    let authorization: BulletinSlotAuthorization;
    try {
        authorization = await getBulletinSlotAuthorization(bulletinApi, slotSigner);
    } catch {
        return slotSigner;
    }
    if (!authorization.usable) throw unusableAuthorizationError(authorization);

    return slotSigner;
}

/**
 * Resolve the cached Bulletin slot signer without issuing any mobile resource
 * allocation request. Contract deploy uses this path so `playground login`
 * remains the single place that grants allowances.
 */
export async function getCachedBulletinAllowanceSigner({
    publishSigner,
    bulletinApi,
}: CachedBulletinAllowanceSignerOptions): Promise<PolkadotSigner> {
    if (publishSigner.source === "dev") return publishSigner.signer;

    const { adapter } = requireSession(publishSigner);
    const slotSigner = await createSlotAccountSigner(adapter, BULLETIN_RESOURCE);
    if (!slotSigner) {
        throw new Error(`No cached Bulletin allowance account available. ${LOGIN_HINT}`);
    }
    if (!bulletinApi) return slotSigner;

    const authorization = await getBulletinSlotAuthorization(bulletinApi, slotSigner);
    if (authorization.usable) return slotSigner;
    throw unusableAuthorizationError(authorization);
}

export function isInvalidPaymentError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : String(err);
    return /"type"\s*:\s*"Invalid"[\s\S]*"type"\s*:\s*"Payment"/.test(message);
}
