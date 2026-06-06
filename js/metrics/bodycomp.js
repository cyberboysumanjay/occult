// js/metrics/bodycomp.js — body-composition pure functions (ES module, no deps).
//
// Ported 1:1 from healthee/tools/body_composition.py.
//
// References:
//   Mifflin MD et al. Am J Clin Nutr 1990;51:241-247.
//   Deurenberg P et al. Br J Nutr 1991;65:105-114.
//   Watson PE et al. Am J Clin Nutr 1980;33:27-39.
//   Janssen I et al. J Appl Physiol 2000;89:465-471 (SMM vs MRI).
//
// NOT medical advice. BIA is noisy; treat as trends, not truth.

import { DEFAULT_IMPEDANCE_SCALE } from '../data/schema.js';

// ── Tier 1: anthropometric ────────────────────────────────────────────────────

/** BMI (kg/m²). Ref: WHO classification. */
export function bmi(weightKg, heightCm) {
  const h = heightCm / 100;
  return weightKg / (h * h);
}

/** WHO BMI classification string. */
export function bmiClass(b) {
  if (b < 18.5) return 'underweight';
  if (b < 25)   return 'normal';
  if (b < 30)   return 'overweight';
  if (b < 35)   return 'obese (class I)';
  if (b < 40)   return 'obese (class II)';
  return 'obese (class III)';
}

/** Mifflin-St Jeor 1990 resting metabolic rate (kcal/day).
 *  male: 10W + 6.25H − 5A + 5 ; female: 10W + 6.25H − 5A − 161 */
export function bmrMifflin(weightKg, heightCm, age, sex) {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  return base + (sex === 'male' ? 5 : -161);
}

/** Deurenberg 1991 BMI-based body-fat %.
 *  BF% = 1.20·BMI + 0.23·age − 10.8·(male?1:0) − 5.4
 *  SEE ≈ ±4 pp; overestimates at high BMI. */
export function bodyFatDeurenberg(b, age, sex) {
  return 1.20 * b + 0.23 * age - 10.8 * (sex === 'male' ? 1 : 0) - 5.4;
}

/** Watson 1980 total body water (litres).
 *  Male:   2.447 − 0.09156·age + 0.1074·H + 0.3362·W
 *  Female: −2.097 + 0.1069·H + 0.2466·W */
export function tbwWatson(weightKg, heightCm, age, sex) {
  if (sex === 'male') {
    return 2.447 - 0.09156 * age + 0.1074 * heightCm + 0.3362 * weightKg;
  }
  return -2.097 + 0.1069 * heightCm + 0.2466 * weightKg;
}

// ── Tier 2: bioimpedance ──────────────────────────────────────────────────────

/** Janssen 2000 skeletal-muscle mass (kg) from 50 kHz resistance.
 *  SMM = (H²/R)·0.401 + (male?3.825:0) − age·0.071 + 5.102
 *  Validated against MRI. Requires resistance in ohms. */
export function smmJanssen(heightCm, resistanceOhms, age, sex) {
  return (heightCm ** 2 / resistanceOhms) * 0.401
    + (sex === 'male' ? 3.825 : 0)
    - age * 0.071
    + 5.102;
}

// ── Composite derive ──────────────────────────────────────────────────────────

/**
 * Derive a full body-composition snapshot from a reading + profile fields.
 *
 * @param {{weightKg, impedanceRaw, age, sex, heightCm, impedanceScale}} p
 * @returns {{ bmi, bmiClass, bodyFatPct, fatMassKg, ffmKg, tbwL,
 *             bodyWaterPct, bmrKcal, smmKg, smmPct }}
 *
 * Rounding: weights/volumes → 1 dp; percentages → 1 dp; bmrKcal → integer.
 * SMM fields are null when impedanceRaw is not a positive number.
 * Any field whose prerequisites (age/sex/height) are missing is set to null.
 */
export function deriveReading({ weightKg, impedanceRaw, age, sex, heightCm, impedanceScale }) {
  const r1 = (v) => v == null ? null : Math.round(v * 10) / 10;   // 1 dp
  const ri = (v) => v == null ? null : Math.round(v);              // integer

  const hasProfile = weightKg != null && age != null && sex != null && heightCm != null;
  const hasWeight  = weightKg != null;
  const hasHgt     = weightKg != null && heightCm != null;

  // BMI — needs weight + height only
  const bmiVal      = hasHgt ? r1(bmi(weightKg, heightCm)) : null;
  const bmiClassVal = bmiVal != null ? bmiClass(bmiVal) : null;

  // body fat — needs BMI + age + sex
  const bodyFatPct = (bmiVal != null && age != null && sex != null)
    ? r1(bodyFatDeurenberg(bmiVal, age, sex))
    : null;

  const fatMassKg  = (hasWeight && bodyFatPct != null) ? r1(weightKg * bodyFatPct / 100) : null;
  const ffmKg      = (hasWeight && fatMassKg  != null) ? r1(weightKg - fatMassKg)        : null;

  // TBW — needs all profile fields
  const tbwL        = hasProfile ? r1(tbwWatson(weightKg, heightCm, age, sex)) : null;
  const bodyWaterPct = (hasWeight && tbwL != null) ? r1(tbwL / weightKg * 100) : null;

  // BMR — needs all profile fields
  const bmrKcal = hasProfile ? ri(bmrMifflin(weightKg, heightCm, age, sex)) : null;

  // SMM — needs impedance + all profile fields
  let smmKg  = null;
  let smmPct = null;
  if (hasProfile && typeof impedanceRaw === 'number' && impedanceRaw > 0) {
    const scale = impedanceScale || DEFAULT_IMPEDANCE_SCALE;
    const R     = impedanceRaw * scale;
    const smm   = smmJanssen(heightCm, R, age, sex);
    smmKg  = r1(smm);
    smmPct = r1(smm / weightKg * 100);
  }

  return { bmi: bmiVal, bmiClass: bmiClassVal, bodyFatPct, fatMassKg, ffmKg,
           tbwL, bodyWaterPct, bmrKcal, smmKg, smmPct };
}

// ── Self-test ─────────────────────────────────────────────────────────────────

/** Returns true iff all reference assertions pass. */
export function bodyCompSelfTest() {
  let ok = true;

  // BMI: 100 kg / (2.00 m)² = 25.0
  ok &&= Math.abs(bmi(100, 200) - 25.0) < 1e-9;

  // Mifflin male  80 kg / 180 cm / 30 y: 800 + 1125 − 150 + 5 = 1780
  ok &&= Math.abs(bmrMifflin(80, 180, 30, 'male')   - 1780) < 1e-9;

  // Mifflin female same params:          800 + 1125 − 150 − 161 = 1614
  ok &&= Math.abs(bmrMifflin(80, 180, 30, 'female') - 1614) < 1e-9;

  // Deurenberg: 1.20×25 + 0.23×40 − 10.8×1 − 5.4 = 30 + 9.2 − 10.8 − 5.4 = 23.0
  ok &&= Math.abs(bodyFatDeurenberg(25, 40, 'male') - 23.0) < 1e-9;

  return ok;
}
