package stats

import (
	"math"
	"testing"
	"time"

	"occultd/internal/store"
)

func r(id int64, ts string, kg float64) store.Reading {
	return store.Reading{ID: id, Ts: ts, WeightKg: kg}
}

func TestDeltas_AcrossPeriods(t *testing.T) {
	history := []store.Reading{
		r(1, "2026-05-13T08:00:00Z", 80), // 1 month before
		r(2, "2026-05-29T08:00:00Z", 78), // 2 weeks before
		r(3, "2026-06-05T08:00:00Z", 77), // 1 week before
		r(4, "2026-06-11T08:00:00Z", 76), // 1 day before / previous
		r(5, "2026-06-12T08:00:00Z", 75), // current
	}
	cur := history[4]
	now, _ := time.Parse(time.RFC3339, cur.Ts)

	d := Deltas(history, cur, now)
	if len(d) != 5 {
		t.Fatalf("expected 5 chips, got %d", len(d))
	}

	want := []struct {
		label string
		delta float64
	}{
		{"vs last", -1.00},
		{"1 day", -1.00},
		{"1 week", -2.00},
		{"2 weeks", -3.00},
		{"1 month", -5.00},
	}
	for i, w := range want {
		if d[i].Label != w.label {
			t.Errorf("chip %d label = %q, want %q", i, d[i].Label, w.label)
		}
		if !d[i].Available {
			t.Errorf("chip %q should be available", w.label)
		}
		if math.Abs(d[i].DeltaKg-w.delta) > 1e-9 {
			t.Errorf("chip %q delta = %v, want %v", w.label, d[i].DeltaKg, w.delta)
		}
	}
}

func TestDeltas_FirstReadingHasNoBaselines(t *testing.T) {
	cur := r(1, "2026-06-12T08:00:00Z", 75)
	d := Deltas([]store.Reading{cur}, cur, time.Now())
	for _, chip := range d {
		if chip.Available {
			t.Errorf("chip %q should be unavailable for the very first reading", chip.Label)
		}
	}
}
