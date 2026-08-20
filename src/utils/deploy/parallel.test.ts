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

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the single-app orchestrator: parallel tests only care about scheduling,
// gate wiring, ordering, and error isolation — not the on-chain pipeline.
const { runDeployMock } = vi.hoisted(() => ({ runDeployMock: vi.fn() }));
vi.mock("./run.js", () => ({ runDeploy: runDeployMock }));

import { runParallelDeploys, clampConcurrency, type ParallelDeployApp } from "./parallel.js";

function app(name: string, domain = name): ParallelDeployApp {
    return { name, domain, projectDir: `/p/${name}`, buildDir: `/p/${name}/dist` };
}

const baseRunOptions = (app: ParallelDeployApp) =>
    Promise.resolve({
        projectDir: app.projectDir,
        buildDir: app.buildDir,
        domain: app.domain,
        mode: "dev" as const,
        publishToPlayground: false,
        userSigner: null,
    });

beforeEach(() => {
    runDeployMock.mockReset();
});

describe("clampConcurrency", () => {
    it("clamps to [1, appCount] and floors fractions", () => {
        expect(clampConcurrency(5, 3)).toBe(3);
        expect(clampConcurrency(0, 3)).toBe(1);
        expect(clampConcurrency(-2, 3)).toBe(1);
        expect(clampConcurrency(2.9, 3)).toBe(2);
        expect(clampConcurrency(Number.NaN, 3)).toBe(1);
        expect(clampConcurrency(2, 0)).toBe(1);
    });
});

describe("runParallelDeploys", () => {
    it("deploys every app and returns results in input order", async () => {
        runDeployMock.mockImplementation(async (opts: any) => ({
            fullDomain: `${opts.domain}.paseo`,
            appCid: `cid-${opts.domain}`,
            approvalsRequested: [],
            appUrl: `https://${opts.domain}.paseo.li`,
        }));

        const apps = [app("c"), app("a"), app("b")];
        const summary = await runParallelDeploys({
            apps,
            concurrency: 2,
            signerKey: () => "shared",
            buildRunOptions: baseRunOptions,
        });

        expect(summary.succeeded).toBe(3);
        expect(summary.failed).toBe(0);
        expect(summary.results.map((r) => r.name)).toEqual(["c", "a", "b"]);
        expect(summary.results.every((r) => r.status === "success")).toBe(true);
    });

    it("passes a shared gate for same signerKey so signing never overlaps", async () => {
        let signingActive = 0;
        let maxSigningActive = 0;

        // Simulate runDeploy's gated signing section: each call runs its on-chain
        // work *inside* the gate the orchestrator handed it. If the gate were not
        // shared across same-key apps, the sections would overlap.
        runDeployMock.mockImplementation(async (opts: any) => {
            await opts.signingGate.runExclusive(async () => {
                signingActive += 1;
                maxSigningActive = Math.max(maxSigningActive, signingActive);
                await new Promise((r) => setTimeout(r, 0));
                signingActive -= 1;
            });
            return {
                fullDomain: `${opts.domain}.paseo`,
                appCid: "cid",
                approvalsRequested: [],
                appUrl: "https://x.paseo.li",
            };
        });

        await runParallelDeploys({
            apps: [app("a"), app("b"), app("c"), app("d")],
            concurrency: 4,
            signerKey: () => "shared", // one account ⇒ one gate ⇒ serialized
            buildRunOptions: baseRunOptions,
        });

        expect(maxSigningActive).toBe(1);
    });

    it("runs distinct signerKeys' signing in parallel", async () => {
        let active = 0;
        let maxActive = 0;
        runDeployMock.mockImplementation(async (opts: any) => {
            await opts.signingGate.runExclusive(async () => {
                active += 1;
                maxActive = Math.max(maxActive, active);
                await new Promise((r) => setTimeout(r, 0));
                active -= 1;
            });
            return {
                fullDomain: `${opts.domain}.paseo`,
                appCid: "cid",
                approvalsRequested: [],
                appUrl: "https://x.paseo.li",
            };
        });

        await runParallelDeploys({
            apps: [app("a"), app("b")],
            concurrency: 2,
            signerKey: (a) => a.name, // distinct keys ⇒ distinct gates
            buildRunOptions: baseRunOptions,
        });

        expect(maxActive).toBeGreaterThan(1);
    });

    it("never exceeds the concurrency limit of in-flight deploys", async () => {
        let inFlight = 0;
        let maxInFlight = 0;
        runDeployMock.mockImplementation(async (opts: any) => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((r) => setTimeout(r, 0));
            inFlight -= 1;
            return {
                fullDomain: `${opts.domain}.paseo`,
                appCid: "cid",
                approvalsRequested: [],
                appUrl: "https://x.paseo.li",
            };
        });

        await runParallelDeploys({
            apps: [app("a"), app("b"), app("c"), app("d"), app("e")],
            concurrency: 2,
            signerKey: (a) => a.name, // distinct keys so the gate doesn't serialize
            buildRunOptions: baseRunOptions,
        });

        expect(maxInFlight).toBeLessThanOrEqual(2);
    });

    it("isolates per-app failures and continues deploying the rest", async () => {
        runDeployMock.mockImplementation(async (opts: any) => {
            if (opts.domain === "b") throw new Error("nonce too low");
            return {
                fullDomain: `${opts.domain}.paseo`,
                appCid: "cid",
                approvalsRequested: [],
                appUrl: "https://x.paseo.li",
            };
        });

        const settled: string[] = [];
        const summary = await runParallelDeploys({
            apps: [app("a"), app("b"), app("c")],
            concurrency: 3,
            signerKey: () => "shared",
            buildRunOptions: baseRunOptions,
            onAppSettled: (r) => settled.push(`${r.name}:${r.status}`),
        });

        expect(summary.succeeded).toBe(2);
        expect(summary.failed).toBe(1);
        const failed = summary.results.find((r) => r.name === "b");
        expect(failed).toMatchObject({ status: "failed", error: "nonce too low" });
        expect(settled.sort()).toEqual(["a:success", "b:failed", "c:success"]);
    });

    it("captures a buildRunOptions failure as a failed app, not a thrown batch", async () => {
        runDeployMock.mockResolvedValue({
            fullDomain: "a.paseo",
            appCid: "cid",
            approvalsRequested: [],
            appUrl: "https://a.paseo.li",
        });

        const summary = await runParallelDeploys({
            apps: [app("a"), app("bad")],
            concurrency: 2,
            signerKey: () => "shared",
            buildRunOptions: (a) =>
                a.name === "bad" ? Promise.reject(new Error("Reserved name")) : baseRunOptions(a),
        });

        expect(summary.failed).toBe(1);
        expect(summary.results.find((r) => r.name === "bad")).toMatchObject({
            status: "failed",
            error: "Reserved name",
        });
        // The "bad" app never reached runDeploy.
        expect(runDeployMock).toHaveBeenCalledTimes(1);
    });
});
