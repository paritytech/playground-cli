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
import { initialRunningState, runningReducer, type RunningState } from "./runningState.js";
import type { DeployEvent } from "../../utils/deploy/index.js";

const FULL_INPUTS = {
    skipBuild: false,
    publishToPlayground: true,
};

function baseState(
    overrides: Partial<{
        skipBuild: boolean;
        publishToPlayground: boolean;
    }> = {},
): RunningState {
    return initialRunningState({ ...FULL_INPUTS, ...overrides });
}

describe("initialRunningState", () => {
    it("skipBuild: true -> frontend.buildStatus is skipped, upload stays pending", () => {
        const s = baseState({ skipBuild: true });
        expect(s.frontend.buildStatus).toBe("skipped");
        expect(s.frontend.uploadStatus).toBe("pending");
    });

    it("publishToPlayground: false -> playground status skipped", () => {
        const s = baseState({ publishToPlayground: false });
        expect(s.playground.status).toBe("skipped");
    });

    it("fully-enabled inputs -> deploy slots start pending", () => {
        const s = baseState();
        expect(s.frontend.buildStatus).toBe("pending");
        expect(s.frontend.uploadStatus).toBe("pending");
        expect(s.playground.status).toBe("pending");
    });
});

describe("runningReducer — phase-start", () => {
    it("build -> frontend.buildStatus running", () => {
        const s = runningReducer(baseState(), { kind: "phase-start", phase: "build" });
        expect(s.frontend.buildStatus).toBe("running");
    });

    it("storage-and-dotns -> frontend.uploadStatus running", () => {
        const s = runningReducer(baseState(), {
            kind: "phase-start",
            phase: "storage-and-dotns",
        });
        expect(s.frontend.uploadStatus).toBe("running");
    });

    it("playground -> playground.status running", () => {
        const s = runningReducer(baseState(), { kind: "phase-start", phase: "playground" });
        expect(s.playground.status).toBe("running");
    });
});

describe("runningReducer — phase-complete", () => {
    it("build -> frontend.buildStatus complete", () => {
        const s = runningReducer(baseState(), { kind: "phase-complete", phase: "build" });
        expect(s.frontend.buildStatus).toBe("complete");
    });

    it("storage-and-dotns -> uploadStatus complete", () => {
        const s = runningReducer(baseState(), {
            kind: "phase-complete",
            phase: "storage-and-dotns",
        });
        expect(s.frontend.uploadStatus).toBe("complete");
    });

    it("playground -> playground.status complete", () => {
        const s = runningReducer(baseState(), { kind: "phase-complete", phase: "playground" });
        expect(s.playground.status).toBe("complete");
    });
});

describe("runningReducer — phase-skipped", () => {
    it("build -> frontend.buildStatus skipped", () => {
        const s = runningReducer(baseState(), {
            kind: "phase-skipped",
            phase: "build",
            reason: "user skipped",
        });
        expect(s.frontend.buildStatus).toBe("skipped");
    });

    it("storage-and-dotns -> uploadStatus skipped", () => {
        const s = runningReducer(baseState(), {
            kind: "phase-skipped",
            phase: "storage-and-dotns",
            reason: "no build output",
        });
        expect(s.frontend.uploadStatus).toBe("skipped");
    });

    it("playground -> playground.status skipped", () => {
        const s = runningReducer(baseState(), {
            kind: "phase-skipped",
            phase: "playground",
            reason: "user opted out",
        });
        expect(s.playground.status).toBe("skipped");
    });
});

describe("runningReducer — error", () => {
    it("phase: build -> frontend.buildStatus error + error set", () => {
        const s = runningReducer(baseState(), {
            kind: "error",
            phase: "build",
            message: "vite exploded",
        });
        expect(s.frontend.buildStatus).toBe("error");
        expect(s.frontend.error).toBe("vite exploded");
    });

    it("phase: storage-and-dotns -> frontend.uploadStatus error + error set", () => {
        const s = runningReducer(baseState(), {
            kind: "error",
            phase: "storage-and-dotns",
            message: "ws halt",
        });
        expect(s.frontend.uploadStatus).toBe("error");
        expect(s.frontend.error).toBe("ws halt");
    });

    it("phase: playground -> playground.status error + error set", () => {
        const s = runningReducer(baseState(), {
            kind: "error",
            phase: "playground",
            message: "registry revert",
        });
        expect(s.playground.status).toBe("error");
        expect(s.playground.error).toBe("registry revert");
    });
});

describe("runningReducer — log/signing/plan events are no-ops", () => {
    const s0 = baseState();

    it("plan -> state unchanged", () => {
        const s = runningReducer(s0, { kind: "plan", approvals: [] });
        expect(s).toBe(s0);
    });

    it("build-log -> state unchanged", () => {
        const s = runningReducer(s0, { kind: "build-log", line: "hello" });
        expect(s).toBe(s0);
    });

    it("signing sign-request -> state unchanged", () => {
        const s = runningReducer(s0, {
            kind: "signing",
            event: { kind: "sign-request", step: 1, attempt: 1, label: "DotNS register" },
        });
        expect(s).toBe(s0);
    });

    it("storage-event chunk-progress -> state unchanged", () => {
        const s = runningReducer(s0, {
            kind: "storage-event",
            event: { kind: "chunk-progress", current: 3, total: 10 },
        });
        expect(s).toBe(s0);
    });
});

describe("runningReducer — full happy-path sequence", () => {
    it("tracks frontend build, upload, and playground publish", () => {
        let s = initialRunningState({
            skipBuild: false,
            publishToPlayground: true,
        });

        const events: DeployEvent[] = [
            { kind: "phase-start", phase: "build" },
            { kind: "phase-complete", phase: "build" },
            { kind: "phase-start", phase: "storage-and-dotns" },
            { kind: "phase-complete", phase: "storage-and-dotns" },
            { kind: "phase-start", phase: "playground" },
            { kind: "phase-complete", phase: "playground" },
        ];

        for (const e of events) s = runningReducer(s, e);

        expect(s.frontend.buildStatus).toBe("complete");
        expect(s.frontend.uploadStatus).toBe("complete");
        expect(s.frontend.error).toBeUndefined();

        expect(s.playground.status).toBe("complete");
        expect(s.playground.error).toBeUndefined();
    });
});
