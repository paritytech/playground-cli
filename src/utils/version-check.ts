import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fetchLatestTag } from "../commands/update.js";

interface VersionCache {
    latest_version: string;
    last_checked: string;
}

/**
 * Returns the path to the version cache file.
 * Lives alongside other playground state in ~/.polkadot/
 */
export function getCachePath(env: NodeJS.ProcessEnv = process.env): string {
    const home = env.HOME;
    if (!home) return "";
    return resolve(home, ".polkadot", "playground-cli.json");
}

/**
 * Reads the cached latest version from disk.
 * Returns null if the file doesn't exist or is corrupted.
 */
export function readCachedVersion(cachePath: string): VersionCache | null {
    try {
        const raw = readFileSync(cachePath, "utf-8");
        const parsed = JSON.parse(raw) as Partial<VersionCache>;
        if (typeof parsed.latest_version === "string" && parsed.latest_version) {
            return {
                latest_version: parsed.latest_version,
                last_checked: parsed.last_checked ?? "",
            };
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Writes the latest version to the cache file.
 */
export function writeCachedVersion(cachePath: string, version: string): void {
    try {
        const dir = resolve(cachePath, "..");
        mkdirSync(dir, { recursive: true });
        const data: VersionCache = {
            latest_version: version,
            last_checked: new Date().toISOString(),
        };
        writeFileSync(cachePath, JSON.stringify(data, null, 2), "utf-8");
    } catch {
        // Silent fail — cache is best-effort
    }
}

/**
 * Normalizes a version tag to a comparable string.
 * "v0.16.14" → "0.16.14", "0.16.14" → "0.16.14"
 */
export function normalizeVersion(v: string): string {
    return v.replace(/^v/, "");
}

/**
 * Returns true if the current version is behind the latest.
 */
export function isOutdated(current: string, latest: string): boolean {
    const c = normalizeVersion(current);
    const l = normalizeVersion(latest);
    if (c === l) return false;

    const cp = c.split(".").map(Number);
    const lp = l.split(".").map(Number);

    for (let i = 0; i < Math.max(cp.length, lp.length); i++) {
        const cv = cp[i] ?? 0;
        const lv = lp[i] ?? 0;
        if (cv < lv) return true;
        if (cv > lv) return false;
    }
    return false;
}

/**
 * Prints an update warning if the CLI is behind the cached latest version.
 * Kicks off a background fetch to refresh the cache for next run.
 * Returns immediately — never blocks the command.
 */
export function checkForUpdates(currentVersion: string): void {
    const cachePath = getCachePath();
    if (!cachePath) return;

    // 1. Check cached version (sync, fast — local file read)
    const cached = readCachedVersion(cachePath);
    if (cached && isOutdated(currentVersion, cached.latest_version)) {
        const latest = cached.latest_version.startsWith("v")
            ? cached.latest_version
            : `v${cached.latest_version}`;
        process.stderr.write(
            `\n  ⚠  Update available: v${normalizeVersion(currentVersion)} → ${latest}\n` +
                `     Run \x1b[1mdot update\x1b[0m to upgrade.\n\n`,
        );
    }

    // 2. Refresh cache in the background (async, non-blocking)
    _pendingRefresh = fetchLatestTag()
        .then((tag) => writeCachedVersion(cachePath, tag))
        .catch(() => {
            // Silent fail — no network is fine, we'll try next time
        });
}

/** In-flight background refresh, if any. */
let _pendingRefresh: Promise<void> | null = null;

/**
 * Waits briefly for the background version-cache refresh to land.
 * Called once in the shutdown path so quick commands (--help, --version)
 * still get a chance to persist the latest tag. A 2 s cap ensures we
 * never visibly delay exit.
 */
export async function flushVersionCheck(timeoutMs = 2000): Promise<void> {
    if (!_pendingRefresh) return;
    await Promise.race([_pendingRefresh, new Promise((r) => setTimeout(r, timeoutMs))]);
    _pendingRefresh = null;
}
