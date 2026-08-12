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
 * Plain-language help copy for the interactive `playground deploy` prompts.
 *
 * Feedback: users who'd been "vibe coding" couldn't interpret prompts like
 * "changed contracts?" and skipped the moddable step because the choices were
 * opaque. So each conceptual choice now renders an info box (a `Callout`)
 * above it explaining what the decision is and what each option does, and the
 * labels/hints are reworded into everyday language. The prompt ORDER and
 * gating are intentionally unchanged (contracts must run before the frontend
 * build, so it stays first); this module only owns the words.
 *
 * Boxed prompts (conceptual choices) get a `{ title, body }`; lightweight
 * nudges get a single dim hint line instead of a full bordered box. Keep bodies
 * short enough to read at a glance; the test enforces a soft length cap.
 */

import { getEnvTld } from "../../config.js";

export interface PromptBox {
    title: string;
    body: string;
}

export const BUILD_HELP: PromptBox = {
    title: "Build step",
    body:
        "Compiles your latest code into the files we upload. Choose Yes to " +
        "rebuild now, or No to redeploy the build that's already in your build folder.",
};

export const BUILD_HINT =
    "Press enter to rebuild now. Change this only if you want to redeploy an existing build.";

export const CONTRACTS_HELP: PromptBox = {
    title: "Smart contracts · your app's on-chain backend",
    body:
        "Smart contracts hold your app's on-chain logic and data, and deploy " +
        "separately from your website. If you only changed the website, choose No. " +
        "If you changed contract code in this project, choose Yes, and we'll redeploy " +
        "and reinstall them, then rebuild the site to match.",
};

export const SIGNER_HELP: PromptBox = {
    title: "Who signs the upload",
    body:
        "Publishing writes to the blockchain, which needs a signature. The dev " +
        "signer uses a shared test account: instant, no phone needed. Your phone " +
        "signer signs with your own logged-in account, with a few taps on your phone.",
};

export const PUBLISH_HELP: PromptBox = {
    title: "Publish to the playground",
    body:
        "Choosing Yes lists your app in the public Polkadot Playground so others " +
        `can find and open it. No still deploys it to your .${getEnvTld()} address. ` +
        "It just won't be listed in the playground.",
};

export const MODDABLE_HELP: PromptBox = {
    title: "Moddable apps",
    body:
        "A moddable app shares its source so anyone can run `playground mod` to " +
        "clone it as a starting point for their own version. This publishes a link " +
        "to your public GitHub repo. Your app works exactly the same either way. " +
        "This only adds a 'remix me' link.",
};

export const TAGS_HELP: PromptBox = {
    title: "Category tag",
    body:
        "Pick a category so people can filter for your app in the playground. " +
        "This is optional: choose Skip to publish without a tag.",
};

export const DOMAIN_HELP: PromptBox = {
    title: `Choosing your .${getEnvTld()} name`,
    body:
        "A name with a 9-character-or-longer base (before any optional 2-digit " +
        "suffix) is open to everyone, so it deploys with no personhood check. " +
        "Names of 6 to 8 characters need Proof of Personhood on this network; " +
        "names of 5 or fewer are reserved.",
};

/**
 * Warning shown after the user confirms they changed contracts (and we're about
 * to redeploy them). CDM package names are globally first-deploy-wins: a modded
 * fork (or any project that edited contracts someone else authored) ships
 * names the current signer does not own, so the publish fails late, after a
 * funded, ownership-binding deploy (paritytech/playground-app#320,
 * paritytech/playground-cli#341). We surface it up front and gate on an explicit
 * ack so the user can rename first. Kept as plain strings (not a `PromptBox`) so
 * it renders as a `warning` Callout and isn't bound by the info-box length cap.
 */
export const CONTRACTS_RENAME_NOTICE_TITLE = "Check your contract names before redeploying";

export const CONTRACTS_RENAME_NOTICE_BODY =
    "Each smart-contract package name is claimed on-chain by the first account to " +
    "deploy it, and only that account can redeploy under it. If you wrote these " +
    "contracts yourself, you already own the names, so just continue. But if this " +
    "app is a mod, or you edited contracts that someone else originally wrote, the " +
    "names in cdm.json still belong to them and your deploy will fail. To publish " +
    "under your own account, first rename each contract to a name you own: update " +
    "its package name in cdm.json, in the contract's Cargo.toml, and anywhere your " +
    "frontend code refers to it.";

export const CONTRACTS_RENAME_NOTICE_HINT = "enter to continue · esc to exit and rename";

/** One-line hints for lightweight prompts (no bordered box). */
export const BUILD_DIR_HINT =
    "The folder holding your built site (the files we upload). The default fits most projects.";

export const DOMAIN_HINT = `Pick the .${getEnvTld()} address people will use to reach your app, e.g. my-app.${getEnvTld()}.`;
