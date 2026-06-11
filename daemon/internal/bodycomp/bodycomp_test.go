package bodycomp

import (
	"math"
	"testing"
)

func near(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

func TestBMI(t *testing.T) {
	if got := BMI(100, 200); !near(got, 25.0) { // 100 kg / 2.00 m² = 25.0
		t.Errorf("BMI = %v, want 25.0", got)
	}
}

func TestBMRMifflin(t *testing.T) {
	if got := BMRMifflin(80, 180, 30, "male"); !near(got, 1780) { // 800+1125-150+5
		t.Errorf("male BMR = %v, want 1780", got)
	}
	if got := BMRMifflin(80, 180, 30, "female"); !near(got, 1614) { // 800+1125-150-161
		t.Errorf("female BMR = %v, want 1614", got)
	}
}

func TestBodyFatDeurenberg(t *testing.T) {
	if got := BodyFatDeurenberg(25, 40, "male"); !near(got, 23.0) { // 30+9.2-10.8-5.4
		t.Errorf("body fat = %v, want 23.0", got)
	}
}

func TestBMIClass(t *testing.T) {
	cases := map[float64]string{
		17: "underweight", 22: "normal", 27: "overweight",
		32: "obese (class I)", 37: "obese (class II)", 42: "obese (class III)",
	}
	for b, want := range cases {
		if got := BMIClass(b); got != want {
			t.Errorf("BMIClass(%v) = %q, want %q", b, got, want)
		}
	}
}

func TestCompose_NoImpedance(t *testing.T) {
	d := Compose(Profile{Age: 30, Sex: "male", HeightCm: 178}, 75)
	if d.BMI <= 0 || d.BMRKcal <= 0 || d.BodyFatPct <= 0 {
		t.Errorf("expected populated anthropometrics, got %+v", d)
	}
	if d.SMMKg != nil || d.SMMPct != nil {
		t.Error("skeletal muscle should be nil (no usable impedance on this scale)")
	}
	if d.FatMassKg+d.FFMKg < 74 || d.FatMassKg+d.FFMKg > 76 {
		t.Errorf("fat + lean mass should ≈ weight (75), got %v", d.FatMassKg+d.FFMKg)
	}
}

func TestCompose_IncompleteProfile(t *testing.T) {
	if d := Compose(Profile{Age: 30, Sex: "male"}, 75); d.BMI != 0 {
		t.Errorf("missing height should yield empty Derived, got %+v", d)
	}
}
