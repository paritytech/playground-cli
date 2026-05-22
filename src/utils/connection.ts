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

import {
    createClient,
    type ChainDefinition,
    type PolkadotClient,
    type TypedApi,
} from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { paseo_bulletin as bulletin } from "@parity/product-sdk-descriptors/paseo-bulletin";
import { paseo_individuality as individuality } from "@parity/product-sdk-descriptors/paseo-individuality";
import { paseo_asset_hub } from "@parity/product-sdk-descriptors/paseo-asset-hub";
import { getChainConfig } from "../config.js";

type PaseoChains = {
    assetHub: typeof paseo_asset_hub;
    bulletin: typeof bulletin;
    individuality: typeof individuality;
};

export type PaseoClient = {
    [K in keyof PaseoChains]: TypedApi<PaseoChains[K]>;
} & {
    raw: { [K in keyof PaseoChains]: PolkadotClient };
    destroy(): void;
};

/** If the direct PAPI clients don't resolve in this window we treat the attempt as dead. */
const CONNECT_TIMEOUT_MS = 30_000;

let connectionPromise: Promise<PaseoClient> | null = null;
let client: PaseoClient | null = null;

function createRawClient(endpoints: readonly string[]): PolkadotClient {
    return createClient(getWsProvider([...endpoints]));
}

function typedApi<T extends ChainDefinition>(raw: PolkadotClient, descriptor: T): TypedApi<T> {
    return raw.getTypedApi(descriptor);
}

async function connectPaseo(): Promise<PaseoClient> {
    const cfg = getChainConfig();
    const raw = {
        assetHub: createRawClient([cfg.assetHubRpc]),
        bulletin: createRawClient([cfg.bulletinRpc, ...cfg.bulletinRpcFallbacks]),
        individuality: createRawClient(cfg.peopleEndpoints),
    };

    let destroyed = false;
    return {
        assetHub: typedApi(raw.assetHub, paseo_asset_hub),
        bulletin: typedApi(raw.bulletin, bulletin),
        individuality: typedApi(raw.individuality, individuality),
        raw,
        destroy() {
            if (destroyed) return;
            destroyed = true;
            raw.assetHub.destroy();
            raw.bulletin.destroy();
            raw.individuality.destroy();
        },
    };
}

function timeoutAfter(ms: number): Promise<never> {
    return new Promise((_, reject) => {
        // .unref() so the timer doesn't keep the event loop alive after Promise.race
        // resolves with the connection winner. Without it, every short-lived process
        // that touches getConnection() stays open for `ms` after work completes —
        // the CLI's scheduleHardExit() papers over it in production, but the e2e
        // test harness has no such guard and was hanging ~30 s past junit write.
        const t = setTimeout(
            () =>
                reject(new Error(`Timed out connecting to Paseo after ${Math.round(ms / 1000)}s`)),
            ms,
        );
        t.unref();
    });
}

export function getConnection(): Promise<PaseoClient> {
    if (!connectionPromise) {
        connectionPromise = Promise.race([
            connectPaseo().then((c) => {
                client = c;
                return c;
            }),
            timeoutAfter(CONNECT_TIMEOUT_MS),
        ]).catch((err: unknown) => {
            // Reset so the next call can retry instead of replaying the error.
            connectionPromise = null;
            const detail = err instanceof Error ? err.message : String(err);
            throw new Error(
                `Could not connect to Paseo network — check your internet connection (${detail})`,
                { cause: err instanceof Error ? err : undefined },
            );
        });
    }
    return connectionPromise;
}

export function destroyConnection(): void {
    if (client) {
        client.destroy();
        client = null;
    }
    connectionPromise = null;
}
