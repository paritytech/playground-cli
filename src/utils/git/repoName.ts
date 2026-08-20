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
import { KNOWN_TLDS } from "../../config.js";

/**
 * Build the default target-directory name for `dot mod`: a slugified domain
 * with a short random suffix so repeated mods of the same app don't collide.
 * TLD-generic: registry domains carry the per-env DotNS TLD (`cool-app.paseo`
 * on paseo-next-v2), and none of the known TLDs belongs in the directory name.
 */
export function defaultRepoName(domain: string): string {
    const label = domain.replace(new RegExp(`\\.(${KNOWN_TLDS.join("|")})$`, "i"), "");
    return slugify(label) + "-" + randomBytes(3).toString("hex");
}

function slugify(s: string): string {
    return s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
}
