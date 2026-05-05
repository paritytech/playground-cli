import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import {
    isOutdated,
    normalizeVersion,
    readCachedVersion,
    writeCachedVersion,
    getCachePath,
} from "./version-check.js";

describe("normalizeVersion", () => {
    it("strips leading v", () => {
        expect(normalizeVersion("v0.16.14")).toBe("0.16.14");
    });

    it("leaves bare version unchanged", () => {
        expect(normalizeVersion("0.16.14")).toBe("0.16.14");
    });
});

describe("isOutdated", () => {
    it("returns false when versions are equal", () => {
        expect(isOutdated("0.16.14", "0.16.14")).toBe(false);
    });

    it("returns false when versions are equal with v prefix", () => {
        expect(isOutdated("v0.16.14", "v0.16.14")).toBe(false);
    });

    it("returns true when patch is behind", () => {
        expect(isOutdated("0.16.14", "0.16.15")).toBe(true);
    });

    it("returns true when minor is behind", () => {
        expect(isOutdated("0.16.14", "0.17.0")).toBe(true);
    });

    it("returns true when major is behind", () => {
        expect(isOutdated("0.16.14", "1.0.0")).toBe(true);
    });

    it("returns false when current is ahead", () => {
        expect(isOutdated("0.17.0", "0.16.14")).toBe(false);
    });

    it("handles mixed v prefixes", () => {
        expect(isOutdated("v0.16.14", "0.16.15")).toBe(true);
    });
});

describe("readCachedVersion", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = resolve(tmpdir(), `version-check-test-${Date.now()}`);
        mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it("returns null for missing file", () => {
        expect(readCachedVersion(resolve(tmpDir, "nope.json"))).toBeNull();
    });

    it("returns null for corrupted JSON", () => {
        const p = resolve(tmpDir, "bad.json");
        writeFileSync(p, "not json");
        expect(readCachedVersion(p)).toBeNull();
    });

    it("returns null for JSON without latest_version", () => {
        const p = resolve(tmpDir, "empty.json");
        writeFileSync(p, JSON.stringify({ foo: "bar" }));
        expect(readCachedVersion(p)).toBeNull();
    });

    it("reads a valid cache file", () => {
        const p = resolve(tmpDir, "good.json");
        writeFileSync(p, JSON.stringify({ latest_version: "v0.17.0", last_checked: "2026-05-04" }));
        const result = readCachedVersion(p);
        expect(result).not.toBeNull();
        expect(result!.latest_version).toBe("v0.17.0");
    });
});

describe("writeCachedVersion", () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = resolve(tmpdir(), `version-check-write-${Date.now()}`);
        mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
        rmSync(tmpDir, { recursive: true, force: true });
    });

    it("writes a cache file that can be read back", () => {
        const p = resolve(tmpDir, "cache.json");
        writeCachedVersion(p, "v0.17.0");
        const result = readCachedVersion(p);
        expect(result).not.toBeNull();
        expect(result!.latest_version).toBe("v0.17.0");
        expect(result!.last_checked).toBeTruthy();
    });

    it("creates parent directories", () => {
        const p = resolve(tmpDir, "nested", "deep", "cache.json");
        writeCachedVersion(p, "v1.0.0");
        const result = readCachedVersion(p);
        expect(result).not.toBeNull();
        expect(result!.latest_version).toBe("v1.0.0");
    });
});

describe("getCachePath", () => {
    it("returns empty string when HOME is not set", () => {
        expect(getCachePath({ HOME: undefined } as NodeJS.ProcessEnv)).toBe("");
    });

    it("returns path under ~/.polkadot/", () => {
        const result = getCachePath({ HOME: "/Users/test" } as NodeJS.ProcessEnv);
        expect(result).toBe("/Users/test/.polkadot/playground-cli.json");
    });
});
