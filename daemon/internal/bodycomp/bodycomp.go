// Package bodycomp computes anthropometric body-composition estimates from a
// profile + weight, with NO impedance required.
//
// Ported from research/body_composition.py and js/metrics/bodycomp.js. The
// CS-BF01 scale does not expose a usable impedance over BLE (see
// research/cult_scale_protocol.md), so the impedance-dependent skeletal-muscle
// figure (Janssen) is intentionally left nil.
//
// References:
//   - Mifflin MD et al. Am J Clin Nutr 1990;51:241-247 (BMR)
//   - Deurenberg P et al. Br J Nutr 1991;65:105-114 (body fat %)
//   - Watson PE et al. Am J Clin Nutr 1980;33:27-39 (total body water)
//
// NOT medical advice — scale/anthropometric estimates are trends, not truth.
package bodycomp

import "math"

// Profile is the minimal anthropometric input.
type Profile struct {
	Age      int     // years
	Sex      string  // "male" | "female"
	HeightCm float64 //
}

// Derived is the body-comp snapshot frozen at save time. Fields mirror occult's
// Reading shape. Pointer fields are nil when not computable.
type Derived struct {
	BMI          float64
	BMIClass     string
	BodyFatPct   float64
	FatMassKg    float64
	FFMKg        float64 // fat-free mass
	TBWL         float64 // total body water, litres
	BodyWaterPct float64
	BMRKcal      int
	SMMKg        *float64 // nil — no usable impedance on this scale
	SMMPct       *float64 // nil
}

// BMI = kg / m².
func BMI(weightKg, heightCm float64) float64 {
	h := heightCm / 100.0
	return weightKg / (h * h)
}

// BMIClass is the WHO category for a BMI value.
func BMIClass(b float64) string {
	switch {
	case b < 18.5:
		return "underweight"
	case b < 25:
		return "normal"
	case b < 30:
		return "overweight"
	case b < 35:
		return "obese (class I)"
	case b < 40:
		return "obese (class II)"
	default:
		return "obese (class III)"
	}
}

// BMRMifflin is the Mifflin-St Jeor 1990 resting metabolic rate (kcal/day).
func BMRMifflin(weightKg, heightCm float64, age int, sex string) float64 {
	base := 10*weightKg + 6.25*heightCm - 5*float64(age)
	if sex == "male" {
		return base + 5
	}
	return base - 161
}

// BodyFatDeurenberg is the Deurenberg 1991 BMI-based body-fat %.
func BodyFatDeurenberg(bmi float64, age int, sex string) float64 {
	s := 0.0
	if sex == "male" {
		s = 1
	}
	return 1.20*bmi + 0.23*float64(age) - 10.8*s - 5.4
}

// TBWWatson is Watson 1980 total body water (litres).
func TBWWatson(weightKg, heightCm float64, age int, sex string) float64 {
	if sex == "male" {
		return 2.447 - 0.09156*float64(age) + 0.1074*heightCm + 0.3362*weightKg
	}
	return -2.097 + 0.1069*heightCm + 0.2466*weightKg
}

// Compose produces the full anthropometric snapshot for a weigh-in. If the
// profile is incomplete (no height/sex), it returns a zero Derived with only
// what can be computed; callers store what is present.
func Compose(p Profile, weightKg float64) Derived {
	if p.HeightCm <= 0 || weightKg <= 0 {
		return Derived{}
	}
	b := BMI(weightKg, p.HeightCm)
	bf := BodyFatDeurenberg(b, p.Age, p.Sex)
	fatMass := weightKg * bf / 100.0
	ffm := weightKg - fatMass
	tbw := TBWWatson(weightKg, p.HeightCm, p.Age, p.Sex)

	return Derived{
		BMI:          round1(b),
		BMIClass:     BMIClass(b),
		BodyFatPct:   round1(bf),
		FatMassKg:    round1(fatMass),
		FFMKg:        round1(ffm),
		TBWL:         round1(tbw),
		BodyWaterPct: round1(tbw / weightKg * 100),
		BMRKcal:      int(math.Round(BMRMifflin(weightKg, p.HeightCm, p.Age, p.Sex))),
		SMMKg:        nil, // no usable impedance — see package doc
		SMMPct:       nil,
	}
}

func round1(x float64) float64 { return math.Round(x*10) / 10 }
