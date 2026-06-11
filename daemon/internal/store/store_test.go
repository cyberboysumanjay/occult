package store

import (
	"path/filepath"
	"testing"
)

func tempStore(t *testing.T) *Store {
	t.Helper()
	path := filepath.Join(t.TempDir(), "test.db")
	st, err := Open(path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

func ptrF(v float64) *float64 { return &v }
func ptrI(v int) *int         { return &v }

func TestInsertAndLatest(t *testing.T) {
	st := tempStore(t)

	if r, err := st.Latest(); err != nil || r != nil {
		t.Fatalf("empty store: got (%v, %v), want (nil, nil)", r, err)
	}

	id, err := st.Insert(Reading{
		Ts:         "2026-06-12T08:00:00Z",
		WeightKg:   75.3,
		HeartRate:  ptrI(60),
		Source:     "scale",
		BMI:        ptrF(23.8),
		BMIClass:   "normal",
		BodyFatPct: ptrF(18.2),
		BMRKcal:    ptrI(1720),
		Reason:     "hr-stable",
	})
	if err != nil {
		t.Fatalf("insert: %v", err)
	}
	if id != 1 {
		t.Errorf("first id = %d, want 1", id)
	}

	latest, err := st.Latest()
	if err != nil {
		t.Fatalf("latest: %v", err)
	}
	if latest == nil || latest.WeightKg != 75.3 {
		t.Fatalf("latest = %+v, want weight 75.3", latest)
	}
	if latest.HeartRate == nil || *latest.HeartRate != 60 {
		t.Errorf("heart rate round-trip failed: %+v", latest.HeartRate)
	}
	if latest.ImpedanceRaw != nil {
		t.Errorf("impedance should be nil, got %v", *latest.ImpedanceRaw)
	}
	if latest.BMIClass != "normal" {
		t.Errorf("bmiClass = %q, want normal", latest.BMIClass)
	}
}

func TestListOrderingAndSince(t *testing.T) {
	st := tempStore(t)
	times := []string{
		"2026-06-10T08:00:00Z",
		"2026-06-11T08:00:00Z",
		"2026-06-12T08:00:00Z",
	}
	for i, ts := range times {
		if _, err := st.Insert(Reading{Ts: ts, WeightKg: 70 + float64(i), Source: "scale"}); err != nil {
			t.Fatalf("insert %d: %v", i, err)
		}
	}

	all, err := st.List("")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(all) != 3 {
		t.Fatalf("len = %d, want 3", len(all))
	}
	if all[0].Ts != times[0] || all[2].Ts != times[2] {
		t.Errorf("expected ascending ts order, got %s … %s", all[0].Ts, all[2].Ts)
	}

	since, err := st.List("2026-06-10T08:00:00Z")
	if err != nil {
		t.Fatalf("list since: %v", err)
	}
	if len(since) != 2 {
		t.Errorf("since filter: len = %d, want 2 (strictly greater)", len(since))
	}
}

func TestDelete(t *testing.T) {
	st := tempStore(t)
	id, err := st.Insert(Reading{Ts: "2026-06-12T08:00:00Z", WeightKg: 75, Source: "scale"})
	if err != nil {
		t.Fatalf("insert: %v", err)
	}

	ok, err := st.Delete(id)
	if err != nil || !ok {
		t.Fatalf("delete: ok=%v err=%v, want ok=true", ok, err)
	}
	if latest, _ := st.Latest(); latest != nil {
		t.Errorf("store should be empty after delete, got %+v", latest)
	}

	// Deleting a non-existent row reports ok=false, no error.
	if ok, err := st.Delete(999); err != nil || ok {
		t.Errorf("delete missing: ok=%v err=%v, want ok=false err=nil", ok, err)
	}
}
