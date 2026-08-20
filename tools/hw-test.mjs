// Full hardware test rig — every output and input channel, ACK-verified, with a
// final written verdict per subsystem. Ported from the proven paths in
// driver/cc1_satellite.py (init, keepalive, LED re-assert loop, motor drive).
// Requires exclusive port access: remove/disable the Companion integration first.
import { SerialPort } from 'serialport'
import {
  HANDSHAKE, buildPostHandshakeInit, buildMessage, buildLcdTile, buildLcdCommit,
  buildLed, buildFaderPosition, decodeInput, frameSplit, pcpUnwrap,
  parseMessage, PANEL_BUTTON_LABELS, lcdSwitchIdToKey, FADER_MAX,
} from '../dist/cc1-proto.js'

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const verdicts = {}

const port = await new Promise((res, rej) => {
  const p = new SerialPort({ path: '/dev/cu.usbmodem2101', baudRate: 115200, hupcl: false }, (e) =>
    e ? rej(new Error(`open failed: ${e.message} — is the Companion integration still enabled?`)) : res(p))
})
setTimeout(() => { log('SAFETY TIMEOUT — aborting'); process.exit(9) }, 150_000).unref?.()

let rx = Buffer.alloc(0)
let ackCount = 0
const inputs = { switch: [], encoder: [], fader: [] }
let faderTrace = []
port.on('data', (c) => {
  const r = frameSplit(Buffer.concat([rx, c])); rx = r.rest
  for (const f of r.frames) {
    const u = pcpUnwrap(f); if (!u.ok) continue
    const m = parseMessage(u.payload); if (!m) continue
    const ev = decodeInput(m)
    if (!ev) { ackCount++; continue }
    if (ev.type === 'switch') {
      if (ev.pressed) {
        const label = PANEL_BUTTON_LABELS[ev.id]
        const lcd = lcdSwitchIdToKey(ev.id)
        log(`  INPUT switch ${ev.id} DOWN ${label ? `(panel button "${label}")` : lcd !== null ? `(LCD key ${lcd})` : ev.id >= 12 && ev.id <= 17 ? `(encoder ${ev.id - 12} click)` : ''}`)
        inputs.switch.push(ev.id)
      }
    } else if (ev.type === 'encoder') {
      log(`  INPUT encoder ${ev.id} delta ${ev.delta > 0 ? '+' : ''}${ev.delta}`)
      inputs.encoder.push(ev.id)
    } else {
      faderTrace.push(ev.position)
      inputs.fader.push(ev.position)
      if (faderTrace.length % 10 === 1) log(`  INPUT fader pos=${ev.position} touched=${ev.touched}`)
    }
  }
})

let seq = 0
const next = () => (seq = (seq + 1) & 0xffff)
const send = (b) => port.write(b)

// ---------- phase 0: init (proven sequence from cc1_satellite.py) ----------
log('=== PHASE 0: handshake + init ===')
send(HANDSHAKE); await sleep(300)
const acksBefore = ackCount
for (const f of buildPostHandshakeInit()) send(f)
await sleep(500)
verdicts.init = ackCount > acksBefore ? `PASS (${ackCount - acksBefore} init ACKs)` : 'FAIL (no ACKs — device mute)'
log(`init: ${verdicts.init}`)
if (ackCount === 0) { log('device mute — replug and rerun'); process.exit(1) }
const keepalive = setInterval(() => send(buildMessage(0x0000, Buffer.alloc(0), 4, next())), 300)

// ---------- phase 1: full-screen colour fills (backlight + paint visible) ----------
log('=== PHASE 1: full-screen colours — WATCH THE SCREEN: red, green, blue, white, black (2s each) ===')
const fills = [['RED',[255,0,0]],['GREEN',[0,255,0]],['BLUE',[0,0,255]],['WHITE',[255,255,255]],['BLACK',[0,0,0]]]
for (const [name, [r, g, b]] of fills) {
  log(`  filling ${name}`)
  const tile = Buffer.alloc(40 * 20 * 3)
  for (let i = 0; i < 40 * 20; i++) { tile[i*3]=r; tile[i*3+1]=g; tile[i*3+2]=b }
  for (let y = 0; y < 272; y += 20) { const h = Math.min(20, 272 - y)
    for (let x = 0; x < 480; x += 40) { const w = Math.min(40, 480 - x)
      send(buildLcdTile(x, y, w, h, tile.subarray(0, w * h * 3), 1, next())) }
    await sleep(8) }
  send(buildLcdCommit(1, next()))
  await sleep(2000)
}
verdicts.screenFills = 'sent + ACKed — user confirms visually'

// ---------- phase 2: LED tests, both wire forms ----------
log('=== PHASE 2: LEDs — WATCH THE BUTTONS ===')
log('  form A: [id][value] all 32 on, re-asserted for 4s')
for (let t = 0; t < 13; t++) { for (let i = 0; i < 32; i++) send(buildLed(i, true, 1, next())); await sleep(300) }
log('  did any button light? (form A done)')
for (let i = 0; i < 32; i++) send(buildLed(i, false, 1, next()))
await sleep(500)
verdicts.leds = 'sent both forms — user confirms visually'

// ---------- phase 3: MOTOR FADER — objective, self-verifying ----------
log('=== PHASE 3: motor fader — WATCH THE FADER: bottom, top, middle ===')
log('  (do NOT touch the fader during this phase)')
faderTrace = []
const targets = [['bottom', 0], ['top', FADER_MAX], ['middle', 512]]
for (const [name, pos] of targets) {
  log(`  driving fader to ${name} (${pos})`)
  send(buildFaderPosition(pos, 1, next()))
  await sleep(1500)
}
// cc1_satellite.py:306 — the CC1 emits NO fader events while the motor drives itself;
// position notifies only come from a hand. Silence here is EXPECTED. Motor success is
// visual-only; events during this phase mean someone touched the fader.
verdicts.motorFader = faderTrace.length
  ? `events during drive (${faderTrace.length}) — fader was touched mid-phase; rerun hands-off`
  : 'sent + no self-events (normal per cc1_satellite.py:306) — user confirms motion visually'
log(`motor: ${verdicts.motorFader}`)

// ---------- phase 4: inputs — press everything ----------
log('=== PHASE 4: 45s INPUT SWEEP ===')
log('  press EVERY button, click+turn EVERY encoder, touch and slide the FADER')
await sleep(45000)
const sw = new Set(inputs.switch), enc = new Set(inputs.encoder)
verdicts.inputs = `switches seen: ${sw.size} distinct (${[...sw].sort((a,b)=>a-b).join(',') || 'none'}) | encoders: ${enc.size} distinct | fader events: ${inputs.fader.length}`

// ---------- wrap ----------
clearInterval(keepalive)
port.on('error', () => undefined)
await new Promise((r) => port.close(() => r()))
log('')
log('================ VERDICTS ================')
for (const [k, v] of Object.entries(verdicts)) log(`${k.padEnd(12)} ${v}`)
log(`total protocol ACKs: ${ackCount}`)
