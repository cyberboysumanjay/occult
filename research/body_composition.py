#!/usr/bin/env python3
"""Body-composition estimates from anthropometrics (+ optional BIA impedance).

Research reference for occult. These are the cited equations occult uses to
compute body metrics WITHOUT needing the scale's (unreachable) impedance — see
cult_scale_protocol.md for why body composition can't be read off the CS-BF01
over BLE. The same formulas are ported to JS in occult's js/metrics/bodycomp.js.

Two tiers:
  TIER 1 — anthropometric (age/sex/height/weight only): BMI, BMR (Mifflin-St
  Jeor), body fat % (Deurenberg), total body water (Watson). occult uses these.
  TIER 2 — bioimpedance: skeletal-muscle mass (Janssen). Included for reference,
  but the CS-BF01 does not expose a usable impedance, so occult does NOT use it.

References:
  Mifflin MD et al. Am J Clin Nutr 1990;51:241-247.
  Deurenberg P et al. Br J Nutr 1991;65:105-114.
  Watson PE et al. Am J Clin Nutr 1980;33:27-39.
  Janssen I et al. J Appl Physiol 2000;89:465-471 (SMM vs MRI).

NOT medical advice. Wearable/scale BIA is noisy; treat as trends, not truth.
"""
from __future__ import annotations

import argparse


def bmi(weight_kg: float, height_cm: float) -> float:
    h = height_cm / 100.0
    return weight_kg / (h * h)


def bmi_class(b: float) -> str:
    if b < 18.5:
        return "underweight"
    if b < 25:
        return "normal"
    if b < 30:
        return "overweight"
    if b < 35:
        return "obese (class I)"
    if b < 40:
        return "obese (class II)"
    return "obese (class III)"


def bmr_mifflin(weight_kg: float, height_cm: float, age: int, sex: str) -> float:
    """Mifflin-St Jeor 1990 resting metabolic rate (kcal/day)."""
    base = 10 * weight_kg + 6.25 * height_cm - 5 * age
    return base + (5 if sex == "male" else -161)


def bodyfat_deurenberg(b: float, age: int, sex: str) -> float:
    """Deurenberg 1991 BMI-based body-fat %. SEE ~4 pp; overestimates at high BMI."""
    s = 1 if sex == "male" else 0
    return 1.20 * b + 0.23 * age - 10.8 * s - 5.4


def tbw_watson(weight_kg: float, height_cm: float, age: int, sex: str) -> float:
    """Watson 1980 total body water (litres)."""
    if sex == "male":
        return 2.447 - 0.09156 * age + 0.1074 * height_cm + 0.3362 * weight_kg
    return -2.097 + 0.1069 * height_cm + 0.2466 * weight_kg


def smm_janssen(height_cm: float, resistance_ohms: float, age: int, sex: str) -> float:
    """Janssen 2000 skeletal-muscle mass (kg) from 50 kHz resistance (ohms).
    NOTE: occult does not use this — the CS-BF01 doesn't expose a usable impedance."""
    s = 1 if sex == "male" else 0
    return (height_cm**2 / resistance_ohms) * 0.401 + s * 3.825 - age * 0.071 + 5.102


def compose(*, age: int, sex: str, height_cm: float, weight_kg: float) -> dict:
    """Anthropometric body-composition snapshot (no impedance)."""
    b = bmi(weight_kg, height_cm)
    bf_pct = bodyfat_deurenberg(b, age, sex)
    fat_mass = weight_kg * bf_pct / 100.0
    ffm = weight_kg - fat_mass
    tbw = tbw_watson(weight_kg, height_cm, age, sex)
    return {
        "bmi": round(b, 1),
        "bmi_class": bmi_class(b),
        "bmr_kcal": round(bmr_mifflin(weight_kg, height_cm, age, sex)),
        "bodyfat_pct": round(bf_pct, 1),
        "fat_mass_kg": round(fat_mass, 1),
        "fat_free_mass_kg": round(ffm, 1),
        "total_body_water_l": round(tbw, 1),
        "body_water_pct": round(tbw / weight_kg * 100, 1),
    }


def tdee_table(bmr: float) -> dict:
    """Activity multipliers (Harris-Benedict tradition)."""
    return {
        "sedentary (x1.2)": round(bmr * 1.2),
        "light (x1.375)": round(bmr * 1.375),
        "moderate (x1.55)": round(bmr * 1.55),
        "active (x1.725)": round(bmr * 1.725),
    }


def _demo(age, sex, height_cm, weight_kg):
    print(f"Profile: {age}y {sex}, {height_cm:.1f} cm, {weight_kg} kg\n")
    r = compose(age=age, sex=sex, height_cm=height_cm, weight_kg=weight_kg)
    print(f"  BMI            {r['bmi']}  ({r['bmi_class']})")
    print(f"  Body fat       {r['bodyfat_pct']}%  ({r['fat_mass_kg']} kg fat · {r['fat_free_mass_kg']} kg lean)")
    print(f"  Body water     {r['total_body_water_l']} L  ({r['body_water_pct']}%)")
    print(f"  BMR (resting)  {r['bmr_kcal']} kcal/day")
    print("  TDEE by activity:")
    for k, v in tdee_table(r["bmr_kcal"]).items():
        print(f"      {k:<20} {v} kcal/day")


def _selftest() -> int:
    ok = True
    ok &= abs(bmi(100, 200) - 25.0) < 1e-9                     # 100 kg / 2.00 m² = 25.0
    ok &= abs(bmr_mifflin(80, 180, 30, "male") - 1780) < 1e-9  # 800+1125-150+5
    ok &= abs(bmr_mifflin(80, 180, 30, "female") - 1614) < 1e-9  # 800+1125-150-161
    ok &= abs(bodyfat_deurenberg(25, 40, "male") - 23.0) < 1e-9  # 30+9.2-10.8-5.4
    print("selftest:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


def main() -> int:
    import sys
    for s in (sys.stdout, sys.stderr):
        try:
            s.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--age", type=int, default=30)
    p.add_argument("--sex", choices=["male", "female"], default="male")
    p.add_argument("--height-cm", type=float, default=175.0)
    p.add_argument("--weight-kg", type=float, default=75.0)
    p.add_argument("--selftest", action="store_true")
    a = p.parse_args()
    if a.selftest:
        return _selftest()
    _demo(a.age, a.sex, a.height_cm, a.weight_kg)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
