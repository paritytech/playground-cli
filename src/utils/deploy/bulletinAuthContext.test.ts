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

import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClientMock, getWsProviderMock, destroyMock, getTypedApiMock } = vi.hoisted(() => ({
    createClientMock: vi.fn(),
    getWsProviderMock: vi.fn(),
    destroyMock: vi.fn(),
    getTypedApiMock: vi.fn(),
}));

vi.mock("polkadot-api", () => ({ createClient: createClientMock }));
vi.mock("polkadot-api/ws", () => ({ getWsProvider: getWsProviderMock }));
vi.mock("@parity/product-sdk-descriptors/paseo-bulletin", () => ({ paseo_bulletin: {} }));

import { createBulletinAuthContext } from "./bulletinAuthContext.js";

// The bulletin descriptor is always the paseo shape now (product-sdk-descriptors
// @0.8.0 dropped the summit subpaths), regardless of the active env.
const expectedActiveBulletinDescriptor = {};

beforeEach(() => {
    createClientMock.mockReset();
    getWsProviderMock.mockReset();
    destroyMock.mockReset();
    getTypedApiMock.mockReset();
    getTypedApiMock.mockReturnValue({ marker: "bulletin-api" });
    createClientMock.mockReturnValue({ getTypedApi: getTypedApiMock, destroy: destroyMock });
});

describe("createBulletinAuthContext", () => {
    it("builds a context exposing the bulletin API and a destroy that tears down the client", () => {
        const ctx = createBulletinAuthContext(undefined);

        expect(ctx).not.toBeNull();
        expect(ctx?.bulletinApi).toEqual({ marker: "bulletin-api" });
        expect(getTypedApiMock).toHaveBeenCalledWith(expectedActiveBulletinDescriptor);
        expect(destroyMock).not.toHaveBeenCalled();
        ctx?.destroy();
        expect(destroyMock).toHaveBeenCalledTimes(1);
    });

    it("returns null when client construction throws (best-effort: skip the check)", () => {
        createClientMock.mockImplementation(() => {
            throw new Error("ws unreachable");
        });

        expect(createBulletinAuthContext(undefined)).toBeNull();
    });
});
