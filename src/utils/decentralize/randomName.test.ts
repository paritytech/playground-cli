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
 * Shape-invariant tests for `generateLabel`. Two things must hold for every
 * generated label, regardless of input, or //Bob and other NoStatus signers
 * will be rejected at the DotNS chain step:
 *
 *   1. Exactly 2 trailing digits (>2 is RESERVED for governance)
 *   2. Base length (everything before the trailing digits) >= 9
 *
 * Each invariant is checked across many iterations to catch RNG-dependent
 * edge cases — the previous hex-suffix implementation produced >2 trailing
 * digits ~62 % of the time, silently masked by the retry loop.
 */

import { describe, expect, it } from "vitest";
import { generateLabel } from "./randomName.js";

const ITERATIONS = 200;

function trailingDigits(label: string): number {
    return /[0-9]*$/.exec(label)?.[0].length ?? 0;
}

function baseLength(label: string): number {
    return label.length - trailingDigits(label);
}

describe("generateLabel", () => {
    it("incorporates the hostname verbatim (TLD kept)", () => {
        expect(generateLabel("https://shawntabrizi.com")).toMatch(/^shawntabrizi-com-/);
        expect(generateLabel("https://example.com")).toMatch(/^example-com-/);
    });

    it("preserves the www. prefix (we don't second-guess what the user typed)", () => {
        expect(generateLabel("https://www.example.com")).toMatch(/^www-example-com-/);
    });

    it("preserves multi-segment public suffixes (we don't consult the PSL)", () => {
        expect(generateLabel("https://example.co.uk")).toMatch(/^example-co-uk-/);
        expect(generateLabel("https://shawntabrizi.github.io")).toMatch(/^shawntabrizi-github-io-/);
    });

    it("replaces dots with hyphens", () => {
        expect(generateLabel("https://a.b.c.example.com")).toMatch(/^a-b-c-example-com-/);
    });

    it("ignores the path", () => {
        const label = generateLabel("https://example.com/blog/post-1?x=y");
        expect(label).toMatch(/^example-com-/);
        expect(label).not.toContain("blog");
        expect(label).not.toContain("post");
    });

    it("accepts bare hostnames (no protocol)", () => {
        expect(generateLabel("example.com")).toMatch(/^example-com-/);
    });

    it("falls back to decent- when the URL is unusable", () => {
        // node:URL accepts plenty of weird inputs; an outright empty hostname
        // should be the trigger. We exercise it via `garbage://` which parses
        // but yields no hostname.
        const label = generateLabel("garbage://");
        expect(label).toMatch(/^decent-/);
    });

    it("falls back to decent- when no siteUrl is provided", () => {
        expect(generateLabel(undefined)).toMatch(/^decent-/);
    });

    it("always ends in exactly 2 trailing digits", () => {
        for (let i = 0; i < ITERATIONS; i++) {
            const label = generateLabel("https://example.com");
            expect(trailingDigits(label)).toBe(2);
        }
    });

    it("produces NoStatus-compatible base length (>=9)", () => {
        for (let i = 0; i < ITERATIONS; i++) {
            const label = generateLabel("https://example.com");
            expect(baseLength(label)).toBeGreaterThanOrEqual(9);
        }
    });

    it("pads short hostnames so the NoStatus base threshold is still met", () => {
        // "a.b" → base "a-b" is only 3 chars; needs extra letters to reach 9.
        for (let i = 0; i < ITERATIONS; i++) {
            const label = generateLabel("https://a.b");
            expect(baseLength(label)).toBeGreaterThanOrEqual(9);
            expect(trailingDigits(label)).toBe(2);
        }
    });

    it("preserves shape invariants for the decent- fallback", () => {
        for (let i = 0; i < ITERATIONS; i++) {
            const label = generateLabel(undefined);
            expect(baseLength(label)).toBeGreaterThanOrEqual(9);
            expect(trailingDigits(label)).toBe(2);
        }
    });

    it("caps absurdly long hostnames", () => {
        const longHost = `${"a".repeat(80)}.com`;
        const label = generateLabel(`https://${longHost}`);
        // DNS labels max out at 63; we cap the host segment at 30 and add a
        // short suffix, so the final length is well under that.
        expect(label.length).toBeLessThanOrEqual(40);
    });

    it("produces labels matching normalizeDomain's regex", () => {
        // playground.ts::normalizeDomain enforces /^[a-z0-9][a-z0-9-]*$/i.
        const re = /^[a-z0-9][a-z0-9-]*$/;
        for (const input of [
            "https://example.com",
            "https://www.shawntabrizi.com",
            "https://x.com",
            "https://a.b",
            "https://sub.domain.example.com",
        ]) {
            const label = generateLabel(input);
            expect(label).toMatch(re);
        }
    });

    it("varies on each call (RNG is wired)", () => {
        const labels = new Set<string>();
        for (let i = 0; i < 50; i++) {
            labels.add(generateLabel("https://example.com"));
        }
        // Tail is 4 letters (26^4 ≈ 456k) + 2 digits, so 50 calls colliding
        // would point at a broken RNG.
        expect(labels.size).toBe(50);
    });
});
