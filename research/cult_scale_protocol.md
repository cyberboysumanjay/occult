---
title: Cult Smart Scale (CS-BF01) — BLE protocol, reverse-engineered
date: 2026-06-06
status: CONCLUSIVE — weight/HR/protocol decoded; body composition NOT recoverable over BLE
device: "Cult Smart Scale" CS-BF01 (foot-only, 4-electrode)
oem: Cultsport (India) white-label of a Chinese OEM in the OneByone / Excelvan CF36x family
tools: tools/scale_probe.py
credit: openScale (GPLv3) — CultSmartScaleProHandler, OneByoneHandler/OneByoneLib, StandardImpedanceLib
---

# TL;DR

A foot-only (4-electrode) BIA scale on a proprietary `0xfff0` service. We fully
decoded **weight** and the **protocol/handshake**, and **proved that body
composition (muscle/bone/visceral/impedance) cannot be obtained over BLE** — not
by us, not by openScale. The official Cult app derives those from an **encrypted
`0xDF` packet** this unit never exposes to a third-party connection. Everything
that does *not* need impedance (weight, BMI, body-fat %, body water, BMR, lean
mass) is computed reliably and matches the Cult app within ~1–2 points.

# GATT layout

| Service | Char | Props | Use |
|---|---|---|---|
| `0xfff0` | `0xfff1` | write | command pipe (OneByone `FD`/`F1`/`F2` commands) |
| `0xfff0` | **`0xfff4`** | notify | all measurement frames |
| `0x180f` | `0x2a19` | read,notify | battery level |

# Frame format — `0xCF` weight frame (11 bytes) on `0xfff4`

```
offset  0    1   2    3  4    5  6  7   8   9    10
        cf  --  --   wt-LE    -- -- --  00  st   xor
```
| byte | field | notes |
|---|---|---|
| 0 | marker | always `0xCF` |
| 1–2 | **NOT a reliable field** | byte 1 often lands in HR range (the scale *displays* HR) but is not a stable value; treating bytes 1–2 as OneByone impedance gives ~4900 Ω → wrong |
| 3–4 | **weight** | uint16-LE ÷100 = kg. e.g. `4c 1d` = 0x1d4c = 7500 → 75.0 kg |
| 5–7 | **reserved / noise** | different garbage every session (`32 33 df`, `fc f6 e3`, `ba b5 d1`…) — NOT a usable impedance |
| 8 | — | `00` |
| 9 | **status** | `0x01` = settling · `0x00` = stable (foot-only, this unit never leaves `0x00`). On the 8-electrode *Pro*: `0x05`/`0x08` = handle measurement |
| 10 | **checksum** | `XOR(bytes 0..9)` — holds on every frame |

Other packet types exist on the **8-electrode Pro** (per openScale): `0xBE`
(real multi-frequency impedance) and `0xDF` (encrypted body comp). **Our
foot-only CS-BF01 sends neither** — only the 11-byte `0xCF` frame.

# Handshake (OneByone family) — CONFIRMED working

Write to `0xfff1`, in order:
1. `FD 37 <unit> <group> 00×6 <xor>` — mode/unit (unit: 00=kg)
2. `F1 <year-BE> <mon> <day> <hh> <mm> <ss>` — clock → scale ACKs **`F1 00`** ✓
3. `F2 00` — request history → scale ACKs **`F2 00`** marker ✓

Both ACKs were received (`scale_probe ... --init`), confirming the OneByone
protocol. **But:** the handshake did **not** change behaviour — live frames stay
`status 0x00` weight-only, and **history came back empty** (start marker, zero
stored frames). So neither live nor stored data yields a clean impedance.

# Why body composition is unreachable

- Skeletal muscle (Janssen) needs a physiologically normal whole-body impedance
  (~400–500 Ω) to produce a sensible figure. No byte interpretation yields a
  stable value in that range; candidate bytes are transient and differ every session.
- If the Cult app read these frame bytes (OneByone formula) it would produce an
  implausibly low muscle figure — so it does **not** read them. It uses the
  **`0xDF` encrypted body-comp packet**, which openScale documents as
  *"proprietary, could not be reverse-engineered,"* and which this foot-only unit
  never sends us.
- Avenues exhausted: passive read · accepted `FD/F1` handshake · `F2 00` history
  (empty) · three byte interpretations · both openScale Cult code paths.

**Conclusion:** muscle/bone/visceral/impedance are phone-app-only on this model.

# What IS reliable (no impedance needed)

occult computes these from weight + profile (age/sex/height) with cited
equations — no impedance required:

| metric | formula |
|---|---|
| Weight / BMI | direct |
| Body fat % | Deurenberg 1991 |
| Fat mass / lean mass | derived from fat % |
| BMR | Mifflin-St Jeor 1990 |
| Body water | Watson 1980 |

Validated against a reference reading from the official app: occult's
anthropometric estimates tracked the app's body-fat %, fat mass and BMR to within
~1–2 points / a few percent — useful, and all without touching the (unreachable)
impedance. The app's 4-compartment breakdown is internally consistent.

# Decode status (tools/scale_probe.py)
- ✅ weight, `0xCF` status byte, XOR checksum, `0xBE` parser (for the Pro),
  `0xDF`/history markers, OneByone `--init` handshake. `selftest` passes.
- ❌ body composition — not exposed by this unit; intentionally omitted from occult.
