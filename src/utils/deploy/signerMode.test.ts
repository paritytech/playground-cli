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

// Boundary mock: resolveStorageSignerOptions delegates slot resolution to
// allowances/bulletin.ts (single source for allocation, corrected derivation,
// and the quota/Increase flow). signerMode only owns the mode matrix.
const { getBulletinAllowanceSignerMock } = vi.hoisted(() => ({
    getBulletinAllowanceSignerMock: vi.fn(),
}));

vi.mock("../allowances/bulletin.js", () => ({
    getBulletinAllowanceSigner: getBulletinAllowanceSignerMock,
}));

import { DEFAULT_MNEMONIC } from "bulletin-deploy";
import { ss58Encode } from "@parity/product-sdk-address";
import {
    resolveSignerSetup,
    resolveStorageSignerOptions,
    DEV_PUBLISH_ADDRESS,
} from "./signerMode.js";
import type { ResolvedSigner } from "../signer.js";

function fakeSigner(
    source: "dev" | "session",
    address = "5FakeAddress",
    productH160: `0x${string}` = "0xbeefbeefbeefbeefbeefbeefbeefbeefbeefbeef",
): ResolvedSigner {
    return {
        signer: {} as any,
        address,
        source,
        ...(source === "session"
            ? {
                  addresses: {
                      rootAddress: "5RootFake",
                      productAddress: address,
                      productH160,
                  },
              }
            : {}),
        destroy: () => {},
    };
}

describe("resolveSignerSetup — dev mode", () => {
    it("no publish, no funding → empty approvals, explicit dev mnemonic, null publishSigner", () => {
        const result = resolveSignerSetup({
            mode: "dev",
            userSigner: null,
            publishToPlayground: false,
        });
        expect(result.approvals).toEqual([]);
        expect(result.bulletinDeployAuthOptions).toEqual({ mnemonic: DEFAULT_MNEMONIC });
        expect(result.publishSigner).toBeNull();
    });

    it("pins the DEFAULT_MNEMONIC explicitly so polkadot-app-deploy can never pick up a persisted phone session", () => {
        // Regression: polkadot-app-deploy 0.8.x resolves the persisted SSO session
        // (~/.polkadot-apps/dot-cli_SsoSessions.json — written by `playground
        // login`, shared namespace) whenever it is called with NO mnemonic, NO
        // signer, and NO suri. Passing `{}` therefore turned dev mode into
        // phone mode (DotNS taps on the phone) for every logged-in user.
        // An explicit mnemonic short-circuits its chooseSignerInput before
        // the session probe.
        const result = resolveSignerSetup({
            mode: "dev",
            userSigner: fakeSigner("session", "5User"),
            publishToPlayground: false,
        });
        expect(result.bulletinDeployAuthOptions.mnemonic).toBe(DEFAULT_MNEMONIC);
        // No signer key: run.ts's maybeWrapAuthForSigning must not wrap dev
        // deploys in the phone-approval event proxy.
        expect(result.bulletinDeployAuthOptions.signer).toBeUndefined();
        expect(result.bulletinDeployAuthOptions.signerAddress).toBeUndefined();
    });

    it("publishToPlayground with active session signs as Alice but claims session H160 as owner — zero phone taps", () => {
        const user = fakeSigner("session", "5User", "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        const result = resolveSignerSetup({
            mode: "dev",
            userSigner: user,
            publishToPlayground: true,
        });
        // No playground approval — dev account signs, user taps nothing.
        expect(result.approvals).toEqual([]);
        // Publish signer is a constructed dev signer (Alice), NOT the session.
        expect(result.publishSigner).not.toBe(user);
        expect(result.publishSigner?.source).toBe("dev");
        // The user's H160 is claimed via the owner parameter so MyApps still
        // resolves their app even though Alice signed the tx.
        expect(result.claimedOwnerH160).toBe("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        // Dev mode keeps polkadot-app-deploy on its built-in default mnemonic —
        // passed EXPLICITLY so the persisted phone session is never resolved.
        expect(result.bulletinDeployAuthOptions).toEqual({ mnemonic: DEFAULT_MNEMONIC });
    });

    it("publishToPlayground without any signer falls back to pure Alice ownership", () => {
        // Pure dev: no `--suri`, no session. Alice publishes AS Alice (her
        // H160 ends up as both publisher and owner). The user explicitly
        // opted into throwaway dev mode.
        const result = resolveSignerSetup({
            mode: "dev",
            userSigner: null,
            publishToPlayground: true,
        });
        expect(result.approvals).toEqual([]);
        expect(result.publishSigner?.source).toBe("dev");
        expect(result.claimedOwnerH160).toBeNull();
    });

    it("dev SURI signer is forwarded to DotNS auth AND used as the publish signer", () => {
        const user = fakeSigner("dev", "5DevSuri");
        const result = resolveSignerSetup({
            mode: "dev",
            userSigner: user,
            publishToPlayground: true,
        });
        // SURI dev signers don't need a claimed owner — the SURI address IS
        // the user's chosen address, recorded as caller by default.
        expect(result.approvals).toEqual([]);
        expect(result.publishSigner).toBe(user);
        expect(result.claimedOwnerH160).toBeNull();
        expect(result.bulletinDeployAuthOptions.signer).toBe(user.signer);
        expect(result.bulletinDeployAuthOptions.signerAddress).toBe("5DevSuri");
        // The injected signer wins inside polkadot-app-deploy; no mnemonic needed.
        expect(result.bulletinDeployAuthOptions.mnemonic).toBeUndefined();
    });
});

describe("resolveSignerSetup — phone mode", () => {
    it("no userSigner throws a helpful message", () => {
        expect(() =>
            resolveSignerSetup({
                mode: "phone",
                userSigner: null,
                publishToPlayground: false,
            }),
        ).toThrow(/playground login|--signer dev/);
    });

    it("no plan + no publish → 3 DotNS approvals in exact order, auth options wired to user signer", () => {
        const user = fakeSigner("session", "5UserPhone");
        const result = resolveSignerSetup({
            mode: "phone",
            userSigner: user,
            publishToPlayground: false,
        });
        expect(result.approvals).toEqual([
            { phase: "dotns", label: "Reserve domain (DotNS commitment)" },
            { phase: "dotns", label: "Finalize domain (DotNS register)" },
            { phase: "dotns", label: "Link content (DotNS setContenthash)" },
        ]);
        expect(result.bulletinDeployAuthOptions.signer).toBe(user.signer);
        expect(result.bulletinDeployAuthOptions.signerAddress).toBe("5UserPhone");
        expect(result.publishSigner).toBeNull();
    });

    it("plan action=update → single setContenthash approval (no commitment/register)", () => {
        const user = fakeSigner("session");
        const result = resolveSignerSetup({
            mode: "phone",
            userSigner: user,
            publishToPlayground: false,
            plan: { action: "update" },
        });
        expect(result.approvals).toEqual([
            { phase: "dotns", label: "Link content (DotNS setContenthash)" },
        ]);
    });

    it("publishToPlayground appends the playground entry after the DotNS entries", () => {
        const user = fakeSigner("session");
        const result = resolveSignerSetup({
            mode: "phone",
            userSigner: user,
            publishToPlayground: true,
        });
        expect(result.approvals).toEqual([
            { phase: "dotns", label: "Reserve domain (DotNS commitment)" },
            { phase: "dotns", label: "Finalize domain (DotNS register)" },
            { phase: "dotns", label: "Link content (DotNS setContenthash)" },
            { phase: "playground", label: "Publish to Playground registry" },
        ]);
        expect(result.publishSigner).toBe(user);
    });
});

describe("resolveStorageSignerOptions", () => {
    // The slot key's public key deliberately differs from the session
    // signer's so the address assertions can prove which key was chosen.
    const SLOT_PUBLIC_KEY = new Uint8Array(32).fill(7);
    const SLOT_SIGNER = { publicKey: SLOT_PUBLIC_KEY } as any;

    function sessionSignerWithHost(): ResolvedSigner {
        return {
            ...fakeSigner("session", "5UserPhone"),
            userSession: {} as any,
            adapter: {} as any,
        };
    }

    beforeEach(() => {
        getBulletinAllowanceSignerMock.mockReset();
    });

    it("phone mode with a session resolves the Bulletin slot key as the storage signer", async () => {
        // Bulletin chunk txs carry up to 2 MiB of callData. The statement-store
        // session to the phone caps request messages far below that, so the
        // storage signer MUST be a local key — the BulletInAllowance slot
        // account — never the phone session signer.
        getBulletinAllowanceSignerMock.mockResolvedValue(SLOT_SIGNER);
        const user = sessionSignerWithHost();

        const result = await resolveStorageSignerOptions("phone", user);

        expect(result.storageSigner).toBe(SLOT_SIGNER);
        expect(result.storageSignerAddress).toBe(ss58Encode(SLOT_PUBLIC_KEY));
        expect(result.storageSignerAddress).not.toBe(user.address);
        expect(getBulletinAllowanceSignerMock).toHaveBeenCalledWith({
            publishSigner: user,
            bulletinApi: undefined,
            onPrompt: undefined,
        });
    });

    it("forwards the bulletin API so the slot's authorization is verified (existence + non-expiry)", async () => {
        getBulletinAllowanceSignerMock.mockResolvedValue(SLOT_SIGNER);
        const user = sessionSignerWithHost();
        const bulletinApi = { marker: true } as any;

        await resolveStorageSignerOptions("phone", user, bulletinApi);

        expect(getBulletinAllowanceSignerMock).toHaveBeenCalledWith({
            publishSigner: user,
            bulletinApi,
            onPrompt: undefined,
        });
        // No quota arg exists any more — a single resolution, no Increase pass.
        expect(getBulletinAllowanceSignerMock).toHaveBeenCalledTimes(1);
    });

    it("dev mode pins storage to the dev publish account — never the user's slot key, no phone prompt", async () => {
        // Regression: polkadot-app-deploy 0.8.x auto-reads the user's cached
        // BulletInAllowance slot key whenever `storageSigner` is absent and
        // signs chunk uploads with it — silently burning the user's small
        // phone-granted quota on dev deploys. Pinning the dev bare-root
        // (authorized on paseo-next-v2; pool fallback if it ever lapses)
        // keeps dev deploys fully off the user's session resources.
        const user = sessionSignerWithHost();
        const result = await resolveStorageSignerOptions("dev", user);
        expect(result.storageSigner).toBeDefined();
        expect(result.storageSignerAddress).toBe(DEV_PUBLISH_ADDRESS);
        expect(getBulletinAllowanceSignerMock).not.toHaveBeenCalled();
    });

    it("dev mode with a --suri signer pins storage to that key (caller owns its allowance)", async () => {
        const user = fakeSigner("dev", "5DevSuri");
        const result = await resolveStorageSignerOptions("dev", user);
        expect(result.storageSigner).toBe(user.signer);
        expect(result.storageSignerAddress).toBe("5DevSuri");
        expect(getBulletinAllowanceSignerMock).not.toHaveBeenCalled();
    });

    it("phone mode with a --suri dev signer pins storage to that key (local key, no size hazard, no slot hijack)", async () => {
        const user = fakeSigner("dev", "5DevSuri");
        const result = await resolveStorageSignerOptions("phone", user);
        expect(result.storageSigner).toBe(user.signer);
        expect(result.storageSignerAddress).toBe("5DevSuri");
        expect(getBulletinAllowanceSignerMock).not.toHaveBeenCalled();
    });

    it("phone mode with no signer returns {}", async () => {
        await expect(resolveStorageSignerOptions("phone", null)).resolves.toEqual({});
    });

    it("slot resolution failure surfaces an actionable error, not a cryptic chunk failure", async () => {
        // Without the slot key, polkadot-app-deploy would route 2 MiB chunk txs to
        // the phone and every one would die with "message too big" after
        // retries. Fail fast with a fix-it hint instead.
        getBulletinAllowanceSignerMock.mockRejectedValue(new Error("user declined"));
        await expect(resolveStorageSignerOptions("phone", sessionSignerWithHost())).rejects.toThrow(
            /playground login/,
        );
    });

    it("a missing/expired authorization aborts with the actionable error (no quota retry)", async () => {
        // The quota two-pass warn-and-proceed is gone: there is nothing left to
        // downgrade to, because we no longer gate on quota at all. A genuine
        // existence/expiry failure is terminal and surfaces the fix-it hint.
        getBulletinAllowanceSignerMock.mockRejectedValue(
            new Error(
                "Bulletin allowance for 5Slot has expired. Re-run `playground login` and approve on your phone.",
            ),
        );
        await expect(
            resolveStorageSignerOptions("phone", sessionSignerWithHost(), { marker: true } as any),
        ).rejects.toThrow(/playground login/);
        // One resolution attempt only — no second quota-free retry.
        expect(getBulletinAllowanceSignerMock).toHaveBeenCalledTimes(1);
    });

    it("session missing host wiring throws the login hint", async () => {
        // requireSession inside getBulletinAllowanceSigner fires here; the
        // wrap keeps the message actionable either way.
        getBulletinAllowanceSignerMock.mockRejectedValue(
            new Error(
                'No Bulletin allowance account available. Run "playground login" to grant allowances.',
            ),
        );
        const user = fakeSigner("session"); // no userSession / adapter
        await expect(resolveStorageSignerOptions("phone", user)).rejects.toThrow(
            /playground login/,
        );
    });
});
