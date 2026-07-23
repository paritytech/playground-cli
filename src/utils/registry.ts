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

import { ContractManager, type CdmJson } from "@parity/product-sdk-contracts";
import { ss58Encode } from "@parity/product-sdk-address";
import { getRegistryAddress } from "@parity/cdm-env";
import type { PolkadotClient } from "polkadot-api";
import { getChainConfig } from "../config.js";
import type { ResolvedSigner } from "./signer.js";
import { getAssetHubDescriptor } from "./descriptors.js";
import {
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
        // throwing; surface the `err` channel as a throw so it lands in the
        // MetaRegistryFailure wrapper below.
        const result = await withoutReviveTraceNoise(() =>
            ContractManager.fromLiveClient(manifest, rawClient, getAssetHubDescriptor(env), {
                libraries: [PLAYGROUND_REGISTRY_CONTRACT],
                defaultOrigin: origin,
                ...(signer ? { defaultSigner: signer.signer } : {}),
            }),
        );
        if (!result.ok) throw result.error;
        return result.value;
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
