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

/**
 * Pins the `MASTER_FUNDER_SEED` gating of the dedicated funder. The seed is
 * read at module load, so each case sets/clears the env var, resets the module
 * registry, and re-imports `./funder.js` to re-derive the chain.
 *
 * Any valid BIP-39 phrase works; we reuse the well-known substrate dev phrase
 * (also used in other test files) purely because it is a guaranteed-valid
 * mnemonic — it is NOT the real funder seed, which only ever comes from the
 * secret.
 */

import { describe, it, expect, afterEach, vi } from "vitest";

const VALID_MNEMONIC = "bottom drive obey lake curtain smoke basket hold race lonely fit walk";

// Frozen bare-root (empty derivation path) address of VALID_MNEMONIC. Pins the
// derivation path so a regression back to `//0` (or any other junction) fails
// loudly: the funder is funded at the bare root, and a path drift would silently
// move the signer to an unfunded account. `//0` of this mnemonic is a DIFFERENT
// address (5D34dL5…), so this vector genuinely guards the path.
const VALID_MNEMONIC_BARE_ROOT = "5DfhGyQdFobKM8NsWvEeAKk5EQQgYe9AydgJ7rMB6E1EqRzV";

afterEach(() => {
    delete process.env.MASTER_FUNDER_SEED;
    vi.resetModules();
});

describe("FUNDER_CHAIN dedicated-funder gating", () => {
    it("omits the dedicated funder when MASTER_FUNDER_SEED is unset", async () => {
        delete process.env.MASTER_FUNDER_SEED;
        vi.resetModules();
        const { FUNDER_CHAIN, DEDICATED_FUNDER_ADDRESS } = await import("./funder.js");

        expect(FUNDER_CHAIN.map((f) => f.name)).toEqual(["Alice"]);
        expect(DEDICATED_FUNDER_ADDRESS).toBeNull();
    });

    it("prepends the dedicated funder (primary) ahead of Alice when MASTER_FUNDER_SEED is set", async () => {
        process.env.MASTER_FUNDER_SEED = VALID_MNEMONIC;
        vi.resetModules();
        const { FUNDER_CHAIN, DEDICATED_FUNDER_ADDRESS } = await import("./funder.js");

        // Dedicated funder is tried first; Alice is the fallback.
        expect(FUNDER_CHAIN.map((f) => f.name)).toEqual(["dedicated", "Alice"]);
        // Derived at the bare root (empty path) and matches the leading entry.
        // The frozen vector pins the derivation path against `//0` regressions.
        expect(DEDICATED_FUNDER_ADDRESS).toBe(VALID_MNEMONIC_BARE_ROOT);
        expect(FUNDER_CHAIN[0]?.address).toBe(DEDICATED_FUNDER_ADDRESS);
    });

    it("trims surrounding whitespace before deriving", async () => {
        process.env.MASTER_FUNDER_SEED = `  ${VALID_MNEMONIC}  `;
        vi.resetModules();
        const { DEDICATED_FUNDER_ADDRESS } = await import("./funder.js");

        expect(DEDICATED_FUNDER_ADDRESS).not.toBeNull();
    });

    it("treats a blank MASTER_FUNDER_SEED as unset", async () => {
        process.env.MASTER_FUNDER_SEED = "   ";
        vi.resetModules();
        const { FUNDER_CHAIN, DEDICATED_FUNDER_ADDRESS } = await import("./funder.js");

        expect(FUNDER_CHAIN.map((f) => f.name)).toEqual(["Alice"]);
        expect(DEDICATED_FUNDER_ADDRESS).toBeNull();
    });
});

describe("faucetUrlFor", () => {
    it("composes the per-env parachain faucet link with the address param", async () => {
        const { faucetUrlFor } = await import("./funder.js");
        // The `?parachain=1500` form is load-bearing: `?network=pah` drips to
        // the PUBLIC Paseo Asset Hub (para 1000), not Asset Hub Next v2.
        expect(faucetUrlFor("5Dtest")).toBe(
            "https://faucet.polkadot.io/?parachain=1500&address=5Dtest",
        );
    });
});
