import { describe, expect, it, beforeEach, vi } from "vitest";
import type { ResolvedSigner } from "./signer.js";
import cdmJson from "../../cdm.json";

const { fromClientMock, getContractMock, withRequiredLiveContractAddressesMock } = vi.hoisted(
    () => ({
        fromClientMock: vi.fn(),
        getContractMock: vi.fn(),
        withRequiredLiveContractAddressesMock: vi.fn(),
    }),
);

vi.mock("@polkadot-apps/contracts", () => ({
    ContractManager: {
        fromClient: (...args: unknown[]) => fromClientMock(...args),
    },
}));

vi.mock("./contractManifest.js", () => ({
    PLAYGROUND_REGISTRY_CONTRACT: "@w3s/playground-registry",
    suppressReviveTraceNoise: (contract: unknown) => contract,
    withRequiredLiveContractAddresses: (...args: unknown[]) =>
        withRequiredLiveContractAddressesMock(...args),
}));

import { getRegistryContract } from "./registry.js";

const fakeSigner: ResolvedSigner = {
    signer: {} as any,
    address: "5Fake",
    source: "session",
    destroy: () => {},
};

beforeEach(() => {
    fromClientMock.mockReset();
    getContractMock.mockReset();
    withRequiredLiveContractAddressesMock.mockReset();
    getContractMock.mockReturnValue({ publish: { tx: vi.fn() } });
    fromClientMock.mockResolvedValue({ getContract: getContractMock });
});

describe("getRegistryContract", () => {
    it("builds the manager with a live-patched manifest", async () => {
        const patchedManifest = { ...cdmJson, marker: "patched" };
        withRequiredLiveContractAddressesMock.mockResolvedValue(patchedManifest);
        const rawClient = {} as any;

        await getRegistryContract(rawClient, fakeSigner);

        expect(withRequiredLiveContractAddressesMock).toHaveBeenCalledWith(
            cdmJson,
            rawClient,
            ["@w3s/playground-registry"],
            { defaultOrigin: fakeSigner.address },
        );
        expect(fromClientMock).toHaveBeenCalledWith(patchedManifest, rawClient, {
            defaultSigner: fakeSigner.signer,
            defaultOrigin: fakeSigner.address,
        });
        expect(getContractMock).toHaveBeenCalledWith("@w3s/playground-registry");
    });

    it("throws a clear error when live lookup fails", async () => {
        withRequiredLiveContractAddressesMock.mockRejectedValue(new Error("registry unavailable"));
        const rawClient = {} as any;

        await expect(getRegistryContract(rawClient, fakeSigner)).rejects.toThrow(
            /MetaRegistryFailure/,
        );

        expect(fromClientMock).not.toHaveBeenCalled();
    });
});
