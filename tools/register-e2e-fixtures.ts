#!/usr/bin/env bun
/**
 * Register all permanent E2E fixture domains on the live playground-registry
 * contract, signed by the dedicated E2E deployer (SIGNER from
 * e2e/cli/fixtures/accounts.ts). Same-owner re-publish is permitted by the
 * registry contract, so re-running this tool simply updates the metadata in
 * place — idempotent.
 *
 * Generalises the old `register-mod-fixture.ts`. The mod fixture
 * (`dot-cli-mod-fixture.dot`) is now one entry in a unified FIXTURES table
 * alongside the new per-cell deploy domains added in Phase 3 (foundry, cdm,
 * hardhat, multi).
 *
 * All fixtures are registered with `visibility = 0` (private) so they don't
 * clutter the public playground.dot grid. The CLI tests that hit these
 * domains use direct `getMetadataUri` queries (`dot mod <domain>`,
 * registry-readback assertions), which are unaffected by visibility.
 *
 * Usage:
 *   bun tools/register-e2e-fixtures.ts                        # register all 5
 *   bun tools/register-e2e-fixtures.ts --domain e2efnd00      # one only
 *   bun tools/register-e2e-fixtures.ts --suri //Alice         # custom signer
 *
 * Auto-tops-up SIGNER from the CLI's funder chain if balance is too low to
 * cover the publish extrinsic, matching the e2e setup behavior.
 */

import { resolveSigner } from "../src/utils/signer.js";
import { publishToPlayground } from "../src/utils/deploy/playground.js";
import { getConnection, destroyConnection } from "../src/utils/connection.js";
import { ensureFunded, checkBalance, MIN_BALANCE } from "../src/utils/account/funding.js";
import { DEDICATED_E2E_DEPLOYER_MNEMONIC } from "../e2e/cli/fixtures/accounts.js";

interface Fixture {
	domain: string;
	repositoryUrl: string | null;
	purpose: string;
}

/**
 * Permanent E2E fixture domains. Registering them is a one-shot bootstrap
 * step per registry-contract lifetime; see Phase 3 of the spec.
 *
 * `dot-cli-mod-fixture.dot` is the only one with a repository URL, because
 * `dot mod <domain>` only works when the registered metadata advertises a
 * source repo. The other domains are deploy targets — same-owner re-publish
 * cycles their metadata on every CI run.
 */
const FIXTURES: readonly Fixture[] = [
	{
		domain: "dot-cli-mod-fixture.dot",
		repositoryUrl: "https://github.com/paritytech/Rock-Paper-Scissors",
		purpose: "dot mod E2E fixture (clones into a fresh repo)",
	},
	{
		domain: "e2efnd00",
		repositoryUrl: null,
		purpose: "pr-deploy-foundry cell",
	},
	{
		domain: "e2ecdm00",
		repositoryUrl: null,
		purpose: "pr-deploy-cdm cell",
	},
	{
		domain: "e2ehat00",
		repositoryUrl: null,
		purpose: "nightly-deploy-hardhat cell",
	},
	{
		domain: "e2emul00",
		repositoryUrl: null,
		purpose: "nightly-deploy-multi cell",
	},
];

const DEFAULT_SURI = `${DEDICATED_E2E_DEPLOYER_MNEMONIC}//e2e-deployer`;
const PAS = 10_000_000_000n;
const TOPUP_TARGET = 500n * PAS;
const TOPUP_AMOUNT = 1000n * PAS;

interface Args {
	onlyDomain: string | null;
	suri: string;
}

function parseArgs(argv: string[]): Args {
	const args: Args = { onlyDomain: null, suri: DEFAULT_SURI };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = argv[i + 1];
		if (arg === "--domain" && next) {
			args.onlyDomain = next;
			i++;
		} else if (arg === "--suri" && next) {
			args.suri = next;
			i++;
		} else if (arg === "--help" || arg === "-h") {
			console.log("Usage: bun tools/register-e2e-fixtures.ts [--domain X] [--suri Z]");
			console.log();
			console.log("Default: registers all permanent E2E fixture domains:");
			for (const f of FIXTURES) {
				console.log(`  ${f.domain.padEnd(28)}  — ${f.purpose}`);
			}
			process.exit(0);
		} else {
			throw new Error(`Unknown arg: ${arg}`);
		}
	}
	return args;
}

async function topUpIfLow(client: Awaited<ReturnType<typeof getConnection>>, address: string): Promise<void> {
	const balance = await checkBalance(client, address, TOPUP_TARGET);
	console.log(`signer balance: ${balance.free / PAS} PAS`);
	if (!balance.sufficient) {
		console.log(`balance below ${TOPUP_TARGET / PAS} PAS — topping up by ${TOPUP_AMOUNT / PAS} PAS…`);
		await ensureFunded(client, address, TOPUP_TARGET, TOPUP_AMOUNT);
		const after = await checkBalance(client, address, MIN_BALANCE);
		console.log(`topped up: ${after.free / PAS} PAS`);
	}
	console.log();
}

async function registerOne(fixture: Fixture, signer: Awaited<ReturnType<typeof resolveSigner>>): Promise<void> {
	console.log(`▶ registering ${fixture.domain}`);
	console.log(`  purpose:    ${fixture.purpose}`);
	console.log(`  repository: ${fixture.repositoryUrl ?? "(none)"}`);
	const result = await publishToPlayground({
		domain: fixture.domain,
		publishSigner: signer,
		repositoryUrl: fixture.repositoryUrl,
		isPrivate: true,
		onLogEvent: (event) => {
			if (event.kind === "info") console.log(`    • ${event.message}`);
		},
	});
	console.log(`  ✓ published ${result.fullDomain}`);
	console.log(`    metadataCid  ${result.metadataCid}`);
	console.log();
}

async function main(): Promise<number> {
	const args = parseArgs(process.argv.slice(2));

	const normalize = (s: string): string => s.replace(/\.dot$/i, "");
	const targets = args.onlyDomain
		? FIXTURES.filter((f) => normalize(f.domain) === normalize(args.onlyDomain ?? ""))
		: FIXTURES;

	if (targets.length === 0) {
		console.error(`No fixture matches --domain ${args.onlyDomain}`);
		console.error(`Known fixtures: ${FIXTURES.map((f) => f.domain).join(", ")}`);
		return 2;
	}

	console.log(`registering ${targets.length} fixture(s):`);
	for (const f of targets) console.log(`  - ${f.domain}`);
	console.log();

	const signer = await resolveSigner({ suri: args.suri });
	console.log(`signer  ${signer.address} (${signer.source})`);
	console.log();

	try {
		const client = await getConnection();
		// Balance checked once; TOPUP_TARGET (500 PAS) gives ~1000× headroom
		// for the ~0.1 PAS/publish cost across all 5 fixtures.
		await topUpIfLow(client, signer.address);
		for (const fixture of targets) {
			await registerOne(fixture, signer);
		}
		console.log(`✓ all ${targets.length} fixture(s) registered`);
		console.log();
		console.log(`verify with: bun tools/probe-registry-resolution.ts <domain>`);
		return 0;
	} finally {
		signer.destroy();
		destroyConnection();
	}
}

main()
	.then((code) => process.exit(code))
	.catch((err) => {
		console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
		process.exit(2);
	});
