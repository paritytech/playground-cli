/**
 * Playground registry contract access.
 */

import { ContractManager, type CdmJson } from "@polkadot-apps/contracts";
import type { ResolvedSigner } from "./signer.js";
import {
    PLAYGROUND_REGISTRY_CONTRACT,
    suppressReviveTraceNoise,
    withRequiredLiveContractAddresses,
} from "./contractManifest.js";

import cdmJson from "../../cdm.json";

/**
 * Get a typed handle to the playground registry contract.
 */
export async function getRegistryContract(
    rawClient: Parameters<typeof ContractManager.fromClient>[1],
    signer: ResolvedSigner,
) {
    let manifest: CdmJson;
    try {
        manifest = await withRequiredLiveContractAddresses(
            cdmJson,
            rawClient,
            [PLAYGROUND_REGISTRY_CONTRACT],
            { defaultOrigin: signer.address },
        );
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
            `MetaRegistryFailure: Could not resolve the live Playground registry contract address from the CDM meta-registry. Refusing to use the cdm.json snapshot because it may be stale. ${msg}`,
            { cause: err instanceof Error ? err : undefined },
        );
    }

    const manager = await ContractManager.fromClient(manifest, rawClient, {
        defaultSigner: signer.signer,
        defaultOrigin: signer.address,
    });
    return suppressReviveTraceNoise(manager.getContract(PLAYGROUND_REGISTRY_CONTRACT));
}
