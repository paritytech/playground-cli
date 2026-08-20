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

import { getRegistryAddress } from "@parity/cdm-env";
import type { CdmJson } from "@parity/cdm-builder";
import { DEFAULT_MNEMONIC as PAD_DEFAULT_MNEMONIC } from "bulletin-deploy";
import { describe, expect, it } from "vitest";
import { getChainConfig } from "../config.js";
import {
    assertSupportedCdmJson,
    findForeignOwnedCdmPackages,
    formatCdmPackageOwnershipConflicts,
    installRequestsFromArgs,
    parseContractInstallLibraryArg,
    resolveContractDeployTarget,
    resolveContractInstallTarget,
    resolveContractSignerOptions,
} from "./contract.js";

describe("installRequestsFromArgs", () => {
    it("maps cdm.json dependencies when no libraries are passed", () => {
        expect(
            installRequestsFromArgs(
                [],
                { dependencies: { "@a/b": "latest" }, contracts: {} },
                "/p",
            ),
        ).toEqual([{ library: "@a/b", requestedVersion: "latest" }]);
    });

    it("throws an actionable error naming the location when there is nothing to install", () => {
        expect(() =>
            installRequestsFromArgs([], { dependencies: {}, contracts: {} }, "/proj/cdm.json"),
        ).toThrow(/\/proj\/cdm\.json/);
    });
});

describe("parseContractInstallLibraryArg", () => {
    it("defaults to latest", () => {
        expect(parseContractInstallLibraryArg("@polkadot/reputation")).toEqual({
            library: "@polkadot/reputation",
            requestedVersion: "latest",
        });
    });

    it("parses explicit versions from the last colon", () => {
        expect(parseContractInstallLibraryArg("@polkadot/reputation:3")).toEqual({
            library: "@polkadot/reputation",
            requestedVersion: 3,
        });
    });

    it("treats non-numeric suffixes as part of the package name", () => {
        expect(parseContractInstallLibraryArg("@polkadot/reputation:beta")).toEqual({
            library: "@polkadot/reputation:beta",
            requestedVersion: "latest",
        });
    });
});

describe("resolveContractDeployTarget", () => {
    it("uses the active playground chain by default", () => {
        const cfg = getChainConfig();
        expect(resolveContractDeployTarget({})).toEqual({
            assethubUrl: cfg.assetHubRpc,
            bulletinUrl: cfg.bulletinRpc,
            bulletinUrls: [cfg.bulletinRpc, ...cfg.bulletinRpcFallbacks],
            registryAddress: getRegistryAddress(cfg.cdmEnvName),
        });
    });

    it("accepts explicit endpoint and registry overrides", () => {
        expect(
            resolveContractDeployTarget({
                assethubUrl: "wss://asset.example",
                bulletinUrl: "wss://bulletin.example",
                registryAddress: "0x1111111111111111111111111111111111111111",
            }),
        ).toEqual({
            assethubUrl: "wss://asset.example",
            bulletinUrl: "wss://bulletin.example",
            bulletinUrls: ["wss://bulletin.example"],
            registryAddress: "0x1111111111111111111111111111111111111111",
        });
    });

    it("rejects non-H160 registry addresses", () => {
        expect(() => resolveContractDeployTarget({ registryAddress: "0x1234" })).toThrow(
            "Registry address must be a 20-byte hex address",
        );
    });
});

describe("resolveContractInstallTarget", () => {
    it("uses the active playground chain by default", () => {
        const cfg = getChainConfig();
        expect(resolveContractInstallTarget({})).toEqual({
            assethubUrl: cfg.assetHubRpc,
            ipfsGatewayUrl: cfg.bulletinGateway,
            registryAddress: getRegistryAddress(cfg.cdmEnvName),
            chainName: undefined,
        });
    });

    it("prefers the active playground registry over stale cdm.json by default", () => {
        const cfg = getChainConfig();
        const cdmJson: CdmJson = {
            dependencies: {},
            contracts: {},
            registry: "0x1111111111111111111111111111111111111111",
        };
        expect(resolveContractInstallTarget({}, cdmJson)).toEqual({
            assethubUrl: cfg.assetHubRpc,
            ipfsGatewayUrl: cfg.bulletinGateway,
            registryAddress: getRegistryAddress(cfg.cdmEnvName),
            chainName: undefined,
        });
    });

    it("prefers an explicit --registry-address over cdm.json", () => {
        const cdmJson: CdmJson = {
            dependencies: {},
            contracts: {},
            registry: "0x1111111111111111111111111111111111111111",
        };
        expect(
            resolveContractInstallTarget(
                { registryAddress: "0x2222222222222222222222222222222222222222" },
                cdmJson,
            ).registryAddress,
        ).toBe("0x2222222222222222222222222222222222222222");
    });

    it("accepts explicit endpoint and registry overrides", () => {
        expect(
            resolveContractInstallTarget({
                assethubUrl: "wss://asset.example",
                ipfsGatewayUrl: "https://gateway.example/ipfs/",
                registryAddress: "0x2222222222222222222222222222222222222222",
            }),
        ).toEqual({
            assethubUrl: "wss://asset.example",
            ipfsGatewayUrl: "https://gateway.example/ipfs/",
            registryAddress: "0x2222222222222222222222222222222222222222",
            chainName: undefined,
        });
    });

    it("rejects non-H160 registry addresses", () => {
        expect(() => resolveContractInstallTarget({ registryAddress: "0x1234" })).toThrow(
            "Registry address must be a 20-byte hex address",
        );
    });
});

describe("assertSupportedCdmJson", () => {
    it("accepts the flat cdm.json shape", () => {
        expect(() => assertSupportedCdmJson({ dependencies: {}, contracts: {} })).not.toThrow();
        expect(() =>
            assertSupportedCdmJson({
                dependencies: { "@polkadot/contexts": "latest" },
                contracts: {},
                registry: "0x1111111111111111111111111111111111111111",
            }),
        ).not.toThrow();
    });

    it("rejects a legacy targets-keyed cdm.json with a plain-English error", () => {
        const legacy = {
            targets: { abc123: { "asset-hub": "wss://x", bulletin: "https://y", registry: "0xz" } },
            dependencies: {},
            contracts: {},
        } as unknown as CdmJson;
        expect(() => assertSupportedCdmJson(legacy, "/proj/cdm.json")).toThrow(
            /old multi-target format/,
        );
        expect(() => assertSupportedCdmJson(legacy, "/proj/cdm.json")).toThrow(/\/proj\/cdm\.json/);
    });
});

describe("resolveContractSignerOptions", () => {
    it("preserves the default contract signer behavior", () => {
        expect(resolveContractSignerOptions({})).toEqual({ suri: undefined });
    });

    it("uses the explicit SURI when no signer mode is selected", () => {
        expect(resolveContractSignerOptions({ suri: "//Bob" })).toEqual({ suri: "//Bob" });
    });

    it("uses polkadot-app-deploy's default dev mnemonic by default", () => {
        expect(resolveContractSignerOptions({ signer: "dev" })).toEqual({
            suri: PAD_DEFAULT_MNEMONIC,
        });
    });

    it("honors polkadot-app-deploy mnemonic environment overrides", () => {
        const previousDotnsMnemonic = process.env.DOTNS_MNEMONIC;
        const previousMnemonic = process.env.MNEMONIC;
        try {
            process.env.DOTNS_MNEMONIC = "dotns env mnemonic";
            process.env.MNEMONIC = "plain env mnemonic";
            expect(resolveContractSignerOptions({ signer: "dev" })).toEqual({
                suri: "dotns env mnemonic",
            });

            delete process.env.DOTNS_MNEMONIC;
            expect(resolveContractSignerOptions({ signer: "dev" })).toEqual({
                suri: "plain env mnemonic",
            });
        } finally {
            if (previousDotnsMnemonic === undefined) delete process.env.DOTNS_MNEMONIC;
            else process.env.DOTNS_MNEMONIC = previousDotnsMnemonic;
            if (previousMnemonic === undefined) delete process.env.MNEMONIC;
            else process.env.MNEMONIC = previousMnemonic;
        }
    });

    it("allows a custom local signer in dev mode", () => {
        expect(resolveContractSignerOptions({ signer: "dev", suri: "//Charlie" })).toEqual({
            suri: "//Charlie",
        });
    });

    it("rejects SURI with phone mode to avoid silently using a local signer", () => {
        expect(() => resolveContractSignerOptions({ signer: "phone", suri: "//Alice" })).toThrow(
            "--suri cannot be used with --signer phone",
        );
    });
});

describe("CDM package ownership conflicts", () => {
    const caller = "0x1111111111111111111111111111111111111111" as const;

    it("ignores unregistered packages and packages owned by the caller", () => {
        expect(
            findForeignOwnedCdmPackages(
                [
                    {
                        packageName: "@example/new",
                        versionCount: 0,
                        owner: "0x0000000000000000000000000000000000000000",
                    },
                    {
                        packageName: "@example/mine",
                        versionCount: 1,
                        owner: caller,
                    },
                ],
                caller,
            ),
        ).toEqual([]);
    });

    it("returns packages owned by another account", () => {
        expect(
            findForeignOwnedCdmPackages(
                [
                    {
                        packageName: "@example/theirs",
                        versionCount: 2,
                        owner: "0x2222222222222222222222222222222222222222",
                    },
                ],
                caller,
            ),
        ).toEqual([
            {
                packageName: "@example/theirs",
                owner: "0x2222222222222222222222222222222222222222",
                caller,
            },
        ]);
    });

    it("formats the rename-or-owner-account guidance", () => {
        expect(
            formatCdmPackageOwnershipConflicts([
                {
                    packageName: "@example/theirs",
                    owner: "0x2222222222222222222222222222222222222222",
                    caller,
                },
            ]),
        ).toContain('Update the contract Cargo.toml [package.metadata.cdm] package = "..."');
    });

    it("formats multiple ownership conflicts with one selected signer", () => {
        const message = formatCdmPackageOwnershipConflicts([
            {
                packageName: "@example/one",
                owner: "0x2222222222222222222222222222222222222222",
                caller,
            },
            {
                packageName: "@example/two",
                owner: "0x3333333333333333333333333333333333333333",
                caller,
            },
        ]);

        expect(message).toContain(`selected signer maps to ${caller}`);
        expect(message).toContain(
            "@example/one owned by 0x2222222222222222222222222222222222222222",
        );
        expect(message).toContain(
            "@example/two owned by 0x3333333333333333333333333333333333333333",
        );
        expect(message).toContain(
            'Update each contract Cargo.toml [package.metadata.cdm] package = "..."',
        );
    });
});
