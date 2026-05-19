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

import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface MirrorOptions {
    /** http(s) URL to mirror. Other schemes are rejected. */
    url: string;
    /** Optional callback for streaming wget output, one line at a time. */
    onLine?: (line: string) => void;
}

export interface MirrorResult {
    /** Absolute path to the temp directory containing the mirrored site. */
    directory: string;
    /** Number of files written under `directory`. */
    fileCount: number;
}

export class WgetMissingError extends Error {
    constructor() {
        super(
            "wget is required to mirror sites but was not found on PATH. " +
                "Install it via `brew install wget` (macOS) or your package manager.",
        );
        this.name = "WgetMissingError";
    }
}

export class InvalidSiteUrlError extends Error {
    constructor(url: string, reason: string) {
        super(`Invalid --site URL "${url}": ${reason}`);
        this.name = "InvalidSiteUrlError";
    }
}

function validateUrl(input: string): string {
    let parsed: URL;
    try {
        parsed = new URL(input);
    } catch {
        // Allow shorthand like "shawntabrizi.github.io" by adding https://.
        try {
            parsed = new URL(`https://${input}`);
        } catch {
            throw new InvalidSiteUrlError(input, "not a parseable URL");
        }
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new InvalidSiteUrlError(input, `unsupported scheme ${parsed.protocol}`);
    }
    return parsed.toString();
}

function countFiles(root: string): number {
    let count = 0;
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir)) {
            const full = join(dir, entry);
            const st = statSync(full);
            if (st.isDirectory()) walk(full);
            else if (st.isFile()) count++;
        }
    };
    try {
        walk(root);
    } catch {
        // ignore — caller validates non-empty via the returned count.
    }
    return count;
}

/**
 * Mirror a live HTTP(S) static site into a fresh temp directory using `wget`.
 *
 * Flags chosen for "useful default for static sites":
 *   --mirror              recursive download + timestamping + infinite depth
 *   --convert-links       rewrite absolute → relative so the local copy renders
 *   --adjust-extension    add .html so links resolve from a flat filesystem
 *   --page-requisites     pull CSS/JS/images that pages reference
 *   --no-parent           don't climb above the URL's directory
 *   --no-host-directories drop the hostname segment from the output path
 *   --no-verbose          one progress line per file; not silent so onLine works
 *
 * URL safety: passed as a separate execve argument, never spliced into a shell
 * string, so a malicious URL cannot inject other flags or shell metacharacters.
 */
export async function mirrorSite(options: MirrorOptions): Promise<MirrorResult> {
    const url = validateUrl(options.url);
    const directory = mkdtempSync(join(tmpdir(), "dot-decentralize-"));

    const args = [
        "--mirror",
        "--convert-links",
        "--adjust-extension",
        "--page-requisites",
        "--no-parent",
        "--no-host-directories",
        "--no-verbose",
        `--directory-prefix=${directory}`,
        url,
    ];

    await new Promise<void>((resolve, reject) => {
        const proc = spawn("wget", args, { stdio: ["ignore", "pipe", "pipe"] });

        proc.on("error", (err: NodeJS.ErrnoException) => {
            if (err.code === "ENOENT") reject(new WgetMissingError());
            else reject(err);
        });

        const forward = (chunk: Buffer) => {
            if (!options.onLine) return;
            for (const line of chunk.toString("utf8").split("\n")) {
                if (line.trim()) options.onLine(line);
            }
        };
        proc.stdout?.on("data", forward);
        proc.stderr?.on("data", forward);

        proc.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`wget failed (exit ${code}) — site may be unreachable`));
        });
    });

    const fileCount = countFiles(directory);
    if (fileCount === 0) {
        throw new Error(
            `wget completed but no files were downloaded from ${url}. The site may be empty or block crawlers.`,
        );
    }
    return { directory, fileCount };
}
