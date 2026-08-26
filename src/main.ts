/**
 * Yamaha CC1 (CC121MK2) surface module for Companion 5.
 *
 * The device is a plain USB CDC-ACM serial port, so this uses the `scanForSurfaces`
 * path rather than HID. All wire encoding lives in cc1-proto.ts.
 */
import { SerialPort } from 'serialport'
import {
	createModuleLogger,
	parseColor,
	type CardGenerator,
	type DetectionSurfaceInfo,
	type OpenSurfaceResult,
	type SurfaceContext,
	type SurfaceDrawProps,
	type SurfaceInstance,
	type SurfacePlugin,
	type SurfaceSchemaLayoutDefinition,
} from '@companion-surface/base'
import {
	FADER_MAX, LCD_H, LCD_KEYS, LCD_KEY_H, LCD_KEY_W, LCD_W,
	PANEL_BUTTON_LABELS, PANEL_BUTTON_SWITCH_IDS, PANEL_ENCODER_IDS,
	HANDSHAKE, buildFaderPosition, buildLcdBacklight, buildMessage, buildLcdCommit, buildLcdTile, buildLed,
	buildLedBrightnessAll, buildPostHandshakeInit, isDeviceInfoResp, ledColourFor,
	decodeInput, frameSplit, lcdKeyRect, lcdSwitchIdToKey, panelEncoderClickSwitch, parseMessage, pcpUnwrap,
} from './cc1-proto.js'

const VENDOR_ID = 0x0499
const PRODUCT_ID = 0x140f

const OPEN_TIMEOUT_MS = 3000
const HANDSHAKE_TIMEOUT_MS = 500
const POST_HANDSHAKE_GRACE_MS = 300
const INIT_SETTLE_MS = 400
const CLOSE_TIMEOUT_MS = 2000
const TILE_PACE_MS = 4
const KEEPALIVE_MS = 300
/** Paints are always ACKed by a healthy device; this much post-paint silence = stalled session. */
const WATCHDOG_MUTE_MS = 2500

/** Any frame this large is an LCD tile and gets paced. Clear tiles are 1626B — must be below this. */
const PACE_THRESHOLD_BYTES = 1024

/** Open surfaces, so plugin.destroy() can release ports on reload/shutdown. */
const openSurfaces = new Set<CC1Surface>()

/**
 * Buttons 33/34 are the device's "1"/"2" keys, the pair offered for page nav.
 *
 * Their presses go to context.changePage() unconditionally — the HOST decides whether to
 * act, gating on the "Buttons 1 / 2 change page" checkbox it renders from
 * registerProps.canChangePage. Do not gate here as well, as this module used to: a surface
 * module is never told the value of that checkbox (see the updateConfig note below), so a
 * module-side gate is stuck shut and page nav could never fire at all. The built-in Stream
 * Deck Plus module hands its page-nav swipes to the host unconditionally for the same reason.
 */
const PAGE_PREV_SWITCH = 33
const PAGE_NEXT_SWITCH = 34

// --- layout -----------------------------------------------------------------
// 7 rows x 6 columns. Rows 0-2 cols 0-3 = the 12 LCD keys (the only controls with
// a display); row 3 = the 6 push-encoders (RC1..RC6); rows 4-6 = the 17 plain buttons
// in label order; fader at 6/5 (the spare cell after button 29) so the layout stays
// within a 7-row grid.
const LCD_CONTROL_IDS: string[] = []
for (let k = 0; k < LCD_KEYS; k++) LCD_CONTROL_IDS.push(`${Math.floor(k / 4)}/${k % 4}`)

// Row 3 in RC order, RC1..RC6 left-to-right. Encoder ids from the live panel mapping
// (driver/cc1_satellite.py): RC1=enc2 RC2=enc3 RC3=enc4 RC4=enc5 RC5=enc1 RC6=enc0 (jog).
const ENCODER_IDS_BY_RC = [2, 3, 4, 5, 1, 0]
const ENC_TO_CONTROL = new Map(ENCODER_IDS_BY_RC.map((eid, i) => [eid, `3/${i}`]))
const ENCODER_CONTROL_IDS = [...ENC_TO_CONTROL.values()]
// Grid order follows the panel's printed labels (1,2,15..29), so row 4 col 0 is the
// button marked "1" — not the internal switch-id order, which is scrambled physically.
const BUTTON_SIDS_BY_LABEL = [...PANEL_BUTTON_SWITCH_IDS].sort(
	(a, b) => Number(PANEL_BUTTON_LABELS[a]) - Number(PANEL_BUTTON_LABELS[b])
)
const BUTTON_CONTROL_IDS = BUTTON_SIDS_BY_LABEL.map((_sid, i) => `${4 + Math.floor(i / 6)}/${i % 6}`)
const FADER_CONTROL_ID = '6/5'

/** switch id -> control id, for every physical switch that maps to a control. */
const SWITCH_TO_CONTROL = new Map<number, string>()
for (let k = 0; k < LCD_KEYS; k++) SWITCH_TO_CONTROL.set(21 + 3 * (k % 4) + Math.floor(k / 4), LCD_CONTROL_IDS[k])
PANEL_ENCODER_IDS.forEach((eid) => SWITCH_TO_CONTROL.set(panelEncoderClickSwitch(eid), ENC_TO_CONTROL.get(eid)!))
BUTTON_SIDS_BY_LABEL.forEach((sid, i) => SWITCH_TO_CONTROL.set(sid, BUTTON_CONTROL_IDS[i]))

/**
 * What a switch press should do: offer it to the host as page nav, press a control, or both.
 * Exported so the both-at-once behaviour is testable without hardware attached.
 */
export function switchRoute(id: number): { pageNav: 'prev' | 'next' | null; controlId: string | undefined } {
	return {
		pageNav: id === PAGE_PREV_SWITCH ? 'prev' : id === PAGE_NEXT_SWITCH ? 'next' : null,
		controlId: SWITCH_TO_CONTROL.get(id),
	}
}

/** control id -> LCD key index (0..11), for the bitmap controls. */
const CONTROL_TO_LCD_KEY = new Map(LCD_CONTROL_IDS.map((id, k) => [id, k]))

/**
 * control id -> LED id, from the hardware-verified correlation (2026-08-19,
 * tools/led-remap.mjs: light each LED via opcode 0x0381, user presses the lit key).
 * All 15 of the device's LEDs (ids 0x00..0x0e) are mapped. The only two buttons
 * without one are switch 33 and 34 — the pair beside the screen, printed "1"/"2".
 * (The R, W and D-shaped keys do light: they are switches 8, 6 and 3 respectively.)
 */
const SWITCH_TO_LED: Record<number, number> = {
	7: 0x00, 10: 0x01, 9: 0x02, 11: 0x03, 18: 0x04, 19: 0x05, 20: 0x06, 0: 0x07,
	1: 0x08, 2: 0x09, 3: 0x0a, 4: 0x0b, 5: 0x0c, 6: 0x0d, 8: 0x0e,
}
const CONTROL_TO_LED = new Map<string, number>()
BUTTON_SIDS_BY_LABEL.forEach((sid, i) => {
	if (SWITCH_TO_LED[sid] !== undefined) CONTROL_TO_LED.set(BUTTON_CONTROL_IDS[i], SWITCH_TO_LED[sid])
})

function buildLayout(): SurfaceSchemaLayoutDefinition {
	const controls: SurfaceSchemaLayoutDefinition['controls'] = {}
	const put = (id: string, stylePreset?: string) => {
		const [row, column] = id.split('/').map(Number)
		controls[id] = stylePreset ? { row, column, stylePreset } : { row, column }
	}
	LCD_CONTROL_IDS.forEach((id) => put(id, 'lcd'))
	ENCODER_CONTROL_IDS.forEach((id) => put(id))
	BUTTON_CONTROL_IDS.forEach((id) => put(id))
	put(FADER_CONTROL_ID)

	return {
		stylePresets: {
			// Non-display controls only need a colour for their backlight.
			default: { colors: 'rgb' },
			lcd: { bitmap: { w: LCD_KEY_W, h: LCD_KEY_H, format: 'rgb' } },
		},
		controls,
	}
}

// --- surface ----------------------------------------------------------------
class CC1Surface implements SurfaceInstance {
	readonly surfaceId: string
	readonly productName = 'Yamaha CC121MK2'

	readonly #logger = createModuleLogger('cc1-surface')
	readonly #context: SurfaceContext
	readonly #path: string

	#port: SerialPort | undefined
	#rx: Buffer<ArrayBufferLike> = Buffer.alloc(0)
	#seq = 0
	/** Set while we are deliberately closing, so teardown doesn't re-enter via disconnect(). */
	#closing = false
	/** Last position reported by the fader, so the motor isn't driven against the user's hand. */
	#faderTouched = false
	#faderLogAt = 0
	/** Watchdog: when we last parsed anything from the device vs last tile we wrote. */
	#lastRxAt = Date.now()
	#lastTileTxAt = 0
	#watchdog: ReturnType<typeof setInterval> | undefined
	/** Set while init() waits for DeviceInfoResp. */
	#onHandshake: (() => void) | null = null
	/** Serialises and paces every outbound frame — see #write/#send. */
	#txChain: Promise<void> = Promise.resolve()
	/** 300ms keepalive (op 0x0000 routing=4), as ControlCenter sends — without it the
	 * device times out the host session and goes unresponsive. */
	#keepalive: ReturnType<typeof setInterval> | undefined

	constructor(surfaceId: string, path: string, context: SurfaceContext) {
		this.surfaceId = surfaceId
		this.#path = path
		this.#context = context
	}

	async init(): Promise<void> {
		this.#port = await new Promise<SerialPort>((resolve, reject) => {
			let settled = false
			// hupcl:false = keep DTR asserted when the port closes. The firmware treats a DTR
			// drop as "host gone" and goes mute until USB re-enumeration (a physical replug) —
			// verified on hardware 2026-08-14. Without this, every reopen needs a replug.
			//
			// WINDOWS: node-serialport gives this flag the OPPOSITE meaning. Its win32 binding
			// compiles hupcl:false to DCB fDtrControl = DTR_CONTROL_DISABLE — DTR is never
			// asserted AT ALL, not merely held across close (@serialport/bindings-cpp
			// src/serialport_win.cpp:123). With DTR low the CC1 still renders everything we
			// write — the LCD lights and paints normally — but transmits NOTHING back: no
			// DeviceInfoResp, no paint ACKs and no switch/encoder/fader notifies, so every
			// button press is silently dead. Diagnosed 2026-08-19 from Companion log lines
			// where the handshake wait expired at exactly HANDSHAKE_TIMEOUT_MS on every open
			// and the paint watchdog then fired having received nothing at all.
			//
			// So on Windows raise DTR explicitly after open (#assertDtr) instead of flipping
			// hupcl: leaving fDtrControl on DTR_CONTROL_DISABLE still stops the driver dropping
			// DTR for us at close, which is the whole point of hupcl:false everywhere else.
			const port = new SerialPort({ path: this.#path, baudRate: 115200, autoOpen: true, hupcl: false }, (err) => {
				if (settled) {
					// Opened after we gave up waiting — don't leak the handle.
					if (!err) port.close(() => undefined)
					return
				}
				settled = true
				clearTimeout(timer)
				if (err)
					reject(
						new Error(
							`Failed to open ${this.#path}: ${err.message}. Is ControlCenter, the Stream Deck app, or another copy of this driver running?`
						)
					)
				else resolve(port)
			})
			// macOS can block indefinitely opening a cu.* device another process holds,
			// which surfaces to the user as the host's opaque "Call timed out". Bound it
			// so they get a message that names the cause.
			const timer = setTimeout(() => {
				if (settled) return
				settled = true
				reject(
					new Error(
						`Timed out opening ${this.#path}. Either another process holds it (ControlCenter / Stream Deck / another copy of this driver), ` +
							`or the device is wedged — repeated rapid reconnects can leave the CDC driver in an uninterruptible state. Unplug the CC1 and plug it back in.`
					)
				)
			}, OPEN_TIMEOUT_MS)
		})

		if (process.platform === 'win32') await this.#assertDtr()

		this.#port.on('data', (chunk: Buffer) => this.#onData(chunk))
		this.#port.on('error', (err) => {
			if (!this.#closing) this.#context.disconnect(err)
		})
		this.#port.on('close', () => {
			if (!this.#closing) this.#context.disconnect(new Error('Serial port closed'))
		})

		// The device ignores everything until it has answered the handshake, so wait for
		// DeviceInfoResp before sending the rest. Skipping this wait leaves the LCD dark:
		// the 0x0082 backlight frame arrives too early and is silently dropped.
		this.#logger.info(`serial open: ${this.#path}`)
		this.#write(HANDSHAKE)
		if (await this.#awaitHandshake()) {
			this.#logger.info('handshake answered; sending init')
		} else {
			// Init still goes out (it costs nothing and the device may just be slow), but a
			// silent handshake means we are almost certainly receiving nothing at all — the
			// panel will paint and every button, encoder and fader move will be dead.
			this.#logger.warn(
				`no handshake reply from ${this.#path} within ${HANDSHAKE_TIMEOUT_MS}ms — the device is not sending to us. ` +
					'The display may still work while all input stays dead.'
			)
		}
		// The device answers the handshake within ~2ms but is not ready for config yet —
		// sending the init frames immediately after the reply leaves them unACKed and the
		// screen dark. The Python driver always waited a flat 300ms here; match it.
		await new Promise((r) => setTimeout(r, POST_HANDSHAKE_GRACE_MS))

		// Backlight, fader touch mode and panel mode.
		for (const frame of buildPostHandshakeInit()) this.#write(frame)
		this.#seq = 4 // the init frames consume seq 0-4
		// Let the device apply the init before the 168-tile clear flood. Without this
		// settle the backlight frame is lost under the burst and the screen stays dark —
		// verified on hardware: with a 400ms pause the panel lights, without it, black.
		await new Promise((r) => setTimeout(r, INIT_SETTLE_MS))
		this.#clearScreen()
		await this.#flush(3000) // the queued clear is ~170 paced frames; hand them over before ready
		this.#keepalive = setInterval(() => this.#write(buildMessage(0x0000, Buffer.alloc(0), 4, this.#nextSeq())), KEEPALIVE_MS)
		// Self-healing: keepalives are never ACKed but paints always are. If tiles have
		// gone out since we last heard anything and the silence has lasted, the device
		// session has stalled — hand back to the host, which reopens and re-inits us.
		// (Before this, a stalled session meant a physical replug.)
		this.#watchdog = setInterval(() => {
			if (this.#closing || !this.#lastTileTxAt) return
			if (this.#lastTileTxAt > this.#lastRxAt && Date.now() - this.#lastTileTxAt > WATCHDOG_MUTE_MS) {
				clearInterval(this.#watchdog)
				this.#logger.warn('device stopped acknowledging paints — recycling the session')
				this.#context.disconnect(new Error('CC1 stopped acknowledging paints — reconnecting'))
			}
		}, 2000)
		this.#logger.info('init complete: backlight on, screen cleared, keepalive running')
	}

	/**
	 * Raise DTR on Windows, where the port was opened with fDtrControl = DTR_CONTROL_DISABLE
	 * (see the hupcl note in init()). EscapeCommFunction SETDTR works regardless of the DCB,
	 * so this leaves the close-time behaviour alone and only brings the line up. Without it
	 * the CC1 sees no host, paints happily and never sends a single byte back.
	 */
	async #assertDtr(): Promise<void> {
		const port = this.#port
		if (!port) return
		await new Promise<void>((resolve) => {
			port.set({ dtr: true, rts: true }, (err) => {
				// Not fatal on its own — log it and let the handshake wait report the real symptom.
				if (err) this.#logger.warn(`could not raise DTR on ${this.#path}: ${err.message}`)
				resolve()
			})
		})
	}

	/** Resolve when the device answers the handshake, or after a short grace period. */
	async #awaitHandshake(): Promise<boolean> {
		const answered = await new Promise<boolean>((resolve) => {
			const timer = setTimeout(() => resolve(false), HANDSHAKE_TIMEOUT_MS)
			this.#onHandshake = () => {
				clearTimeout(timer)
				resolve(true)
			}
		})
		this.#onHandshake = null
		return answered
	}

	async close(): Promise<void> {
		openSurfaces.delete(this)
		clearInterval(this.#keepalive)
		clearInterval(this.#watchdog)
		const port = this.#port
		this.#port = undefined
		this.#closing = true
		if (!port) return

		// Leave every listener ATTACHED. The #closing flag already turns the close/error
		// handlers into no-ops, so there is no re-entry and no unhandled 'error' event.
		// Do NOT strip the data listener and do NOT force-destroy on a slow close:
		// yanking the fd while the CDC driver has a read in flight is what degrades the
		// device (next open mute, the one after wedged in the kernel until a replug).
		// Verified on hardware: a plain close() with listeners intact returns promptly
		// and the device stays healthy — the same close the Python driver always used.
		await this.#flush(1500) // paced queue drains fast once writes are honoured
		if (!port.isOpen) return
		await Promise.race([
			new Promise<void>((resolve) => port.close(() => resolve())),
			// Bound the wait so a host destroy can't hang, but never destroy() the port —
			// process exit will reap the fd more gently than ripping it out mid-read.
			new Promise<void>((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS)),
		])
	}

	/**
	 * Deliberately a no-op. Companion only forwards fields the module declared itself in
	 * registerProps.configFields (it filters on a "plugin_cfg_" prefix — see YU() in
	 * Companion's main.js), and this module declares none, so `config` is always {}.
	 * Host-level settings — brightness, rotation, the transfer-variable bindings and
	 * canChangePage — are applied by the host and never reach us.
	 *
	 * Kept rather than omitted so the host stops logging "updateConfig not supported" every
	 * time the user touches a surface setting.
	 */
	async updateConfig(_config: Record<string, any>): Promise<void> {}

	async ready(): Promise<void> {
		// Panel is already initialised in init(); nothing extra needed to start drawing.
	}

	async setBrightness(percent: number): Promise<void> {
		// 100% maps to 0xAE, ControlCenter's own level — the only value proven on this
		// hardware. 0xFF is out of the observed range and suspected of blanking the
		// backlight, which made every Companion session (which always sets brightness
		// right after init) go black while standalone sessions (which never do) worked.
		const level = Math.round((Math.max(0, Math.min(100, percent)) / 100) * 0xae)
		this.#write(buildLedBrightnessAll(level, 15, 1, this.#nextSeq()))
		this.#write(buildLcdBacklight(level, this.#nextSeq()))
	}

	async blank(): Promise<void> {
		this.#clearScreen()
		for (const ledId of CONTROL_TO_LED.values()) this.#setLed(ledId, null)
	}

	async draw(signal: AbortSignal, drawProps: SurfaceDrawProps): Promise<void> {
		if (signal.aborted) return
		const key = CONTROL_TO_LCD_KEY.get(drawProps.controlId)
		if (key !== undefined) {
			const image = drawProps.image
			if (!image || image.length < LCD_KEY_W * LCD_KEY_H * 3) return
			this.#paintKey(key, image)
			this.#write(buildLcdCommit(1, this.#nextSeq()))
			return
		}

		const ledId = CONTROL_TO_LED.get(drawProps.controlId)
		if (ledId !== undefined) {
			// LEDs are on/off only — light when the cell's colour is anything but near-black.
			// Companion sends "rgba(r,g,b,a)" strings, which parseColor mangles (r=NaN) —
			// parse them directly and keep parseColor only as the fallback.
			// Companion sends "rgba(r,g,b,a)" strings, which parseColor mangles (r=NaN) —
			// parse them directly and keep parseColor only as the fallback.
			const m = /^rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(drawProps.color ?? '')
			const { r, g, b } = m ? { r: +m[1], g: +m[2], b: +m[3] } : parseColor(drawProps.color)
			this.#setLed(ledId, ledColourFor(r, g, b))
		}
	}

	onVariableValue(name: string, value: any): void {
		if (name !== 'faderMotor') return
		// Don't fight the user's hand while they're holding the fader.
		if (this.#faderTouched) return
		const pct = Number(value)
		if (!Number.isFinite(pct)) return
		this.#write(buildFaderPosition((Math.max(0, Math.min(100, pct)) / 100) * FADER_MAX, 1, this.#nextSeq()))
	}

	async showStatus(signal: AbortSignal, cardGenerator: CardGenerator, _statusMessage: string): Promise<void> {
		const card = await cardGenerator.generateLogoCard(LCD_KEY_W, LCD_KEY_H, 'rgb')
		if (signal.aborted) return
		for (let k = 0; k < LCD_KEYS; k++) this.#paintKey(k, card)
		this.#write(buildLcdCommit(1, this.#nextSeq()))
	}

	// --- internals ---
	#nextSeq(): number {
		this.#seq = (this.#seq + 1) & 0xffff
		return this.#seq
	}

	/**
	 * All outbound frames go through one paced queue. Unpaced bursts (the 12-key paint
	 * is ~125KB) stall the device's protocol parser: tiles never reach the panel (dark
	 * screen), the OS buffer backs up (close hangs on the unflushed fd), and killing
	 * the process in that state wedges the CDC driver until a replug. Every paint that
	 * worked on hardware was paced; every flood failed. So: honour stream backpressure,
	 * and give the device a breather after each large (tile) frame.
	 */
	/** Set one LED to a palette colour, or clear it when colour is null. */
	#setLed(ledId: number, colour: number | null): void {
		this.#write(buildLed(ledId, colour !== null, 1, this.#nextSeq(), colour ?? 0x01))
	}

	#write(frame: Buffer): void {
		this.#txChain = this.#txChain.then(() => this.#send(frame)).catch(() => undefined)
	}

	async #send(frame: Buffer): Promise<void> {
		const port = this.#port
		if (!port?.isOpen) return
		// Bound the drain wait: a 'drain' lost to a port close/error mid-flight would
		// otherwise freeze #txChain forever and silently swallow every later frame.
		if (!port.write(frame))
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, 250)
				port.once('drain', () => {
					clearTimeout(timer)
					resolve()
				})
			})
		// ponytail: flat 4ms pause after every tile-sized frame. The device coped with
		// ~40KB bursts at 8ms gaps; this caps bursts at one tile — comfortably inside
		// the proven envelope. Tune down only with the hardware on the desk.
		if (frame.length >= PACE_THRESHOLD_BYTES) {
			this.#lastTileTxAt = Date.now()
			await new Promise((resolve) => setTimeout(resolve, TILE_PACE_MS))
		}
	}

	/** Resolve when everything queued so far has been handed to the OS. */
	async #flush(maxMs: number): Promise<void> {
		await Promise.race([this.#txChain, new Promise((resolve) => setTimeout(resolve, maxMs))])
	}

	/**
	 * Paint one key in 40x20 sub-tiles — the only tile size the device is proven to
	 * accept. driver/cc1_satellite.py paint_key does exactly this; a single 72x72
	 * frame (10.4KB) was never sent by any working driver and stalls the device.
	 */
	#paintKey(keyIndex: number, rgb: Uint8Array): void {
		const { x0, y0, w, h } = lcdKeyRect(keyIndex)
		for (let ty = 0; ty < h; ty += 20) {
			const th = Math.min(20, h - ty)
			for (let tx = 0; tx < w; tx += 40) {
				const tw = Math.min(40, w - tx)
				const sub = Buffer.alloc(tw * th * 3)
				for (let j = 0; j < th; j++)
					for (let i = 0; i < tw; i++) {
						const src = ((ty + j) * w + (tx + i)) * 3
						const dst = (j * tw + i) * 3
						sub[dst] = rgb[src]
						sub[dst + 1] = rgb[src + 1]
						sub[dst + 2] = rgb[src + 2]
					}
				this.#write(buildLcdTile(x0 + tx, y0 + ty, tw, th, sub, 1, this.#nextSeq()))
			}
		}
	}

	/**
	 * Black the whole 480x272 panel, including the bezel gaps between key apertures
	 * which no key paint ever covers. Tiled at 40x20 — the size ControlCenter uses,
	 * and known to be accepted. Pacing comes from the queue in #send.
	 */
	#clearScreen(): void {
		const black = Buffer.alloc(40 * 20 * 3)
		for (let y = 0; y < LCD_H; y += 20) {
			const h = Math.min(20, LCD_H - y)
			for (let x = 0; x < LCD_W; x += 40) {
				const w = Math.min(40, LCD_W - x)
				this.#write(buildLcdTile(x, y, w, h, black.subarray(0, w * h * 3), 1, this.#nextSeq()))
			}
		}
		this.#write(buildLcdCommit(1, this.#nextSeq()))
	}

	#onData(chunk: Buffer): void {
		const { frames, rest } = frameSplit(Buffer.concat([this.#rx, chunk]))
		this.#rx = rest
		for (const frame of frames) {
			const { payload, ok } = pcpUnwrap(frame)
			if (!ok) continue
			const msg = parseMessage(payload)
			if (!msg) continue
			this.#lastRxAt = Date.now()
			if (this.#onHandshake && isDeviceInfoResp(msg)) this.#onHandshake()
			this.#onInput(msg)
		}
	}

	#onInput(msg: ReturnType<typeof parseMessage> & {}): void {
		const event = decodeInput(msg)
		if (!event) return
		// Debug-level tracing of every input — turn on the module's debug logging to
		// watch presses decode live (this is how the panel mapping was verified).
		if (event.type === 'switch')
			this.#logger.debug(`input: switch ${event.id}${PANEL_BUTTON_LABELS[event.id] ? ` (btn ${PANEL_BUTTON_LABELS[event.id]})` : ''} ${event.pressed ? 'down' : 'up'} -> ${SWITCH_TO_CONTROL.get(event.id) ?? 'unmapped'}`)
		else if (event.type === 'encoder') this.#logger.debug(`input: encoder ${event.id} delta=${event.delta} -> ${ENC_TO_CONTROL.get(event.id) ?? 'unmapped'}`)
		else if (event.touched !== this.#faderTouched || Date.now() - this.#faderLogAt > 500) {
			this.#faderLogAt = Date.now()
			this.#logger.debug(`input: fader pos=${event.position} touched=${event.touched}`)
		}

		if (event.type === 'switch') {
			// Offer the press to the host as page nav AND deliver it as an ordinary press.
			// changePage() is silently dropped unless the user ticked the surface's
			// "Buttons 1 / 2 change page" box, and we never get told which way that box is
			// set — so doing only one of the two would leave buttons 1/2 dead in whichever
			// state we guessed wrong. Doing both keeps them working either way; the cost is
			// that with page nav ON, anything bound to controls 4/0 and 4/1 also fires, so
			// leave those two cells empty when using page nav.
			const { pageNav, controlId } = switchRoute(event.id)
			if (pageNav && event.pressed) this.#context.changePage(pageNav === 'next')
			if (!controlId) return
			if (event.pressed) this.#context.keyDownById(controlId)
			else this.#context.keyUpById(controlId)
			return
		}

		if (event.type === 'encoder') {
			const controlId = ENC_TO_CONTROL.get(event.id)
			if (!controlId) return
			for (let i = 0; i < Math.abs(event.delta); i++) {
				if (event.delta > 0) this.#context.rotateRightById(controlId)
				else this.#context.rotateLeftById(controlId)
			}
			return
		}

		// Fader: touch reads as a press, movement reports position to Companion.
		if (event.touched !== this.#faderTouched) {
			this.#faderTouched = event.touched
			if (event.touched) this.#context.keyDownById(FADER_CONTROL_ID)
			else this.#context.keyUpById(FADER_CONTROL_ID)
		}
		// Report to one decimal place. The fader is 10-bit (1024 positions), so rounding to
		// a whole percent would throw away most of it — 101 steps, barely 7 bits. One
		// decimal gives 1001 steps, which is the hardware's resolution to within a count.
		this.#context.sendVariableValue('faderPosition', Math.round((event.position / FADER_MAX) * 1000) / 10)
	}
}

// --- plugin -----------------------------------------------------------------
interface CC1Info {
	path: string
}

/**
 * macOS enumerates the device as both /dev/tty.* and /dev/cu.*. Opening the tty
 * (dial-in) node blocks until carrier detect, which never asserts here — use the
 * cu (call-out) node instead. No-op on Linux/Windows.
 */
export function calloutPath(path: string): string {
	return process.platform === 'darwin' ? path.replace('/dev/tty.', '/dev/cu.') : path
}

/** Fallback surface id, used because the CC121MK2 reports no USB serial number. */
const STABLE_SURFACE_ID = 'yamaha-cc121mk2'

/**
 * A surface id that survives being plugged into a different USB socket.
 *
 * Companion keys everything the user configures — the motor-fader expression, the
 * fader-position binding, page assignment, brightness, grid offsets — on the surface id.
 * The obvious id, the serial number, does not exist on this hardware: the CC1 ships no
 * iSerial, so the OS invents one per PORT. Windows reports `6&24EE3B&0&0000` (a hash of
 * the hub/port path, hence the ampersands) and macOS falls back to /dev/cu.usbmodemNNNN.
 * Keying on either means moving the cable to the next socket along presents a brand new
 * surface and silently abandons every setting on the old one.
 *
 * So use a fixed id unless the device really does carry a serial. The host still resolves
 * collisions itself (`trackSurface` appends `-dev2`, `-dev3`, ... to a taken id), so a
 * second CC1 on the same machine still works; only the first keeps the bare id.
 */
export function stableSurfaceId(serialNumber: string | undefined): string {
	// A real serial is a plain string. Windows instance ids always contain "&".
	return serialNumber && !serialNumber.includes('&') ? serialNumber : STABLE_SURFACE_ID
}

const plugin: SurfacePlugin<CC1Info> = {
	async init(): Promise<void> {
		// Nothing to set up — devices are found per-scan.
	},

	async destroy(): Promise<void> {
		// Companion hot-reloads dev modules and terminates the process shortly after
		// this resolves. Release every port here — a surface left open keeps the fd
		// and the replacement process cannot open the device.
		await Promise.allSettled([...openSurfaces].map((s) => s.close()))
		openSurfaces.clear()
	},

	async scanForSurfaces(): Promise<DetectionSurfaceInfo<CC1Info>[]> {
		const ports = await SerialPort.list()
		return ports
			.filter((p) => parseInt(p.vendorId ?? '', 16) === VENDOR_ID && parseInt(p.productId ?? '', 16) === PRODUCT_ID)
			.map((p) => ({
				surfaceId: stableSurfaceId(p.serialNumber),
				description: 'Yamaha CC121MK2',
				deviceHandle: p.path,
				pluginInfo: { path: calloutPath(p.path) },
			}))
	},

	async openSurface(surfaceId: string, pluginInfo: CC1Info, context: SurfaceContext): Promise<OpenSurfaceResult> {
		const surface = new CC1Surface(surfaceId, pluginInfo.path, context)
		openSurfaces.add(surface)
		return {
			surface,
			registerProps: {
				brightness: true,
				surfaceLayout: buildLayout(),
				transferVariables: [
					{ id: 'faderPosition', type: 'input', name: 'Fader position', description: 'Fader position, 0-100 in 0.1 steps (the fader is 10-bit)' },
					{ id: 'faderMotor', type: 'output', name: 'Motor fader target', description: 'Expression (0-100, decimals allowed) driving the motorised fader' },
				],
				// Only the LCD keys have a display, so pincode entry lives there.
				pincodeMap: {
					type: 'single-page',
					pincode: LCD_CONTROL_IDS[0],
					0: LCD_CONTROL_IDS[10],
					1: LCD_CONTROL_IDS[1], 2: LCD_CONTROL_IDS[2], 3: LCD_CONTROL_IDS[3],
					4: LCD_CONTROL_IDS[4], 5: LCD_CONTROL_IDS[5], 6: LCD_CONTROL_IDS[6],
					7: LCD_CONTROL_IDS[7], 8: LCD_CONTROL_IDS[8], 9: LCD_CONTROL_IDS[9],
				},
				location: pluginInfo.path,
				configFields: null,
				canChangePage: { label: `Buttons ${PANEL_BUTTON_LABELS[PAGE_PREV_SWITCH]} / ${PANEL_BUTTON_LABELS[PAGE_NEXT_SWITCH]} change page` },
			},
		}
	},
}

export default plugin
