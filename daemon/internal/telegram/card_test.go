package telegram

import (
	"bytes"
	"testing"
	"time"
)

// TestRenderCard exercises the full gg + embedded-font drawing path and verifies
// a valid PNG comes out. This guards against a font/draw panic that would
// otherwise only surface at the first real weigh-in.
func TestRenderCard(t *testing.T) {
	bmi := 23.8
	bf := 18.2
	bmr := 1720
	water := 58.6
	hr := 60

	png, err := RenderCard(CardData{
		ProfileName:  "Sample",
		Ts:           time.Date(2026, 6, 12, 8, 14, 0, 0, time.UTC),
		WeightKg:     75.3,
		BMI:          &bmi,
		BMIClass:     "normal",
		BodyFatPct:   &bf,
		BMRKcal:      &bmr,
		BodyWaterPct: &water,
		HeartRate:    &hr,
		Deltas: []DeltaView{
			{Label: "vs last", Available: true, DeltaKg: -0.4},
			{Label: "1 day", Available: true, DeltaKg: 0.2},
			{Label: "1 week", Available: true, DeltaKg: -1.1},
			{Label: "2 weeks", Available: false},
			{Label: "1 month", Available: true, DeltaKg: -2.3},
		},
		Spark: []float64{78, 77.6, 77.1, 76.8, 76.9, 76.2, 75.8, 75.3},
	})
	if err != nil {
		t.Fatalf("RenderCard: %v", err)
	}
	if len(png) < 1000 {
		t.Fatalf("PNG suspiciously small: %d bytes", len(png))
	}
	// PNG magic header.
	if !bytes.HasPrefix(png, []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}) {
		t.Fatalf("output is not a PNG (header = % x)", png[:8])
	}
}

func TestCaption_Renders(t *testing.T) {
	cap := Caption(CardData{
		ProfileName: "Sample",
		Ts:          time.Date(2026, 6, 12, 8, 14, 0, 0, time.UTC),
		WeightKg:    75.3,
		Deltas:      []DeltaView{{Label: "vs last", Available: true, DeltaKg: -0.4}},
	})
	if cap == "" {
		t.Fatal("empty caption")
	}
}
