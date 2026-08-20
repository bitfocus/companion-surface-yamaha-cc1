# Yamaha CC1 (CC121MK2) — Companion 5 surface module

Runs the Yamaha CC121MK2 as a native Bitfocus Companion surface: the 12 LCD keys draw
real Companion button graphics, every button and encoder is a control, the button LEDs
light in colour, and the motorised fader works in both directions.

Reverse-engineered from a USB capture of Yamaha ControlCenter — no Yamaha software or
driver is needed. The device is a plain USB CDC-ACM serial port.

## Install

**Easiest — import the package** (Companion 5.0.3+):

1. Web UI → **Modules → Import custom module** → `yamaha-cc1-<version>.tgz`
2. Confirm the Yamaha module shows that version as selected.
3. Plug in the CC1, then **Surfaces → Add Surface Integration → Yamaha CC121MK2**.

**Alternative — developer modules path:** extract the zip somewhere permanent, point the
launcher's *Developer modules path* at the folder **containing** `yamaha-cc1`, restart
Companion.

Nothing needs compiling: prebuilt serial bindings for macOS, Windows and Linux
(x64/armv6/armv7/arm64, glibc and musl) are bundled.

### Linux

Two things that don't apply on macOS or Windows — see [`linux/`](linux/):

- **ModemManager** probes any new `/dev/ttyACM*` with AT commands, which can upset the
  device. `linux/99-yamaha-cc1.rules` tells it to keep away.
- **Permissions**: `/dev/ttyACM*` is `root:dialout` mode 660, so the user running
  Companion must be in `dialout`. Group changes only apply to *new* processes — restart
  the session, not just Companion.

`bash linux/check.sh` diagnoses both, plus "something else already holds the port".

## Layout — 6 columns × 7 rows

| Row | Contents |
|-----|----------|
| 0–2 | the 12 LCD keys (72×72 bitmaps, columns 0–3) |
| 3   | encoders RC1–RC6 (RC6 is the jog wheel) — rotate and push |
| 4–6 | the 17 buttons, in the order printed on the panel |
| 6/5 | the fader — touching it is a press |

## The fader

Companion surface modules cannot publish their own variables; the only channel is
"hand this value to a custom variable you nominate". So the fader needs a one-time
setup, and **the custom variable must exist first** — the surface settings dropdown
only lists existing ones and cannot create them.

1. **Variables → Custom Variables** → create e.g. `cc1_fader`.
2. **Surfaces → Yamaha CC121MK2 → settings**:
   - **Fader position** → pick `cc1_fader`. Moving the fader now writes 0–100 into it.
   - **Motor fader target** → an expression the motor should follow, e.g. a camera's
     iris level. Leave empty if nothing should drive the motor.

Point these two at *different* things. Aiming both at `cc1_fader` makes a loop: the
fader writes the variable and the variable drives the motor back to where the fader
already is. (It won't fight your hand — motor moves are ignored while the fader is
touched — but it achieves nothing.)

## Testing an install

[`docs/CC1-Surface-Test-Page.companionconfig`](docs/CC1-Surface-Test-Page.companionconfig)
is an importable page that exercises the whole surface at once: the 12 LCD keys in
distinct colours and labelled with their key numbers, RC1-RC6 across row 3, and one cell
per button coloured so every LED that exists lights up. Import it (Import/Export ->
Import), send the surface to that page, and anything mismapped is obvious at a glance.

## LEDs

15 of the 17 buttons have an LED; the pair beside the screen has none in hardware.
They light in the colour of the Companion cell, snapped to the device's palette —
blue, orange, yellow, purple, light blue, pink, red, green, white. A near-black cell
leaves the LED off, and brightness is normalised so a dim red cell still lights red.

## Development

```sh
npm install
npx tsc                      # build to dist/
npx tsx src/cc1-proto.test.ts   # codec self-check, anchored on captured bytes
npx tsx src/main.test.ts        # layout and host-contract self-check
bash tools/pack.sh           # build an importable .tgz (never tar it by hand — see below)
```

`tools/` also holds the hardware rigs used to map the device: `hw-test.mjs` (full
5-phase check), `led-remap.mjs` (rebuild the LED map), `led-colour.mjs` (identify a
colour value), `press-pass.mjs` (log button ids), `parse_usbpcap.py` (decode a USB
capture).

**Always package with `tools/pack.sh`.** macOS `tar` writes an AppleDouble sidecar for
every file, including `._package` at the archive root; Companion extracts with
`strip: 1`, that name becomes empty, and the import dies with `EISDIR`. Worse, macOS
`tar -tzf` hides those entries, so a bad archive lists as clean — verify with Python's
`tarfile` if you ever need to check by hand.

## Notes on the hardware

- The device ignores everything until it has answered the handshake; the backlight
  frame must be sent **last**, after panel mode, or the screen stays dark.
- Writes must be paced. Unpaced tile floods stall the firmware: dark screen, hung
  close, and a CDC driver that needs a physical replug.
- The port is opened with `hupcl: false` — dropping DTR on close makes the device mute
  until USB re-enumeration.
- If the device stops acknowledging paints for a couple of seconds, the module
  disconnects itself so the host reconnects and re-initialises it.

Protocol details — framing, opcodes, the LED palette, and how each was verified —
are in [`docs/protocol.md`](docs/protocol.md).
