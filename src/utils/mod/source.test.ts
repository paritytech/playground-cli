import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create as tarCreate } from "tar";
import { createGzip } from "node:zlib";
import { Readable } from "node:stream";
import { parseGitHubRepoUrl, resolveDefaultBranch, downloadGitHubTarball } from "./source.js";

describe("parseGitHubRepoUrl", () => {
    it("parses https github URL", () => {
        expect(parseGitHubRepoUrl("https://github.com/foo/bar")).toEqual({
            owner: "foo",
            repo: "bar",
        });
    });

    it("parses https github URL with .git suffix", () => {
        expect(parseGitHubRepoUrl("https://github.com/foo/bar.git")).toEqual({
            owner: "foo",
            repo: "bar",
        });
    });

    it("parses ssh github URL", () => {
        expect(parseGitHubRepoUrl("git@github.com:foo/bar.git")).toEqual({
            owner: "foo",
            repo: "bar",
        });
    });

    it("parses URL with trailing slash", () => {
        expect(parseGitHubRepoUrl("https://github.com/foo/bar/")).toEqual({
            owner: "foo",
            repo: "bar",
        });
    });

    it("returns null for non-GitHub URLs", () => {
        expect(parseGitHubRepoUrl("https://gitlab.com/foo/bar")).toBeNull();
    });

    it("returns null for malformed input", () => {
        expect(parseGitHubRepoUrl("not a url")).toBeNull();
        expect(parseGitHubRepoUrl("https://github.com/foo")).toBeNull();
        expect(parseGitHubRepoUrl("")).toBeNull();
    });
});

describe("resolveDefaultBranch", () => {
    it("returns the API's default_branch when reachable", async () => {
        const fetchImpl: typeof fetch = async (url) => {
            expect(String(url)).toBe("https://api.github.com/repos/foo/bar");
            return new Response(JSON.stringify({ default_branch: "develop" }), { status: 200 });
        };
        const branch = await resolveDefaultBranch(
            { owner: "foo", repo: "bar" },
            { fetch: fetchImpl },
        );
        expect(branch).toBe("develop");
    });

    it("falls back to main when API GET fails and main exists", async () => {
        const fetchImpl: typeof fetch = async (url) => {
            const u = String(url);
            if (u.startsWith("https://api.github.com"))
                return new Response("rate limit", { status: 403 });
            if (u === "https://github.com/foo/bar/tree/main")
                return new Response("ok", { status: 200 });
            return new Response("not found", { status: 404 });
        };
        const branch = await resolveDefaultBranch(
            { owner: "foo", repo: "bar" },
            { fetch: fetchImpl },
        );
        expect(branch).toBe("main");
    });

    it("falls back to master when neither API nor main works", async () => {
        const fetchImpl: typeof fetch = async (url) => {
            const u = String(url);
            if (u.startsWith("https://api.github.com")) return new Response("err", { status: 500 });
            if (u === "https://github.com/foo/bar/tree/main")
                return new Response("nf", { status: 404 });
            if (u === "https://github.com/foo/bar/tree/master")
                return new Response("ok", { status: 200 });
            return new Response("nope", { status: 404 });
        };
        const branch = await resolveDefaultBranch(
            { owner: "foo", repo: "bar" },
            { fetch: fetchImpl },
        );
        expect(branch).toBe("master");
    });

    it("throws when nothing resolves", async () => {
        const fetchImpl: typeof fetch = async () => new Response("err", { status: 500 });
        await expect(
            resolveDefaultBranch({ owner: "foo", repo: "bar" }, { fetch: fetchImpl }),
        ).rejects.toThrow(/could not resolve a default branch/i);
    });

    it("throws a private-or-missing error when the API returns 404 and probes fail", async () => {
        const fetchImpl: typeof fetch = async () => new Response("Not Found", { status: 404 });
        await expect(
            resolveDefaultBranch({ owner: "foo", repo: "bar" }, { fetch: fetchImpl }),
        ).rejects.toThrow(/private or does not exist/i);
    });

    it("throws a private-or-missing error when the API returns 401 and probes fail", async () => {
        const fetchImpl: typeof fetch = async (url) => {
            if (String(url).startsWith("https://api.github.com"))
                return new Response("Unauthorized", { status: 401 });
            return new Response("Not Found", { status: 404 });
        };
        await expect(
            resolveDefaultBranch({ owner: "foo", repo: "bar" }, { fetch: fetchImpl }),
        ).rejects.toThrow(/private or does not exist/i);
    });
});

describe("downloadGitHubTarball", () => {
    let stage: string;
    let target: string;
    beforeEach(() => {
        stage = mkdtempSync(join(tmpdir(), "src-stage-"));
        target = mkdtempSync(join(tmpdir(), "src-target-"));
        rmSync(target, { recursive: true, force: true });
    });
    afterEach(() => {
        rmSync(stage, { recursive: true, force: true });
        rmSync(target, { recursive: true, force: true });
    });

    it("extracts a codeload-style tarball into the target dir, stripping the wrapper", async () => {
        const wrapper = "bar-abc1234";
        mkdirSync(join(stage, wrapper, "src"), { recursive: true });
        writeFileSync(join(stage, wrapper, "README.md"), "hi\n");
        writeFileSync(join(stage, wrapper, "src", "main.ts"), "export {};\n");

        const tarStream = tarCreate({ cwd: stage, gzip: false }, [wrapper]).pipe(createGzip());
        const webStream = Readable.toWeb(tarStream as unknown as Readable);

        const fetchImpl: typeof fetch = async (url) => {
            expect(String(url)).toBe("https://codeload.github.com/foo/bar/tar.gz/refs/heads/main");
            return new Response(webStream as unknown as ReadableStream, { status: 200 });
        };

        await downloadGitHubTarball(
            { owner: "foo", repo: "bar", branch: "main", targetDir: target },
            { fetch: fetchImpl },
        );

        expect(existsSync(join(target, "README.md"))).toBe(true);
        expect(readFileSync(join(target, "README.md"), "utf8")).toBe("hi\n");
        expect(existsSync(join(target, "src", "main.ts"))).toBe(true);
        expect(existsSync(join(target, wrapper))).toBe(false);
    });

    it("rejects when the response is non-2xx", async () => {
        const fetchImpl: typeof fetch = async () => new Response("nf", { status: 404 });
        await expect(
            downloadGitHubTarball(
                { owner: "foo", repo: "bar", branch: "x", targetDir: target },
                { fetch: fetchImpl },
            ),
        ).rejects.toThrow(/404/);
    });

    it("refuses to overwrite an existing target directory", async () => {
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, "preexisting"), "x");
        const fetchImpl: typeof fetch = async () => new Response("ok", { status: 200 });
        await expect(
            downloadGitHubTarball(
                { owner: "foo", repo: "bar", branch: "main", targetDir: target },
                { fetch: fetchImpl },
            ),
        ).rejects.toThrow(/already exists/i);
    });
});
