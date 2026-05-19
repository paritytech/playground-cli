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

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import pkg from "../package.json" with { type: "json" };

export const PLAYGROUND_SENTRY_DSN =
    "https://002663c738bfb4ae0560eb92f9f28bae@o4511059872841728.ingest.de.sentry.io/4511298552135760";
export const HOST_APP = "playground-cli";
export const VERSION: string = pkg.version;

const INTERNAL_ORG_RE = /^(paritytech|w3f|polkadot-fellows)\//i;
const CONVENTIONAL_BRANCH_PREFIXES = new Set([
    "fix",
    "feat",
    "chore",
    "docs",
    "test",
    "refactor",
    "release",
    "bump",
    "perf",
    "style",
    "ci",
    "build",
    "revert",
]);

export interface InternalContextSignals {
    githubRepository?: string;
    runnerName?: string;
    gitRemote?: string;
    branch?: string;
}

export type CliCommandName =
    | "init"
    | "deploy"
    | "mod"
    | "build"
    | "update"
    | "logout"
    | "decentralize";
export type TelemetryAttribute = string | number | boolean | undefined;

type EnvLike = Record<string, string | undefined>;

export function extractRepoSlug(url: string): string {
    return url
        .trim()
        .replace(/^git@github\.com:/, "")
        .replace(/^https?:\/\/github\.com\//, "")
        .replace(/\.git$/, "");
}

export function tryGitRemote(cwd = process.cwd()): string | undefined {
    try {
        const out = execFileSync("git", ["remote", "get-url", "origin"], {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 500,
        }).trim();
        return out ? extractRepoSlug(out) : undefined;
    } catch {
        return undefined;
    }
}

export function tryGitBranch(cwd = process.cwd()): string | undefined {
    try {
        const out = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 500,
        }).trim();
        return out || undefined;
    } catch {
        return undefined;
    }
}

export function isInternalContextFromSignals(signals: InternalContextSignals): boolean {
    if (INTERNAL_ORG_RE.test(signals.githubRepository ?? "")) return true;
    if (signals.runnerName?.startsWith("parity-")) return true;
    if (signals.gitRemote && INTERNAL_ORG_RE.test(signals.gitRemote)) return true;
    return false;
}

export function resolveTelemetryEnabled(
    env: EnvLike = process.env,
    signals?: InternalContextSignals,
): boolean {
    if (env.DOT_TELEMETRY === "0") return false;
    if (env.DOT_TELEMETRY === "1") return true;

    return isInternalContextFromSignals({
        githubRepository: env.GITHUB_REPOSITORY,
        runnerName: env.RUNNER_NAME,
        gitRemote: signals?.gitRemote ?? tryGitRemote(),
        branch: signals?.branch,
    });
}

export function configureBulletinTelemetryEnv(
    env: EnvLike = process.env,
    signals?: InternalContextSignals,
): void {
    if (env.BULLETIN_DEPLOY_USE_AMBIENT_SENTRY === undefined) {
        env.BULLETIN_DEPLOY_USE_AMBIENT_SENTRY = "1";
    }
    if (env.BULLETIN_DEPLOY_HOST_APP === undefined) {
        env.BULLETIN_DEPLOY_HOST_APP = HOST_APP;
    }
    if (env.BULLETIN_DEPLOY_TELEMETRY === undefined) {
        env.BULLETIN_DEPLOY_TELEMETRY = resolveTelemetryEnabled(env, signals) ? "1" : "0";
    }
}

export function scrubPaths(msg: string): string {
    if (!msg) return msg;
    return msg
        .replace(/\/Users\/[^/\s"'`]+/g, "/Users/<redacted>")
        .replace(/\/home\/[^/\s"'`]+/g, "/home/<redacted>");
}

export function truncateAddress(addr: string | undefined): string | undefined {
    if (!addr) return addr;
    return addr.length > 8 ? `${addr.slice(0, 8)}...` : addr;
}

export function sanitizeBranch(name: string | undefined): string | undefined {
    if (!name) return name;
    const slash = name.indexOf("/");
    if (slash === -1) return name;
    const prefix = name.slice(0, slash).toLowerCase();
    return CONVENTIONAL_BRANCH_PREFIXES.has(prefix) ? name : name.slice(slash + 1);
}

function shortHash(value: string): string {
    return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export function sanitizeRepo(slug: string | undefined): string | undefined {
    if (!slug) return slug;
    if (INTERNAL_ORG_RE.test(slug)) return slug;
    const slash = slug.indexOf("/");
    if (slash === -1) return `ext/${shortHash(slug)}`;
    const org = slug.slice(0, slash);
    const repo = slug.slice(slash + 1);
    return `${org}/${shortHash(repo)}`;
}

export function truncateString(value: string, max = 200): string {
    return value.length > max ? value.slice(0, max) : value;
}

export function sanitizeAttributes<T extends Record<string, TelemetryAttribute>>(attrs: T): T {
    const copy = { ...attrs };
    for (const key of Object.keys(copy)) {
        const value = copy[key];
        if (typeof value === "string") {
            copy[key as keyof T] = truncateString(scrubPaths(value)) as T[keyof T];
        }
    }
    return copy;
}

export function resolveRunner(env: EnvLike = process.env): string {
    if (!env.CI) return "local";
    if (env.RUNNER_NAME?.startsWith("parity-")) return env.RUNNER_NAME;
    return env.RUNNER_NAME || "unknown";
}

export function resolveRunnerType(env: EnvLike = process.env): string {
    if (!env.CI) return "local";
    if (env.RUNNER_NAME?.startsWith("parity-")) return "self-hosted";
    return "github-hosted";
}

export function getCliRootAttributes(
    command: CliCommandName,
    env: EnvLike = process.env,
    signals?: InternalContextSignals,
): Record<string, TelemetryAttribute> {
    const repo = env.GITHUB_REPOSITORY ?? signals?.gitRemote ?? tryGitRemote();
    const branch = env.GITHUB_HEAD_REF ?? env.GITHUB_REF_NAME ?? signals?.branch ?? tryGitBranch();

    return sanitizeAttributes({
        "cli.command": command,
        "cli.source": env.CI ? "ci" : "local",
        "cli.repo": sanitizeRepo(repo) ?? "unknown",
        "cli.branch": sanitizeBranch(branch) ?? "unknown",
        "cli.tool_version": VERSION,
        "cli.runner": resolveRunner(env),
        "cli.runner_type": resolveRunnerType(env),
        "cli.sad": "false",
        "cli.expected": "false",
        "cli.tag": env.DOT_TAG,
    });
}
