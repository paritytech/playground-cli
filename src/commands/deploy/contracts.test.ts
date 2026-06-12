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

import type { DeploySummary } from "@parity/cdm-builder";
import { describe, expect, it, vi } from "vitest";
import { installLibrariesFromDeploySummary, runContractsBeforeFrontend } from "./contracts.js";

vi.mock("../contract.js", () => ({
    runContractDeploy: vi.fn(),
    runContractInstall: vi.fn(),
}));

describe("installLibrariesFromDeploySummary", () => {
    it("deduplicates successful CDM packages and skips failed contracts", () => {
        const summary: DeploySummary = {
            totalDurationMs: 123,
            contracts: [
                {
                    crate: "counter",
                    cdmPackage: "@example/counter",
                    status: "done",
                },
                {
                    crate: "counter-copy",
                    cdmPackage: "@example/counter",
                    status: "cached",
                },
                {
                    crate: "broken",
                    cdmPackage: "@example/broken",
                    status: "error",
                    error: "failed",
                },
            ],
        };

        expect(installLibrariesFromDeploySummary(summary)).toEqual(["@example/counter"]);
    });
});

describe("runContractsBeforeFrontend", () => {
    it("fails with an actionable error when the project has no contracts (#319)", async () => {
        const { runContractDeploy, runContractInstall } = await import("../contract.js");
        vi.mocked(runContractDeploy).mockResolvedValue({
            summary: { totalDurationMs: 0, contracts: [] },
            success: true,
        });

        await expect(
            runContractsBeforeFrontend({
                projectDir: "/tmp/example-app",
                mode: "dev",
                userSigner: null,
            }),
        ).rejects.toThrow(/No smart contracts found in \/tmp\/example-app/);

        // The install step used to run anyway and die with the cryptic
        // "No library specified and no dependencies found in cdm.json."
        expect(vi.mocked(runContractInstall)).not.toHaveBeenCalled();
    });
});
