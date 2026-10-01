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
 * Copy for a phone-approval request, shared by `PhoneApprovalCallout` and the
 * line-oriented (`--yes`) output so the two can't drift. Lifted out of the Ink
 * component so it can be unit-tested without React.
 *
 * A re-send keeps its step number (the counter numbers approvals, not
 * requests — see `signingProxy.ts::createSigningCounter`) and says plainly that
 * it is a re-send, with the one remedy that actually fixes a missing prompt.
 */

import type { SigningEvent } from "../../deploy/signingProxy.js";

type SignRequest = Extract<SigningEvent, { kind: "sign-request" }>;

/** The usual cause of a request that shows no prompt at all. */
export const PHONE_RESEND_HINT =
    "If no prompt appeared, open the Polkadot app and keep it in the foreground.";

/** `null` for a first request; otherwise the re-send notice for `attempt`. */
export function resendNotice(attempt: number): string | null {
    return attempt > 1 ? `No response yet — re-sent to your phone (attempt ${attempt}).` : null;
}

/** One output line (plus the remedy on a re-send) for a sign request. */
export function formatSignRequestLine(event: SignRequest): string {
    if (event.attempt <= 1) {
        return `  📱 Approve on your phone (step ${event.step}): ${event.label}\n`;
    }
    return (
        `  📱 No response yet — re-sent to your phone (step ${event.step}, attempt ${event.attempt}): ${event.label}\n` +
        `     ${PHONE_RESEND_HINT}\n`
    );
}
