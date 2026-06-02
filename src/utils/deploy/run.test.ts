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

// Mocks for the heavy underlying pieces. Orchestrator tests only care about
// sequencing, event shape, and error propagation. Declare mocks via
// `vi.hoisted()` so they're available when `vi.mock()` (itself hoisted) runs.
const {
    runStorageDeploy,
    publishToPlaygroundMock,
    runBuildMock,
    detectBuildConfigMock,
    loadDetectInputMock,
    withSpanMock,
    getBulletinAllowanceSignerMock,
    readSlotAccountKeyMock,
    getSlotAccountAddressMock,
} = vi.hoisted(() => ({
    runStorageDeploy: vi.fn<
        (arg: any) => Promise<{
            domainName: string;
            fullDomain: string;
            cid: string;
            ipfsCid: string;
        }>
    >(async () => ({
        domainName: "my-app",
        fullDomain: "my-app.dot",
        cid: "bafyapp",
        ipfsCid: "bafyipfs",
    })),
    publishToPlaygroundMock: vi.fn(async () => ({
        metadataCid: "bafymeta",
        fullDomain: "my-app.dot",
        metadata: {},
    })),
    runBuildMock: vi.fn(async () => ({ config: {} as any, outputDir: "/tmp/dist" })),
    detectBuildConfigMock: vi.fn(() => ({
        cmd: "pnpm",
        args: ["run", "build"],
        description: "pnpm run build",
        defaultOutputDir: "dist",
    })),
    loadDetectInputMock: vi.fn(() => ({
        packageJson: { scripts: { build: "vite build" } },
        lockfiles: new Set<string>(),
        configFiles: new Set<string>(),
    })),
    withSpanMock: vi.fn(async (_op: string, _name: string, _attrs: any, fn: any) => fn()),
    getBulletinAllowanceSignerMock: vi.fn(async () => ({
        publicKey: new Uint8Array(32),
        signTx: async () => new Uint8Array(64),
        signBytes: async () => new Uint8Array(64),
    })),
    readSlotAccountKeyMock: vi.fn(async () => new Uint8Array(32).fill(0x42)),
    getSlotAccountAddressMock: vi.fn(() => "5SlotAddress"),
}));

vi.mock("./storage.js", () => ({ runStorageDeploy }));
vi.mock("../allowances/bulletin.js", () => ({
    getBulletinAllowanceSigner: getBulletinAllowanceSignerMock,
}));
vi.mock("../allowances/slotKeys.js", () => ({
    readSlotAccountKey: readSlotAccountKeyMock,
    getSlotAccountAddress: getSlotAccountAddressMock,
}));
vi.mock("./playground.js", () => ({
    publishToPlayground: publishToPlaygroundMock,
    normalizeDomain: (d: string) => {
        const label = d.replace(/\.dot$/, "");
        return { label, fullDomain: `${label}.dot` };
    },
}));
vi.mock("../build/index.js", () => ({
    runBuild: runBuildMock,
    loadDetectInput: loadDetectInputMock,
    detectBuildConfig: detectBuildConfigMock,
}));
vi.mock("../../telemetry.js", () => ({
    withSpan: (...args: unknown[]) =>
        withSpanMock(args[0] as string, args[1] as string, args[2], args[3]),
    errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

import { runDeploy, type DeployEvent } from "./run.js";
import type { ResolvedSigner } from "../signer.js";

const fakeUserSigner: ResolvedSigner = {
    signer: {
        publicKey: new Uint8Array(32),
        signTx: vi.fn(),
        signBytes: vi.fn(),
    },
    address: "5Fake",
    source: "session",
    // `addresses` is forwarded from SessionHandle in real code. The
    // claimed-owner flow reads `addresses.productH160` — without it,
    // dev-mode publish would silently fall through to "no claimed
    // owner" and Alice ends up as the registered owner.
    addresses: {
        rootAddress: "5Root",
        productAddress: "5Fake",
        productH160: "0xbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef",
    },
    destroy: vi.fn(),
};

function collectEvents(): { events: DeployEvent[]; push: (e: DeployEvent) => void } {
    const events: DeployEvent[] = [];
    return { events, push: (e) => events.push(e) };
}

beforeEach(() => {
    runStorageDeploy.mockClear();
    publishToPlaygroundMock.mockClear();
    runBuildMock.mockClear();
    withSpanMock.mockClear();
    getBulletinAllowanceSignerMock.mockClear();
    readSlotAccountKeyMock.mockClear();
    getSlotAccountAddressMock.mockClear();
});

describe("runDeploy", () => {
    it("dev mode without playground: no phone taps, no publishToPlayground call", async () => {
        const { events, push } = collectEvents();
        const outcome = await runDeploy({
            projectDir: "/tmp/proj",
            buildDir: "/tmp/proj/dist",
            domain: "my-app",
            mode: "dev",
            publishToPlayground: false,
            userSigner: null,
            onEvent: push,
        });

        expect(outcome.fullDomain).toBe("my-app.dot");
        expect(outcome.approvalsRequested).toEqual([]);
        expect(publishToPlaygroundMock).not.toHaveBeenCalled();

        const plan = events.find((e) => e.kind === "plan");
        expect(plan).toEqual({ kind: "plan", approvals: [] });

        // bulletin-deploy auth must be empty in dev mode.
        expect(runStorageDeploy).toHaveBeenCalledTimes(1);
        const arg = runStorageDeploy.mock.calls[0][0];
        expect(arg.auth).toEqual({});
        expect(arg.domainName).toBe("my-app");
    });

    it("dev mode with playground: ZERO planned approvals AND user H160 is claimed as owner", async () => {
        const { events, push } = collectEvents();
        const outcome = await runDeploy({
            projectDir: "/tmp/proj",
            buildDir: "/tmp/proj/dist",
            domain: "my-app",
            mode: "dev",
            publishToPlayground: true,
            userSigner: fakeUserSigner,
            onEvent: push,
        });

        // The dev-mode publish runs against a constructed Alice signer
        // (resolveSignerSetup synthesises it). Zero phone approvals are
        // promised to the user. publishToPlayground is still invoked.
        expect(outcome.approvalsRequested).toEqual([]);
        expect(outcome.metadataCid).toBe("bafymeta");
        expect(publishToPlaygroundMock).toHaveBeenCalledTimes(1);

        // The headline contract: the user's session H160 is passed as
        // claimedOwnerH160 so MyApps still resolves the app even though
        // Alice signed the publish tx. Without this assertion the test
        // would pass even if the user's H160 silently never reached the
        // chain.
        const calls = publishToPlaygroundMock.mock.calls as unknown[][];
        const publishCall = calls[0]?.[0] as { claimedOwnerH160?: string } | undefined;
        expect(publishCall?.claimedOwnerH160).toBe("0xbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef");

        const plan = events.find((e) => e.kind === "plan");
        expect(plan?.kind).toBe("plan");
        if (plan?.kind === "plan") expect(plan.approvals).toHaveLength(0);
    });

    it("threads isModdable + isDevSigner into publishToPlayground", async () => {
        // Phone-mode publish: isDevSigner=false, isModdable=true.
        const { push } = collectEvents();
        await runDeploy({
            projectDir: "/tmp/proj",
            buildDir: "/tmp/proj/dist",
            domain: "phone-mod",
            mode: "phone",
            publishToPlayground: true,
            moddable: true,
            repositoryUrl: "https://github.com/foo/bar",
            userSigner: fakeUserSigner,
            onEvent: push,
        });
        const phoneCall = (publishToPlaygroundMock.mock.calls as unknown[][])[0]?.[0] as
            | { isModdable?: boolean; isDevSigner?: boolean }
            | undefined;
        expect(phoneCall?.isModdable).toBe(true);
        expect(phoneCall?.isDevSigner).toBe(false);

        publishToPlaygroundMock.mockClear();

        // Dev-mode publish (no session): isDevSigner=true, isModdable=false.
        await runDeploy({
            projectDir: "/tmp/proj",
            buildDir: "/tmp/proj/dist",
            domain: "dev-throwaway",
            mode: "dev",
            publishToPlayground: true,
            moddable: false,
            userSigner: null,
            onEvent: push,
        });
        const devCall = (publishToPlaygroundMock.mock.calls as unknown[][])[0]?.[0] as
            | { isModdable?: boolean; isDevSigner?: boolean }
            | undefined;
        expect(devCall?.isModdable).toBe(false);
        expect(devCall?.isDevSigner).toBe(true);
    });

    it("phone mode with playground: 4 planned approvals, DotNS uses phone signer", async () => {
        const { events, push } = collectEvents();
        const outcome = await runDeploy({
            projectDir: "/tmp/proj",
            buildDir: "/tmp/proj/dist",
            domain: "my-app",
            mode: "phone",
            publishToPlayground: true,
            userSigner: fakeUserSigner,
            onEvent: push,
        });

        expect(outcome.approvalsRequested).toHaveLength(4);

        // bulletin-deploy auth must carry a wrapped signer + our address.
        const arg = runStorageDeploy.mock.calls[0][0];
        expect(arg.auth.signerAddress).toBe("5Fake");
        expect(arg.auth.signer).toBeDefined();

        const plan = events.find((e) => e.kind === "plan");
        if (plan?.kind === "plan") {
            expect(plan.approvals.map((a) => a.phase)).toEqual([
                "dotns",
                "dotns",
                "dotns",
                "playground",
            ]);
        }
    });

    it("phone mode + needsPopUpgrade: 5 planned approvals (setPop + commit + finalize + contenthash + playground)", async () => {
        // Regression: this used to be 4 approvals across the board, so a
        // PoP-gated name with a lower-tier signer (which triggers
        // `setUserPopStatus` inside bulletin-deploy.register) printed
        // "approve step 5 of 4" at the playground step.
        const { events, push } = collectEvents();
        const outcome = await runDeploy({
            projectDir: "/tmp/proj",
            buildDir: "/tmp/proj/dist",
            domain: "my-app",
            mode: "phone",
            publishToPlayground: true,
            userSigner: fakeUserSigner,
            plan: { action: "register", needsPopUpgrade: true },
            onEvent: push,
        });

        expect(outcome.approvalsRequested).toHaveLength(5);
        expect(outcome.approvalsRequested.map((a) => a.label)).toEqual([
            "Grant Proof of Personhood",
            "Reserve domain (DotNS commitment)",
            "Finalize domain (DotNS register)",
            "Link content (DotNS setContenthash)",
            "Publish to Playground registry",
        ]);

        const plan = events.find((e) => e.kind === "plan");
        if (plan?.kind === "plan") {
            expect(plan.approvals.map((a) => a.phase)).toEqual([
                "dotns",
                "dotns",
                "dotns",
                "dotns",
                "playground",
            ]);
        }
    });

    it("phone mode + re-deploy (plan.action=update): only setContenthash + playground taps", async () => {
        // When the domain is already owned by the signer, bulletin-deploy
        // skips `register()` entirely (no commit, no reveal, no PoP grant)
        // and jumps straight to `setContenthash`. Summary should reflect that.
        const { events, push } = collectEvents();
        const outcome = await runDeploy({
            projectDir: "/tmp/proj",
            buildDir: "/tmp/proj/dist",
            domain: "my-app",
            mode: "phone",
            publishToPlayground: true,
            userSigner: fakeUserSigner,
            plan: { action: "update", needsPopUpgrade: false },
            onEvent: push,
        });

        expect(outcome.approvalsRequested).toHaveLength(2);
        expect(outcome.approvalsRequested.map((a) => a.label)).toEqual([
            "Link content (DotNS setContenthash)",
            "Publish to Playground registry",
        ]);

        const plan = events.find((e) => e.kind === "plan");
        if (plan?.kind === "plan") {
            expect(plan.approvals.map((a) => a.phase)).toEqual(["dotns", "playground"]);
        }
    });

    it("phone mode without a logged-in session throws before touching the network", async () => {
        const { push } = collectEvents();
        await expect(
            runDeploy({
                projectDir: "/tmp/proj",
                buildDir: "/tmp/proj/dist",
                domain: "my-app",
                mode: "phone",
                publishToPlayground: false,
                userSigner: null,
                onEvent: push,
            }),
        ).rejects.toThrow(/Phone signer requested/);

        expect(runStorageDeploy).not.toHaveBeenCalled();
    });

    it("skipBuild bypasses detect + runBuild", async () => {
        const { push } = collectEvents();
        await runDeploy({
            projectDir: "/tmp/proj",
            buildDir: "/tmp/proj/dist",
            skipBuild: true,
            domain: "my-app",
            mode: "dev",
            publishToPlayground: false,
            userSigner: null,
            onEvent: push,
        });
        expect(runBuildMock).not.toHaveBeenCalled();
    });

    it("emits error event and rethrows when storage fails", async () => {
        runStorageDeploy.mockImplementationOnce(async () => {
            throw new Error("bulletin rpc down");
        });
        const { events, push } = collectEvents();
        await expect(
            runDeploy({
                projectDir: "/tmp/proj",
                buildDir: "/tmp/proj/dist",
                skipBuild: true,
                domain: "my-app",
                mode: "dev",
                publishToPlayground: false,
                userSigner: null,
                onEvent: push,
            }),
        ).rejects.toThrow(/bulletin rpc down/);

        const err = events.find((e) => e.kind === "error");
        expect(err).toMatchObject({ phase: "storage-and-dotns", message: "bulletin rpc down" });
    });

    it("wraps build, storage, and playground phases in telemetry spans", async () => {
        const { push } = collectEvents();
        await runDeploy({
            projectDir: "/tmp/proj",
            buildDir: "/tmp/proj/dist",
            domain: "my-app",
            mode: "dev",
            publishToPlayground: true,
            userSigner: fakeUserSigner,
            onEvent: push,
        });

        const ops = withSpanMock.mock.calls.map((call) => call[0]);
        expect(ops).toContain("cli.deploy.build");
        expect(ops).toContain("cli.deploy.storage-dotns");
        expect(ops).toContain("cli.deploy.playground");
    });

    it("phone mode: slot signer injected into storage auth when resolution succeeds", async () => {
        // getBulletinAllowanceSigner succeeds → storageSigner + storageSignerAddress
        // must appear in the auth object passed to runStorageDeploy.
        const { events, push } = collectEvents();
        await runDeploy({
            projectDir: "/tmp/proj",
            buildDir: "/tmp/proj/dist",
            skipBuild: true,
            domain: "my-app",
            mode: "phone",
            publishToPlayground: false,
            userSigner: fakeUserSigner,
            onEvent: push,
        });

        expect(getBulletinAllowanceSignerMock).toHaveBeenCalledTimes(1);
        const arg = runStorageDeploy.mock.calls[0][0];
        // The wrapped signer (from maybeWrapAuthForSigning) carries storageSignerAddress through.
        expect(arg.auth.storageSignerAddress).toBe("5SlotAddress");
        expect(arg.auth.storageSigner).toBeDefined();

        // A signing event must be emitted BEFORE getBulletinAllowanceSigner is
        // called so the TUI can show "check your phone" while the allocator runs.
        const signingEvents = events.filter((e) => e.kind === "signing") as Array<{
            kind: "signing";
            event: any;
        }>;
        expect(
            signingEvents.some((e) => e.event?.label === "Approve Bulletin storage allowance"),
        ).toBe(true);
    });

    it("dev mode: getBulletinAllowanceSigner is NOT called", async () => {
        const { push } = collectEvents();
        await runDeploy({
            projectDir: "/tmp/proj",
            buildDir: "/tmp/proj/dist",
            skipBuild: true,
            domain: "my-app",
            mode: "dev",
            publishToPlayground: false,
            userSigner: null,
            onEvent: push,
        });

        expect(getBulletinAllowanceSignerMock).not.toHaveBeenCalled();
    });

    it("phone mode: slot resolution failure does not abort deploy (pool fallback)", async () => {
        getBulletinAllowanceSignerMock.mockRejectedValueOnce(new Error("allocation failed"));
        const { push } = collectEvents();
        // Should resolve normally — error is swallowed, pool is used.
        await expect(
            runDeploy({
                projectDir: "/tmp/proj",
                buildDir: "/tmp/proj/dist",
                skipBuild: true,
                domain: "my-app",
                mode: "phone",
                publishToPlayground: false,
                userSigner: fakeUserSigner,
                onEvent: push,
            }),
        ).resolves.toBeDefined();

        // auth must NOT contain storageSigner (slot resolution failed).
        const arg = runStorageDeploy.mock.calls[0][0];
        expect(arg.auth.storageSignerAddress).toBeUndefined();
    });
});
