/**
 * Resolves *which* signer is used for each on-chain step of a deploy. This
 * is the only module that knows the full matrix; everywhere else receives
 * already-composed objects so a future mainnet profile can swap in without
 * rewriting callers.
 *
 * Today (testnet):
 *   - Dev mode: bulletin-deploy uses its built-in default mnemonic for
 *     storage AND DotNS. Playground publish (if enabled) still uses the
 *     user's phone signer so myApps ownership lands on the correct address.
 *   - Phone mode: bulletin-deploy uses the user's phone signer for DotNS
 *     (3 taps). Storage always uses the bulletin-deploy pool mnemonic.
 *     Playground publish uses the user's phone signer (1 more tap).
 */

import type { DeployOptions } from "bulletin-deploy";
import type { ResolvedSigner } from "../signer.js";
import type { DeployPlan } from "./availability.js";

export type SignerMode = "dev" | "phone";

export interface DeploySignerSetup {
    /**
     * Options to pass to bulletin-deploy's `deploy()`. For dev mode this is
     * empty (bulletin-deploy falls back to its env / DEFAULT_MNEMONIC); for
     * phone mode we inject the user's signer so DotNS registration is paid
     * for by — and recorded against — their account.
     */
    bulletinDeployAuthOptions: Pick<DeployOptions, "signer" | "signerAddress" | "mnemonic">;

    /**
     * Signer used to call `registry.publish()` for the playground step. This
     * is always the user's phone signer (when available) because the contract
     * records `env::caller()` as the owner — that's what drives the myApps
     * view. `null` means we cannot publish (dev mode without a phone session).
     */
    publishSigner: ResolvedSigner | null;

    /**
     * Count of phone approvals the user should expect under this setup,
     * broken down by phase. Used to render the summary card.
     */
    approvals: DeployApproval[];
}

export interface DeployApproval {
    phase: "dotns" | "playground" | "contracts-fund";
    label: string;
}

export interface ResolveOptions {
    mode: SignerMode;
    /** The user's phone (or --suri) signer, or null if not logged in. */
    userSigner: ResolvedSigner | null;
    /** Whether `--playground` / the prompt enabled playground publish. */
    publishToPlayground: boolean;
    /**
     * Known DotNS plan from the availability check. Shapes the approvals list
     * to match what bulletin-deploy will actually submit. Absent = we haven't
     * run the check yet, so assume the most common path (new register, no
     * PoP upgrade, 3 DotNS taps). The signing counter clamps up at runtime if
     * we under-estimated, so users never see "step 5 of 4" even on this path.
     */
    plan?: DeployPlan;
    /**
     * Whether the contracts phase will top up its session key before deploy.
     * When true and the user signer is a real phone session, the top-up
     * `Balances.transfer_keep_alive` needs a phone tap — surfaced here so
     * the confirm page's approval count matches what the user is about to
     * experience. When the session is already funded, or the funder is a
     * local dev key (pure dev mode, no session), no extra approval is added.
     */
    contractsFundingNeeded?: boolean;
}

/**
 * DotNS approvals in the exact order bulletin-deploy will fire them. Order
 * matters because `maybeWrapAuthForSigning` in run.ts labels each incoming
 * `signTx` call by its index in this list — the Nth `signTx` is labelled
 * with the Nth entry here, so a mismatch ends up showing "Finalize domain"
 * on the phone when the app is actually asking for commitment.
 */
function dotnsApprovals(plan: DeployPlan | undefined): DeployApproval[] {
    // Default to the most common path when the caller hasn't told us the
    // plan yet. Counter will self-correct if we under-estimated.
    const effective: DeployPlan = plan ?? { action: "register", needsPopUpgrade: false };

    if (effective.action === "update") {
        // Domain already owned by the signer — bulletin-deploy skips
        // `register()` entirely (no commitment, no finalize, no PoP grant)
        // and jumps straight to `setContenthash`. So only one tap.
        return [{ phase: "dotns", label: "Link content (DotNS setContenthash)" }];
    }

    const approvals: DeployApproval[] = [];
    if (effective.needsPopUpgrade) {
        // `register()` submits `setUserPopStatus` first whenever the predicted
        // post-grant status differs from the user's current one. Without this
        // entry the counter previously ran one past total ("step 5 of 4") for
        // any PoP-gated name.
        approvals.push({ phase: "dotns", label: "Grant Proof of Personhood" });
    }
    approvals.push(
        { phase: "dotns", label: "Reserve domain (DotNS commitment)" },
        { phase: "dotns", label: "Finalize domain (DotNS register)" },
        { phase: "dotns", label: "Link content (DotNS setContenthash)" },
    );
    return approvals;
}

export function resolveSignerSetup(opts: ResolveOptions): DeploySignerSetup {
    const approvals: DeployApproval[] = [];

    let bulletinDeployAuthOptions: DeploySignerSetup["bulletinDeployAuthOptions"] = {};

    // Contract session-key top-up — only counts as a phone tap when the
    // funder is a live session signer. Dev-suri and pure dev (Alice)
    // funding happen in-process with no human in the loop. Listed FIRST so
    // the numbered order on the confirm page matches the runtime firing
    // order: the contracts phase runs before `storage-and-dotns` + playground.
    if (opts.contractsFundingNeeded && opts.userSigner?.source === "session") {
        approvals.push({ phase: "contracts-fund", label: "Fund contract deploy session key" });
    }

    if (opts.mode === "phone") {
        if (!opts.userSigner) {
            throw new Error(
                'Phone signer requested but no session found. Run "dot init" to log in, or pass --signer dev.',
            );
        }
        bulletinDeployAuthOptions = {
            signer: opts.userSigner.signer,
            signerAddress: opts.userSigner.address,
        };
        approvals.push(...dotnsApprovals(opts.plan));
    }

    // Playground publish always uses the user's signer so ownership ties to
    // their address — otherwise the registry would record a shared dev key
    // and the myApps view would be useless.
    //
    // userSigner is guaranteed non-null here: shouldResolveUserSigner() returns
    // true whenever publishToPlayground is true, so resolveSigner() in the
    // preflight has already either resolved a signer or thrown before we reach
    // this point. The null guard that previously lived here was unreachable.
    let publishSigner: ResolvedSigner | null = null;
    if (opts.publishToPlayground) {
        publishSigner = opts.userSigner!;
        approvals.push({ phase: "playground", label: "Publish to Playground registry" });
    }

    return { bulletinDeployAuthOptions, publishSigner, approvals };
}
