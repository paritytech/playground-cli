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
import { deriveProductAccountPublicKey, seedToAccount } from "@parity/product-sdk-keys";
import type { UserSession } from "@parity/product-sdk-terminal";
import type { PolkadotSigner } from "polkadot-api";
import { PLAYGROUND_PRODUCT_ID, getEnvTld } from "../config.js";
import {
    INCOMPLETE_SESSION_MESSAGE,
    SESSION_EXPIRED_MESSAGE,
    createPlaygroundSessionSigner,
    derivePlaygroundProductPublicKey,
    wrapSignerWithSssFastFail,
} from "./sessionSigner.js";

const { deriveProductPublicKeyMock, createSessionSignerForAccountMock } = vi.hoisted(() => ({
    deriveProductPublicKeyMock: vi.fn(),
    createSessionSignerForAccountMock: vi.fn(),
}));

// RFC-0022 derives the product account from a subtree key only the WALLET can
// produce. The SDK fetches it over the statement store and caches it on disk
// under the default storage dir — so an unmocked call here would hang waiting
// for a phone AND write a bogus key into the developer's real
// ~/.polkadot-apps subtree cache, breaking their live session. We mock the SDK
// boundary and assert what WE control (which productId/index we ask for); the
// derivation math itself is pinned below against host-rust-core's vector.
vi.mock("@parity/product-sdk-terminal", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@parity/product-sdk-terminal")>();
    return {
        ...actual,
        deriveProductPublicKey: deriveProductPublicKeyMock,
        createSessionSignerForAccount: createSessionSignerForAccountMock,
    };
});

const DEV_PHRASE = "bottom drive obey lake curtain smoke basket hold race lonely fit walk";

/**
 * host-rust-core cross-host vector (tests/wasm_crypto_vectors.rs,
 * `product_account_and_entropy_vectors_match_mobile`): the product SUBTREE
 * public key for `//product//myapp.dot` off entropy 0xab x 16, and the account
 * it yields at index 0. Copied from the host's own fixtures — never
 * regenerated from our output.
 */
const HOST_VECTOR_SUBTREE = hexToBytes(
    "4a4c063de30994d4341f1effa157ded4e0b340b2e657f238bef3f930faba192b",
);
const HOST_VECTOR_ACCOUNT = hexToBytes(
    "1c1ae478b564572f806ffa6352b4273d612beb01610b19f4e5bf444521cd5b5c",
);

function hexToBytes(hex: string): Uint8Array {
    return Uint8Array.from(hex.match(/.{2}/g)!.map((b) => Number.parseInt(b, 16)));
}

function toHex(bytes: Uint8Array): string {
    return `0x${Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")}`;
}

// Stand-in for the mobile's SSO handshake response. `rootAccountId` is
// `deriveRootAccount()` on the mobile = the bare-mnemonic keypair pubkey.
// `remoteAccount.accountId` is the wallet's currently-selected substrate
// account (`walletAccount.defaultAccountId()` on Android) — distinct from the
// product account, and the wrong key for `signer.publicKey`. Only those two
// fields are read by `createPlaygroundSessionSigner`.
function fakeSession(opts: { rootAccountId?: Uint8Array; remoteAccountId?: Uint8Array }) {
    return {
        rootAccountId: opts.rootAccountId,
        remoteAccount: { accountId: opts.remoteAccountId ?? new Uint8Array(32).fill(7) },
    } as unknown as UserSession;
}

describe("createPlaygroundSessionSigner", () => {
    const root = seedToAccount(DEV_PHRASE, "");

    // ────────────────────────────────────────────────────────────────────────
    // Login / deploy / playground-app equivalence
    //
    // Every flow that references "the user's account" must resolve to the same
    // SS58 — the product account derived at `mnemonic + "/product/{id}/0"`.
    //   - `playground login` displays `ss58Encode(signer.publicKey)`.
    //   - `playground deploy --signer phone` passes the same SS58 to
    //     polkadot-app-deploy as `signerAddress`.
    //   - The deployed playground-app's `HostProvider.getProductAccount`
    //     asks the mobile to compute `seedToAccount(mnemonic, "/product/{id}/0")`.
    // As long as all three pin the same `(rootPubKey, productId, 0)` triple they
    // yield byte-identical SS58 strings. This is the regression guard.
    // ────────────────────────────────────────────────────────────────────────
    test("asks the SDK for the playground product id at index 0", async () => {
        const session = fakeSession({ rootAccountId: root.publicKey });
        deriveProductPublicKeyMock.mockResolvedValue(HOST_VECTOR_ACCOUNT);

        const key = await derivePlaygroundProductPublicKey(session, {
            productId: PLAYGROUND_PRODUCT_ID,
            derivationIndex: 0,
        });

        expect(deriveProductPublicKeyMock).toHaveBeenCalledWith(session, {
            productId: PLAYGROUND_PRODUCT_ID,
            derivationIndex: 0,
        });
        expect(key).toBe(HOST_VECTOR_ACCOUNT);
    });

    /**
     * The signer must NOT be handed a pre-computed `publicKey`. Supplying one
     * would let the signing key and the address we display drift apart if the
     * two were ever derived by different paths; omitting it makes the SDK
     * resolve both through the same cached subtree. The pre-RFC-0022 bug was
     * the extreme version of this — the signer used
     * `session.remoteAccount.accountId` (the WALLET account), so the chain saw
     * a different `From` than the funded, allowance-granted product account.
     */
    test("builds the signer without pinning a publicKey, so it cannot desync", async () => {
        const session = fakeSession({
            rootAccountId: root.publicKey,
            remoteAccountId: new Uint8Array(32).fill(7),
        });
        createSessionSignerForAccountMock.mockResolvedValue({
            publicKey: HOST_VECTOR_ACCOUNT,
            signTx: async () => new Uint8Array(),
            signBytes: async () => new Uint8Array(),
        } as unknown as PolkadotSigner);

        const signer = await createPlaygroundSessionSigner(session, {
            productId: PLAYGROUND_PRODUCT_ID,
            derivationIndex: 0,
        });

        const [passedSession, passedRef] = createSessionSignerForAccountMock.mock.calls[0];
        expect(passedSession).toBe(session);
        expect(passedRef).toEqual({ productId: PLAYGROUND_PRODUCT_ID, derivationIndex: 0 });
        expect(passedRef).not.toHaveProperty("publicKey");
        expect(signer.publicKey).toEqual(HOST_VECTOR_ACCOUNT);
        expect(ss58Encode(signer.publicKey)).not.toEqual(ss58Encode(new Uint8Array(32).fill(7)));
    });

    /**
     * Cross-host agreement, pinned at the primitive rather than through our
     * own composition — a fixture regenerated from the code it checks is
     * worthless.
     *
     * Both values come from host-rust-core's `tests/wasm_crypto_vectors.rs`
     * (`product_account_and_entropy_vectors_match_mobile`), mirrored upstream
     * in product-sdk's `product-account.test.ts`. They are what the MOBILE
     * computes, so if this fails the CLI and the phone would derive different
     * accounts for the same person.
     *
     * Note the subtree is keyed by product id: it is `//product//{productId}`
     * with HARD junctions, which is why a public key can no longer cross it
     * and the wallet has to hand us the subtree.
     */
    test("derives the mobile-matched account from the host's cross-host vector", () => {
        const account = deriveProductAccountPublicKey(HOST_VECTOR_SUBTREE, {
            tag: "Index",
            value: 0,
        });
        expect(toHex(account)).toBe(
            "0x1c1ae478b564572f806ffa6352b4273d612beb01610b19f4e5bf444521cd5b5c",
        );
    });

    test("playground product id follows the environment TLD", () => {
        // playground-app derives MyApps ownership from this exact id, and the
        // phone REJECTS an id whose TLD is not its own (android#123) — so the
        // label is fixed but the suffix must track the env. Pinned against
        // getEnvTld() rather than a literal so flipping ACTIVE_TESTNET_ENV
        // cannot silently desync the CLI from the app.
        expect(PLAYGROUND_PRODUCT_ID).toEqual(`playground.${getEnvTld()}`);
        // Guard the shape too: a bare label or a doubled suffix would both
        // still be "a string" but would derive a different account.
        expect(PLAYGROUND_PRODUCT_ID).toMatch(/^playground\.[a-z0-9-]+$/);
    });
});

describe("wrapSignerWithSssFastFail", () => {
    // The statement-store adapter logs NoAllowanceError to console.error but
    // does NOT reject the createTransaction promise — without intervention the
    // phone-signing call hangs for the SDK's 180s queue timeout while the
    // outer transaction watcher gives up with a useless message. The wrapper
    // detects the log line and rejects within ~200ms with a fix-it message.
    const NO_ALLOWANCE_LINE =
        "submitRequest failed: NoAllowanceError: Submit failed, no allowance set for account";

    function makeSigner(overrides: Partial<PolkadotSigner>): PolkadotSigner {
        return {
            publicKey: new Uint8Array(32).fill(1),
            signTx: vi.fn(async () => new Uint8Array([1])),
            signBytes: vi.fn(async () => new Uint8Array([2])),
            ...overrides,
        } as PolkadotSigner;
    }

    test("rejects fast with the logout/login message when NoAllowanceError is logged", async () => {
        const hanging = makeSigner({
            signTx: () => {
                console.error(NO_ALLOWANCE_LINE);
                return new Promise<never>(() => {}); // never settles — the real failure mode
            },
        });
        const wrapped = wrapSignerWithSssFastFail(hanging);

        const started = Date.now();
        await expect(wrapped.signTx(new Uint8Array(), {}, new Uint8Array(), 0)).rejects.toThrow(
            SESSION_EXPIRED_MESSAGE,
        );
        // Well under the SDK's 180s queue timeout / 90s watcher timeout.
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(SESSION_EXPIRED_MESSAGE).toMatch(/playground logout/);
        expect(SESSION_EXPIRED_MESSAGE).toMatch(/playground login/);
    });

    test("signBytes gets the same fast-fail (raw signing rides the same channel)", async () => {
        const hanging = makeSigner({
            signBytes: () => {
                console.error(NO_ALLOWANCE_LINE);
                return new Promise<never>(() => {});
            },
        });
        const wrapped = wrapSignerWithSssFastFail(hanging);
        await expect(wrapped.signBytes(new Uint8Array())).rejects.toThrow(SESSION_EXPIRED_MESSAGE);
    });

    test("happy path passes the result through and restores console.error", async () => {
        const original = console.error;
        const inner = makeSigner({});
        const wrapped = wrapSignerWithSssFastFail(inner);

        const result = await wrapped.signTx(new Uint8Array(), {}, new Uint8Array(), 0);

        expect(result).toEqual(new Uint8Array([1]));
        expect(console.error).toBe(original);
        expect(wrapped.publicKey).toBe(inner.publicKey);
    });

    test("console.error is restored even after a fast-fail rejection", async () => {
        const original = console.error;
        const hanging = makeSigner({
            signTx: () => {
                console.error(NO_ALLOWANCE_LINE);
                return new Promise<never>(() => {});
            },
        });
        const wrapped = wrapSignerWithSssFastFail(hanging);
        await wrapped.signTx(new Uint8Array(), {}, new Uint8Array(), 0).catch(() => {});
        expect(console.error).toBe(original);
    });

    test("unrelated console.error lines are forwarded, not swallowed", async () => {
        const seen: string[] = [];
        const original = console.error;
        console.error = (...args: unknown[]) => {
            seen.push(args.map(String).join(" "));
        };
        try {
            const inner = makeSigner({
                signTx: async () => {
                    console.error("some unrelated diagnostic");
                    return new Uint8Array([1]);
                },
            });
            const wrapped = wrapSignerWithSssFastFail(inner);
            await wrapped.signTx(new Uint8Array(), {}, new Uint8Array(), 0);
            expect(seen).toContain("some unrelated diagnostic");
            // And the nested interception restored OUR replacement, not the
            // process original — interception must be re-entrant because the
            // deploy pipeline (storage.ts) intercepts console too.
            expect(seen.length).toBe(1);
        } finally {
            console.error = original;
        }
    });

    test("underlying rejection is passed through unchanged", async () => {
        const failing = makeSigner({
            signTx: async () => {
                throw new Error("user declined on phone");
            },
        });
        const wrapped = wrapSignerWithSssFastFail(failing);
        await expect(wrapped.signTx(new Uint8Array(), {}, new Uint8Array(), 0)).rejects.toThrow(
            "user declined on phone",
        );
    });
});
