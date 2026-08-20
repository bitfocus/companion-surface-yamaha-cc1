// Mimic Companion's host lifecycle against the real device, with full error visibility.
const BASE = new URL('../dist/main.js', import.meta.url).href
process.on('uncaughtException', (e) => { console.error('UNCAUGHT EXCEPTION:', e); process.exit(9) })
process.on('unhandledRejection', (e) => { console.error('UNHANDLED REJECTION:', e); process.exit(9) })
const plugin = (await import(BASE)).default
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a)

log('plugin.init()'); await plugin.init()
const found = await plugin.scanForSurfaces()
log('found:', JSON.stringify(found))
if (!found.length) { console.error('no device'); process.exit(1) }

const ctx = {
  isLocked: false, capabilities: {},
  disconnect: (err) => log('!! context.disconnect:', err?.message),
  keyDownById: (id) => log('   keyDown', id),
  keyUpById: (id) => log('   keyUp', id),
  keyDownUpById: (id) => log('   keyDownUp', id),
  rotateLeftById: (id) => log('   rotateLeft', id),
  rotateRightById: (id) => log('   rotateRight', id),
  changePage: (f) => log('   changePage', f),
  sendVariableValue: (n, v) => log('   var', n, '=', v),
}
const { surface } = await plugin.openSurface(found[0].surfaceId, found[0].pluginInfo, ctx)
log('surface.init()')
const t0 = Date.now()
await surface.init()
log(`surface.init() OK in ${Date.now() - t0}ms`)
await surface.ready()

log('drawing test colours into all 12 LCD keys...')
const colors = [[220,40,40],[40,180,40],[60,60,220],[220,180,40],[180,40,180],[40,180,180],[240,120,40],[120,240,120],[120,120,240],[240,240,240],[200,80,120],[80,200,160]]
for (let k = 0; k < 12; k++) {
  const [r, g, b] = colors[k]
  const px = Buffer.alloc(72 * 72 * 3)
  for (let i = 0; i < 72 * 72; i++) { px[i*3]=r; px[i*3+1]=g; px[i*3+2]=b }
  await surface.draw(new AbortController().signal, { controlId: `${Math.floor(k / 4)}/${k % 4}`, image: px })
}
log('draw queued — 12 coloured squares should appear within ~1s')
log('listening 15s: press buttons / turn encoders / touch+move the fader')
await new Promise((r) => setTimeout(r, 15000))

log('surface.close()')
const t1 = Date.now(); await surface.close()
log(`close() OK in ${Date.now() - t1}ms`)
await plugin.destroy()
log('DONE — clean exit')
process.exit(0)
