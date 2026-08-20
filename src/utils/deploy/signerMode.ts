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
 * Resolves *which* signer is used for each on-chain step of a deploy. This
 * is the only module that knows the full matrix; everywhere else receives
 * already-composed objects so a future mainnet profile can swap in without
 * rewriting callers.
 *
 * Today (testnet):
 *   - Dev mode: storage + DotNS go through polkadot-app-deploy's built-in
 *     mnemonic (or `--suri`) — passed EXPLICITLY, never via polkadot-app-deploy's
 *     own fallback chain. Since 0.8.x, `deploy()` called with no mnemonic /
 *     signer / suri resolves the persisted SSO session on disk
 *     (`~/.polkadot-apps/dot-cli_SsoSessions.json`, the same namespace
 *     `playground login` writes) and phone-signs DotNS — so an empty options
 *     object silently turns dev mode into phone mode for any logged-in user.
 *     Likewise, an absent `storageSigner` makes it auto-read the user's
 *     cached BulletInAllowance slot key and burn their phone-granted quota
 *     on chunk uploads. Dev mode therefore pins all three: `mnemonic` for
 *     DotNS, `storageSigner` for chunks, and the dev publish signer below.
 *     Playground publish is ALSO signed by the dev
 *     account — Alice's H160 is recorded as `publisher`, but the contract
 *     accepts an optional `owner` parameter so we can record the user's
 *     H160 as the `owner` (the H160 MyApps queries with). When a phone
 *     session is present we pass `claimedOwnerH160 = session.productH160`
 *     so the user still sees the app in MyApps without ever tapping the
 *     phone. With no session, `claimedOwnerH160 = null` and the contract
 *     falls back to caller (dev account owns the app).
 *   - Phone mode: polkadot-app-deploy uses the user's phone signer for DotNS
 *     (3 taps). Storage uses the BulletInAllowance slot key resolved by
 *     `resolveStorageSignerOptions` — NEVER the phone signer (see that
 *     function's doc for why). Playground publish uses the user's phone
 *     signer (1 more tap). `claimedOwnerH160 = null` — the contract
 *     defaults to caller, which is the user's H160 anyway.
 */

import { DEFAULT_MNEMONIC, type DeployOptions } from "bulletin-deploy";
import { ss58Encode } from "@parity/product-sdk-address";
import type { CloudStorageApi } from "@parity/product-sdk-cloud-storage";
import { seedToAccount } from "@parity/product-sdk-keys";
import { getBulletinAllowanceSigner, type AllowancePrompt } from "../allowances/bulletin.js";
import type { ResolvedSigner } from "../signer.js";
import type { DeployPlan } from "./availability.js";

/**
 * The dev account used for dev-mode publish: `polkadot-app-deploy`'s
 * `DEFAULT_MNEMONIC` bare-root (the same identity polkadot-app-deploy uses
 * internally for storage + DotNS when no explicit signer is provided).
 * All three on-chain phases — storage, DotNS, registry publish — sign as
 * the same account, so `is_authorized_to_republish` accepts dev iteration
 * uniformly and the DotNS name owner equals the registry publisher for
 * dev-mode apps.
 *
 * Derived once at module load to avoid re-running BIP-39 + sr25519 on
 * every `resolveSignerSetup` call.
 *
 * `DEV_PUBLISH_ADDRESS` is exported so callers (e.g. the availability
 * preflight) can pass it as the expected DotNS owner whenever dev mode
 * will fall back to polkadot-app-deploy's default mnemonic.
 *
 * IMPORTANT: do NOT swap to `createDevSigner("Alice")` from
 * `@parity/product-sdk-tx`. That helper uses `//Alice` derivation
 * (`5Grwva...`), which is a DIFFERENT account from polkadot-app-deploy's
 * bare-mnemonic root (`5DfhGyQd...`). The `signerModeAlice.test.ts`
 * snapshot test guards against this regression.
 */
const DEV_PUBLISH_ACCOUNT = seedToAccount(DEFAULT_MNEMONIC, "");
export const DEV_PUBLISH_ADDRESS = ss58Encode(DEV_PUBLISH_ACCOUNT.publicKey);

/**
 * Construct a `ResolvedSigner` for polkadot-app-deploy's `DEFAULT_MNEMONIC`
 * bare-root account. Used by deploy's dev-mode publish flow, and by
 * `dot decentralize`'s interactive dev signer option — both keep
 * storage / DotNS / registry signing coherent under one identity.
 *
 * Despite the historical "Alice" label in the test snapshot, this is NOT
 * Substrate's `//Alice` (`5Grwva...`). It is polkadot-app-deploy's bare-root
 * (`5DfhGyQd...`). See `signerModeAlice.test.ts` for the pin.
 */
export function createDevPublishSigner(): ResolvedSigner {
    return {
        signer: DEV_PUBLISH_ACCOUNT.signer,
        address: DEV_PUBLISH_ADDRESS,
        source: "dev",
        destroy() {},
    };
}

export type SignerMode = "dev" | "phone";

/**
 * The SS58 address that will own and sign a deploy's DotNS name, by mode:
 *   - phone: the user's session account (the caller IS the user)
 *   - dev with an explicit `--suri` signer: that local account
 *   - dev otherwise: polkadot-app-deploy's `DEFAULT_MNEMONIC` bare-root
 *     (`DEV_PUBLISH_ADDRESS`), the identity it falls back to internally.
 *
 * Centralised here so the dev/phone owner rules live in one place. Consumed by
 * the availability preflight (the expected DotNS owner) and by `deploy-all`'s
 * signing-gate key (apps that resolve to the same address share a gate).
 * Returns `undefined` only for phone mode with no resolved session.
 */
export function resolveDotnsOwnerAddress(
    mode: SignerMode,
    userSigner: ResolvedSigner | null,
): string | undefined {
    if (mode === "phone") return userSigner?.address;
    if (userSigner?.source === "dev") return userSigner.address;
    return DEV_PUBLISH_ADDRESS;
}

export interface DeploySignerSetup {
    /**
     * Options to pass to polkadot-app-deploy's `deploy()`. For dev mode this is
     * an EXPLICIT `{ mnemonic: DEFAULT_MNEMONIC }` (or the `--suri` signer) —
     * never `{}`, because polkadot-app-deploy 0.8.x answers empty options by
     * resolving the persisted phone session from `playground login`. For
     * phone mode we inject the user's signer so DotNS registration is paid
     * for by — and recorded against — their account.
     */
    bulletinDeployAuthOptions: Pick<DeployOptions, "signer" | "signerAddress" | "mnemonic">;

    /**
     * Signer used to call the registry publish method for the playground step.
     *
     * - Phone mode: the user's session signer — caller becomes owner.
     * - Dev mode: the dev signer (Alice or `--suri`) — caller becomes
     *   publisher, and `claimedOwnerH160` (when set) becomes owner.
     *
     * `null` means we cannot publish (no signer at all — only valid when
     * `publishToPlayground === false`).
     */
    publishSigner: ResolvedSigner | null;

    /**
     * The H160 to pass as the `owner` argument of the registry publish method.
     * Non-null only in dev mode WITH an active phone session — the dev
     * account signs the tx but the user's H160 is recorded as owner so the
     * app shows in their MyApps view. `null` ⇒ contract defaults to
     * `env::caller()` (the signer's H160), which is correct for phone mode
     * and for pure dev mode (no session).
     */
    claimedOwnerH160: `0x${string}` | null;

    /**
     * Count of phone approvals the user should expect under this setup,
     * broken down by phase. Used to render the summary card.
     */
    approvals: DeployApproval[];
}

export interface DeployApproval {
    phase: "dotns" | "playground";
    label: string;
}

export interface ResolveOptions {
    mode: SignerMode;
    /** The user's phone (or --suri) signer, or null if not logged in. */
    userSigner: ResolvedSigner | null;
    /** Whether `--playground` / the prompt enabled playground publish. */
    publishToPlayground: boolean;
    /**
     * Known DotNS plan from the availability check. Shapes the approvals list
     * to match what polkadot-app-deploy will actually submit (3 DotNS taps for a
     * new register, 1 for an update). Absent = we haven't run the check yet, so
     * assume the most common path (new register). The list drives the pre-deploy summary and
     * the per-tap labels only — the runtime counter shows bare sequential
     * step numbers (no predicted total), so a wrong guess here can't strand
     * the user on "step 4 of 5" with no fifth step.
     */
    plan?: DeployPlan;
}

/**
 * DotNS approvals in the exact order polkadot-app-deploy will fire them. Order
 * matters because `maybeWrapAuthForSigning` in run.ts labels each incoming
 * `signTx` call by its index in this list — the Nth `signTx` is labelled
 * with the Nth entry here, so a mismatch ends up showing "Finalize domain"
 * on the phone when the app is actually asking for commitment.
 */
function dotnsApprovals(plan: DeployPlan | undefined): DeployApproval[] {
    // Default to the most common path when the caller hasn't told us the plan
    // yet. The runtime counter self-corrects if we under-estimate.
    const effective: DeployPlan = plan ?? { action: "register" };

    if (effective.action === "update") {
        // Domain already owned by the signer — polkadot-app-deploy skips register()
        // entirely and jumps straight to setContenthash. One tap.
        return [{ phase: "dotns", label: "Link content (DotNS setContenthash)" }];
    }

    // New register: commitment + finalize + setContenthash. There is NO PoP
    // tap — polkadot-app-deploy reads the signer's tier and fails if insufficient;
    // it never submits a setUserPopStatus tx.
    return [
        { phase: "dotns", label: "Reserve domain (DotNS commitment)" },
        { phase: "dotns", label: "Finalize domain (DotNS register)" },
        { phase: "dotns", label: "Link content (DotNS setContenthash)" },
    ];
}

export function resolveSignerSetup(opts: ResolveOptions): DeploySignerSetup {
    const approvals: DeployApproval[] = [];

    let bulletinDeployAuthOptions: DeploySignerSetup["bulletinDeployAuthOptions"] = {};

    if (opts.mode === "phone") {
        if (!opts.userSigner) {
            throw new Error(
                'Phone signer requested but no session found. Run "playground login" to log in, or pass --signer dev.',
            );
        }
        bulletinDeployAuthOptions = {
            signer: opts.userSigner.signer,
            signerAddress: opts.userSigner.address,
        };
        approvals.push(...dotnsApprovals(opts.plan));
    }

    if (opts.mode === "dev") {
        if (opts.userSigner?.source === "dev") {
            bulletinDeployAuthOptions = {
                signer: opts.userSigner.signer,
                signerAddress: opts.userSigner.address,
            };
        } else {
            // Pass the default mnemonic EXPLICITLY. polkadot-app-deploy 0.8.x
            // treats "no mnemonic, no signer, no suri" as "resolve a signer
            // yourself", and its resolution finds the persisted phone session
            // from `playground login` before any dev fallback — turning a dev
            // deploy into 3-4 phone taps. An explicit mnemonic wins its
            // chooseSignerInput outright, so the session file is never read.
            // The derived identity is unchanged: DEFAULT_MNEMONIC's bare root
            // (DEV_PUBLISH_ADDRESS) is exactly what the old empty-options
            // path used for DotNS.
            bulletinDeployAuthOptions = { mnemonic: DEFAULT_MNEMONIC };
        }
    }

    // Pick the publish signer and the optional claimed-owner H160.
    //
    // Phone mode: publish signer is the session — the contract records the
    // caller as owner, no need to claim. One phone approval.
    //
    // Dev mode: we ALWAYS sign with a dev key, never with the session.
    //   - With `--suri`: that SURI dev signer (its address becomes owner).
    //   - With a session (user did `dot login`): construct Alice and pass
    //     the session's product H160 as `claimedOwnerH160` — the contract
    //     records the user as owner so MyApps resolves their app.
    //   - With neither: construct Alice and leave claimedOwnerH160 null
    //     (Alice owns the entry — pure-dev throwaway).
    // No phone approval is ever added in dev mode.
    let publishSigner: ResolvedSigner | null = null;
    let claimedOwnerH160: `0x${string}` | null = null;
    if (opts.publishToPlayground) {
        if (opts.mode === "phone") {
            publishSigner = opts.userSigner!;
            approvals.push({ phase: "playground", label: "Publish to Playground registry" });
        } else if (opts.userSigner?.source === "dev") {
            // --suri path. The SURI account IS the user.
            publishSigner = opts.userSigner;
        } else {
            // Dev mode with either a session (extract H160 for owner claim)
            // or nothing (Alice owns). Construct Alice fresh either way —
            // polkadot-app-deploy uses the same default mnemonic so all three
            // tx phases sign as the same on-chain identity.
            publishSigner = createDevPublishSigner();
            if (opts.userSigner?.source === "session") {
                claimedOwnerH160 = opts.userSigner.addresses?.productH160 ?? null;
            }
        }
    }

    return { bulletinDeployAuthOptions, publishSigner, claimedOwnerH160, approvals };
}

/**
 * Resolve the signer for Bulletin STORAGE txs (the CAR chunk uploads),
 * threaded to polkadot-app-deploy as `storageSigner` / `storageSignerAddress`.
 * Every mode pins one explicitly: phone+session uses the local
 * BulletInAllowance slot key, `--suri` uses the caller's key, and dev mode
 * uses the dev bare-root — leaving it absent lets polkadot-app-deploy 0.8.x
 * auto-read the user's cached slot key and burn their quota (see below).
 *
 * Why this exists: since polkadot-app-deploy 0.8.x, passing `signer` routes
 * Bulletin storage through that signer too — not just DotNS. Chunk txs carry
 * up to 2 MiB of callData, and the phone session signer forwards the FULL
 * callData over the statement store (`session.createTransaction`), whose
 * request-size cap is 4 KiB on the pinned host-papp 0.7.9 (254 KiB upstream,
 * and the Android app itself caps statements at 256 KiB). A phone-signed
 * chunk therefore fails client-side with "message too big" before the phone
 * is ever contacted. polkadot-app-deploy's `storageSigner` takes precedence over
 * `signer` for storage routing only, so DotNS keeps the phone signer while
 * chunks sign locally. polkadot-app-deploy 0.8.3 can resolve the same slot key
 * itself from the shared `dot-cli` allowance cache, but only as a best-effort
 * side path — when it misses (fresh machine, declined grant) it silently
 * falls back to phone-signing the chunks, so we resolve and pass the key
 * explicitly and fail fast with an actionable message instead.
 *
 * Resolution is delegated to `allowances/bulletin.ts::getBulletinAllowanceSigner`
 * — the single source for slot allocation (cache hit → silent; miss → one
 * phone approval) and the existence + non-expiry authorization check when a
 * `bulletinApi` is provided. Key derivation is the SDK's
 * (`@parity/product-sdk-terminal` 0.3.1+ derives the schnorrkel-normalized
 * address the chain granted to).
 *
 * Pass `bulletinApi` to verify the slot's authorization up front: a missing
 * or expired authorization fails fast with a "re-run login" message instead
 * of the upload dying mid-flight (mid-upload Payment failures do NOT fall back
 * to the pool — only a first-connection failure does). We do NOT gate on the
 * slot's tx/byte allowance counters and never request an `Increase`: the
 * Bulletin `store` extrinsic treats those as soft limits, so an authorized,
 * unexpired slot stores fine regardless of how exhausted they read (confirmed
 * in pallet-transaction-storage's `check_authorization`). Dropping the quota
 * gate removes the per-deploy phone-tap friction it used to cause.
 *
 * Dev and `--suri` deploys pin `storageSigner` to their own local key
 * instead of returning `{}`. polkadot-app-deploy 0.8.x auto-reads the user's
 * cached BulletInAllowance slot key whenever `storageSigner` is absent and
 * signs chunk uploads with it — silently burning the user's small
 * phone-granted quota (~10 txs / 4 MiB per grant) on deploys that were
 * supposed to run entirely on dev accounts. The dev bare-root carries its
 * own Bulletin authorization on paseo-next-v2; if it ever lapses,
 * polkadot-app-deploy's committed-signer wrapper falls back to the shared pool
 * (the pre-0.8 dev storage path) without aborting. A `--suri` key is the
 * caller's responsibility per the CI escape hatch contract — unauthorized
 * keys land on the pool fallback the same way.
 */
export async function resolveStorageSignerOptions(
    mode: SignerMode,
    userSigner: ResolvedSigner | null,
    bulletinApi?: CloudStorageApi,
    onPrompt?: AllowancePrompt,
): Promise<Pick<DeployOptions, "storageSigner" | "storageSignerAddress">> {
    // A --suri key (either mode): the caller supplied a local key and owns
    // its Bulletin allowance. Pin it so the slot-key auto-read never fires.
    if (userSigner?.source === "dev") {
        return { storageSigner: userSigner.signer, storageSignerAddress: userSigner.address };
    }
    // Dev mode without --suri: pin the dev bare-root — the same identity the
    // explicit DEFAULT_MNEMONIC gives DotNS in resolveSignerSetup.
    if (mode !== "phone") {
        return {
            storageSigner: DEV_PUBLISH_ACCOUNT.signer,
            storageSignerAddress: DEV_PUBLISH_ADDRESS,
        };
    }
    if (userSigner?.source !== "session") return {};

    // Existence + non-expiry check only (no quota gate, no Increase). A
    // genuinely missing/expired authorization — or a declined first-use grant
    // — aborts here; without the slot key polkadot-app-deploy would route the
    // 2 MiB chunks to the phone and every one would die with "message too
    // big". Wrap any failure into a single actionable fix-it message.
    try {
        const storageSigner = await getBulletinAllowanceSigner({
            publishSigner: userSigner,
            bulletinApi,
            onPrompt,
        });
        return { storageSigner, storageSignerAddress: ss58Encode(storageSigner.publicKey) };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
            `Could not resolve the Bulletin storage key for this session (${message}). ` +
                "Storage uploads are too large to sign on the phone, so deploy cannot continue. " +
                'Re-run "playground login" and approve the Bulletin allowance on your phone.',
        );
    }
}
