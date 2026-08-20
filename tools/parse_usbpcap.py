#!/usr/bin/env python3
"""Decode CC1 protocol messages from a USBPcap .pcapng capture.

Wireshark's USBPcap display filters are unreliable for this device, so this reads
the pcapng blocks directly, reassembles the CDC-ACM bulk streams, and decodes the
0xC0..0xC1 framed PCP messages.

Usage: tools/parse_usbpcap.py <capture.pcapng> <out_prefix>
Writes <out_prefix>-msgs.txt: "<time> ep<NN> IN|OUT r=.. s=.. op=.. d=<hex>"

Handy follow-ups:
  awk '{print $2, $3, $6}' out-msgs.txt | sort | uniq -c | sort -rn   # opcode histogram
  grep 'op=0381' out-msgs.txt                                        # LED traffic
"""
import struct, sys

ESC_IN = {0xDC: 0xC0, 0xDD: 0xDB, 0xDE: 0xC1}


def pcapng_packets(path):
    """Yield (timestamp, packet_bytes) from Enhanced Packet Blocks."""
    buf = open(path, "rb").read()
    off, n_if, if_tsres = 0, 0, {}
    while off + 12 <= len(buf):
        btype, blen = struct.unpack_from("<II", buf, off)
        if blen < 12 or off + blen > len(buf):
            break
        body = buf[off + 8 : off + blen - 4]
        if btype == 0x00000001:  # Interface Description Block
            if_tsres[n_if] = 6  # default: microseconds
            o = 8
            while o + 4 <= len(body):
                code, olen = struct.unpack_from("<HH", body, o)
                if code == 9 and olen >= 1:
                    if_tsres[n_if] = body[o + 4]
                if code == 0:
                    break
                o += 4 + ((olen + 3) & ~3)
            n_if += 1
        elif btype == 0x00000006:  # Enhanced Packet Block
            iface, ts_hi, ts_lo, caplen, _orig = struct.unpack_from("<IIIII", body, 0)
            ts = ((ts_hi << 32) | ts_lo) / (10 ** if_tsres.get(iface, 6))
            yield ts, body[20 : 20 + caplen]
        off += blen


def usbpcap_records(path):
    """Yield (ts, bus, device, endpoint, transfer_type, payload)."""
    for ts, pkt in pcapng_packets(path):
        if len(pkt) < 27:
            continue
        hlen = struct.unpack_from("<H", pkt, 0)[0]
        if hlen < 27 or hlen > len(pkt):
            continue
        bus, dev = struct.unpack_from("<HH", pkt, 17)
        dlen = struct.unpack_from("<I", pkt, 23)[0]
        yield ts, bus, dev, pkt[21], pkt[22], pkt[hlen : hlen + dlen]


def split_frames(stream):
    """Un-escape complete 0xC0..0xC1 frames; return (frames, unconsumed_tail)."""
    frames, i, consumed = [], 0, 0
    while i < len(stream):
        if stream[i] != 0xC0:
            i += 1
            continue
        j = i + 1
        while j < len(stream) and stream[j] != 0xC1:
            j += 1
        if j >= len(stream):
            break  # incomplete — keep for the next read
        out, esc = bytearray(), False
        for k in range(i + 1, j):
            b = stream[k]
            if esc:
                out.append(ESC_IN.get(b, b))
                esc = False
            elif b == 0xDB:
                esc = True
            else:
                out.append(b)
        frames.append(bytes(out))
        i = consumed = j + 1
    return frames, stream[consumed:]


def decode(frame):
    """PCP frame -> 'r=.. s=.. op=.. d=<hex>'."""
    if len(frame) < 3:
        return f"RAW {frame.hex()}"
    n = frame[0] | (frame[1] << 8)
    if n + 3 != len(frame):
        return f"BADLEN {frame.hex()}"
    payload = frame[2 : 2 + n]
    ok = (-sum(payload)) & 0xFF == frame[2 + n]
    if len(payload) < 6:
        return f"SHORT {payload.hex()}"
    routing, seq, op = (struct.unpack_from("<H", payload, i)[0] for i in (0, 2, 4))
    data = payload[6:]
    d = data.hex() if len(data) <= 24 else f"{data[:24].hex()}...({len(data)}B)"
    return f"r={routing:04x} s={seq:04x} op={op:04x} d={d}{'' if ok else ' BADSUM'}"


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    cap, prefix = sys.argv[1], sys.argv[2]
    records = list(usbpcap_records(cap))

    # Find the CC1 automatically: the (bus, device) whose bulk traffic contains the
    # most frame-start bytes. Beats hardcoding an address that changes per capture.
    scores = {}
    for ts, bus, dev, ep, transfer, payload in records:
        if transfer == 3 and payload:
            scores[(bus, dev)] = scores.get((bus, dev), 0) + payload.count(0xC0)
    if not scores:
        sys.exit("no bulk traffic found in capture")
    target = max(scores, key=scores.get)
    print(f"device: bus {target[0]} dev {target[1]} ({scores[target]} frame starts)")

    streams = {}
    for ts, bus, dev, ep, transfer, payload in records:
        if (bus, dev) == target and transfer == 3 and payload:
            streams.setdefault(ep, []).append((ts, payload))
    for ep, chunks in sorted(streams.items()):
        print(f"  endpoint 0x{ep:02x}: {len(chunks)} packets, {sum(len(p) for _, p in chunks)} bytes")

    events = []
    for ep, chunks in streams.items():
        direction = "IN " if ep & 0x80 else "OUT"
        pend = b""
        for ts, payload in chunks:
            frames, pend = split_frames(pend + payload)
            for fr in frames:
                events.append((ts, ep, direction, decode(fr)))
    events.sort(key=lambda e: e[0])

    out = f"{prefix}-msgs.txt"
    with open(out, "w") as f:
        for ts, ep, direction, msg in events:
            f.write(f"{ts:12.6f} ep{ep:02x} {direction} {msg}\n")
    print(f"{len(events)} messages -> {out}")


if __name__ == "__main__":
    main()
