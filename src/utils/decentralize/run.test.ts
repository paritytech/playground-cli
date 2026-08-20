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

import { beforeEach, describe, expect, it, vi } from "vitest";

// Heavy underlying pieces mocked — the orchestrator test only cares about
// which signer reaches the Bulletin storage layer. Same pattern as
// `../deploy/run.test.ts`.
const {
    runStorageDeployMock,
    mirrorSiteMock,
    prepareLocalDirectoryMock,
    findProjectRootMock,
    ensureSlotAccountSignerMock,
    publishToPlaygroundMock,
} = vi.hoisted(() => ({
    // Explicit arg type so `mock.calls[0][0]` typechecks (an arg-less vi.fn
    // infers Parameters = [] and indexing the empty tuple is a tsc error).
    runStorageDeployMock: vi.fn<
        (arg: unknown) => Promise<{
            domainName: string;
            fullDomain: string;
            cid: string;
            ipfsCid: string;
        }>
    >(async () => ({
        domainName: "my-site",
        fullDomain: "my-site.paseo",
        cid: "bafysite",
        ipfsCid: "bafyipfs",
    })),
    mirrorSiteMock: vi.fn(async () => ({
        directory: "/tmp/playground-cli-test-mirror-does-not-exist",
        uploadRoot: "/tmp/playground-cli-test-mirror-does-not-exist",
        fileCount: 3,
    })),
    prepareLocalDirectoryMock: vi.fn(() => ({
        uploadRoot: "/tmp/playground-cli-test-local-does-not-exist",
        fileCount: 5,
    })),
    // Stand-in repo root: the runner walks up from the typed --path to the
    // enclosing git repo so the project README (not the build dir) is inlined.
    findProjectRootMock: vi.fn((dir: string) => `${dir}/__repo_root__`),
    ensureSlotAccountSignerMock: vi.fn(),
    publishToPlaygroundMock: vi.fn<(arg: unknown) => Promise<{ metadataCid: string }>>(
        async () => ({ metadataCid: "bafymeta" }),
    ),
}));

vi.mock("../deploy/storage.js", () => ({ runStorageDeploy: runStorageDeployMock }));
vi.mock("../deploy/playground.js", () => ({ publishToPlayground: publishToPlaygroundMock }));
vi.mock("./mirror.js", () => ({ mirrorSite: mirrorSiteMock }));
vi.mock("./local.js", () => ({
    prepareLocalDirectory: prepareLocalDirectoryMock,
    findProjectRoot: findProjectRootMock,
}));
vi.mock("@parity/product-sdk-terminal/host", () => ({
    createSlotAccountSigner: vi.fn(),
    ensureSlotAccountSigner: ensureSlotAccountSignerMock,
    // Slot key reported as cached so no grant prompt fires — these tests
    // exercise storage-signer routing, not the approval UI.
    getCachedAllocation: vi.fn(async () => ({ tag: "BulletInAllowance" })),
    requestResourceAllocation: vi.fn(),
}));
import { DEFAULT_MNEMONIC } from "bulletin-deploy";
import type { ResolvedSigner } from "../signer.js";
import { DEV_PUBLISH_ADDRESS } from "../deploy/signerMode.js";
import type { DecentralizeLogEvent } from "./run.js";
import { describeDeployEvent, LARGE_SITE_FILE_THRESHOLD, runDecentralize } from "./run.js";

describe("describeDeployEvent", () => {
    it("renders chunk-progress as a human-readable upload line", () => {
        expect(describeDeployEvent({ kind: "chunk-progress", current: 3, total: 7 })).toBe(
            "uploading chunk 3/7",
        );
    });

    it("passes info messages through verbatim", () => {
        expect(describeDeployEvent({ kind: "info", message: "reserving domain" })).toBe(
            "reserving domain",
        );
    });

    it("drops phase-start banners (step rows / phase headers convey those)", () => {
        // This is the bug the rewrite fixed: phase banners used to surface as
        // the raw "phase-start" string in the log tail.
        expect(describeDeployEvent({ kind: "phase-start", phase: "storage" })).toBeNull();
    });
});

describe("runDecentralize — Bulletin storage signer", () => {
    const SLOT_PUBLIC_KEY = new Uint8Array(32).fill(7);
    const slotSigner = { publicKey: SLOT_PUBLIC_KEY } as any;

    const sessionSigner: ResolvedSigner = {
        signer: {
            publicKey: new Uint8Array(32),
            signTx: vi.fn(),
            signBytes: vi.fn(),
        } as any,
        address: "5Fake",
        source: "session",
        userSession: {} as any,
        adapter: {} as any,
        addresses: {
            rootAddress: "5Root",
            productAddress: "5Fake",
            productH160: "0xbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef",
        },
        destroy: vi.fn(),
    };

    beforeEach(() => {
        runStorageDeployMock.mockClear();
        mirrorSiteMock.mockClear();
        prepareLocalDirectoryMock.mockClear();
        ensureSlotAccountSignerMock.mockReset();
        ensureSlotAccountSignerMock.mockResolvedValue(slotSigner);
    });

    it("phone mode threads the slot key as storageSigner — chunks never phone-sign", async () => {
        await runDecentralize({
            source: { kind: "url", url: "https://example.com" },
            label: "my-site",
            fullDomain: "my-site.paseo",
            mode: "phone",
            userSigner: sessionSigner,
            env: "paseo-next-v2",
        });

        expect(runStorageDeployMock).toHaveBeenCalledTimes(1);
        const arg = runStorageDeployMock.mock.calls[0][0] as unknown as {
            auth: {
                signerAddress?: string;
                storageSigner?: unknown;
                storageSignerAddress?: string;
            };
        };
        // DotNS keeps the phone signer...
        expect(arg.auth.signerAddress).toBe("5Fake");
        // ...but Bulletin storage signs with the local slot key.
        expect(arg.auth.storageSigner).toBe(slotSigner);
        expect(arg.auth.storageSignerAddress).toBeDefined();
        expect(arg.auth.storageSignerAddress).not.toBe("5Fake");
    });

    it("dev mode pins the dev mnemonic + dev storage signer and never touches the slot key", async () => {
        await runDecentralize({
            source: { kind: "url", url: "https://example.com" },
            label: "my-site",
            fullDomain: "my-site.paseo",
            mode: "dev",
            userSigner: null,
            env: "paseo-next-v2",
        });

        const arg = runStorageDeployMock.mock.calls[0][0] as unknown as {
            auth: { mnemonic?: string; signer?: unknown; storageSignerAddress?: string };
        };
        // Explicit dev identity: an empty auth object would let polkadot-app-deploy
        // 0.8.x resolve the persisted phone session (DotNS taps) and the
        // user's cached slot key (quota burn). See signerMode.ts.
        expect(arg.auth.mnemonic).toBe(DEFAULT_MNEMONIC);
        expect(arg.auth.signer).toBeUndefined();
        expect(arg.auth.storageSignerAddress).toBe(DEV_PUBLISH_ADDRESS);
        expect(ensureSlotAccountSignerMock).not.toHaveBeenCalled();
    });

    it("local path skips the mirror and uploads the prepared directory", async () => {
        const events: DecentralizeLogEvent[] = [];
        await runDecentralize({
            source: { kind: "path", directory: "./dist" },
            label: "my-site",
            fullDomain: "my-site.paseo",
            mode: "dev",
            userSigner: null,
            env: "paseo-next-v2",
            onEvent: (ev) => events.push(ev),
        });

        expect(mirrorSiteMock).not.toHaveBeenCalled();
        expect(prepareLocalDirectoryMock).toHaveBeenCalledWith("./dist");
        const arg = runStorageDeployMock.mock.calls[0][0] as unknown as { content: string };
        expect(arg.content).toBe("/tmp/playground-cli-test-local-does-not-exist");
        // The path branch emits local-done and none of the mirror events.
        expect(events.some((e) => e.kind === "local-done")).toBe(true);
        expect(events.some((e) => e.kind.startsWith("mirror-"))).toBe(false);
    });

    it("local path in phone mode still routes storage through the slot key", async () => {
        // Signer routing is source-independent: chunks must never phone-sign
        // regardless of where the site content came from.
        await runDecentralize({
            source: { kind: "path", directory: "./dist" },
            label: "my-site",
            fullDomain: "my-site.paseo",
            mode: "phone",
            userSigner: sessionSigner,
            env: "paseo-next-v2",
        });

        const arg = runStorageDeployMock.mock.calls[0][0] as unknown as {
            auth: { signerAddress?: string; storageSigner?: unknown };
        };
        expect(arg.auth.signerAddress).toBe("5Fake");
        expect(arg.auth.storageSigner).toBe(slotSigner);
    });
});

describe("runDecentralize — playground publish metadata", () => {
    beforeEach(() => {
        runStorageDeployMock.mockClear();
        mirrorSiteMock.mockClear();
        prepareLocalDirectoryMock.mockClear();
        publishToPlaygroundMock.mockClear();
        ensureSlotAccountSignerMock.mockReset();
        ensureSlotAccountSignerMock.mockResolvedValue({ publicKey: new Uint8Array(32) } as any);
    });

    type PublishArg = {
        repositoryUrl: string | null;
        isModdable?: boolean;
        cwd?: string;
    };

    it("path source threads the preflighted repo URL + cwd (README root) through", async () => {
        const outcome = await runDecentralize({
            source: { kind: "path", directory: "./dist" },
            label: "my-site",
            fullDomain: "my-site.paseo",
            mode: "dev",
            userSigner: null,
            publishToPlayground: true,
            repositoryUrl: "https://github.com/acme/site",
            env: "paseo-next-v2",
        });

        expect(publishToPlaygroundMock).toHaveBeenCalledTimes(1);
        const arg = publishToPlaygroundMock.mock.calls[0][0] as PublishArg;
        expect(arg.repositoryUrl).toBe("https://github.com/acme/site");
        expect(arg.isModdable).toBe(true);
        // cwd is the resolved git repo root (walked up from the typed --path),
        // not the build dir — publishToPlayground inlines the *project* README
        // as the app's detail page, matching how the moddable origin resolves.
        expect(findProjectRootMock).toHaveBeenCalledWith("./dist");
        expect(arg.cwd).toBe("./dist/__repo_root__");
        expect(outcome.metadataCid).toBe("bafymeta");
    });

    it("path source without a repo URL still inlines the README but is not moddable", async () => {
        await runDecentralize({
            source: { kind: "path", directory: "./dist" },
            label: "my-site",
            fullDomain: "my-site.paseo",
            mode: "dev",
            userSigner: null,
            publishToPlayground: true,
            env: "paseo-next-v2",
        });

        const arg = publishToPlaygroundMock.mock.calls[0][0] as PublishArg;
        expect(arg.repositoryUrl).toBeNull();
        expect(arg.isModdable).toBe(false);
        expect(arg.cwd).toBe("./dist/__repo_root__");
    });

    it("url source records no repository, no moddable bit, and no project root", async () => {
        // Mirrored sites have no git source: even if a caller smuggled a repo
        // URL in, the contract for url mode is null/false/undefined — pinned
        // here without the smuggling (callers can't reach the option in url
        // mode through the CLI surface).
        await runDecentralize({
            source: { kind: "url", url: "https://example.com" },
            label: "my-site",
            fullDomain: "my-site.paseo",
            mode: "dev",
            userSigner: null,
            publishToPlayground: true,
            env: "paseo-next-v2",
        });

        const arg = publishToPlaygroundMock.mock.calls[0][0] as PublishArg;
        expect(arg.repositoryUrl).toBeNull();
        expect(arg.isModdable).toBe(false);
        expect(arg.cwd).toBeUndefined();
    });
});

describe("runDecentralize — large-site warning", () => {
    beforeEach(() => {
        runStorageDeployMock.mockClear();
        mirrorSiteMock.mockReset();
        ensureSlotAccountSignerMock.mockReset();
        ensureSlotAccountSignerMock.mockResolvedValue({ publicKey: new Uint8Array(32) } as any);
    });

    function collectEvents(lineCount: number): Promise<DecentralizeLogEvent[]> {
        // Drive the mock mirror to emit `lineCount` wget output lines so the
        // line-counting threshold logic in runDecentralize is exercised.
        // The hoisted mock is typed arg-less; cast so we can read `onLine`.
        mirrorSiteMock.mockImplementationOnce((async (opts: any) => {
            for (let i = 0; i < lineCount; i++) opts.onLine?.(`saved file ${i}`);
            return {
                directory: "/tmp/playground-cli-test-mirror-does-not-exist",
                uploadRoot: "/tmp/playground-cli-test-mirror-does-not-exist",
                fileCount: lineCount,
            };
        }) as unknown as () => Promise<{
            directory: string;
            uploadRoot: string;
            fileCount: number;
        }>);
        const events: DecentralizeLogEvent[] = [];
        return runDecentralize({
            source: { kind: "url", url: "https://example.com" },
            label: "my-site",
            fullDomain: "my-site.paseo",
            mode: "dev",
            userSigner: null,
            env: "paseo-next-v2",
            onEvent: (ev) => events.push(ev),
        }).then(() => events);
    }

    it("fires mirror-large exactly once after crossing the threshold", async () => {
        const events = await collectEvents(LARGE_SITE_FILE_THRESHOLD + 50);
        const large = events.filter((e) => e.kind === "mirror-large");
        expect(large).toHaveLength(1);
        expect((large[0] as { fileCount: number }).fileCount).toBe(LARGE_SITE_FILE_THRESHOLD);
    });

    it("does not fire mirror-large for a small site", async () => {
        const events = await collectEvents(LARGE_SITE_FILE_THRESHOLD - 1);
        expect(events.some((e) => e.kind === "mirror-large")).toBe(false);
    });
});
