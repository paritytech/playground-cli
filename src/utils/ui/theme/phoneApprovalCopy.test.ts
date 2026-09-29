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

import { describe, expect, it } from "vitest";
import { formatSignRequestLine, resendNotice } from "./phoneApprovalCopy.js";

const request = (step: number, attempt: number, label = "Link content (DotNS setContenthash)") =>
    ({ kind: "sign-request", label, step, attempt }) as const;

describe("formatSignRequestLine", () => {
    it("announces a first request with its step", () => {
        const line = formatSignRequestLine(request(1, 1));
        expect(line).toContain("Approve on your phone (step 1)");
        expect(line).toContain("Link content (DotNS setContenthash)");
        expect(line).not.toMatch(/attempt|re-sent/i);
    });

    /**
     * A re-send must not read as progress: it keeps its step number and says
     * it is a re-send. Seen live before this: "step 3: Link content" for a
     * user who had approved nothing on a two-approval deploy.
     */
    it("calls a re-send a re-send, on the same step", () => {
        const line = formatSignRequestLine(request(1, 3));
        expect(line).toMatch(/re-sent/i);
        expect(line).toContain("step 1, attempt 3");
        expect(line).not.toMatch(/step [23]/);
    });

    it("tells the user what to check when a prompt never appeared", () => {
        expect(formatSignRequestLine(request(2, 2))).toMatch(/foreground/i);
        expect(formatSignRequestLine(request(2, 1))).not.toMatch(/foreground/i);
    });
});

describe("resendNotice", () => {
    it("is null for a first request and names the attempt otherwise", () => {
        expect(resendNotice(1)).toBeNull();
        expect(resendNotice(2)).toMatch(/attempt 2/);
    });
});
