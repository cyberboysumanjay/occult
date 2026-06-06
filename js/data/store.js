// js/data/store.js — IndexedDB CRUD layer for profiles, readings, and settings.
//
// All functions accept an open IDBDatabase handle (from openDb) so callers
// control connection lifetime — one db handle can be shared across an entire
// app session without re-opening.
//
// Conventions:
//   • Each write opens its own short-lived transaction so reads never block.
//   • req2promise / txDone are the only IDB promise wrappers in use (from db.js).
//   • "getAll via cursor" is avoided where a built-in getAll is available.

import { req2promise, txDone } from './db.js';

// ── Profiles ──────────────────────────────────────────────────────────────────

/** Returns all profiles as an array (insertion order ≈ creation order). */
export async function listProfiles(db) {
  const tx    = db.transaction('profiles', 'readonly');
  const store = tx.objectStore('profiles');
  return req2promise(store.getAll());
}

/**
 * Create a new profile.  Stamps createdAt automatically.
 * @returns {number} the new auto-assigned id
 */
export async function createProfile(db, { name, sex, birthYear, heightCm, color, impedanceScale }) {
  const tx    = db.transaction('profiles', 'readwrite');
  const store = tx.objectStore('profiles');
  const id    = await req2promise(store.add({
    name, sex, birthYear, heightCm,
    color: color ?? null,
    impedanceScale: impedanceScale ?? null,
    createdAt: new Date().toISOString(),
  }));
  await txDone(tx);
  return id;
}

/** Merge `fields` into an existing profile (partial update). */
export async function updateProfile(db, id, fields) {
  const tx    = db.transaction('profiles', 'readwrite');
  const store = tx.objectStore('profiles');
  // Read current record first so we can spread changes onto it.
  const existing = await req2promise(store.get(id));
  if (!existing) throw new Error(`Profile ${id} not found`);
  await req2promise(store.put({ ...existing, ...fields, id }));
  await txDone(tx);
}

/**
 * Delete a profile AND all its readings.
 * Also clears activeProfileId from settings if it pointed to this profile.
 */
export async function deleteProfile(db, id) {
  // Use a single transaction spanning all three stores so the delete is atomic.
  const tx       = db.transaction(['profiles', 'readings', 'settings'], 'readwrite');
  const profiles = tx.objectStore('profiles');
  const readings = tx.objectStore('readings');
  const settings = tx.objectStore('settings');

  // 1. Remove the profile record.
  profiles.delete(id);

  // 2. Delete every reading that belongs to this profile via the profileId index.
  const idx    = readings.index('profileId');
  const cursor = await req2promise(idx.openCursor(IDBKeyRange.only(id)));
  // Walk the cursor and delete each matched reading.
  let cur = cursor;
  while (cur) {
    cur.delete();
    cur = await req2promise(cur.continue());
  }

  // 3. Clear activeProfileId if it pointed at the deleted profile.
  const activeSetting = await req2promise(settings.get('activeProfileId'));
  if (activeSetting?.value === id) {
    settings.delete('activeProfileId');
  }

  await txDone(tx);
}

// ── Active profile (settings store) ─────────────────────────────────────────

/**
 * Returns the currently active profile id, or null when nothing is set.
 * Settings rows have shape { key, value }.
 */
export async function getActiveProfileId(db) {
  const tx      = db.transaction('settings', 'readonly');
  const store   = tx.objectStore('settings');
  const row     = await req2promise(store.get('activeProfileId'));
  return row?.value ?? null;
}

/** Persist the active profile id (overwrites any previous value). */
export async function setActiveProfileId(db, id) {
  const tx    = db.transaction('settings', 'readwrite');
  const store = tx.objectStore('settings');
  await req2promise(store.put({ key: 'activeProfileId', value: id }));
  await txDone(tx);
}

// ── Readings ─────────────────────────────────────────────────────────────────

/**
 * Insert a new reading.
 * @returns {number} the new auto-assigned id
 */
export async function insertReading(db, reading) {
  const tx    = db.transaction('readings', 'readwrite');
  const store = tx.objectStore('readings');
  const id    = await req2promise(store.add(reading));
  await txDone(tx);
  return id;
}

/**
 * All readings for a profile, sorted oldest → newest by ts.
 * Uses the compound [profileId, ts] index so the DB returns them pre-sorted —
 * no client-side sort needed.
 */
export async function readingsForProfile(db, profileId) {
  const tx    = db.transaction('readings', 'readonly');
  const store = tx.objectStore('readings');
  const idx   = store.index('profile_ts');
  // IDBKeyRange over the compound key: fix profileId, let ts range freely.
  const range = IDBKeyRange.bound([profileId, ''], [profileId, '￿']);
  return req2promise(idx.getAll(range));
}

/**
 * The single most-recent reading for a profile (highest ts).
 * Opens a cursor on the compound index in reverse so the first result is newest.
 */
export async function latestReading(db, profileId) {
  const tx    = db.transaction('readings', 'readonly');
  const store = tx.objectStore('readings');
  const idx   = store.index('profile_ts');
  const range = IDBKeyRange.bound([profileId, ''], [profileId, '￿']);
  // 'prev' direction = descending; first cursor position is the newest row.
  const cursor = await req2promise(idx.openCursor(range, 'prev'));
  return cursor?.value ?? null;
}

/** Delete a single reading by its auto-id. */
export async function deleteReading(db, id) {
  const tx    = db.transaction('readings', 'readwrite');
  const store = tx.objectStore('readings');
  await req2promise(store.delete(id));
  await txDone(tx);
}
