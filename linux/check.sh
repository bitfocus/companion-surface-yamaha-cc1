#!/usr/bin/env bash
#
# Diagnose a CC1 install on Linux. Run as the user Companion runs as:
#   bash check.sh
set -u
VID=0499; PID=140f
ok() { echo "  OK    $*"; }
bad() { echo "  FAIL  $*"; }
warn() { echo "  WARN  $*"; }

echo "1. USB device"
if command -v lsusb >/dev/null && lsusb -d "$VID:$PID" >/dev/null 2>&1; then
	ok "$(lsusb -d "$VID:$PID")"
else
	bad "CC1 not found on USB (looking for $VID:$PID). Is it plugged in?"
fi

echo "2. Serial node"
node=$(ls /dev/ttyACM* 2>/dev/null | head -1)
[ -e /dev/cc1 ] && node=/dev/cc1
if [ -n "${node:-}" ]; then
	ok "$node  ($(stat -c '%U:%G %a' "$node" 2>/dev/null))"
else
	bad "no /dev/ttyACM* node — the cdc_acm driver did not bind"
fi

echo "3. Permissions"
if [ -n "${node:-}" ]; then
	if [ -r "$node" ] && [ -w "$node" ]; then
		ok "$(whoami) can read/write $node"
	else
		bad "$(whoami) cannot open $node — run: sudo usermod -aG dialout $(whoami)  (then log out and back in)"
		echo "        groups: $(id -nG)"
	fi
fi

echo "4. ModemManager"
if systemctl is-active --quiet ModemManager 2>/dev/null; then
	if [ -f /etc/udev/rules.d/99-yamaha-cc1.rules ]; then
		ok "running, but the CC1 udev rule is installed (it will be ignored)"
	else
		warn "ModemManager is running and the udev rule is NOT installed — it may probe the CC1 and wedge it"
		echo "        fix: sudo cp 99-yamaha-cc1.rules /etc/udev/rules.d/ && sudo udevadm control --reload-rules && replug"
	fi
else
	ok "not running"
fi

echo "5. Port in use"
if command -v fuser >/dev/null && [ -n "${node:-}" ] && fuser "$node" 2>/dev/null; then
	warn "something already holds $node (Companion itself, or a leftover process)"
else
	ok "nothing else holds the port"
fi
