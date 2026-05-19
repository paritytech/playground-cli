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
import {
    checkDomainAvailability,
    type AvailabilityResult,
} from "../deploy/availability.js";
import type { Env } from "../../config.js";

/**
 * Random label prefix for the "free / not-great domain" tier. The base length
 * (8 chars before the trailing digits) keeps us in DotNS's NoStatus bucket
 * (`baseLength >= 9` after 2 trailing digits → no PoP required) so //Bob can
 * self-register without a personhood credential. See `availability.ts`'s
 * `classifyLabel` for the rule.
 */
const PREFIX = "decent-";

function randomLabel(): string {
    // 6 random base36 chars + 2 trailing digits = "decent-xxxxxx12".
    // Trailing digits keep us inside the "Available to all" classifier branch
    // for short-ish names without needing PoP.
    const suffix = randomBytes(4).toString("hex").slice(0, 6);
    const digits = String(randomBytes(1)[0] % 90 + 10); // always 2 digits
    return `${PREFIX}${suffix}${digits}`;
}

export interface FindAvailableNameOptions {
    env?: Env;
    ownerSs58Address?: string;
    /** Cap on attempts; defaults to 20. */
    maxAttempts?: number;
}

/**
 * Generate `decent-<hash>NN` candidates until one is `available` according to
 * `checkDomainAvailability`. Returns the chosen label and the matching
 * availability result so callers can reuse the embedded `DeployPlan`.
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
        const candidate = randomLabel();
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
