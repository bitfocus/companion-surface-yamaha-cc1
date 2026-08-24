/**
 * CC1 (CC121MK2) serial protocol codec — TypeScript port of driver/cc1_proto.py.
 * Verified against a real USBPcap capture of Yamaha ControlCenter (2026-06-30).
 * Transport: USB CDC-ACM serial port (/dev/cu.usbmodem* | COMx | /dev/ttyACM*).
 *
 * Framing (NOT standard SLIP):
 *   frame on the wire = 0xC0 [escaped bytes] 0xC1
 *     0xC0 = START, 0xC1 = END, 0xDB = ESC
 *     escape: 0xC0->DB DC,  0xDB->DB DD,  0xC1->DB DE
 *   inside = PCP frame = [len:u16 LE = N][N payload bytes][checksum]
 *     checksum = (-sum(payload)) & 0xFF ; total = N + 3
 *   payload (message) = [routing:u16 LE][seq:u16 LE][opcode:u16 LE][data...]
 *     routing: host->device = 0x0000/0x0001/0x0002/0x0004 ; device->host = that | 0x8000
 */

const ESC_OUT: Record<number, number> = { 0xc0: 0xdc, 0xdb: 0xdd, 0xc1: 0xde }
const ESC_IN: Record<number, number> = { 0xdc: 0xc0, 0xdd: 0xdb, 0xde: 0xc1 }

export function le16(v: number): Buffer {
	return Buffer.from([v & 0xff, (v >> 8) & 0xff])
}

/** Wrap PCP payload bytes into a 0xC0..0xC1 escaped wire frame. */
export function frameEncode(payload: Uint8Array): Buffer {
	const out: number[] = [0xc0]
	for (const x of payload) {
		const esc = ESC_OUT[x]
		if (esc !== undefined) out.push(0xdb, esc)
		else out.push(x)
	}
	out.push(0xc1)
	return Buffer.from(out)
}

/**
 * Un-escape complete PCP frames from a raw RX byte stream.
 *
 * Unlike the Python original this returns the unconsumed tail, because serial
 * reads split frames at arbitrary boundaries — feed `rest` back in next read
 * instead of dropping a half-received frame.
 */
export function frameSplit(stream: Uint8Array): { frames: Buffer[]; rest: Buffer } {
	const frames: Buffer[] = []
	let i = 0
	let consumed = 0
	while (i < stream.length) {
		if (stream[i] !== 0xc0) {
			i++
			continue
		}
		let j = i + 1
		while (j < stream.length && stream[j] !== 0xc1) j++
		if (j >= stream.length) break // no terminator yet — keep from `i` for next read

		const out: number[] = []
		let esc = false
		for (let k = i + 1; k < j; k++) {
			const b = stream[k]
			if (esc) {
				out.push(ESC_IN[b] ?? b)
				esc = false
			} else if (b === 0xdb) {
				esc = true
			} else {
				out.push(b)
			}
		}
		frames.push(Buffer.from(out))
		i = j + 1
		consumed = i
	}
	return { frames, rest: Buffer.from(stream.subarray(consumed)) }
}

export function pcpWrap(payload: Uint8Array): Buffer {
	let sum = 0
	for (const b of payload) sum += b
	return Buffer.concat([le16(payload.length), Buffer.from(payload), Buffer.from([-sum & 0xff])])
}

export function pcpUnwrap(frame: Uint8Array): { payload: Buffer; ok: boolean } {
	if (frame.length < 3) return { payload: Buffer.alloc(0), ok: false }
	const n = frame[0] | (frame[1] << 8)
	if (n + 3 !== frame.length) return { payload: Buffer.alloc(0), ok: false }
	const payload = Buffer.from(frame.subarray(2, 2 + n))
	let sum = 0
	for (const b of payload) sum += b
	return { payload, ok: (-sum & 0xff) === frame[2 + n] }
}

/** Full wire frame ready to write to the serial port. */
export function buildMessage(opcode: number, data: Uint8Array = Buffer.alloc(0), routing = 1, seq = 0): Buffer {
	// Only channels 0/1/2/4 exist. Catches the routing/seq argument-order footgun that
	// once sent every draw's LCD commit to routing≈seq — invisible content, mute device.
	if (![0, 1, 2, 4].includes(routing & 0x7fff)) throw new Error(`buildMessage: invalid routing ${routing} (seq passed as routing?)`)
	const payload = Buffer.concat([le16(routing), le16(seq), le16(opcode), Buffer.from(data)])
	return frameEncode(pcpWrap(payload))
}

export interface CC1Message {
	routing: number
	seq: number
	opcode: number
	data: Buffer
}

export function parseMessage(payload: Uint8Array): CC1Message | null {
	if (payload.length < 6) return null
	return {
		routing: payload[0] | (payload[1] << 8),
		seq: payload[2] | (payload[3] << 8),
		opcode: payload[4] | (payload[5] << 8),
		data: Buffer.from(payload.subarray(6)),
	}
}

/** The verified wake-up frame (DeviceInfoReq, routing=0 seq=0 opcode=0). */
export const HANDSHAKE = buildMessage(0x0000, Buffer.alloc(0), 0x0000, 0x0000)

// --- input notifies (device->host) — VERIFIED by live capture 2026-06-30 ---
export const OP_SWITCH = 0x0001 // data = [id][state]   state: 1=press, 0=release
export const OP_ENCODER = 0x0002 // data = [id][delta]   delta signed: 0x01=+1 CW, 0xFF=-1 CCW
export const OP_FADER = 0x0004 // data = [00][pos_lo][pos_hi][touch]  pos 10-bit, touch = byte3 & 0x80

export type CC1Input =
	| { type: 'switch'; id: number; pressed: boolean }
	| { type: 'encoder'; id: number; delta: number }
	| { type: 'fader'; position: number; touched: boolean }

/** Turn a parsed device->host message into an input event, or null. */
export function decodeInput(m: CC1Message): CC1Input | null {
	const op = m.opcode & 0x7fff
	const d = m.data
	if (op === OP_SWITCH && d.length >= 2) return { type: 'switch', id: d[0], pressed: d[1] !== 0 }
	if (op === OP_ENCODER && d.length >= 2) return { type: 'encoder', id: d[0], delta: d[1] > 127 ? d[1] - 256 : d[1] }
	if (op === OP_FADER && d.length >= 4)
		return { type: 'fader', position: d[1] | (d[2] << 8), touched: (d[3] & 0x80) !== 0 }
	return null
}

// --- motor fader drive (host->device) — VERIFIED live on the motor 2026-07-01 ---
// Same opcode 0x0004 as FaderStatusReq, but the NONZERO flag byte makes it a
// position SET (FaderPositionControlReq): [fader_idx=00][flag!=0][pos_lo][pos_hi].
// (A layout of [00][pos_lo][pos_hi][x] was wrong — the device read pos as ~3.)
export const FADER_MAX = 1023

export function buildFaderPosition(pos: number, routing = 1, seq = 0, flag = 0x01): Buffer {
	const p = Math.max(0, Math.min(FADER_MAX, Math.round(pos)))
	return buildMessage(0x0004, Buffer.from([0x00, flag, p & 0xff, (p >> 8) & 0x03]), routing, seq)
}

// --- button LEDs (host->device) ---
// Opcode DECODED from the 2026-08-19 ControlCenter USBPcap capture; ids and colours
// MAPPED live on hardware (tools/led-remap.mjs lights one LED and the user presses
// whichever button lit; tools/led-colour.mjs names a colour value). The earlier 0x0180
// guess, taken from the firmware string table, ACKed every frame but never lit anything.
//
//   data = [led_id][colour][state]      state 1 = on, 0 = off
//
// 15 LEDs exist, ids 0x00..0x0e — the same 15 ControlCenter enumerates in its 0x0281
// brightness frame at init. Lighting all 256 ids at once lights those 15 and nothing
// more. Colours are 0..9 (see LED_COLOURS); 10 and above leave the LED dark, which is
// why an early sweep sending [id][id] — colour = id — found nothing for ids >= 0x0a.
//
// led -> button, using the numbering on the project's button map:
//   00=20 01=19 02=18 03=15 04=25 05=17 06=16 07=29 08=28 09=27 0a=26 0b=24 0c=23
//   0d=22 0e=21
//
// The only two buttons with no LED are switch 33 and 34, the pair beside the screen
// printed "1"/"2". Note that those printed numbers are NOT the legends on the keycaps:
// the R, W and D-shaped keys do light, and are switch 8 (0x0e), 6 (0x0d) and 3 (0x0a).
export const OP_LED = 0x0381
export const LED_COUNT = 15

/**
 * The LED palette, named on hardware 2026-08-22 by lighting each value in turn and
 * having the panel read out. Values 0..9 are valid; 10 and above leave the LED dark,
 * which is why an early sweep sending [id][id] found nothing for ids >= 0x0a.
 *
 * The rgb values are approximations of what each looks like on the panel — they exist
 * only so ledColourFor can pick a nearest match, and are the thing to adjust if a
 * Companion colour maps to a shade you would not have chosen.
 */
export const LED_COLOURS: ReadonlyArray<{ value: number; name: string; rgb: [number, number, number] }> = [
	{ value: 0, name: 'blue', rgb: [0, 0, 255] },
	{ value: 1, name: 'orange', rgb: [255, 120, 0] },
	{ value: 2, name: 'yellow', rgb: [255, 255, 0] },
	{ value: 3, name: 'purple', rgb: [150, 0, 255] },
	{ value: 4, name: 'sky blue', rgb: [110, 190, 255] },
	{ value: 5, name: 'pink', rgb: [255, 80, 170] },
	{ value: 6, name: 'red', rgb: [255, 0, 0] },
	{ value: 7, name: 'green', rgb: [0, 255, 0] },
	{ value: 8, name: 'yellow-green', rgb: [170, 255, 0] },
	{ value: 9, name: 'white', rgb: [255, 255, 255] },
]

/**
 * Nearest palette colour for an arbitrary RGB, or null if the colour reads as off.
 *
 * Two wrinkles, both there to make the match look right rather than merely be
 * arithmetically closest:
 *
 * - Brightness is normalised away first, so a dim red cell picks red instead of
 *   collapsing towards black. The LED has no brightness control of its own.
 * - Distance is the "redmean" weighting rather than plain RGB distance, which is
 *   closer to how the eye judges similarity — plain distance is happy to call a
 *   saturated cyan "green".
 */
export function ledColourFor(r: number, g: number, b: number): number | null {
	const max = Math.max(r, g, b)
	if (!Number.isFinite(max) || max < 24) return null // near-black: leave the LED off
	const scale = 255 / max
	const [R, G, B] = [r * scale, g * scale, b * scale]
	let best = LED_COLOURS[0]
	let bestDist = Infinity
	for (const c of LED_COLOURS) {
		const rMean = (R + c.rgb[0]) / 2
		const dR = R - c.rgb[0]
		const dG = G - c.rgb[1]
		const dB = B - c.rgb[2]
		const d = (2 + rMean / 256) * dR * dR + 4 * dG * dG + (2 + (255 - rMean) / 256) * dB * dB
		if (d < bestDist) {
			bestDist = d
			best = c
		}
	}
	return best.value
}

export function buildLed(ledId: number, on: boolean | number = true, routing = 1, seq = 0, colour = 0x01): Buffer {
	return buildMessage(OP_LED, Buffer.from([ledId & 0xff, colour & 0xff, on ? 1 : 0]), routing, seq)
}

// LedsBrightnessControlReq op 0x0281: [id][level]*n. Only visible once lit via 0x0180.
export function buildLedBrightnessAll(level = 0xae, n = 15, routing = 1, seq = 0): Buffer {
	const body = Buffer.alloc(n * 2)
	for (let i = 0; i < n; i++) {
		body[i * 2] = i
		body[i * 2 + 1] = level & 0xff
	}
	return buildMessage(0x0281, body, routing, seq)
}

// --- LCD touchscreen (host->device) — DECODED from capture 2026-07-01 ---
// One 480x272 colour TFT (12 cells, 4 cols x 3 rows). LcdPaintReq op 0x0182:
//   data = [0000][x0 u16][y0 u16][x1 u16][y1 u16] + RGB565-LE pixels (row-major)
// rect is INCLUSIVE (w = x1-x0+1). LcdUpdateControlReq op 0x0282 commits/flushes.
export const LCD_W = 480
export const LCD_H = 272
export const OP_LCD = 0x0182
export const OP_LCD_COMMIT = 0x0282

export function rgb565(r: number, g: number, b: number): number {
	return ((r & 0xf8) << 8) | ((g & 0xfc) << 3) | (b >> 3)
}

/**
 * Paint a w*h region at (x0,y0). `rgb` is row-major RGB triplets (w*h*3 bytes) —
 * the exact shape Companion hands over as SurfaceDrawProps.image with format 'rgb'.
 */
export function buildLcdTile(x0: number, y0: number, w: number, h: number, rgb: Uint8Array, routing = 1, seq = 0): Buffer {
	const px = w * h
	if (rgb.length < px * 3) throw new Error(`buildLcdTile: need ${px * 3} bytes for ${w}x${h}, got ${rgb.length}`)
	const body = Buffer.alloc(px * 2)
	for (let i = 0; i < px; i++) {
		const v = rgb565(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2])
		body[i * 2] = v & 0xff
		body[i * 2 + 1] = (v >> 8) & 0xff
	}
	const hdr = Buffer.concat([le16(0), le16(x0), le16(y0), le16(x0 + w - 1), le16(y0 + h - 1)])
	return buildMessage(OP_LCD, Buffer.concat([hdr, body]), routing, seq)
}

/** Commit/flush painted tiles. Without this the panel keeps showing the old frame. */
export function buildLcdCommit(routing = 1, seq = 0): Buffer {
	return buildMessage(OP_LCD_COMMIT, Buffer.from([0x00]), routing, seq)
}

// --- session init (host->device) — replayed from the ControlCenter capture ---
// Painting alone leaves a dark panel: 0x0082 is the LCD backlight, and 0x0204 puts
// the fader in touch-sensitive mode so the motor releases while it is held.
export const OP_FADER_TOUCH_MODE = 0x0204
export const OP_LCD_BACKLIGHT = 0x0082
export const OP_PANEL_MODE = 0x0104

/** LCD backlight level. Without this the panel stays dark however much you paint. */
export function buildLcdBacklight(level = 0xae, seq = 0, routing = 1): Buffer {
	return buildMessage(OP_LCD_BACKLIGHT, Buffer.from([0x00, level & 0xff]), routing, seq)
}

/**
 * Startup frames sent AFTER the handshake has been answered.
 *
 * The device drops anything that arrives before it has replied with DeviceInfoResp,
 * so these must not be written in the same tick as HANDSHAKE — wait for the reply
 * first (driver/cc1_satellite.py does the same with a 0.3s sleep). Sending them too
 * early leaves the LCD dark, because the 0x0082 backlight frame is simply ignored.
 */
export function buildPostHandshakeInit(backlight = 0xae): Buffer[] {
	return [
		buildMessage(OP_FADER_TOUCH_MODE, Buffer.from([0x00]), 2, 1),
		buildMessage(OP_PANEL_MODE, Buffer.from([0x00, 0x07]), 1, 2),
		// Backlight LAST. Panel mode (0x0104) appears to re-init the display, so sending
		// it after 0x0082 leaves the screen dark with content painted into it — exactly
		// the order driver/cc1_satellite.py uses, and the order proven on the hardware.
		buildLcdBacklight(backlight, 3),
	]
}

/**
 * The full startup sequence ControlCenter sends, in its order and with its sequence
 * numbers — see the first five outbound lines of tools/re/captures/init_sequence.txt.
 * Callers must still pause between element 0 (the handshake) and the rest.
 */
export function buildInitSequence(backlight = 0xae): Buffer[] {
	return [HANDSHAKE, ...buildPostHandshakeInit(backlight)]
}

/** True if this is the device's reply to the handshake (DeviceInfoResp). */
export function isDeviceInfoResp(m: CC1Message): boolean {
	return (m.opcode & 0x7fff) === 0x0000 && (m.routing & 0x8000) !== 0
}

// --- LCD key grid — MAPPED live 2026-07-01 ---
// 12 keys, 4 cols x 3 rows. Presses arrive as Switch op 0x0001.
// Verified press order (L->R, top->bottom): top 21,24,27,30 / mid 22,25,28,31 /
// bottom 23,26,29,32  =>  switch id = 21 + 3*col + row  (column-major).
export const LCD_COLS = 4
export const LCD_ROWS = 3
export const LCD_KEYS = 12

// Key apertures are 72x72 squares (NOT edge-to-edge), measured from the ground-truth
// Cubase capture: content x-runs 15/141/267/393, rows ~3/98/194.
export const LCD_KEY_W = 72
export const LCD_KEY_H = 72
const LCD_COL_X = [15, 141, 267, 393]
const LCD_ROW_Y = [3, 98, 194]

export function lcdKeySwitchId(row: number, col: number): number {
	return 21 + 3 * col + row
}

/** Switch id (21..32) -> row-major key index 0..11, or null if not an LCD key. */
export function lcdSwitchIdToKey(sid: number): number | null {
	if (sid < 21 || sid > 32) return null
	const col = Math.floor((sid - 21) / 3)
	const row = (sid - 21) % 3
	return row * LCD_COLS + col
}

/** Row-major key index 0..11 -> pixel aperture on the 480x272 panel. */
export function lcdKeyRect(keyIndex: number): { x0: number; y0: number; w: number; h: number } {
	const row = Math.floor(keyIndex / LCD_COLS)
	const col = keyIndex % LCD_COLS
	return { x0: LCD_COL_X[col], y0: LCD_ROW_Y[row], w: LCD_KEY_W, h: LCD_KEY_H }
}

// --- physical panel map (buttons + RC encoders) — MAPPED live 2026-07-01 ---
// 6 push-encoders: rotation = encoder id 0..5 (op 0x0002); push-click = Switch id 12+id.
// 17 plain buttons: the Switch ids below (device labels "1-2, 15-29").
export const PANEL_ENCODER_IDS = [0, 1, 2, 3, 4, 5]
export const PANEL_BUTTON_SWITCH_IDS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 18, 19, 20, 33, 34]
export const PANEL_KEYS_PER_ROW = 6
export const PANEL_FADER_KEY = PANEL_ENCODER_IDS.length + PANEL_BUTTON_SWITCH_IDS.length // 23
export const PANEL_KEYS_TOTAL = PANEL_FADER_KEY + 1 // 24 (incl. fader)

/** The device's own physical button numbers (from the button map), by Switch id. */
export const PANEL_BUTTON_LABELS: Record<number, string> = {
	33: '1', 34: '2', 11: '15', 20: '16', 19: '17', 9: '18', 10: '19', 7: '20',
	8: '21', 6: '22', 5: '23', 4: '24', 18: '25', 3: '26', 2: '27', 1: '28', 0: '29',
}

export function panelEncoderClickSwitch(eid: number): number {
	return 12 + eid
}

/** Physical Switch id -> panel surface key index, or null if not a panel button. */
export function panelSwitchToKey(sid: number): number | null {
	if (sid >= 12 && sid <= 17) return sid - 12 // encoder push-click -> its encoder key 0..5
	const idx = PANEL_BUTTON_SWITCH_IDS.indexOf(sid)
	return idx === -1 ? null : PANEL_ENCODER_IDS.length + idx
}

/** Encoder id -> panel surface key index (encoder keys are 0..5). */
export function panelEncoderToKey(eid: number): number | null {
	return PANEL_ENCODER_IDS.includes(eid) ? eid : null
}
