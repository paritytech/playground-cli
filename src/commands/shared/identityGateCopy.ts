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
 * Yellow-callout copy for a blocked builder-identity gate. Lifted out of the
 * Ink component so it can be unit-tested without React. An empty string is a
 * blank-line spacer (the renderer maps it to a `<Text> </Text>`).
 */

import type { BlockedIdentityStatus } from "../../utils/identity/identityGate.js";

export interface GateNoticeCopy {
    title: string;
    lines: string[];
}

export function identityGateCopy(status: BlockedIdentityStatus): GateNoticeCopy {
    switch (status) {
        case "not-logged-in":
            return {
                title: "Log in first",
                lines: [
                    "You're not signed in yet. Playground commands are for builders who've joined the competition, and we need to know who you are to check.",
                    "",
                    "Run `playground login` and scan the QR code with your Polkadot mobile app. If you haven't yet, become a builder and join the competition at playground.dot in your desktop app.",
                ],
            };
        case "anonymous":
            return {
                title: "Join the competition first",
                lines: [
                    "You're signed in, but you haven't joined the competition yet.",
                    "",
                    "To deploy, mod, or decentralize an app you need to first become a builder and join the competition at playground.dot in your desktop app, then try again.",
                ],
            };
        case "unverifiable":
            return {
                title: "Couldn't verify your builder status",
                lines: [
                    "We couldn't check whether you've joined the competition right now.",
                    "",
                    "Make sure you joined the competition on playground.dot in your desktop app, then try again.",
                ],
            };
    }
}
