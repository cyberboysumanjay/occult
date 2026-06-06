#!/usr/bin/env python3
"""BLE weighing-scale probe — discovery-first prototype.

We don't yet know what kind of scale this is, so this tool covers all three
realistic cases instead of assuming the standard:

1. **Spec-compliant** scales (Beurer BF600, A&D UC-352BLE, some Withings)
   implement the Bluetooth SIG Weight Scale Service (0x181D) with the Weight
   Measurement characteristic (0x2A9D). `read` connects and parses it.
2. **Body-composition** scales often use 0x181B / Body Composition Measurement
   (0x2A9C), which embeds weight + fat%. `read` best-effort parses that too.
3. **Broadcast-only** scales (many Xiaomi / cheap clones) never accept a
   connection — they put the weight in the advertisement's service-data or
   manufacturer-data. `scan` / `monitor` surface those raw bytes.

The 0x2A9D parser mirrors the validated logic in whoof's web/js/health/scale.js.

Run without touching the repo's lockfile:
    uv run --with bleak python tools/scale_probe.py scan
    uv run --with bleak python tools/scale_probe.py monitor
    uv run --with bleak python tools/scale_probe.py read --name <substr>
    uv run --with bleak python tools/scale_probe.py read --address <addr>
    python tools/scale_probe.py selftest        # no hardware / no bleak needed

On Windows: Bluetooth must be ON and the app allowed Bluetooth access
(Settings → Privacy → Bluetooth). Step on the scale to wake it — most only
advertise while active.
"""
from __future__ import annotations

import argparse
import asyncio
import sys
from datetime import datetime

# ── SIG 16-bit UUID helpers ──────────────────────────────────────────────
def uuid16(x: int) -> str:
    return f"0000{x:04x}-0000-1000-8000-00805f9b34fb"


WEIGHT_SCALE_SVC = uuid16(0x181D)
WEIGHT_MEAS_CHR = uuid16(0x2A9D)
BODY_COMP_SVC = uuid16(0x181B)
BODY_COMP_CHR = uuid16(0x2A9C)
SCALE_SVCS = {WEIGHT_SCALE_SVC, BODY_COMP_SVC}

WEIGHT_RES_KG = 0.005
WEIGHT_RES_LB = 0.01
LB_TO_KG = 0.45359237
IN_TO_M = 0.0254


# ── Parsers (pure, hardware-independent) ──────────────────────────────────
def parse_weight_measurement(data: bytes) -> dict | None:
    """Weight Measurement (0x2A9D). Mirrors whoof's parseWeightMeasurement."""
    b = bytes(data)
    if len(b) < 3:
        return None
    flags = b[0]
    is_imperial = bool(flags & 0x01)
    has_ts = bool(flags & 0x02)
    has_user = bool(flags & 0x04)
    has_bmi_height = bool(flags & 0x08)

    off = 1
    weight_raw = b[off] | (b[off + 1] << 8)
    off += 2
    units = weight_raw * (WEIGHT_RES_LB if is_imperial else WEIGHT_RES_KG)
    weight_kg = units * LB_TO_KG if is_imperial else units

    ts = None
    if has_ts and off + 7 <= len(b):
        year = b[off] | (b[off + 1] << 8)
        mon, day, hh, mm, ss = b[off + 2], b[off + 3], b[off + 4], b[off + 5], b[off + 6]
        if year > 0:
            try:
                ts = datetime(year, mon, day, hh, mm, ss).isoformat()
            except ValueError:
                ts = None
        off += 7

    user_id = None
    if has_user and off < len(b):
        user_id = b[off]
        off += 1

    bmi = height_m = None
    if has_bmi_height and off + 4 <= len(b):
        bmi = (b[off] | (b[off + 1] << 8)) * 0.1
        off += 2
        h_raw = b[off] | (b[off + 1] << 8)
        height_m = h_raw * 0.1 * IN_TO_M if is_imperial else h_raw * 0.001
        off += 2

    return {
        "weight_kg": round(weight_kg, 2),
        "is_imperial": is_imperial,
        "timestamp": ts,
        "user_id": user_id,
        "bmi": round(bmi, 1) if bmi is not None else None,
        "height_cm": round(height_m * 100, 1) if height_m else None,
    }


def parse_body_composition(data: bytes) -> dict | None:
    """Body Composition Measurement (0x2A9C) — best-effort.

    Extracts body-fat% (always present) and weight (if the weight-present flag
    bit is set). The full optional-field chain is long; we only walk far enough
    to reach weight, which is what we care about for a scale prototype.
    """
    b = bytes(data)
    if len(b) < 4:
        return None
    flags = b[0] | (b[1] << 8)
    is_imperial = bool(flags & 0x0001)
    off = 2
    body_fat = (b[off] | (b[off + 1] << 8)) * 0.1
    off += 2

    # Optional fields, in spec order, each gated by a flag bit. Sizes in bytes.
    optional = [
        (0x0002, 7),   # timestamp
        (0x0004, 1),   # user id
        (0x0008, 2),   # basal metabolism
        (0x0010, 2),   # muscle percentage
        (0x0020, 2),   # muscle mass
        (0x0040, 2),   # fat free mass
        (0x0080, 2),   # soft lean mass
        (0x0100, 2),   # body water mass
        (0x0200, 2),   # impedance
    ]
    for bit, size in optional:
        if flags & bit:
            off += size

    weight_kg = None
    if (flags & 0x0400) and off + 2 <= len(b):  # weight present
        raw = b[off] | (b[off + 1] << 8)
        units = raw * (WEIGHT_RES_LB if is_imperial else WEIGHT_RES_KG)
        weight_kg = round(units * LB_TO_KG if is_imperial else units, 2)

    return {
        "body_fat_pct": round(body_fat, 1),
        "weight_kg": weight_kg,
        "is_imperial": is_imperial,
    }


# 0xCF status byte (byte 9), per openScale's CultSmartScaleProHandler:
CF_STATUS = {
    0x01: "live · weight settling",
    0x00: "STABLE · weight-only (NO handles — no body-comp will be sent)",
    0x08: "impedance measuring (handles engaged)",
    0x05: "STABLE · full body measurement (handles engaged)",
}


def parse_cf_scale(data: bytes) -> dict | None:
    """0xCF — live weight stream (11 bytes). Cult Smart Scale Pro.

    Per openScale RE: bytes 5–8 are RESERVED (NOT impedance — our earlier guess
    was wrong). The real impedance arrives in separate 0xBE packets. Byte 9 is a
    STATUS byte (see CF_STATUS): 0x00 = weight-only (no handles → no body comp);
    0x05/0x08 = handles engaged → expect 0xBE + 0xDF packets to follow.

        cf 00 00 4c 1d 00 00 00 00 01 9f
        ^marker  ^wt-LE          ^status ^xor
    """
    b = bytes(data)
    if len(b) != 11 or b[0] != 0xCF:
        return None
    xor = 0
    for x in b[:10]:
        xor ^= x
    return {
        "type": "0xCF weight",
        "weight_kg": round((b[3] | (b[4] << 8)) / 100.0, 2),
        "status": CF_STATUS.get(b[9], f"unknown 0x{b[9]:02x}"),
        "status_byte": b[9],
        "byte1": b[1],   # openScale: flags (0x80=handle measurement); your unit may put HR here
        "checksum_ok": xor == b[10],
    }


def parse_be_impedance(data: bytes) -> dict | None:
    """0xBE — raw multi-frequency impedance (13 bytes). THE real impedance.

    Per openScale: packet index in byte 1 (0x00 = set A). bytes 2..11 = five
    uint16-LE impedance values (Ω). For packet 0x00, imp[2] (bytes 6–7) is the
    whole-body impedance (~250–500 Ω) used for the body-comp formulas. byte 12 =
    XOR over bytes 0..11.
    """
    b = bytes(data)
    if len(b) < 13 or b[0] != 0xBE:
        return None
    idx = b[1]
    imp = [(b[2 + i * 2] | (b[3 + i * 2] << 8)) for i in range(5)]
    xor = 0
    for x in b[:12]:
        xor ^= x
    return {
        "type": "0xBE impedance",
        "packet": idx,
        "impedances_ohm": imp,
        "whole_body_ohm": imp[2] if idx == 0 else None,
        "checksum_ok": xor == b[12],
    }


def parse_cf_history(data: bytes) -> dict | None:
    """0xCF history frame (18+ bytes) — OneByone stored measurement w/ timestamp.

    Per openScale OneByoneHandler: weight at 3–4 (LE ÷100), impedance =
    (b2<<8|b1)×0.1 Ω, timestamp = year(BE 11–12) month13 day14 hh15 mm16 ss17.
    These come back after a F2 00 history request and SHOULD carry the clean
    impedance from a real (handle/phone) measurement.
    """
    b = bytes(data)
    if len(b) < 18 or b[0] != 0xCF:
        return None
    imp_raw = (b[2] << 8) | b[1]
    return {
        "weight_kg": round((b[3] | (b[4] << 8)) / 100.0, 2),
        "imp_raw_b1b2": imp_raw,
        "imp_x0.1_ohm": round(imp_raw * 0.1, 1),
        "timestamp": f"{(b[11] << 8) | b[12]}-{b[13]:02d}-{b[14]:02d} "
                     f"{b[15]:02d}:{b[16]:02d}:{b[17]:02d}",
        "tail_5_10": _hex(b[5:11]),
    }


def _hex(data: bytes) -> str:
    return " ".join(f"{x:02x}" for x in data)


# ── BLE modes (require bleak) ─────────────────────────────────────────────
def _import_bleak():
    try:
        from bleak import BleakClient, BleakScanner  # noqa: F401
        return BleakScanner, BleakClient
    except ImportError:
        sys.exit(
            "bleak is not installed. Run with:\n"
            "    uv run --with bleak python tools/scale_probe.py ...\n"
            "or:  pip install bleak"
        )


def _looks_like_scale(adv) -> bool:
    svcs = {s.lower() for s in (adv.service_uuids or [])}
    return bool(svcs & SCALE_SVCS)


async def cmd_scan(timeout: float) -> None:
    BleakScanner, _ = _import_bleak()
    print(f"Scanning {timeout:.0f}s … (step on the scale now to wake it)\n")
    found = await BleakScanner.discover(timeout=timeout, return_adv=True)
    if not found:
        print("No BLE devices seen. Is Bluetooth on? Is the scale awake?")
        return
    rows = sorted(found.values(), key=lambda da: da[1].rssi or -999, reverse=True)
    for dev, adv in rows:
        flag = "  ⚖️ SCALE SERVICE" if _looks_like_scale(adv) else ""
        name = adv.local_name or dev.name or "(no name)"
        print(f"{dev.address}  {adv.rssi:>4} dBm  {name}{flag}")
        for u in adv.service_uuids or []:
            print(f"      svc  {u}")
        for u, raw in (adv.service_data or {}).items():
            print(f"      svc-data  {u}  =  {_hex(raw)}")
        for cid, raw in (adv.manufacturer_data or {}).items():
            print(f"      mfr-data  0x{cid:04x}  =  {_hex(raw)}")
    print(
        "\nIf weight bytes appear under svc-data/mfr-data when you step on it, "
        "this is a BROADCAST scale — use `monitor`. Otherwise `read` the address."
    )


async def cmd_monitor(seconds: float) -> None:
    """Continuous advertisement watch — for broadcast-only scales."""
    BleakScanner, _ = _import_bleak()
    print(f"Monitoring advertisements for {seconds:.0f}s. Step on the scale.\n")
    seen: dict[str, str] = {}

    def on_detect(dev, adv):
        payload = []
        for u, raw in (adv.service_data or {}).items():
            payload.append(f"svc[{u[4:8]}]={_hex(raw)}")
        for cid, raw in (adv.manufacturer_data or {}).items():
            payload.append(f"mfr[{cid:04x}]={_hex(raw)}")
        if not payload:
            return
        line = " ".join(payload)
        if seen.get(dev.address) == line:
            return  # unchanged — skip noise
        seen[dev.address] = line
        name = adv.local_name or dev.name or "(no name)"
        ts = datetime.now().strftime("%H:%M:%S")
        print(f"[{ts}] {dev.address} {name:<18} {line}")

    scanner = BleakScanner(detection_callback=on_detect)
    await scanner.start()
    try:
        await asyncio.sleep(seconds)
    finally:
        await scanner.stop()


async def _resolve_address(BleakScanner, name: str | None, address: str | None, timeout: float) -> str:
    if address:
        return address
    print(f"Looking for a device matching '{name}' …")
    found = await BleakScanner.discover(timeout=timeout, return_adv=True)
    for dev, adv in found.values():
        dn = (adv.local_name or dev.name or "")
        if name.lower() in dn.lower() or _looks_like_scale(adv):
            print(f"  → {dev.address}  {dn or '(no name)'}")
            return dev.address
    sys.exit(f"No device matched '{name}'. Run `scan` first to see what's around.")


async def cmd_read(name: str | None, address: str | None, timeout: float, seconds: float, watch: bool = False, init: bool = False) -> None:
    BleakScanner, BleakClient = _import_bleak()
    addr = await _resolve_address(BleakScanner, name, address, timeout)
    print(f"\nConnecting to {addr} …")

    loop = asyncio.get_event_loop()
    done = loop.create_future()

    stable = {"value": None, "count": 0}

    def on_notify(char, data: bytearray):
        uuid = char.uuid if hasattr(char, "uuid") else str(char)
        short = uuid[4:8].lower()
        ts = datetime.now().strftime("%H:%M:%S")
        print(f"[{ts}] notify {uuid}  raw: {_hex(data)}")
        parsed = None
        if short == "2a9d":
            parsed = parse_weight_measurement(data)
        elif short == "2a9c":
            parsed = parse_body_composition(data)
        elif len(data) == 2:
            print(f"           ack/marker: {_hex(data)}  "
                  f"({'F1 clock-ack' if data[0] == 0xF1 else 'F2 history-marker' if data[0] == 0xF2 else '?'})")
            return
        elif len(data) >= 18 and data[0] == 0xCF:
            print(f"           🗂  HISTORY 18B: {parse_cf_history(data)}")
            return
        elif len(data) and data[0] == 0xCF:
            parsed = parse_cf_scale(data)
        elif len(data) and data[0] == 0xBE:
            parsed = parse_be_impedance(data)
            if parsed:
                print(f"           ⚡ parsed: {parsed}")
                print("           ↑ THIS is the real impedance — feed whole_body_ohm to the body-comp formulas")
                return
        elif len(data) and data[0] == 0xDF:
            print(f"           parsed: 0xDF body-comp packet ({len(data)}B) — proprietary, computed from 0xBE impedance instead")
            return
        if not parsed:
            return
        print(f"           parsed: {parsed}")
        w = parsed.get("weight_kg")
        if not w or w <= 0:
            return
        if watch:
            return  # watch mode: log everything, never early-stop
        # Lock in only a *stable* reading — the same weight 3 frames running —
        # so we report the final value, not a mid-settle sample.
        if w == stable["value"]:
            stable["count"] += 1
        else:
            stable["value"], stable["count"] = w, 1
        if stable["count"] >= 3 and not done.done():
            done.set_result(parsed)

    async with BleakClient(addr) as client:
        print(f"Connected: {client.is_connected}\n--- GATT table ---")
        notifiables = []
        for svc in client.services:
            print(f"service {svc.uuid}")
            for ch in svc.characteristics:
                props = ",".join(ch.properties)
                print(f"   char {ch.uuid}  [{props}]")
                if "notify" in ch.properties or "indicate" in ch.properties:
                    notifiables.append(ch)

        if not notifiables:
            print("\nNo notify/indicate characteristics — likely a broadcast scale. Try `monitor`.")
            return

        print(f"\nSubscribing to {len(notifiables)} characteristic(s). "
              f"Step on the scale (waiting up to {seconds:.0f}s) …\n")
        for ch in notifiables:
            try:
                await client.start_notify(ch, on_notify)
            except Exception as e:  # noqa: BLE001 — prototype: keep going
                print(f"   (couldn't subscribe to {ch.uuid}: {e})")

        if init:
            # OneByone-family handshake (openScale OneByoneHandler): write a
            # mode/unit command then a clock to 0xfff1, which puts the scale into
            # proper measurement mode so it emits real impedance frames.
            fff1 = uuid16(0xFFF1)
            now = datetime.now()
            mode = bytearray([0xFD, 0x37, 0x00, 0x01, 0, 0, 0, 0, 0, 0, 0])  # FD 37 unit=kg group=1
            xx = 0
            for v in mode[:10]:
                xx ^= v
            mode[10] = xx
            clock = bytes([0xF1, (now.year >> 8) & 0xFF, now.year & 0xFF,
                           now.month, now.day, now.hour, now.minute, now.second])
            try:
                await client.write_gatt_char(fff1, bytes(mode), response=True)
                await asyncio.sleep(0.4)
                await client.write_gatt_char(fff1, clock, response=True)
                await asyncio.sleep(0.6)  # let the scale ACK F1 00 first
                await client.write_gatt_char(fff1, bytes([0xF2, 0x00]), response=True)  # request history
                print(f"→ OneByone init sent to 0xfff1: mode={_hex(mode)} clock={_hex(clock)} + F2 00 (history)")
                print("  Watching for 🗂 HISTORY frames (stored measurements w/ clean impedance)…")
                print("  Then STEP ON for a fresh reading too.\n")
            except Exception as e:  # noqa: BLE001
                print(f"  (init write to 0xfff1 failed: {e})")

        if watch:
            print(f"\n👀 WATCH mode — logging every packet for {seconds:.0f}s. "
                  f"Stay on the scale and hold still (HR/impedance lag the weight).\n")
            await asyncio.sleep(seconds)
            print("\nWatch window ended. Share the frames above and we'll decode "
                  "the fat%/muscle/HR fields.")
            return
        try:
            result = await asyncio.wait_for(done, timeout=seconds)
            print(f"\n✅ Weight reading: {result['weight_kg']} kg")
        except asyncio.TimeoutError:
            print("\nNo parseable weight received. Raw notifications (if any) are above — "
                  "share them and we can write a decoder for this scale's format.")


# ── selftest (no hardware) ────────────────────────────────────────────────
def cmd_selftest() -> int:
    ok = True

    # 70.000 kg, SI, no optional fields: 70 / 0.005 = 14000 = 0x36B0 → LE b0 36
    m = parse_weight_measurement(bytes([0x00, 0xB0, 0x36]))
    print("SI 70kg →", m)
    ok &= m is not None and abs(m["weight_kg"] - 70.0) < 1e-6 and not m["is_imperial"]

    # Imperial 154.32 lb (=70.0 kg): 154.32 / 0.01 = 15432 = 0x3C48 → LE 48 3c
    m = parse_weight_measurement(bytes([0x01, 0x48, 0x3C]))
    print("Imperial 154.32lb →", m)
    ok &= m is not None and m["is_imperial"] and abs(m["weight_kg"] - 70.0) < 0.01

    # Too short → None
    ok &= parse_weight_measurement(bytes([0x00, 0x10])) is None

    # Body composition: flags weight-present(0x0400)+SI, fat 22.5%, weight 70kg.
    # flags=0x0400 LE → 00 04 ; fat 225=0x00E1 LE → e1 00 ; weight 14000 → b0 36
    m = parse_body_composition(bytes([0x00, 0x04, 0xE1, 0x00, 0xB0, 0x36]))
    print("BodyComp 22.5% / 70kg →", m)
    ok &= m is not None and abs(m["body_fat_pct"] - 22.5) < 1e-6 and abs(m["weight_kg"] - 70.0) < 1e-6

    # 0xCF weight frame: 0x1d4c=7500 → 75.00 kg, status 0x01 (settling), XOR=0x9f.
    m = parse_cf_scale(bytes([0xCF, 0x00, 0x00, 0x4C, 0x1D, 0x00, 0x00, 0x00, 0x00, 0x01, 0x9F]))
    print("0xCF weight 75.0kg →", m)
    ok &= m is not None and abs(m["weight_kg"] - 75.0) < 1e-6 and m["status_byte"] == 0x01 and m["checksum_ok"]
    # Bad checksum must be flagged.
    bad = parse_cf_scale(bytes([0xCF, 0x00, 0x00, 0x4C, 0x1D, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00]))
    ok &= bad is not None and not bad["checksum_ok"]
    # 0xBE impedance packet: idx 0, imp[2]=0x00FA=250Ω whole-body. XOR(0..11)=byte12.
    be = bytearray([0xBE, 0x00, 0x33, 0x0B, 0xC5, 0x0B, 0xFA, 0x00, 0x58, 0x0B, 0x6C, 0x0A, 0x00])
    x = 0
    for v in be[:12]:
        x ^= v
    be[12] = x
    m = parse_be_impedance(bytes(be))
    print("0xBE impedance →", m)
    ok &= m is not None and m["whole_body_ohm"] == 250 and m["checksum_ok"]

    print("\nselftest:", "PASS ✅" if ok else "FAIL ❌")
    return 0 if ok else 1


# ── CLI ───────────────────────────────────────────────────────────────────
def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("scan", help="One-shot discovery; dump advertisement data")
    s.add_argument("--timeout", type=float, default=12.0)

    mo = sub.add_parser("monitor", help="Continuous adv watch (broadcast scales)")
    mo.add_argument("--seconds", type=float, default=60.0)

    r = sub.add_parser("read", help="Connect, subscribe to notify chars, parse weight")
    g = r.add_mutually_exclusive_group(required=True)
    g.add_argument("--address", help="BLE MAC/UUID from `scan`")
    g.add_argument("--name", help="Substring of the device name")
    r.add_argument("--timeout", type=float, default=12.0, help="Scan timeout when resolving --name")
    r.add_argument("--seconds", type=float, default=60.0, help="How long to wait for a reading")
    r.add_argument("--init", action="store_true",
                   help="Send the OneByone handshake (FD 37 mode + F1 clock) to 0xfff1 to trigger a real measurement")
    r.add_argument("--watch", action="store_true",
                   help="Log every packet for the full window (no early-stop) — for capturing fat%%/HR frames")

    sub.add_parser("selftest", help="Parser unit checks (no hardware/bleak)")

    # Windows consoles default to cp1252 and crash on the ⚖️/→ glyphs below.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001 — best-effort; older Python/streams
            pass

    args = p.parse_args()
    if args.cmd == "selftest":
        return cmd_selftest()
    if args.cmd == "scan":
        asyncio.run(cmd_scan(args.timeout))
    elif args.cmd == "monitor":
        asyncio.run(cmd_monitor(args.seconds))
    elif args.cmd == "read":
        asyncio.run(cmd_read(args.name, args.address, args.timeout, args.seconds, args.watch, args.init))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
