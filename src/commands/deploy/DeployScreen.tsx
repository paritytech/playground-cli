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

import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import type {
    DeployEvent as ContractDeployEvent,
    InstallEvent as ContractInstallEvent,
} from "@parity/cdm-builder";
import {
    Header,
    Row,
    Section,
    Hint,
    Callout,
    PromptInfo,
    PhoneApprovalCallout,
    Sparkline,
    Select,
    Input,
    setWindowTitle,
    type MarkKind,
} from "../../utils/ui/theme/index.js";
import {
    resolveSignerSetup,
    DEV_PUBLISH_ADDRESS,
    type SignerMode,
    type DeployApproval,
} from "../../utils/deploy/signerMode.js";
import {
    checkDomainAvailability,
    formatAvailability,
    type AvailabilityResult,
    type DeployPlan,
} from "../../utils/deploy/availability.js";
import { readReadme, README_CAP_BYTES } from "../../utils/deploy/playground.js";
import type { DeployEvent, DeployOutcome } from "../../utils/deploy/run.js";
import type { SigningEvent } from "../../utils/deploy/signingProxy.js";
import { buildSummaryView } from "./summary.js";
import {
    initialRunningState,
    runningReducer,
    type FrontendSectionState,
    type StepStatus,
} from "./runningState.js";
import type { ResolvedSigner } from "../../utils/signer.js";
import { DEFAULT_BUILD_DIR, getChainConfig, getEnvTld, getNetworkLabel } from "../../config.js";
import { VERSION_LABEL } from "../../utils/version.js";
import { ModdableErrorStage, ModdablePreflightStage } from "./ModdableStages.js";
import { PLAYGROUND_TAGS } from "../../utils/deploy/tags.js";
import { normalizeDomain } from "../../utils/deploy/playground.js";
import {
    NO_SESSION_NOTICE_TITLE,
    NO_SESSION_NOTICE_BODY,
    DEV_SIGNER_NO_XP_TITLE,
    DEV_SIGNER_NO_XP_BODY,
    deploySignerOptions,
    shouldShowDevNoXpWarning,
} from "./signerNotice.js";
import {
    BUILD_HELP,
    BUILD_HINT,
    CONTRACTS_HELP,
    SIGNER_HELP,
    PUBLISH_HELP,
    MODDABLE_HELP,
    TAGS_HELP,
    DOMAIN_HELP,
    BUILD_DIR_HINT,
    DOMAIN_HINT,
    CONTRACTS_RENAME_NOTICE_TITLE,
    CONTRACTS_RENAME_NOTICE_BODY,
    CONTRACTS_RENAME_NOTICE_HINT,
} from "./promptHelp.js";
import { ContractPipelineStatusAdapter } from "../contractPipelineStatus.js";
import { ContractDeployStatusView, precomputeContractDeployDisplay } from "../contractDeployUi.js";
import { ContractInstallStatusAdapter, ContractInstallStatusView } from "../contractInstallUi.js";

export interface DeployScreenInputs {
    projectDir: string;
    domain: string | null;
    buildDir: string | null;
    mode: SignerMode | null;
    /** Secret URI forwarded to the contract pre-step when deploy was invoked with --suri. */
    suri?: string;
    /** Pre-set from --contracts / --no-contracts. null = ask. */
    deployContracts: boolean | null;
    publishToPlayground: boolean | null;
    /** Publish to the playground with private visibility. Not interactively prompted — set via `--private`. */
    playgroundPrivate: boolean;
    skipBuild: boolean | null;
    /** Pre-set moddable from `--moddable` / `--no-moddable`. null = ask. */
    moddable: boolean | null;
    /**
     * Pre-set tag from `--tag`. A string skips the picker; `undefined` means
     * "ask in the TUI" once the user opts to publish. (The picker itself can
     * also resolve to `null` = explicitly untagged.)
     */
    tag?: string;
    userSigner: ResolvedSigner | null;
    onDone: (
        outcome: DeployOutcome | null,
        opts?: { graceful?: boolean; gracefulMessage?: string },
    ) => void;
}

export type Stage =
    | { kind: "ack" }
    | { kind: "prompt-build" }
    | { kind: "prompt-signer" }
    | { kind: "prompt-contracts" }
    | { kind: "prompt-contracts-notice" }
    | { kind: "prompt-buildDir" }
    | { kind: "prompt-domain" }
    | { kind: "validate-domain"; domain: string }
    | { kind: "prompt-publish" }
    | { kind: "prompt-moddable" }
    | { kind: "moddable-preflight" }
    | { kind: "moddable-error"; message: string }
    | { kind: "prompt-tags" }
    | { kind: "confirm" }
    | { kind: "running" }
    | { kind: "done"; outcome: DeployOutcome }
    | { kind: "error"; message: string };

interface Resolved {
    mode: SignerMode;
    buildDir: string;
    domain: string;
    deployContracts: boolean;
    publishToPlayground: boolean;
    skipBuild: boolean;
    moddable: boolean;
    repositoryUrl: string | null;
    /** Resolved playground tag, or `null` for untagged. Only meaningful when `publishToPlayground`. */
    tag: string | null;
}

/**
 * Plain-language info box rendered above a conceptual deploy prompt. See
 * `promptHelp.ts`. The `accent` tone marks it as informational (distinct from
 * the yellow `warning` notices).
 */
/** One-line dim hint above a lightweight prompt. */
function PromptHint({ text }: { text: string }) {
    return (
        <Box marginLeft={2} marginBottom={1}>
            <Text dimColor>{text}</Text>
        </Box>
    );
}

export function DeployScreen({
    projectDir,
    domain: initialDomain,
    buildDir: initialBuildDir,
    mode: initialMode,
    suri,
    deployContracts: initialDeployContracts,
    publishToPlayground: initialPublish,
    playgroundPrivate,
    skipBuild: initialSkipBuild,
    moddable: initialModdable,
    tag: initialTag,
    userSigner,
    onDone,
}: DeployScreenInputs) {
    // Phone signing needs a paired session (from `playground login`). Without
    // one the phone path is not offered — but a dev deploy still works. If the
    // user pre-selected `--signer phone` yet has no session, drop back to the
    // picker (mode = null) so they see the notice and can choose the dev signer.
    const hasSession = userSigner?.source === "session";
    const effectiveInitialMode: SignerMode | null =
        !hasSession && initialMode === "phone" ? null : initialMode;
    const effectiveInitialSkipBuild = initialDeployContracts === true ? false : initialSkipBuild;
    const [mode, setMode] = useState<SignerMode | null>(effectiveInitialMode);
    // Which signer option the cursor is currently on in the prompt-signer Select.
    // Drives the "dev signer earns no XP" warning, which only matters while the
    // dev option is highlighted. Defaults to "phone" (the top, default-cursor
    // option when a session exists) so the warning starts hidden.
    const [highlightedSigner, setHighlightedSigner] = useState<SignerMode>("phone");
    const [deployContracts, setDeployContracts] = useState<boolean | null>(initialDeployContracts);
    const [buildDir, setBuildDir] = useState<string | null>(initialBuildDir);
    const [domain, setDomain] = useState<string | null>(initialDomain);
    const [publishToPlayground, setPublishToPlayground] = useState<boolean | null>(initialPublish);
    const [skipBuild, setSkipBuild] = useState<boolean | null>(effectiveInitialSkipBuild);
    const [moddable, setModdable] = useState<boolean | null>(initialModdable);
    const [repositoryUrl, setRepositoryUrl] = useState<string | null>(null);
    // Tri-state: `undefined` = not chosen yet (ask when publishing), `null` =
    // explicitly untagged, a string = chosen tag. A `--tag` flag pre-fills it.
    const [tag, setTag] = useState<string | null | undefined>(initialTag);
    const [domainError, setDomainError] = useState<string | null>(null);
    // Captured from the availability check; feeds `resolveSignerSetup` so
    // the summary card shows the correct phone-approval count (a new register
    // is 3 DotNS taps, an update of a name we already own is 1).
    const [plan, setPlan] = useState<DeployPlan | null>(null);
    // Always open on the README acknowledgement so users learn — before
    // investing any time in the flow — that their README becomes the app's
    // playground detail page. Enter drops into the normal prompt sequence
    // (computed from any pre-filled flags); Esc exits gracefully so they can
    // go edit the README first.
    const [stage, setStage] = useState<Stage>({ kind: "ack" });

    // Passed down to RunningStage; read back on completion for the sparkline.
    // Ref instead of state so the high-frequency chunk-progress stream doesn't
    // force re-renders of the whole DeployScreen.
    const finalChunkTimingsRef = useRef<number[]>([]);

    const advance = (
        nextSkipBuild: boolean | null = skipBuild,
        nextMode: SignerMode | null = mode,
        nextDeployContracts: boolean | null = deployContracts,
        nextBuildDir: string | null = buildDir,
        nextDomain: string | null = domain,
        nextPublish: boolean | null = publishToPlayground,
        nextModdable: boolean | null = moddable,
        nextRepoUrl: string | null = repositoryUrl,
        nextTag: string | null | undefined = tag,
    ) => {
        const s = pickNextStage(
            nextSkipBuild,
            nextMode,
            nextDeployContracts,
            nextBuildDir,
            nextDomain,
            nextPublish,
            nextModdable,
            nextRepoUrl,
            nextTag,
        );
        setStage(s);
    };

    // Single "user declined moddable" transition, shared by the remix prompt's
    // "no" answer and the setup-error menu's "continue without moddable", so
    // the two paths can't drift apart.
    const declineModdable = () => {
        setModdable(false);
        advance(skipBuild, mode, deployContracts, buildDir, domain, publishToPlayground, false);
    };

    const resolved = useMemo<Resolved | null>(() => {
        const effectiveSkipBuild = deployContracts === true ? false : skipBuild;
        if (
            mode === null ||
            deployContracts === null ||
            buildDir === null ||
            domain === null ||
            publishToPlayground === null ||
            effectiveSkipBuild === null ||
            moddable === null ||
            // A tag is only required once the user has opted to publish; an
            // `undefined` tag there means the picker hasn't run yet.
            (publishToPlayground && tag === undefined)
        )
            return null;
        return {
            mode,
            deployContracts,
            buildDir,
            domain,
            publishToPlayground,
            skipBuild: effectiveSkipBuild,
            moddable,
            repositoryUrl,
            // Untagged when not publishing, or when the picker resolved to "skip".
            tag: publishToPlayground ? (tag ?? null) : null,
        };
    }, [
        mode,
        deployContracts,
        buildDir,
        domain,
        publishToPlayground,
        skipBuild,
        moddable,
        repositoryUrl,
        tag,
    ]);

    // Dynamic terminal tab title: subtitle becomes the domain once we know it.
    const headerSubtitle = resolved?.domain ?? domain ?? undefined;

    return (
        <Box flexDirection="column">
            <Header
                cmd="playground deploy"
                subtitle={headerSubtitle}
                network={getNetworkLabel()}
                right={VERSION_LABEL}
            />

            {stage.kind === "ack" && (
                <AckStage
                    onContinue={() => advance()}
                    onExit={() => onDone(null, { graceful: true })}
                />
            )}

            {stage.kind === "prompt-build" && (
                <Box flexDirection="column">
                    <PromptInfo box={BUILD_HELP} />
                    <PromptHint text={BUILD_HINT} />
                    <Select<boolean>
                        label="build before deploy?"
                        options={[
                            { value: false, label: "yes", hint: "rebuild with my latest code" },
                            { value: true, label: "no", hint: "redeploy the existing build" },
                        ]}
                        initialIndex={0}
                        onSelect={(skip) => {
                            setSkipBuild(skip);
                            advance(skip);
                        }}
                    />
                </Box>
            )}

            {stage.kind === "prompt-signer" && (
                <Box flexDirection="column">
                    <PromptInfo box={SIGNER_HELP} />
                    <Select<SignerMode>
                        label="who signs the upload?"
                        options={deploySignerOptions(hasSession)}
                        onHighlight={setHighlightedSigner}
                        onSelect={(m) => {
                            setMode(m);
                            advance(skipBuild, m);
                        }}
                    />
                    {/* Both notices sit below the options: the phone signer is
                        shown disabled above, and this explains why and how to
                        unlock it. The "no XP" trade-off (logged-in path) appears
                        right as the cursor lands on the dev signer. */}
                    {!hasSession && (
                        <Callout tone="warning" title={NO_SESSION_NOTICE_TITLE}>
                            <Text>{NO_SESSION_NOTICE_BODY}</Text>
                        </Callout>
                    )}
                    {shouldShowDevNoXpWarning(hasSession, highlightedSigner) && (
                        <Callout tone="warning" title={DEV_SIGNER_NO_XP_TITLE}>
                            <Text>{DEV_SIGNER_NO_XP_BODY}</Text>
                        </Callout>
                    )}
                </Box>
            )}

            {stage.kind === "prompt-contracts" && (
                <Box flexDirection="column">
                    <PromptInfo box={CONTRACTS_HELP} />
                    <Select<boolean>
                        label="did you change your smart contracts?"
                        options={[
                            { value: false, label: "no", hint: "I only changed the website" },
                            {
                                value: true,
                                label: "yes",
                                hint: "I changed contract code too",
                            },
                        ]}
                        initialIndex={0}
                        onSelect={(yes) => {
                            setDeployContracts(yes);
                            if (yes) setSkipBuild(false);
                            // Redeploying contracts is when the CDM-name ownership
                            // footgun bites (a mod ships names the signer doesn't
                            // own). Gate "yes" on an explicit rename ack; "no"
                            // skips straight ahead. The notice lives outside
                            // pickNextStage, so the headless --contracts path
                            // never hits it.
                            if (yes) setStage({ kind: "prompt-contracts-notice" });
                            else advance(skipBuild, mode, false);
                        }}
                    />
                </Box>
            )}

            {stage.kind === "prompt-contracts-notice" && (
                <ContractsRenameNotice
                    onContinue={() => advance(false, mode, true)}
                    onExit={() => onDone(null, { graceful: true })}
                />
            )}

            {stage.kind === "prompt-buildDir" && (
                <Box flexDirection="column">
                    <PromptHint text={BUILD_DIR_HINT} />
                    <Input
                        label="build directory"
                        initial={DEFAULT_BUILD_DIR}
                        onSubmit={(v) => {
                            setBuildDir(v);
                            advance(skipBuild, mode, deployContracts, v);
                        }}
                    />
                </Box>
            )}

            {stage.kind === "prompt-domain" && (
                <Box flexDirection="column">
                    <PromptInfo box={DOMAIN_HELP} />
                    <PromptHint text={DOMAIN_HINT} />
                    <Input
                        label="domain"
                        prefill={domain ?? ""}
                        externalError={domainError}
                        validate={(v) => {
                            // Same TLD-aware canonicalization the deploy path
                            // applies — accepts a bare label or `.<envTld>`,
                            // rejects a wrong-TLD suffix with the actionable
                            // message. Interactive deploys always run on the
                            // default env, hence bare `getEnvTld()`.
                            try {
                                normalizeDomain(v.trim(), getEnvTld());
                                return null;
                            } catch (err) {
                                return err instanceof Error ? err.message : String(err);
                            }
                        }}
                        onSubmit={(v) => {
                            const trimmed = v.trim();
                            setDomain(trimmed);
                            setDomainError(null);
                            setStage({ kind: "validate-domain", domain: trimmed });
                        }}
                    />
                </Box>
            )}

            {stage.kind === "validate-domain" && (
                <ValidateDomainStage
                    domain={stage.domain}
                    ownerSs58Address={
                        mode === "phone"
                            ? userSigner?.address
                            : userSigner?.source === "dev"
                              ? userSigner.address
                              : DEV_PUBLISH_ADDRESS
                    }
                    onAvailable={(result) => {
                        setDomain(result.fullDomain);
                        setPlan(result.plan);
                        advance(skipBuild, mode, deployContracts, buildDir, result.fullDomain);
                    }}
                    onUnavailable={(reason) => {
                        setDomainError(reason);
                        setStage({ kind: "prompt-domain" });
                    }}
                />
            )}

            {stage.kind === "prompt-publish" && (
                <Box flexDirection="column">
                    <PromptInfo box={PUBLISH_HELP} />
                    <Select<boolean>
                        label="publish to the playground?"
                        options={[
                            { value: true, label: "yes", hint: "list it in the public playground" },
                            { value: false, label: "no", hint: "deploy to my .dot address only" },
                        ]}
                        initialIndex={0}
                        onSelect={(yes) => {
                            setPublishToPlayground(yes);
                            if (!yes) setModdable(false);
                            advance(
                                skipBuild,
                                mode,
                                deployContracts,
                                buildDir,
                                domain,
                                yes,
                                yes ? moddable : false,
                            );
                        }}
                    />
                </Box>
            )}

            {stage.kind === "prompt-moddable" && (
                <Box flexDirection="column">
                    <PromptInfo box={MODDABLE_HELP} />
                    <Select<boolean>
                        label="let others remix (mod) this app?"
                        options={[
                            {
                                value: true,
                                label: "yes",
                                hint: "share my source so others can remix",
                            },
                            {
                                value: false,
                                label: "no",
                                hint: "keep my source private",
                            },
                        ]}
                        initialIndex={0}
                        onSelect={(yes) => {
                            if (yes) {
                                setModdable(true);
                                setStage({ kind: "moddable-preflight" });
                            } else {
                                declineModdable();
                            }
                        }}
                    />
                </Box>
            )}

            {stage.kind === "moddable-preflight" && (
                <ModdablePreflightStage
                    projectDir={projectDir}
                    onResolved={(url) => {
                        setRepositoryUrl(url);
                        advance(
                            skipBuild,
                            mode,
                            deployContracts,
                            buildDir,
                            domain,
                            publishToPlayground,
                            true,
                            url,
                        );
                    }}
                    onError={(msg) => {
                        setStage({ kind: "moddable-error", message: msg });
                    }}
                />
            )}

            {stage.kind === "moddable-error" && (
                <ModdableErrorStage
                    message={stage.message}
                    onContinueWithoutModdable={declineModdable}
                    onExit={() =>
                        onDone(null, {
                            graceful: true,
                            // Cause-neutral: this stage is reached for a missing
                            // origin, a private repo, or a non-GitHub origin, and
                            // the Callout above already named the specific problem.
                            gracefulMessage:
                                "No problem. Fix the GitHub repository setup and re-run `playground deploy` when ready.",
                        })
                    }
                />
            )}

            {stage.kind === "prompt-tags" && (
                <Box flexDirection="column">
                    <PromptInfo box={TAGS_HELP} />
                    <Select<string | null>
                        label="tag this app?"
                        options={[
                            ...PLAYGROUND_TAGS.map((t) => ({
                                value: t as string | null,
                                label: t,
                            })),
                            { value: null, label: "skip", hint: "publish without a tag" },
                        ]}
                        onSelect={(t) => {
                            setTag(t);
                            advance(
                                skipBuild,
                                mode,
                                deployContracts,
                                buildDir,
                                domain,
                                publishToPlayground,
                                moddable,
                                repositoryUrl,
                                t,
                            );
                        }}
                    />
                </Box>
            )}

            {stage.kind === "confirm" && resolved && (
                <ConfirmStage
                    projectDir={projectDir}
                    inputs={resolved}
                    userSigner={userSigner}
                    plan={plan}
                    onProceed={() => setStage({ kind: "running" })}
                    onCancel={() => {
                        onDone(null);
                    }}
                />
            )}

            {resolved &&
                (stage.kind === "running" || stage.kind === "done" || stage.kind === "error") && (
                    <RunningStage
                        projectDir={projectDir}
                        inputs={resolved}
                        suri={suri}
                        playgroundPrivate={playgroundPrivate}
                        userSigner={userSigner}
                        plan={plan}
                        onFinish={(outcome, chunkTimings) => {
                            setStage({ kind: "done", outcome });
                            // Surface completion on the terminal tab so users can glance over.
                            setWindowTitle(`playground deploy · ${resolved.domain} · ✓`);
                            onDone(outcome);
                            // chunkTimings is threaded via ref below — consumed by FinalResult.
                            finalChunkTimingsRef.current = chunkTimings;
                        }}
                        onError={(message) => {
                            setStage({ kind: "error", message });
                            setWindowTitle(`playground deploy · ${resolved.domain} · ✕`);
                            onDone(null);
                        }}
                    />
                )}

            {stage.kind === "done" && (
                <FinalResult outcome={stage.outcome} chunkTimings={finalChunkTimingsRef.current} />
            )}

            {stage.kind === "error" && (
                <Section>
                    <Row mark="fail" label="deploy failed" value={stage.message} tone="danger" />
                </Section>
            )}
        </Box>
    );
}

// ── Stage pickers ────────────────────────────────────────────────────────────

export function pickNextStage(
    skipBuild: boolean | null,
    mode: SignerMode | null,
    deployContracts: boolean | null,
    buildDir: string | null,
    domain: string | null,
    publish: boolean | null,
    moddable: boolean | null,
    repositoryUrl: string | null,
    tag: string | null | undefined,
): Stage {
    if (deployContracts === null) return { kind: "prompt-contracts" };
    const effectiveSkipBuild = deployContracts ? false : skipBuild;
    if (effectiveSkipBuild === null) return { kind: "prompt-build" };
    if (mode === null) return { kind: "prompt-signer" };
    if (buildDir === null) return { kind: "prompt-buildDir" };
    if (domain === null) return { kind: "prompt-domain" };
    if (publish === null) return { kind: "prompt-publish" };
    if (publish && moddable === null) return { kind: "prompt-moddable" };
    // --moddable=true via flag: skip the prompt and drive into the preflight.
    if (publish && moddable === true && repositoryUrl === null) {
        return { kind: "moddable-preflight" };
    }
    // Tag is the last publish-only choice — asked after the moddable decision
    // is fully resolved, and only when no `--tag` flag pre-filled it.
    if (publish && tag === undefined) return { kind: "prompt-tags" };
    return { kind: "confirm" };
}

// ── README acknowledgement ─────────────────────────────────────────────────────

/**
 * First screen of every interactive deploy. Many users don't realise the
 * project README is what renders as their app's detail page in the playground,
 * so we surface it up front: Enter continues into the normal prompt flow, Esc
 * exits cleanly (exit code 0) so they can update the README and re-run.
 */
function AckStage({ onContinue, onExit }: { onContinue: () => void; onExit: () => void }) {
    useInput((_input, key) => {
        if (key.return) onContinue();
        else if (key.escape) onExit();
    });
    return (
        <Box flexDirection="column">
            <Callout tone="accent" title="Your app detail page">
                <Text>
                    Your README.md becomes your app's detail page on the playground. Make sure it's
                    up to date before you publish.
                </Text>
            </Callout>
            <Box marginTop={1}>
                <Hint>{"enter to continue · esc to exit and edit"}</Hint>
            </Box>
        </Box>
    );
}

/**
 * Interstitial shown when the user opts to redeploy contracts. Warns that CDM
 * package names are owned by their first deployer, so a mod (or any project that
 * edited someone else's contracts) must rename before publishing or the deploy
 * fails late. Enter continues; Esc exits the flow gracefully so they can rename.
 */
function ContractsRenameNotice({
    onContinue,
    onExit,
}: {
    onContinue: () => void;
    onExit: () => void;
}) {
    useInput((_input, key) => {
        if (key.return) onContinue();
        else if (key.escape) onExit();
    });
    return (
        <Box flexDirection="column">
            <Callout tone="warning" title={CONTRACTS_RENAME_NOTICE_TITLE}>
                <Text>{CONTRACTS_RENAME_NOTICE_BODY}</Text>
            </Callout>
            <Box marginTop={1}>
                <Hint>{CONTRACTS_RENAME_NOTICE_HINT}</Hint>
            </Box>
        </Box>
    );
}

// ── Domain validation ────────────────────────────────────────────────────────

function ValidateDomainStage({
    domain,
    ownerSs58Address,
    onAvailable,
    onUnavailable,
}: {
    domain: string;
    ownerSs58Address: string | undefined;
    onAvailable: (result: AvailabilityResult & { status: "available" }) => void;
    onUnavailable: (reason: string) => void;
}) {
    const [status, setStatus] = useState<"checking" | "done" | "error">("checking");
    const [message, setMessage] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const result = await checkDomainAvailability(domain, { ownerSs58Address });
                if (cancelled) return;
                if (result.status === "available") {
                    setStatus("done");
                    setMessage(formatAvailability(result));
                    // Short hold so users can read any note (e.g. the PoP
                    // verification advisory) before the next prompt mounts.
                    setTimeout(
                        () => {
                            if (!cancelled) onAvailable(result);
                        },
                        result.note ? 1200 : 300,
                    );
                } else {
                    const reason = formatAvailability(result);
                    setStatus("error");
                    setMessage(reason);
                    setTimeout(() => {
                        if (!cancelled) onUnavailable(reason);
                    }, 600);
                }
            } catch (err) {
                if (cancelled) return;
                const msg = err instanceof Error ? err.message : String(err);
                setStatus("error");
                setMessage(`availability check failed: ${msg}`);
                setTimeout(() => {
                    if (!cancelled) onUnavailable(msg);
                }, 600);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [domain]);

    const mark: MarkKind = status === "checking" ? "run" : status === "done" ? "ok" : "fail";
    const label = status === "checking" ? `checking ${domain}` : (message ?? "");
    return (
        <Section>
            <Row mark={mark} label={label} tone={status === "error" ? "danger" : "muted"} />
        </Section>
    );
}

// ── Confirm stage ────────────────────────────────────────────────────────────

function ConfirmStage({
    projectDir,
    inputs,
    userSigner,
    plan,
    onProceed,
    onCancel,
}: {
    projectDir: string;
    inputs: Resolved;
    userSigner: ResolvedSigner | null;
    plan: DeployPlan | null;
    onProceed: () => void;
    onCancel: () => void;
}) {
    const setup = useMemo(() => {
        try {
            return resolveSignerSetup({
                mode: inputs.mode,
                userSigner,
                publishToPlayground: inputs.publishToPlayground,
                plan: plan ?? undefined,
            });
        } catch (err) {
            return {
                approvals: [] as DeployApproval[],
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }, [inputs, userSigner, plan]);

    // Only warn on the oversized branch — silent when README is absent or
    // within the cap, per the product decision to inline tacitly and speak
    // up only when we're dropping content the user expected to ship.
    const oversizedReadme = useMemo(() => {
        if (!inputs.publishToPlayground) return null;
        const status = readReadme(projectDir);
        return status.kind === "oversized" ? status : null;
    }, [projectDir, inputs.publishToPlayground]);

    const view = buildSummaryView({
        mode: inputs.mode,
        domain: normalizeDomain(inputs.domain, getEnvTld()).fullDomain,
        buildDir: inputs.buildDir,
        skipBuild: inputs.skipBuild,
        deployContracts: inputs.deployContracts,
        publishToPlayground: inputs.publishToPlayground,
        moddable: inputs.moddable,
        repositoryUrl: inputs.repositoryUrl,
        tag: inputs.tag,
        approvals: "approvals" in setup ? setup.approvals : [],
        // What we show in the "Signer" row reflects who actually submits
        // the on-chain txs, which is mostly setup.publishSigner — that's
        // either the user's session (phone mode), the user's SURI account
        // (dev + --suri), or a synthesised Alice for dev + session / pure
        // dev. For non-playground deploys we fall back to userSigner.
        signerAddress:
            "publishSigner" in setup && setup.publishSigner
                ? setup.publishSigner.address
                : inputs.mode === "phone" || userSigner?.source === "dev"
                  ? userSigner?.address
                  : undefined,
        claimedOwnerH160: "claimedOwnerH160" in setup ? setup.claimedOwnerH160 : undefined,
    });

    useInput((_input, key) => {
        if (key.return) onProceed();
        if (key.escape) onCancel();
    });

    return (
        <Box flexDirection="column">
            <Section title={view.headline.toLowerCase()}>
                {view.rows.map((row) => (
                    <Row
                        key={row.label}
                        label={row.label.toLowerCase()}
                        value={row.value}
                        tone="default"
                    />
                ))}
            </Section>

            <Section>
                {view.totalApprovals === 0 ? (
                    <Row label="phone approvals" value="none" tone="muted" />
                ) : (
                    <>
                        <Row
                            label="phone approvals"
                            value={`${view.totalApprovals} expected`}
                            tone="accent"
                        />
                        {view.approvalLines.map((line) => (
                            <Hint key={line} indent={2}>
                                {line}
                            </Hint>
                        ))}
                        {view.approvalHint && <Hint indent={2}>({view.approvalHint})</Hint>}
                    </>
                )}
            </Section>

            {oversizedReadme && (
                <Callout tone="warning" title="README Will Not Be Uploaded">
                    <Text>
                        README.md is {formatKbCeil(oversizedReadme.size)} — over the{" "}
                        {README_CAP_BYTES / 1024} KB limit. the rest of the deploy will continue
                        without it.
                    </Text>
                </Callout>
            )}

            <Hint>{"enter to deploy  ·  esc to cancel"}</Hint>

            {"error" in setup && setup.error && (
                <Callout tone="warning">
                    <Text>{setup.error}</Text>
                </Callout>
            )}
        </Box>
    );
}

// ── Running stage ────────────────────────────────────────────────────────────

function stepMark(status: StepStatus): MarkKind {
    switch (status) {
        case "complete":
            return "ok";
        case "running":
            return "run";
        case "error":
            return "fail";
        default:
            return "idle";
    }
}

function RunningStage({
    projectDir,
    inputs,
    suri,
    playgroundPrivate,
    userSigner,
    plan,
    onFinish,
    onError,
}: {
    projectDir: string;
    inputs: Resolved;
    suri?: string;
    playgroundPrivate: boolean;
    userSigner: ResolvedSigner | null;
    plan: DeployPlan | null;
    onFinish: (outcome: DeployOutcome, chunkTimings: number[]) => void;
    onError: (message: string) => void;
}) {
    const [runningState, setRunningState] = useState(() =>
        initialRunningState({
            skipBuild: inputs.skipBuild,
            publishToPlayground: inputs.publishToPlayground,
        }),
    );
    const frontendState = runningState.frontend;
    const playgroundState = runningState.playground;
    const [activeView, setActiveView] = useState<"contracts" | "frontend">(
        inputs.deployContracts ? "contracts" : "frontend",
    );
    const chainConfig = useMemo(() => getChainConfig(), []);
    const contractDeployDisplay = useMemo(() => {
        if (!inputs.deployContracts) return { crates: [], displayNames: new Map<string, string>() };
        try {
            return precomputeContractDeployDisplay(projectDir, undefined);
        } catch {
            return { crates: [], displayNames: new Map<string, string>() };
        }
    }, [inputs.deployContracts, projectDir]);
    const [contractDeployAdapter] = useState(
        () =>
            new ContractPipelineStatusAdapter({
                onCdmPackageDetected: (crate, pkg) =>
                    contractDeployDisplay.displayNames.set(crate, pkg),
            }),
    );
    const [contractInstallAdapter] = useState(() => new ContractInstallStatusAdapter());
    const [contractInstallLibraries, setContractInstallLibraries] = useState<string[]>([]);
    const [signingPrompt, setSigningPrompt] = useState<SigningEvent | null>(null);
    // Heads-up rendered from the moment the run starts until the first real
    // sign-request arrives — once the PhoneApprovalCallout takes over, the
    // readiness reminder is redundant and stays hidden for the rest of the run.
    const [showPhoneNotice, setShowPhoneNotice] = useState(inputs.mode === "phone");

    // Per-chunk timing for the sparkline on completion. Held in refs to avoid
    // re-renders on every chunk tick.
    const chunkTimingsRef = useRef<number[]>([]);
    const lastChunkAtRef = useRef<number | null>(null);

    // Flush each section's latest-line row at ≤10 Hz — see CLAUDE.md
    // "Throttle TUI info updates" for the incident that made this mandatory.
    const INFO_THROTTLE_MS = 100;
    const INFO_MAX_LEN = 160;
    const frontendPendingRef = useRef<string | null>(null);
    const frontendTimerRef = useRef<NodeJS.Timeout | null>(null);
    const queueFrontendLog = (line: string) => {
        const truncated = line.length > INFO_MAX_LEN ? `${line.slice(0, INFO_MAX_LEN - 1)}…` : line;
        frontendPendingRef.current = truncated;
        if (frontendTimerRef.current === null) {
            frontendTimerRef.current = setTimeout(() => {
                if (frontendPendingRef.current !== null) {
                    const v = frontendPendingRef.current;
                    frontendPendingRef.current = null;
                    setRunningState((s) => ({
                        ...s,
                        frontend: { ...s.frontend, latestLog: v },
                    }));
                }
                frontendTimerRef.current = null;
            }, INFO_THROTTLE_MS);
        }
    };

    useEffect(() => {
        // Announce the command + target in the terminal tab on mount.
        setWindowTitle(
            `playground deploy · ${inputs.domain} · ${
                inputs.deployContracts ? "contracts" : "building"
            }`,
        );

        let cancelled = false;
        let runningContracts = false;

        (async () => {
            try {
                if (inputs.deployContracts) {
                    runningContracts = true;
                    setActiveView("contracts");
                    const { runContractsBeforeFrontend } = await import("./contracts.js");
                    await runContractsBeforeFrontend({
                        projectDir,
                        mode: inputs.mode,
                        suri,
                        userSigner,
                        onDeployEvent: handleContractDeployEvent,
                        onInstallEvent: handleContractInstallEvent,
                        onSigningEvent: handleSigningEvent,
                    });
                    runningContracts = false;
                    if (cancelled) return;
                    setActiveView("frontend");
                }

                const { runDeploy } = await import("../../utils/deploy/run.js");
                const outcome = await runDeploy({
                    projectDir,
                    buildDir: inputs.buildDir,
                    skipBuild: inputs.skipBuild,
                    domain: inputs.domain,
                    mode: inputs.mode,
                    publishToPlayground: inputs.publishToPlayground,
                    playgroundPrivate,
                    moddable: inputs.moddable,
                    repositoryUrl: inputs.repositoryUrl,
                    tag: inputs.tag,
                    userSigner,
                    plan: plan ?? undefined,
                    onEvent: (event) => handleEvent(event),
                });
                if (!cancelled) {
                    // RunningStage stays mounted through "done"/"error", so
                    // clear the readiness notice in case no sign-request fired.
                    setShowPhoneNotice(false);
                    onFinish(outcome, chunkTimingsRef.current);
                }
            } catch (err) {
                if (!cancelled) {
                    const message = err instanceof Error ? err.message : String(err);
                    if (runningContracts) contractDeployAdapter.setRunError(message);
                    setShowPhoneNotice(false);
                    onError(message);
                }
            }
        })();

        function handleSigningEvent(event: SigningEvent) {
            if (runningContracts) {
                if (event.kind === "sign-request") setShowPhoneNotice(false);
                contractDeployAdapter.handleSigningEvent(event);
                return;
            }
            if (event.kind === "sign-request") {
                setShowPhoneNotice(false);
                setSigningPrompt(event);
            } else if (event.kind === "sign-complete") {
                setSigningPrompt(null);
            } else if (event.kind === "sign-error") {
                setSigningPrompt(null);
            }
        }

        function handleContractDeployEvent(event: ContractDeployEvent) {
            contractDeployAdapter.handleDeployEvent(event);
        }

        function handleContractInstallEvent(event: ContractInstallEvent) {
            contractInstallAdapter.handleEvent(event);
            if ("library" in event) {
                setContractInstallLibraries((libraries) =>
                    libraries.includes(event.library) ? libraries : [...libraries, event.library],
                );
            }
        }

        function handleEvent(event: DeployEvent) {
            setRunningState((s) => runningReducer(s, event));
            if (event.kind === "phase-start") {
                if (event.phase === "build") {
                    setWindowTitle(`playground deploy · ${inputs.domain} · building`);
                } else if (event.phase === "storage-and-dotns") {
                    setWindowTitle(`playground deploy · ${inputs.domain} · uploading`);
                } else if (event.phase === "playground") {
                    setWindowTitle(`playground deploy · ${inputs.domain} · publishing`);
                }
            } else if (event.kind === "build-log") {
                queueFrontendLog(event.line);
            } else if (event.kind === "build-detected") {
                queueFrontendLog(`> ${event.config.description}`);
            } else if (event.kind === "storage-event") {
                if (event.event.kind === "chunk-progress") {
                    const now = performance.now();
                    const last = lastChunkAtRef.current;
                    if (last !== null) {
                        chunkTimingsRef.current.push(now - last);
                    }
                    lastChunkAtRef.current = now;
                    queueFrontendLog(`uploading chunk ${event.event.current}/${event.event.total}`);
                } else if (event.event.kind === "info") {
                    queueFrontendLog(event.event.message);
                }
            } else if (event.kind === "signing") {
                handleSigningEvent(event.event);
                if (event.event.kind === "sign-error") {
                    queueFrontendLog(`signing failed: ${event.event.message}`);
                }
            }
        }

        return () => {
            cancelled = true;
            if (frontendTimerRef.current !== null) {
                clearTimeout(frontendTimerRef.current);
                frontendTimerRef.current = null;
            }
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const showFrontendView = activeView === "frontend";

    return (
        <Box flexDirection="column">
            {showPhoneNotice && (
                <Callout tone="warning" title="Keep Your Phone Ready">
                    <Text>This deploy may ask you to approve transactions in your mobile app.</Text>
                </Callout>
            )}
            {inputs.deployContracts && (
                <Box flexDirection="column">
                    <Section
                        title="contract deploy"
                        gapBelow={contractInstallLibraries.length === 0}
                    >
                        <ContractDeployStatusView
                            adapter={contractDeployAdapter}
                            crates={contractDeployDisplay.crates}
                            displayNames={contractDeployDisplay.displayNames}
                            assethubUrl={chainConfig.assetHubRpc}
                            ipfsGatewayUrl={chainConfig.bulletinGateway}
                        />
                    </Section>
                    {contractInstallLibraries.length > 0 && (
                        <Section title="contract install" gapBelow={showFrontendView}>
                            <ContractInstallStatusView
                                adapter={contractInstallAdapter}
                                libraries={contractInstallLibraries}
                                ipfsGatewayUrl={chainConfig.bulletinGateway}
                            />
                        </Section>
                    )}
                </Box>
            )}
            {showFrontendView && (
                <>
                    <FrontendSectionView state={frontendState} />
                    {playgroundState.status !== "skipped" && (
                        <Box marginTop={1}>
                            <Row
                                mark={stepMark(playgroundState.status)}
                                label="publish to playground"
                                tone={playgroundState.status === "error" ? "danger" : "muted"}
                            />
                        </Box>
                    )}

                    {signingPrompt && signingPrompt.kind === "sign-request" && (
                        <PhoneApprovalCallout
                            step={signingPrompt.step}
                            label={signingPrompt.label}
                        />
                    )}
                </>
            )}
        </Box>
    );
}

function FrontendSectionView({ state }: { state: FrontendSectionState }) {
    const running = state.buildStatus === "running" || state.uploadStatus === "running";
    return (
        <Section title="frontend" gapBelow={false}>
            <Row
                mark={stepMark(state.buildStatus)}
                label="build"
                value={state.buildStatus === "skipped" ? "skipped" : undefined}
                tone={state.buildStatus === "error" ? "danger" : "muted"}
            />
            <Row
                mark={stepMark(state.uploadStatus)}
                label="upload + dotns"
                tone={state.uploadStatus === "error" ? "danger" : "muted"}
            />
            {running && state.latestLog && <Hint indent={2}>{truncate(state.latestLog, 120)}</Hint>}
        </Section>
    );
}

// ── Final result ─────────────────────────────────────────────────────────────

function FinalResult({
    outcome,
    chunkTimings,
}: {
    outcome: DeployOutcome;
    chunkTimings: number[];
}) {
    return (
        <Box flexDirection="column" marginTop={1}>
            <Row mark="ok" label="deploy complete" tone="default" />

            <Box marginTop={1}>
                <Section gapBelow={false}>
                    <Row label="url" value={outcome.appUrl} />
                    <Row label="domain" value={outcome.fullDomain} />
                    <Row label="app cid" value={outcome.appCid} />
                    {outcome.ipfsCid && <Row label="ipfs cid" value={outcome.ipfsCid} />}
                    {outcome.metadataCid && (
                        <Row label="metadata cid" value={outcome.metadataCid} />
                    )}
                </Section>
            </Box>

            {chunkTimings.length > 0 && (
                <Box paddingLeft={2} flexDirection="row">
                    <Text>{"chunks".padEnd(14)}</Text>
                    <Sparkline values={chunkTimings} width={16} />
                    <Text dimColor>
                        {`  ${chunkTimings.length + 1} chunks  ·  avg ${(
                            average(chunkTimings) / 1000
                        ).toFixed(2)}s/chunk`}
                    </Text>
                </Box>
            )}
        </Box>
    );
}

function truncate(s: string, n: number): string {
    return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function average(xs: number[]): number {
    if (xs.length === 0) return 0;
    return xs.reduce((a, b) => a + b, 0) / xs.length;
}

// Round UP to the nearest 0.1 KB when displaying an oversized file, so a
// file 1 byte over a round-number cap never reads as "20.0 KB — over the
// 20 KB limit". Worst case we overstate by ~100 bytes, which is fine in a
// warning already saying the file is being dropped.
function formatKbCeil(bytes: number): string {
    const tenths = Math.ceil((bytes / 1024) * 10) / 10;
    return `${tenths.toFixed(1)} KB`;
}
