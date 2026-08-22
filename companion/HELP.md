# Yamaha CC121MK2

Uses the CC121MK2 as a Companion surface over its USB serial interface. No Yamaha
ControlCenter, driver or Stream Deck software is needed — just plug it in.

Requires Companion 5.0.3 or newer.

## Getting started

1. Plug in the CC1.
2. **Surfaces → Add Surface Integration → Yamaha CC121MK2**.

The screen lights, clears, and starts drawing your current page within a second or two.

## Layout — 6 columns × 7 rows

| Row | Controls |
|-----|----------|
| **0–2** | the 12 LCD keys, columns 0–3. These draw real Companion button graphics. |
| **3** | encoders RC1–RC6, left to right. RC6 is the jog wheel. Rotate them, or push them as buttons. |
| **4–6** | the 17 push buttons. |
| **6/5** | the fader. Touching it counts as a button press. |

## Setting up the fader

The fader carries a value in each direction, and each has its own field in
**Surfaces → Yamaha CC121MK2 → settings**:

- **Fader position** — fader → Companion. Writes the fader position, 0–100, into a
  custom variable.
- **Motor fader target** — Companion → fader. An expression, 0–100, that the motor
  drives to.

**The custom variable must already exist before you can pick it.** The dropdown lists
existing custom variables and cannot create one, so if it offers nothing but `None`,
that is why — and it is the usual reason the fader seems to do nothing.

**Quickest route:** import the surface test page that ships with this module and press
its `+10` button once. That creates `cc1_fader`, which then appears in the dropdown.
Otherwise add it by hand under **Variables → Custom Variables**.

Then:

1. **Fader position** → `cc1_fader`. Move the fader and it tracks 0–100.
2. **Motor fader target** → an expression to follow, for example a camera's iris
   percentage such as `$(PTZ_4:irisPositionPct)`. The fader physically moves to match.
   Leave it empty if nothing should drive the motor.

The motor is ignored while you are touching the fader, so it never fights your hand.

Point the two fields at **different** things in normal use. Aiming both at the same
variable is a loop: the fader writes it, and it drives the motor back to where the fader
already is. (The test page does this deliberately, to show both directions at once.)

## Button lights

15 of the 17 buttons have an LED. The pair beside the screen has none — that is the
hardware, not a fault.

LEDs follow the colour of the Companion button, snapped to the nine the device can
show: blue, orange, yellow, purple, light blue, pink, red, green and white. A button
that is nearly black leaves its LED off. Brightness is normalised, so a dark red button
still lights red.

## Page navigation

Ticking **"Buttons 1 / 2 change page"** lets the two buttons beside the screen step
pages. Those presses are still delivered as ordinary button presses too, so leave the
cells at row 4 columns 0 and 1 empty when you use page nav.

## Troubleshooting

**The surface does not appear.** Make sure nothing else holds the port — Yamaha
ControlCenter, Cubase, or a second copy of Companion.

**Linux.** The port is `root:dialout`, so the user running Companion must be in the
`dialout` group, and group changes only apply to newly started processes — restart the
session, not just Companion. If ModemManager is installed it may probe the device; a
udev rule setting `ID_MM_DEVICE_IGNORE` for USB `0499:140f` stops that.

**The screen freezes.** The module notices when the device stops acknowledging and
reconnects itself within a few seconds. If it stays unresponsive, unplug it and plug it
back in — repeated rapid reconnects can leave the USB serial driver stuck until then.

**Logs.** The module logs as `cc1-surface`. Enable debug logging to trace every button,
encoder and fader event as it decodes.
