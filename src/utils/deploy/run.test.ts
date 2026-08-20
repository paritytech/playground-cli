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
        fullDomain: "my-app.paseo",
        cid: "bafyapp",
        ipfsCid: "bafyipfs",
    })),
    publishToPlaygroundMock: vi.fn(async () => ({
        metadataCid: "bafymeta",
        fullDomain: "my-app.paseo",
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
}));

vi.mock("./storage.js", () => ({ runStorageDeploy }));
vi.mock("./playground.js", () => ({
    publishToPlayground: publishToPlaygroundMock,
    // Mirrors the real TLD-aware signature: runDeploy resolves the tld via
    // getEnvTld(options.env) ("paseo" for the default env) and threads it in.
    normalizeDomain: (d: string, tld: string) => {
        const label = d.replace(new RegExp(`\\.${tld}$`), "");
        return { label, fullDomain: `${label}.${tld}` };
    },
}));
vi.mock("../build/index.js", () => ({
    runBuild: runBuildMock,
    loadDetectInput: loadDetectInputMock,
    detectBuildConfig: detectBuildConfigMock,
}));
// These orchestration tests use a fake `/tmp/proj` and mock every I/O boundary;
// the real skip-build artifacts check (covered by buildDir.test.ts) would trip
// on the non-existent path, so stub it to a no-op here. Hoisted so the wiring
// (called with projectDir + buildDir on skip-build) can be asserted.
const { assertBuildDirExistsMock } = vi.hoisted(() => ({
    assertBuildDirExistsMock: vi.fn(),
}));
vi.mock("./buildDir.js", () => ({ assertBuildDirExists: assertBuildDirExistsMock }));
vi.mock("../../telemetry.js", () => ({
    withSpan: (...args: unknown[]) =>
        withSpanMock(args[0] as string, args[1] as string, args[2], args[3]),
    errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

// Boundary mock for the BulletInAllowance slot key. Phone-mode deploys
// resolve it as the Bulletin STORAGE signer (chunk txs are too large for the
// phone's statement-store channel). The slot public key differs from the
// session signer's so assertions can prove which key was threaded through.
const SLOT_PUBLIC_KEY = new Uint8Array(32).fill(7);
const slotSigner = { publicKey: SLOT_PUBLIC_KEY } as any;
const { getBulletinAllowanceSignerMock, createBulletinAuthContextMock, authDestroyMock } =
    vi.hoisted(() => ({
        getBulletinAllowanceSignerMock: vi.fn(),
        createBulletinAuthContextMock: vi.fn(),
        authDestroyMock: vi.fn(),
    }));
vi.mock("../allowances/bulletin.js", () => ({
    getBulletinAllowanceSigner: getBulletinAllowanceSignerMock,
}));
vi.mock("./bulletinAuthContext.js", () => ({
    createBulletinAuthContext: createBulletinAuthContextMock,
}));
const bulletinApi = { marker: "bulletin-api" } as any;

import { DEFAULT_MNEMONIC } from "bulletin-deploy";
import { runDeploy, type DeployEvent } from "./run.js";
import { DEV_PUBLISH_ADDRESS } from "./signerMode.js";
import type { ResolvedSigner } from "../signer.js";

const fakeUserSigner: ResolvedSigner = {
    signer: {
        publicKey: new Uint8Array(32),
        signTx: vi.fn(),
        signBytes: vi.fn(),
    },
    address: "5Fake",
    source: "session",
    // Host wiring consumed by resolveStorageSignerOptions in phone mode.
    userSession: {} as any,
    adapter: {} as any,
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
    assertBuildDirExistsMock.mockClear();
    withSpanMock.mockClear();
    getBulletinAllowanceSignerMock.mockReset();
    getBulletinAllowanceSignerMock.mockResolvedValue(slotSigner);
    createBulletinAuthContextMock.mockReset();
    authDestroyMock.mockClear();
    createBulletinAuthContextMock.mockReturnValue({
        bulletinApi,
        destroy: authDestroyMock,
    });
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

        expect(outcome.fullDomain).toBe("my-app.paseo");
        expect(outcome.approvalsRequested).toEqual([]);
        expect(publishToPlaygroundMock).not.toHaveBeenCalled();

        const plan = events.find((e) => e.kind === "plan");
        expect(plan).toEqual({ kind: "plan", approvals: [] });

        // polkadot-app-deploy auth must pin the dev identity explicitly: an
        // empty object makes 0.8.x resolve the persisted phone session for
        // DotNS and the user's cached slot key for storage (see signerMode.ts).
        expect(runStorageDeploy).toHaveBeenCalledTimes(1);
        const arg = runStorageDeploy.mock.calls[0][0];
        expect(arg.auth.mnemonic).toBe(DEFAULT_MNEMONIC);
        expect(arg.auth.signer).toBeUndefined();
        expect(arg.auth.storageSignerAddress).toBe(DEV_PUBLISH_ADDRESS);
        expect(arg.domainName).toBe("my-app");

        // Dev mode never opens a Bulletin client for the authorization check —
        // no slot signer is used, so there is nothing to verify.
        expect(createBulletinAuthContextMock).not.toHaveBeenCalled();
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

    it("threads the chosen tag into publishToPlayground (and defaults to null)", async () => {
        const { push } = collectEvents();
        await runDeploy({
            projectDir: "/tmp/proj",
            buildDir: "/tmp/proj/dist",
            domain: "tagged",
            mode: "phone",
            publishToPlayground: true,
            tag: "site",
            userSigner: fakeUserSigner,
            onEvent: push,
        });
        const tagged = (publishToPlaygroundMock.mock.calls as unknown[][])[0]?.[0] as
            | { tag?: string | null }
            | undefined;
        expect(tagged?.tag).toBe("site");

        publishToPlaygroundMock.mockClear();

        // No tag supplied ⇒ publishToPlayground receives an explicit null.
        await runDeploy({
            projectDir: "/tmp/proj",
            buildDir: "/tmp/proj/dist",
            domain: "untagged",
            mode: "phone",
            publishToPlayground: true,
            userSigner: fakeUserSigner,
            onEvent: push,
        });
        const untagged = (publishToPlaygroundMock.mock.calls as unknown[][])[0]?.[0] as
            | { tag?: string | null }
            | undefined;
        expect(untagged?.tag).toBeNull();
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

        // polkadot-app-deploy auth must carry a wrapped signer + our address.
        const arg = runStorageDeploy.mock.calls[0][0];
        expect(arg.auth.signerAddress).toBe("5Fake");
        expect(arg.auth.signer).toBeDefined();

        // Bulletin STORAGE must sign with the local slot key, never the phone
        // signer: chunk txs carry up to 2 MiB of callData and the phone's
        // statement-store channel rejects them as "message too big" before
        // the phone is even contacted. storageSigner takes precedence over
        // signer for storage routing inside polkadot-app-deploy 0.8.3+.
        expect(arg.auth.storageSigner).toBe(slotSigner);
        expect(arg.auth.storageSignerAddress).toBeDefined();
        expect(arg.auth.storageSignerAddress).not.toBe("5Fake");

        // The Bulletin client flows into the allowance resolution so the
        // slot's authorization is verified (existence + non-expiry) BEFORE the
        // upload starts (mid-upload Payment failures never fall back to the
        // pool), and the dedicated WS client is always torn down. No quota /
        // requiredBytes is passed — Bulletin `store` treats those as soft limits.
        expect(createBulletinAuthContextMock).toHaveBeenCalledWith(undefined);
        expect(getBulletinAllowanceSignerMock).toHaveBeenCalledWith({
            publishSigner: fakeUserSigner,
            bulletinApi,
            // The deploy threads a "check your phone" prompt into the
            // allowance resolution — allocation taps happen outside any
            // PolkadotSigner, so this hook is their only TUI surface.
            onPrompt: expect.any(Function),
        });
        expect(authDestroyMock).toHaveBeenCalledTimes(1);

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

    it("phone mode + re-deploy (plan.action=update): only setContenthash + playground taps", async () => {
        // When the domain is already owned by the signer, polkadot-app-deploy
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
            plan: { action: "update" },
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

    it("checks the build artifacts exist before deploying when skipping the build", async () => {
        const { push } = collectEvents();
        await runDeploy({
            projectDir: "/tmp/proj",
            buildDir: "dist",
            skipBuild: true,
            domain: "my-app",
            mode: "dev",
            publishToPlayground: false,
            userSigner: null,
            onEvent: push,
        });
        expect(assertBuildDirExistsMock).toHaveBeenCalledWith("/tmp/proj", "dist");
    });

    it("uploads the build artifacts resolved against projectDir, not the process cwd", async () => {
        // polkadot-app-deploy resolves a relative `content` against process.cwd()
        // (deploy.js: `path.resolve(content)`), but the build writes to
        // `projectDir/<buildDir>`. Passing the raw relative path would make a
        // `--dir`-from-another-cwd deploy upload the wrong directory. We resolve
        // against projectDir so storage reads exactly where the build wrote.
        const { push } = collectEvents();
        await runDeploy({
            projectDir: "/tmp/proj",
            buildDir: "dist",
            skipBuild: true,
            domain: "my-app",
            mode: "dev",
            publishToPlayground: false,
            userSigner: null,
            onEvent: push,
        });
        const arg = runStorageDeploy.mock.calls[0][0];
        expect(arg.content).toBe("/tmp/proj/dist");
    });

    it("does NOT check build artifacts when a build will produce them", async () => {
        const { push } = collectEvents();
        await runDeploy({
            projectDir: "/tmp/proj",
            buildDir: "dist",
            skipBuild: false,
            domain: "my-app",
            mode: "dev",
            publishToPlayground: false,
            userSigner: null,
            onEvent: push,
        });
        expect(assertBuildDirExistsMock).not.toHaveBeenCalled();
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

    it("runs the on-chain phases inside the signing gate, but not the build", async () => {
        // Record gate hold transitions and which phase fired during each, so we
        // can prove (a) signing happens under the gate and (b) the build does
        // not — the nonce-safety contract for parallel deploys.
        let held = false;
        const buildWhileHeld: boolean[] = [];
        const storageWhileHeld: boolean[] = [];

        runBuildMock.mockImplementationOnce(async () => {
            buildWhileHeld.push(held);
            return { config: {} as any, outputDir: "/tmp/dist" };
        });
        runStorageDeploy.mockImplementationOnce(async () => {
            storageWhileHeld.push(held);
            return {
                domainName: "my-app",
                fullDomain: "my-app.paseo",
                cid: "bafyapp",
                ipfsCid: "bafyipfs",
            };
        });

        const gate = {
            runExclusive: vi.fn(async <T>(fn: () => Promise<T>): Promise<T> => {
                held = true;
                try {
                    return await fn();
                } finally {
                    held = false;
                }
            }),
        };

        const { push } = collectEvents();
        await runDeploy({
            projectDir: "/tmp/proj",
            buildDir: "/tmp/proj/dist",
            domain: "my-app",
            mode: "dev",
            publishToPlayground: true,
            userSigner: fakeUserSigner,
            onEvent: push,
            signingGate: gate as any,
        });

        expect(gate.runExclusive).toHaveBeenCalledTimes(1);
        // Build ran before/outside the gate; storage (signing) ran inside it.
        expect(buildWhileHeld).toEqual([false]);
        expect(storageWhileHeld).toEqual([true]);
        // The publish (also on-chain) shared the same single gate acquisition.
        expect(publishToPlaygroundMock).toHaveBeenCalledTimes(1);
    });

    it("is unchanged when no signing gate is provided (single-deploy path)", async () => {
        const { push } = collectEvents();
        const outcome = await runDeploy({
            projectDir: "/tmp/proj",
            buildDir: "/tmp/proj/dist",
            domain: "my-app",
            mode: "dev",
            publishToPlayground: false,
            userSigner: null,
            onEvent: push,
        });
        expect(outcome.fullDomain).toBe("my-app.paseo");
        expect(runStorageDeploy).toHaveBeenCalledTimes(1);
    });
});
