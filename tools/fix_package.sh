#!/usr/bin/env bash
#
# Repair a module package that was tarred by hand on macOS.
#
# macOS tar writes an AppleDouble sidecar for every file (`._package`, `package/._dist`,
# ...). The one at the archive ROOT is fatal — see tools/verify_package.sh. This unpacks,
# deletes the sidecars, repacks, and refuses to write the result unless it verifies.
#
# Prefer tools/pack.sh, which never produces the problem in the first place; use this when
# the tarball already exists (e.g. it was built on a Mac and handed over).
#
# Usage: tools/fix_package.sh yamaha-cc1-0.3.0.tgz [output.tgz]
set -euo pipefail

. "$(dirname "$0")/verify_package.sh"

SRC=${1:?usage: fix_package.sh <package.tgz> [output.tgz]}
OUT=${2:-$SRC}
[ -f "$SRC" ] || { echo "no such file: $SRC" >&2; exit 1; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# 2>/dev/null: macOS tarballs make tar grumble about LIBARCHIVE.xattr headers.
tar -xzf "$SRC" -C "$WORK" 2>/dev/null
stripped=$(find "$WORK" \( -name '._*' -o -name '.DS_Store' \) | wc -l | tr -d ' ')
find "$WORK" \( -name '._*' -o -name '.DS_Store' \) -delete
echo "stripped $stripped macOS metadata entries"

[ -d "$WORK/package" ] || { echo "ERROR: no package/ directory inside $SRC" >&2; exit 1; }

# Pack to a temp file and verify before overwriting — this runs in place by default.
TMP="$WORK/out.tgz"
COPYFILE_DISABLE=1 tar --format=ustar --exclude='._*' --exclude='.DS_Store' -czf "$TMP" -C "$WORK" package
verify_package "$TMP" > /dev/null

cp "$TMP" "$OUT"
verify_package "$OUT"
