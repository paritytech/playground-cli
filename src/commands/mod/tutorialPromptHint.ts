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
 * HARDCODED, TEMPORARY: gates the `(prompt: "start tutorial")` nudge in the
 * post-mod "Next steps" block on a single hardcoded app domain, rather than on
 * whether the user started a quest track.
 *
 * Kept in its own module so it can be removed in one go if we decide against
 * it: delete this file and pass `startedTutorial` straight to
 * `editWithAgentStep` at the `playground mod` call site to revert to the
 * quest-track behaviour.
 */
import { getEnvTld } from "../../config.js";

const TUTORIAL_APP_LABEL = "playground-tutorial";

/**
 * Whether the post-mod next steps should nudge toward the prepopulated
 * "start tutorial" AI prompt. `startedTutorial` is accepted (and currently
 * ignored) so the call site keeps threading it through; that is the value to
 * fall back to once this hardcode is removed.
 */
export function shouldShowTutorialPrompt(args: {
    domain: string;
    startedTutorial: boolean;
}): boolean {
    // TLD-aware: the registry keys apps by `<label>.<tld>` and the TLD is
    // per-env since the DotNS split (`.paseo` on paseo-next-v2).
    return args.domain === `${TUTORIAL_APP_LABEL}.${getEnvTld()}`;
}
