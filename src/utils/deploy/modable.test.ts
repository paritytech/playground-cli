import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    decideRepositoryAction,
    resolveRepositoryUrl,
    assertPublicGitHubRepo,
    ModablePreflightError,
} from "./modable.js";

describe("decideRepositoryAction", () => {
    it("uses the existing origin when present", () => {
        expect(
            decideRepositoryAction({ originUrl: "https://github.com/foo/bar", repoName: null }),
        ).toEqual({ kind: "use-origin", url: "https://github.com/foo/bar" });
    });

    it("creates a new repo when origin is absent and a repo name is provided", () => {
        expect(decideRepositoryAction({ originUrl: null, repoName: "my-app" })).toEqual({
            kind: "create",
            repoName: "my-app",
        });
    });

    it("rejects when origin is absent and no repo name was supplied", () => {
        expect(decideRepositoryAction({ originUrl: null, repoName: null })).toEqual({
            kind: "needs-repo-name",
        });
    });

    it("normalises trailing .git off existing origins", () => {
        expect(
            decideRepositoryAction({
                originUrl: "https://github.com/foo/bar.git",
                repoName: null,
            }),
        ).toEqual({ kind: "use-origin", url: "https://github.com/foo/bar" });
    });
});

describe("assertPublicGitHubRepo", () => {
    it("does nothing for a public repo", async () => {
        const mockFetch: typeof fetch = async () =>
            new Response(JSON.stringify({ private: false }), { status: 200 });
        await expect(
            assertPublicGitHubRepo("https://github.com/foo/bar", mockFetch),
        ).resolves.toBeUndefined();
    });

    it("throws for a private repo (API reports private: true)", async () => {
        const mockFetch: typeof fetch = async () =>
            new Response(JSON.stringify({ private: true }), { status: 200 });
        await expect(
            assertPublicGitHubRepo("https://github.com/org/secret", mockFetch),
        ).rejects.toThrow(ModablePreflightError);
    });

    it("throws for a 404 response (private or missing)", async () => {
        const mockFetch: typeof fetch = async () => new Response("Not Found", { status: 404 });
        await expect(
            assertPublicGitHubRepo("https://github.com/org/ghost", mockFetch),
        ).rejects.toThrow(/private or does not exist/i);
    });

    it("throws for a 401 response", async () => {
        const mockFetch: typeof fetch = async () => new Response("Unauthorized", { status: 401 });
        await expect(
            assertPublicGitHubRepo("https://github.com/org/ghost", mockFetch),
        ).rejects.toThrow(ModablePreflightError);
    });

    it("does nothing for a non-GitHub URL", async () => {
        const mockFetch: typeof fetch = async () => {
            throw new Error("should not be called");
        };
        await expect(
            assertPublicGitHubRepo("https://gitlab.com/foo/bar", mockFetch),
        ).resolves.toBeUndefined();
    });

    it("does nothing on network error (fail open)", async () => {
        const mockFetch: typeof fetch = async () => {
            throw new Error("ECONNREFUSED");
        };
        await expect(
            assertPublicGitHubRepo("https://github.com/foo/bar", mockFetch),
        ).resolves.toBeUndefined();
    });

    it("skips check for rate-limit (403) responses", async () => {
        const mockFetch: typeof fetch = async () => new Response("rate limited", { status: 403 });
        await expect(
            assertPublicGitHubRepo("https://github.com/foo/bar", mockFetch),
        ).resolves.toBeUndefined();
    });
});

describe("resolveRepositoryUrl", () => {
    let tmp: string | null = null;

    afterEach(() => {
        if (tmp) rmSync(tmp, { recursive: true, force: true });
        tmp = null;
    });

    const publicFetch: typeof fetch = async () =>
        new Response(JSON.stringify({ private: false }), { status: 200 });
    const privateFetch: typeof fetch = async () =>
        new Response(JSON.stringify({ private: true }), { status: 200 });

    it("uses an existing origin without pushing", async () => {
        tmp = mkdtempSync(join(tmpdir(), "pg-modable-origin-"));
        execFileSync("git", ["init"], { cwd: tmp, stdio: "ignore" });
        execFileSync("git", ["remote", "add", "origin", "git@github.com:foo/bar.git"], {
            cwd: tmp,
            stdio: "ignore",
        });

        await expect(
            resolveRepositoryUrl({ cwd: tmp, repoName: null, fetch: publicFetch }),
        ).resolves.toBe("git@github.com:foo/bar");
    });

    it("throws when the existing origin is a private GitHub repo", async () => {
        tmp = mkdtempSync(join(tmpdir(), "pg-modable-private-"));
        execFileSync("git", ["init"], { cwd: tmp, stdio: "ignore" });
        execFileSync("git", ["remote", "add", "origin", "https://github.com/org/secret.git"], {
            cwd: tmp,
            stdio: "ignore",
        });

        await expect(
            resolveRepositoryUrl({ cwd: tmp, repoName: null, fetch: privateFetch }),
        ).rejects.toThrow(ModablePreflightError);
    });
});
