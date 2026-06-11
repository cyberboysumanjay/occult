// Package protocol decodes the Cult Smart Scale (CS-BF01) BLE stream and runs
// the weigh-in state machine.
//
// Frame layout — 11 bytes, little-endian where multi-byte (see
// ../../research/cult_scale_protocol.md and js/ble/parser.js):
//
//	Offset  Len  Meaning
//	------  ---  -------
//	0       1    Magic marker: always 0xCF
//	1       1    Heart rate (bpm) — valid only in body phase; 0 while weighing
//	2       1    Unknown (not decoded)
//	3–4     2    Weight, LE uint16, unit = 0.01 kg  →  /100 for kg
//	5–6     2    Impedance, LE uint16 — zero/garbage while weighing
//	7–8     2    Unknown
//	9       1    Phase flag: 0x01 = still weighing; 0x00 = body/HR locked
//	10      1    XOR checksum of bytes 0–9
package protocol

// Phase is the measurement phase a frame belongs to.
type Phase int

const (
	// PhaseWeigh: the scale is still settling (status byte 0x01).
	PhaseWeigh Phase = iota
	// PhaseBody: weight locked; heart-rate / impedance fields are meaningful (0x00).
	PhaseBody
)

func (p Phase) String() string {
	if p == PhaseBody {
		return "body"
	}
	return "weigh"
}

// Frame is a decoded 11-byte measurement notification.
//
// HeartRate and ImpedanceRaw are 0 when not present (the scale reports 0 until a
// value is available); callers treat 0 as "absent" — see Session.
type Frame struct {
	Phase        Phase
	WeightKg     float64
	HeartRate    int // 0 = not available
	ImpedanceRaw int // 0 = not available
	ChecksumOK   bool
}

// ParseFrame decodes a single notification. ok is false when the buffer is not
// a recognised frame (wrong length or missing 0xCF marker). A frame with a bad
// checksum still returns ok=true but ChecksumOK=false, so the caller can decide.
func ParseFrame(b []byte) (Frame, bool) {
	if len(b) != 11 || b[0] != 0xCF {
		return Frame{}, false
	}

	// XOR checksum: XOR of bytes 0–9 must equal byte 10.
	var xor byte
	for i := 0; i < 10; i++ {
		xor ^= b[i]
	}
	checksumOK := xor == b[10]

	// Weight: LE uint16 at [3..4], unit = 0.01 kg, rounded to 2 dp.
	raw := int(b[3]) | int(b[4])<<8
	weightKg := float64(raw) / 100.0

	f := Frame{WeightKg: weightKg, ChecksumOK: checksumOK}
	if b[9] == 0x01 {
		f.Phase = PhaseWeigh
		return f, true
	}
	// Body phase: byte 1 = HR (0 = none), bytes 5–6 = impedance (0 = none).
	f.Phase = PhaseBody
	f.HeartRate = int(b[1])
	f.ImpedanceRaw = int(b[5]) | int(b[6])<<8
	return f, true
}
