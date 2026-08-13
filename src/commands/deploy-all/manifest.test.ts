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

import { describe, it, expect } from "vitest";
import { parseManifest } from "./manifest.js";

describe("parseManifest", () => {
    it("parses a minimal apps list", () => {
        const { apps } = parseManifest(
            JSON.stringify({
                apps: [
                    { name: "arcade", dir: "apps/arcade", domain: "arcade" },
                    { dir: "apps/snake", domain: "arcade-snake.dot" },
                ],
            }),
        );
        expect(apps).toHaveLength(2);
        expect(apps[0]).toEqual({ name: "arcade", dir: "apps/arcade", domain: "arcade" });
        // name defaults to domain when omitted.
        expect(apps[1].name).toBe("arcade-snake.dot");
    });

    it("carries optional per-app overrides", () => {
        const { apps } = parseManifest(
            JSON.stringify({
                apps: [{ dir: "a", domain: "a", buildDir: "build", skipBuild: true }],
            }),
        );
        expect(apps[0]).toMatchObject({ buildDir: "build", skipBuild: true });
    });

    it("rejects invalid JSON", () => {
        expect(() => parseManifest("{ not json")).toThrow(/not valid JSON/);
    });

    it("rejects a non-object root", () => {
        expect(() => parseManifest("[]")).toThrow(/apps/);
    });

    it("rejects an empty or missing apps array", () => {
        expect(() => parseManifest(JSON.stringify({ apps: [] }))).toThrow(/non-empty array/);
        expect(() => parseManifest(JSON.stringify({}))).toThrow(/non-empty array/);
    });

    it("rejects an app missing dir or domain", () => {
        expect(() => parseManifest(JSON.stringify({ apps: [{ domain: "a" }] }))).toThrow(
            /apps\[0\]\.dir/,
        );
        expect(() => parseManifest(JSON.stringify({ apps: [{ dir: "a" }] }))).toThrow(
            /apps\[0\]\.domain/,
        );
    });

    it("rejects a wrong-typed optional override", () => {
        expect(() =>
            parseManifest(JSON.stringify({ apps: [{ dir: "a", domain: "a", skipBuild: "yes" }] })),
        ).toThrow(/skipBuild must be a boolean/);
    });

    it("rejects duplicate domains (case- and suffix-insensitive)", () => {
        // The stripped suffix is the ENV TLD ("paseo" on the default env) —
        // "arcade" and "Arcade.paseo" deploy to the same DotNS name.
        expect(() =>
            parseManifest(
                JSON.stringify({
                    apps: [
                        { dir: "a", domain: "arcade" },
                        { dir: "b", domain: "Arcade.paseo" },
                    ],
                }),
            ),
        ).toThrow(/duplicate domain/);
    });

    it("does not conflate a name that merely ends in a foreign-TLD spelling", () => {
        // ".dot" is NOT the default env's TLD, so "arcade.dot" is a distinct
        // (and later-rejected-by-normalizeDomain) name, not a duplicate of
        // "arcade" — the guard only strips the env TLD.
        expect(() =>
            parseManifest(
                JSON.stringify({
                    apps: [
                        { dir: "a", domain: "arcade" },
                        { dir: "b", domain: "arcade.dot" },
                    ],
                }),
            ),
        ).not.toThrow();
    });
});
