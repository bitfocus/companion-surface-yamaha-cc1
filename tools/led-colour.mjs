#!/usr/bin/env node
/**
 * Set the R, W and D-shaped keys to three given colour values and leave them lit.
 *
 * LED state persists after the port closes, so this exits immediately — no long-lived
 * process holding the port, and no timing pressure on the user.
 *
 * Usage: node tools/led-colour.mjs <colourR> <colourW> <colourD>   (decimal or 0x..)
 */
import { SerialPort } from 'serialport'
import { HANDSHAKE, buildMessage, buildLedBrightnessAll, buildPostHandshakeInit } from '../dist/cc1-proto.js'

// Confirmed by pressing each key while it was lit (2026-08-19).
const SLOTS = [
	['R', 0x0e],
	['W', 0x0d],
	['D', 0x0a],
]
const colours = process.argv.slice(2, 5).map((a) => Number(a))
if (colours.length !== 3 || colours.some((c) => !Number.isFinite(c))) {
	console.error('usage: led-colour.mjs <colourR> <colourW> <colourD>')
	process.exit(1)
}

const ports = await SerialPort.list()
const info = ports.find((p) => parseInt(p.vendorId ?? '', 16) === 0x0499 && parseInt(p.productId ?? '', 16) === 0x140f)
if (!info) throw new Error('CC1 not found — is Companion holding the port?')
const port = new SerialPort({ path: process.platform === 'darwin' ? info.path.replace('/dev/tty.', '/dev/cu.') : info.path, baudRate: 115200, hupcl: false })
await new Promise((r, j) => { port.once('open', r); port.once('error', j) })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let seq = 10
const led = (id, colour, state) => buildMessage(0x0381, Buffer.from([id, colour, state]), 1, ++seq & 0xffff)

port.write(HANDSHAKE); await sleep(400)
for (const f of buildPostHandshakeInit()) port.write(f)
port.write(buildLedBrightnessAll(0xae, 15, 1, ++seq & 0xffff))
await sleep(500)

// Clear all 15 first so only the three under test are lit.
for (let i = 0; i <= 0x0e; i++) port.write(led(i, 0x01, 0))
await sleep(400)
for (const [name, id] of SLOTS) {
	const c = colours[SLOTS.findIndex(([n]) => n === name)]
	port.write(led(id, c & 0xff, 1))
	console.log(`${name}  (led 0x${id.toString(16).padStart(2, '0')})  colour ${c} / 0x${(c & 0xff).toString(16).padStart(2, '0')}`)
}
await sleep(600)
port.close(() => process.exit(0))
