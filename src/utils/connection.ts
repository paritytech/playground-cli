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
import { getChainConfig, getNetworkLabel } from "../config.js";
import {
    getAssetHubDescriptor,
    getBulletinDescriptor,
    getIndividualityDescriptor,
    type AssetHubDescriptor,
    type BulletinDescriptor,
    type IndividualityDescriptor,
} from "./descriptors.js";

// The public type name remains `PaseoClient` for compatibility with the rest of
// the codebase. Since `@parity/product-sdk-descriptors@0.8.0` dropped the
// non-paseo descriptor subpaths, the descriptor selectors return the paseo
// descriptor for every env (see `descriptors.ts`); direct PAPI reads touch
// common pallets only, so that is safe for the single wired env (paseo-next-v2).

type PaseoChains = {
    assetHub: AssetHubDescriptor;
    bulletin: BulletinDescriptor;
    individuality: IndividualityDescriptor;
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
    const descriptors = {
        assetHub: getAssetHubDescriptor(cfg.env),
        bulletin: getBulletinDescriptor(cfg.env),
        individuality: getIndividualityDescriptor(cfg.env),
    };
    const raw = {
        assetHub: createRawClient([cfg.assetHubRpc]),
        bulletin: createRawClient([cfg.bulletinRpc, ...cfg.bulletinRpcFallbacks]),
        individuality: createRawClient(cfg.peopleEndpoints),
    };

    let destroyed = false;
    return {
        assetHub: typedApi(raw.assetHub, descriptors.assetHub),
        bulletin: typedApi(raw.bulletin, descriptors.bulletin),
        individuality: typedApi(raw.individuality, descriptors.individuality),
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
                reject(
                    new Error(
                        `Timed out connecting to ${getNetworkLabel()} after ${Math.round(ms / 1000)}s`,
                    ),
                ),
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
                `Could not connect to ${getNetworkLabel()} network — check your internet connection (${detail})`,
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
