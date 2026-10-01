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

import { Text } from "ink";
import { Callout } from "./Callout.js";
import { PHONE_RESEND_HINT, resendNotice } from "./phoneApprovalCopy.js";

export interface PhoneApprovalCalloutProps {
    step: number;
    /**
     * Optional: only pass when the total is exactly known (e.g. a fixed
     * single-tap flow like the login allowance grant). Deploy flows omit it —
     * taps are demand-driven (allowance grants, DotNS plan drift), so a
     * predicted total regularly turned out wrong ("step 4 of 5" with no
     * fifth step).
     */
    total?: number;
    label: string;
    /** 2+ when this is a re-send of the same approval; omit (or 1) for a first request. */
    attempt?: number;
}

export function PhoneApprovalCallout({
    step,
    total,
    label,
    attempt = 1,
}: PhoneApprovalCalloutProps) {
    const notice = resendNotice(attempt);
    return (
        <Callout tone="warning" title="Check Your Phone">
            <Text>
                approve step {step}
                {total !== undefined ? ` of ${total}` : ""}: <Text bold>{label}</Text>
            </Text>
            {notice && <Text>{notice}</Text>}
            {notice && <Text dimColor>{PHONE_RESEND_HINT}</Text>}
        </Callout>
    );
}
