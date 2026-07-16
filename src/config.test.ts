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
 * Divergence guard: our per-env `CONFIGS` duplicate the network endpoints that
 * polkadot-app-deploy owns in `assets/environments.json` (we pass our own
 * `rpc`/`assetHubEndpoints` into `deploy()` while it looks up DotNS contracts by
 * env id). These two copies MUST stay byte-identical or deploys would connect to
 * one chain while contracts resolve on another. This test reads the bundled
 * catalog through polkadot-app-deploy's own public `loadEnvironments` API and
 * asserts every wired env matches — so a polkadot-app-deploy version bump that
 * moves an endpoint, or a typo in a hand-added block, fails CI.
 *
 * Scope: this checks the values WE duplicate (endpoints, network, gateway,
 * autoAccountMapping). It does NOT assert the DotNS contract-address map —
 * polkadot-app-deploy owns and resolves that internally by env id, so as long as
 * our `env` string matches a known upstream env, the contracts come from the same
 * source by construction.
 *
 * It also guards the single-line network switch: the default env's CDM
 * meta-registry address (owned by `@parity/cdm-env`, keyed by `cdmEnvName`) must
 * be non-empty, so nobody can ship a default whose registry isn't deployed yet.
 */

import { afterEach, describe, expect, it } from "vitest";
import { loadEnvironments } from "@parity/polkadot-app-deploy";
import { getRegistryAddress } from "@parity/cdm-env";
import {
    CONFIGS,
    DEFAULT_ENV,
    getActiveEnv,
    getChainConfig,
    getNetworkLabel,
    getPgasAssetId,
    getTokenSymbol,
    type ChainConfig,
    type Env,
} from "./config.js";

const { doc } = await loadEnvironments();

describe("getPgasAssetId", () => {
    it("returns the active PGAS asset id by default", () => {
        expect(getPgasAssetId()).toBe(2_000_000_000);
    });

    it("returns a number for every wired env", () => {
        expect(typeof getPgasAssetId("paseo-next-v2")).toBe("number");
        expect(typeof getPgasAssetId("summit")).toBe("number");
    });
});

describe("getActiveEnv (PLAYGROUND_ENV runtime override)", () => {
    const original = process.env.PLAYGROUND_ENV;
    afterEach(() => {
        if (original === undefined) delete process.env.PLAYGROUND_ENV;
        else process.env.PLAYGROUND_ENV = original;
    });

    it("falls back to DEFAULT_ENV when PLAYGROUND_ENV is unset", () => {
        delete process.env.PLAYGROUND_ENV;
        expect(getActiveEnv()).toBe(DEFAULT_ENV);
    });

    it("uses a wired PLAYGROUND_ENV value", () => {
        process.env.PLAYGROUND_ENV = "summit";
        expect(getActiveEnv()).toBe("summit");
    });

    it("trims surrounding whitespace", () => {
        process.env.PLAYGROUND_ENV = "  summit  ";
        expect(getActiveEnv()).toBe("summit");
    });

    it("falls back to DEFAULT_ENV for an unwired/garbage value", () => {
        process.env.PLAYGROUND_ENV = "not-a-real-env";
        expect(getActiveEnv()).toBe(DEFAULT_ENV);
    });

    it("threads through the no-arg config + display helpers", () => {
        process.env.PLAYGROUND_ENV = "summit";
        expect(getChainConfig().env).toBe("summit");
        expect(getTokenSymbol()).toBe("SUM");
        expect(getNetworkLabel()).toBe("summit");
    });
});

/** First (primary) wss endpoint declared for a chain on an env, or undefined. */
function upstreamEndpoint(chainId: string, envId: string): string | undefined {
    const wss = doc.chains.find((c) => c.id === chainId)?.endpoints?.[envId]?.wss;
    return Array.isArray(wss) ? wss[0] : wss;
}

function upstreamEnv(envId: string) {
    return doc.environments.find((e) => e.id === envId);
}

const wired = Object.entries(CONFIGS) as [Env, ChainConfig][];

describe("config ↔ polkadot-app-deploy environments.json (divergence guard)", () => {
    for (const [envId, cfg] of wired) {
        describe(envId, () => {
            it("asset hub endpoint matches upstream", () => {
                expect(cfg.assetHubRpc).toBe(upstreamEndpoint("asset-hub", envId));
            });

            it("bulletin endpoint matches upstream", () => {
                expect(cfg.bulletinRpc).toBe(upstreamEndpoint("bulletin", envId));
            });

            it("people endpoints match upstream", () => {
                expect(cfg.peopleEndpoints).toEqual([upstreamEndpoint("people", envId)]);
            });

            it("relay endpoint matches upstream", () => {
                expect(cfg.relayRpc).toBe(upstreamEndpoint("relay", envId));
            });

            it("network matches upstream", () => {
                expect(cfg.network).toBe(upstreamEnv(envId)?.network);
            });

            it("autoAccountMapping matches upstream", () => {
                expect(cfg.autoAccountMapping).toBe(
                    upstreamEnv(envId)?.autoAccountMapping ?? false,
                );
            });

            it("bulletin gateway derives from upstream ipfs", () => {
                expect(cfg.bulletinGateway).toBe(`${upstreamEnv(envId)?.ipfs}/ipfs/`);
            });
        });
    }

    it("default env has a non-empty CDM meta-registry address in @parity/cdm-env", () => {
        const cfg = CONFIGS[DEFAULT_ENV];
        expect(cfg).toBeDefined();
        // getRegistryAddress("") / unknown name returns "" — switching the default
        // to an env whose registry isn't deployed yet must fail here, not at runtime.
        expect(getRegistryAddress(cfg!.cdmEnvName)).not.toBe("");
    });
});
