#!/usr/bin/env node
/**
 * Print what the module reports for each fader position, to confirm the 10-bit value
 * survives to Companion. Shows raw 0-1023 alongside the reported 0-100.
 */
import { SerialPort } from 'serialport'
import { HANDSHAKE, FADER_MAX, buildMessage, buildPostHandshakeInit, frameSplit, pcpUnwrap, parseMessage, decodeInput } from '../dist/cc1-proto.js'

const ports = await SerialPort.list()
const info = ports.find((p) => parseInt(p.vendorId ?? '', 16) === 0x0499 && parseInt(p.productId ?? '', 16) === 0x140f)
if (!info) throw new Error('CC1 not found')
const port = new SerialPort({ path: process.platform === 'darwin' ? info.path.replace('/dev/tty.', '/dev/cu.') : info.path, baudRate: 115200, hupcl: false })
await new Promise((r, j) => { port.once('open', r); port.once('error', j) })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let seq = 10, rx = Buffer.alloc(0)
const seen = new Set()
let min = Infinity, max = -Infinity
port.on('data', (chunk) => {
	const { frames, rest } = frameSplit(Buffer.concat([rx, chunk])); rx = rest
	for (const f of frames) {
		const { payload, ok } = pcpUnwrap(f); if (!ok) continue
		const m = parseMessage(payload); const ev = m && decodeInput(m)
		if (ev?.type !== 'fader') continue
		// exactly what CC1Surface reports to Companion
		const reported = Math.round((ev.position / FADER_MAX) * 1000) / 10
		if (!seen.has(ev.position)) {
			seen.add(ev.position)
			min = Math.min(min, ev.position); max = Math.max(max, ev.position)
			if (seen.size <= 40 || ev.position === 0 || ev.position === FADER_MAX)
				console.log(`  raw ${String(ev.position).padStart(4)} / 1023  ->  reported ${reported}`)
		}
	}
})
port.write(HANDSHAKE); await sleep(400)
for (const f of buildPostHandshakeInit()) port.write(f)
const ka = setInterval(() => port.write(buildMessage(0x0000, Buffer.alloc(0), 4, ++seq & 0xffff)), 300)
console.log('Move the fader slowly through its FULL travel, bottom to top (30s)')
await sleep(30000)
console.log(`\n=== ${seen.size} distinct raw positions seen, range ${min === Infinity ? '-' : min}..${max === -Infinity ? '-' : max} of 0..1023 ===`)
clearInterval(ka)
port.close(() => process.exit(0))
