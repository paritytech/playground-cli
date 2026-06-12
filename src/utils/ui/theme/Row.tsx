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

import { Box, Text } from "ink";
import { COLOR, LAYOUT } from "./tokens.js";
import { Mark, type MarkKind } from "./Mark.js";

type ValueTone = "default" | "danger" | "warning" | "muted" | "accent";

export interface RowProps {
    mark?: MarkKind;
    label: string;
    value?: string;
    hint?: string;
    /** Controls vertical alignment of `value` across sibling Rows. */
    labelWidth?: number;
    /** Semantic color for the value — e.g. danger for "expired". */
    tone?: ValueTone;
}

/** A labeled status line: [mark] label (padded) value  — optional dim hint below. */
export function Row({
    mark,
    label,
    value,
    hint,
    labelWidth = LAYOUT.defaultLabelWidth,
    tone = "default",
}: RowProps) {
    const paddedLabel = label.length >= labelWidth ? label + " " : label.padEnd(labelWidth);
    return (
        <Box flexDirection="column" paddingLeft={LAYOUT.leftMargin}>
            <Box flexDirection="row">
                {mark && (
                    <Box marginRight={1}>
                        <Mark kind={mark} />
                    </Box>
                )}
                {/* Label and value live in separate boxes: when a long value
                    wraps, Ink trims the label's trailing pad and the mark's
                    margin if they share a text run, fusing "label" into
                    "value" with no space. flexShrink=0 keeps the label
                    column; the value box absorbs the wrapping. */}
                <Box flexShrink={0}>
                    <Text>{paddedLabel}</Text>
                </Box>
                {value !== undefined && (
                    <Box flexGrow={1} flexShrink={1}>
                        <ValueText tone={tone}>{value}</ValueText>
                    </Box>
                )}
            </Box>
            {hint && (
                <Box paddingLeft={mark ? 4 : 2}>
                    <Text dimColor>{hint}</Text>
                </Box>
            )}
        </Box>
    );
}

function ValueText({ tone, children }: { tone: ValueTone; children: string }) {
    switch (tone) {
        case "danger":
            return <Text color={COLOR.danger}>{children}</Text>;
        case "warning":
            return <Text color={COLOR.warning}>{children}</Text>;
        case "accent":
            return <Text color={COLOR.accent}>{children}</Text>;
        case "muted":
            return <Text dimColor>{children}</Text>;
        default:
            return <Text>{children}</Text>;
    }
}
