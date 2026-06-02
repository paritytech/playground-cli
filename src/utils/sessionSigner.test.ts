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

import { describe, expect, test, vi } from "vitest";
import { ss58Encode } from "@parity/product-sdk-address";
import { seedToAccount } from "@parity/product-sdk-keys";
import type { UserSession } from "@parity/product-sdk-terminal";
import { PLAYGROUND_PRODUCT_ID } from "../config.js";
import { createPlaygroundSessionSigner } from "./sessionSigner.js";

const DEV_PHRASE = "bottom drive obey lake curtain smoke basket hold race lonely fit walk";

// ────────────────────────────────────────────────────────────────────────────
// Init / deploy / playground-app equivalence
//
// Pins the invariant that every flow which references "the user's account"
// resolves to the *same* SS58 — the product account derived at
// `mnemonic + "/product/{PLAYGROUND_PRODUCT_ID}/0"`.
//
//   - `dot init`'s `getSessionSigner()` builds a signer via
//     `createPlaygroundSessionSigner(session, { productId, derivationIndex })`
//     and displays `ss58Encode(signer.publicKey)`.
//   - `dot deploy --signer phone`'s `preflight()` → `resolveSigner()` →
//     `getSessionSigner()` walks the same `createPlaygroundSessionSigner`
//     path. `userSigner.address` (passed to bulletin-deploy as `signerAddress`)
//     IS `ss58Encode(signer.publicKey)`.
//   - The deployed playground-app's `HostProvider.getProductAccount(dotNsId)`
//     asks the mobile host to compute `seedToAccount(mnemonic,
//     "/product/{dotNsId}/0").publicKey` and SS58-encodes it.
//
// As long as all three pin to the same `(rootPubKey, productId, 0)` triple,
// they yield byte-identical SS58 strings. These tests are the regression guard.
// ────────────────────────────────────────────────────────────────────────────
describe("init / deploy / playground-app account equivalence", () => {
    // Build a stand-in for the mobile's SSO handshake response. Mirrors what
    // `host-papp`'s `createStoredUserSession` would produce: `rootAccountId`
    // is `deriveRootAccount()` on the mobile = the bare-mnemonic keypair pubkey.
    // The other fields aren't read by `createPlaygroundSessionSigner` in the
    // path under test — we only need the types to line up.
    function fakeSession(mnemonic: string): UserSession {
        const root = seedToAccount(mnemonic, "");
        const wallet = seedToAccount(mnemonic, "//SomeWallet"); // simulates the user picking a derived account on mobile
        return {
            id: "test",
            localAccount: { accountId: new Uint8Array(32), pin: undefined },
            // `walletAccount.defaultAccountId()` on Android — distinct from the
            // bare-mnemonic keypair when the user has a derived wallet account.
            remoteAccount: {
                accountId: wallet.publicKey,
                publicKey: wallet.publicKey,
                pin: undefined,
            },
            rootAccountId: root.publicKey,
            // Methods aren't exercised by signer-build — type-only.
        } as unknown as UserSession;
    }

    test("init signer address === deploy signer address === playground-app address", () => {
        const session = fakeSession(DEV_PHRASE);

        // What `dot init`'s `sessionSigningAddress` and `dot deploy --signer phone`'s
        // `userSigner.address` resolve to (both go through `createPlaygroundSessionSigner`).
        const cliSigner = createPlaygroundSessionSigner(session, {
            productId: PLAYGROUND_PRODUCT_ID,
            derivationIndex: 0,
        });
        const cliAddress = ss58Encode(cliSigner.publicKey);

        // What the deployed playground-app's `HostProvider.getProductAccount(dotNsId)`
        // gets back from the mobile (mobile computes this exact derivation).
        const mobileDerived = seedToAccount(DEV_PHRASE, `/product/${PLAYGROUND_PRODUCT_ID}/0`);
        const playgroundAppAddress = ss58Encode(mobileDerived.publicKey);

        expect(cliAddress).toEqual(playgroundAppAddress);
    });

    test("regression: signer does NOT use remoteAccount.accountId (= wallet account)", () => {
        const session = fakeSession(DEV_PHRASE);
        const cliSigner = createPlaygroundSessionSigner(session, {
            productId: PLAYGROUND_PRODUCT_ID,
            derivationIndex: 0,
        });
        const cliAddress = ss58Encode(cliSigner.publicKey);
        const walletAddress = ss58Encode(new Uint8Array(session.remoteAccount.accountId));

        // The pre-fix bug: signer.publicKey was set from session.remoteAccount.accountId
        // (the user's wallet account), not the product-derived account. The wallet
        // account is what the chain sees as From — different from the funded /
        // allowance-granted product account. This regression guard ensures we never
        // slip back into using remoteAccount.accountId as the signer's identity.
        expect(cliAddress).not.toEqual(walletAddress);
    });

    test("reports stale sessions without a root account public key", () => {
        const session = {
            ...fakeSession(DEV_PHRASE),
            rootAccountId: new Uint8Array(),
        } as UserSession;

        expect(() =>
            createPlaygroundSessionSigner(session, {
                productId: PLAYGROUND_PRODUCT_ID,
                derivationIndex: 0,
            }),
        ).toThrow(
            'Stored login session is missing the root account public key. Run "playground logout"',
        );
    });

    test("PLAYGROUND_PRODUCT_ID matches the playground-app's default dotNsId", () => {
        // The deployed playground-app defaults to PLAYGROUND_DOTNS_ID = "playground.dot"
        // (see playground-app/src/config.ts::defaultDotNsId for the non-localhost path).
        // The CLI must use the same productId so both derive the SAME account from
        // a given user mnemonic.
        expect(PLAYGROUND_PRODUCT_ID).toEqual("playground.dot");
    });
});

// ────────────────────────────────────────────────────────────────────────────
// signRaw(Payload) anti-regression — guards against accidental revert to the
// signPayload path (which sends 2 MB calldata to mobile wallets).
// ────────────────────────────────────────────────────────────────────────────
describe("createPlaygroundSessionSigner — signRaw(Payload) routing", () => {
    type OkResult<T> = { isErr(): false; isOk(): true; value: T };
    type ErrResult<E> = { isErr(): true; isOk(): false; error: E };
    function okResult<T>(value: T): OkResult<T> {
        return { isErr: () => false as const, isOk: () => true as const, value };
    }
    function errResult<E>(error: E): ErrResult<E> {
        return { isErr: () => true as const, isOk: () => false as const, error };
    }

    function makeSession(opts: {
        signRaw?: (req: unknown) => Promise<unknown>;
        signPayload?: (req: unknown) => Promise<unknown>;
    } = {}) {
        const root = seedToAccount("bottom drive obey lake curtain smoke basket hold race lonely fit walk", "");
        return {
            id: "test",
            localAccount: { accountId: new Uint8Array(32), pin: undefined },
            remoteAccount: { accountId: root.publicKey, publicKey: root.publicKey, pin: undefined },
            rootAccountId: root.publicKey,
            signRaw: vi.fn(opts.signRaw ?? (async () => { throw new Error("signRaw not stubbed"); })),
            signPayload: vi.fn(opts.signPayload ?? (async () => { throw new Error("signPayload not stubbed"); })),
        } as unknown as UserSession & { signRaw: ReturnType<typeof vi.fn>; signPayload: ReturnType<typeof vi.fn> };
    }

    test("signBytes never calls session.signPayload (anti-regression: message-too-big)", async () => {
        const sig = new Uint8Array(64).fill(0xaa);
        const session = makeSession({
            signRaw: async () => okResult({ signature: sig }),
        });
        const signer = createPlaygroundSessionSigner(session, {
            productId: PLAYGROUND_PRODUCT_ID,
            derivationIndex: 0,
        });
        await signer.signBytes(new Uint8Array([1]));
        expect(session.signPayload).not.toHaveBeenCalled();
        expect(session.signRaw).toHaveBeenCalled();
        const req = (session.signRaw.mock.calls[0] as [{ data: { tag: string } }])[0];
        expect(req.data.tag).toBe("Bytes");
    });

    test("signBytes routes through signRaw with Bytes tag", async () => {
        const sig = new Uint8Array(64).fill(0xbb);
        const session = makeSession({
            signRaw: async () => okResult({ signature: sig }),
        });
        const signer = createPlaygroundSessionSigner(session, {
            productId: PLAYGROUND_PRODUCT_ID,
            derivationIndex: 0,
        });
        const out = await signer.signBytes(new Uint8Array([1, 2, 3]));
        expect(out).toEqual(sig);
        expect(session.signPayload).not.toHaveBeenCalled();
        const req = (session.signRaw.mock.calls[0] as [{ data: { tag: string } }])[0];
        expect(req.data.tag).toBe("Bytes");
    });

    test("mobile rejection surfaces as 'Mobile signing rejected:' prefix", async () => {
        const session = makeSession({
            signRaw: async () => errResult({ message: "user declined" }),
        });
        const signer = createPlaygroundSessionSigner(session, {
            productId: PLAYGROUND_PRODUCT_ID,
            derivationIndex: 0,
        });
        await expect(signer.signBytes(new Uint8Array([1]))).rejects.toThrow(
            "Mobile signing rejected: user declined",
        );
    });
});
