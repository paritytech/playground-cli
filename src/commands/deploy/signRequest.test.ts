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

import { beforeEach, describe, expect, it } from "vitest";
import { formatSignRequest, resetSignRequestAttempts } from "./index.js";

beforeEach(() => {
    resetSignRequestAttempts();
});

describe("formatSignRequest", () => {
    it("announces the first request plainly", () => {
        const line = formatSignRequest("Link content (DotNS setContenthash)");
        expect(line).toContain("Approve on your phone");
        expect(line).toContain("Link content (DotNS setContenthash)");
        expect(line).not.toMatch(/attempt/i);
    });

    /**
     * The bug this replaces, observed live: the event's `step` counts signature
     * REQUESTS, so a timed-out attempt re-sent as "step 2" read as progress —
     * and contradicted the "Phone approvals expected" plan above it, which
     * numbers OPERATIONS. A deploy printed `step 1: Link content` then
     * `step 2: Link content` while the plan said step 2 was the registry
     * publish, and the user approved four prompts for a two-approval deploy.
     */
    it("calls a repeat of the same operation a retry, not the next step", () => {
        const label = "Link content (DotNS setContenthash)";
        formatSignRequest(label);
        const second = formatSignRequest(label);

        expect(second).toMatch(/attempt 2/);
        expect(second).toMatch(/re-sent/i);
        // Must not imply forward progress.
        expect(second).not.toMatch(/step 2/);
    });

    it("keeps counting further retries of the same operation", () => {
        const label = "Publish to Playground registry";
        formatSignRequest(label);
        formatSignRequest(label);
        expect(formatSignRequest(label)).toMatch(/attempt 3/);
    });

    it("treats a different operation as a fresh request", () => {
        formatSignRequest("Link content (DotNS setContenthash)");
        const other = formatSignRequest("Publish to Playground registry");

        expect(other).toContain("Approve on your phone");
        expect(other).not.toMatch(/attempt/i);
    });

    /** The one remedy worth surfacing when no prompt showed up at all. */
    it("tells the user what to check when a prompt never appeared", () => {
        const label = "Link content (DotNS setContenthash)";
        formatSignRequest(label);
        expect(formatSignRequest(label)).toMatch(/foreground/i);
    });
});
