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

import { describe, expect, it, vi } from "vitest";

// Make detectBuildOrder (which shells out to `cargo metadata`) throw, so we can
// assert the call site applies the remap (#396), not just that the helper does.
vi.mock("@parity/cdm-builder", () => ({
    detectBuildOrder: () => {
        throw new Error(
            'Command failed: cargo metadata --format-version 1 --manifest-path "/p/Cargo.toml" --no-deps\n' +
                "error: could not parse manifest\n",
        );
    },
    deployContracts: vi.fn(),
}));

import { CARGO_METADATA_MESSAGE } from "../utils/toolchain.js";
import { precomputeContractDeployDisplay } from "./contractDeployUi.js";

describe("precomputeContractDeployDisplay cargo metadata remap (#396)", () => {
    it("remaps a detectBuildOrder cargo metadata failure to the actionable message", () => {
        expect(() => precomputeContractDeployDisplay("/p", undefined)).toThrow(
            CARGO_METADATA_MESSAGE,
        );
    });
});
