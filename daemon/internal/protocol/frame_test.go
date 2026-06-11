package protocol

import "testing"

func TestParseFrame_Weigh(t *testing.T) {
	// 75.0 kg, weigh phase (status 0x01), valid XOR (0x9F).
	f, ok := ParseFrame([]byte{0xCF, 0x00, 0x00, 0x4C, 0x1D, 0x00, 0x00, 0x00, 0x00, 0x01, 0x9F})
	if !ok {
		t.Fatal("expected ok")
	}
	if f.Phase != PhaseWeigh {
		t.Errorf("phase = %v, want weigh", f.Phase)
	}
	if f.WeightKg != 75.0 {
		t.Errorf("weight = %v, want 75.0", f.WeightKg)
	}
	if f.HeartRate != 0 || f.ImpedanceRaw != 0 {
		t.Errorf("weigh frame should carry no HR/impedance, got hr=%d imp=%d", f.HeartRate, f.ImpedanceRaw)
	}
	if !f.ChecksumOK {
		t.Error("checksum should be valid")
	}
}

func TestParseFrame_Body(t *testing.T) {
	// 75.0 kg, body phase (0x00), HR 0x3C=60, impedance 0x01F4=500, XOR 0x97.
	f, ok := ParseFrame([]byte{0xCF, 0x3C, 0xC0, 0x4C, 0x1D, 0xF4, 0x01, 0x00, 0x00, 0x00, 0x97})
	if !ok {
		t.Fatal("expected ok")
	}
	if f.Phase != PhaseBody {
		t.Errorf("phase = %v, want body", f.Phase)
	}
	if f.WeightKg != 75.0 {
		t.Errorf("weight = %v, want 75.0", f.WeightKg)
	}
	if f.HeartRate != 60 {
		t.Errorf("hr = %d, want 60", f.HeartRate)
	}
	if f.ImpedanceRaw != 500 {
		t.Errorf("impedance = %d, want 500", f.ImpedanceRaw)
	}
	if !f.ChecksumOK {
		t.Error("checksum should be valid")
	}
}

func TestParseFrame_BadChecksum(t *testing.T) {
	f, ok := ParseFrame([]byte{0xCF, 0x00, 0x00, 0x92, 0x27, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00})
	if !ok {
		t.Fatal("expected ok (frame recognised) even with bad checksum")
	}
	if f.ChecksumOK {
		t.Error("checksum should be flagged invalid")
	}
}

func TestParseFrame_Rejects(t *testing.T) {
	if _, ok := ParseFrame([]byte{0x01, 0x02, 0x03}); ok {
		t.Error("short buffer should be rejected")
	}
	if _, ok := ParseFrame([]byte{0xAB, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0}); ok {
		t.Error("wrong marker should be rejected")
	}
}
