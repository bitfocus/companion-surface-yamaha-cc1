/**
 * Self-check for the CC1 codec. Run: npx tsx src/cc1-proto.test.ts
 * Anchored on bytes from the verified USBPcap capture, not on this port's own output.
 */
import assert from 'node:assert/strict'
import {
	HANDSHAKE, buildMessage, parseMessage, pcpWrap, pcpUnwrap, frameEncode, frameSplit,
	decodeInput, buildFaderPosition, buildLed, buildLcdTile, rgb565,
	lcdKeySwitchId, lcdSwitchIdToKey, lcdKeyRect, panelSwitchToKey, panelEncoderToKey,
	buildInitSequence, buildLcdCommit, ledColourFor, LED_COLOURS,
	OP_SWITCH, OP_ENCODER, OP_FADER, OP_LCD,
} from './cc1-proto.js'

// 1. The wake-up frame must match the capture byte-for-byte.
// Ground truth = line 1 of tools/re/captures/init_sequence.txt:
//   O route=0x0000 seq=0x0000 op=0x0000 data= wire=c0060000000000000000c1
assert.equal(HANDSHAKE.toString('hex'), 'c0060000000000000000c1', 'handshake wire bytes')

// 2. Round-trip through the full stack.
const payload = Buffer.from([0x01, 0x00, 0x05, 0x00, 0x80, 0x01, 0xaa, 0xbb])
const { frames, rest } = frameSplit(frameEncode(pcpWrap(payload)))
assert.equal(frames.length, 1)
assert.equal(rest.length, 0)
const un = pcpUnwrap(frames[0])
assert.ok(un.ok, 'checksum verifies')
assert.deepEqual(un.payload, payload)

// 3. Escaping: payload containing all three reserved bytes must survive intact.
const nasty = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0, 0xc1, 0xdb])
const rt = frameSplit(frameEncode(pcpWrap(nasty)))
assert.deepEqual(pcpUnwrap(rt.frames[0]).payload, nasty, 'escaped bytes round-trip')

// 4. Streaming: a frame split across two reads must not be lost.
const wire = Buffer.concat([frameEncode(pcpWrap(payload)), frameEncode(pcpWrap(payload))])
const first = frameSplit(wire.subarray(0, wire.length - 4))
assert.equal(first.frames.length, 1, 'one complete frame from a partial buffer')
const second = frameSplit(Buffer.concat([first.rest, wire.subarray(wire.length - 4)]))
assert.equal(second.frames.length, 1, 'tail carried over completes the second frame')

// 5. Input decode, including the signed encoder delta and the fader touch bit.
const sw = decodeInput(parseMessage(pcpUnwrap(frameSplit(buildMessage(OP_SWITCH | 0x8000, Buffer.from([21, 1]), 0x8001)).frames[0]).payload)!)
assert.deepEqual(sw, { type: 'switch', id: 21, pressed: true })

const enc = decodeInput({ routing: 0x8001, seq: 0, opcode: OP_ENCODER | 0x8000, data: Buffer.from([3, 0xff]) })
assert.deepEqual(enc, { type: 'encoder', id: 3, delta: -1 }, 'CCW decodes as -1')

const fad = decodeInput({ routing: 0x8001, seq: 0, opcode: OP_FADER | 0x8000, data: Buffer.from([0x00, 0xff, 0x03, 0x80]) })
assert.deepEqual(fad, { type: 'fader', position: 1023, touched: true }, 'fader at max, touched')

// 6. Motor fader layout is [00][flag][lo][hi] — the [00][lo][hi][x] variant was wrong.
const fpos = pcpUnwrap(frameSplit(buildFaderPosition(1023)).frames[0]).payload
assert.deepEqual(fpos.subarray(6), Buffer.from([0x00, 0x01, 0xff, 0x03]), 'FaderPositionControlReq data layout')

// 7. LED frame shape — anchored on the 2026-08-19 ControlCenter capture (op 0x0381,
// d=020101 lit the LED; live probe confirmed a repeated single id lights that LED).
const led = pcpUnwrap(frameSplit(buildLed(0x02, true)).frames[0]).payload
assert.deepEqual(led.subarray(4), Buffer.from([0x81, 0x03, 0x02, 0x01, 0x01]), 'opcode 0x0381 + [id][colour][on]')
assert.deepEqual(pcpUnwrap(frameSplit(buildLed(0x02, false)).frames[0]).payload.subarray(4), Buffer.from([0x81, 0x03, 0x02, 0x01, 0x00]), 'off form')
// The colour byte must never carry the led id: ids >= 0x0a are invalid colours and
// the LED silently stays dark — that bug hid three LEDs through two correlation runs.
assert.equal(pcpUnwrap(frameSplit(buildLed(0x0c, true)).frames[0]).payload[7], 0x01, 'high ids still get a valid colour')

// 7b. Colour matching — palette named on hardware; values >= 10 leave the LED dark, so
// the matcher must only ever return one of the ten valid values.
assert.equal(ledColourFor(255, 0, 0), 6, 'red')
assert.equal(ledColourFor(0, 255, 0), 7, 'green')
assert.equal(ledColourFor(0, 0, 255), 0, 'blue')
assert.equal(ledColourFor(255, 255, 255), 9, 'white')
assert.equal(ledColourFor(255, 255, 0), 2, 'yellow')
assert.equal(ledColourFor(128, 255, 0), 8, 'lime picks yellow-green, not yellow')
assert.equal(ledColourFor(0, 255, 255), 4, 'cyan picks sky blue')
assert.equal(ledColourFor(0, 0, 0), null, 'black leaves the LED off')
assert.equal(ledColourFor(64, 0, 0), 6, 'a dim red is still red, not off')
assert.equal(ledColourFor(120, 120, 120), 9, 'grey reads as white')
for (const c of [[12, 34, 56], [200, 30, 90], [1, 250, 100], [255, 200, 40]]) {
	const v = ledColourFor(c[0], c[1], c[2])
	assert.ok(v !== null && v >= 0 && v <= 9, `colour ${v} is a valid palette value`)
}
assert.equal(LED_COLOURS.length, 10, 'ten colours, values 0..9')
assert.deepEqual(LED_COLOURS.map((c) => c.value), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 'contiguous values')

// 8. LCD key grid: verified press order was top row 21,24,27,30 (column-major ids).
assert.deepEqual([0, 1, 2, 3].map((c) => lcdKeySwitchId(0, c)), [21, 24, 27, 30], 'top row switch ids')
assert.deepEqual([21, 24, 27, 30].map(lcdSwitchIdToKey), [0, 1, 2, 3], 'top row -> keys 0..3')
assert.deepEqual([22, 25, 28, 31].map(lcdSwitchIdToKey), [4, 5, 6, 7], 'middle row -> keys 4..7')
assert.deepEqual([23, 26, 29, 32].map(lcdSwitchIdToKey), [8, 9, 10, 11], 'bottom row -> keys 8..11')
assert.equal(lcdSwitchIdToKey(20), null)
assert.equal(lcdSwitchIdToKey(33), null, 'panel button 33 is not an LCD key')
assert.deepEqual(lcdKeyRect(0), { x0: 15, y0: 3, w: 72, h: 72 })
assert.deepEqual(lcdKeyRect(11), { x0: 393, y0: 194, w: 72, h: 72 })

// 8b. Init frames must match the capture's bytes, and the backlight must go LAST.
// Panel mode (0x0104) re-inits the display, so a backlight sent before it is undone —
// the screen stays dark with content painted into it. driver/cc1_satellite.py sends
// 0x0204 -> 0x0104 -> 0x0082, which is the order proven on the hardware.
const init = buildInitSequence()
assert.equal(init[0].toString('hex'), 'c0060000000000000000c1', 'handshake first')
assert.equal(init[1].toString('hex'), 'c0070002000100040200f7c1', '0x0204 fader touch mode (matches capture)')
assert.equal(init[3].toString('hex'), 'c0080001000300820000aeccc1', '0x0082 backlight (matches capture)')
assert.equal(init.length, 4, 'handshake + 3 setup frames')

const initOps = init.map((f) => pcpUnwrap(frameSplit(f).frames[0]).payload.readUInt16LE(4))
assert.deepEqual(initOps, [0x0000, 0x0204, 0x0104, 0x0082], 'backlight is the last frame sent')

// The commit carries a single 0x00 payload byte; an empty one does not flush the panel.
assert.equal(pcpUnwrap(frameSplit(buildLcdCommit(1, 9)).frames[0]).payload.toString('hex'), '01000900820200')
// Regression: buildLcdCommit takes (routing, seq). Passing a seq alone routed every
// draw's commit to a bogus channel — painted but never flipped to the glass.
assert.throws(() => buildLcdCommit(300), /invalid routing/, 'seq-as-routing rejected')

// 9. LCD tile: inclusive rect header + RGB565-LE body sized w*h*2.
assert.equal(rgb565(255, 255, 255), 0xffff)
assert.equal(rgb565(0, 0, 0), 0x0000)
const tile = pcpUnwrap(frameSplit(buildLcdTile(15, 3, 2, 2, Buffer.alloc(2 * 2 * 3, 0xff))).frames[0]).payload
assert.equal(tile.readUInt16LE(4), OP_LCD)
assert.deepEqual(tile.subarray(6, 16), Buffer.from([0, 0, 15, 0, 3, 0, 16, 0, 4, 0]), 'inclusive x1/y1')
assert.equal(tile.length - 16, 2 * 2 * 2, 'RGB565 body is w*h*2 bytes')
assert.throws(() => buildLcdTile(0, 0, 2, 2, Buffer.alloc(3)), /need 12 bytes/, 'rejects short pixel buffer')

// 10. Panel map: encoder clicks fold onto their encoder key; buttons follow after.
assert.deepEqual([12, 13, 17].map(panelSwitchToKey), [0, 1, 5], 'encoder push-click -> encoder key')
assert.equal(panelSwitchToKey(0), 6, 'first plain button lands after the 6 encoders')
assert.equal(panelSwitchToKey(34), 22, 'last plain button')
assert.equal(panelSwitchToKey(99), null)
assert.equal(panelEncoderToKey(5), 5)
assert.equal(panelEncoderToKey(6), null)

// 11. Pacing guard: every LCD tile frame — including the small 40x20 clear tiles —
// must exceed the module's pace threshold (1024B). An unpaced tile flood stalls the
// device: dark screen, hung close, wedged CDC driver. This is how that regressed once.
assert.ok(buildLcdTile(0, 0, 40, 20, Buffer.alloc(40 * 20 * 3)).length >= 1024, 'clear tile trips pacing')
assert.ok(buildLcdTile(0, 0, 72, 72, Buffer.alloc(72 * 72 * 3)).length >= 1024, 'key tile trips pacing')

console.log('cc1-proto: all checks passed')
