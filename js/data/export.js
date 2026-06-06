// js/data/export.js — CSV / JSON export and full-database import.
//
// Export helpers are deliberately pure or near-pure so they can be unit-tested
// outside a browser (readingsToCsv has zero side-effects; the async helpers
// only need an open IDBDatabase handle).

import { req2promise, txDone } from './db.js';

// ── CSV ───────────────────────────────────────────────────────────────────────

// Column order matches the Reading shape documented in schema.js, raw fields
// first (they are the source of truth), derived snapshot fields after.
const CSV_HEADERS = [
  'ts', 'weightKg', 'heartRate', 'impedanceRaw',
  'bmi', 'bodyFatPct', 'fatMassKg', 'ffmKg',
  'tbwL', 'bodyWaterPct', 'bmrKcal',
  'smmKg', 'smmPct',
  'source',
];

/** Escape a single CSV cell value (handles commas, quotes, newlines). */
function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  // Wrap in double-quotes whenever the value contains a special character.
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/**
 * Convert an array of Reading objects to a CSV string.
 * Returns a header row + one data row per reading, CRLF-terminated.
 * profileId and id are intentionally omitted (use exportAllJson for full fidelity).
 *
 * @param {object[]} readings
 * @returns {string}
 */
export function readingsToCsv(readings) {
  const rows = [CSV_HEADERS.join(',')];
  for (const r of readings) {
    rows.push(CSV_HEADERS.map(k => csvCell(r[k])).join(','));
  }
  return rows.join('\r\n') + '\r\n';
}

// ── JSON export ───────────────────────────────────────────────────────────────

/**
 * Snapshot the entire database into a plain JS object ready for JSON.stringify.
 * Shape: { version: 1, exportedAt: <ISO>, profiles: [...], readings: [...], settings: [...] }
 *
 * version is bumped here (not in schema.js) because the export format may evolve
 * independently of the DB schema version.
 */
export async function exportAllJson(db) {
  const tx       = db.transaction(['profiles', 'readings', 'settings'], 'readonly');
  const profiles = await req2promise(tx.objectStore('profiles').getAll());
  const readings = await req2promise(tx.objectStore('readings').getAll());
  const settings = await req2promise(tx.objectStore('settings').getAll());

  return {
    version:    1,
    exportedAt: new Date().toISOString(),
    profiles,
    readings,
    settings,
  };
}

// ── JSON import ───────────────────────────────────────────────────────────────

/**
 * Restore a full database snapshot produced by exportAllJson.
 * Strategy: clear all three stores then bulk-put every record.
 * Missing keys in the payload are tolerated (treated as empty arrays).
 *
 * WARNING: this is destructive — all existing data is erased before restore.
 * Callers should prompt for confirmation before invoking.
 */
export async function importAllJson(db, payload) {
  const { profiles = [], readings = [], settings = [] } = payload ?? {};

  const tx           = db.transaction(['profiles', 'readings', 'settings'], 'readwrite');
  const profileStore = tx.objectStore('profiles');
  const readingStore = tx.objectStore('readings');
  const settingStore = tx.objectStore('settings');

  // Clear existing data first so there are no key collisions or stale rows.
  profileStore.clear();
  readingStore.clear();
  settingStore.clear();

  // Bulk-put each record.  put() is used (not add()) so the imported ids are
  // preserved exactly — foreign-key relationships (reading.profileId) stay valid.
  for (const p of profiles) profileStore.put(p);
  for (const r of readings) readingStore.put(r);
  for (const s of settings) settingStore.put(s);

  await txDone(tx);
}
