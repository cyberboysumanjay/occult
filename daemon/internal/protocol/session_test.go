package protocol

import "testing"

var (
	weighFrame = []byte{0xCF, 0x00, 0x00, 0x4C, 0x1D, 0x00, 0x00, 0x00, 0x00, 0x01, 0x9F} // 75.0 kg, weigh
	bodyFrame  = []byte{0xCF, 0x3C, 0xC0, 0x4C, 0x1D, 0xF4, 0x01, 0x00, 0x00, 0x00, 0x97} // 75.0, hr60, imp500
)

func TestSession_LocksThenCompletes(t *testing.T) {
	s := NewSession()

	// Weight must repeat WeightLockFrames times before it locks.
	for i := 0; i < WeightLockFrames-1; i++ {
		up, done := s.Handle(weighFrame)
		if done != nil {
			t.Fatalf("frame %d: completed too early", i)
		}
		if up == nil || up.Kind == "locked" {
			t.Fatalf("frame %d: should not be locked yet (kind=%v)", i, kind(up))
		}
	}
	up, done := s.Handle(weighFrame) // the lock frame
	if done != nil {
		t.Fatal("should not complete on weight lock alone")
	}
	if up == nil || up.Kind != "locked" {
		t.Fatalf("expected locked update, got %v", kind(up))
	}
	if !s.WeightLocked() {
		t.Fatal("WeightLocked() should be true")
	}

	// Body phase: HR must converge (HRLockFrames identical) with impedance present.
	var final *Complete
	for i := 0; i < HRLockFrames; i++ {
		_, done = s.Handle(bodyFrame)
		if done != nil {
			final = done
		}
	}
	if final == nil {
		t.Fatal("expected completion after HR converged")
	}
	if final.Reason != "hr-stable" {
		t.Errorf("reason = %q, want hr-stable", final.Reason)
	}
	if final.WeightKg != 75.0 || final.HeartRate != 60 || final.ImpedanceRaw != 500 {
		t.Errorf("final = %+v, want 75.0/60/500", final)
	}
}

func TestSession_FinalizeOnDisconnect(t *testing.T) {
	s := NewSession()
	for i := 0; i < WeightLockFrames; i++ {
		s.Handle(weighFrame)
	}
	c := s.Finalize("disconnect")
	if c == nil {
		t.Fatal("locked session should finalise on disconnect")
	}
	if c.WeightKg != 75.0 || c.Reason != "disconnect" {
		t.Errorf("got %+v, want 75.0/disconnect", c)
	}
	// A second finalise must not double-emit.
	if again := s.Finalize("timeout"); again != nil {
		t.Error("session should complete only once")
	}
}

func TestSession_NoLockNoReading(t *testing.T) {
	s := NewSession()
	s.Handle(weighFrame) // single frame, never repeats to lock
	if c := s.Finalize("timeout"); c != nil {
		t.Errorf("unlocked session should not produce a reading, got %+v", c)
	}
}

func kind(u *Update) string {
	if u == nil {
		return "<nil>"
	}
	return u.Kind
}
