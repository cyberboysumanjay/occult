package protocol

// Session is the weigh-in state machine, ported from js/ble/client.js.
//
// A weigh-in has TWO phases on the wire:
//  1. weigh — the weight settles, then repeats (status 0x01). We "lock" it once
//     the same value repeats WeightLockFrames times.
//  2. body  — heart rate converges and impedance fills in (status 0x00); then
//     the scale flashes the HR and powers off.
//
// So we must NOT finish on the weight lock alone — after locking we wait for the
// body phase (HR stable + impedance present). The BLE layer additionally calls
// Finalize on a post-lock timeout or on power-off (disconnect), so a reading is
// always produced once a weight has locked.
//
// Session is pure (no timers, no I/O) so it is fully unit-testable; the BLE
// layer owns the clock and the disconnect signal.
const (
	// WeightLockFrames: identical weight frames in a row → weight is locked.
	WeightLockFrames = 3
	// HRLockFrames: identical heart-rate frames (body phase) → HR has converged.
	HRLockFrames = 4
)

// Update is a progress event emitted per clean frame, for logging/observability.
type Update struct {
	Kind         string  // "live" | "locked" | "measuring"
	Phase        string  // "weigh" | "body"
	WeightKg     float64 //
	HeartRate    int     // 0 = none
	HasImpedance bool    //
	Locked       bool    // weight locked yet?
	Ticks        int     // consecutive identical HR frames (body phase)
}

// Complete is the final reading for a weigh-in (emitted at most once).
type Complete struct {
	WeightKg     float64
	HeartRate    int    // 0 = none
	ImpedanceRaw int    // 0 = none
	Reason       string // "hr-stable" | "timeout" | "disconnect"
}

// Session accumulates frames for one weigh-in. Create one per session.
type Session struct {
	lastWeight   float64
	weightCount  int
	weightLocked bool

	latestHR        int
	latestImpedance int

	lastHR  int
	hrCount int

	completed bool
}

// NewSession returns a fresh state machine.
func NewSession() *Session { return &Session{} }

// WeightLocked reports whether the weight has settled (a reading can be produced).
func (s *Session) WeightLocked() bool { return s.weightLocked }

// Completed reports whether a final reading has already been produced.
func (s *Session) Completed() bool { return s.completed }

// Handle feeds one raw notification buffer. It returns an Update for every clean
// frame (nil if the frame is unrecognised or fails its checksum), and a non-nil
// Complete exactly once when the body phase converges (HR stable + impedance).
func (s *Session) Handle(buf []byte) (*Update, *Complete) {
	f, ok := ParseFrame(buf)
	if !ok || !f.ChecksumOK {
		return nil, nil
	}

	up := &Update{
		Kind:      "live",
		Phase:     f.Phase.String(),
		WeightKg:  f.WeightKg,
		HeartRate: f.HeartRate,
		Locked:    s.weightLocked,
	}

	// Carry the latest body-phase HR / impedance (locking frames may be weigh-phase).
	if f.Phase == PhaseBody {
		if f.HeartRate != 0 {
			s.latestHR = f.HeartRate
		}
		if f.ImpedanceRaw != 0 {
			s.latestImpedance = f.ImpedanceRaw
		}
	}

	// 1) Lock the weight once it repeats WeightLockFrames times.
	if f.WeightKg > 0 {
		if f.WeightKg == s.lastWeight {
			s.weightCount++
		} else {
			s.lastWeight = f.WeightKg
			s.weightCount = 1
		}
		if !s.weightLocked && s.weightCount >= WeightLockFrames {
			s.weightLocked = true
			up.Kind = "locked"
			up.Locked = true
			return up, nil
		}
	}

	// 2) After lock, wait for the HR read to converge + impedance to land.
	if s.weightLocked && f.Phase == PhaseBody && f.HeartRate != 0 {
		if f.HeartRate == s.lastHR {
			s.hrCount++
		} else {
			s.lastHR = f.HeartRate
			s.hrCount = 1
		}
		up.Kind = "measuring"
		up.HasImpedance = s.latestImpedance != 0
		up.Ticks = s.hrCount
		if s.hrCount >= HRLockFrames && s.latestImpedance != 0 {
			if c := s.finish("hr-stable"); c != nil {
				return up, c
			}
		}
	}

	return up, nil
}

// Finalize forces completion with the captured values, used by the BLE layer on
// a post-lock timeout or on power-off (disconnect). Returns nil if no weight was
// ever locked, or if the session already completed.
func (s *Session) Finalize(reason string) *Complete {
	return s.finish(reason)
}

func (s *Session) finish(reason string) *Complete {
	if s.completed || !s.weightLocked {
		return nil
	}
	s.completed = true
	return &Complete{
		WeightKg:     s.lastWeight,
		HeartRate:    s.latestHR,
		ImpedanceRaw: s.latestImpedance,
		Reason:       reason,
	}
}
