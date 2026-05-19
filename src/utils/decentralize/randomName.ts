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

import { randomBytes } from "node:crypto";
import { checkDomainAvailability, type AvailabilityResult } from "../deploy/availability.js";
import type { Env } from "../../config.js";

/**
 * Label-generation rules (see `availability.ts::classifyLabel`):
 *
 *   - `baseLength >= 9` + exactly 2 trailing digits → `POP_STATUS_NO_STATUS`
 *     (any signer, no personhood credential)
 *   - More than 2 trailing digits → `POP_STATUS_RESERVED` (unregistrable)
 *   - Base <= 5 chars → reserved for governance
 *
 * We aim for NoStatus so a fresh //Bob demo or any user without PoP can
 * register the name. The variable middle uses lowercase letters only (no
 * digits) so the "exactly 2 trailing digits" invariant holds no matter where
 * the RNG lands — the earlier hex-suffix design could produce >2 trailing
 * digits ~62 % of the time, silently rejected by the retry loop as RESERVED.
 */

const MIN_BASE_LEN = 9;
const MIN_LETTERS = 4;
const FALLBACK_PREFIX = "decent-";
/** Cap the derived host segment so the final label stays well under DNS's 63-char ceiling. */
const MAX_HOST_LEN = 30;

/**
 * Sanitise a site URL into a domain-safe prefix derived from its hostname.
 * Returns null if no usable base can be extracted; callers fall back to
 * `FALLBACK_PREFIX`.
 *
 * We deliberately do NOT strip TLDs, public suffixes, or `www.` — they're
 * part of the URL the user typed and we want the auto-generated name to be a
 * predictable transliteration of it. Stripping `.com` requires a Public
 * Suffix List to handle `co.uk`/`github.io`/`vercel.app` correctly, which is
 * a dep we don't want. Users who want a clean name pass `--dot=<name>`.
 *
 *   https://www.shawntabrizi.com/blog  →  www-shawntabrizi-com
 *   https://example.com:8080            →  example-com
 *   https://shawntabrizi.github.io      →  shawntabrizi-github-io
 *   https://example.co.uk               →  example-co-uk
 *   https://x.com                       →  x-com
 *   https://garbage://                  →  null
 */
function deriveBase(siteUrl: string): string | null {
    let parsed: URL;
    try {
        parsed = new URL(siteUrl);
    } catch {
        try {
            parsed = new URL(`https://${siteUrl}`);
        } catch {
            return null;
        }
    }

    let s = parsed.hostname
        .toLowerCase()
        .replace(/\./g, "-")
        .replace(/[^a-z0-9-]/g, "");
    s = s.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
    if (!s) return null;

    // `normalizeDomain` (playground.ts) requires `^[a-z0-9]` as first char.
    if (!/^[a-z0-9]/.test(s)) return null;

    if (s.length > MAX_HOST_LEN) s = s.slice(0, MAX_HOST_LEN).replace(/-+$/, "");

    return s || null;
}

/**
 * Generate one candidate label. Each call produces fresh randomness, so the
 * retry loop in `findAvailableRandomName` can resolve collisions.
 *
 *   generateLabel("https://shawntabrizi.com")  →  "shawntabrizi-com-abcd42"
 *   generateLabel("https://x.com")              →  "x-com-abcd42"
 *   generateLabel(undefined)                    →  "decent-abcd42"
 */
export function generateLabel(siteUrl?: string): string {
    const base = siteUrl ? deriveBase(siteUrl) : null;
    const prefix = base ? `${base}-` : FALLBACK_PREFIX;

    // Pad with lowercase letters so prefix + letters >= MIN_BASE_LEN.
    const lettersLen = Math.max(MIN_LETTERS, MIN_BASE_LEN - prefix.length);
    const letters = Array.from(randomBytes(lettersLen))
        .map((b) => String.fromCharCode(97 + (b % 26)))
        .join("");

    const digits = String((randomBytes(1)[0] % 90) + 10); // 10..99

    return `${prefix}${letters}${digits}`;
}

export interface FindAvailableNameOptions {
    env?: Env;
    ownerSs58Address?: string;
    /**
     * URL of the site being decentralized. When provided, the generated
     * candidates start with a sanitised version of the hostname (e.g.
     * `shawntabrizi-com-abcd42` rather than `decent-abcd42`). Improves
     * recognisability of the resulting `.dot.li` URL.
     */
    siteUrl?: string;
    /** Cap on attempts; defaults to 20. */
    maxAttempts?: number;
}

/**
 * Generate URL-derived NoStatus candidates until one is `available`. Returns
 * the chosen label and the matching availability result so callers can reuse
 * the embedded `DeployPlan`.
 *
 * Bails after `maxAttempts` with a descriptive error — collisions in this
 * keyspace would indicate either a broken RNG or an attacker pre-claiming the
 * keyspace, both of which are worth surfacing rather than looping forever.
 */
export async function findAvailableRandomName(
    options: FindAvailableNameOptions = {},
): Promise<{ label: string; availability: Extract<AvailabilityResult, { status: "available" }> }> {
    const maxAttempts = options.maxAttempts ?? 20;
    let lastFailure: AvailabilityResult | null = null;

    for (let i = 0; i < maxAttempts; i++) {
        const candidate = generateLabel(options.siteUrl);
        const result = await checkDomainAvailability(candidate, {
            env: options.env,
            ownerSs58Address: options.ownerSs58Address,
        });
        if (result.status === "available") {
            return { label: candidate, availability: result };
        }
        lastFailure = result;
    }

    const reason = lastFailure
        ? `last attempt was "${lastFailure.fullDomain}" (${lastFailure.status})`
        : "no availability response";
    throw new Error(
        `Could not find an available random domain after ${maxAttempts} attempts — ${reason}`,
    );
}
