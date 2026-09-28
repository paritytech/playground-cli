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

import { describe, expect, it } from "vitest";
import { getAppMetadataUri, type MetadataUriReader } from "./metadataUri.js";

const reader = (res: { success: boolean; value?: unknown }): MetadataUriReader => ({
    getMetadataUri: { query: async () => res },
});

describe("getAppMetadataUri", () => {
    /**
     * Both cases are the shapes observed live against the v2 registry on
     * paseo-next-v2 (`rps-mod-test.paseo` vs a domain that was never
     * published), not a guess at the ABI.
     */
    it("returns the CID for a published app", async () => {
        const cid = "bafk2bzacebh3n5gtceo3u4m7u5zssy23ewbtfrj7e3k4f3msiivlkzxndo6ug";
        await expect(
            getAppMetadataUri(reader({ success: true, value: cid }), "x.paseo"),
        ).resolves.toBe(cid);
    });

    it("treats the empty string as 'no such app' — v2 has no Option wrapper", async () => {
        await expect(
            getAppMetadataUri(reader({ success: true, value: "" }), "nope.paseo"),
        ).resolves.toBeNull();
    });

    /**
     * Regression guard. The pre-v2 call sites did `value.isSome ? … : null`,
     * which reads `undefined` off a plain string and reported EVERY app as
     * missing — `playground mod` failed for apps that demonstrably existed.
     * If a future refactor reintroduces Option-style narrowing, this fails.
     */
    it("does not depend on an isSome wrapper", async () => {
        const cid = "bafkreiexample";
        const res = { success: true, value: cid };
        expect((res.value as unknown as { isSome?: boolean }).isSome).toBeUndefined();
        await expect(getAppMetadataUri(reader(res), "x.paseo")).resolves.toBe(cid);
    });

    it("throws when the dry-run itself was rejected", async () => {
        await expect(getAppMetadataUri(reader({ success: false }), "x.paseo")).rejects.toThrow(
            /failed at dry-run/,
        );
    });

    /** A changed ABI must be loud, not silently indistinguishable from "not found". */
    it("throws on an unexpected payload shape rather than reporting 'not found'", async () => {
        await expect(
            getAppMetadataUri(
                reader({ success: true, value: { isSome: true, value: "x" } }),
                "x.paseo",
            ),
        ).rejects.toThrow(/unexpected shape/);
    });
});
