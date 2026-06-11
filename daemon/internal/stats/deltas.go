// Package stats computes weight deltas of a reading against historical baselines
// (the previous reading, and the most-recent reading at/before 1 day, 1 week,
// 2 weeks and 1 month ago). These power the Telegram card's trend chips.
package stats

import (
	"time"

	"occultd/internal/store"
)

// Delta is the change from a historical baseline to the current reading.
type Delta struct {
	Label      string  // "vs last", "1 day", "1 week", "2 weeks", "1 month"
	Available  bool    // a baseline reading existed for this period
	DeltaKg    float64 // current.WeightKg - baseline.WeightKg (negative = lost weight)
	BaselineKg float64 // the comparison weight
	BaselineTs string  // when the baseline was taken (RFC3339)
}

// period defines one time-window baseline.
type period struct {
	label string
	dur   time.Duration
}

var periods = []period{
	{"1 day", 24 * time.Hour},
	{"1 week", 7 * 24 * time.Hour},
	{"2 weeks", 14 * 24 * time.Hour},
	{"1 month", 30 * 24 * time.Hour},
}

// Deltas returns the trend chips for current, given the full ascending-by-ts
// reading history (which may or may not already include current — it is excluded
// by id). The first entry is always "vs last" (the immediately previous
// reading); the rest are the fixed time windows. Periods with no qualifying
// baseline are returned with Available=false so the caller can show a dash.
func Deltas(history []store.Reading, current store.Reading, now time.Time) []Delta {
	curT, err := time.Parse(time.RFC3339, current.Ts)
	if err != nil {
		curT = now
	}

	out := make([]Delta, 0, len(periods)+1)

	// "vs last": the reading with the greatest ts strictly before current.
	if prev := latestBefore(history, curT, current.ID); prev != nil {
		out = append(out, delta("vs last", current, *prev))
	} else {
		out = append(out, Delta{Label: "vs last"})
	}

	// Fixed windows: most-recent reading at/before (curT - dur).
	for _, p := range periods {
		cutoff := curT.Add(-p.dur)
		if base := atOrBefore(history, cutoff, current.ID); base != nil {
			out = append(out, delta(p.label, current, *base))
		} else {
			out = append(out, Delta{Label: p.label})
		}
	}
	return out
}

func delta(label string, cur, base store.Reading) Delta {
	return Delta{
		Label:      label,
		Available:  true,
		DeltaKg:    round2(cur.WeightKg - base.WeightKg),
		BaselineKg: base.WeightKg,
		BaselineTs: base.Ts,
	}
}

// latestBefore returns the reading with the greatest ts strictly before t,
// skipping excludeID. history is assumed ascending by ts.
func latestBefore(history []store.Reading, t time.Time, excludeID int64) *store.Reading {
	var found *store.Reading
	for i := range history {
		r := &history[i]
		if r.ID == excludeID {
			continue
		}
		ts, err := time.Parse(time.RFC3339, r.Ts)
		if err != nil || !ts.Before(t) {
			continue
		}
		found = r // ascending → last match is the closest before t
	}
	return found
}

// atOrBefore returns the reading with the greatest ts <= cutoff, skipping excludeID.
func atOrBefore(history []store.Reading, cutoff time.Time, excludeID int64) *store.Reading {
	var found *store.Reading
	for i := range history {
		r := &history[i]
		if r.ID == excludeID {
			continue
		}
		ts, err := time.Parse(time.RFC3339, r.Ts)
		if err != nil || ts.After(cutoff) {
			continue
		}
		found = r
	}
	return found
}

func round2(x float64) float64 {
	return float64(int64(x*100+sign(x)*0.5)) / 100
}

func sign(x float64) float64 {
	if x < 0 {
		return -1
	}
	return 1
}
