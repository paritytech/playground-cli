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

import React from "react";
import { Command } from "commander";
import { render } from "ink";
import { captureWarning, withSpan, errorMessage } from "../../telemetry.js";
import { runCliCommand } from "../../cli-runtime.js";
import { LoginScreen } from "./LoginScreen.js";
import { connect, type LoginHandle, type SessionAddresses } from "../../utils/auth.js";
import { destroyConnection } from "../../utils/connection.js";

export const loginCommand = new Command("login")
    .description("Install prerequisites and login via mobile QR")
    .option("-y, --yes", "Skip interactive prompts")
    .action(async (opts) =>
        runCliCommand("login", { hardExit: false }, async () => {
            console.log();

            let login: LoginHandle | null = null;
            let existingAddresses: SessionAddresses | null = null;

            if (!opts.yes) {
                try {
                    const result = await withSpan(
                        "cli.login.session",
                        "login via mobile session",
                        () => connect(),
                    );
                    if (result.kind === "existing") {
                        existingAddresses = result.addresses;
                    } else {
                        login = result.login;
                        console.log("  Scan with the Polkadot mobile app to log in:\n");
                        console.log(result.qrCode);
                        // On the same device as the app (e.g. a browser terminal on a
                        // phone) you can't scan a QR on your own screen, so also print
                        // a link. Browser terminals (ttyd/xterm.js) only make http(s)
                        // tappable — not custom schemes — so when PG_LOGIN_LINK_BASE is
                        // set, print an https link that redirects to the deeplink;
                        // otherwise print the raw polkadotapp:// deeplink.
                        const linkBase = process.env.PG_LOGIN_LINK_BASE?.replace(/\/+$/, "");
                        const openUrl = linkBase
                            ? `${linkBase}/?d=${encodeURIComponent(result.link)}`
                            : result.link;
                        console.log("\n  or open this link to log in on this device:\n");
                        console.log(`  ${openUrl}\n`);
                    }
                } catch (err) {
                    const msg = errorMessage(err);
                    captureWarning("Login service unavailable, continuing setup", {
                        error: msg,
                    });
                    console.log(`  Login skipped: ${msg}\n`);
                }
            }

            const app = render(
                React.createElement(LoginScreen, {
                    login,
                    existingAddresses,
                    onDone: () => app.unmount(),
                }),
            );
            try {
                await withSpan("cli.login.setup", "run login setup", () => app.waitUntilExit());
            } finally {
                // The login flow opens the shared Paseo client lazily via
                // `getConnection()` (AccountSetup uses the same singleton).
                // Login runs with `hardExit: false`, so the event loop has to
                // drain naturally — leaving the WS open means `dot login`
                // hangs after "setup complete".
                destroyConnection();
                // QR-path login handle: `connect()` transferred adapter
                // ownership to us (it's the transport `waitForLogin` signs
                // in over). Once the TUI has exited nothing uses it —
                // AccountSetup opens its own handles via
                // `getSessionSigner()` — so release it here, or its
                // statement-store WebSocket keeps the event loop (and the
                // process) alive indefinitely. Fire-and-forget + `.catch()`
                // for the same post-destroy-artifact reasons as
                // `SessionHandle.destroy()` (see auth.ts).
                login?.adapter.destroy().catch(() => {});
            }

            console.log();
        }),
    );
