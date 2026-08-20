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
 * Interactive TUI for `dot decentralize`. The state-machine in `state.ts`
 * decides which prompt to show next; this file only wires the prompts to
 * `runDecentralize` and renders the live progress + final summary.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text } from "ink";
import {
    Callout,
    Header,
    Hint,
    Input,
    type MarkKind,
    PromptInfo,
    Row,
    Section,
    Select,
} from "../../utils/ui/theme/index.js";
import { PhoneApprovalCallout } from "../../utils/ui/theme/PhoneApprovalCallout.js";
import { getEnvTld, getNetworkLabel, type Env } from "../../config.js";
import { VERSION_LABEL } from "../../utils/version.js";
import type { ResolvedSigner } from "../../utils/signer.js";
import { createDevPublishSigner, type SignerMode } from "../../utils/deploy/signerMode.js";
import {
    DEV_SIGNER_NO_XP_TITLE,
    DEV_SIGNER_NO_XP_BODY,
    shouldShowDevNoXpWarning,
} from "../deploy/signerNotice.js";
import { SIGNER_HELP, DOMAIN_HELP, PUBLISH_HELP, TAGS_HELP } from "../deploy/promptHelp.js";
import { PLAYGROUND_TAGS } from "../../utils/deploy/tags.js";
import { decentralizeSignerOptions, decentralizeSignerInitialIndex } from "./signerPrompt.js";
import type { SigningEvent } from "../../utils/deploy/signingProxy.js";
import { resolveDomain } from "../../utils/decentralize/domain.js";
import { prepareLocalDirectory, type LocalSiteResult } from "../../utils/decentralize/local.js";
import { FREE_DOMAIN_SUFFIX_NOTE } from "../../utils/decentralize/randomName.js";
import {
    describeDeployEvent,
    LARGE_SITE_FILE_THRESHOLD,
    runDecentralize,
    type DecentralizeOutcome,
    type DecentralizeSource,
} from "../../utils/decentralize/run.js";
import { ModdableErrorStage, ModdablePreflightStage } from "../deploy/ModdableStages.js";
import {
    pickNextStage,
    validateDomainInput,
    validateLocalPathInput,
    validateSiteUrlInput,
    type SourceKind,
    type Stage,
} from "./state.js";

/**
 * What the screen reports back when it unmounts. The host (`runInteractive`)
 * maps each variant to an exit code: `success` and `cancel` resolve cleanly
 * (exit 0); `error` rejects so telemetry records the failure (exit 1). The
 * TUI itself has already rendered any user-visible message before this fires
 * — `runInteractive` never re-prints.
 */
export type DecentralizeResult =
    | { kind: "success"; outcome: DecentralizeOutcome }
    | { kind: "cancel" }
    | { kind: "error"; message: string };

export interface DecentralizeScreenProps {
    env: Env;
    initialSiteUrl: string | null;
    initialDot: string | null;
    /** `--suri` resolved up front. When set, the signer picker is skipped. */
    explicitSigner: ResolvedSigner | null;
    /** Session signer from `dot login`, if any. Picked when "phone" is selected. */
    sessionSigner: ResolvedSigner | null;
    /**
     * Pre-set when `--playground` was passed on the CLI. `null` means the
     * publish prompt is shown.
     */
    initialPublishToPlayground: boolean | null;
    /**
     * Pre-set to the `--tag` value when passed (skips the tag prompt).
     * `undefined` means the tag prompt is shown when publishing.
     */
    initialTag?: string;
    /**
     * Pre-set when `--moddable` was passed on the CLI: skips the moddable
     * prompt and drives straight into the git-origin preflight (only if the
     * user ends up in the path + publish flow — URL mode ignores it). `null`
     * means the prompt is shown.
     */
    initialModdable: boolean | null;
    onDone: (result: DecentralizeResult) => void;
}

export function DecentralizeScreen({
    env,
    initialSiteUrl,
    initialDot,
    explicitSigner,
    sessionSigner,
    initialPublishToPlayground,
    initialTag,
    initialModdable,
    onDone,
}: DecentralizeScreenProps) {
    // A caller-provided site URL pre-selects the URL flow (vestigial today —
    // `--site` forces headless — but kept so the prop keeps meaning something).
    const [sourceKind, setSourceKind] = useState<SourceKind | null>(initialSiteUrl ? "url" : null);
    const [siteUrl, setSiteUrl] = useState<string | null>(initialSiteUrl);
    const [localPath, setLocalPath] = useState<string | null>(null);
    // Captured at path submit so the confirm screen can show the resolved
    // upload root + file count without re-walking the directory on render.
    const [preparedLocal, setPreparedLocal] = useState<LocalSiteResult | null>(null);
    // If --suri was passed, the user has effectively pre-chosen dev.
    const [signerMode, setSignerMode] = useState<SignerMode | null>(explicitSigner ? "dev" : null);
    // Which signer option the cursor is on in the prompt-signer Select. Drives
    // the "dev signer earns no XP" warning (shown only while dev is highlighted
    // and a session exists). Initialised to match the default cursor position.
    const [highlightedSigner, setHighlightedSigner] = useState<SignerMode>(
        sessionSigner ? "phone" : "dev",
    );
    const [domainRaw, setDomainRaw] = useState<string | null>(initialDot);
    const [domainLabel, setDomainLabel] = useState<string | null>(null);
    const [fullDomain, setFullDomain] = useState<string | null>(null);
    const [autoGenerated, setAutoGenerated] = useState(false);
    const [availabilityNote, setAvailabilityNote] = useState<string | null>(null);
    const [domainError, setDomainError] = useState<string | null>(null);
    const [validationMessage, setValidationMessage] = useState<string | null>(null);
    const [publishToPlayground, setPublishToPlayground] = useState<boolean | null>(
        initialPublishToPlayground,
    );
    // Category tag (tri-state, mirroring deploy): `undefined` = not asked yet,
    // `null` = explicitly skipped, a string = chosen. Pre-filled from `--tag`.
    const [tag, setTag] = useState<string | null | undefined>(initialTag);
    const [moddable, setModdable] = useState<boolean | null>(initialModdable);
    const [repositoryUrl, setRepositoryUrl] = useState<string | null>(null);

    const [stage, setStage] = useState<Stage>(() =>
        pickNextStage({
            sourceKind: initialSiteUrl ? "url" : null,
            siteUrl: initialSiteUrl,
            localPath: null,
            signerMode: explicitSigner ? "dev" : null,
            domainLabel: null,
            domainRaw: initialDot,
            publishToPlayground: initialPublishToPlayground,
            tag: initialTag,
            moddable: initialModdable,
            repositoryUrl: null,
        }),
    );

    const advance = (
        next: Partial<{
            sourceKind: SourceKind | null;
            siteUrl: string | null;
            localPath: string | null;
            signerMode: SignerMode | null;
            domainLabel: string | null;
            domainRaw: string | null;
            publishToPlayground: boolean | null;
            tag: string | null;
            moddable: boolean | null;
            repositoryUrl: string | null;
        }> = {},
    ) => {
        setStage(
            pickNextStage({
                sourceKind: next.sourceKind !== undefined ? next.sourceKind : sourceKind,
                siteUrl: next.siteUrl !== undefined ? next.siteUrl : siteUrl,
                localPath: next.localPath !== undefined ? next.localPath : localPath,
                signerMode: next.signerMode !== undefined ? next.signerMode : signerMode,
                domainLabel: next.domainLabel !== undefined ? next.domainLabel : domainLabel,
                domainRaw: next.domainRaw !== undefined ? next.domainRaw : domainRaw,
                publishToPlayground:
                    next.publishToPlayground !== undefined
                        ? next.publishToPlayground
                        : publishToPlayground,
                // `undefined` is a meaningful tag value ("not asked"), so detect
                // presence with `in` rather than the `!== undefined` sentinel.
                tag: "tag" in next ? next.tag : tag,
                moddable: next.moddable !== undefined ? next.moddable : moddable,
                repositoryUrl:
                    next.repositoryUrl !== undefined ? next.repositoryUrl : repositoryUrl,
            }),
        );
    };

    // Single "user declined moddable" transition, shared by the remix prompt's
    // "no" answer and the setup-error menu's "continue without moddable", so
    // the two paths can't drift apart. Mirrors deploy's helper of the same name.
    const declineModdable = () => {
        setModdable(false);
        advance({ moddable: false });
    };

    // Compose the active signer for downstream stages. Memoised so the
    // ResolvedSigner identity stays stable across re-renders (the dev branch
    // would otherwise produce a fresh `createDevPublishSigner()` instance on
    // every render — fine functionally because `DEV_PUBLISH_ACCOUNT` is
    // module-scope, but it makes downstream effect dependencies look churny).
    const activeSigner = useMemo<ResolvedSigner | null>(() => {
        if (explicitSigner) return explicitSigner;
        if (signerMode === "phone") return sessionSigner;
        if (signerMode === "dev") return createDevPublishSigner();
        return null;
    }, [explicitSigner, signerMode, sessionSigner]);

    // The resolved content source. Null until the picker + matching prompt
    // are answered; stages past prompt-url/prompt-path only mount once set.
    const source = useMemo<DecentralizeSource | null>(() => {
        if (sourceKind === "url" && siteUrl !== null) return { kind: "url", url: siteUrl };
        if (sourceKind === "path" && localPath !== null) {
            return { kind: "path", directory: localPath };
        }
        return null;
    }, [sourceKind, siteUrl, localPath]);

    return (
        <Box flexDirection="column">
            <Header
                cmd="playground decentralize"
                subtitle={fullDomain ?? siteUrl ?? localPath ?? undefined}
                network={getNetworkLabel(env)}
                right={VERSION_LABEL}
            />

            {stage.kind === "prompt-source" && (
                <>
                    <Callout tone="accent" title="About This Command">
                        <Text>
                            Republishes a static site as a DotNS site — either mirrored from a live
                            https URL or uploaded from a local build directory. Press Ctrl+C any
                            time to cancel.
                        </Text>
                    </Callout>
                    <Select<SourceKind>
                        label="source"
                        options={[
                            {
                                value: "url",
                                label: "live site (URL)",
                                hint: "mirror it with wget — large sites can take minutes",
                            },
                            {
                                value: "path",
                                label: "local directory",
                                hint: "upload an already-built static site, e.g. ./dist",
                            },
                        ]}
                        onSelect={(kind) => {
                            setSourceKind(kind);
                            advance({ sourceKind: kind });
                        }}
                    />
                </>
            )}

            {stage.kind === "prompt-url" && (
                <Input
                    label="site URL"
                    placeholder="example.com or https://you.github.io/site"
                    validate={validateSiteUrlInput}
                    onSubmit={(value) => {
                        setSiteUrl(value);
                        advance({ siteUrl: value });
                    }}
                />
            )}

            {stage.kind === "prompt-path" && (
                <>
                    <Hint indent={2}>
                        The directory must contain an index.html — a built static site like ./dist.
                        Files upload as-is (no build step runs).
                    </Hint>
                    <Input
                        label="directory"
                        placeholder="./dist"
                        validate={validateLocalPathInput}
                        onSubmit={(value) => {
                            // validate just accepted this path, so the second
                            // walk can't throw; it returns the resolved upload
                            // root + file count for the confirm screen.
                            setPreparedLocal(prepareLocalDirectory(value));
                            setLocalPath(value);
                            advance({ localPath: value });
                        }}
                    />
                </>
            )}

            {stage.kind === "prompt-signer" && (
                <Box flexDirection="column">
                    <PromptInfo box={SIGNER_HELP} />
                    <Select<SignerMode>
                        label="signer"
                        options={decentralizeSignerOptions(sessionSigner != null)}
                        initialIndex={decentralizeSignerInitialIndex(sessionSigner != null)}
                        onHighlight={setHighlightedSigner}
                        onSelect={(mode) => {
                            if (mode === "phone" && !sessionSigner) {
                                setStage({
                                    kind: "error",
                                    message:
                                        'No session found — run "playground login" to log in, then re-run, or pick the dev signer.',
                                });
                                return;
                            }
                            setSignerMode(mode);
                            advance({ signerMode: mode });
                        }}
                    />
                    {/* Below the options (mirroring the phone-approval notices)
                        and only while the dev option is highlighted with a
                        session present, so the "no XP" trade-off shows exactly
                        when the user is about to pick the dev signer. */}
                    {shouldShowDevNoXpWarning(sessionSigner != null, highlightedSigner) && (
                        <Callout tone="warning" title={DEV_SIGNER_NO_XP_TITLE}>
                            <Text>{DEV_SIGNER_NO_XP_BODY}</Text>
                        </Callout>
                    )}
                </Box>
            )}

            {stage.kind === "prompt-domain" && (
                <Box flexDirection="column">
                    <PromptInfo box={DOMAIN_HELP} />
                    <Input
                        label="domain"
                        placeholder={
                            sourceKind === "path"
                                ? "leave blank to auto-generate from the directory name"
                                : "leave blank to auto-generate from the URL"
                        }
                        prefill={domainRaw ?? ""}
                        externalError={domainError}
                        validate={(raw) => validateDomainInput(raw, getEnvTld(env))}
                        onSubmit={(value) => {
                            setDomainError(null);
                            setDomainRaw(value);
                            advance({ domainRaw: value });
                        }}
                    />
                </Box>
            )}

            {stage.kind === "validate-domain" && (
                <ValidateDomainStage
                    raw={stage.raw}
                    env={env}
                    source={source!}
                    signer={activeSigner}
                    onResolved={({ label, fullDomain: full, note, autoGenerated: auto }) => {
                        setDomainLabel(label);
                        setFullDomain(full);
                        setAutoGenerated(auto);
                        setAvailabilityNote(note);
                        setValidationMessage(null);
                        advance({ domainLabel: label });
                    }}
                    onFailed={(message) => {
                        setDomainError(message);
                        setDomainLabel(null);
                        setValidationMessage(null);
                        // Re-prompt: clear domainRaw so prompt-domain reopens.
                        setDomainRaw(null);
                        setStage({ kind: "prompt-domain" });
                    }}
                    onProgress={(message) => setValidationMessage(message)}
                    progressMessage={validationMessage}
                />
            )}

            {stage.kind === "prompt-publish" && (
                <Box flexDirection="column">
                    <PromptInfo box={PUBLISH_HELP} />
                    {sourceKind === "path" && (
                        <Callout tone="accent" title="Your app detail page">
                            <Text>
                                If you publish, your project's README.md becomes your app's detail
                                page on the playground (found at your repo root, even when --path is
                                a build dir like ./dist). Make sure it's up to date.
                            </Text>
                        </Callout>
                    )}
                    <Select<boolean>
                        label="publish to the playground registry?"
                        options={[
                            {
                                value: true,
                                label: "yes",
                                hint: "list the site in the playground apps tab",
                            },
                            {
                                value: false,
                                label: "no",
                                hint: `just register the .${getEnvTld(env)} name (DotNS only)`,
                            },
                        ]}
                        initialIndex={0}
                        onSelect={(choice) => {
                            setPublishToPlayground(choice);
                            advance({ publishToPlayground: choice });
                        }}
                    />
                </Box>
            )}

            {stage.kind === "prompt-moddable" && (
                <Select<boolean>
                    label="let others remix (mod) this app?"
                    options={[
                        {
                            value: true,
                            label: "yes",
                            hint: "record my public GitHub repo so others can `playground mod` it",
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
                            advance({ tag: t });
                        }}
                    />
                </Box>
            )}

            {stage.kind === "moddable-preflight" && (
                <ModdablePreflightStage
                    // git resolves `origin` from any subdirectory of the repo,
                    // so the typed path works even when it's a build output dir.
                    projectDir={localPath!}
                    onResolved={(url) => {
                        setRepositoryUrl(url);
                        advance({ moddable: true, repositoryUrl: url });
                    }}
                    onError={(msg) => setStage({ kind: "moddable-error", message: msg })}
                />
            )}

            {stage.kind === "moddable-error" && (
                <ModdableErrorStage
                    message={stage.message}
                    onContinueWithoutModdable={declineModdable}
                    onExit={() => onDone({ kind: "cancel" })}
                />
            )}

            {stage.kind === "confirm" && (
                <ConfirmStage
                    source={source!}
                    preparedLocal={preparedLocal}
                    fullDomain={fullDomain!}
                    autoGenerated={autoGenerated}
                    availabilityNote={availabilityNote}
                    signer={activeSigner!}
                    signerMode={signerMode!}
                    publishToPlayground={publishToPlayground === true}
                    tag={publishToPlayground === true ? (tag ?? null) : null}
                    repositoryUrl={repositoryUrl}
                    onConfirm={() => setStage({ kind: "running" })}
                    onCancel={() => onDone({ kind: "cancel" })}
                />
            )}

            {stage.kind === "running" && (
                <RunningStage
                    source={source!}
                    label={domainLabel!}
                    fullDomain={fullDomain!}
                    mode={signerMode!}
                    userSigner={explicitSigner ?? sessionSigner}
                    publishToPlayground={publishToPlayground === true}
                    tag={publishToPlayground === true ? (tag ?? null) : null}
                    repositoryUrl={repositoryUrl}
                    env={env}
                    onComplete={(outcome) => setStage({ kind: "done", outcome })}
                    onFailed={(message) => setStage({ kind: "error", message })}
                />
            )}

            {stage.kind === "done" && (
                <DoneStage
                    outcome={stage.outcome}
                    onExit={() => onDone({ kind: "success", outcome: stage.outcome })}
                />
            )}

            {stage.kind === "error" && (
                <ErrorStage
                    message={stage.message}
                    onExit={() => onDone({ kind: "error", message: stage.message })}
                />
            )}
        </Box>
    );
}

// ── Validate-domain stage ────────────────────────────────────────────────────

function ValidateDomainStage({
    raw,
    env,
    source,
    signer,
    progressMessage,
    onResolved,
    onFailed,
    onProgress,
}: {
    raw: string;
    env: Env;
    source: DecentralizeSource;
    signer: ResolvedSigner | null;
    progressMessage: string | null;
    onResolved: (result: {
        label: string;
        fullDomain: string;
        note: string | null;
        autoGenerated: boolean;
    }) => void;
    onFailed: (message: string) => void;
    onProgress: (message: string) => void;
}) {
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const result = await resolveDomain({
                    env,
                    providedDot: raw || null,
                    source,
                    signer,
                    onMessage: (m) => {
                        if (!cancelled) onProgress(m.trim());
                    },
                });
                if (!cancelled) onResolved(result);
            } catch (err) {
                if (!cancelled) onFailed(err instanceof Error ? err.message : String(err));
            }
        })();
        return () => {
            cancelled = true;
        };
        // We intentionally key on `raw` only — `signer`/`source` are stable
        // for the lifetime of a single validate stage.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [raw]);

    return (
        <Box flexDirection="column">
            <Row
                mark="run"
                label={progressMessage ?? `checking ${raw || "auto-generated name"}…`}
            />
        </Box>
    );
}

// ── Confirm stage ────────────────────────────────────────────────────────────

function ConfirmStage({
    source,
    preparedLocal,
    fullDomain,
    autoGenerated,
    availabilityNote,
    signer,
    signerMode,
    publishToPlayground,
    tag,
    repositoryUrl,
    onConfirm,
    onCancel,
}: {
    source: DecentralizeSource;
    /** Set when `source.kind === "path"` — resolved upload root + file count. */
    preparedLocal: LocalSiteResult | null;
    fullDomain: string;
    autoGenerated: boolean;
    availabilityNote: string | null;
    signer: ResolvedSigner;
    signerMode: SignerMode;
    publishToPlayground: boolean;
    tag: string | null;
    /** Resolved public GitHub URL when moddable was accepted; null otherwise. */
    repositoryUrl: string | null;
    onConfirm: () => void;
    onCancel: () => void;
}) {
    const steps = source.kind === "url" ? "mirror + upload + register" : "upload + register";
    // For local dirs the file count is known up front — reuse the mirror
    // flow's threshold to flag a long upload before the user commits.
    const largeLocal =
        source.kind === "path" &&
        preparedLocal !== null &&
        preparedLocal.fileCount >= LARGE_SITE_FILE_THRESHOLD;
    return (
        <Box flexDirection="column">
            <Section title={`decentralizing ${fullDomain}`}>
                {source.kind === "url" ? (
                    <Row label="site" value={source.url} />
                ) : (
                    <Row
                        label="path"
                        // Show the resolved upload root, not the typed path —
                        // when index.html sits in a subdirectory, this is what
                        // actually uploads and the user should see it here.
                        value={
                            preparedLocal
                                ? `${preparedLocal.uploadRoot} (${preparedLocal.fileCount} files)`
                                : source.directory
                        }
                    />
                )}
                <Row label="domain" value={`${fullDomain}.li`} />
                <Row
                    label="signer"
                    value={`${signerMode} · ${signer.address}`}
                    tone={signerMode === "phone" ? "accent" : "default"}
                />
                <Row
                    label="playground"
                    value={publishToPlayground ? "publish to apps tab" : "skip"}
                    tone={publishToPlayground ? "accent" : "muted"}
                />
                {source.kind === "path" && publishToPlayground && (
                    <Row
                        label="moddable"
                        value={repositoryUrl ? `yes · ${repositoryUrl}` : "no"}
                        tone={repositoryUrl ? "accent" : "muted"}
                    />
                )}
                {/* Surface the chosen tag before the irreversible publish, like
                    deploy's confirm summary. Only shown when publishing — the
                    tag is otherwise irrelevant. */}
                {publishToPlayground && (
                    <Row label="tag" value={tag ?? "none"} tone={tag ? "accent" : "muted"} />
                )}
                {availabilityNote && <Row label="note" value={availabilityNote} tone="warning" />}
                {largeLocal && (
                    <Row
                        label="note"
                        value={`${preparedLocal!.fileCount} files — the upload may take a while`}
                        tone="warning"
                    />
                )}
            </Section>
            {autoGenerated && <Hint indent={2}>{FREE_DOMAIN_SUFFIX_NOTE}</Hint>}
            <Select<"go" | "cancel">
                label="proceed?"
                options={[
                    {
                        value: "go",
                        label: "yes, decentralize it",
                        hint: publishToPlayground ? `${steps} + publish` : steps,
                    },
                    { value: "cancel", label: "cancel", hint: "exit without changes" },
                ]}
                onSelect={(choice) => (choice === "go" ? onConfirm() : onCancel())}
            />
        </Box>
    );
}

// ── Running stage ────────────────────────────────────────────────────────────

type StepStatus = "idle" | "running" | "complete";

function stepMark(status: StepStatus): MarkKind {
    switch (status) {
        case "complete":
            return "ok";
        case "running":
            return "run";
        default:
            return "idle";
    }
}

function RunningStage({
    source,
    label,
    fullDomain,
    mode,
    userSigner,
    publishToPlayground,
    tag,
    repositoryUrl,
    env,
    onComplete,
    onFailed,
}: {
    source: DecentralizeSource;
    label: string;
    fullDomain: string;
    mode: SignerMode;
    userSigner: ResolvedSigner | null;
    publishToPlayground: boolean;
    tag: string | null;
    /** Preflighted public GitHub URL when moddable was accepted; null otherwise. */
    repositoryUrl: string | null;
    env: Env;
    onComplete: (outcome: DecentralizeOutcome) => void;
    onFailed: (message: string) => void;
}) {
    const [mirrorStatus, setMirrorStatus] = useState<StepStatus>("running");
    const [uploadStatus, setUploadStatus] = useState<StepStatus>("idle");
    const [playgroundStatus, setPlaygroundStatus] = useState<StepStatus>("idle");
    const [latestLog, setLatestLog] = useState<string | null>(null);
    // Set once when the mirror crosses the large-site threshold so the warning
    // persists for the rest of the download (a transient log line would scroll
    // off). Reminds the user the download is large and Ctrl+C cancels.
    const [largeSite, setLargeSite] = useState(false);
    // Active "check your phone" prompt — set on sign-request, cleared on
    // sign-complete / sign-error. Only ever populated in phone mode.
    const [signingPrompt, setSigningPrompt] = useState<SigningEvent | null>(null);

    // Throttle the latest-log line to ≤10 Hz. polkadot-app-deploy emits per-chunk
    // events in bursts; setState-per-event floods Ink's reconciler (see
    // CLAUDE.md "Throttle TUI info updates"). We keep only the most recent
    // line — it's a status indicator, not a scrollback.
    const pendingRef = useRef<string | null>(null);
    const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const queueLog = (line: string) => {
        pendingRef.current = line.length > 160 ? `${line.slice(0, 159)}…` : line;
        if (flushTimer.current) return;
        flushTimer.current = setTimeout(() => {
            if (pendingRef.current !== null) {
                setLatestLog(pendingRef.current);
                pendingRef.current = null;
            }
            flushTimer.current = null;
        }, 100);
    };

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const outcome = await runDecentralize({
                    source,
                    label,
                    fullDomain,
                    mode,
                    userSigner,
                    publishToPlayground,
                    tag,
                    repositoryUrl,
                    env,
                    onEvent: (event) => {
                        switch (event.kind) {
                            case "mirror-start":
                                setMirrorStatus("running");
                                queueLog(`mirroring ${event.url}`);
                                break;
                            case "mirror-line":
                                queueLog(event.line);
                                break;
                            case "mirror-large":
                                setLargeSite(true);
                                break;
                            case "mirror-done":
                                setMirrorStatus("complete");
                                setUploadStatus("running");
                                queueLog(`mirrored ${event.fileCount} files`);
                                break;
                            case "local-done":
                                setMirrorStatus("complete");
                                setUploadStatus("running");
                                queueLog(`prepared ${event.fileCount} files`);
                                break;
                            case "storage-start":
                                setUploadStatus("running");
                                break;
                            case "storage-event": {
                                const line = describeDeployEvent(event.event);
                                if (line) queueLog(line);
                                break;
                            }
                            case "storage-done":
                                setUploadStatus("complete");
                                queueLog(`registered ${fullDomain}`);
                                break;
                            case "playground-start":
                                setPlaygroundStatus("running");
                                break;
                            case "playground-event": {
                                const line = describeDeployEvent(event.event);
                                if (line) queueLog(line);
                                break;
                            }
                            case "playground-done":
                                setPlaygroundStatus("complete");
                                break;
                            case "signing":
                                if (event.event.kind === "sign-request") {
                                    setSigningPrompt(event.event);
                                } else if (event.event.kind === "sign-complete") {
                                    setSigningPrompt(null);
                                } else if (event.event.kind === "sign-error") {
                                    setSigningPrompt(null);
                                    queueLog(`signing failed: ${event.event.message}`);
                                }
                                break;
                        }
                    },
                });
                if (!cancelled) onComplete(outcome);
            } catch (err) {
                if (!cancelled) onFailed(err instanceof Error ? err.message : String(err));
            }
        })();
        return () => {
            cancelled = true;
            if (flushTimer.current) {
                clearTimeout(flushTimer.current);
                flushTimer.current = null;
            }
        };
        // The pipeline is keyed on the inputs frozen at confirm time; we
        // never re-run it within a single mount.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const running =
        mirrorStatus === "running" || uploadStatus === "running" || playgroundStatus === "running";

    return (
        <Box flexDirection="column">
            <Section title={`decentralizing ${fullDomain}`} gapBelow={false}>
                <Row
                    mark={stepMark(mirrorStatus)}
                    label={source.kind === "url" ? "mirror" : "prepare"}
                    tone="muted"
                />
                <Row mark={stepMark(uploadStatus)} label="upload + dotns" tone="muted" />
                {publishToPlayground && (
                    <Row
                        mark={stepMark(playgroundStatus)}
                        label="publish to playground"
                        tone="muted"
                    />
                )}
                {running && latestLog && <Hint indent={2}>{latestLog}</Hint>}
                {mirrorStatus === "running" && largeSite && (
                    <Hint indent={2}>large site — this may take several minutes</Hint>
                )}
                {running && <Hint indent={2}>press Ctrl+C to cancel</Hint>}
            </Section>

            {signingPrompt && signingPrompt.kind === "sign-request" && (
                <PhoneApprovalCallout step={signingPrompt.step} label={signingPrompt.label} />
            )}
        </Box>
    );
}

// ── Done stage ───────────────────────────────────────────────────────────────

function DoneStage({
    outcome,
    onExit,
}: {
    outcome: DecentralizeOutcome;
    onExit: () => void;
}) {
    // Auto-exit: the rendered frame stays in terminal scrollback, so users
    // see the summary without having to press a key. Matches the implicit
    // "command finishes when work finishes" convention every other CLI uses.
    useEffect(() => {
        onExit();
        // onExit is captured at mount; we never want to re-fire on identity churn.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <Box flexDirection="column">
            <Row mark="ok" label="decentralized!" />
            <Section gapBelow={false}>
                <Row label="url" value={outcome.appUrl} />
                <Row label="domain" value={outcome.fullDomain} />
                <Row label="ipfs cid" value={outcome.ipfsCid} />
                <Row label="gateway" value={outcome.gatewayUrl} />
                {outcome.metadataCid && <Row label="metadata cid" value={outcome.metadataCid} />}
            </Section>
            {outcome.signerSource === "dev" && (
                <Callout tone="warning" title="Owned by a Development Account">
                    <Text>
                        To deploy to a domain owned by you, run `playground login` and re-run
                        `playground decentralize` with the mobile signer.
                    </Text>
                </Callout>
            )}
        </Box>
    );
}

// ── Error stage ──────────────────────────────────────────────────────────────

function ErrorStage({ message, onExit }: { message: string; onExit: () => void }) {
    // Same auto-exit rationale as DoneStage — the danger callout stays in
    // scrollback so the user can still read it after the prompt returns.
    useEffect(() => {
        onExit();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <Box flexDirection="column">
            <Callout tone="danger" title="Decentralize Failed">
                <Text>{message}</Text>
            </Callout>
        </Box>
    );
}
