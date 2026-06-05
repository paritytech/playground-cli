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

import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { arch, homedir, platform } from "node:os";
import { runShell as runPiped } from "./process.js";

/** Returns "sudo " when not already running as root, empty string otherwise. */
const sudo = () => (typeof process.getuid === "function" && process.getuid() === 0 ? "" : "sudo ");

/** Async exec — resolves with stdout, rejects on non-zero exit. */
function run(cmd: string, opts?: { shell?: string }): Promise<string> {
    return new Promise((resolve, reject) => {
        exec(cmd, { shell: opts?.shell ?? "bash" }, (err, stdout) => {
            if (err) reject(err);
            else resolve(stdout);
        });
    });
}

/**
 * Prepend `dir` to `process.env.PATH` if not already present. Lets a step that
 * just installed a binary expose it to the rest of `dot init` without waiting
 * for a shell restart.
 */
export function prependPath(dir: string): void {
    const segments = (process.env.PATH ?? "").split(":").filter(Boolean);
    if (segments.includes(dir)) return;
    process.env.PATH = process.env.PATH ? `${dir}:${process.env.PATH}` : dir;
}

export async function commandExists(cmd: string): Promise<boolean> {
    if (!/^[a-zA-Z0-9_-]+$/.test(cmd)) {
        throw new Error(`Invalid command name: ${cmd}`);
    }
    try {
        await run(`command -v ${cmd}`);
        return true;
    } catch {
        return false;
    }
}

async function hasRustNightly(): Promise<boolean> {
    try {
        const out = await run("rustup toolchain list");
        return out.includes("nightly");
    } catch {
        return false;
    }
}

async function hasRustSrc(): Promise<boolean> {
    try {
        const out = await run("rustup component list --toolchain nightly");
        return out.includes("rust-src (installed)");
    } catch {
        return false;
    }
}

async function hasCargoPvmContract(): Promise<boolean> {
    return commandExists("cargo-pvm-contract");
}

function isIpfsInitialized(): boolean {
    return existsSync(resolve(homedir(), ".ipfs"));
}

export interface ToolStep {
    name: string;
    check: () => Promise<boolean>;
    install: (onData?: (line: string) => void) => Promise<void>;
    manualHint?: string;
}

const CARGO_PVM_CONTRACT_INSTALL = `
set -euo pipefail
tmp_dir="$(mktemp -d)"
cleanup() {
    rm -rf "$tmp_dir"
}
trap cleanup EXIT
git clone --depth 1 --branch charles/cdm-integration https://github.com/paritytech/cargo-pvm-contract.git "$tmp_dir"
host_target="$(rustc -vV | awk '/^host:/ { print $2 }')"
cargo install --force --locked --target "$host_target" --path "$tmp_dir/crates/cargo-pvm-contract"
`.trim();

// Step order is load-bearing: git MUST come before cargo-pvm-contract, whose
// install script starts with `git clone` (#247 — clean Ubuntu has no git, so
// the clone failed before the git step ran; macOS masked it via Xcode CLT).
// git goes first overall: it's the cheapest step, so a broken apt surfaces
// before the multi-hundred-MB rustup/nightly downloads. Pinned by a test in
// toolchain.test.ts.
export const TOOL_STEPS: ToolStep[] = [
    {
        name: "git",
        check: () => commandExists("git"),
        install: async (onData) => {
            if (platform() === "darwin" && (await commandExists("brew"))) {
                await runPiped("brew install git", onData);
            } else if (platform() === "linux") {
                await runPiped(`${sudo()}apt update && ${sudo()}apt install -y git`, onData);
            } else {
                throw new Error(
                    "Cannot install git automatically on this platform — install manually.",
                );
            }
        },
        manualHint: "https://git-scm.com/downloads",
    },
    {
        name: "rustup",
        check: () => commandExists("rustup"),
        install: async (onData) => {
            await runPiped(
                'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y',
                onData,
            );
            // rustup-init writes binaries to $CARGO_HOME/bin (default ~/.cargo/bin)
            // and updates shell rc files, but those edits don't reach the running
            // dot process. Prepend the bin dir so the very next step in this same
            // `dot init` can resolve `rustup`.
            prependPath(resolve(process.env.CARGO_HOME ?? `${homedir()}/.cargo`, "bin"));
        },
        manualHint: "https://rustup.rs",
    },
    {
        name: "Rust nightly",
        check: () => hasRustNightly(),
        install: (onData) => runPiped("rustup toolchain install nightly", onData),
    },
    {
        name: "rust-src",
        check: () => hasRustSrc(),
        install: (onData) => runPiped("rustup component add rust-src --toolchain nightly", onData),
    },
    {
        name: "cargo-pvm-contract",
        check: () => hasCargoPvmContract(),
        install: (onData) => runPiped(CARGO_PVM_CONTRACT_INSTALL, onData),
        manualHint:
            "Install cargo-pvm-contract from https://github.com/paritytech/cargo-pvm-contract/tree/charles/cdm-integration",
    },
    {
        name: "IPFS",
        check: async () => (await commandExists("ipfs")) && isIpfsInitialized(),
        install: async (onData) => {
            if (!(await commandExists("ipfs"))) {
                if (platform() === "darwin" && (await commandExists("brew"))) {
                    await runPiped("brew install ipfs", onData);
                } else {
                    const os = platform() === "darwin" ? "darwin" : "linux";
                    const cpu = arch() === "arm64" ? "arm64" : "amd64";
                    await runPiped(
                        `curl -fsSL https://dist.ipfs.tech/kubo/v0.33.2/kubo_v0.33.2_${os}-${cpu}.tar.gz | tar xz && cd kubo && ${sudo()}bash install.sh && cd .. && rm -rf kubo`,
                        onData,
                    );
                }
            }
            if (!isIpfsInitialized()) {
                await runPiped("ipfs init", onData);
            }
        },
        manualHint: "https://docs.ipfs.tech/install/ then run: ipfs init",
    },
    {
        // Required by `dot decentralize` (mirrors a live site via `wget --mirror`).
        // macOS doesn't ship wget by default; Linux distros vary.
        name: "wget",
        check: () => commandExists("wget"),
        install: async (onData) => {
            if (platform() === "darwin" && (await commandExists("brew"))) {
                await runPiped("brew install wget", onData);
            } else if (platform() === "linux") {
                await runPiped(`${sudo()}apt update && ${sudo()}apt install -y wget`, onData);
            } else {
                throw new Error(
                    "Cannot install wget automatically on this platform — install manually.",
                );
            }
        },
        manualHint: "brew install wget (macOS) or your distro's package manager",
    },
];
