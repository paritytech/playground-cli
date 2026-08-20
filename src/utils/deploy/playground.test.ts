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
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { captureWarningMock, withSpanMock, bulletinStorageSigner, getBulletinAllowanceSignerMock } =
    vi.hoisted(() => ({
        captureWarningMock: vi.fn(),
        withSpanMock: vi.fn(async (_op: string, _name: string, _attrs: any, fn: any) => fn()),
        bulletinStorageSigner: { __signer: "bulletin-allowance" },
        getBulletinAllowanceSignerMock: vi.fn(async (_options: unknown) => ({
            __signer: "bulletin-allowance",
        })),
    }));

// Mock the metadata upload path so we never actually touch the network.
// The mock returns a fake CID that registry publishing treats as the metadata CID.
vi.mock("@parity/product-sdk-cloud-storage", () => ({
    calculateCid: vi.fn(async () => ({ toString: (): string => "bafymeta" })),
}));
vi.mock("@parity/product-sdk-tx", () => ({
    createDevSigner: vi.fn(() => ({ __devSigner: "Alice" })),
    submitAndWatch: vi.fn(async () => ({ ok: true, block: { hash: "0x0" } })),
    withRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
}));
vi.mock("../allowances/bulletin.js", () => ({
    asCloudStorageApi: (api: unknown) => api,
    getBulletinAllowanceSigner: (options: unknown) => getBulletinAllowanceSignerMock(options),
    isInvalidPaymentError: (err: unknown) => String(err).includes("Payment"),
}));
vi.mock("polkadot-api", () => ({
    createClient: vi.fn(() => ({
        getTypedApi: vi.fn(() => ({
            tx: {
                TransactionStorage: {
                    store: vi.fn((args: unknown) => ({ __kind: "store", args })),
                },
            },
        })),
        destroy: vi.fn(),
    })),
}));
vi.mock("polkadot-api/ws", () => ({
    getWsProvider: vi.fn(() => ({})),
}));

// Likewise stub the connection + registry helpers. We capture the publish
// arguments so we can assert on them.
const publishTx = vi.fn(async () => ({ ok: true, txHash: "0xdead" }));
vi.mock("../connection.js", () => ({
    getConnection: vi.fn(async () => ({ raw: { assetHub: {} } })),
}));
vi.mock("../registry.js", () => ({
    getRegistryContract: vi.fn(async () => ({
        publish: { tx: publishTx },
    })),
}));
vi.mock("../../telemetry.js", () => ({
    captureWarning: (...args: unknown[]) => captureWarningMock(...args),
    withSpan: (...args: unknown[]) =>
        withSpanMock(args[0] as string, args[1] as string, args[2], args[3]),
    errorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}));

import { execFileSync } from "node:child_process";
import {
    publishToPlayground,
    buildMetadata,
    normalizeDomain,
    normalizeModdedFrom,
    readGitBranch,
    readModdedFrom,
    readReadme,
    README_CAP_BYTES,
} from "./playground.js";
import { submitAndWatch } from "@parity/product-sdk-tx";
import type { ResolvedSigner } from "../signer.js";

const makeTmpDir = () => mkdtempSync(join(tmpdir(), "dot-playground-test-"));

const fakeSigner: ResolvedSigner = {
    signer: {} as any,
    address: "5Fake",
    source: "session",
    destroy: () => {},
};

beforeEach(() => {
    publishTx.mockClear();
    publishTx.mockImplementation(async () => ({ ok: true, txHash: "0xdead" }));
    captureWarningMock.mockClear();
    withSpanMock.mockClear();
    getBulletinAllowanceSignerMock.mockClear();
    getBulletinAllowanceSignerMock.mockResolvedValue(bulletinStorageSigner);
    vi.mocked(submitAndWatch).mockClear();
    vi.mocked(submitAndWatch).mockResolvedValue({
        ok: true,
        value: {
            txHash: "0x0",
            ok: true,
            block: { hash: "0x0", number: 0, index: 0 },
            events: [],
        },
    });
});

describe("normalizeDomain", () => {
    it("accepts a valid label and appends the env TLD", () => {
        expect(normalizeDomain("my-app", "dot")).toEqual({
            label: "my-app",
            fullDomain: "my-app.dot",
        });
        expect(normalizeDomain("my-app", "paseo")).toEqual({
            label: "my-app",
            fullDomain: "my-app.paseo",
        });
    });

    it("strips an existing TLD suffix matching the env", () => {
        expect(normalizeDomain("my-app.dot", "dot")).toEqual({
            label: "my-app",
            fullDomain: "my-app.dot",
        });
        expect(normalizeDomain("my-app.paseo", "paseo")).toEqual({
            label: "my-app",
            fullDomain: "my-app.paseo",
        });
    });

    it("strips the suffix case-insensitively", () => {
        expect(normalizeDomain("my-app.PASEO", "paseo")).toEqual({
            label: "my-app",
            fullDomain: "my-app.paseo",
        });
    });

    it("rejects a known TLD that differs from the env's (both directions)", () => {
        // .dot input on a .paseo env — the paseo-next-v2 shape.
        expect(() => normalizeDomain("my-app.dot", "paseo")).toThrow(
            /ends in "\.dot", but this environment uses "\.paseo" names/,
        );
        // .paseo input on a .dot env — the previewnet shape.
        expect(() => normalizeDomain("my-app.paseo", "dot")).toThrow(
            /ends in "\.paseo", but this environment uses "\.dot" names/,
        );
    });

    it("suggests the bare label in the wrong-TLD message", () => {
        expect(() => normalizeDomain("my-app.dot", "paseo")).toThrow(/"my-app"/);
    });

    it("rejects illegal characters", () => {
        expect(() => normalizeDomain("My_App!", "dot")).toThrow(/Invalid domain/);
    });

    it("rejects uppercase (chain stores lowercase only)", () => {
        expect(() => normalizeDomain("MyApp", "dot")).toThrow(/lowercase/i);
    });

    it("rejects labels shorter than 3 characters", () => {
        expect(() => normalizeDomain("ab", "dot")).toThrow(/at least 3/i);
    });

    it("rejects a trailing dash", () => {
        expect(() => normalizeDomain("my-app-", "dot")).toThrow(/dash/i);
    });

    it("rejects a one-digit suffix", () => {
        expect(() => normalizeDomain("myapp1", "dot")).toThrow(/two digits/i);
    });
});

describe("normalizeModdedFrom", () => {
    it("returns null for omitted/empty/whitespace input", () => {
        expect(normalizeModdedFrom(undefined, "dot")).toBeNull();
        expect(normalizeModdedFrom(null, "dot")).toBeNull();
        expect(normalizeModdedFrom("", "dot")).toBeNull();
        expect(normalizeModdedFrom("   ", "dot")).toBeNull();
    });

    it("canonicalizes to <label>.<tld>, adding the suffix and trimming", () => {
        expect(normalizeModdedFrom("original", "dot")).toBe("original.dot");
        expect(normalizeModdedFrom("original.dot", "dot")).toBe("original.dot");
        expect(normalizeModdedFrom("  original.dot  ", "dot")).toBe("original.dot");
        expect(normalizeModdedFrom("original", "paseo")).toBe("original.paseo");
        expect(normalizeModdedFrom("original.paseo", "paseo")).toBe("original.paseo");
    });

    it("returns null for a malformed domain so it can't reach on-chain", () => {
        expect(normalizeModdedFrom("Not A Domain!", "dot")).toBeNull();
        expect(normalizeModdedFrom("../etc.dot", "dot")).toBeNull();
        expect(normalizeModdedFrom("foo/bar.dot", "dot")).toBeNull();
    });

    it("returns null for a wrong-TLD lineage edge rather than propagating it", () => {
        expect(normalizeModdedFrom("original.dot", "paseo")).toBeNull();
    });
});

describe("readReadme", () => {
    it("returns content when README.md exists and fits under the cap", () => {
        const dir = makeTmpDir();
        try {
            writeFileSync(join(dir, "README.md"), "# My App\n\nHello there.");
            const status = readReadme(dir);
            expect(status.kind).toBe("ok");
            if (status.kind === "ok") {
                expect(status.content).toBe("# My App\n\nHello there.");
                expect(status.size).toBe(Buffer.byteLength(status.content, "utf8"));
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("reports oversized when README.md exceeds the cap", () => {
        const dir = makeTmpDir();
        try {
            // One byte over the default 20 KB cap.
            const bigContent = "x".repeat(README_CAP_BYTES + 1);
            writeFileSync(join(dir, "README.md"), bigContent);
            const status = readReadme(dir);
            expect(status.kind).toBe("oversized");
            if (status.kind === "oversized") {
                expect(status.size).toBe(README_CAP_BYTES + 1);
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("returns missing when the file is not present", () => {
        const dir = makeTmpDir();
        try {
            const status = readReadme(dir);
            expect(status.kind).toBe("missing");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("falls back to lowercase readme.md on case-sensitive filesystems", () => {
        const dir = makeTmpDir();
        try {
            writeFileSync(join(dir, "readme.md"), "# lower");
            const status = readReadme(dir);
            expect(status.kind).toBe("ok");
            if (status.kind === "ok") expect(status.content).toBe("# lower");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("falls back to title-cased Readme.md", () => {
        const dir = makeTmpDir();
        try {
            writeFileSync(join(dir, "Readme.md"), "# title");
            const status = readReadme(dir);
            expect(status.kind).toBe("ok");
            if (status.kind === "ok") expect(status.content).toBe("# title");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("respects a custom cap", () => {
        const dir = makeTmpDir();
        try {
            writeFileSync(join(dir, "README.md"), "abcdefghij"); // 10 bytes
            expect(readReadme(dir, 5).kind).toBe("oversized");
            expect(readReadme(dir, 10).kind).toBe("ok");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("readGitBranch", () => {
    // Helper: git invocations that bypass the maintainer's global gpg-signing
    // and ignore-author-config settings, so the tests run identically on any
    // dev machine and in CI.
    const gitOpts = (cwd: string) => ({
        cwd,
        stdio: "ignore" as const,
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: "test",
            GIT_AUTHOR_EMAIL: "test@example.com",
            GIT_COMMITTER_NAME: "test",
            GIT_COMMITTER_EMAIL: "test@example.com",
            GIT_CONFIG_GLOBAL: "/dev/null", // ignore the user's global git config (gpgsign etc.)
            GIT_CONFIG_SYSTEM: "/dev/null",
        },
    });

    it("returns null for a non-git directory", () => {
        const tmp = makeTmpDir();
        try {
            expect(readGitBranch(tmp)).toBeNull();
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });

    it("returns the branch name when the repo is on a named branch", () => {
        const tmp = makeTmpDir();
        try {
            execFileSync("git", ["init", "-b", "feature/x"], gitOpts(tmp));
            writeFileSync(join(tmp, "f"), "x");
            execFileSync("git", ["add", "f"], gitOpts(tmp));
            execFileSync("git", ["commit", "-m", "init"], gitOpts(tmp));
            expect(readGitBranch(tmp)).toBe("feature/x");
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });

    it("returns null in detached-HEAD state (so we never write the literal 'HEAD' to metadata)", () => {
        const tmp = makeTmpDir();
        try {
            execFileSync("git", ["init", "-b", "main"], gitOpts(tmp));
            writeFileSync(join(tmp, "f"), "x");
            execFileSync("git", ["add", "f"], gitOpts(tmp));
            execFileSync("git", ["commit", "-m", "init"], gitOpts(tmp));
            const sha = execFileSync("git", ["rev-parse", "HEAD"], {
                cwd: tmp,
                encoding: "utf8",
                env: gitOpts(tmp).env,
            }).trim();
            execFileSync("git", ["checkout", "--detach", sha], gitOpts(tmp));
            expect(readGitBranch(tmp)).toBeNull();
        } finally {
            rmSync(tmp, { recursive: true, force: true });
        }
    });
});

describe("readModdedFrom", () => {
    it("returns null when dot.json is missing", () => {
        const dir = makeTmpDir();
        try {
            expect(readModdedFrom(dir, "dot")).toBeNull();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("returns the moddedFrom value when set", () => {
        const dir = makeTmpDir();
        try {
            writeFileSync(join(dir, "dot.json"), JSON.stringify({ moddedFrom: "original.dot" }));
            expect(readModdedFrom(dir, "dot")).toBe("original.dot");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("returns null when the field is absent, blank, or non-string", () => {
        const dir = makeTmpDir();
        try {
            writeFileSync(join(dir, "dot.json"), JSON.stringify({ name: "x" }));
            expect(readModdedFrom(dir, "dot")).toBeNull();
            writeFileSync(join(dir, "dot.json"), JSON.stringify({ moddedFrom: "   " }));
            expect(readModdedFrom(dir, "dot")).toBeNull();
            writeFileSync(join(dir, "dot.json"), JSON.stringify({ moddedFrom: 42 }));
            expect(readModdedFrom(dir, "dot")).toBeNull();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("returns null when dot.json is unparseable", () => {
        const dir = makeTmpDir();
        try {
            writeFileSync(join(dir, "dot.json"), "{ not json");
            expect(readModdedFrom(dir, "dot")).toBeNull();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("rejects malformed domains so they can't reach published metadata", () => {
        const dir = makeTmpDir();
        try {
            const cases = [
                "<script>alert(1)</script>",
                "<img onerror=fetch(0)>.dot",
                "foo bar.dot",
                "foo/bar.dot",
                "../etc.dot",
            ];
            for (const moddedFrom of cases) {
                writeFileSync(join(dir, "dot.json"), JSON.stringify({ moddedFrom }));
                expect(readModdedFrom(dir, "dot"), `expected null for ${moddedFrom}`).toBeNull();
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("canonicalizes to <label>.dot when the suffix is missing", () => {
        const dir = makeTmpDir();
        try {
            writeFileSync(join(dir, "dot.json"), JSON.stringify({ moddedFrom: "original" }));
            expect(readModdedFrom(dir, "dot")).toBe("original.dot");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("buildMetadata", () => {
    it("includes repository when repositoryUrl is non-null", () => {
        const meta = buildMetadata({
            repositoryUrl: "https://github.com/x/y",
            branch: null,
            readme: null,
            moddedFrom: null,
            tag: null,
        });
        expect(meta).toEqual({ repository: "https://github.com/x/y" });
    });

    it("omits repository entirely when repositoryUrl is null", () => {
        const meta = buildMetadata({
            repositoryUrl: null,
            branch: null,
            readme: null,
            moddedFrom: null,
            tag: null,
        });
        expect(meta.repository).toBeUndefined();
    });

    it("includes branch alongside repository when both are present", () => {
        const meta = buildMetadata({
            repositoryUrl: "https://github.com/x/y",
            branch: "develop",
            readme: null,
            moddedFrom: null,
            tag: null,
        });
        expect(meta).toEqual({ repository: "https://github.com/x/y", branch: "develop" });
    });

    it("omits branch when repositoryUrl is null (branch alone is meaningless)", () => {
        const meta = buildMetadata({
            repositoryUrl: null,
            branch: "develop",
            readme: null,
            moddedFrom: null,
            tag: null,
        });
        expect(meta.branch).toBeUndefined();
    });

    it("includes README when present", () => {
        const meta = buildMetadata({
            repositoryUrl: null,
            branch: null,
            readme: { kind: "ok", content: "hello", size: 5 },
            moddedFrom: null,
            tag: null,
        });
        expect(meta).toEqual({ readme: "hello" });
    });

    it("includes moddedFrom when present (independent of repositoryUrl)", () => {
        const meta = buildMetadata({
            repositoryUrl: null,
            branch: null,
            readme: null,
            moddedFrom: "original.dot",
            tag: null,
        });
        expect(meta).toEqual({ moddedFrom: "original.dot" });
    });

    it("omits moddedFrom when null or empty", () => {
        const meta = buildMetadata({
            repositoryUrl: "https://github.com/x/y",
            branch: null,
            readme: null,
            moddedFrom: null,
            tag: null,
        });
        expect(meta.moddedFrom).toBeUndefined();
    });

    it("includes tag when present (independent of repositoryUrl)", () => {
        const meta = buildMetadata({
            repositoryUrl: null,
            branch: null,
            readme: null,
            moddedFrom: null,
            tag: "site",
        });
        expect(meta).toEqual({ tag: "site" });
    });

    it("omits tag when null", () => {
        const meta = buildMetadata({
            repositoryUrl: "https://github.com/x/y",
            branch: null,
            readme: null,
            moddedFrom: null,
            tag: null,
        });
        expect(meta.tag).toBeUndefined();
    });
});

describe("publishToPlayground", () => {
    // Every test needs a cwd that doesn't accidentally pick up the repo's own
    // README.md (the CLI's real README is ~10 KB and would be inlined if we
    // defaulted to `process.cwd()`). Each test opts into a tmpdir explicitly.
    it("uploads metadata JSON with the Bulletin allowance signer and calls registry.publish with the phone signer", async () => {
        const dir = makeTmpDir();
        try {
            const result = await publishToPlayground({
                domain: "my-app",
                publishSigner: fakeSigner,
                repositoryUrl: "https://github.com/paritytech/example",
                cwd: dir,
            });

            expect(result.fullDomain).toBe("my-app.paseo");
            expect(result.metadata).toEqual({
                repository: "https://github.com/paritytech/example",
            });
            expect(result.metadataCid).toBe("bafymeta");
            expect(submitAndWatch).toHaveBeenCalledWith(
                expect.objectContaining({ __kind: "store" }),
                bulletinStorageSigner,
            );
            expect(publishTx).toHaveBeenCalledWith(
                "my-app.paseo",
                "bafymeta",
                1,
                {
                    isSome: false,
                    value: "0x0000000000000000000000000000000000000000",
                },
                "",
                false,
                false,
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("omits the repository field when repositoryUrl is null", async () => {
        const result = await publishToPlayground({
            domain: "my-app.paseo",
            publishSigner: fakeSigner,
            repositoryUrl: null,
            cwd: "/definitely/not/a/repo",
        });
        expect(result.metadata).toEqual({});
    });

    it("records the chosen tag in the uploaded metadata JSON", async () => {
        const result = await publishToPlayground({
            domain: "tagged-app",
            publishSigner: fakeSigner,
            repositoryUrl: null,
            tag: "gaming",
            cwd: "/definitely/not/a/repo",
        });
        expect(result.metadata).toEqual({ tag: "gaming" });
    });

    it("inlines README.md when it is present and within the cap", async () => {
        const dir = makeTmpDir();
        try {
            writeFileSync(join(dir, "README.md"), "# Hello\n\nA short readme.");
            const result = await publishToPlayground({
                domain: "readme-app",
                publishSigner: fakeSigner,
                repositoryUrl: "https://example.com/r",
                cwd: dir,
            });
            expect(result.metadata).toEqual({
                repository: "https://example.com/r",
                readme: "# Hello\n\nA short readme.",
            });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("omits readme when README.md exceeds the cap", async () => {
        const dir = makeTmpDir();
        try {
            writeFileSync(join(dir, "README.md"), "x".repeat(README_CAP_BYTES + 1));
            const result = await publishToPlayground({
                domain: "big-readme",
                publishSigner: fakeSigner,
                repositoryUrl: "https://example.com/r",
                cwd: dir,
            });
            expect(result.metadata).toEqual({ repository: "https://example.com/r" });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("passes claimedOwnerH160 through as the dev-signer publish owner argument", async () => {
        await publishToPlayground({
            domain: "claimed-app",
            publishSigner: fakeSigner,
            repositoryUrl: null,
            cwd: "/definitely/not/a/repo",
            claimedOwnerH160: "0x1234567890abcdef1234567890abcdef12345678",
            isDevSigner: true,
        });
        expect(publishTx).toHaveBeenCalledWith(
            "claimed-app.paseo",
            "bafymeta",
            1,
            {
                isSome: true,
                value: "0x1234567890abcdef1234567890abcdef12345678",
            },
            "",
            false,
            true,
        );
    });

    it("passes visibility=0 when isPrivate is true", async () => {
        await publishToPlayground({
            domain: "secret",
            publishSigner: fakeSigner,
            repositoryUrl: "https://example.com/x",
            cwd: "/definitely/not/a/repo",
            isPrivate: true,
        });
        expect(publishTx).toHaveBeenCalledWith(
            "secret.paseo",
            "bafymeta",
            0,
            {
                isSome: false,
                value: "0x0000000000000000000000000000000000000000",
            },
            "",
            false,
            false,
        );
    });

    it("routes dev signer publishes through publish with is_dev_signer=true", async () => {
        await publishToPlayground({
            domain: "modded-by-dev",
            publishSigner: fakeSigner,
            repositoryUrl: "https://github.com/foo/bar",
            cwd: "/definitely/not/a/repo",
            isModdable: true,
            isDevSigner: true,
        });
        expect(publishTx).toHaveBeenCalledWith(
            "modded-by-dev.paseo",
            "bafymeta",
            1,
            {
                isSome: false,
                value: "0x0000000000000000000000000000000000000000",
            },
            "",
            true,
            true,
        );
    });

    it("forwards moddedFrom captured by `dot mod` in dot.json to registry.publish", async () => {
        const dir = makeTmpDir();
        try {
            writeFileSync(join(dir, "dot.json"), JSON.stringify({ moddedFrom: "original.paseo" }));
            await publishToPlayground({
                domain: "my-mod",
                publishSigner: fakeSigner,
                repositoryUrl: null,
                cwd: dir,
            });
            expect(publishTx).toHaveBeenCalledWith(
                "my-mod.paseo",
                "bafymeta",
                1,
                {
                    isSome: false,
                    value: "0x0000000000000000000000000000000000000000",
                },
                "original.paseo",
                false,
                false,
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    // playground-app#335: an SDK/RevX consumer that clones the source itself
    // (skipping the `dot mod` TUI that rewrites `dot.json`) passes the true
    // immediate parent via the `moddedFrom` option. It MUST win over the stale
    // value the cloned repo's `dot.json` carried — otherwise a mod-of-a-mod
    // re-publishes the grandparent and credits the wrong owner.
    it("prefers an explicit moddedFrom option over a stale dot.json value", async () => {
        const dir = makeTmpDir();
        try {
            // Stale value inherited from the cloned source (e.g. tutorial).
            writeFileSync(
                join(dir, "dot.json"),
                JSON.stringify({ moddedFrom: "playground-tutorial.paseo" }),
            );
            const result = await publishToPlayground({
                domain: "my-mod",
                publishSigner: fakeSigner,
                repositoryUrl: null,
                cwd: dir,
                // True immediate parent, known by the caller that did the mod.
                moddedFrom: "steampunk-lizard-spock01.paseo",
            });
            expect(publishTx).toHaveBeenCalledWith(
                "my-mod.paseo",
                "bafymeta",
                1,
                {
                    isSome: false,
                    value: "0x0000000000000000000000000000000000000000",
                },
                "steampunk-lizard-spock01.paseo",
                false,
                false,
            );
            // The explicit value must ALSO drive the metadata JSON, not just the
            // on-chain arg — otherwise the badge and the XP edge disagree.
            expect(result.metadata.moddedFrom).toBe("steampunk-lizard-spock01.paseo");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    // The contract matches lineage on the canonical `<label>.paseo` string, so a
    // caller passing a bare label or trailing `.paseo`-less value must still land
    // on the canonical form — same as the `dot.json` path goes through
    // `normalizeDomain`.
    it("canonicalizes a non-`.paseo` explicit moddedFrom before publishing", async () => {
        const dir = makeTmpDir();
        try {
            const result = await publishToPlayground({
                domain: "my-mod",
                publishSigner: fakeSigner,
                repositoryUrl: null,
                cwd: dir,
                moddedFrom: "steampunk-lizard-spock01",
            });
            expect(publishTx).toHaveBeenCalledWith(
                "my-mod.paseo",
                "bafymeta",
                1,
                {
                    isSome: false,
                    value: "0x0000000000000000000000000000000000000000",
                },
                "steampunk-lizard-spock01.paseo",
                false,
                false,
            );
            expect(result.metadata.moddedFrom).toBe("steampunk-lizard-spock01.paseo");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("falls back to dot.json when the explicit moddedFrom is empty/whitespace", async () => {
        const dir = makeTmpDir();
        try {
            writeFileSync(join(dir, "dot.json"), JSON.stringify({ moddedFrom: "original.paseo" }));
            const result = await publishToPlayground({
                domain: "my-mod",
                publishSigner: fakeSigner,
                repositoryUrl: null,
                cwd: dir,
                moddedFrom: "   ",
            });
            expect(publishTx).toHaveBeenCalledWith(
                "my-mod.paseo",
                "bafymeta",
                1,
                {
                    isSome: false,
                    value: "0x0000000000000000000000000000000000000000",
                },
                "original.paseo",
                false,
                false,
            );
            expect(result.metadata.moddedFrom).toBe("original.paseo");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    // A malformed explicit value is treated as "not provided" (it can't reach
    // on-chain), so it falls through to the `dot.json` value rather than
    // recording garbage or wiping the lineage edge.
    it("falls back to dot.json when the explicit moddedFrom is malformed", async () => {
        const dir = makeTmpDir();
        try {
            writeFileSync(join(dir, "dot.json"), JSON.stringify({ moddedFrom: "original.paseo" }));
            const result = await publishToPlayground({
                domain: "my-mod",
                publishSigner: fakeSigner,
                repositoryUrl: null,
                cwd: dir,
                moddedFrom: "Not A Domain!",
            });
            expect(publishTx).toHaveBeenCalledWith(
                "my-mod.paseo",
                "bafymeta",
                1,
                {
                    isSome: false,
                    value: "0x0000000000000000000000000000000000000000",
                },
                "original.paseo",
                false,
                false,
            );
            expect(result.metadata.moddedFrom).toBe("original.paseo");
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("retries up to 3 times on registry publish failure", async () => {
        publishTx.mockImplementationOnce(async () => {
            throw new Error("nonce race");
        });
        publishTx.mockImplementationOnce(async () => {
            throw new Error("nonce race");
        });
        publishTx.mockImplementationOnce(async () => ({ ok: true, txHash: "0xbeef" }));

        const result = await publishToPlayground({
            domain: "flaky",
            publishSigner: fakeSigner,
            repositoryUrl: "https://example.com/x",
            cwd: "/definitely/not/a/repo",
        });
        expect(publishTx).toHaveBeenCalledTimes(3);
        expect(result.fullDomain).toBe("flaky.paseo");
    }, 30_000);

    it("captures a warning when registry publish retries", async () => {
        publishTx
            .mockRejectedValueOnce(new Error("temporary registry failure"))
            .mockResolvedValueOnce({ ok: true, txHash: "0xdead" });

        await publishToPlayground({
            domain: "my-app.paseo",
            publishSigner: fakeSigner,
            repositoryUrl: null,
            cwd: undefined,
        });

        expect(captureWarningMock).toHaveBeenCalledWith(
            "Playground registry publish failed, retrying",
            expect.objectContaining({
                attempt: 1,
                maxAttempts: 3,
                error: "temporary registry failure",
            }),
        );
    }, 30_000);

    it("wraps metadata upload and registry publish in spans", async () => {
        await publishToPlayground({
            domain: "my-app.paseo",
            publishSigner: fakeSigner,
            repositoryUrl: null,
            cwd: undefined,
        });

        const ops = withSpanMock.mock.calls.map((call) => call[0]);
        expect(ops).toContain("cli.deploy.playground.metadata-upload");
        expect(ops).toContain("cli.deploy.playground.registry-publish");
    });

    it("re-checks Bulletin allowance once when metadata upload fails with Invalid Payment", async () => {
        // tx@0.3 surfaces the Invalid-Payment failure on the `err` channel
        // instead of rejecting; `unwrapTx` re-throws it, so the retry path is
        // driven exactly as before.
        vi.mocked(submitAndWatch)
            .mockResolvedValueOnce({
                ok: false,
                error: new Error('{"type":"Invalid","value":{"type":"Payment"}}'),
            } as Awaited<ReturnType<typeof submitAndWatch>>)
            .mockResolvedValueOnce({
                ok: true,
                value: {
                    txHash: "0x1",
                    ok: true,
                    block: { hash: "0x1", number: 1, index: 0 },
                    events: [],
                },
            });

        await publishToPlayground({
            domain: "my-app.paseo",
            publishSigner: fakeSigner,
            repositoryUrl: null,
            cwd: undefined,
        });

        expect(getBulletinAllowanceSignerMock).toHaveBeenCalledTimes(2);
        expect(submitAndWatch).toHaveBeenCalledTimes(2);
    });

    it("surfaces the last error after exhausting retries", async () => {
        publishTx.mockImplementation(async () => {
            throw new Error("unauthorized");
        });

        await expect(
            publishToPlayground({
                domain: "doomed",
                publishSigner: fakeSigner,
                repositoryUrl: "https://example.com/x",
                cwd: "/definitely/not/a/repo",
            }),
        ).rejects.toThrow(/unauthorized/);
    }, 30_000);

    it("fails fast on a deterministic contract revert — surfaces the reason, no retries", async () => {
        // A revert (decoded `.reason`) is deterministic; the retry loop must NOT
        // burn 3 attempts on it. publishTx is called exactly once and the reason
        // is surfaced verbatim.
        publishTx.mockReset();
        publishTx.mockResolvedValue({ ok: false, error: { reason: "NotRevealed" } } as any);

        await expect(
            publishToPlayground({
                domain: "reverts",
                publishSigner: fakeSigner,
                repositoryUrl: null,
                cwd: "/definitely/not/a/repo",
            }),
        ).rejects.toThrow(/reverted: NotRevealed/);
        expect(publishTx).toHaveBeenCalledTimes(1);
    });
});
