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

import type { PolkadotClient } from "polkadot-api";
import { withSpan } from "../../telemetry.js";
import { checkIdentityGate, type IdentitySpine } from "../../utils/identity/identityGate.js";
import { renderIdentityGateNotice } from "./IdentityGateNotice.js";

/**
 * Enforce the builder-identity gate for the signed-in session.
 *
 * Returns `true` when the user is BLOCKED — the caller should set
 * `process.exitCode = 0` (a soft, actionable outcome) and return after running
 * its own cleanup. Returns `false` when the user is a revealed builder and the
 * command may proceed; nothing is printed on that path (no flash on success).
 */
export async function enforceIdentityGate(
    rawAssetHubClient: PolkadotClient,
    identity?: IdentitySpine,
): Promise<boolean> {
    const result = await withSpan("cli.identity-gate", "check builder identity", () =>
        checkIdentityGate(rawAssetHubClient, { identity }),
    );
    if (result.status === "revealed") return false;
    await renderIdentityGateNotice(result.status);
    return true;
}
