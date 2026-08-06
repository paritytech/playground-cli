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

import { describe, expect, it, beforeEach, vi } from "vitest";
import { getRegistryAddress } from "@parity/cdm-env";
import type { ResolvedSigner } from "./signer.js";
import { getChainConfig } from "../config.js";
import cdmJson from "../../cdm.json";

const { fromLiveClientMock, getContractMock } = vi.hoisted(() => ({
    fromLiveClientMock: vi.fn(),
    getContractMock: vi.fn(),
}));

vi.mock("@parity/product-sdk-contracts", () => ({
    ContractManager: {
        fromLiveClient: (...args: unknown[]) => fromLiveClientMock(...args),
    },
}));

vi.mock("@parity/product-sdk-descriptors/paseo-asset-hub", () => ({
    paseo_asset_hub: { genesis: "0xasset" },
}));

vi.mock("./contractManifest.js", () => ({
    PLAYGROUND_REGISTRY_CONTRACT: "@w3s/playground-registry",
    PLAYGROUND_IDENTITY_CONTRACT: "@w3s/playground-identity",
    suppressReviveTraceNoise: (contract: unknown) => contract,
    // Pass-through wrapper so the live resolution runs unchanged in tests.
    withoutReviveTraceNoise: (fn: () => unknown) => fn(),
}));

import {
    getRegistryContract,
    getReadOnlyRegistryContract,
    getReadOnlyIdentityContract,
    getReadOnlyPlaygroundContracts,
    queryMetadataUri,
} from "./registry.js";

// pallet-revive's keyless pallet account ("modlpy/reviv" + 20 zero bytes),
// frozen here so a regression back to Alice (or any other origin) fails loudly.
// Must match @parity/product-sdk-contracts' QUERY_FALLBACK_ORIGIN.
const READ_ONLY_ORIGIN = "5EYCAe5ijiYfhaAUBd6H9WGRTsvwFFc7GnhQkiHvBYxdvpbV";
const cfg = getChainConfig();
const EXPECTED_CDM_REGISTRY = getRegistryAddress(cfg.cdmEnvName);
const EXPECTED_ASSET_DESCRIPTOR = { genesis: "0xasset" };

const fakeSigner: ResolvedSigner = {
    signer: {} as any,
    address: "5Fake",
    source: "session",
    destroy: () => {},
};

beforeEach(() => {
    fromLiveClientMock.mockReset();
    getContractMock.mockReset();
    getContractMock.mockReturnValue({ publish: { tx: vi.fn() } });
    // contracts@0.9 `fromLiveClient` resolves a `Result<ContractManager, …>`.
    fromLiveClientMock.mockResolvedValue({ ok: true, value: { getContract: getContractMock } });
});

describe("getRegistryContract", () => {
    it("resolves the registry live with the signer origin and signer", async () => {
        const rawClient = {} as any;

        await getRegistryContract(rawClient, fakeSigner);

        expect(fromLiveClientMock).toHaveBeenCalledWith(
            { ...cdmJson, registry: EXPECTED_CDM_REGISTRY },
            rawClient,
            EXPECTED_ASSET_DESCRIPTOR,
            {
                libraries: ["@w3s/playground-registry"],
                defaultOrigin: fakeSigner.address,
                defaultSigner: fakeSigner.signer,
            },
        );
        expect(getContractMock).toHaveBeenCalledWith("@w3s/playground-registry");
    });

    it("throws a clear error when live lookup fails", async () => {
        fromLiveClientMock.mockRejectedValue(new Error("registry unavailable"));
        const rawClient = {} as any;

        await expect(getRegistryContract(rawClient, fakeSigner)).rejects.toThrow(
            /MetaRegistryFailure/,
        );
    });
});

describe("getReadOnlyPlaygroundContracts", () => {
    it("resolves registry + identity in ONE live pass with the read-only origin and no signer", async () => {
        const rawClient = {} as any;

        const { registry, identity } = await getReadOnlyPlaygroundContracts(rawClient);

        expect(fromLiveClientMock).toHaveBeenCalledTimes(1);
        expect(fromLiveClientMock).toHaveBeenCalledWith(
            { ...cdmJson, registry: EXPECTED_CDM_REGISTRY },
            rawClient,
            EXPECTED_ASSET_DESCRIPTOR,
            {
                libraries: ["@w3s/playground-registry", "@w3s/playground-identity"],
                defaultOrigin: READ_ONLY_ORIGIN,
            },
        );
        const [, , , options] = fromLiveClientMock.mock.calls[0];
        expect(options).not.toHaveProperty("defaultSigner");
        expect(getContractMock).toHaveBeenCalledWith("@w3s/playground-registry");
        expect(getContractMock).toHaveBeenCalledWith("@w3s/playground-identity");
        expect(registry).toBeDefined();
        expect(identity).toBeDefined();
    });

    it("throws a clear error when live lookup fails", async () => {
        fromLiveClientMock.mockRejectedValue(new Error("registry unavailable"));

        await expect(getReadOnlyPlaygroundContracts({} as any)).rejects.toThrow(
            /MetaRegistryFailure/,
        );
    });
});

describe("single-contract read-only accessors", () => {
    // Registry-only and identity-only paths must not resolve (or couple
    // their failure to) the other library — a spine registration problem in
    // the meta-registry must not take down pure registry reads, and vice
    // versa.
    it("getReadOnlyRegistryContract resolves ONLY the registry library", async () => {
        await getReadOnlyRegistryContract({} as any);

        const [, , , options] = fromLiveClientMock.mock.calls[0];
        expect((options as { libraries: string[] }).libraries).toEqual([
            "@w3s/playground-registry",
        ]);
        expect(getContractMock).toHaveBeenCalledWith("@w3s/playground-registry");
        expect(getContractMock).not.toHaveBeenCalledWith("@w3s/playground-identity");
    });

    it("getReadOnlyIdentityContract resolves ONLY the identity library", async () => {
        await getReadOnlyIdentityContract({} as any);

        const [, , , options] = fromLiveClientMock.mock.calls[0];
        expect((options as { libraries: string[] }).libraries).toEqual([
            "@w3s/playground-identity",
        ]);
        expect(getContractMock).toHaveBeenCalledWith("@w3s/playground-identity");
        expect(getContractMock).not.toHaveBeenCalledWith("@w3s/playground-registry");
    });
});

describe("queryMetadataUri", () => {
    const registryWith = (res: { success: boolean; value?: unknown }) => ({
        getMetadataUri: { query: vi.fn(async () => res) },
    });

    it("returns the CID string when the domain is published", async () => {
        await expect(
            queryMetadataUri(registryWith({ success: true, value: "bafymeta" }), "app.dot"),
        ).resolves.toBe("bafymeta");
    });

    it('maps the ""-tombstone sentinel to null', async () => {
        await expect(
            queryMetadataUri(registryWith({ success: true, value: "" }), "app.dot"),
        ).resolves.toBeNull();
    });

    it("throws a clear error on a rejected dry-run", async () => {
        await expect(
            queryMetadataUri(registryWith({ success: false, value: { err: 1 } }), "app.dot"),
        ).rejects.toThrow(/failed at dry-run/);
    });

    it("throws on a non-string response instead of leaking it (ABI drift guard)", async () => {
        // The old Option shape resurfacing must fail loudly, not flow into a
        // gateway URL as "[object Object]".
        await expect(
            queryMetadataUri(
                registryWith({ success: true, value: { isSome: true, value: "x" } }),
                "app.dot",
            ),
        ).rejects.toThrow(/Unrecognized getMetadataUri response/);
    });
});
