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

## Setting up the fader

The fader carries a value in each direction, and each needs its own field in
**Surfaces → Yamaha CC121MK2 → settings**:

| Field | Direction | Meaning |
|---|---|---|
| **Fader position** | fader → Companion | writes the fader's position into a custom variable, 0–100 in 0.1 steps |
| **Motor fader target** | Companion → fader | an expression the motor drives to, 0–100 |

A surface module cannot publish variables of its own — the only channel Companion gives
it is "hand this value to a custom variable you nominate". **That variable has to exist
before you can pick it**: the dropdown lists existing custom variables and cannot create
one. If it shows nothing but `None`, that is why, and it is the most common reason the
fader appears to do nothing at all.

### Quickest route

Import [the test page](docs/CC1-Surface-Test-Page.companionconfig) and press its `+10`
button once. That creates `cc1_fader` for you, and it then appears in the dropdown.

Otherwise: **Variables → Custom Variables → +** and add `cc1_fader` by hand.

### Reading the fader

1. Set **Fader position** to `cc1_fader`.
2. Move the fader. `cc1_fader` tracks 0-100 — watch it on the Custom Variables page, or
   on the test page's `FADER` readout.

The fader is 10-bit, so the value is reported to one decimal place: 1001 distinct
positions rather than the 101 a whole percent would give. Round it in your expression
if you want coarser steps.
3. Use it anywhere: a trigger on that variable, a button's text, an action's value.

**Example — ride an OBS audio source.** Add a trigger that fires when `cc1_fader`
changes, with the OBS action **Set Source Volume**. That action wants decibels
(-100 to 26), so map the fader's 0-100 onto a useful range with an expression:

```
$(custom:cc1_fader) * 0.6 - 60
```

Bottom of the fader is -60 dB, top is 0 dB. Widen or narrow the range by changing the
two numbers.

### Driving the motor

Put an expression in **Motor fader target** and the motor follows it whenever the value
changes. Anything that yields 0-100 works — most usefully a custom variable that
something else sets:

```
$(custom:cc1_fader)
```

The module ignores motor commands while you are touching the fader, so it never fights
your hand. To drive the motor from a button, have the button set that variable — which
is exactly what the test page's `SET 0` / `-10` / `+10` buttons do.

Note that a value with units cannot drive the motor directly: OBS reports volume as
`-6.5 dB`, for instance, so it needs converting to 0-100 first — usually by having the
trigger that moves the level also write the 0-100 figure into a custom variable, and
pointing **Motor fader target** at that.

### A worked pair

For a fader that rides a level *and* re-syncs when that level changes elsewhere:

- **Fader position** → `cc1_fader`, with a trigger sending the level onward (the OBS
  example above).
- **Motor fader target** → a custom variable holding the level as it currently stands,
  updated whenever something else changes it.

Point the two fields at **different** variables in real use. Aiming both at `cc1_fader`
creates a loop — the fader writes it, and it drives the motor back to where the fader
already is. Harmless, but pointless. (On the test page that loop is deliberate: it
demonstrates both directions with one variable.)

## Testing an install

[`docs/CC1-Surface-Test-Page.companionconfig`](docs/CC1-Surface-Test-Page.companionconfig)
is an importable page that exercises the whole surface at once. Import it
(Import/Export -> Import) and send the surface to that page; anything mismapped is
obvious at a glance.

- **LCD row 0** — four colours on the screen itself, as a display reference.
- **LCD rows 1-2** — the fader strip: `0%`, `25%`, `50%`, `75%`, `100%`, plus `-10` /
  `+10` nudges and a live readout of the `cc1_fader` custom variable. Those buttons
  create the variable if it does not exist, so no setup is needed first.
- **Row 3** — RC1-RC6.
- **Rows 4-6** — one cell per button, each set to a different colour from the device
  palette and labelled with it, so every one of the ten colours appears and a wrong LED
  is obvious. The two cells marked `no LED` are the pair beside the screen, which have
  no LED in hardware.

To watch the motor move, set **Motor fader target** to `$(custom:cc1_fader)` in the
surface settings — then `-10` / `+10` drive the fader and the readout follows. Set
**Fader position** to the same variable and moving the fader by hand updates the readout
too. (Pointing both at one variable is a loop, which is exactly what you want for a
test but not in a real setup — see the fader section above.)

## LEDs

15 of the 17 buttons have an LED; the pair beside the screen has none in hardware.
They light in the colour of the Companion cell, snapped to the nearest of the ten the
device can show: blue, orange, yellow, purple, sky blue, pink, red, green, yellow-green
and white. Matching ignores brightness, so a dim red cell still lights red, and it uses a
perceptual distance rather than raw RGB — a cyan cell picks sky blue rather than green.
A near-black cell leaves the LED off.

## Development

This repository uses **yarn** (Companion's module tooling requires it — an
`npm` lockfile fails the upstream CI checks).

```sh
corepack enable              # yarn 4, per packageManager in package.json
yarn install
yarn build                   # tsc -> dist/
yarn test                    # codec + layout self-checks
yarn package                 # importable .tgz via companion-surface-build
yarn check                   # companion-surface-check
```

`yarn package` bundles the module with esbuild and installs serialport into the output
as an external — see `build-config.cjs` for why it cannot be bundled.

`tools/` holds the hardware rigs used to map the device: `hw-test.mjs` (full 5-phase
check), `led-remap.mjs` (rebuild the LED map), `led-colour.mjs` (identify a colour
value), `press-pass.mjs` (log button ids), `harness.mjs` (full lifecycle against real
hardware), `listen.mjs` (raw input listener), `parse_usbpcap.py` (decode a USB capture).

Use `yarn package` rather than tarring the folder by hand: macOS `tar` writes an
AppleDouble sidecar for every file, including `._package` at the archive root, and
Companion extracts with `strip: 1` — that name becomes empty and the import dies with
`EISDIR`. macOS `tar -tzf` hides those entries, so a broken archive lists as clean.

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
