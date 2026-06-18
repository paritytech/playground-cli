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
 * Single source of truth for environment-dependent values: RPC endpoints,
 * contract addresses, dapp identifiers, and feature defaults.
 *
 * Env IDs mirror polkadot-app-deploy's `assets/environments.json` (paseo-next,
 * paseo-next-v2, paseo-review, summit, preview, polkadot, kusama) so a single
 * value threads through both layers. paseo-next-v2 and summit are wired today;
 * others throw from `getChainConfig` until they're populated.
 */

/**
 * All known env IDs (mirror polkadot-app-deploy's `environments.json`). This
 * array is the single source: `Env` derives from it AND `ENV_FLAG_CHOICES`
 * (the `--env` flag's accepted values) is built from it, so adding an env here
 * automatically teaches every `--env` flag about it — no second list to keep in
 * sync.
 */
export const ENV_IDS = [
    "preview",
    "paseo-next",
    "paseo-review",
    "paseo-next-v2",
    "summit",
    "polkadot",
    "kusama",
] as const;

export type Env = (typeof ENV_IDS)[number];

/** Legacy `--env testnet|mainnet` aliases accepted alongside the real IDs (mapped via `resolveLegacyEnv`). */
export const LEGACY_ENV_ALIASES = ["testnet", "mainnet"] as const;

/** Accepted `--env` flag values across commands: every env ID plus the legacy aliases. */
export const ENV_FLAG_CHOICES: readonly string[] = [...ENV_IDS, ...LEGACY_ENV_ALIASES];

/**
 * THE network switch. This single constant selects the active testnet for the
 * whole CLI — it feeds both `DEFAULT_ENV` and the legacy `testnet` alias in
 * `resolveLegacyEnv`. Flipping it (e.g. to `"summit"`) is the one-line change an
 * open-source actor makes to point a release at a different network; CI does the
 * rest. The `config.test.ts` guard blocks the flip until the target env's
 * endpoints match upstream AND its CDM meta-registry address exists.
 */
export const ACTIVE_TESTNET_ENV: Env = "summit";
export const DEFAULT_ENV: Env = ACTIVE_TESTNET_ENV;

export interface ChainConfig {
    /** Env identifier — passes straight through to polkadot-app-deploy's `deploy({ env })`. */
    env: Env;
    /** Underlying network (testnet/mainnet) for cosmetics + gates. */
    network: "testnet" | "mainnet";
    /**
     * Native token symbol for display only (balances, drip amounts) — never used
     * for on-chain math. Read it via `getTokenSymbol()` / threaded through
     * `formatPas` so flipping `ACTIVE_TESTNET_ENV` re-labels the whole CLI in one
     * place. All wired envs use 10-decimal planck regardless of symbol (PAS and
     * SUM are both 10 decimals — verified live against the chain, see
     * `PAS_DECIMALS` in `account/drip.ts`).
     */
    tokenSymbol: string;
    /** Relay chain RPC (mostly informational; product-sdk talks to system chains directly). */
    relayRpc: string;
    /** Asset Hub RPC — Revive contracts (registry, DotNS) live here. */
    assetHubRpc: string;
    /** Primary Bulletin RPC for storage. */
    bulletinRpc: string;
    /**
     * Ordered fallback Bulletin endpoints. Always excludes `bulletinRpc`.
     * Used by callers that build their own WS provider (e.g. the dedicated
     * metadata-upload client in `src/utils/deploy/playground.ts`).
     * Typically empty; populated when `DOT_BULLETIN_RPC` overrides primary.
     */
    bulletinRpcFallbacks: string[];
    /** People chain endpoints (SSO / session discovery). */
    peopleEndpoints: string[];
    /** HTTP IPFS gateway for Bulletin content reads. */
    bulletinGateway: string;
    /** True when Revive auto-maps SS58 → H160 on first tx (paseo-next-v2 onward). */
    autoAccountMapping: boolean;
    /**
     * Base public faucet URL for this env (callers append `&address=…`), or null
     * when the env has no public faucet. Single source for the faucet link —
     * `src/utils/account/funder.ts::faucetUrlFor` reads it from here.
     */
    faucetUrl: string | null;
    /**
     * Chain name that `@parity/cdm-env`'s `getRegistryAddress` understands, used
     * to resolve the CDM meta-registry address for this env. Differs from `env`
     * where the two catalogs disagree (our `summit` is cdm-env's `w3s`). The
     * meta-registry ADDRESS itself lives ONLY in `@parity/cdm-env` and is never
     * stored here — see `src/utils/registry.ts` and CLAUDE.md.
     */
    cdmEnvName: string;
    /**
     * Asset id of PGAS (the smart-contract gas token, a `sufficient` asset) on
     * this env's Asset Hub. Display-only — read via `getPgasAssetId()` to show a
     * balance in `playground status`. Like `tokenSymbol`, it is NOT present in
     * polkadot-app-deploy's `environments.json`, so the `config.test.ts`
     * divergence guard does not cross-check it; set it from the chain's own asset
     * registry.
     */
    pgasAssetId: number;
}

// Paseo Next v2 — the active env. DotNS contracts are owned by
// polkadot-app-deploy's environment catalog and keyed by `env`.
const PASEO_NEXT_V2: ChainConfig = {
    env: "paseo-next-v2",
    network: "testnet",
    tokenSymbol: "PAS",
    relayRpc: "wss://paseo-rpc.n.dwellir.com",
    assetHubRpc: "wss://paseo-asset-hub-next-rpc.polkadot.io",
    bulletinRpc: "wss://paseo-bulletin-next-rpc.polkadot.io",
    bulletinRpcFallbacks: [],
    peopleEndpoints: ["wss://paseo-people-next-system-rpc.polkadot.io"],
    bulletinGateway: "https://paseo-bulletin-next-ipfs.polkadot.io/ipfs/",
    autoAccountMapping: true,
    faucetUrl: "https://faucet.polkadot.io/?network=pah",
    cdmEnvName: "paseo-next-v2",
    pgasAssetId: 2_000_000_000,
};

// Web3 Summit network. Every endpoint/network value mirrors polkadot-app-deploy's
// `assets/environments.json` `summit` entry verbatim (the `config.test.ts` guard
// fails CI if they drift). The CDM meta-registry address is NOT stored here — it
// resolves at runtime from `@parity/cdm-env` via `cdmEnvName: "w3s"`, and is empty
// until that package ships it (see CLAUDE.md → "Adding a network / summit").
const SUMMIT: ChainConfig = {
    env: "summit",
    network: "testnet",
    tokenSymbol: "SUM",
    relayRpc: "wss://summit-rpc.polkadot.io",
    assetHubRpc: "wss://summit-asset-hub-rpc.polkadot.io",
    bulletinRpc: "wss://summit-bulletin-rpc.polkadot.io",
    bulletinRpcFallbacks: [],
    peopleEndpoints: ["wss://summit-people-rpc.polkadot.io"],
    bulletinGateway: "https://summit-ipfs.polkadot.io/ipfs/",
    autoAccountMapping: true,
    faucetUrl: null,
    cdmEnvName: "w3s",
    pgasAssetId: 2_000_000_000,
};

/**
 * Wired environments. Exported (read-only) so the `config.test.ts` divergence
 * guard can compare every entry against polkadot-app-deploy's `environments.json`
 * without going through `getChainConfig` (which applies the `DOT_BULLETIN_RPC`
 * test override). Prefer `getChainConfig()` everywhere else.
 */
export const CONFIGS: Partial<Record<Env, ChainConfig>> = {
    "paseo-next-v2": PASEO_NEXT_V2,
    summit: SUMMIT,
    // Other envs are not wired yet — getChainConfig() throws below.
};

export function getChainConfig(env: Env = DEFAULT_ENV): ChainConfig {
    const cfg = CONFIGS[env];
    if (!cfg) {
        throw new Error(
            `--env ${env} is not yet supported. Use --env ${DEFAULT_ENV} (default). ` +
                `Supported envs in this build: ${Object.keys(CONFIGS).join(", ")}`,
        );
    }
    // CHAOS-test hook: when DOT_BULLETIN_RPC is set, use it as the primary
    // Bulletin endpoint and retain the built-in URL as a fallback so failover
    // works. polkadot-app-deploy's deploy() already applies this pattern internally
    // (it builds [userRpc, DEFAULT] from options.rpc), so storage.ts consumers
    // get failover for free. The dedicated WS client in playground.ts reads
    // bulletinRpcFallbacks explicitly and builds its own endpoint array.
    // Used by `e2e/cli/chaos.test.ts` to simulate an unreachable primary RPC.
    const override = process.env.DOT_BULLETIN_RPC;
    if (override) {
        return {
            ...cfg,
            bulletinRpc: override,
            bulletinRpcFallbacks: [cfg.bulletinRpc, ...cfg.bulletinRpcFallbacks],
        };
    }
    return cfg;
}

/**
 * Map legacy `--env testnet|mainnet` flag values onto the new env IDs.
 * Keeps existing scripts/CI working while we transition.
 */
export function resolveLegacyEnv(input: string): Env {
    if (input === "testnet") return ACTIVE_TESTNET_ENV;
    if (input === "mainnet") return "polkadot";
    return input as Env;
}

/**
 * Human-readable network label for the Header bread-crumb. Lower-cased to
 * match the existing visual style ("paseo", "polkadot").
 */
export function getNetworkLabel(env: Env = DEFAULT_ENV): string {
    switch (env) {
        case "paseo-next-v2":
            return "paseo next v2";
        case "paseo-next":
            return "paseo next";
        case "paseo-review":
            return "paseo review";
        case "summit":
            return "summit";
        case "preview":
            return "preview";
        case "polkadot":
            return "polkadot";
        case "kusama":
            return "kusama";
    }
}

/**
 * Native token symbol for the given env (defaults to the active env). Display
 * only — drives balance/drip labels via `formatPas`. Flipping
 * `ACTIVE_TESTNET_ENV` (e.g. to `"summit"`) re-labels everything from here.
 */
export function getTokenSymbol(env: Env = DEFAULT_ENV): string {
    return getChainConfig(env).tokenSymbol;
}

/**
 * Asset id of PGAS on the given env's Asset Hub (defaults to the active env).
 * Display only — used by `playground status` to read the product account's PGAS
 * balance. See `ChainConfig.pgasAssetId`.
 */
export function getPgasAssetId(env: Env = DEFAULT_ENV): number {
    return getChainConfig(env).pgasAssetId;
}

/** Identifier the terminal adapter reports during SSO. Kept stable so mobile pairings persist across releases. */
export const DAPP_ID = "dot-cli";

/**
 * Product account identifier used for mobile signing. Must match the
 * `dotNsIdentifier` the deployed playground-app passes to
 * `HostProvider.getProductAccount(...)` (see
 * `playground-app/src/config.ts::defaultDotNsId`) so that the CLI and the
 * playground-app resolve to the EXACT SAME product-derived account on the
 * user's wallet. The mobile derives the product keypair via
 * `mnemonic + "/product/{PLAYGROUND_PRODUCT_ID}/0"`; changing this value
 * changes the on-chain account.
 */
export const PLAYGROUND_PRODUCT_ID = "playground.dot";

/**
 * Host metadata carried inline in the V2 pairing proposal (host-papp 0.8+).
 * The mobile app renders these fields on the Sign-In pair sheet — no network
 * fetch involved, unlike the V1 QR's metadata URL (which pointed at a gist
 * and was removed together with the `@novasamatech` 0.7.9 mobile-compat pin).
 * `hostVersion` is filled in by the caller from `package.json`.
 */
export const TERMINAL_HOST_METADATA = {
    hostName: "Polkadot Playground",
    hostIcon: "https://cryptologos.cc/logos/polkadot-new-dot-logo.png",
} as const;

/** Default build output directory — matches Vite and the interactive prompt default. */
export const DEFAULT_BUILD_DIR = "dist";
