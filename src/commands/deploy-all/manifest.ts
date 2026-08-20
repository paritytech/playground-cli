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

/**
 * Parsing + validation for the `playground deploy-all` manifest file.
 *
 * The manifest is a small JSON document listing the apps to deploy in one
 * invocation. Shared options (signer mode, env, publish flags) come from CLI
 * flags; the manifest carries only the per-app fields (`name`, `dir`, `domain`,
 * `buildDir`). Kept as pure functions so it can be unit-tested without I/O.
 *
 * Example:
 *
 *   {
 *     "apps": [
 *       { "name": "arcade",       "dir": "apps/arcade",       "domain": "arcade" },
 *       { "name": "arcade-snake", "dir": "apps/arcade-snake", "domain": "arcade-snake" }
 *     ]
 *   }
 */

import { getEnvTld } from "../../config.js";

export interface ManifestApp {
    /** Stable identifier surfaced in output (defaults to `domain` if omitted). */
    name: string;
    /** Project directory, resolved relative to the manifest file's directory. */
    dir: string;
    /** DotNS label (with or without the env TLD suffix). */
    domain: string;
    /** Build-output directory relative to `dir`. Falls back to the shared flag. */
    buildDir?: string;
    /** Per-app override for skipping the build. Falls back to the shared flag. */
    skipBuild?: boolean;
}

export interface ParsedManifest {
    apps: ManifestApp[];
}

/**
 * Parse and validate a manifest from its raw JSON text. Throws a single,
 * actionable error on the first problem found — the caller is non-interactive,
 * so a clear message beats a partial deploy of a malformed list.
 */
export function parseManifest(raw: string): ParsedManifest {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        throw new Error(
            `Manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error('Manifest must be a JSON object with an "apps" array.');
    }
    const appsRaw = (parsed as Record<string, unknown>).apps;
    if (!Array.isArray(appsRaw) || appsRaw.length === 0) {
        throw new Error('Manifest "apps" must be a non-empty array.');
    }

    const seenDomains = new Set<string>();
    const apps: ManifestApp[] = appsRaw.map((entry, i) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
            throw new Error(`Manifest apps[${i}] must be an object.`);
        }
        const obj = entry as Record<string, unknown>;
        const dir = requireString(obj.dir, `apps[${i}].dir`);
        const domain = requireString(obj.domain, `apps[${i}].domain`);
        const name = typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : domain;
        const buildDir = optionalString(obj.buildDir, `apps[${i}].buildDir`);
        const skipBuild = optionalBoolean(obj.skipBuild, `apps[${i}].skipBuild`);

        // Two apps writing the same DotNS name in one batch would race on the
        // exact resource the signing gate exists to protect, and the second
        // would just overwrite the first — almost certainly a manifest typo.
        // Strip the env TLD before comparing so "app" and "app.<tld>" (which
        // deploy to the same name) are caught as duplicates.
        const normalizedDomain = domain
            .replace(new RegExp(`\\.${getEnvTld()}$`, "i"), "")
            .toLowerCase();
        if (seenDomains.has(normalizedDomain)) {
            throw new Error(`Manifest has a duplicate domain "${domain}".`);
        }
        seenDomains.add(normalizedDomain);

        const app: ManifestApp = { name, dir, domain };
        if (buildDir !== undefined) app.buildDir = buildDir;
        if (skipBuild !== undefined) app.skipBuild = skipBuild;
        return app;
    });

    return { apps };
}

function requireString(value: unknown, field: string): string {
    if (typeof value !== "string" || !value.trim()) {
        throw new Error(`Manifest ${field} must be a non-empty string.`);
    }
    return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
    if (value === undefined) return undefined;
    return requireString(value, field);
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "boolean") {
        throw new Error(`Manifest ${field} must be a boolean.`);
    }
    return value;
}
