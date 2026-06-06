# occult

**Read your smart scale's hidden telemetry — fully in your browser, no app, no cloud.**

`occult` is an unofficial, independent Web Bluetooth client for the **Cult Smart
Scale**. It connects to the scale over BLE straight from a Chromium-family
browser, decodes the proprietary measurement frames (weight, heart rate, and
bioimpedance), computes body composition on-device with peer-reviewed equations,
stores everything locally in IndexedDB, and charts your trends — across multiple
user profiles.

No accounts. No servers. Nothing leaves your device.

> [!IMPORTANT]
> **Disclaimer.** Unofficial, third-party project for **educational, research,
> and personal-interoperability purposes only**. Not affiliated with, endorsed
> by, or sponsored by the makers of the scale; product names are referenced
> nominatively to describe hardware compatibility only. The metrics shown are
> **not clinically validated and are not medical advice**. Bioimpedance is noisy
> — treat everything here as trends, not truth.

---

## Features

- **Direct BLE pairing** — Web Bluetooth talks to the scale on service `0xfff0`,
  no handshake required (the protocol was reverse-engineered live; see
  [`research/cult_scale_protocol.md`](research/cult_scale_protocol.md)).
- **Live weigh-in** — watch the weight settle and your heart rate read out in real time.
- **On-device body composition** — BMI, body-fat % (Deurenberg 1991), total body
  water (Watson 1980), resting metabolic rate (Mifflin-St Jeor 1990), and
  skeletal-muscle mass (Janssen 2000) from the scale's impedance.
- **Multiple profiles** — track the whole household; each profile has its own
  height/sex/age, accent color, optional impedance calibration, and history.
- **Beautiful trends** — weight, fat %, muscle, and BMI line charts plus a
  body-composition donut, themed per profile.
- **Local-first** — all data in IndexedDB. CSV + full JSON export/import.
- **Manual entry** — works even without the scale or Web Bluetooth.
- **Installable PWA**, dark "gilded-grimoire" aesthetic.

## Run it

Web Bluetooth needs a **secure context** (no `file://`) and a **Chromium browser**
(Chrome/Edge on desktop, or Bluefy on iPhone). Serve the folder:

```bash
python serve.py          # → http://localhost:8765
# or:
python -m http.server 8765
```

Open `http://localhost:8765` in Chrome. On first launch you set up a profile
(name, age, sex, height); then press **Measure** and step on the scale. The
dashboard stays empty until your first real reading. Add more profiles any time
from the Profiles tab.

## Deploy (optional)

It's pure static files — drop the folder on any static host:

```bash
# Cloudflare Pages
npx wrangler pages deploy . --project-name=occult
# or GitHub Pages: push and enable Pages on the repo root
```

HTTPS there satisfies the secure-context requirement automatically.

## How the scale protocol works

11-byte frames on notify characteristic `0xfff4`, marker `0xCF`:

| byte | field |
|---|---|
| 0 | `0xCF` marker |
| 1 | heart rate (bpm, body phase) |
| 3–4 | weight, little-endian uint16 ÷ 100 = kg |
| 5–6 | impedance (raw) |
| 9 | phase flag (`0x01` weighing, `0x00` body/HR) |
| 10 | XOR checksum of bytes 0–9 |

Full writeup, calibration notes, and the body-composition derivation:
[`research/cult_scale_protocol.md`](research/cult_scale_protocol.md).

## Layout

```
occult/
├── index.html              dashboard shell
├── app.js                  controller (wires BLE ↔ store ↔ metrics ↔ UI)
├── styles.css              design system
├── vendor/chart.umd.min.js Chart.js (vendored)
├── js/
│   ├── ble/      uuids · parser (frame decode) · client (Web Bluetooth)
│   ├── data/     schema · db · store (CRUD) · export
│   ├── metrics/  bodycomp (BMI/BMR/fat/TBW/SMM)
│   ├── ui/       charts · render · profiles-ui
│   └── util/     events · format
└── research/     reverse-engineered protocol notes
```

## Credits & references

- **[openScale](https://github.com/oliexdev/openScale)** (GPLv3) — the open-source
  BLE-scale project. Its `CultSmartScaleProHandler`, `OneByoneHandler` /
  `OneByoneLib`, and `StandardImpedanceLib` were invaluable for decoding the
  protocol family and the body-composition formulas (and for confirming the
  encrypted `0xDF` body-comp packet is not reverse-engineerable).
- **[whoof](https://github.com/madhursatija/whoof)** — an independent, local-first
  Web Bluetooth client for the WHOOP 4.0 strap. Its architecture (vanilla-JS
  modules, IndexedDB, cache-first PWA, on-device metrics) was the blueprint for
  occult's "own your data, no cloud" design.

## License

MIT. Product names are trademarks of their respective owners; this project is
not affiliated with or endorsed by them.
