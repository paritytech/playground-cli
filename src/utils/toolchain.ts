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
import { sudo } from "./sudo.js";

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
 * just installed a binary expose it to the rest of `dot login` without waiting
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

export async function hasCargoPvmContract(): Promise<boolean> {
    if (!(await commandExists("cargo-pvm-contract"))) return false;
    try {
        await run("cargo pvm-contract build --help");
        return true;
    } catch {
        return false;
    }
}

function isIpfsInitialized(): boolean {
    return existsSync(resolve(homedir(), ".ipfs"));
}

/**
 * True when an error is Kubo's "repo needs migration" abort. The exact notice
 * is "ipfs repo needs migration, please run migration tool."; we match the
 * stable "repo needs migration" fragment case-insensitively so surrounding
 * text (Node's `Command failed: …` prefix, a trailing newline) doesn't matter.
 *
 * This is the single source of truth for the marker, shared by the login-setup
 * probe (`ipfsRepoNeedsMigration`) and the deploy-time remap
 * (`storage.ts::remapIpfsMigrationError`). Scoped to "repo needs migration"
 * rather than a bare "needs migration" so an unrelated upstream error that
 * happens to say "needs migration" isn't misattributed to IPFS.
 */
export function isIpfsMigrationError(err: unknown): boolean {
    return /repo needs migration/i.test(err instanceof Error ? err.message : String(err));
}

/**
 * True when an error is cdm-builder's raw `cargo metadata` failure. cdm-builder
 * (`getCargoMetadata`) shells out to `cargo metadata --format-version 1
 * --manifest-path <…> --no-deps` and rethrows execSync's bare `Command failed:
 * cargo metadata …` on any non-zero exit — a missing/partial Rust toolchain, an
 * unfetched git dependency (the CDM / pvm-contract crates resolve over the
 * network), or a malformed Cargo.toml. We match the stable `cargo metadata`
 * fragment case-insensitively so the surrounding `Command failed: …` prefix and
 * cargo's stderr can vary.
 *
 * Single source of truth for the marker, shared with the deploy-time remap
 * (`contract.ts` / `contractDeployUi.tsx` via `remapCargoMetadataError`).
 */
export function isCargoMetadataError(err: unknown): boolean {
    return /cargo metadata/i.test(err instanceof Error ? err.message : String(err));
}

/**
 * Actionable replacement for cdm-builder's raw `Command failed: cargo metadata …`
 * dump (issue #396). The failure means `cargo metadata` could not read the
 * contract workspace — usually a missing Rust toolchain, an unfetched git
 * dependency (the CDM / pvm-contract crates resolve over the network), or a
 * malformed Cargo.toml. We point at the concrete remedies instead of echoing
 * the bare command.
 */
export const CARGO_METADATA_MESSAGE =
    "Couldn't read the contract workspace: `cargo metadata` failed. Check that Rust is " +
    "installed (run `playground login` to set up the toolchain), that you're online so the " +
    "CDM/pvm-contract git dependencies can be fetched, and that each contract's Cargo.toml is " +
    "valid, then try again.";

/**
 * Pull cargo's own diagnostic out of cdm-builder's execSync failure so the
 * actionable message keeps the specifics (e.g. `Cargo.toml:21:6 key with no
 * value`) that actually let the user fix a malformed manifest. Prefer `.stderr`
 * (cargo's clean output) over `.message`, which prefixes the noisy
 * `Command failed: cargo metadata …` command echo.
 */
function cargoErrorDetail(err: unknown): string {
    if (typeof err !== "object" || err === null) return "";
    const e = err as { stderr?: unknown; message?: unknown };
    if (typeof e.stderr === "string" && e.stderr.trim()) return e.stderr.trim();
    return typeof e.message === "string" ? e.message.trim() : "";
}

/**
 * Replace cdm-builder's cryptic `Command failed: cargo metadata …` with an
 * actionable instruction that still surfaces cargo's own diagnostic (so a
 * malformed Cargo.toml keeps its file/line). Non-cargo-metadata errors pass
 * through unchanged; the raw error stays reachable via `.cause`.
 */
export function remapCargoMetadataError(err: unknown): unknown {
    if (!isCargoMetadataError(err)) return err;
    const detail = cargoErrorDetail(err);
    return new Error(detail ? `${CARGO_METADATA_MESSAGE}\n\n${detail}` : CARGO_METADATA_MESSAGE, {
        cause: err,
    });
}

/**
 * Detect a stale Kubo repo that the installed `ipfs` binary refuses to use
 * until it's migrated to the current on-disk format. Kubo stamps `~/.ipfs`
 * with a repo version; when the binary is newer than the repo (e.g. the user
 * installed ipfs long ago, then `dot login` installed/upgraded Kubo), every
 * repo-touching command — including the `ipfs add` polkadot-app-deploy runs
 * during a deploy — fails with "ipfs repo needs migration, please run
 * migration tool." We probe with a cheap, offline, read-only command and look
 * for that marker in the error.
 *
 * Returns false when there's no repo to migrate (nothing initialized yet) so
 * the IPFS step's fresh-install path is unaffected.
 */
export async function ipfsRepoNeedsMigration(): Promise<boolean> {
    if (!isIpfsInitialized()) return false;
    try {
        await run("ipfs repo stat --offline");
        return false;
    } catch (err) {
        // Node's `exec` appends the child's stderr to the rejection message,
        // which is where Kubo prints the migration notice.
        return isIpfsMigrationError(err);
    }
}

export interface ToolStep {
    name: string;
    check: () => Promise<boolean>;
    install: (onData?: (line: string) => void) => Promise<void>;
    manualHint?: string;
}

// Pinned to a specific cargo-pvm-contract `main` commit for reproducibility.
// main (not the old charles/cdm-integration branch) is where the CDM work now
// lives and is the only branch that emits the `cargo-pvm-contract-build-plan`
// progress protocol that @parity/cdm-builder prefers. Bump deliberately.
const CARGO_PVM_CONTRACT_REV = "533087395f1df1d1de53da55d8c1882c95eecdd2";
const CARGO_PVM_CONTRACT_INSTALL = `
set -euo pipefail
tmp_dir="$(mktemp -d)"
cleanup() {
    rm -rf "$tmp_dir"
}
trap cleanup EXIT
git init -q "$tmp_dir"
git -C "$tmp_dir" remote add origin https://github.com/paritytech/cargo-pvm-contract.git
git -C "$tmp_dir" fetch -q --depth 1 origin ${CARGO_PVM_CONTRACT_REV}
git -C "$tmp_dir" checkout -q FETCH_HEAD
host_target="$(rustc -vV | awk '/^host:/ { print $2 }')"
cargo install --force --locked --target "$host_target" --path "$tmp_dir/crates/cargo-pvm-contract"
`.trim();

// Step order is load-bearing: git MUST come before cargo-pvm-contract, whose
// install script starts with `git clone` (#247 — clean Ubuntu has no git, so
// the clone failed before the git step ran; macOS masked it via Xcode CLT).
// git goes first overall: it's the cheapest step, so a broken apt surfaces
// before the multi-hundred-MB rustup/nightly downloads. Likewise curl MUST
// come before rustup/IPFS (their installers fetch via curl) and the C linker
// MUST come before cargo-pvm-contract (`cargo install` links) — #248. Pinned
// by tests in toolchain.test.ts.
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
        // The rustup and IPFS install commands below fetch via curl (#248).
        // The install.sh one-liner already implies curl exists, but `playground
        // init` can also run standalone on a machine the binary was copied to.
        name: "curl",
        check: () => commandExists("curl"),
        install: async (onData) => {
            if (platform() === "darwin" && (await commandExists("brew"))) {
                await runPiped("brew install curl", onData);
            } else if (platform() === "linux") {
                await runPiped(`${sudo()}apt update && ${sudo()}apt install -y curl`, onData);
            } else {
                throw new Error(
                    "Cannot install curl automatically on this platform — install manually.",
                );
            }
        },
        manualHint: "https://curl.se/download.html",
    },
    {
        // cargo-pvm-contract's `cargo install` compiles Rust, which needs a
        // system C linker (#248). Bare Ubuntu ships none; macOS masks the gap
        // via Xcode CLT, same pattern as #247's missing git.
        name: "C linker (cc)",
        check: () => commandExists("cc"),
        install: async (onData) => {
            if (platform() === "linux") {
                await runPiped(
                    `${sudo()}apt update && ${sudo()}apt install -y build-essential`,
                    onData,
                );
            } else {
                throw new Error(
                    "Cannot install a C toolchain automatically on this platform — install manually.",
                );
            }
        },
        manualHint:
            "Debian/Ubuntu: sudo apt install -y build-essential — macOS: xcode-select --install",
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
            // `dot login` can resolve `rustup`.
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
        check: hasCargoPvmContract,
        install: (onData) =>
            runPiped(CARGO_PVM_CONTRACT_INSTALL, onData, {
                description: `cargo install cargo-pvm-contract @ ${CARGO_PVM_CONTRACT_REV.slice(0, 12)}`,
                failurePrefix: "cargo-pvm-contract build failed",
            }),
        manualHint: `Install cargo-pvm-contract from https://github.com/paritytech/cargo-pvm-contract at commit ${CARGO_PVM_CONTRACT_REV}`,
    },
    {
        name: "IPFS",
        // A stale repo (older on-disk format than the installed Kubo) passes
        // the binary + init checks but blows up later inside the deploy's
        // `ipfs add` with "repo needs migration". Treat it as not-ready so the
        // install step migrates it before any deploy runs.
        check: async () =>
            (await commandExists("ipfs")) &&
            isIpfsInitialized() &&
            !(await ipfsRepoNeedsMigration()),
        install: async (onData) => {
            if (!(await commandExists("ipfs"))) {
                if (platform() === "darwin" && (await commandExists("brew"))) {
                    await runPiped("brew install ipfs", onData);
                } else {
                    const os = platform() === "darwin" ? "darwin" : "linux";
                    const cpu = arch() === "arm64" ? "arm64" : "amd64";
                    // Run without sudo first (falls through to ~/.local/bin);
                    // sudo -n avoids hanging on a password prompt (stdin is /dev/null).
                    await runPiped(
                        `curl -fsSL https://dist.ipfs.tech/kubo/v0.33.2/kubo_v0.33.2_${os}-${cpu}.tar.gz | tar xz && mkdir -p "$HOME/.local/bin" && (cd kubo && bash install.sh || sudo -n bash install.sh) && rm -rf kubo`,
                        onData,
                    );
                }
            }
            if (!isIpfsInitialized()) {
                await runPiped("ipfs init", onData);
            } else if (await ipfsRepoNeedsMigration()) {
                // One-time, offline, idempotent: Kubo bundles its fs-repo
                // migrations since v0.15, so this needs no network and no-ops
                // when the repo is already current.
                await runPiped("ipfs repo migrate", onData);
            }
        },
        manualHint:
            "https://docs.ipfs.tech/install/ then run: ipfs init (or `ipfs repo migrate` if it reports a stale repo)",
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
