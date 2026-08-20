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
import { defaultRepoName } from "./repoName.js";

describe("defaultRepoName", () => {
    it("slugifies and appends a 6-hex-char suffix", () => {
        const name = defaultRepoName("My Cool App.dot");
        expect(name).toMatch(/^my-cool-app-[0-9a-f]{6}$/);
    });

    it("strips the .dot suffix", () => {
        expect(defaultRepoName("foo.dot")).toMatch(/^foo-[0-9a-f]{6}$/);
    });

    it("strips the .paseo suffix (per-env DotNS TLDs)", () => {
        // Registry domains carry the env TLD since the paseo-next-v2 DotNS
        // redeploy; the directory name must not keep it as a `-paseo` tail.
        expect(defaultRepoName("cool-app.paseo")).toMatch(/^cool-app-[0-9a-f]{6}$/);
        expect(defaultRepoName("My Cool App.PASEO")).toMatch(/^my-cool-app-[0-9a-f]{6}$/);
    });

    it("handles domains without a TLD suffix", () => {
        expect(defaultRepoName("bar")).toMatch(/^bar-[0-9a-f]{6}$/);
    });

    it("produces different suffixes on consecutive calls", () => {
        const a = defaultRepoName("x.dot");
        const b = defaultRepoName("x.dot");
        expect(a).not.toBe(b);
    });
});
