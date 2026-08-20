#!/usr/bin/env node
/** Print every switch press for 75s — for guided label mapping. */
import { SerialPort } from 'serialport'
import { HANDSHAKE, buildMessage, buildPostHandshakeInit, frameSplit, pcpUnwrap, parseMessage, decodeInput } from '../dist/cc1-proto.js'

const ports = await SerialPort.list()
const info = ports.find((p) => parseInt(p.vendorId ?? '', 16) === 0x0499 && parseInt(p.productId ?? '', 16) === 0x140f)
if (!info) throw new Error('CC1 not found')
const path = process.platform === 'darwin' ? info.path.replace('/dev/tty.', '/dev/cu.') : info.path
const port = new SerialPort({ path, baudRate: 115200, hupcl: false })
await new Promise((r, j) => port.once('open', r) && 0 || port.once('error', j))
let seq = 10
port.write(HANDSHAKE)
await new Promise((r) => setTimeout(r, 400))
for (const f of buildPostHandshakeInit()) port.write(f)
const ka = setInterval(() => port.write(buildMessage(0x0000, Buffer.alloc(0), 4, ++seq & 0xffff)), 300)
const t0 = Date.now()
let rx = Buffer.alloc(0)
port.on('data', (chunk) => {
	const { frames, rest } = frameSplit(Buffer.concat([rx, chunk]))
	rx = rest
	for (const f of frames) {
		const { payload, ok } = pcpUnwrap(f)
		if (!ok) continue
		const m = parseMessage(payload)
		const ev = m && decodeInput(m)
		if (ev?.type === 'switch' && ev.pressed) console.log(`${((Date.now() - t0) / 1000).toFixed(1)}  press: switch ${ev.id}`)
	}
})
console.log('listening 75s — press the buttons in the agreed order')
await new Promise((r) => setTimeout(r, 75000))
clearInterval(ka)
port.close(() => process.exit(0))
