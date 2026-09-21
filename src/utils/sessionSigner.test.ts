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
import type { PolkadotSigner } from "polkadot-api";
import { PLAYGROUND_PRODUCT_ID, getEnvTld } from "../config.js";
import {
    INCOMPLETE_SESSION_MESSAGE,
    SESSION_EXPIRED_MESSAGE,
    createPlaygroundSessionSigner,
    derivePlaygroundProductPublicKey,
    wrapSignerWithSssFastFail,
} from "./sessionSigner.js";

const DEV_PHRASE = "bottom drive obey lake curtain smoke basket hold race lonely fit walk";

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
    test("login signer address === deploy signer address === playground-app address", () => {
        const session = fakeSession({ rootAccountId: root.publicKey });

        const cliSigner = createPlaygroundSessionSigner(session, {
            productId: PLAYGROUND_PRODUCT_ID,
            derivationIndex: 0,
        });
        const cliAddress = ss58Encode(cliSigner.publicKey);

        // What the deployed playground-app gets back from the mobile (mobile
        // computes this exact derivation from the same mnemonic).
        const mobileDerived = seedToAccount(DEV_PHRASE, `/product/${PLAYGROUND_PRODUCT_ID}/0`);
        const playgroundAppAddress = ss58Encode(mobileDerived.publicKey);

        expect(cliAddress).toEqual(playgroundAppAddress);
    });

    test("signer.publicKey is the derived product account, not the wallet account", () => {
        const session = fakeSession({
            rootAccountId: root.publicKey,
            remoteAccountId: new Uint8Array(32).fill(7),
        });
        const signer = createPlaygroundSessionSigner(session, {
            productId: PLAYGROUND_PRODUCT_ID,
            derivationIndex: 0,
        });
        const expected = derivePlaygroundProductPublicKey(root.publicKey, {
            productId: PLAYGROUND_PRODUCT_ID,
            derivationIndex: 0,
        });

        // The pre-fix bug set signer.publicKey from session.remoteAccount.accountId
        // (the user's wallet account), not the product-derived account. The chain
        // would see the wallet as From — different from the funded / allowance-
        // granted product account. This guard ensures we never slip back.
        expect(signer.publicKey).toEqual(expected);
        expect(ss58Encode(signer.publicKey)).not.toEqual(ss58Encode(new Uint8Array(32).fill(7)));
    });

    test("throws the friendly message when rootAccountId is missing", () => {
        const session = fakeSession({ rootAccountId: undefined });
        expect(() =>
            createPlaygroundSessionSigner(session, {
                productId: PLAYGROUND_PRODUCT_ID,
                derivationIndex: 0,
            }),
        ).toThrow(INCOMPLETE_SESSION_MESSAGE);
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
