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
import { ContractPipelineStatusAdapter } from "./contractPipelineStatus.js";

describe("ContractPipelineStatusAdapter", () => {
    it("tracks build, deploy, publish, and register status for CDM events", () => {
        const displayNames = new Map<string, string>();
        const adapter = new ContractPipelineStatusAdapter({
            onCdmPackageDetected: (crate, pkg) => displayNames.set(crate, pkg),
        });

        adapter.handleDeployEvent({
            type: "detect",
            layers: [["reputation"]],
            contracts: [
                {
                    name: "reputation",
                    cdmPackage: "@polkadot/reputation",
                    description: null,
                    authors: [],
                    homepage: null,
                    repository: null,
                    readmePath: null,
                    path: "/tmp/reputation",
                    dependsOnCrates: [],
                },
            ],
        });
        adapter.handleDeployEvent({ type: "build-start", crate: "reputation" });
        adapter.handleDeployEvent({
            type: "build-progress",
            crate: "reputation",
            compiled: 4,
            total: 8,
        });
        adapter.handleDeployEvent({
            type: "build-done",
            crate: "reputation",
            durationMs: 1200,
            bytecodeSize: 42_000,
        });
        adapter.handleDeployEvent({
            type: "deploy-register-start",
            crates: ["reputation"],
        });
        adapter.handleDeployEvent({
            type: "publish-start",
            crates: ["reputation"],
        });
        adapter.handleDeployEvent({
            type: "deploy-register-done",
            addresses: { reputation: "0x1111111111111111111111111111111111111111" },
            txHash: "0xabc",
            blockHash: "0xdef",
            durationMs: 2500,
        });
        adapter.handleDeployEvent({
            type: "publish-done",
            cids: { reputation: "bafy1234" },
            txHash: "0xpub",
            durationMs: 500,
        });

        expect(displayNames.get("reputation")).toBe("@polkadot/reputation");
        expect(adapter.statuses.get("reputation")).toMatchObject({
            state: "done",
            address: "0x1111111111111111111111111111111111111111",
            cid: "bafy1234",
            deployInProgress: false,
            publishInProgress: false,
            registerInProgress: false,
            deployTxHash: "0xabc",
            publishTxHash: "0xpub",
            bytecodeSize: 42_000,
        });
    });

    it("retains only a bounded sanitized log tail", () => {
        const adapter = new ContractPipelineStatusAdapter();

        for (let i = 0; i < 10; i++) {
            adapter.handleDeployEvent({
                type: "log",
                line: `\u001b[32mline ${i}\u001b[0m\r`,
            });
        }

        expect(adapter.logLines).toEqual(["line 5", "line 6", "line 7", "line 8", "line 9"]);
    });

    it("ignores planned dry-run addresses until deployment submits", () => {
        const adapter = new ContractPipelineStatusAdapter();
        adapter.handleDeployEvent({
            type: "build-done",
            crate: "counter",
            durationMs: 1200,
            bytecodeSize: 4200,
        });

        adapter.handleDeployEvent({
            type: "check-needs-deploy",
            crate: "counter",
            address: "0x1111111111111111111111111111111111111111",
        });

        expect(adapter.statuses.get("counter")?.state).toBe("built");
        expect(adapter.statuses.get("counter")?.address).toBeUndefined();
    });

    it("surfaces raw signer errors over normalized deploy errors", () => {
        const adapter = new ContractPipelineStatusAdapter();

        adapter.handleSigningEvent({
            kind: "sign-request",
            label: "Deploy and register contracts",
            step: 1,
            attempt: 1,
        });
        expect(adapter.signingPrompt?.label).toBe("Deploy and register contracts");

        adapter.handleSigningEvent({
            kind: "sign-error",
            label: "Deploy and register contracts",
            step: 1,
            message: "Mobile signing failed: unsupported payload",
        });
        adapter.handleDeployEvent({
            type: "deploy-register-error",
            crates: ["counter"],
            error: "[AssetHub deploy+register chunk 1/1] Transaction signing was rejected.",
        });

        expect(adapter.signingPrompt).toBeNull();
        expect(adapter.signingError).toBe("Mobile signing failed: unsupported payload");
        expect(adapter.statuses.get("counter")).toMatchObject({
            state: "error",
            error: "Mobile signing failed: unsupported payload",
        });
    });

    it("records a non-signing run error separately from signing errors", () => {
        const adapter = new ContractPipelineStatusAdapter();

        adapter.setRunError("Contract deploy was requested but no contracts were found in /app.");

        expect(adapter.runError).toBe(
            "Contract deploy was requested but no contracts were found in /app.",
        );
        expect(adapter.signingError).toBeNull();
    });

    it("keeps the first run error and does not overwrite it", () => {
        const adapter = new ContractPipelineStatusAdapter();

        adapter.setRunError("first failure");
        adapter.setRunError("second failure");

        expect(adapter.runError).toBe("first failure");
    });
});
