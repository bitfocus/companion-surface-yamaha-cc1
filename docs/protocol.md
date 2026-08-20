# Driverless CC1 — reverse-engineering notes

Goal: drive the Yamaha CC1 with **no Yamaha software at all** — portable off a USB
stick, any OS — and eventually the LCD screens without the Stream Deck software.

## THE BREAKTHROUGH: the CC1 is a standard USB CDC serial device
Config descriptor (read via pyusb, VID 0x0499 / PID 0x140f, product "CC1"):
- **Interface 0** — CDC-ACM control (interrupt IN `0x84`, 16 B)
- **Interface 1** — CDC-Data (bulk IN `0x83` / bulk OUT `0x03`, 512 B)  ← the serial pipe
- **Interface 2** — USB Mass Storage (bulk IN `0x81` / OUT `0x02`)

So the transport is a **plain serial port** — `/dev/cu.usbmodem*` / `/dev/tty.usbmodem*`
on macOS, a COM port on Windows, `/dev/ttyACM*` on Linux — **with no driver**.
`lsof` confirms ControlCenter simply opens `/dev/tty.usbmodem101` and exchanges bytes;
it does **not** use vendor USB transfers. (That's why years of MIDI/HID sniffing
failed — the data was on a serial interface the whole time.)

## The device is silent until handshaked
On open it streams nothing. A sweep of DTR/RTS line states, baud rates
(9600…1 Mbaud) and probe writes all returned **0 bytes**. It needs a
`DeviceInfoReq` message first; then notifications begin.

## Full protocol recovered from the ControlCenter binary (not stripped)
Internal product name **"CC121MK2"**, comms framework **"Anzu"**. ~75 message types,
including:
- **Inputs (device→host):** Switch / Encoder / Volume(fader) / Wheel(jog) /
  TouchPad / TouchPanel / FaderPositionNotify
- **Handshake / status:** DeviceInfoReq/Resp, DeviceStatusReq/Resp,
  DeviceAuxInfoReq/Resp, DeviceDisplay(Detail)InfoReq/Resp, DeviceOperatorInfoReq/Resp
- **Motor fader (host→device):** FaderPositionControlReq, FaderMotorCalibration(Abort)Req,
  FaderSavePositionDataReq, FaderTouchSensitivity*
- **LEDs:** Led / LedColor / LedBrightness / LedColorBrightness LightingControlReq
- **LCD screens:** LcdPaintReq, LcdPaintPatternReq, LcdBacklightControlReq,
  LcdUpdateControlReq  ← path to LCDs without Stream Deck software
- **Keepalive:** ActiveSenseMessage ; **Firmware:** UpdateData/Info/Status*

Key function: `CC121MK2::CC121mk2MessageTranslator::encode(AbstractMessage&, vector<uint8>&)`
(arm64 @ `0x10018c430`) turns a message into bytes; a queue-encode variant exists too.
Firmware blob: `ControlCenter.app/Contents/MacOS/firm/CC1/CC1_Firm.bin` (393216 B).

## Wire format — RECOVERED (via radare2 disassembly, 2026-06-30)
On-the-wire stack, outermost first:
1. **SLIP framing** (RFC1055): `decode()` calls `_slipDecode` before `pcpParseMessage`.
   `0xC0` = frame delimiter, `0xDB` = escape (`DB DC`->`C0`, `DB DD`->`DB`).
2. **PCP frame** (`PCP::pcpParseMessage` @ 0x100196d70 ; `PCP::MessageFrame`):
   `[len_lo][len_hi]` = uint16 **little-endian payload length N**, then N payload
   bytes, then 1 **checksum** byte. Total frame = N + 3. Validation in parser:
   `(N + 3) == totalLen`.
3. **Checksum** = `(-(sum of the N payload bytes)) & 0xFF` (two's complement; i.e.
   `(sum(payload) + checksum) & 0xFF == 0`). Confirmed: SIMD sum -> `addv` ->
   `neg` -> `& 0xff` -> compare to last byte.
4. **Message** (the payload): structured header. Parser reads a dispatch/type byte
   (seen values `0x7f, 0x80, 0x81, 0x82` at payload offset ~4) + a sub-id byte after
   it, then typed fields (multiple little-endian 16-bit params, e.g. ldrb pairs
   `[+0xa][+0xb]` etc.). Multi-level switch -> one of the ~75 message classes.

Key functions: `PCP::pcpParseMessage`, `CC121mk2MessageTranslator::encode`
(0x10018c430, RTTI/dynamic_cast dispatch per message type) / `::decode` (0x100193ac0),
`AnzuUsbSerial::UsbSerialSession::writePort` (0x100337cd8) / `onSendMessage`,
`UsbSerialDeviceDiscovery::start`.

## Message layer — RECOVERED (r2ghidra decompile of `encode()`, 2026-06-30)
`CC121mk2MessageTranslator::encode` (0x10018c430) is a **71-case switch on the
message type-id** (`*(msg+8)` via u16 table @ `0x1004d6a90`); each case confirms the
type with `__dynamic_cast` then serializes. **Each message has a 16-bit opcode**
(little-endian) followed by data bytes. typeinfo->name resolved via the chained
pointer at `typeinfo+8` (`& 0xFFFFFFFFF` = ZTS string addr).

Opcodes look structured (`0xCNN`: C=category, NN=id). Confirmed subset:
- requests (host->device): `SwitchStatusReq=0x001`, `VolumeStatusReq=0x003`,
  `FaderStatusReq=0x004`, `FaderTouchSensitivitySettingStatusReq=0x104`,
  `FaderTouchSensitivityStatusReq=0x204`.
- responses: `LedBrightnessControlResp=0x80`, `LedsBrightnessControlResp=0x81`,
  `LcdBacklightControlResp=0x82`, `LedLightingControlResp=0x180`,
  `LedsLightingControlResp=0x181`, `LcdPaintResp=0x182`, `DeviceOperatorInfoResp=0x200`,
  `LcdUpdateControlResp=0x282`, `DeviceDisplayDetailInfoResp=0x300`,
  `FaderMotorCalibrationResp=0x304`, `LcdPaintPatternResp=0x382`, `DeviceStatusResp=0x400`.
- simple encode example (SwitchStatusReq op1): `CONCAT12(*(msg+0xe),0x0001)` -> bytes
  `01 00 <datab>`, then serializer `func.100190350` wraps into the PCP payload.

`DeviceInfoReq` has no dedicated case -> trivial/default encode (case0 @0x10018c480 ->
`func.10018e408`); opcode probably a small value (0x000/0x002).

## PROTOCOL FULLY DECODED — verified against a real USBPcap capture (2026-06-30)
Ground-truth capture (Windows + USBPcap) of ControlCenter <-> CC1 lives at
`tools/re/captures/cc1_handshake.pcap` (decoded init in `init_sequence.txt`).
The capture corrected two things static RE got wrong: the END delimiter is **0xC1**
(not 0xC0), and the 2nd header field is the **sequence number** (not a const).

**Framing (verified):** wire frame = `0xC0 [escaped] 0xC1`; escape `0xDB`
(`DB DC`=C0, `DB DD`=DB, `DB DE`=C1). Inside = PCP `[len u16 LE = N][payload][cksum=(-Σ)&0xff]`,
total N+3. payload = `[routing u16 LE][seq u16 LE][opcode u16 LE][data]`.
routing: host->device 0x0000/1/2/4; device->host = routing | 0x8000. seq increments from 0.

**HANDSHAKE (verified bytes):**
- host -> `c0 06 00 00 00 00 00 00 00 00 00 c1`  (routing=0 seq=0 op=0 = DeviceInfoReq)
- device -> `... routing=0x8000 seq=0 op=0 data=00 01 00 00 00 01 00 01` (DeviceInfoResp)
Then host sends LCD/fader setup (op 0x0204, 0x0281, 0x0082, 0x0104) and begins polling
(op 0x0004 FaderStatus, op 0x0182 LcdPaint x many). All in `init_sequence.txt`.

Codec with the verified framing + `HANDSHAKE` constant: `tools/re/cc1_proto.py`.

## Motor fader behaviour (observed 2026-06-30)
With only the bare handshake sent and no position command, the **motorized fader
parks itself at 0** — push it up, release, it slides back down. This is normal:
the motor is *actively held* by `FaderPositionControlReq`; ControlCenter sends one
right after the handshake. So position-hold is **our** responsibility:
- after handshake (and on every camera switch) send `FaderPositionControlReq` with
  the target iris % so the motor holds there;
- while the fader touch bit = 1, stop driving the motor (let the user move it),
  then re-assert the held value on release.
Upside: this confirms the motor is live and obeying us. Decoding the
`FaderPositionControlReq` data layout is now easy to test — send a position, watch
the motor jump to it.

## MOTOR FADER DRIVE — DECODED + VERIFIED LIVE (2026-07-01)
The motor-drive is `FaderPositionControlReq`, a **distinct class** from FaderStatusReq
but it **reuses opcode 0x0004**. Recovered from `encode()` case @ `0x10018d930`
(dynamic_cast target typeinfo `0x100585a18` = `CC121MK230FaderPositionControlReqMessage`,
found via chained-fixup name-ptr @ file 0xca1a20). Data layout:
  `[fader_idx=00][flag][pos_lo][pos_hi]`  — pos 10-bit 0..1023; **flag must be nonzero**.
The nonzero flag is what distinguishes a position SET from a FaderStatusReq query
(query = all-zero data). Verified live: `build_fader_position(pos)` sweeps the real
motor top/mid/bottom on command with **no Yamaha software**. Codec: `cc1_proto.build_fader_position`.
Note the byte order differs from the device->host fader NOTIFY (`[00][pos_lo][pos_hi][touch]`).
Practical use in the driver: on connect + on every camera switch, send the target
iris%; stop sending while the fader touch bit=1; re-assert on release. This is the
fix for the "fader falls to 0" (ControlCenter only ever sent pos=0 in our capture).

## BUTTON LEDs — DECODED + VERIFIED LIVE (2026-07-01)
Single-LED lighting = `LedLightingControlReq`, **opcode 0x0180** (serializer helper
@ 0x10018e7e8 stores op 0x180 then a byte vector). Wire: `[led_id][value]`, value
0=off / nonzero=on. **32 addressable LEDs** (id 0x00..0x1f); buttons are **RGB**
(walk lit S, monitor/speaker, record, jog, play... in different colours). id 0x00 =
"S" button. `[led_id][r][g][b]` form also ACKed (exact colour map TBD). Device ACKs
each with `op=0x0180 data=00`. Codec: `cc1_proto.build_led` / `build_led_rgb`.

Related, decoded from encode()/helpers:
- **LedsLightingControlReq op 0x0181** (set-all, helper @ 0x10018eb3c): payload =
  `[msg0xe][msg0xf]` prefix + value vector. The prefix format isn't pinned yet, so
  naive per-LED-pair payloads got NO ACK. Use per-LED 0x0180 for now.
- **LedColorLightingControlReq op 0x0381** (helper @ 0x10018f11c): small inline data.
- **LedsBrightnessControlReq op 0x0281**: `[id][level]*15` (device ACKs op 0x0081);
  brightness only shows once the LED is lit via 0x0180. `build_led_brightness_all`.
Typeinfos located via chained-fixup name-ptr search (name vaddr in low-51 bits of an
on-disk 8-byte word; typeinfo = that file-offset − 8; vaddr = fileoff + 0xff8e4000).

## LCD TOUCHSCREEN — PAINT FORMAT DECODED (2026-07-01)
The "Stream Deck" keys are ONE **480x272 colour TFT** (not 12 separate displays;
field0 always 0). Shows **12 button cells in a 4x3 grid** (~120x90 px each).
Painted via **LcdPaintReq op 0x0182**, tiled:
  `data = [0000][x0 u16][y0 u16][x1 u16][y1 u16] + RGB565-LE pixels` (row-major, w*h*2 bytes)
rect INCLUSIVE (w=x1-x0+1). ControlCenter uses 40x20 tiles (1600B body) but any rect works.
**Verified**: reconstructed the capture's 480x272 framebuffer from the op 0x0182 tiles ->
produced the exact Cubase panel (mixer/e/piano/EQ/folder/INSERT/EQ/SEND icons). Encoding is
RGB565 little-endian (byte0=lo). Codec: `cc1_proto.build_lcd_tile` / `rgb565` (LCD_W=480 LCD_H=272).
`LcdUpdateControlReq op 0x0282` appears once in init -> probably a flush/commit (TBD).
LCD KEYS MAPPED (2026-07-01): the 12 keys are **physical press buttons** (not touch);
presses arrive as **Switch op 0x0001 [id][state]**, ids **21..32** (0x15..0x20).
Verified press order L->R/top->bottom: top 21,24,27,30 / mid 22,25,28,31 / bot 23,26,29,32
=> **switch id = 21 + 3*col + row** (column-major). Codec: `lcd_key_switch_id`,
`lcd_switch_id_to_key`, `lcd_key_rect`. Live-verified we can PAINT the panel from our own
code (12-colour grid appeared) and READ the key presses — LCD fully decoded (display+keys).
A 0x0282 flush was sent but paint appeared without needing to confirm it's required.

## TARGET ARCHITECTURE (decided 2026-07-01)
Driver presents the CC1 to Companion as **one surface** via the **Companion Satellite**
protocol (NOT a Companion "module" — modules are integrations; surfaces use Satellite).
Driver = Satellite client that: (a) opens the CC1 serial port (handshake, read inputs,
drive LEDs/motor fader/LCD); (b) receives per-button graphics from Companion -> renders
them into the 12 LCD cells (op 0x0182); (c) sends key press/rotate for LCD touches AND the
physical CC1 buttons/encoders -> so every CC1 control is user-assignable in Companion.
This removes BOTH ControlCenter and the Stream Deck software.

## DRIVER — PHASE 1 DONE + WORKING (2026-07-01)  `driver/cc1_satellite.py`
Standalone driverless bridge: opens the CC1 serial port (auto-find by USB 0499:140f),
handshakes, and connects to **Companion Satellite** (TCP 127.0.0.1:16622) as a surface.
- Registers a 12-key / 4-per-row surface (`ADD-DEVICE`, BITMAPS=72).
- Renders each Companion button graphic 1:1 into the 72x72 key aperture
  (`lcd_key_rect` positions x=15/141/267/393, y=3/98/194), clears bezel gaps to black,
  commits with the 0x0282 flush.
- LCD key press (Switch id 21..32) -> `KEY-PRESS` back to Companion.
- PING/PONG keepalive, auto-reconnect to Companion.
VERIFIED live: surface appears in Companion, buttons render cleanly + centred, presses
trigger the mapped Companion actions. No ControlCenter, no Stream Deck software.
Gotchas solved: LCD needs the 0x0282 commit after tiles to display; key aperture is
72x72 (not edge-to-edge) so paint 1:1; Companion 5.0 sends raw-RGB square bitmaps
(size inferred from length). Run: `.venv/bin/python driver/cc1_satellite.py` (CC1_DEBUG=1 for logs).

## PHASE 2 DONE (2026-07-01): physical panel as a 2nd Companion surface
Mapped live: 17 buttons (Switch ids 0-11,18-20,33-34 = device labels "1,2,15-29"),
6 push-encoders (rotate id 0-5, click Switch 12+id), fader (touch=press, move=rotate).
Driver exposes DEV_PANEL surface (24 keys, 6/row): keys 0-5 encoders, 6-22 buttons,
23 fader. Codec: PANEL_* consts + panel_switch_to_key/panel_encoder_to_key/labels.
Verify tool: `CC1-panel-map.companionconfig` (generator `tools/build_panel_map.py`) — a
single-page import that lights each tile as you press, with live rotary counters (custom
vars cc1_enc0-5/cc1_fadermap; must import Custom Variables too). All verified working.

## PHASE 3 IN PROGRESS: cross-platform user-friendly driver
`driver/` is now a self-contained package (bundles its own cc1_proto.py): hardened
`cc1_satellite.py` with independent auto-reconnect for BOTH the CC1 (waits/reconnects on
unplug, friendly "quit ControlCenter" hint if port busy) and Companion; coordinated
_sync_devices so surfaces register only when both sides are up (fixed the "paint before
CC1 ready" drop); remove+add on CC1 reconnect forces a repaint. One-click launchers
run_mac.command / run_windows.bat / run_linux.sh bootstrap a venv + deps. Verified on Mac
(double-click -> venv setup -> connected -> 12 keys painted). README in driver/.
STILL TODO: LED colour from Companion per-key COLOR (set_panel_led is a stub — needs the
LED-id<->button correlation pass); jog wheel (WheelNotify); optional PyInstaller/CI
standalone binaries (no-Python) for all 3 OSes; fader<->iris camera integration.
1. Bring the CC1 **back to the Mac**, quit ControlCenter, and **replay the handshake**
   (`cc1_proto.HANDSHAKE`) to `/dev/cu.usbmodem*` — confirm the device wakes + streams.
2. Move a few controls; decode the **input notifies** (Switch/Encoder/Volume/Wheel/Fader)
   from the device->host stream (their opcodes are in the map; data layout by observation).
3. Build the cross-platform `pyserial` driver: open port -> send handshake -> poll/parse
   notifies -> drive fader/LEDs/LCD; bridge to Companion exactly like the current agent.
   This removes Yamaha ControlCenter entirely (USB-stick portable).

## Tooling
libusb 1.0.30 (brew), pyusb, pyserial 3.5. Capture helper: `tools/re/cc1_serial_capture.py`
(opens the port, logs timestamped hex). Device serial enumerates as `/dev/cu.usbmodem101`.

## LED control decoded (2026-08-19, ControlCenter USBPcap + live probe)
- **LedLighting is opcode 0x0381**, data `[led_id][led_id2][state]` (state 1=on 0=off).
  ControlCenter sends id pairs; a repeated single id lights just that LED. On/off only.
  The 0x0180 guess from the firmware string table ACKs but never lights anything.
- No enable/mode switch needed — ControlCenter's init is the same 0x0204/0x0281/0x0082/0x0104
  frames (order differs from ours; both work). 0x0281 = brightness (00..0e at 0xAE), sent at init.
- Verified led->button map (press-the-lit-key probe): 00=20 01=19 02=18 03=15 04=25 05=17
  06=16 07=29 08=28 09=27 0d=22 0e=21. No LED found for buttons 1, 2, 23, 24, 26
  (ids 0a-0c, 0f-1f lit nothing in [i][i] form).
- 0x0081 (device->host) is the ACK to 0x0381. 0x7000 = 5s status poll, empty req,
  resp `000201ff01`. ControlCenter keepalive is 1s (ours 300ms — both fine).
- Jog wheel: no separate Wheel message on the wire — fast spins send multi-tick encoder
  deltas (seen up to ±4) on the normal 0x0002 opcode.
- Button label map re-verified by guided press pass: cc1_proto.py PANEL_BUTTON_LABELS is
  correct on all 17 buttons; the cc1_satellite.py cam-select comments (sid4="22", sid5="21")
  were stale — those sids are buttons 24 and 23.
