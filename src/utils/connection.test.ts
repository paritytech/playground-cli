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

import { describe, it, expect, vi, beforeEach } from "vitest";
import { getNetworkLabel } from "../config.js";

const mockCreateClient = vi.fn();
const mockGetWsProvider = vi.fn();
const mockDestroy = vi.fn();
const mockGetTypedApi = vi.fn((descriptor) => ({ descriptor }));

vi.mock("polkadot-api", () => ({
    createClient: (provider: unknown) => mockCreateClient(provider),
}));

vi.mock("polkadot-api/ws", () => ({
    getWsProvider: (endpoints: unknown, options?: unknown) => mockGetWsProvider(endpoints, options),
}));

vi.mock("@parity/product-sdk-descriptors/paseo-asset-hub", () => ({
    paseo_asset_hub: { genesis: "0xasset" },
}));

vi.mock("@parity/product-sdk-descriptors/paseo-bulletin", () => ({
    paseo_bulletin: { genesis: "0xbulletin" },
}));

vi.mock("@parity/product-sdk-descriptors/paseo-individuality", () => ({
    paseo_individuality: { genesis: "0xpeople" },
}));

// Re-import after each test to reset the singleton
let getConnection: typeof import("./connection.js").getConnection;
let destroyConnection: typeof import("./connection.js").destroyConnection;

// Descriptors are always the paseo shapes now — product-sdk-descriptors@0.8.0
// dropped the summit subpaths, so the selectors return paseo for every env.
const expectedActiveDescriptors = [
    { genesis: "0xasset" },
    { genesis: "0xbulletin" },
    { genesis: "0xpeople" },
];

beforeEach(async () => {
    vi.resetModules();
    mockCreateClient.mockReset();
    mockGetWsProvider.mockReset();
    mockDestroy.mockReset();
    mockGetTypedApi.mockClear();
    mockCreateClient.mockImplementation(() => ({
        destroy: mockDestroy,
        getTypedApi: mockGetTypedApi,
    }));
    mockGetWsProvider.mockImplementation((endpoints) => ({ endpoints }));
    const mod = await import("./connection.js");
    getConnection = mod.getConnection;
    destroyConnection = mod.destroyConnection;
});

describe("getConnection", () => {
    it("creates direct clients with descriptors for the active chains", async () => {
        await getConnection();
        expect(mockCreateClient).toHaveBeenCalledTimes(3);
        expect(mockGetTypedApi).toHaveBeenCalledTimes(3);
        expect(mockGetTypedApi.mock.calls.map(([descriptor]) => descriptor)).toEqual(
            expectedActiveDescriptors,
        );
    });

    it("returns the same client on subsequent calls (singleton)", async () => {
        const first = await getConnection();
        const second = await getConnection();

        expect(first).toBe(second);
        expect(mockCreateClient).toHaveBeenCalledTimes(3);
    });

    it("does not race when called concurrently", async () => {
        const [a, b] = await Promise.all([getConnection(), getConnection()]);

        expect(a).toBe(b);
        expect(mockCreateClient).toHaveBeenCalledTimes(3);
    });

    it("throws a readable error on connection failure", async () => {
        mockCreateClient.mockImplementation(() => {
            throw new Error("WebSocket failed");
        });

        await expect(getConnection()).rejects.toThrow(
            `Could not connect to ${getNetworkLabel()} network`,
        );
    });

    it("preserves the underlying error detail in the message", async () => {
        // Regression guard — historically the outer message only said "check
        // your internet connection", which is misleading when the cause is a
        // descriptor mismatch or a bad endpoint URL.
        mockCreateClient.mockImplementation(() => {
            throw new Error("ECONNREFUSED 127.0.0.1:9944");
        });

        await expect(getConnection()).rejects.toThrow(/ECONNREFUSED 127\.0\.0\.1:9944/);
    });

    it("preserves the underlying error as Error.cause", async () => {
        const underlying = new Error("descriptor mismatch");
        mockCreateClient.mockImplementation(() => {
            throw underlying;
        });

        try {
            await getConnection();
            expect.fail("expected throw");
        } catch (err) {
            expect((err as Error).cause).toBe(underlying);
        }
    });

    it("allows retry after connection failure", async () => {
        mockCreateClient.mockImplementationOnce(() => {
            throw new Error("timeout");
        });

        await expect(getConnection()).rejects.toThrow();
        const client = await getConnection();
        expect(client).toBeTruthy();
        expect(mockCreateClient).toHaveBeenCalledTimes(4);
    });
});

describe("destroyConnection", () => {
    it("calls destroy on the client", async () => {
        await getConnection();
        destroyConnection();

        expect(mockDestroy).toHaveBeenCalledTimes(3);
    });

    it("allows reconnection after destroy", async () => {
        const first = await getConnection();
        destroyConnection();
        const second = await getConnection();

        expect(first).not.toBe(second);
        expect(mockCreateClient).toHaveBeenCalledTimes(6);
    });

    it("is safe to call when not connected", () => {
        expect(() => destroyConnection()).not.toThrow();
    });
});
