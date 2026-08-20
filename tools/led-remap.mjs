#!/usr/bin/env node
/**
 * Rebuild the whole LED id -> switch id map by lighting one LED at a time and
 * having the user press whichever button lights.
 *
 * Needed after the 2026-08-19 firmware upgrade: LED 0x00 lit a different physical
 * button before and after, so the pre-upgrade map is not trustworthy.
 *
 * Sends both candidate payload forms per id ([i][i] and [i][0x01]), advances as soon
 * as a press arrives, and prints a paste-ready table at the end.
 */
import { SerialPort } from 'serialport'
import { HANDSHAKE, buildMessage, buildLedBrightnessAll, buildPostHandshakeInit, frameSplit, pcpUnwrap, parseMessage, decodeInput } from '../dist/cc1-proto.js'

const LAST_ID = 0x3f
const DWELL_MS = 2500

const ports = await SerialPort.list()
const info = ports.find((p) => parseInt(p.vendorId ?? '', 16) === 0x0499 && parseInt(p.productId ?? '', 16) === 0x140f)
if (!info) throw new Error('CC1 not found — is Companion holding the port?')
const port = new SerialPort({ path: process.platform === 'darwin' ? info.path.replace('/dev/tty.', '/dev/cu.') : info.path, baudRate: 115200, hupcl: false })
await new Promise((r, j) => { port.once('open', r); port.once('error', j) })

let seq = 10
const hx = (v) => '0x' + v.toString(16).padStart(2, '0')
const frame = (a, b, s) => buildMessage(0x0381, Buffer.from([a, b, s]), 1, ++seq & 0xffff)
const setLed = (id, on) => { port.write(frame(id, id, on ? 1 : 0)); port.write(frame(id, 0x01, on ? 1 : 0)) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
const log = (m) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}  ${m}`)

let onPress = null
let rx = Buffer.alloc(0)
port.on('data', (chunk) => {
	const { frames, rest } = frameSplit(Buffer.concat([rx, chunk])); rx = rest
	for (const f of frames) {
		const { payload, ok } = pcpUnwrap(f); if (!ok) continue
		const m = parseMessage(payload); const ev = m && decodeInput(m)
		// Ignore encoder push-clicks (12-17): those are usually accidental.
		if (ev?.type === 'switch' && ev.pressed && !(ev.id >= 12 && ev.id <= 17)) onPress?.(ev.id)
	}
})
const waitPress = (ms) => new Promise((resolve) => {
	const timer = setTimeout(() => { onPress = null; resolve(null) }, ms)
	onPress = (id) => { clearTimeout(timer); onPress = null; resolve(id) }
})

port.write(HANDSHAKE); await sleep(400)
for (const f of buildPostHandshakeInit()) port.write(f)
port.write(buildLedBrightnessAll(0xae, 15, 1, ++seq & 0xffff))
const ka = setInterval(() => port.write(buildMessage(0x0000, Buffer.alloc(0), 4, ++seq & 0xffff)), 300)
await sleep(600)
for (let i = 0; i <= LAST_ID; i++) setLed(i, false)
await sleep(600)

log(`READY — press any button when you are watching the panel (${LAST_ID + 1} ids to test)`)
await waitPress(600000)
await sleep(1200)
log('Light on = PRESS IT. Nothing lit = just wait, it advances on its own.')

const map = []
for (let id = 0; id <= LAST_ID; id++) {
	setLed(id, true)
	log(`${hx(id)}`)
	const sid = await waitPress(DWELL_MS)
	setLed(id, false)
	if (sid !== null) { map.push([id, sid]); log(`   >>> ${hx(id)} = switch ${sid}`) }
	await sleep(200)
}

log('=== RESULT ===')
if (!map.length) log('  no LEDs responded at all')
for (const [id, sid] of map) log(`  led ${hx(id)} -> switch ${sid}`)
log('paste-ready:')
console.log('   ' + map.map(([id, sid]) => `${sid}: ${hx(id)}`).join(', '))
clearInterval(ka)
port.close(() => process.exit(0))
