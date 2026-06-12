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

import type {
    DeployEvent as ContractDeployEvent,
    DeploySummary,
    InstallEvent as ContractInstallEvent,
    InstallSummary,
} from "@parity/cdm-builder";
import { runContractDeploy, runContractInstall } from "../contract.js";
import type { SigningEvent } from "../../utils/deploy/signingProxy.js";
import type { SignerMode } from "../../utils/deploy/signerMode.js";
import type { ResolvedSigner } from "../../utils/signer.js";

export interface RunContractsBeforeFrontendOptions {
    projectDir: string;
    mode: SignerMode;
    suri?: string;
    userSigner: ResolvedSigner | null;
    onDeployEvent?: (event: ContractDeployEvent) => void;
    onInstallEvent?: (event: ContractInstallEvent) => void;
    onSigningEvent?: (event: SigningEvent) => void;
}

export interface RunContractsBeforeFrontendResult {
    deploySummary: DeploySummary;
    installSummary: InstallSummary;
    installedLibraries: string[];
}

export function installLibrariesFromDeploySummary(summary: DeploySummary): string[] {
    const seen = new Set<string>();
    for (const contract of summary.contracts) {
        if (contract.status === "error" || !contract.cdmPackage) continue;
        seen.add(contract.cdmPackage);
    }
    return [...seen];
}

export async function runContractsBeforeFrontend({
    projectDir,
    mode,
    suri,
    userSigner,
    onDeployEvent,
    onInstallEvent,
    onSigningEvent,
}: RunContractsBeforeFrontendOptions): Promise<RunContractsBeforeFrontendResult> {
    const deploy = await runContractDeploy(
        {
            rootDir: projectDir,
            signer: mode,
            suri,
        },
        {
            useUi: false,
            resolvedSigner: contractSignerOverride(mode, userSigner),
            onDeployEvent,
            onSigningEvent,
        },
    );
    if (!deploy.success) {
        throw new Error(formatContractErrors("Contract deploy failed", deploy.summary));
    }

    if (deploy.summary.contracts.length === 0) {
        throw new Error(
            `No deployable smart contracts found in ${projectDir}. ` +
                "If this app has no contracts, deploy without --contracts " +
                '(or answer "No" to the contracts question). If it does, ' +
                "run the deploy from the project directory that contains them.",
        );
    }

    const installedLibraries = installLibrariesFromDeploySummary(deploy.summary);
    if (installedLibraries.length === 0) {
        throw new Error(
            "Contract deploy completed, but no CDM package names were registered. " +
                'Add [package.metadata.cdm] package = "@org/name" to each deployable Cargo.toml.',
        );
    }

    const install = await runContractInstall(
        installedLibraries,
        { rootDir: projectDir },
        {
            useUi: false,
            onInstallEvent,
        },
    );
    if (!install.success) {
        throw new Error(formatInstallErrors("Contract install failed", install.summary));
    }

    return {
        deploySummary: deploy.summary,
        installSummary: install.summary,
        installedLibraries,
    };
}

function contractSignerOverride(
    mode: SignerMode,
    userSigner: ResolvedSigner | null,
): ResolvedSigner | undefined {
    if (mode === "phone") {
        if (userSigner?.source !== "session") {
            throw new Error(
                "Phone signer requested for contract deploy, but no session is active.",
            );
        }
        return userSigner;
    }
    return userSigner?.source === "dev" ? userSigner : undefined;
}

function formatContractErrors(prefix: string, summary: DeploySummary): string {
    const errors = summary.contracts
        .filter((contract) => contract.status === "error")
        .map(
            (contract) => `${contract.cdmPackage ?? contract.crate}: ${contract.error ?? "error"}`,
        );
    return errors.length === 0 ? prefix : `${prefix}: ${errors.join("; ")}`;
}

function formatInstallErrors(prefix: string, summary: InstallSummary): string {
    const errors = summary.errors.map((entry) => `${entry.library}: ${entry.error}`);
    return errors.length === 0 ? prefix : `${prefix}: ${errors.join("; ")}`;
}
