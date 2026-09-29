#!/usr/bin/env bash
# Verify (or add) the Apache-2.0 SPDX header on every tracked source file.
#
# Usage:
#   scripts/check-license-headers.sh         # check (CI). Exits non-zero if any file is missing the header.
#   scripts/check-license-headers.sh --fix   # prepend the header to any source file missing it.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

HEADER='// Copyright (C) Parity Technologies (UK) Ltd.
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
'

# git ls-files honors .gitignore, so dist/, node_modules/, target/ are skipped.
#
# `.cdm/` is excluded explicitly: its two committed `.d.ts` files are generated
# by `cdm install` ("do not edit"), and any header we added would be stripped by
# the next regeneration — turning this check red on a routine `cdm i`. They are
# committed so CI can typecheck contract call sites, not as authored source.
mode="${1:-check}"
missing=()
total=0

while IFS= read -r f; do
  total=$((total + 1))
  # Require BOTH the SPDX line and the Parity copyright line. A bare SPDX line
  # alone is not enough — we want the full Parity-style block, not just the
  # machine-readable identifier.
  if ! grep -q 'SPDX-License-Identifier: Apache-2.0' "$f" \
     || ! grep -q 'Copyright (C) Parity Technologies' "$f"; then
    missing+=("$f")
  fi
done < <(git ls-files '*.ts' '*.tsx' '*.rs' | grep -v '^\.cdm/')

if [[ ${#missing[@]} -eq 0 ]]; then
  echo "All ${total} source files have the Apache-2.0 SPDX header."
  exit 0
fi

if [[ "$mode" == "--fix" ]]; then
  for f in "${missing[@]}"; do
    first=$(head -n1 "$f")
    if [[ "$first" == "#!"* ]]; then
      # Preserve the shebang on line 1 — node/bun rely on it being first.
      { printf '%s\n\n' "$first"; printf '%s\n' "$HEADER"; tail -n +2 "$f"; } > "$f.tmp"
    else
      { printf '%s\n' "$HEADER"; cat "$f"; } > "$f.tmp"
    fi
    mv "$f.tmp" "$f"
    echo "fixed: $f"
  done
  exit 0
fi

echo "Missing Apache-2.0 SPDX header in ${#missing[@]} file(s):"
printf '  %s\n' "${missing[@]}"
echo
echo "Run 'scripts/check-license-headers.sh --fix' to add the header automatically."
exit 1
