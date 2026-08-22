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
| **Fader position** | fader → Companion | writes the fader's position, 0–100, into a custom variable |
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
2. Move the fader. `cc1_fader` tracks 0–100 — watch it on the Custom Variables page, or
   on the test page's `FADER` readout.
3. Use it anywhere: a trigger on that variable, a button's text, an action's value.

### Driving the motor

Put an expression in **Motor fader target** and the motor follows it whenever the value
changes. Any expression that yields 0-100 works — a variable from another connection,
or a custom variable you set from a trigger:

```
$(custom:desk_level)
```

The fader physically moves to match whenever that value changes. The module ignores
motor commands while you are touching the fader, so it never fights your hand.

To drive the motor from a button instead, have the button set a custom variable and
point **Motor fader target** at it — that is what the test page's `SET 0` / `-10` /
`+10` buttons do.

### A worked pair

For a fader that controls a level *and* re-syncs when the thing it controls changes
underneath it:

- **Fader position** → `cc1_fader`, with a trigger on that variable sending the level to
  wherever it belongs.
- **Motor fader target** → the level as that device reports it, so the fader snaps to
  the real value whenever it changes elsewhere.

Point the two fields at **different** things in real use. Aiming both at `cc1_fader`
creates a loop — the fader writes the variable, the variable drives the motor back to
where the fader already is. Harmless, but pointless. (On the test page it is deliberate:
it demonstrates both directions with one variable.)

## Testing an install

[`docs/CC1-Surface-Test-Page.companionconfig`](docs/CC1-Surface-Test-Page.companionconfig)
is an importable page that exercises the whole surface at once. Import it
(Import/Export -> Import) and send the surface to that page; anything mismapped is
obvious at a glance.

- **LCD rows 0-1** — eight distinct colours, labelled with their key numbers.
- **LCD row 2** — the fader test strip: `SET 0`, `-10`, `+10`, and a live readout of
  the `cc1_fader` custom variable. The buttons create that variable if it does not
  exist, so no setup is needed first.
- **Row 3** — RC1-RC6.
- **Rows 4-6** — one cell per button, coloured so every LED that exists lights up.

To watch the motor move, set **Motor fader target** to `$(custom:cc1_fader)` in the
surface settings — then `-10` / `+10` drive the fader and the readout follows. Set
**Fader position** to the same variable and moving the fader by hand updates the readout
too. (Pointing both at one variable is a loop, which is exactly what you want for a
test but not in a real setup — see the fader section above.)

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
