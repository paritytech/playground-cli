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
 * Chain query helpers for E2E tests.
 *
 * Connects to Paseo Asset Hub to verify on-chain state
 * (balances, registry entries) after CLI operations.
 */

import { destroyConnection, getConnection, type PaseoClient } from "../../../src/utils/connection.js";

let clientPromise: Promise<PaseoClient> | null = null;
let client: PaseoClient | null = null;

/**
 * Get a cached Paseo client. Creates one on first call.
 * Reuses the same connection for all subsequent calls.
 *
 * Delegates connect-timeout handling to `getConnection()` — wrapping a second
 * Promise.race-with-setTimeout here previously stacked an extra un-unref'd
 * timer on top, leaking the event loop for ~30 s after every short test and
 * causing vitest teardown to hang past its 5 s budget.
 */
export async function getTestClient(): Promise<PaseoClient> {
	if (!clientPromise) {
		clientPromise = getConnection()
			.then((c) => {
				client = c;
				return c;
			})
			.catch((err) => {
				clientPromise = null;
				throw err;
			});
	}
	return clientPromise;
}

/**
 * Destroy the cached chain client and release the WebSocket.
 * Call this in globalSetup teardown.
 */
export function destroyTestClient(): void {
	if (client) {
		destroyConnection();
		client = null;
	}
	clientPromise = null;
}

/**
 * Query the free balance of an ss58 address on Asset Hub (substrate-side).
 */
export async function queryBalance(address: string): Promise<bigint> {
	const c = await getTestClient();
	const account = await c.assetHub.query.System.Account.getValue(address, { at: "best" });
	return account.data.free;
}
