#!/usr/bin/env bash
#
# Check that a .tgz is a module package Companion can actually import.
#
# Sourced by pack.sh and fix_package.sh; also runnable on its own:
#   tools/verify_package.sh yamaha-cc1-0.3.0.tgz
verify_package() {
	local tarball=$1
	local list outside required missing=0

	# List once into a variable, then search that. Deliberately NOT `tar -tzf ... | grep -q`:
	# under `set -o pipefail` grep -q exits at the first match, tar then dies of SIGPIPE (141),
	# and the pipeline reports a failure that never happened. That bug hides on a small archive
	# (tar finishes before grep exits) and bites on a real one.
	list=$(tar -tzf "$tarball")

	# The fatal case. Companion extracts module packages with `strip: 1`, so any entry with a
	# single path component — macOS tar writes `._package` at the archive root — strips to an
	# empty name, and the extractor tries to write a file over the destination directory:
	#   EISDIR: illegal operation on a directory, open '...\surfaces\yamaha-cc1-0.3.0'
	outside=$(printf '%s\n' "$list" | grep -v '^package/' || true)
	if [ -n "$outside" ]; then
		echo "ERROR: $tarball has entries outside package/ — Companion's strip:1 extract will fail:" >&2
		printf '%s\n' "$outside" | sed 's/^/  /' >&2
		return 1
	fi

	for required in package/companion/manifest.json package/dist/main.js; do
		# No -q, so grep drains its input and cannot SIGPIPE the producer.
		if ! printf '%s\n' "$list" | grep -Fx -- "$required" > /dev/null; then
			echo "ERROR: $tarball is missing $required" >&2
			missing=1
		fi
	done
	[ "$missing" -eq 0 ] || return 1

	echo "ok: $tarball ($(printf '%s\n' "$list" | wc -l | tr -d ' ') entries, 0 outside package/)"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
	set -euo pipefail
	verify_package "${1:?usage: verify_package.sh <package.tgz>}"
fi
