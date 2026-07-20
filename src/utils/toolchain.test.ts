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
import {
    CARGO_METADATA_MESSAGE,
    hasCargoPvmContract,
    isCargoMetadataError,
    isIpfsMigrationError,
    prependPath,
    remapCargoMetadataError,
    TOOL_STEPS,
} from "./toolchain.js";

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

    it("installs curl before any step whose installer fetches with it (#248)", () => {
        // Bare Ubuntu ships no curl. The rustup and IPFS install commands
        // both pipe from curl, so the curl step must run first. macOS masks
        // this because curl ships with the OS.
        const names = TOOL_STEPS.map((step) => step.name);
        const curlIndex = names.indexOf("curl");
        expect(curlIndex).toBeGreaterThanOrEqual(0);

        const rustupIndex = names.indexOf("rustup");
        expect(rustupIndex).toBeGreaterThanOrEqual(0);
        expect(curlIndex).toBeLessThan(rustupIndex);

        const ipfsIndex = names.indexOf("IPFS");
        expect(ipfsIndex).toBeGreaterThanOrEqual(0);
        expect(curlIndex).toBeLessThan(ipfsIndex);
    });

    it("installs the C linker before cargo-pvm-contract, which compiles (#248)", () => {
        // `cargo install` needs a system linker; bare Ubuntu has no cc until
        // build-essential lands. macOS masks this via Xcode CLT, so the
        // ordering is pinned by test, same as git in #247.
        const names = TOOL_STEPS.map((step) => step.name);
        const ccIndex = names.indexOf("C linker (cc)");
        expect(ccIndex).toBeGreaterThanOrEqual(0);

        const cargoPvmIndex = names.indexOf("cargo-pvm-contract");
        expect(cargoPvmIndex).toBeGreaterThanOrEqual(0);
        expect(ccIndex).toBeLessThan(cargoPvmIndex);
    });

    it("installs cargo-pvm-contract directly instead of the CDM CLI installer", () => {
        const names = TOOL_STEPS.map((step) => step.name);
        expect(names).toContain("cargo-pvm-contract");
        expect(names).not.toContain("cdm & cargo-pvm-contract");

        const step = TOOL_STEPS.find((entry) => entry.name === "cargo-pvm-contract");
        expect(step?.manualHint).toContain("cargo-pvm-contract");
        expect(step?.manualHint).not.toContain("contract-dependency-manager");
    });

    it("validates cargo-pvm-contract by probing the build subcommand", () => {
        const cargoStep = TOOL_STEPS.find((entry) => entry.name === "cargo-pvm-contract");
        expect(cargoStep?.check).toBe(hasCargoPvmContract);
    });

    it("documents the IPFS repo migration in its manual hint", () => {
        // A stale Kubo repo crashes the deploy's internal `ipfs add` with
        // "repo needs migration"; the manual hint must point at the fix.
        const ipfsStep = TOOL_STEPS.find((entry) => entry.name === "IPFS");
        expect(ipfsStep?.manualHint).toContain("ipfs repo migrate");
    });
});

describe("isIpfsMigrationError", () => {
    it("matches Kubo's full migration notice", () => {
        expect(
            isIpfsMigrationError(
                new Error("Error: ipfs repo needs migration, please run migration tool."),
            ),
        ).toBe(true);
    });

    it("matches regardless of surrounding text (Node's exec prefix, trailing newline)", () => {
        expect(
            isIpfsMigrationError(
                new Error(
                    "Command failed: ipfs add -Q -r /tmp/x\nError: ipfs repo needs migration, please run …\n",
                ),
            ),
        ).toBe(true);
    });

    it("matches a bare string, not only Error instances", () => {
        expect(isIpfsMigrationError("repo needs migration")).toBe(true);
    });

    it("does not match unrelated failures", () => {
        expect(isIpfsMigrationError(new Error("AncientBirthBlock: chunk rejected"))).toBe(false);
        expect(isIpfsMigrationError(new Error("some other failure"))).toBe(false);
    });

    it("is scoped to the IPFS repo, not any 'needs migration' text", () => {
        // The marker is "repo needs migration"; a generic database-style
        // "needs migration" from some other dependency must not be remapped
        // to the IPFS instruction.
        expect(isIpfsMigrationError(new Error("database needs migration"))).toBe(false);
    });
});

describe("cargo metadata error remap (#396)", () => {
    // The shape cdm-builder's getCargoMetadata rethrows: execSync's bare
    // "Command failed: cargo metadata …" with cargo's stderr appended.
    const raw = new Error(
        'Command failed: cargo metadata --format-version 1 --manifest-path "/p/Cargo.toml" --no-deps\n' +
            "error: key with no value, expected `=`\n",
    );

    it("classifies cdm-builder's raw cargo metadata failure", () => {
        expect(isCargoMetadataError(raw)).toBe(true);
    });

    it("remaps to the actionable message while keeping cargo's own diagnostic", () => {
        const remapped = remapCargoMetadataError(raw) as Error;
        expect(remapped).toBeInstanceOf(Error);
        expect(remapped.message.startsWith(CARGO_METADATA_MESSAGE)).toBe(true);
        // Must NOT drop cargo's specifics, or a malformed Cargo.toml loses the
        // detail that lets the user fix it.
        expect(remapped.message).toContain("key with no value");
        // The raw error stays reachable for diagnostics — wrap, never discard.
        expect(remapped.cause).toBe(raw);
    });

    it("surfaces cargo's clean stderr over the noisy 'Command failed' echo", () => {
        // execSync puts the clean diagnostic on `.stderr` and the command echo
        // on `.message`; prefer stderr so the user sees file/line, not the command.
        const withStderr = Object.assign(
            new Error('Command failed: cargo metadata --manifest-path "/p/Cargo.toml" --no-deps'),
            { stderr: "error: key with no value, expected `=`\n --> Cargo.toml:21:6\n" },
        );
        const remapped = remapCargoMetadataError(withStderr) as Error;
        expect(remapped.message).toContain("Cargo.toml:21:6");
        expect(remapped.message).not.toContain("--manifest-path");
    });

    it("passes unrelated deploy errors through unchanged", () => {
        const other = new Error("AncientBirthBlock: chunk rejected");
        expect(remapCargoMetadataError(other)).toBe(other);
        expect(isCargoMetadataError(other)).toBe(false);
    });
});
