// BLE frame parser for the Cult Smart Scale (CF-header family).
//
// Frame layout — 11 bytes, little-endian where multi-byte:
//
//   Offset  Len  Meaning
//   ------  ---  -------
//   0       1    Magic marker: always 0xCF
//   1       1    Heart rate (bpm) — valid only in body phase; 0 while weighing
//   2       1    Unknown (rising counter / signal quality — not decoded)
//   3–4     2    Weight, LE uint16, unit = 0.01 kg  →  divide by 100 for kg
//   5–6     2    Impedance, LE uint16 (ohms, ~)     — zero while weighing
//   7       1    Unknown (possibly secondary impedance byte — not decoded)
//   8       1    Unknown
//   9       1    Phase flag: 0x01 = still weighing; 0x00 = body/HR locked
//   10      1    XOR checksum of bytes 0–9
//
// Source: reverse-engineered live — see research/cult_scale_protocol.md and
// the validated Python reference in healthee/tools/scale_probe.py::parse_cf_scale().

/**
 * Parse a single 11-byte notification frame from the Cult Smart Scale.
 *
 * @param {Uint8Array|DataView} bytes
 * @returns {{ phase: 'weigh'|'body', weightKg: number,
 *             heartRate: number|null, impedanceRaw: number|null,
 *             checksumOk: boolean } | null}
 *   null if the frame is not recognised (wrong length or missing 0xCF marker).
 */
export function parseCultFrame(bytes) {
  // Normalise DataView → Uint8Array so we can index directly.
  const b = bytes instanceof DataView
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : bytes;

  if (b.length !== 11 || b[0] !== 0xCF) return null;

  // XOR checksum: XOR of bytes 0–9 must equal byte 10.
  let xor = 0;
  for (let i = 0; i < 10; i++) xor ^= b[i];
  const checksumOk = xor === b[10];

  // Weight: LE uint16 at [3..4], unit = 0.01 kg.
  const weightKg = Math.round((b[3] | (b[4] << 8)) / 100 * 100) / 100;

  // Phase 0x01 = scale is still settling (weigh); 0x00 = reading locked, HR/impedance valid.
  const isWeigh = b[9] === 0x01;

  if (isWeigh) {
    return { phase: 'weigh', weightKg, heartRate: null, impedanceRaw: null, checksumOk };
  }

  // Body phase: byte 1 = HR (0 means not yet measured → null), bytes 5–6 = impedance.
  const heartRate    = b[1] || null;                    // 0x00 = not available
  const impedanceRaw = (b[5] | (b[6] << 8)) || null;   // 0 = not available

  return { phase: 'body', weightKg, heartRate, impedanceRaw, checksumOk };
}

/**
 * Self-test: verify parseCultFrame against the three captured reference frames.
 * Call this at app startup or during CI to catch accidental regressions.
 *
 * @returns {boolean} true iff all assertions pass.
 */
export function cultSelfTest() {
  let ok = true;

  // ── Weigh frame ───────────────────────────────────────────────────────────
  // Raw: cf 00 00 4c 1d 00 00 00 00 01 9f  (illustrative 75.0 kg)
  // Expected: weight 75.0 kg, phase 'weigh', checksumOk true
  const weigh = parseCultFrame(new Uint8Array([0xCF,0x00,0x00,0x4C,0x1D,0x00,0x00,0x00,0x00,0x01,0x9F]));
  ok &&= weigh !== null
      && weigh.phase === 'weigh'
      && weigh.weightKg === 75.0
      && weigh.heartRate === null
      && weigh.impedanceRaw === null
      && weigh.checksumOk === true;

  // ── Body/HR frame ─────────────────────────────────────────────────────────
  // Raw: cf 3c c0 4c 1d f4 01 00 00 00 97  (illustrative 75.0 kg, body phase)
  // Expected: weight 75.0 kg, byte1=0x3c=60, bytes5-6=0x01f4=500, phase 'body'
  const body = parseCultFrame(new Uint8Array([0xCF,0x3C,0xC0,0x4C,0x1D,0xF4,0x01,0x00,0x00,0x00,0x97]));
  ok &&= body !== null
      && body.phase === 'body'
      && body.weightKg === 75.0
      && body.heartRate === 60
      && body.impedanceRaw === 500
      && body.checksumOk === true;

  // ── Corrupted checksum ────────────────────────────────────────────────────
  // Same weigh frame but with byte 10 set to 0x00 (was 0x7b) — must flag checksumOk false.
  const corrupt = parseCultFrame(new Uint8Array([0xCF,0x00,0x00,0x92,0x27,0x00,0x00,0x00,0x00,0x01,0x00]));
  ok &&= corrupt !== null && corrupt.checksumOk === false;

  return ok;
}
