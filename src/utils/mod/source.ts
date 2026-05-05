/**
 * GitHub-only source acquisition for `dot mod`.
 *
 * Downloads a public repo's source via `codeload.github.com` (no auth, no
 * git binary needed) and extracts into a target directory. RevX-importable
 * — no React/Ink imports.
 */

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { extract } from "tar";

export interface GitHubRepoRef {
    owner: string;
    repo: string;
}

export function parseGitHubRepoUrl(url: string): GitHubRepoRef | null {
    if (!url) return null;
    const trimmed = url
        .trim()
        .replace(/\.git$/, "")
        .replace(/\/$/, "");
    const m = trimmed.match(/^(?:https?:\/\/github\.com\/|git@github\.com:)([^/]+)\/([^/]+)$/);
    if (!m) return null;
    return { owner: m[1], repo: m[2] };
}

interface FetchOpts {
    fetch?: typeof fetch;
}

export async function resolveDefaultBranch(
    ref: GitHubRepoRef,
    opts: FetchOpts = {},
): Promise<string> {
    const f = opts.fetch ?? fetch;
    let apiStatus: number | undefined;
    try {
        const res = await f(`https://api.github.com/repos/${ref.owner}/${ref.repo}`);
        apiStatus = res.status;
        if (res.ok) {
            const body = (await res.json()) as { default_branch?: string };
            if (body.default_branch) return body.default_branch;
        }
    } catch {
        // network error — fall through to the heuristic probes
    }
    for (const candidate of ["main", "master"]) {
        try {
            const probe = await f(`https://github.com/${ref.owner}/${ref.repo}/tree/${candidate}`);
            if (probe.ok) return candidate;
        } catch {
            // try next
        }
    }
    if (apiStatus === 404 || apiStatus === 401) {
        throw new Error(
            `Repository ${ref.owner}/${ref.repo} is private or does not exist — dot mod only supports public repositories`,
        );
    }
    throw new Error(
        `Could not resolve a default branch for ${ref.owner}/${ref.repo} — pin one in metadata.branch`,
    );
}

export interface DownloadOpts {
    owner: string;
    repo: string;
    branch: string;
    targetDir: string;
}

export async function downloadGitHubTarball(
    opts: DownloadOpts,
    fetchOpts: FetchOpts = {},
): Promise<void> {
    if (existsSync(opts.targetDir) && readdirSync(opts.targetDir).length > 0) {
        throw new Error(`Directory "${opts.targetDir}" already exists`);
    }
    mkdirSync(opts.targetDir, { recursive: true });

    const f = fetchOpts.fetch ?? fetch;
    const url = `https://codeload.github.com/${opts.owner}/${opts.repo}/tar.gz/refs/heads/${opts.branch}`;
    const res = await f(url);
    if (!res.ok || !res.body) {
        throw new Error(`Failed to download ${url}: ${res.status} ${res.statusText}`);
    }

    const nodeStream = Readable.fromWeb(res.body as unknown as import("stream/web").ReadableStream);
    // `pipeline` rejects on any stream error and auto-destroys every stream
    // in the chain on failure — so a network drop, a corrupted gzip stream,
    // or a tar parse error all propagate cleanly without leaking the open
    // socket or buffered chunks. Hand-rolled `.pipe()` chains miss this:
    // attaching `.on("error")` to only the last stream lets an upstream
    // error bubble up as `unhandledRejection` while the promise hangs.
    await pipeline(nodeStream, createGunzip(), extract({ cwd: opts.targetDir, strip: 1 }));
}
