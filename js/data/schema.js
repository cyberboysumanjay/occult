// IndexedDB schema for occult.
//
// Three stores:
//   profiles  — multiple user profiles (name/sex/birthYear/heightCm/color + per-profile calibration)
//   readings  — one row per weigh-in, tagged with profileId; carries raw scale
//               fields (weight/HR/impedance) AND a derived body-comp snapshot
//   settings  — singletons keyed by string (activeProfileId, global calibration…)

export const DB_NAME = 'occult';
export const DB_VERSION = 1;

// indexes: [indexName, keyPath?] — keyPath defaults to indexName
export const STORES = {
  profiles: {
    keyPath: 'id',
    autoIncrement: true,
    indexes: [['name']],
  },
  readings: {
    keyPath: 'id',
    autoIncrement: true,
    indexes: [
      ['ts'],
      ['profileId'],
      ['profile_ts', ['profileId', 'ts']],
    ],
  },
  settings: {
    keyPath: 'key',
    indexes: [],
  },
};

// ── Shared object shapes (documentation; JS is untyped) ──────────────────────
//
// Profile = {
//   id,            // auto
//   name,          // string
//   sex,           // 'male' | 'female'
//   birthYear,     // number  → age = currentYear - birthYear
//   heightCm,      // number
//   color,         // accent hex, e.g. '#5b8cff'  (avatar + chart line)
//   impedanceScale,// number | null  per-profile raw→ohm factor (default DEFAULT_IMPEDANCE_SCALE)
//   createdAt,     // ISO string
// }
//
// Reading = {
//   id,            // auto
//   profileId,     // FK
//   ts,            // ISO string (measurement time)
//   weightKg,      // number
//   heartRate,     // number | null  (bpm)
//   impedanceRaw,  // number | null  (raw scale units; captured but not displayed)
//   source,        // 'scale' | 'manual' | 'seed'
//   // derived snapshot (frozen at save time from the profile + raw fields):
//   bmi, bmiClass, bodyFatPct, fatMassKg, ffmKg, tbwL, bodyWaterPct,
//   bmrKcal, smmKg, smmPct,
// }

// Provisional raw-impedance → ohms factor (see research/cult_scale_protocol.md).
// Unused: this scale doesn't expose a usable impedance (see research note). Kept for reference.
export const DEFAULT_IMPEDANCE_SCALE = 0.03036;
