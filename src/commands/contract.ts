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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { generateContractTypes, generateContractsAugmentation } from "@parity/cdm-codegen";
import {
    CONTRACTS_REGISTRY_ABI,
    detectBuildOrder,
    deployContracts,
    generateSolidityImport,
    hasBuildableSolidityProject,
    installContracts,
    readCdmJson,
    resolveFeatures,
    type CdmJson,
    type DeployEvent as ContractDeployEvent,
    type DeploySummary,
    type InstallLibraryRequest,
    type InstallEvent as ContractInstallEvent,
    type InstallResult,
    type InstallSummary,
    type PipelineChainClient,
    type SolidityAbiEntry,
    writeCdmJson,
} from "@parity/cdm-builder";
import {
    connectIpfsGateway,
    createCdmAssetHubClient,
    getChainPreset,
    getRegistryAddress,
    resolveQueryOrigin,
} from "@parity/cdm-env";
import { createContractFromClient } from "@parity/product-sdk-contracts";
import { DEFAULT_MNEMONIC as PAD_DEFAULT_MNEMONIC } from "@parity/polkadot-app-deploy";
import { Command, Option } from "commander";
import { createClient, type HexString, type SS58String } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";
import { runCliCommand } from "../cli-runtime.js";
import { getChainConfig } from "../config.js";
import { getCachedBulletinAllowanceSigner } from "../utils/allowances/bulletin.js";
import { BULLETIN_WS_HEARTBEAT_MS } from "../utils/bulletinWs.js";
import { suppressReviveTraceNoise } from "../utils/contractManifest.js";
import type { SignerMode } from "../utils/deploy/signerMode.js";
import {
    createSigningCounter,
    wrapSignerWithEvents,
    type SigningEvent,
} from "../utils/deploy/signingProxy.js";
import { getAssetHubDescriptor, getBulletinDescriptor } from "../utils/descriptors.js";
import { onProcessShutdown } from "../utils/process-guard.js";
import { resolveSigner, type ResolvedSigner, type SignerOptions } from "../utils/signer.js";
import { runContractDeployWithUI } from "./contractDeployUi.js";
import { runContractInstallWithUI } from "./contractInstallUi.js";

const CDM_INCLUDE = ".cdm/**/*";
const ZERO_H160 = "0x0000000000000000000000000000000000000000";

export interface ContractDeployOpts {
    /** Project root. Internal callers set this; the standalone command defaults to cwd. */
    rootDir?: string;
    assethubUrl?: string;
    bulletinUrl?: string;
    registryAddress?: string;
    signer?: SignerMode;
    suri?: string;
    features?: string;
}

export interface ContractInstallOpts {
    /** Project root. Internal callers set this; the standalone command defaults to cwd. */
    rootDir?: string;
    assethubUrl?: string;
    name?: string;
    ipfsGatewayUrl?: string;
    registryAddress?: string;
}

export interface ContractDeployRunOptions {
    /** Render the standalone contract deploy Ink UI. Defaults to true for the direct command. */
    useUi?: boolean;
    /**
     * Reuse a signer already resolved by another command. The caller retains
     * ownership and must destroy it; this runner only destroys signers it opens.
     */
    resolvedSigner?: ResolvedSigner;
    onDeployEvent?: (event: ContractDeployEvent) => void;
    onSigningEvent?: (event: SigningEvent) => void;
}

export interface ContractDeployRunResult {
    summary: DeploySummary;
    success: boolean;
}

export interface ContractInstallRunOptions {
    /** Render the standalone contract install Ink UI. Defaults to true for the direct command. */
    useUi?: boolean;
    onInstallEvent?: (event: ContractInstallEvent) => void;
}

export interface ContractInstallRunResult {
    summary: InstallSummary;
    success: boolean;
}

interface ContractDeployTarget {
    assethubUrl: string;
    bulletinUrl: string;
    bulletinUrls: string[];
    registryAddress: HexString;
}

interface ContractInstallTarget {
    assethubUrl: string;
    ipfsGatewayUrl: string;
    registryAddress: HexString;
    chainName?: string;
}

type ContractChainClient = PipelineChainClient & { destroy(): void };

export interface CdmPackageOwnershipConflict {
    packageName: string;
    owner: HexString;
    caller: HexString;
}

function assertHexAddress(value: string | undefined, label: string): HexString {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
        throw new Error(`${label} must be a 20-byte hex address`);
    }
    return value as HexString;
}

export function resolveContractSignerOptions(opts: ContractDeployOpts): SignerOptions {
    if (opts.signer === "dev") {
        return {
            suri:
                opts.suri ??
                process.env.DOTNS_MNEMONIC ??
                process.env.MNEMONIC ??
                PAD_DEFAULT_MNEMONIC,
        };
    }
    if (opts.signer === "phone") {
        if (opts.suri) {
            throw new Error(
                "--suri cannot be used with --signer phone. Use --signer dev --suri <suri> for local signing.",
            );
        }
        return {};
    }
    return { suri: opts.suri };
}

export function resolveContractDeployTarget(opts: ContractDeployOpts): ContractDeployTarget {
    const cfg = getChainConfig();
    const bulletinUrl = opts.bulletinUrl ?? cfg.bulletinRpc;
    return {
        assethubUrl: opts.assethubUrl ?? cfg.assetHubRpc,
        bulletinUrl,
        bulletinUrls: opts.bulletinUrl
            ? [opts.bulletinUrl]
            : [bulletinUrl, ...cfg.bulletinRpcFallbacks],
        registryAddress: assertHexAddress(
            opts.registryAddress ?? getRegistryAddress(cfg.cdmEnvName),
            "Registry address",
        ),
    };
}

export function parseContractInstallLibraryArg(arg: string): InstallLibraryRequest {
    const colonIdx = arg.lastIndexOf(":");
    if (colonIdx > 0) {
        const library = arg.slice(0, colonIdx);
        const version = Number.parseInt(arg.slice(colonIdx + 1), 10);
        if (!Number.isNaN(version)) return { library, requestedVersion: version };
    }
    return { library: arg, requestedVersion: "latest" };
}

/**
 * Guard against a pre-migration `cdm.json`. The flat manifest dropped the
 * `targets`/`targetHash` layer, and `readCdmJson`'s `normalizeCdmJson` is an
 * identity pass, so an old multi-target file would otherwise flow through and
 * fail opaquely (target-hash keys read as library names, orphaned nested
 * `contracts` entries with undefined fields). Fail fast with a clear message.
 */
export function assertSupportedCdmJson(cdmJson: CdmJson, cdmJsonPath?: string): void {
    if (cdmJson && typeof cdmJson === "object" && "targets" in cdmJson) {
        const where = cdmJsonPath ? ` (${cdmJsonPath})` : "";
        throw new Error(
            `cdm.json${where} uses the old multi-target format, which is no longer supported. ` +
                `Remove the "targets" section, or delete cdm.json and re-run, so it uses the flat ` +
                `dependencies/contracts format.`,
        );
    }
}

export function resolveContractInstallTarget(
    opts: ContractInstallOpts,
    cdmJson?: CdmJson,
): ContractInstallTarget {
    const cfg = getChainConfig();
    let assethubUrl = opts.assethubUrl;
    let ipfsGatewayUrl = opts.ipfsGatewayUrl;
    let registryAddress = opts.registryAddress;
    const chainName = opts.name;

    if (opts.name && opts.name !== "custom") {
        const preset = getChainPreset(opts.name);
        assethubUrl ??= preset.assethubUrl;
        ipfsGatewayUrl ??= preset.ipfsGatewayUrl;
        registryAddress ??= preset.registryAddress;
    }

    assethubUrl ??= cfg.assetHubRpc;
    ipfsGatewayUrl ??= cfg.bulletinGateway;
    if (registryAddress == null) {
        const activeRegistryAddress = getRegistryAddress(cfg.cdmEnvName);
        registryAddress = activeRegistryAddress || cdmJson?.registry;
    }

    return {
        assethubUrl,
        ipfsGatewayUrl,
        registryAddress: assertHexAddress(registryAddress, "Registry address"),
        chainName: chainName === "custom" ? undefined : chainName,
    };
}

function normalizeH160(value: unknown): HexString | null {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) return null;
    return value.toLowerCase() as HexString;
}

export function findForeignOwnedCdmPackages(
    packages: { packageName: string; versionCount: number; owner: HexString | null }[],
    caller: HexString,
): CdmPackageOwnershipConflict[] {
    const callerLower = caller.toLowerCase();
    return packages
        .filter((pkg) => pkg.versionCount > 0)
        .filter((pkg) => pkg.owner !== null && pkg.owner.toLowerCase() !== ZERO_H160)
        .filter((pkg) => pkg.owner!.toLowerCase() !== callerLower)
        .map((pkg) => ({
            packageName: pkg.packageName,
            owner: pkg.owner!,
            caller,
        }));
}

export function formatCdmPackageOwnershipConflicts(
    conflicts: CdmPackageOwnershipConflict[],
): string {
    if (conflicts.length === 1) {
        const conflict = conflicts[0];
        return (
            `CDM package "${conflict.packageName}" is already owned by ${conflict.owner}, ` +
            `but the selected signer maps to ${conflict.caller}. Update the contract Cargo.toml ` +
            `[package.metadata.cdm] package = "..." value to a package name you own, or ` +
            `deploy with the owner account.`
        );
    }
    return (
        `Some CDM packages are already owned by another account, but the selected signer maps to ${conflicts[0]?.caller}: ` +
        conflicts
            .map((conflict) => `${conflict.packageName} owned by ${conflict.owner}`)
            .join("; ") +
        `. Update each contract Cargo.toml [package.metadata.cdm] package = "..." value to package names you own, ` +
        `or deploy with the owner account.`
    );
}

async function assertCdmPackageOwnership({
    rootDir,
    client,
    registryAddress,
    origin,
}: {
    rootDir: string;
    client: ContractChainClient;
    registryAddress: HexString;
    origin: SS58String;
}): Promise<void> {
    const detected = detectBuildOrder(rootDir);
    const packageNames = [
        ...new Set(
            detected.contracts
                .map((contract) => contract.cdmPackage)
                .filter((pkg): pkg is string => Boolean(pkg)),
        ),
    ];
    if (packageNames.length === 0) return;

    const caller = normalizeH160(await client.assetHub.apis.ReviveApi.address(origin));
    if (!caller) {
        throw new Error(`Could not resolve Revive H160 address for ${origin}`);
    }

    const registry = suppressReviveTraceNoise(
        await createContractFromClient(
            client.raw.assetHub,
            client.descriptors.assetHub,
            registryAddress,
            CONTRACTS_REGISTRY_ABI,
            { defaultOrigin: origin },
        ),
    );

    const ownership = await Promise.all(
        packageNames.map(async (packageName) => {
            const [versionResult, ownerResult] = await Promise.all([
                registry.getVersionCount.query(packageName),
                registry.getOwner.query(packageName),
            ]);
            if (!versionResult.success || typeof versionResult.value !== "number") {
                throw new Error(`Failed to query registry version count for "${packageName}"`);
            }
            if (!ownerResult.success) {
                throw new Error(`Failed to query registry owner for "${packageName}"`);
            }
            return {
                packageName,
                versionCount: versionResult.value,
                owner: normalizeH160(ownerResult.value),
            };
        }),
    );

    const conflicts = findForeignOwnedCdmPackages(ownership, caller);
    if (conflicts.length > 0) {
        throw new Error(formatCdmPackageOwnershipConflicts(conflicts));
    }
}

// ── cdm-builder descriptor skew bridge ─────────────────────────────────────
// Our root `@parity/product-sdk-descriptors` paseo-asset-hub descriptor and
// cdm-env's `CdmDeployAssetHubDescriptor` (which `cdm-builder` generates the
// `PipelineChainClient` type from) come from different product-sdk descriptor
// generations, so the `DotnsGateway` pallet shape differs nominally (e.g.
// `PopControllerAddressSet` vs `DispatcherAddressSet`). They are structurally
// identical for the Revive + registry calls the contract pipeline actually
// makes — it never touches DotnsGateway — so cast through these single seams.
// Delete once the two descriptor generations realign. Sibling of the
// `asCloudStorageApi` seam (see CLAUDE.md "cdm-builder version skew").
function asCdmAssetHubApi(api: unknown): PipelineChainClient["assetHub"] {
    return api as PipelineChainClient["assetHub"];
}
function asCdmAssetHubDescriptor(d: unknown): PipelineChainClient["descriptors"]["assetHub"] {
    return d as PipelineChainClient["descriptors"]["assetHub"];
}

// Same family of skew: `installContracts` comes from `@parity/cdm-builder`,
// which pins an OLDER `@parity/product-sdk-contracts` whose `Contract.tx()`
// resolves a bare `TxResult`. Our root bumped contracts to 0.9.x, where `.tx()`
// resolves a `Result<TxResult, …>`, so the freshly-built `registry` contract is
// nominally unassignable to cdm-builder's `RegistryContract` param. The
// install-time registry is query-only (no signer wired in — see `liveManager`),
// so `.tx()` is never invoked through it and the cast is runtime-safe. Delete
// once cdm-builder's pinned contracts version realigns with our root.
type CdmRegistryContract = Parameters<typeof installContracts>[0]["registry"];
function asCdmRegistryContract(contract: unknown): CdmRegistryContract {
    return contract as CdmRegistryContract;
}

async function createContractChainClient(
    target: ContractDeployTarget,
): Promise<ContractChainClient> {
    const cfg = getChainConfig();
    const assetHubDescriptor = getAssetHubDescriptor(cfg.env);
    const bulletinDescriptor = getBulletinDescriptor(cfg.env);
    const raw = {
        assetHub: createClient(getWsProvider([target.assethubUrl])),
        bulletin: createClient(
            getWsProvider(target.bulletinUrls, { heartbeatTimeout: BULLETIN_WS_HEARTBEAT_MS }),
        ),
    };
    let destroyed = false;
    const destroy = () => {
        if (destroyed) return;
        destroyed = true;
        raw.assetHub.destroy();
        raw.bulletin.destroy();
    };

    try {
        await Promise.all([raw.assetHub.getChainSpecData(), raw.bulletin.getChainSpecData()]);
    } catch (err) {
        destroy();
        throw err;
    }

    return {
        assetHub: asCdmAssetHubApi(raw.assetHub.getTypedApi(assetHubDescriptor)),
        bulletin: raw.bulletin.getTypedApi(bulletinDescriptor),
        raw,
        descriptors: {
            assetHub: asCdmAssetHubDescriptor(assetHubDescriptor),
            bulletin: bulletinDescriptor,
        },
        destroy,
    };
}

export async function runContractDeploy(
    opts: ContractDeployOpts,
    runOptions: ContractDeployRunOptions = {},
): Promise<ContractDeployRunResult> {
    const target = resolveContractDeployTarget(opts);
    const cfg = getChainConfig();
    const rootDir = resolve(opts.rootDir ?? process.cwd());
    const features = resolveFeatures(opts.features, rootDir);
    const useUi = runOptions.useUi ?? true;
    const signingCounter = createSigningCounter();

    let signer: ResolvedSigner | null = runOptions.resolvedSigner ?? null;
    const ownsSigner = !signer;
    let client: ContractChainClient | null = null;
    const cleanupOnce = (() => {
        let ran = false;
        return () => {
            if (ran) return;
            ran = true;
            if (ownsSigner) {
                try {
                    signer?.destroy();
                } catch {}
            }
            try {
                client?.destroy();
            } catch {}
        };
    })();
    onProcessShutdown(cleanupOnce);

    try {
        signer ??= await resolveSigner(resolveContractSignerOptions(opts));
        runOptions.onDeployEvent?.({
            type: "log",
            line: "connecting contract chains",
        });
        client = await createContractChainClient(target);
        runOptions.onDeployEvent?.({
            type: "log",
            line: "checking cdm registry ownership",
        });
        await assertCdmPackageOwnership({
            rootDir,
            client,
            registryAddress: target.registryAddress,
            origin: signer.address as SS58String,
        });
        runOptions.onDeployEvent?.({
            type: "log",
            line: "cdm registry ownership ok",
        });
        runOptions.onDeployEvent?.({
            type: "log",
            line: "checking cached bulletin allowance",
        });
        const metadataSigner = await getCachedBulletinAllowanceSigner({
            publishSigner: signer,
        });

        if (useUi) {
            return await runContractDeployWithUI({
                rootDir,
                features,
                client,
                signer: signer.signer,
                origin: signer.address as SS58String,
                registryAddress: target.registryAddress,
                metadataSigner,
                assethubUrl: target.assethubUrl,
                bulletinUrl: target.bulletinUrl,
                ipfsGatewayUrl: cfg.bulletinGateway,
                signerAddress: signer.address,
                signerRequiresApproval: signer.source === "session",
            });
        }

        const deploySigner =
            signer.source === "session" && runOptions.onSigningEvent
                ? wrapSignerWithEvents(signer.signer, {
                      label: "Deploy and register contracts",
                      counter: signingCounter,
                      onEvent: runOptions.onSigningEvent,
                  })
                : signer.signer;
        const summary = await deployContracts({
            rootDir,
            features,
            client,
            signer: deploySigner,
            origin: signer.address as SS58String,
            registryAddress: target.registryAddress,
            metadataSigner,
            onEvent: runOptions.onDeployEvent,
        });
        return {
            summary,
            success: summary.contracts.every((contract) => contract.status !== "error"),
        };
    } finally {
        cleanupOnce();
    }
}

function detectProjectType(rootDir: string): {
    hasRust: boolean;
    hasSolidity: boolean;
    hasTypeScript: boolean;
} {
    return {
        hasRust: existsSync(resolve(rootDir, "Cargo.toml")),
        hasSolidity: hasBuildableSolidityProject(rootDir),
        hasTypeScript: existsSync(resolve(rootDir, "package.json")),
    };
}

export function installRequestsFromArgs(
    libraries: string[],
    cdmJson: CdmJson,
    location: string,
): InstallLibraryRequest[] {
    if (libraries.length > 0) return libraries.map(parseContractInstallLibraryArg);

    const deps = cdmJson.dependencies;
    if (!deps || Object.keys(deps).length === 0) {
        throw new Error(
            `No library specified and no dependencies found in cdm.json (looked in ${location}). ` +
                'Pass a library to install (e.g. "@org/name"), or add a "dependencies" map to ' +
                "cdm.json. If you meant to deploy a frontend, run from the project root.",
        );
    }

    return Object.entries(deps).map(([library, version]) => ({
        library,
        requestedVersion: version === "latest" ? "latest" : Number(version),
    }));
}

function updateCdmJsonAfterInstall(
    cdmJson: CdmJson,
    target: ContractInstallTarget,
    requests: InstallLibraryRequest[],
    results: InstallResult[],
): void {
    cdmJson.registry = target.registryAddress;
    cdmJson.dependencies ??= {};
    cdmJson.contracts ??= {};

    for (const result of results) {
        const request = requests.find((entry) => entry.library === result.library);
        if (!request) continue;
        cdmJson.dependencies[result.library] = request.requestedVersion;
        cdmJson.contracts[result.library] = {
            version: result.version,
            address: result.address,
            abi: result.abi,
            metadataCid: result.metadataCid,
        };
    }
}

function ensureTsconfigIncludesCdm(rootDir: string): void {
    const tsconfigPath = resolve(rootDir, "tsconfig.json");

    let tsconfig: Record<string, unknown>;
    if (existsSync(tsconfigPath)) {
        try {
            tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8"));
        } catch {
            return;
        }
    } else {
        tsconfig = {};
    }

    const include = Array.isArray(tsconfig.include) ? tsconfig.include : [];
    const alreadyHas = include.some(
        (entry: unknown) => typeof entry === "string" && entry.replace(/^\.\//, "") === CDM_INCLUDE,
    );
    if (alreadyHas) return;

    include.push(`./${CDM_INCLUDE}`);
    tsconfig.include = include;
    writeFileSync(tsconfigPath, `${JSON.stringify(tsconfig, null, 4)}\n`);
}

function postInstallSolidity(rootDir: string, cdmJson: CdmJson): void {
    const contractsForTarget = cdmJson.contracts;
    if (!contractsForTarget) return;

    for (const [library, data] of Object.entries(contractsForTarget)) {
        const generated = generateSolidityImport({
            library,
            address: data.address,
            version: data.version,
            abi: data.abi as SolidityAbiEntry[],
        });
        const outputPath = resolve(rootDir, generated.path);
        mkdirSync(dirname(outputPath), { recursive: true });
        writeFileSync(outputPath, generated.content);
    }
}

function postInstallTypeScript(rootDir: string, cdmJson: CdmJson): void {
    const contractsForTarget = cdmJson.contracts;
    if (!contractsForTarget) return;

    const contracts = Object.entries(contractsForTarget).map(([library, data]) => ({
        library,
        abi: data.abi as Parameters<typeof generateContractTypes>[0][number]["abi"],
    }));
    if (contracts.length === 0) return;

    const cdmDir = resolve(rootDir, ".cdm");
    mkdirSync(cdmDir, { recursive: true });
    writeFileSync(resolve(cdmDir, "cdm.d.ts"), generateContractTypes(contracts));
    writeFileSync(resolve(cdmDir, "contracts.d.ts"), generateContractsAugmentation(contracts));
    ensureTsconfigIncludesCdm(rootDir);
}

function runPostInstallHooks(rootDir: string, cdmJson: CdmJson): void {
    const projectType = detectProjectType(rootDir);
    if (projectType.hasSolidity) postInstallSolidity(rootDir, cdmJson);
    if (projectType.hasTypeScript) postInstallTypeScript(rootDir, cdmJson);
}

export async function runContractInstall(
    libraries: string[],
    opts: ContractInstallOpts,
    runOptions: ContractInstallRunOptions = {},
): Promise<ContractInstallRunResult> {
    const rootDir = resolve(opts.rootDir ?? process.cwd());
    const cdmResult = readCdmJson(rootDir);
    const cdmJson = cdmResult?.cdmJson ?? { dependencies: {}, contracts: {} };
    assertSupportedCdmJson(cdmJson, cdmResult?.cdmJsonPath);
    const target = resolveContractInstallTarget(opts, cdmJson);
    const requests = installRequestsFromArgs(libraries, cdmJson, cdmResult?.cdmJsonPath ?? rootDir);
    const useUi = runOptions.useUi ?? true;

    let client: Awaited<ReturnType<typeof createCdmAssetHubClient>> | null = null;
    const cleanupOnce = (() => {
        let ran = false;
        return () => {
            if (ran) return;
            ran = true;
            try {
                client?.destroy();
            } catch {}
        };
    })();
    onProcessShutdown(cleanupOnce);

    try {
        client = await createCdmAssetHubClient(target.assethubUrl, target.chainName);
        await client.raw.assetHub.getChainSpecData();
        // Registry getters run through Revive dry-run queries, so product-sdk
        // still needs a mapped origin to encode the call. This is not a signer.
        const registry = suppressReviveTraceNoise(
            await createContractFromClient(
                client.raw.assetHub,
                client.descriptors.assetHub,
                target.registryAddress,
                CONTRACTS_REGISTRY_ABI,
                {
                    defaultOrigin: resolveQueryOrigin({
                        chainName: target.chainName,
                        assethubUrl: target.assethubUrl,
                    }),
                },
            ),
        );
        const ipfs = connectIpfsGateway(target.ipfsGatewayUrl);

        const result: ContractInstallRunResult = useUi
            ? await runContractInstallWithUI({
                  libraries: requests,
                  registry: asCdmRegistryContract(registry),
                  ipfs,
                  registryAddress: target.registryAddress,
                  assethubUrl: target.assethubUrl,
                  ipfsGatewayUrl: target.ipfsGatewayUrl,
              })
            : await installContracts({
                  libraries: requests,
                  registry: asCdmRegistryContract(registry),
                  ipfs,
                  onEvent: runOptions.onInstallEvent,
              }).then((summary) => ({ summary, success: summary.success }));

        updateCdmJsonAfterInstall(cdmJson, target, requests, result.summary.results);
        writeCdmJson(cdmJson, rootDir);
        if (result.summary.results.length > 0) {
            runPostInstallHooks(rootDir, cdmJson);
        }
        return result;
    } finally {
        cleanupOnce();
    }
}

function makeDeployCommand(): Command {
    return new Command("deploy")
        .description("Build, deploy, and register CDM contracts with the logged-in signer")
        .addOption(new Option("--signer <mode>", "Signer mode").choices(["dev", "phone"]))
        .option("--assethub-url <url>", "Override the Asset Hub WebSocket URL")
        .option("--bulletin-url <url>", "Override the Bulletin WebSocket URL")
        .option("--registry-address <address>", "Registry contract address")
        .option(
            "--suri <suri>",
            "Secret URI for local signing; defaults to polkadot-app-deploy's dev mnemonic when --signer dev",
        )
        .option("--features <features>", "Cargo feature flags to pass to the build")
        .action(async (opts: ContractDeployOpts) =>
            runCliCommand("contract", { watchdog: true, hardExit: true }, () =>
                runContractDeploy(opts).then((result) => {
                    if (!result.success) process.exitCode = 1;
                }),
            ),
        );
}

function makeInstallCommand(): Command {
    return new Command("install")
        .alias("i")
        .description("Install CDM contract libraries to ~/.cdm/")
        .argument(
            "[libraries...]",
            'CDM libraries (e.g., "@polkadot/reputation" or "@polkadot/reputation:3"). Omit to install all from cdm.json.',
        )
        .option("--assethub-url <url>", "WebSocket URL for Asset Hub chain")
        .option("-n, --name <name>", "Chain preset name (polkadot, paseo, preview-net, local)")
        .option("--ipfs-gateway-url <url>", "IPFS gateway URL for fetching metadata")
        .option("--registry-address <address>", "Registry contract address")
        .action(async (libraries: string[], opts: ContractInstallOpts) =>
            runCliCommand("contract", { watchdog: true, hardExit: true }, () =>
                runContractInstall(libraries, opts).then((result) => {
                    if (!result.success) process.exitCode = 1;
                }),
            ),
        );
}

export const contractCommand = new Command("contract")
    .description("Install and deploy smart contract libraries for your app")
    .usage("<command> [options]")
    .addCommand(makeDeployCommand())
    .addCommand(makeInstallCommand());
