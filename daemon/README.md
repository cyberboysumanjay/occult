# occultd

`occultd` is a headless Bluetooth scale logger for the Cult Smart Scale (CS-BF01).
It runs 24/7 on a Linux home server (Raspberry Pi, mini PC, etc.), listens for the
scale over BLE, captures each weigh-in into a local SQLite database, and serves a
read-only web dashboard and JSON API — all in a single, CGO-free Go binary.
It is a server-side companion to the [occult PWA](../) but works completely standalone.

## Architecture

```
┌─────────────┐  BLE advert   ┌─────────────────────────────────────────────────┐
│  Cult Smart │ ───────────►  │  occultd                                        │
│  Scale      │               │                                                  │
│  (CS-BF01)  │  GATT notify  │  BLE listener ──► state machine ──► SQLite DB  │
│             │ ◄──────────►  │                                          │       │
└─────────────┘               │                       HTTP server ◄──────┘       │
                               └──────────────────────────┬──────────────────────┘
                                                          │  :8765
                                                          ▼
                                              phone / browser dashboard
```

## Build

Requires Go 1.22+. No CGO — the binary is fully self-contained.

```sh
make tidy && make build     # outputs bin/occultd
```

Cross-compile for a different machine from any host OS:

```sh
make linux-arm64   # 64-bit Raspberry Pi 4/5, most modern SBCs
make linux-arm     # 32-bit Raspberry Pi (armv7)
make linux-amd64   # x86-64 mini PC or VM
```

## Configure

There is **no config file** — all configuration lives in the database and is set
through the web UI. The only two settings that can't (the database path and the
listen address) are flags:

```sh
occultd -db /var/lib/occultd/occult.db -addr :8765   # these are also the defaults
```

On first run the dashboard shows an **onboarding wizard** (name, sex, age, height,
and optional Telegram). After that, the header **⚙ Settings** panel lets you edit
the profile, Telegram credentials (with a *Send test message* button), and
advanced scale tuning at any time. Changes apply live — no restart needed.

## Install as a service

1. Copy the binary into place:

   ```sh
   sudo cp bin/occultd /usr/local/bin/occultd
   ```

2. Create a dedicated system user and add it to the `bluetooth` group:

   ```sh
   sudo useradd --system --no-create-home occultd
   sudo usermod -aG bluetooth occultd
   ```

   Alternatively, edit the `User=` / `Group=` lines in `occultd.service` to use
   your own login account if it is already in the `bluetooth` group.

3. Install and start the systemd unit:

   ```sh
   sudo cp occultd.service /etc/systemd/system/occultd.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now occultd
   ```

4. Follow logs:

   ```sh
   journalctl -u occultd -f
   ```

## Bluetooth prerequisites on Linux

- BlueZ must be installed and `bluetooth.service` must be running:
  ```sh
  sudo apt install bluez          # Debian/Raspbian
  sudo systemctl enable --now bluetooth
  ```
- The user running `occultd` must be in the `bluetooth` group (see above).
- The adapter must be powered on:
  ```sh
  bluetoothctl power on
  ```
- The Cult Smart Scale only advertises while you are actively standing on it —
  there is no persistent background advertisement. occultd will capture the
  weigh-in automatically when you step on the scale.

## Usage

Step on the scale. occultd detects the advertisement, connects, waits for a
stable reading, records it to SQLite, then disconnects. The `cooldown_seconds`
setting (default 20 s) prevents a single weigh-in from being recorded twice.

View the dashboard at:

```
http://<your-box-ip>:8765
```

The same data is available as JSON via the API:

| Method & path | Purpose |
|---|---|
| `GET /api/profile` | the configured user |
| `GET /api/latest` | most-recent reading (or `{}`) |
| `GET /api/readings[?since=<ISO8601>]` | all readings, oldest→newest |
| `DELETE /api/readings/{id}` | remove a stray reading (also available as the ✕ button on each history row) |

## Telegram notifications (optional)

Open **⚙ Settings → Telegram** in the dashboard and enter a bot token + chat id;
use **Send test message** to confirm it works. From then on occultd pushes a card
to your chat on **every** new reading — a caption plus a rendered image showing
the weight, body-composition snapshot, a weight sparkline, and trend deltas
**vs your previous reading, 1 day, 1 week, 2 weeks and 1 month ago** (each compared
against the most-recent reading at or before that point).

- **bot token** — create a bot with [@BotFather](https://t.me/BotFather).
- **chat id** — message your new bot once, then open
  `https://api.telegram.org/bot<token>/getUpdates` and read `message.chat.id`
  (or DM `@userinfobot`).

Leave either field blank to disable. The image is rendered in pure Go (no headless
browser, no extra system packages).

## Body composition — what is and is not estimated

Weight, BMI, body-fat %, fat mass, lean mass, BMR, and body water are computed
from weight + profile (age, sex, height) using established anthropometric
equations (Deurenberg 1991, Mifflin-St Jeor 1990, Watson 1980). These figures
match the official Cult app to within ~1–2 points and require no impedance data.

Skeletal muscle mass (Janssen 2000), heart rate, and raw impedance are captured
from the BLE frame when present. **However, this foot-only unit (CS-BF01) does
not expose usable impedance over BLE to third-party connections.** The bytes in
the impedance position of the 0xCF frame are transient noise, not a stable
physiological reading. The official app derives muscle/bone/visceral values from
an encrypted `0xDF` packet that this unit never sends. See
[`../research/cult_scale_protocol.md`](../research/cult_scale_protocol.md) for
the full protocol reverse-engineering notes.

## Troubleshooting

| Symptom | Check |
|---|---|
| Scale not captured | Is the run user in the `bluetooth` group? Is `bluetooth.service` running? Is `rssi_threshold` too strict (raise it toward -100)? |
| Permission denied on DB | Does the `-db` path sit inside `StateDirectory` (`/var/lib/occultd`)? Does the run user own that path? |
| Nothing on dashboard | `journalctl -u occultd -f` — look for startup errors. Is `:8765` reachable (firewall)? |
| Stuck on onboarding | The POST to `/api/settings` needs name + a positive height; check the browser console and `journalctl`. |
| Unit fails to start | Try running manually as the target user: `sudo -u occultd occultd -db /var/lib/occultd/occult.db` |
