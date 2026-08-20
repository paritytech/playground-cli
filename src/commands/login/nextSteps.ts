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
 * "Try this next" suggestions shown in a bordered Callout at the end of a
 * successful `pg login`. Kept in its own data file (no React/Ink) so the list
 * stays testable and the rendering component stays a thin map over it.
 */

import { getEnvTld } from "../../config.js";

export interface NextStep {
    /** Full command the user can copy-paste, e.g. `pg decentralize`. */
    cmd: string;
    /** One-line description of what the command does. */
    description: string;
}

export const NEXT_STEPS: NextStep[] = [
    {
        cmd: "pg decentralize",
        description: `Take any static website and deploy it to a .${getEnvTld()} domain. Fully web3.`,
    },
    {
        cmd: "pg mod",
        description: "Browse available community apps and mod them to make them your own.",
    },
    {
        cmd: "pg deploy",
        description: `Built an app already? Deploy it to a .${getEnvTld()} domain on Playground.`,
    },
];
