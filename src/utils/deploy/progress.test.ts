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

import { describe, it, expect } from "vitest";
import { DeployLogParser, type DeployLogEvent } from "./progress.js";

function feedAll(lines: string[]): DeployLogEvent[] {
    const parser = new DeployLogParser();
    const out: DeployLogEvent[] = [];
    for (const line of lines) {
        const ev = parser.feed(line);
        if (ev) out.push(ev);
    }
    return out;
}

describe("DeployLogParser", () => {
    it("emits phase-start for the Storage banner", () => {
        const events = feedAll([
            "============================================================",
            "Storage",
            "============================================================",
        ]);
        expect(events).toEqual([{ kind: "phase-start", phase: "storage" }]);
    });

    it("emits phase-start for DotNS and completion banners", () => {
        const events = feedAll([
            "============================================================",
            "DotNS",
            "============================================================",
            "============================================================",
            "DEPLOYMENT COMPLETE!",
            "============================================================",
        ]);
        expect(events).toEqual([
            { kind: "phase-start", phase: "dotns" },
            { kind: "phase-start", phase: "complete" },
        ]);
    });

    it("parses chunk progress lines", () => {
        const events = feedAll(["   [1/2] 1.00 MB (nonce: 42)", "   [2/2] 0.23 MB (nonce: 43)"]);
        expect(events).toEqual([
            { kind: "chunk-progress", current: 1, total: 2 },
            { kind: "chunk-progress", current: 2, total: 2 },
        ]);
    });

    it("drops unknown banner titles — extend PHASE_BANNERS to handle new ones", () => {
        // Regression guard: previously an unknown banner emitted an info
        // event, which could leak high-volume prose through the same code
        // path. Unknown banners must be SILENT here — if polkadot-app-deploy
        // adds a new phase, extend PHASE_BANNERS to match it.
        const events = feedAll([
            "============================================================",
            "Some Future Section",
            "============================================================",
        ]);
        expect(events).toEqual([]);
    });

    it("survives bulletin-deploy 0.15's post-Preflight Domain echo (#1240 ordering)", () => {
        // Since bulletin-deploy 0.15 (PR #1240), the `Domain: <name>.<tld>`
        // line prints AFTER the Preflight banner (once the chain-resolved TLD
        // is known) — i.e. it is the first non-divider line following the
        // banner's closing divider, exactly where the parser considers a
        // banner title. It must be dropped silently, not mistaken for a phase.
        const events = feedAll([
            "============================================================",
            "Preflight",
            "============================================================",
            "   Domain: my-app.paseo",
            "   [1/3] chunk 0 — 1.00 MB (nonce: 42)",
        ]);
        expect(events).toEqual([
            { kind: "phase-start", phase: "preflight" },
            { kind: "chunk-progress", current: 1, total: 3 },
        ]);
    });

    it("drops plain prose lines so we don't flood the TUI", () => {
        // Regression guard: previously we emitted `info` events for every
        // random log line. polkadot-app-deploy produces hundreds per deploy
        // and the per-event allocation was a measurable contributor to
        // the multi-GB memory pressure we hit during chunk uploads.
        const events = feedAll(["   Domain: my-app.dot", "   Build dir: /tmp/dist"]);
        expect(events).toEqual([]);
    });

    it("ignores blank lines and divider-only lines", () => {
        const events = feedAll([
            "",
            "   ",
            "============================================================",
        ]);
        expect(events).toEqual([]);
    });

    it("handles trailing carriage returns from Windows-style output", () => {
        // The actual log capture may include \r from child_process buffers
        // even on Linux; strip them so banners still match.
        const parser = new DeployLogParser();
        parser.feed("============================================================\r");
        const ev = parser.feed("Storage\r");
        expect(ev).toEqual({ kind: "phase-start", phase: "storage" });
    });
});
