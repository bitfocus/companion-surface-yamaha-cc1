#!/usr/bin/env bash
#
# Build a Companion-importable module package (.tgz).
#
# Use this instead of tarring the folder by hand. A tarball built with plain `tar` on macOS
# carries AppleDouble sidecar entries (`._package`, `package/._dist`, ...), and the one at
# the ROOT of the archive is fatal — see tools/verify_package.sh for why, and
# tools/fix_package.sh to repair a tarball that already has the problem.
#
# Usage: tools/pack.sh [output.tgz]
set -euo pipefail

cd "$(dirname "$0")/.."
. tools/verify_package.sh

VERSION=$(node -p "require('./package.json').version")
OUT=${1:-"../yamaha-cc1-${VERSION}.tgz"}
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

echo "building..."
npm run build

echo "staging..."
mkdir -p "$STAGE/package"
cp package.json LICENSE README.md "$STAGE/package/"
cp -R companion dist "$STAGE/package/"

# Production deps only. Upstream does not commit a lockfile, so this resolves from
# package.json — pin ranges there if a build ever needs to be byte-reproducible.
# --ignore-scripts is safe here: serialport resolves its prebuilt binding at runtime via
# node-gyp-build, so nothing needs compiling at install time.
echo "installing production dependencies..."
(cd "$STAGE/package" && npm install --omit=dev --ignore-scripts --no-package-lock >/dev/null 2>&1)

# Belt and braces: drop any macOS metadata already on disk, and stop bsdtar creating more
# (COPYFILE_DISABLE is what makes macOS tar leave the resource forks out).
find "$STAGE" \( -name '._*' -o -name '.DS_Store' \) -delete

echo "packing..."
rm -f "$OUT"
COPYFILE_DISABLE=1 tar --format=ustar --exclude='._*' --exclude='.DS_Store' -czf "$OUT" -C "$STAGE" package

verify_package "$OUT"

# Release assets are just this package plus docs/CC1-Surface-Test-Page.companionconfig.
