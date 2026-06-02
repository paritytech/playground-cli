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
 *   - Dev mode: storage + DotNS go through bulletin-deploy's built-in
 *     mnemonic (or `--suri`). Playground publish is ALSO signed by the dev
 *     account — Alice's H160 is recorded as `publisher`, but the contract
 *     accepts an optional `owner` parameter so we can record the user's
 *     H160 as the `owner` (the H160 MyApps queries with). When a phone
 *     session is present we pass `claimedOwnerH160 = session.productH160`
 *     so the user still sees the app in MyApps without ever tapping the
 *     phone. With no session, `claimedOwnerH160 = null` and the contract
 *     falls back to caller (dev account owns the app).
 *   - Phone mode: bulletin-deploy uses the user's phone signer for DotNS
 *     (3 taps). Storage always uses the bulletin-deploy pool mnemonic.
 *     Playground publish uses the user's phone signer (1 more tap).
 *     `claimedOwnerH160 = null` — the contract defaults to caller, which
 *     is the user's H160 anyway.
 */

import { DEFAULT_MNEMONIC, type DeployOptions } from "bulletin-deploy";
import type { PolkadotSigner } from "polkadot-api";
import { ss58Encode } from "@parity/product-sdk-address";
import { seedToAccount } from "@parity/product-sdk-keys";
import type { ResolvedSigner } from "../signer.js";
import type { DeployPlan } from "./availability.js";

/**
 * The dev account used for dev-mode publish: `bulletin-deploy`'s
 * `DEFAULT_MNEMONIC` bare-root (the same identity bulletin-deploy uses
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
 * will fall back to bulletin-deploy's default mnemonic.
 *
 * IMPORTANT: do NOT swap to `createDevSigner("Alice")` from
 * `@parity/product-sdk-tx`. That helper uses `//Alice` derivation
 * (`5Grwva...`), which is a DIFFERENT account from bulletin-deploy's
 * bare-mnemonic root (`5DfhGyQd...`). The `signerModeAlice.test.ts`
 * snapshot test guards against this regression.
 */
const DEV_PUBLISH_ACCOUNT = seedToAccount(DEFAULT_MNEMONIC, "");
export const DEV_PUBLISH_ADDRESS = ss58Encode(DEV_PUBLISH_ACCOUNT.publicKey);

/**
 * Construct a `ResolvedSigner` for bulletin-deploy's `DEFAULT_MNEMONIC`
 * bare-root account. Used by deploy's dev-mode publish flow, and by
 * `dot decentralize`'s interactive dev signer option — both keep
 * storage / DotNS / registry signing coherent under one identity.
 *
 * Despite the historical "Alice" label in the test snapshot, this is NOT
 * Substrate's `//Alice` (`5Grwva...`). It is bulletin-deploy's bare-root
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

export interface DeploySignerSetup {
    /**
     * Options to pass to bulletin-deploy's `deploy()`. For dev mode this is
     * empty (bulletin-deploy falls back to its env / DEFAULT_MNEMONIC); for
     * phone mode we inject the user's signer so DotNS registration is paid
     * for by — and recorded against — their account.
     */
    bulletinDeployAuthOptions: Pick<DeployOptions, "signer" | "signerAddress" | "mnemonic"> & {
        /**
         * Slot-account signer for Bulletin storage writes. When present,
         * bulletin-deploy routes chunk uploads through this signer's
         * allowance instead of the pool. Only populated in phone mode when
         * `getBulletinAllowanceSigner` succeeds; pool fallback otherwise.
         *
         * NOTE: `storageSigner` / `storageSignerAddress` are present in
         * `DeployOptions` only from bulletin-deploy v0.8.x onward. The
         * intersection is used here because the npm-published 0.7.x types
         * don't carry these fields yet; the spread in storage.ts passes them
         * through silently to the runtime where they become effective once
         * bulletin-deploy is updated.
         */
        storageSigner?: PolkadotSigner;
        storageSignerAddress?: string;
    };

    /**
     * Signer used to call `registry.publish()` for the playground step.
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
     * The H160 to pass as the `owner` argument of `registry.publish(...)`.
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
     * to match what bulletin-deploy will actually submit. Absent = we haven't
     * run the check yet, so assume the most common path (new register, no
     * PoP upgrade, 3 DotNS taps). The signing counter clamps up at runtime if
     * we under-estimated, so users never see "step 5 of 4" even on this path.
     */
    plan?: DeployPlan;
}

/**
 * DotNS approvals in the exact order bulletin-deploy will fire them. Order
 * matters because `maybeWrapAuthForSigning` in run.ts labels each incoming
 * `signTx` call by its index in this list — the Nth `signTx` is labelled
 * with the Nth entry here, so a mismatch ends up showing "Finalize domain"
 * on the phone when the app is actually asking for commitment.
 */
function dotnsApprovals(plan: DeployPlan | undefined): DeployApproval[] {
    // Default to the most common path when the caller hasn't told us the
    // plan yet. Counter will self-correct if we under-estimated.
    const effective: DeployPlan = plan ?? { action: "register", needsPopUpgrade: false };

    if (effective.action === "update") {
        // Domain already owned by the signer — bulletin-deploy skips
        // `register()` entirely (no commitment, no finalize, no PoP grant)
        // and jumps straight to `setContenthash`. So only one tap.
        return [{ phase: "dotns", label: "Link content (DotNS setContenthash)" }];
    }

    const approvals: DeployApproval[] = [];
    if (effective.needsPopUpgrade) {
        // `register()` submits `setUserPopStatus` first whenever the predicted
        // post-grant status differs from the user's current one. Without this
        // entry the counter previously ran one past total ("step 5 of 4") for
        // any PoP-gated name.
        approvals.push({ phase: "dotns", label: "Grant Proof of Personhood" });
    }
    approvals.push(
        { phase: "dotns", label: "Reserve domain (DotNS commitment)" },
        { phase: "dotns", label: "Finalize domain (DotNS register)" },
        { phase: "dotns", label: "Link content (DotNS setContenthash)" },
    );
    return approvals;
}

export function resolveSignerSetup(opts: ResolveOptions): DeploySignerSetup {
    const approvals: DeployApproval[] = [];

    let bulletinDeployAuthOptions: DeploySignerSetup["bulletinDeployAuthOptions"] = {};

    if (opts.mode === "phone") {
        if (!opts.userSigner) {
            throw new Error(
                'Phone signer requested but no session found. Run "playground init" to log in, or pass --signer dev.',
            );
        }
        bulletinDeployAuthOptions = {
            signer: opts.userSigner.signer,
            signerAddress: opts.userSigner.address,
        };
        approvals.push(...dotnsApprovals(opts.plan));
    }

    if (opts.mode === "dev" && opts.userSigner?.source === "dev") {
        bulletinDeployAuthOptions = {
            signer: opts.userSigner.signer,
            signerAddress: opts.userSigner.address,
        };
    }

    // Pick the publish signer and the optional claimed-owner H160.
    //
    // Phone mode: publish signer is the session — the contract records the
    // caller as owner, no need to claim. One phone approval.
    //
    // Dev mode: we ALWAYS sign with a dev key, never with the session.
    //   - With `--suri`: that SURI dev signer (its address becomes owner).
    //   - With a session (user did `dot init`): construct Alice and pass
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
            // bulletin-deploy uses the same default mnemonic so all three
            // tx phases sign as the same on-chain identity.
            publishSigner = createDevPublishSigner();
            if (opts.userSigner?.source === "session") {
                claimedOwnerH160 = opts.userSigner.addresses?.productH160 ?? null;
            }
        }
    }

    return { bulletinDeployAuthOptions, publishSigner, claimedOwnerH160, approvals };
}
