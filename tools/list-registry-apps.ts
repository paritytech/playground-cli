#!/usr/bin/env bun

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
 * Enumerate apps on the live playground-registry contract on Paseo Asset Hub,
 * and check whether each one's `metadata.repository` is reachable as a public
 * GitHub repo. Useful for picking a stable e2e test target for `dot mod`.
 *
 * Usage:
 *   bun tools/list-registry-apps.ts
 */

import type { HexString } from "polkadot-api";
import { fetchBulletinJson, getBulletinGateway } from "../src/utils/bulletinGateway.js";
import { getConnection, destroyConnection } from "../src/utils/connection.js";
import { getReadOnlyRegistryContract } from "../src/utils/registry.js";

interface AppMetadata {
    name?: string;
    description?: string;
    repository?: string;
    branch?: string;
}

interface RegistryEntry {
    domain: string;
    metadata_uri: string;
    owner: HexString;
}

async function probePublicGithub(repoUrl: string): Promise<{ ok: boolean; status: number }> {
    const match = repoUrl.match(/github\.com[:/]+([^/]+)\/([^/.]+)/);
    if (!match) return { ok: false, status: 0 };
    const [, owner, repo] = match;
    // HEAD on the HTML page rather than a GET on `api.github.com` — same
    // 200/404 signal, but doesn't consume GitHub's 60/hour anonymous-IP
    // API quota. Mirrors `src/utils/deploy/moddable.ts::assertPublicGitHubRepo`
    // so a maintainer running this tool burns the same kind of probe their
    // CLI does at moddable-preflight time.
    const res = await fetch(`https://github.com/${owner}/${repo}`, { method: "HEAD" });
    return { ok: res.ok, status: res.status };
}

async function main(): Promise<number> {
    const client = await getConnection();
    try {
        const registry = await getReadOnlyRegistryContract(client.raw.assetHub);

        const res = await registry.getApps.query(0, 100);
        if (!res.success) {
            throw new Error(`getApps dry-run was rejected: ${JSON.stringify(res.value)}`);
        }
        const value = res.value as { entries: RegistryEntry[]; total: number };
        console.log(`live registry has ${value.total} app(s); inspecting up to 100:\n`);

        const gateway = getBulletinGateway();
        for (const entry of value.entries) {
            let meta: AppMetadata = {};
            let metaErr = "";
            try {
                meta = await fetchBulletinJson<AppMetadata>(entry.metadata_uri, gateway);
            } catch (e) {
                metaErr = e instanceof Error ? e.message.slice(0, 60) : String(e).slice(0, 60);
            }
            const repo = meta.repository ?? "";
            let probe = "—";
            if (repo) {
                try {
                    const r = await probePublicGithub(repo);
                    probe = r.ok ? "PUBLIC ✓" : `${r.status}`;
                } catch {
                    probe = "fetch-err";
                }
            }
            console.log(
                `  ${entry.domain.padEnd(36)}  repo=${(repo || metaErr || "<no repo>").padEnd(60)}  github=${probe}`,
            );
        }
        return 0;
    } finally {
        destroyConnection();
    }
}

main()
    .then((code) => process.exit(code))
    .catch((err) => {
        console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
        process.exit(2);
    });
