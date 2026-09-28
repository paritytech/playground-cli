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

/** Minimal structural view of the registry handle this decoder needs. */
export interface MetadataUriReader {
    getMetadataUri: { query(domain: string): Promise<{ success: boolean; value?: unknown }> };
}

/**
 * Read an app's metadata CID from the playground registry.
 *
 * Returns `null` when the registry has no entry for `domain`.
 *
 * ⚠️ Shape, and why this is the ONLY place that decodes it: on the v2 registry
 * `getMetadataUri` returns a plain `String`, and an ABSENT app decodes as the
 * EMPTY STRING. There is no `Option` wrapper, so there is no `isSome` to
 * narrow on. The pre-v2 contract did return `Option<String>`, and the code
 * written against it (`value.isSome ? value.value : null`) reads `undefined`
 * on every call — reporting every app as missing, including ones that exist.
 * That shipped briefly and broke `playground mod` outright; the call sites are
 * typed loosely enough that neither tsc nor the tests could see it.
 *
 * An unexpected payload therefore throws rather than degrading to "not found":
 * a silent wrong-shape read is exactly the failure mode above, and a missing
 * app and a changed ABI need very different responses from whoever hits it.
 */
export async function getAppMetadataUri(
    registry: MetadataUriReader,
    domain: string,
): Promise<string | null> {
    const res = await registry.getMetadataUri.query(domain);
    if (!res.success) {
        throw new Error(
            `Registry lookup for "${domain}" failed at dry-run (chain rejected the call).`,
        );
    }
    if (res.value === undefined || res.value === null) return null;
    if (typeof res.value !== "string") {
        throw new Error(
            `Registry returned an unexpected shape for getMetadataUri("${domain}"): ` +
                `expected a string, got ${typeof res.value}. The registry ABI has probably ` +
                `changed — re-run \`cdm i\` and check this decoder.`,
        );
    }
    return res.value === "" ? null : res.value;
}
