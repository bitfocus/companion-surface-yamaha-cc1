// Pure input listener: init the device, send keepalives, print every event. Nothing else.
import { SerialPort } from 'serialport'
import { HANDSHAKE, buildPostHandshakeInit, buildMessage, decodeInput, frameSplit, pcpUnwrap, parseMessage, PANEL_BUTTON_LABELS, lcdSwitchIdToKey } from '../dist/cc1-proto.js'
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const port = await new Promise((res, rej) => { const p = new SerialPort({ path: '/dev/cu.usbmodem2101', baudRate: 115200, hupcl: false }, (e) => (e ? rej(e) : res(p))) })
let rx = Buffer.alloc(0), events = 0, acks = 0
port.on('data', (c) => { const r = frameSplit(Buffer.concat([rx, c])); rx = r.rest
  for (const f of r.frames) { const u = pcpUnwrap(f); if (!u.ok) continue
    const m = parseMessage(u.payload); if (!m) continue
    const ev = decodeInput(m)
    if (!ev) { acks++; continue }
    events++
    if (ev.type === 'switch') log(`EVENT switch ${ev.id} ${ev.pressed ? 'DOWN' : 'up'} ${PANEL_BUTTON_LABELS[ev.id] ? `(button "${PANEL_BUTTON_LABELS[ev.id]}")` : lcdSwitchIdToKey(ev.id) !== null ? `(LCD key ${lcdSwitchIdToKey(ev.id)})` : ''}`)
    else if (ev.type === 'encoder') log(`EVENT encoder ${ev.id} ${ev.delta > 0 ? '+' : ''}${ev.delta}`)
    else log(`EVENT fader pos=${ev.position} touched=${ev.touched}`)
  } })
let seq = 0
port.write(HANDSHAKE); await sleep(300)
for (const f of buildPostHandshakeInit()) port.write(f)
await sleep(400)
const ka = setInterval(() => port.write(buildMessage(0x0000, Buffer.alloc(0), 4, ++seq & 0xffff)), 300)
log('LISTENING 180s — press buttons, turn encoders, slide the fader')
await sleep(180000)
clearInterval(ka)
port.on('error', () => undefined)
await new Promise((r) => port.close(() => r()))
log(`done: ${events} input events, ${acks} ACKs`)
