#!/usr/bin/env node

// MUST be the first import — sets env vars that gate bulletin-deploy's
// ambient Sentry handoff before its modules evaluate. See
// `src/bootstrap.ts` for the rationale.
import "./bootstrap.js";
import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { initCommand } from "./commands/init/index.js";
import { modCommand } from "./commands/mod/index.js";
import { buildCommand } from "./commands/build.js";
import { logoutCommand } from "./commands/logout/index.js";
import { updateCommand } from "./commands/update.js";
import { captureWarning, closeTelemetry, flushTelemetry, initTelemetry } from "./telemetry.js";
import {
    installSignalHandlers,
    onProcessShutdown,
    setProcessGuardWarningHandler,
} from "./utils/process-guard.js";
import { clearWindowTitle } from "./utils/ui/theme/window-title.js";
import { checkForUpdates, flushVersionCheck } from "./utils/version-check.js";

const DEPLOY_DESCRIPTION =
    "Build the project, upload to Bulletin, register a .dot domain, and optionally publish to Playground";

async function runDotnsCliIfRequested(): Promise<void> {
    if (process.argv[2] !== "dotns") return;

    const { runDotnsCliSubprocess } = await import("./dotns-cli-dispatch.js");
    process.exit(await runDotnsCliSubprocess(process.argv.slice(3)));
}

async function loadDeployCommand(): Promise<Command> {
    return await withoutBundledDotnsCliWarning(async () => {
        const { deployCommand } = await import("./commands/deploy/index.js");
        return deployCommand;
    });
}

async function withoutBundledDotnsCliWarning<T>(fn: () => Promise<T>): Promise<T> {
    const warn = console.warn;
    console.warn = (...args: unknown[]) => {
        const message = String(args[0] ?? "");
        if (
            message.startsWith("[bulletin-deploy] @parity/dotns-cli not found in node_modules") &&
            message.includes("from '/$bunfs/root/")
        ) {
            return;
        }
        warn(...args);
    };
    try {
        return await fn();
    } finally {
        console.warn = warn;
    }
}

async function createDeployCommand(argv = process.argv): Promise<Command> {
    const wantsDeployHelp = argv[2] === "help" && argv[3] === "deploy";
    if (argv[2] === "deploy" || wantsDeployHelp) {
        return await loadDeployCommand();
    }

    return new Command("deploy")
        .description(DEPLOY_DESCRIPTION)
        .allowUnknownOption(true)
        .allowExcessArguments(true)
        .action(async () => {
            const deployCommand = await loadDeployCommand();
            await deployCommand.parseAsync(process.argv, { from: "node" });
        });
}

await runDotnsCliIfRequested();

// ── Bun compiled-binary stdin workaround ─────────────────────────────────────
// When `dot` is shipped via `bun build --compile`, Ink's internal
// `stdin.addListener('readable', …)` does NOT receive events until something
// else has already touched `process.stdin.on('readable', …)` first. Symptom:
// every useInput-driven TUI locks up — no arrow keys, no Enter, no Ctrl+C.
//
// Attaching a no-op `readable` listener here warms the stream up so Ink's
// own listener fires normally. Harmless under `bun run` and Node.
// Remove once Bun's compiled-binary TTY stdin behaves like Node's out of the
// box.
if (process.stdin.isTTY) {
    process.stdin.on("readable", () => {});
    // Don't let the listener itself hold the event loop open on exit.
    process.stdin.unref();
}

// Install SIGINT/SIGTERM/SIGHUP + unhandledRejection handlers so a force-quit
// or a stray async error can't turn `dot` into a zombie that grows memory
// indefinitely.
installSignalHandlers();
await initTelemetry();
setProcessGuardWarningHandler(captureWarning);
onProcessShutdown(() => closeTelemetry(2000));

// Hand the terminal tab title back to the shell on exit. The shell usually
// repaints its own title immediately, but being explicit avoids leaving
// "dot deploy · my-app.dot · ✓" stuck on a long-lived tab.
onProcessShutdown(clearWindowTitle);

const program = new Command()
    .name("dot")
    .description("CLI for Polkadot Playground")
    .version(pkg.version);

program.addCommand(initCommand);
program.addCommand(modCommand);
program.addCommand(buildCommand);
program.addCommand(await createDeployCommand());
program.addCommand(logoutCommand);
program.addCommand(updateCommand);

try {
    checkForUpdates(pkg.version);
    await program.parseAsync();
} catch (err) {
    if (process.exitCode === undefined || process.exitCode === 0) {
        process.stderr.write(`\n${err instanceof Error ? err.message : String(err)}\n`);
    }
    process.exitCode = 1;
} finally {
    await flushTelemetry();
    await flushVersionCheck();
}

process.exit(typeof process.exitCode === "number" ? process.exitCode : 0);
