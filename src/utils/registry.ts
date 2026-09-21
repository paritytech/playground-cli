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
 * Playground registry contract access.
 */

import {
    ContractManager,
    createContractFromClient,
    type AbiEntry,
    type CdmJson,
} from "@parity/product-sdk-contracts";
import { ss58Encode } from "@parity/product-sdk-address";
import { getRegistryAddress } from "@parity/cdm-env";
import type { PolkadotClient } from "polkadot-api";
import { getChainConfig } from "../config.js";
import type { ResolvedSigner } from "./signer.js";
import { getAssetHubDescriptor } from "./descriptors.js";
import { unwrapResult } from "./tx.js";
import {
    PLAYGROUND_IDENTITY_CONTRACT,
    PLAYGROUND_REGISTRY_CONTRACT,
    suppressReviveTraceNoise,
    withoutReviveTraceNoise,
} from "./contractManifest.js";

import cdmJsonRaw from "../../cdm.json";

/**
 * The `cdm.json` import is typed wide by TS (`"latest"` widens to `string`,
 * hex addresses to `string`), which doesn't match the SDK's flat `CdmJson`
 * shape. Assert through `unknown` once here so every call site is typed.
 */
const cdmJson = cdmJsonRaw as unknown as CdmJson;

/**
 * Stable origin used for read-only registry queries (`playground mod` and
 * friends): pallet-revive's own keyless pallet account, mirroring
 * `Pallet::<T>::account_id()` — `PalletId(*b"py/reviv").into_account_truncating()`,
 * i.e. the PalletId `TYPE_ID` (`b"modl"`) + `b"py/reviv"` + 20 trailing zero
 * bytes. This is the same fallback `@parity/product-sdk-contracts` uses when
 * no origin is configured (its `QUERY_FALLBACK_ORIGIN` isn't exported, so we
 * derive the identical bytes here — `5EYCAe5ij…`). We still pass it explicitly
 * as `defaultOrigin` so the SDK's per-query "No origin configured" warning
 * never fires inside the TUI. Revive query nodes accept any SS58 as origin
 * for read-only dry-runs; this one is semantically neutral, not tied to a dev
 * seed, and always exists on chain.
 */
const REVIVE_PALLET_PUBLIC_KEY = new Uint8Array(32);
REVIVE_PALLET_PUBLIC_KEY.set(new TextEncoder().encode("modlpy/reviv"));
const READ_ONLY_QUERY_ORIGIN = ss58Encode(REVIVE_PALLET_PUBLIC_KEY);

/**
 * Build a ContractManager whose contract ADDRESSES are resolved live from the
 * CDM meta-registry — never from the snapshot. ABIs still come from the snapshot.
 * This is the same registry address and `"latest"` dependency the playground-app
 * resolves, so both ends always talk to the same playground-registry contract
 * even when either repo's snapshot is stale.
 *
 * The meta-registry address is env-specific and owned by `@parity/cdm-env`
 * (`getRegistryAddress`), NOT by `cdm.json` (whose `registry` is just whatever
 * `cdm i` baked for one env). We resolve it for the default env — the same env
 * `getConnection()` (the only client this is used with) is bound to — and inject
 * it over the snapshot's value.
 *
 * `fromLiveClient`'s internal `getAddress` dry-runs hit the same Revive path
 * that emits the known `ReviveApi_trace_call` incompatibility noise on Paseo
 * Asset Hub, so the resolution is wrapped in `withoutReviveTraceNoise`.
 */
async function liveManager(
    rawClient: PolkadotClient,
    origin: string,
    signer?: ResolvedSigner,
): Promise<ContractManager> {
    const { env, cdmEnvName } = getChainConfig();
    const metaRegistry = getRegistryAddress(cdmEnvName);
    if (!metaRegistry) {
        throw new Error(
            `Playground registry not available on ${env}: @parity/cdm-env has no registry ` +
                `address for "${cdmEnvName}" yet. Bump @parity/cdm-env to a version that ` +
                `includes it (see CLAUDE.md → "Adding a network / Summit").`,
        );
    }
    const manifest: CdmJson = { ...cdmJson, registry: metaRegistry };
    try {
        // contracts@0.9 returns a `Result` from `fromLiveClient` instead of
        // throwing; `unwrapResult` surfaces the `err` channel as a throw so it
        // lands in the MetaRegistryFailure wrapper below.
        return unwrapResult(
            await withoutReviveTraceNoise(() =>
                ContractManager.fromLiveClient(manifest, rawClient, getAssetHubDescriptor(env), {
                    libraries: [PLAYGROUND_REGISTRY_CONTRACT, PLAYGROUND_IDENTITY_CONTRACT],
                    defaultOrigin: origin,
                    ...(signer ? { defaultSigner: signer.signer } : {}),
                }),
            ),
        );
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
            `MetaRegistryFailure: Could not resolve the live Playground registry contract address from the CDM meta-registry. Refusing to use the cdm.json snapshot because it may be stale. ${msg}`,
            { cause: err instanceof Error ? err : undefined },
        );
    }
}

/**
 * Get a typed handle to the playground registry contract for SIGNED writes
 * (e.g. registry publish transactions). Caller is responsible for providing a
 * funded + mapped user signer.
 */
export async function getRegistryContract(rawClient: PolkadotClient, signer: ResolvedSigner) {
    const manager = await liveManager(rawClient, signer.address, signer);
    return suppressReviveTraceNoise(manager.getContract(PLAYGROUND_REGISTRY_CONTRACT));
}

/**
 * Get a read-only handle to the registry contract. No signer required; reads
 * use `READ_ONLY_QUERY_ORIGIN` as the dry-run origin. Use this from any path
 * that only calls `.query()` methods (e.g. `dot mod` listing moddable apps),
 * so the command doesn't need the user to be logged in / mapped first.
 *
 * Do NOT call `.tx()` on the returned contract — there is no signer wired in,
 * and `defaultOrigin` is the keyless pallet-revive account, so any submission
 * would either crash or be misattributed.
 */
export async function getReadOnlyRegistryContract(rawClient: PolkadotClient) {
    const manager = await liveManager(rawClient, READ_ONLY_QUERY_ORIGIN);
    return suppressReviveTraceNoise(manager.getContract(PLAYGROUND_REGISTRY_CONTRACT));
}

/**
 * Minimal ABI for the personhood-verifier interface: the one read the gate
 * needs. Deliberately not the full open-verifier ABI — any verifier
 * implementation exposes `isVerified`, and narrowing to it keeps this working
 * against implementations that do not exist yet.
 */
const VERIFIER_ABI = [
    {
        inputs: [{ name: "_account", type: "address" }],
        name: "isVerified",
        outputs: [{ name: "", type: "bool" }],
        stateMutability: "view",
        type: "function",
    },
] as const;

/**
 * Read-only handle to whichever verifier the REGISTRY is currently wired to.
 *
 * The registry's `require_revealed()` delegates to `getVerifier()`, so that —
 * not the identity spine — is the authority on whether a publish is allowed.
 * On the current deployment it is the open verifier, whose `is_verified()`
 * returns `true` for every account; on a competition deployment it is the
 * spine, which returns false for an unrevealed caller. Asking the wired
 * verifier is therefore correct in BOTH regimes with no flag to keep in sync.
 *
 * Load-bearing: **ask the verifier a question, never compare its address.**
 * ADR-0011 names three implementations (PoP spine, attendance SBT, open
 * verifier) and an operator picks one per event, so `verifier === <known
 * address>` is correct only until the next one. We resolve the address at
 * runtime and attach the minimal ABI to it via `createContractFromClient`,
 * which works for implementations that are not in our `cdm.json` at all.
 */
export async function getVerifierContract(rawClient: PolkadotClient) {
    const registry = await getReadOnlyRegistryContract(rawClient);
    const res = await (
        registry as unknown as {
            getVerifier: { query(): Promise<{ success: boolean; value?: unknown }> };
        }
    ).getVerifier.query();
    if (!res?.success || typeof res.value !== "string") {
        throw new Error(
            "Could not read registry.getVerifier() — cannot determine which personhood " +
                "verifier gates publishing on this deployment.",
        );
    }
    return suppressReviveTraceNoise(
        createContractFromClient(
            rawClient,
            getAssetHubDescriptor(getChainConfig().env),
            res.value as `0x${string}`,
            VERIFIER_ABI as unknown as AbiEntry[],
            { defaultOrigin: READ_ONLY_QUERY_ORIGIN },
        ),
    );
}

/**
 * Read-only handle to the playground IDENTITY contract (the personhood spine).
 *
 * ⚠️ CURRENTLY UNUSED, and deliberately so. The builder gate used to read
 * `getRootAccount` here; it now asks `getVerifierContract()` instead, because
 * the registry consults the verifier it was wired with and the spine is only
 * one possible implementation. Kept because the spine is a real contract we
 * will need for a reveal / "become a builder" path — but do NOT reintroduce it
 * as a gate: that is the bug this replaced.
 *
 * Identity moved out of the registry in registry #525 — `getRootAccount` is no
 * longer a registry method, so the builder-identity gate must read it here or
 * the call reverts on-chain. Same read-only contract as
 * `getReadOnlyRegistryContract`: no signer, `READ_ONLY_QUERY_ORIGIN` as the
 * dry-run origin, `.query()` only.
 */
export async function getReadOnlyIdentityContract(rawClient: PolkadotClient) {
    const manager = await liveManager(rawClient, READ_ONLY_QUERY_ORIGIN);
    return suppressReviveTraceNoise(manager.getContract(PLAYGROUND_IDENTITY_CONTRACT));
}
