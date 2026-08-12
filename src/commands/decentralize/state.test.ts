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

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import {
    pickNextStage,
    validateDomainInput,
    validateLocalPathInput,
    validateSiteUrlInput,
    type PickStageInput,
} from "./state.js";

/** All-empty input; tests spread the fields a stage transition depends on. */
const base: PickStageInput = {
    sourceKind: null,
    siteUrl: null,
    localPath: null,
    signerMode: null,
    domainLabel: null,
    domainRaw: null,
    publishToPlayground: null,
    moddable: null,
    repositoryUrl: null,
};

/** A url-source flow answered up to (and including) the domain validation. */
const urlThroughDomain: PickStageInput = {
    ...base,
    sourceKind: "url",
    siteUrl: "https://example.com",
    signerMode: "dev",
    domainLabel: "myapp",
    domainRaw: "myapp",
};

/** A path-source flow answered up to (and including) the domain validation. */
const pathThroughDomain: PickStageInput = {
    ...base,
    sourceKind: "path",
    localPath: "./dist",
    signerMode: "dev",
    domainLabel: "myapp",
    domainRaw: "myapp",
};

describe("pickNextStage", () => {
    it("starts at prompt-source when nothing has been filled", () => {
        expect(pickNextStage(base)).toEqual({ kind: "prompt-source" });
    });

    it("prompts for the URL once the url source is picked", () => {
        expect(pickNextStage({ ...base, sourceKind: "url" })).toEqual({ kind: "prompt-url" });
    });

    it("prompts for the directory once the path source is picked", () => {
        expect(pickNextStage({ ...base, sourceKind: "path" })).toEqual({ kind: "prompt-path" });
    });

    it("path flow joins the shared stages at prompt-signer", () => {
        expect(pickNextStage({ ...base, sourceKind: "path", localPath: "./dist" })).toEqual({
            kind: "prompt-signer",
        });
    });

    it("advances to prompt-signer once the URL is known", () => {
        expect(
            pickNextStage({ ...base, sourceKind: "url", siteUrl: "https://example.com" }),
        ).toEqual({ kind: "prompt-signer" });
    });

    it("advances to prompt-domain once URL + signer are picked", () => {
        expect(
            pickNextStage({
                ...base,
                sourceKind: "url",
                siteUrl: "https://example.com",
                signerMode: "dev",
            }),
        ).toEqual({ kind: "prompt-domain" });
    });

    it("advances to validate-domain once domain has been typed but not yet validated", () => {
        expect(
            pickNextStage({
                ...base,
                sourceKind: "url",
                siteUrl: "https://example.com",
                signerMode: "phone",
                domainRaw: "myapp",
            }),
        ).toEqual({ kind: "validate-domain", raw: "myapp" });
    });

    it("asks the publish question once the domain is validated", () => {
        expect(pickNextStage(urlThroughDomain)).toEqual({ kind: "prompt-publish" });
    });

    it("lands on confirm once the publish answer is locked in", () => {
        expect(pickNextStage({ ...urlThroughDomain, publishToPlayground: false })).toEqual({
            kind: "confirm",
        });
    });

    it("asks for a tag when publishing and no --tag pre-filled it", () => {
        // url source publishing: moddable is skipped (no git source), so the
        // tag picker is the only publish-only follow-up before confirm.
        expect(pickNextStage({ ...urlThroughDomain, publishToPlayground: true })).toEqual({
            kind: "prompt-tags",
        });
    });

    it("lands on confirm once a tag is chosen (or skipped) when publishing", () => {
        // A resolved tag (a string OR an explicit null "skip") clears the last
        // publish-only prompt.
        for (const tag of ["site", null] as const) {
            expect(pickNextStage({ ...urlThroughDomain, publishToPlayground: true, tag })).toEqual({
                kind: "confirm",
            });
        }
    });

    it("treats an empty-string domainRaw as 'asked-already, use auto'", () => {
        // Mirrors the user submitting a blank domain prompt to opt into auto-naming.
        expect(
            pickNextStage({
                ...base,
                sourceKind: "url",
                siteUrl: "https://example.com",
                signerMode: "dev",
                domainRaw: "",
            }),
        ).toEqual({ kind: "validate-domain", raw: "" });
    });

    // ── Moddable (path + publish only) ───────────────────────────────────────

    it("asks the moddable question before the tag for a publishing path source", () => {
        // Moddable is the first publish-only follow-up (tag still undefined),
        // mirroring deploy's moddable → tag ordering.
        expect(pickNextStage({ ...pathThroughDomain, publishToPlayground: true })).toEqual({
            kind: "prompt-moddable",
        });
    });

    it("never asks moddable for a url source — mirrored sites have no git source", () => {
        // url + publish jumps straight to the tag prompt: moddable is skipped.
        expect(pickNextStage({ ...urlThroughDomain, publishToPlayground: true })).toEqual({
            kind: "prompt-tags",
        });
    });

    it("never asks moddable when the path source is not publishing", () => {
        expect(pickNextStage({ ...pathThroughDomain, publishToPlayground: false })).toEqual({
            kind: "confirm",
        });
    });

    it("declining moddable advances to the tag prompt", () => {
        expect(
            pickNextStage({ ...pathThroughDomain, publishToPlayground: true, moddable: false }),
        ).toEqual({ kind: "prompt-tags" });
    });

    it("accepting moddable (or pre-answering via --moddable) drives into the preflight", () => {
        expect(
            pickNextStage({ ...pathThroughDomain, publishToPlayground: true, moddable: true }),
        ).toEqual({ kind: "moddable-preflight" });
    });

    it("advances to the tag prompt once the preflight has resolved the repository URL", () => {
        expect(
            pickNextStage({
                ...pathThroughDomain,
                publishToPlayground: true,
                moddable: true,
                repositoryUrl: "https://github.com/acme/site",
            }),
        ).toEqual({ kind: "prompt-tags" });
    });

    it("lands on confirm once a publishing path source resolves both moddable and tag", () => {
        expect(
            pickNextStage({
                ...pathThroughDomain,
                publishToPlayground: true,
                moddable: true,
                repositoryUrl: "https://github.com/acme/site",
                tag: null,
            }),
        ).toEqual({ kind: "confirm" });
    });
});

describe("validateSiteUrlInput", () => {
    it("accepts https URLs", () => {
        expect(validateSiteUrlInput("https://example.com")).toBeNull();
    });

    it("accepts http URLs", () => {
        expect(validateSiteUrlInput("http://example.com")).toBeNull();
    });

    it("accepts bare hostnames (mirror.ts will prepend https)", () => {
        expect(validateSiteUrlInput("example.com")).toBeNull();
        expect(validateSiteUrlInput("you.github.io/site")).toBeNull();
    });

    it("rejects non-http schemes with a precise message", () => {
        expect(validateSiteUrlInput("ftp://example.com")).toBe("only http(s) URLs are supported");
        expect(validateSiteUrlInput("file:///etc/passwd")).toBe("only http(s) URLs are supported");
    });

    it("rejects empty input", () => {
        expect(validateSiteUrlInput("")).toBe("enter a URL");
        expect(validateSiteUrlInput("   ")).toBe("enter a URL");
    });

    it("rejects obvious junk", () => {
        expect(validateSiteUrlInput("not a url at all!!")).toBe("doesn't look like a URL");
    });
});

describe("validateDomainInput", () => {
    it("accepts a bare label", () => {
        expect(validateDomainInput("myapp")).toBeNull();
    });

    it("accepts the env TLD suffix", () => {
        // Default env is paseo-next-v2 whose DotNS TLD is "paseo".
        expect(validateDomainInput("myapp.paseo")).toBeNull();
        // Explicit tld param (previewnet shape).
        expect(validateDomainInput("myapp.dot", "dot")).toBeNull();
    });

    it("rejects a wrong-TLD suffix with the actionable deploy-path message", () => {
        expect(validateDomainInput("myapp.dot")).toMatch(/uses "\.paseo" names/);
        expect(validateDomainInput("myapp.paseo", "dot")).toMatch(/uses "\.dot" names/);
    });

    it("accepts digits and a valid 2-digit suffix", () => {
        expect(validateDomainInput("my-app42")).toBeNull();
    });

    it("treats empty as 'auto-generate'", () => {
        expect(validateDomainInput("")).toBeNull();
        expect(validateDomainInput("   ")).toBeNull();
    });

    it("rejects leading dashes and underscores", () => {
        // Canonical rules: no leading/trailing dash, lowercase-only charset.
        expect(validateDomainInput("-leading")).toMatch(/dash/i);
        expect(validateDomainInput("under_score")).toMatch(/lowercase/i);
    });

    it("rejects uppercase (the chain stores lowercase only)", () => {
        // Regression: the old inline validator was case-insensitive and let
        // MixedCase through to fail one screen later at normalizeDomain. The
        // canonical rules reject it inline.
        expect(validateDomainInput("MyApp")).toMatch(/lowercase/i);
    });

    it("rejects a dash before the digit suffix (strips to a trailing-hyphen base)", () => {
        expect(validateDomainInput("my-app-42")).toMatch(/dash/i);
    });
});

describe("validateLocalPathInput", () => {
    const tempDirs: string[] = [];

    function makeTempDir(): string {
        const dir = mkdtempSync(join(tmpdir(), "dot-state-path-test-"));
        tempDirs.push(dir);
        return dir;
    }

    afterEach(() => {
        for (const dir of tempDirs.splice(0)) {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("accepts a directory containing an index.html", () => {
        const dir = makeTempDir();
        writeFileSync(join(dir, "index.html"), "<html></html>");
        expect(validateLocalPathInput(dir)).toBeNull();
    });

    it("rejects empty input", () => {
        expect(validateLocalPathInput("")).toBe("enter a directory path");
        expect(validateLocalPathInput("   ")).toBe("enter a directory path");
    });

    it("rejects a missing directory with prepareLocalDirectory's message", () => {
        expect(validateLocalPathInput("/tmp/dot-state-path-test-does-not-exist")).toMatch(
            /directory not found/,
        );
    });

    it("states the index.html requirement for a directory without one", () => {
        const dir = makeTempDir();
        writeFileSync(join(dir, "main.js"), "console.log(1)");
        expect(validateLocalPathInput(dir)).toMatch(/no index\.html found.*built static site/);
    });
});
