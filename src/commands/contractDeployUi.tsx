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

import { useEffect, useState, type ReactNode } from "react";
import { Box, Text, render } from "ink";
import {
    deployContracts,
    detectBuildOrder,
    type DeployContractsOptions,
    type DeploySummary,
} from "@parity/cdm-builder";
import { getNetworkLabel } from "../config.js";
import { remapCargoMetadataError } from "../utils/toolchain.js";
import {
    COLOR,
    Callout,
    GLYPH,
    Header,
    LogTail,
    Mark,
    PhoneApprovalCallout,
    Row,
    Section,
    TIMING,
} from "../utils/ui/theme/index.js";
import { createSigningCounter, wrapSignerWithEvents } from "../utils/deploy/signingProxy.js";
import { VERSION_LABEL } from "../utils/version.js";
import { ContractPipelineStatusAdapter, type ContractStatus } from "./contractPipelineStatus.js";

const COL_CONTRACT = 22;
const COL_BUILD = 18;
const COL_REGISTRY = 8;
const COL_METADATA = 8;
const BAR_WIDTH = 12;

export interface ContractDeployUiOptions extends Omit<DeployContractsOptions, "onEvent"> {
    assethubUrl: string;
    bulletinUrl: string;
    ipfsGatewayUrl: string;
    signerAddress: string;
    signerRequiresApproval?: boolean;
}

export interface ContractDeployUiResult {
    summary: DeploySummary;
    success: boolean;
}

export interface ContractDeployDisplay {
    crates: string[];
    displayNames: Map<string, string>;
}

export async function runContractDeployWithUI(
    opts: ContractDeployUiOptions,
): Promise<ContractDeployUiResult> {
    const {
        assethubUrl,
        bulletinUrl,
        ipfsGatewayUrl,
        signerAddress,
        signerRequiresApproval = false,
        ...deployOpts
    } = opts;
    const { crates, displayNames } = precomputeContractDeployDisplay(
        deployOpts.rootDir,
        deployOpts.contracts,
    );
    const adapter = new ContractPipelineStatusAdapter({
        onCdmPackageDetected: (crate, pkg) => displayNames.set(crate, pkg),
    });

    const app = render(
        <ContractDeployScreen
            adapter={adapter}
            crates={crates}
            displayNames={displayNames}
            signerAddress={signerAddress}
            registryAddress={deployOpts.registryAddress}
            assethubUrl={assethubUrl}
            bulletinUrl={bulletinUrl}
            ipfsGatewayUrl={ipfsGatewayUrl}
        />,
    );
    const signingCounter = createSigningCounter();
    const signer = signerRequiresApproval
        ? wrapSignerWithEvents(deployOpts.signer, {
              label: "Deploy and register contracts",
              counter: signingCounter,
              onEvent: adapter.handleSigningEvent,
          })
        : deployOpts.signer;

    let summary: DeploySummary;
    try {
        summary = await deployContracts({
            ...deployOpts,
            signer,
            onEvent: adapter.handleDeployEvent,
        });
    } finally {
        await new Promise((resolve) => setTimeout(resolve, 200));
        app.unmount();
    }

    return {
        summary,
        success: summary.contracts.every((contract) => contract.status !== "error"),
    };
}

export function precomputeContractDeployDisplay(
    rootDir: string,
    contracts: string[] | undefined,
): ContractDeployDisplay {
    let order: ReturnType<typeof detectBuildOrder>;
    try {
        order = detectBuildOrder(rootDir, contracts);
    } catch (err) {
        throw remapCargoMetadataError(err);
    }
    const displayNames = new Map<string, string>();
    for (const contract of order.contracts) {
        displayNames.set(
            contract.name,
            contract.cdmPackage ?? contract.displayName ?? contract.name,
        );
    }
    return { crates: order.layers.flat(), displayNames };
}

function ContractDeployScreen({
    adapter,
    crates,
    displayNames,
    signerAddress,
    registryAddress,
    assethubUrl,
    bulletinUrl,
    ipfsGatewayUrl,
}: {
    adapter: ContractPipelineStatusAdapter;
    crates: string[];
    displayNames: Map<string, string>;
    signerAddress: string;
    registryAddress: string;
    assethubUrl: string;
    bulletinUrl: string;
    ipfsGatewayUrl: string;
}) {
    return (
        <Box flexDirection="column">
            <Header
                cmd="playground contract deploy"
                subtitle="cdm contracts"
                network={getNetworkLabel()}
                right={VERSION_LABEL}
            />
            <Section gapBelow={false}>
                <Row label="signer" value={signerAddress} tone="muted" />
                <Row label="registry" value={registryAddress} tone="muted" />
            </Section>
            <ContractDeployStatusView
                adapter={adapter}
                crates={crates}
                displayNames={displayNames}
                assethubUrl={assethubUrl}
                ipfsGatewayUrl={ipfsGatewayUrl}
            />
        </Box>
    );
}

export function ContractDeployStatusView({
    adapter,
    crates,
    displayNames,
    assethubUrl,
    ipfsGatewayUrl,
}: {
    adapter: ContractPipelineStatusAdapter;
    crates: string[];
    displayNames: Map<string, string>;
    assethubUrl: string;
    ipfsGatewayUrl: string;
}) {
    const [tick, setTick] = useState(0);

    useEffect(() => {
        const timer = setInterval(() => setTick((current) => current + 1), TIMING.spinnerMs);
        return () => clearInterval(timer);
    }, []);

    return (
        <Box flexDirection="column">
            {adapter.signingPrompt && (
                <PhoneApprovalCallout
                    step={adapter.signingPrompt.step}
                    label={adapter.signingPrompt.label}
                />
            )}
            {adapter.signingError && (
                <Callout tone="danger" title="Signing Failed">
                    <Text>{adapter.signingError}</Text>
                </Callout>
            )}
            {adapter.runError && (
                <Callout tone="danger" title="Contract Deploy Failed">
                    <Text>{adapter.runError}</Text>
                </Callout>
            )}
            <DeployTable
                statuses={adapter.statuses}
                displayNames={displayNames}
                crates={crates.length > 0 ? crates : adapter.crates}
                logLines={adapter.logLines}
                assethubUrl={assethubUrl}
                ipfsGatewayUrl={ipfsGatewayUrl}
                tick={tick}
            />
        </Box>
    );
}

function DeployTable({
    statuses,
    displayNames,
    crates,
    logLines,
    assethubUrl,
    ipfsGatewayUrl,
    tick,
}: {
    statuses: Map<string, ContractStatus>;
    displayNames: Map<string, string>;
    crates: string[];
    logLines: string[];
    assethubUrl: string;
    ipfsGatewayUrl: string;
    tick: number;
}) {
    const rowCrates = [
        ...crates,
        ...Array.from(statuses.keys()).filter((crate) => !crates.includes(crate)),
    ];
    const errors = errorGroups(rowCrates, statuses, displayNames);

    return (
        <Box flexDirection="column" marginTop={1}>
            <HeaderRow />
            {rowCrates.map((crate) => (
                <ContractRow
                    key={crate}
                    name={displayNames.get(crate) ?? crate}
                    status={statuses.get(crate)}
                    assethubUrl={assethubUrl}
                    ipfsGatewayUrl={ipfsGatewayUrl}
                    tick={tick}
                />
            ))}
            {rowCrates.length === 0 && <Row mark="run" label="detecting contracts" tone="muted" />}
            {logLines.length > 0 && (
                <Box marginTop={1}>
                    <LogTail
                        lines={logLines}
                        height={ContractPipelineStatusAdapter.LOG_TAIL_LINES}
                    />
                </Box>
            )}
            {errors.length > 0 && (
                <Box flexDirection="column" marginTop={1}>
                    {errors.map(({ names, error }) => (
                        <Row
                            key={`${names.join(",")}:${error}`}
                            mark="fail"
                            label={formatErrorNames(names)}
                            value={error}
                            tone="danger"
                        />
                    ))}
                </Box>
            )}
        </Box>
    );
}

function HeaderRow() {
    return (
        <Box paddingLeft={2}>
            <Cell width={COL_CONTRACT}>
                <Text dimColor>contract</Text>
            </Cell>
            <Cell width={COL_BUILD}>
                <Text dimColor>build</Text>
            </Cell>
            <Cell width={COL_REGISTRY}>
                <Text dimColor>registry</Text>
            </Cell>
            <Cell width={COL_METADATA}>
                <Text dimColor>metadata</Text>
            </Cell>
            <Cell>
                <Text dimColor>address</Text>
            </Cell>
        </Box>
    );
}

function ContractRow({
    name,
    status,
    assethubUrl,
    ipfsGatewayUrl,
    tick,
}: {
    name: string;
    status: ContractStatus | undefined;
    assethubUrl: string;
    ipfsGatewayUrl: string;
    tick: number;
}) {
    const state = status?.state ?? "waiting";

    return (
        <Box paddingLeft={2}>
            <Cell width={COL_CONTRACT}>
                <Text bold wrap="truncate">
                    {name}
                </Text>
            </Cell>
            <Cell width={COL_BUILD}>{buildCell(status, tick)}</Cell>
            <Cell width={COL_REGISTRY}>{registryCell(status, state, assethubUrl, tick)}</Cell>
            <Cell width={COL_METADATA}>{metadataCell(status, state, ipfsGatewayUrl, tick)}</Cell>
            <Cell>{status?.address ? <Text dimColor>{status.address}</Text> : <Idle />}</Cell>
        </Box>
    );
}

function buildCell(status: ContractStatus | undefined, tick: number) {
    const state = status?.state ?? "waiting";
    if (state === "building" && status?.buildProgress) {
        return (
            <ProgressBar
                current={status.buildProgress.compiled}
                total={status.buildProgress.total}
            />
        );
    }
    if (state === "building") return <Spinner tick={tick} />;
    if (state === "error" && errorPhase(status) === "build") return <Mark kind="fail" />;
    if (state === "waiting") return <EmptyBar />;
    if (status?.bytecodeSize) {
        return <ProgressBar current={1} total={1} tail={formatBytes(status.bytecodeSize)} />;
    }
    return <Mark kind="ok" />;
}

function registryCell(
    status: ContractStatus | undefined,
    state: ContractStatus["state"],
    assethubUrl: string,
    tick: number,
) {
    if (state === "checking" || status?.deployInProgress || status?.registerInProgress) {
        return <Spinner tick={tick} />;
    }
    if (
        state === "error" &&
        (errorPhase(status) === "deploy" || errorPhase(status) === "register")
    ) {
        return <Mark kind="fail" />;
    }
    if (state === "cached") return <Cached />;
    if (status?.deployTxHash && status.deployBlockHash) {
        return (
            <HashText
                value={status.deployTxHash}
                url={pjsExplorerUrl(assethubUrl, status.deployBlockHash)}
            />
        );
    }
    if (state === "done") return <Mark kind="ok" />;
    return <Idle />;
}

function metadataCell(
    status: ContractStatus | undefined,
    state: ContractStatus["state"],
    ipfsGatewayUrl: string,
    tick: number,
) {
    if (status?.publishInProgress) return <Spinner tick={tick} />;
    if (state === "error" && errorPhase(status) === "metadata") return <Mark kind="fail" />;
    if (state === "cached") return <Cached />;
    if (status?.cid) {
        return <HashText value={status.cid} url={ipfsUrl(ipfsGatewayUrl, status.cid)} />;
    }
    return <Idle />;
}

function ProgressBar({
    current,
    total,
    tail,
}: {
    current: number;
    total: number;
    tail?: string;
}) {
    const filled = total > 0 ? Math.round((current / total) * BAR_WIDTH) : 0;
    return (
        <Text>
            <Text color={COLOR.success}>{GLYPH.cursorBlock.repeat(filled)}</Text>
            <Text dimColor>{GLYPH.progressEmpty.repeat(BAR_WIDTH - filled)}</Text>
            <Text> {tail ?? `${current}/${total}`}</Text>
        </Text>
    );
}

function EmptyBar() {
    return <Text dimColor>{GLYPH.progressEmpty.repeat(BAR_WIDTH)}</Text>;
}

function Spinner({ tick }: { tick: number }) {
    return <Text color={COLOR.warning}>{GLYPH.spinner[tick % GLYPH.spinner.length]}</Text>;
}

function Cached() {
    return <Text color={COLOR.accent}>{GLYPH.cached}</Text>;
}

function Idle() {
    return <Text dimColor>{GLYPH.pending}</Text>;
}

function HashText({ value, url }: { value: string; url?: string }) {
    const label = <Text color={COLOR.success}>{shortHash(value)}</Text>;
    return url ? <Link url={url}>{label}</Link> : label;
}

function Cell({ children, width }: { children: ReactNode; width?: number }) {
    return (
        <Box width={width} marginRight={1}>
            {children}
        </Box>
    );
}

function errorPhase(
    status: ContractStatus | undefined,
): "build" | "deploy" | "metadata" | "register" {
    if (!status) return "build";
    if (status.address && status.publishTxHash) return "register";
    if (status.address && !status.publishTxHash && status.cid) return "metadata";
    if (
        status.buildProgress &&
        status.buildProgress.compiled === status.buildProgress.total &&
        status.buildProgress.total > 0
    ) {
        return "deploy";
    }
    return "build";
}

function errorGroups(
    crates: string[],
    statuses: Map<string, ContractStatus>,
    displayNames: Map<string, string>,
) {
    const groups = new Map<string, string[]>();
    for (const crate of crates) {
        const status = statuses.get(crate);
        if (status?.state !== "error" || !status.error) continue;
        const names = groups.get(status.error) ?? [];
        names.push(displayNames.get(crate) ?? crate);
        groups.set(status.error, names);
    }
    return [...groups].map(([error, names]) => ({ error, names }));
}

function formatErrorNames(names: string[]): string {
    if (names.length === 1) return names[0] ?? "contract";
    const preview = names.slice(0, 3).join(", ");
    const suffix = names.length > 3 ? ", ..." : "";
    return `${names.length} contracts (${preview}${suffix})`;
}

function formatBytes(bytes: number): string {
    if (bytes < 1000) return `${bytes}B`;
    if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(1)}KB`;
    return `${(bytes / 1_000_000).toFixed(1)}MB`;
}

function shortHash(value: string): string {
    if (value.startsWith("0x")) return value.slice(2, 6);
    return value.slice(-4);
}

function Link({ url, children }: { url: string; children: ReactNode }) {
    return (
        <Text>
            {`\x1b]8;;${url}\x07`}
            {children}
            {"\x1b]8;;\x07"}
        </Text>
    );
}

function pjsExplorerUrl(rpcUrl: string, blockHash: string): string {
    return `https://polkadot.js.org/apps/?rpc=${encodeURIComponent(rpcUrl)}#/explorer/query/${blockHash}`;
}

function ipfsUrl(gatewayUrl: string, cid: string): string {
    return `${gatewayUrl.replace(/\/+$/, "")}/${cid.replace(/^\/+/, "")}`;
}
