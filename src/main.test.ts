/**
 * Self-check for the surface layout and host contract. Run: npx tsx src/main.test.ts
 * Guards the invariants Companion relies on but only enforces at runtime with hardware attached.
 */
import assert from 'node:assert/strict'
import plugin, { stableSurfaceId, switchRoute } from './main.js'
import { PANEL_BUTTON_SWITCH_IDS, PANEL_ENCODER_IDS, panelEncoderClickSwitch } from './cc1-proto.js'

// The host accepts an entrypoint only if it exposes init + destroy.
// Mirrors companion/lib/Instance/Surface/Thread/Entrypoint.ts.
assert.equal(typeof plugin.init, 'function', 'host would accept the entrypoint')
assert.equal(typeof plugin.destroy, 'function', 'host would accept the entrypoint')
assert.equal(typeof plugin.scanForSurfaces, 'function', 'supportsScan reported true')
assert.equal(plugin.checkSupportsHidDevice, undefined, 'this is a serial plugin, not HID')

// openSurface only constructs — init() is what opens the port — so this is safe without hardware.
const ctx = new Proxy({}, { get: () => () => undefined }) as any
const { surface, registerProps } = await plugin.openSurface!('TEST', { path: '/dev/null' }, ctx)

assert.equal(surface.surfaceId, 'TEST')
assert.equal(surface.productName, 'Yamaha CC121MK2')

const controls = registerProps.surfaceLayout.controls
const ids = Object.keys(controls)
assert.equal(ids.length, 12 + 6 + 17 + 1, `36 controls, got ${ids.length}`)

// Ids are "row/column" and must agree with their own fields — the host keys cells as `${y}/${x}`.
for (const [id, spec] of Object.entries(controls)) {
	assert.match(id, /^\d+\/\d+$/, `id ${id} is row/column`)
	assert.equal(id, `${spec.row}/${spec.column}`, `id ${id} matches its row/column`)
}
assert.equal(
	new Set(Object.values(controls).map((c) => `${c.row}/${c.column}`)).size,
	ids.length,
	'no two controls share a grid cell'
)

// Exactly the 12 LCD keys request bitmaps; every referenced preset exists.
const presets = registerProps.surfaceLayout.stylePresets
assert.ok(presets.default, 'schema requires a default preset')
const lcdIds = Object.entries(controls).filter(([, c]) => c.stylePreset === 'lcd').map(([id]) => id)
assert.equal(lcdIds.length, 12, '12 bitmap controls')
assert.deepEqual(presets.lcd.bitmap, { w: 72, h: 72, format: 'rgb' })
for (const c of Object.values(controls)) if (c.stylePreset) assert.ok(presets[c.stylePreset], 'preset exists')

// Pincode entry must land on real controls, and only on the keys that can display a digit.
const pin = registerProps.pincodeMap as any
assert.equal(pin.type, 'single-page')
const pinIds: string[] = [pin.pincode, ...Array.from({ length: 10 }, (_, i) => pin[i])]
assert.equal(new Set(pinIds).size, 11, 'pincode display + 10 digits are distinct')
for (const id of pinIds) {
	assert.ok(controls[id], `pincode control ${id} exists`)
	assert.ok(lcdIds.includes(id), `pincode control ${id} is an LCD key`)
}

// One variable produced by the surface, one consumed by it.
assert.deepEqual(
	registerProps.transferVariables!.map((v) => `${v.id}:${v.type}`).sort(),
	['faderMotor:output', 'faderPosition:input']
)

// Motor drive must tolerate junk and a closed port without throwing.
surface.onVariableValue!('faderMotor', 50)
surface.onVariableValue!('faderMotor', 'not a number')
surface.onVariableValue!('unrelated', 1)

// The surface id must not change when the CC1 moves to another USB socket — Companion
// keys every user setting on it, so a port-derived id silently discards their config.
// The device carries no USB serial, so both OSes hand back a port identifier instead:
assert.equal(stableSurfaceId('6&24EE3B&0&0000'), 'yamaha-cc121mk2', 'a Windows instance id is a port id')
assert.equal(stableSurfaceId(undefined), 'yamaha-cc121mk2', 'no serial reported (macOS/Linux)')
assert.equal(stableSurfaceId(''), 'yamaha-cc121mk2', 'empty serial')
assert.equal(stableSurfaceId('CC1234567'), 'CC1234567', 'a real serial is honoured if one ever appears')

assert.equal(registerProps.brightness, true)

// Page nav: buttons 1/2 must be offered to the host AND still press their own control.
// The host silently drops changePage() unless the user enabled it, and a surface module is
// never told which way that setting is set — so doing only one of the two leaves buttons 1/2
// dead in one of the two states. This regressed once already (a module-side gate reading a
// config field Companion never forwards, so page nav could not fire at all).
assert.deepEqual(switchRoute(33), { pageNav: 'prev', controlId: '4/0' }, 'button 1 does both')
assert.deepEqual(switchRoute(34), { pageNav: 'next', controlId: '4/1' }, 'button 2 does both')
assert.equal(switchRoute(21).pageNav, null, 'an LCD key is not page nav')
assert.equal(switchRoute(21).controlId, '0/0')
assert.equal(switchRoute(200).controlId, undefined, 'an unmapped switch routes nowhere')

// Every physical switch reaches a control that actually exists in the layout.
for (const sid of [
	...PANEL_BUTTON_SWITCH_IDS,
	...PANEL_ENCODER_IDS.map(panelEncoderClickSwitch),
	...Array.from({ length: 12 }, (_, k) => 21 + k),
]) {
	const { controlId } = switchRoute(sid)
	assert.ok(controlId && controls[controlId], `switch ${sid} maps to a real control`)
}
assert.match(registerProps.canChangePage!.label, /Buttons 1 \/ 2/)

// Shutdown must never hang. Companion hot-reloads dev modules and waits on destroy();
// when that call timed out, the old process kept the serial port and the replacement
// could not open it — 47 restarts in a loop. close() must be safe unopened and repeatable,
// and destroy() must release everything promptly.
const hang = new Promise((_, rej) => setTimeout(() => rej(new Error('shutdown hung')), 3000).unref?.())
await Promise.race([
	(async () => {
		await surface.close()
		await surface.close() // idempotent
		await plugin.destroy()
	})(),
	hang,
])

console.log(`main: OK — ${ids.length} controls (${lcdIds.length} bitmap, ${ids.length - lcdIds.length} colour)`)
