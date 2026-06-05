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

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prependPath, TOOL_STEPS } from "./toolchain.js";

describe("prependPath", () => {
    let originalPath: string | undefined;

    beforeEach(() => {
        originalPath = process.env.PATH;
    });

    afterEach(() => {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
    });

    it("prepends the directory when not already present", () => {
        process.env.PATH = "/usr/bin:/bin";
        prependPath("/Users/me/.cargo/bin");
        expect(process.env.PATH).toBe("/Users/me/.cargo/bin:/usr/bin:/bin");
    });

    it("is a no-op when the directory is already on PATH", () => {
        process.env.PATH = "/Users/me/.cargo/bin:/usr/bin";
        prependPath("/Users/me/.cargo/bin");
        expect(process.env.PATH).toBe("/Users/me/.cargo/bin:/usr/bin");
    });

    it("handles an empty PATH", () => {
        process.env.PATH = "";
        prependPath("/Users/me/.cargo/bin");
        expect(process.env.PATH).toBe("/Users/me/.cargo/bin");
    });

    it("handles an unset PATH", () => {
        delete process.env.PATH;
        prependPath("/Users/me/.cargo/bin");
        expect(process.env.PATH).toBe("/Users/me/.cargo/bin");
    });
});

describe("TOOL_STEPS", () => {
    it("installs git before any step whose installer shells out to it (#247)", () => {
        // On a clean Ubuntu install (no Xcode CLT equivalent), git is absent
        // until our own git step runs. Any earlier step that invokes git in
        // its install command fails — the DevEx audit hit exactly this with
        // cargo-pvm-contract's `git clone`. macOS masks the bug because git
        // is always present, so this ordering is pinned by test instead.
        const names = TOOL_STEPS.map((step) => step.name);
        const gitIndex = names.indexOf("git");
        expect(gitIndex).toBeGreaterThanOrEqual(0);

        const cargoPvmIndex = names.indexOf("cargo-pvm-contract");
        expect(cargoPvmIndex).toBeGreaterThanOrEqual(0);
        expect(gitIndex).toBeLessThan(cargoPvmIndex);
    });

    it("installs cargo-pvm-contract directly instead of the CDM CLI installer", () => {
        const names = TOOL_STEPS.map((step) => step.name);
        expect(names).toContain("cargo-pvm-contract");
        expect(names).not.toContain("cdm & cargo-pvm-contract");

        const step = TOOL_STEPS.find((entry) => entry.name === "cargo-pvm-contract");
        expect(step?.manualHint).toContain("cargo-pvm-contract");
        expect(step?.manualHint).not.toContain("contract-dependency-manager");
    });
});
