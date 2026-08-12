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
 * paseo-next-v2, paseo-review, preview, polkadot, kusama) so a single value
 * threads through both layers. Only paseo-next-v2 is wired today; others throw
 * from `getChainConfig` until they're populated. (Summit / w3s was retired when
 * polkadot-app-deploy 0.13.x dropped it from `environments.json`.)
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
 * `resolveLegacyEnv`. Flipping it (e.g. to another wired env) is the one-line
 * change an open-source actor makes to point a release at a different network; CI does the
 * rest. The `config.test.ts` guard blocks the flip until the target env's
 * endpoints match upstream AND its CDM meta-registry address exists.
 */
export const ACTIVE_TESTNET_ENV: Env = "paseo-next-v2";
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
     * DotNS top-level domain for names registered on this env (no leading dot,
     * e.g. `"paseo"` on paseo-next-v2 — DotNS TLDs went per-network when the
     * paseo-next-v2 testnet was wiped and DotNS redeployed; previewnet keeps
     * `"dot"`). Mirrors the per-env `tld` field in bulletin-deploy's
     * `environments.json`; the `config.test.ts` divergence guard pins the two
     * copies identical. Read it via `getEnvTld()` — the single helper every
     * domain-side consumer goes through.
     */
    tld: string;
    /**
     * Chain name that `@parity/cdm-env`'s `getRegistryAddress` understands, used
     * to resolve the CDM meta-registry address for this env. Kept separate from
     * `env` because the two catalogs can disagree on a network's name (the
     * retired summit env was cdm-env's `w3s`); `paseo-next-v2` passes through
     * unchanged. The meta-registry ADDRESS itself lives ONLY in `@parity/cdm-env`
     * and is never stored here — see `src/utils/registry.ts` and CLAUDE.md.
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
    tld: "paseo",
    cdmEnvName: "paseo-next-v2",
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
 * Fallback TLD for envs that don't declare one — mirrors bulletin-deploy's
 * `DEFAULT_TLD` ("dot" is what every pre-per-network DotNS deployment mints
 * under, and what upstream falls back to when an env has no `tld`).
 */
export const DEFAULT_TLD_FALLBACK = "dot";

/**
 * Every TLD DotNS has ever minted names under, mirroring bulletin-deploy's
 * `KNOWN_TLDS` (not exported from its package root, so we keep this copy).
 * Used only by `normalizeDomain`'s wrong-TLD guard: input ending in a
 * DIFFERENT known TLD than the env's is a user error worth an actionable
 * message, while an unknown suffix falls through to plain label validation.
 */
export const KNOWN_TLDS: readonly string[] = ["dot", "paseo"];

/**
 * DotNS TLD for the given env (defaults to the active env), with the upstream
 * `"dot"` fallback for envs that don't declare one. THE single source of truth
 * for the domain side of the CLI — everything that renders, parses, or
 * registers a `<label>.<tld>` name goes through here. Note this is
 * intentionally separate from `PLAYGROUND_PRODUCT_ID`, which stays
 * `playground.dot` on every network (see its doc).
 */
export function getEnvTld(env: Env = DEFAULT_ENV): string {
    return CONFIGS[env]?.tld ?? DEFAULT_TLD_FALLBACK;
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
 * `ACTIVE_TESTNET_ENV` re-labels everything from here.
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
// NOTE: this id is TLD-independent by ecosystem convention — product ids stay
// `<label>.dot` on every network; only DotNS registration/serving names use
// the per-env TLD (see `getEnvTld`). Do NOT thread `getEnvTld` through here.
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
