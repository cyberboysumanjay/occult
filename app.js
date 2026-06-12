// occult — app controller. Wires the BLE client, IndexedDB store, body-comp
// derivation, and the UI renderers together. Fully client-side: open the DB,
// seed demo data on first run, render, and react to scale + user events.

import { openDb } from './js/data/db.js';
import {
  listProfiles, createProfile, updateProfile, deleteProfile,
  getActiveProfileId, setActiveProfileId,
  insertReading, readingsForProfile, latestReading, deleteReading,
} from './js/data/store.js';
import { exportAllJson, importAllJson, readingsToCsv } from './js/data/export.js';
import { deriveReading } from './js/metrics/bodycomp.js';
import { CultScaleClient } from './js/ble/client.js';
import { renderToday, renderTrends, renderHistory } from './js/ui/render.js';
import { renderProfiles } from './js/ui/profiles-ui.js';
import { ageFromBirthYear, PROFILE_COLORS } from './js/util/format.js';

const $ = (id) => document.getElementById(id);

const state = {
  db: null,
  profiles: [],
  activeId: null,
  profile: null,
  readings: [],
  tab: 'today',
  editingProfileId: null,
};

const scale = new CultScaleClient();

// ── boot ─────────────────────────────────────────────────────────────────────
(async function boot() {
  state.db = await openDb();
  wireChrome();
  wireScale();
  await refresh();
  positionUnderline();
  // First run: no profiles yet → onboard the user (name / age / sex / height).
  if (!state.profiles.length) startOnboarding();
})().catch((e) => { console.error(e); toast('Failed to start: ' + e.message); });

// ── data refresh + render ──────────────────────────────────────────────────────
async function refresh() {
  state.profiles = await listProfiles(state.db);
  state.activeId = await getActiveProfileId(state.db);
  if (state.activeId == null && state.profiles.length) {
    state.activeId = state.profiles[0].id;
    await setActiveProfileId(state.db, state.activeId);
  }
  state.profile = state.profiles.find((p) => p.id === state.activeId) || null;
  state.readings = state.profile ? await readingsForProfile(state.db, state.profile.id) : [];

  renderChips();
  renderActiveTab();
}

function renderActiveTab() {
  if (state.tab === 'today') {
    renderToday({ heroEl: $('todayHero'), gridEl: $('todayGrid'), readings: state.readings, profile: state.profile });
  } else if (state.tab === 'trends') {
    renderTrends({ gridEl: $('trendsGrid'), readings: state.readings, profile: state.profile });
  } else if (state.tab === 'history') {
    renderHistory({ wrapEl: $('historyWrap'), readings: state.readings, onDelete: onDeleteReading });
  } else if (state.tab === 'profiles') {
    renderProfilesTab();
  }
}

async function renderProfilesTab() {
  const latestByProfile = new Map();
  await Promise.all(state.profiles.map(async (p) => {
    latestByProfile.set(p.id, await latestReading(state.db, p.id));
  }));
  renderProfiles({
    gridEl: $('profilesGrid'),
    profiles: state.profiles,
    activeId: state.activeId,
    latestByProfile,
    handlers: {
      onActivate: async (id) => { await setActiveProfileId(state.db, id); await refresh(); },
      onEdit: (p) => openProfileModal(p),
      onDelete: onDeleteProfile,
    },
  });
}

// ── profile chips (top bar switcher) ───────────────────────────────────────────
function renderChips() {
  const wrap = $('profileChips');
  wrap.innerHTML = '';
  for (const p of state.profiles) {
    const b = document.createElement('button');
    b.className = 'chip' + (p.id === state.activeId ? ' is-active' : '');
    b.style.setProperty('--accent', p.color || '#a06bff');
    b.textContent = (p.name || '?').charAt(0).toUpperCase();
    b.title = p.name;
    b.addEventListener('click', async () => { await setActiveProfileId(state.db, p.id); await refresh(); });
    wrap.appendChild(b);
  }
}

// ── chrome wiring (tabs, buttons, modals) ──────────────────────────────────────
function wireChrome() {
  // tabs
  $('tabs').querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.tab = btn.dataset.tab;
      $('tabs').querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t === btn));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('is-active', p.id === 'tab-' + state.tab));
      positionUnderline();
      renderActiveTab();
    });
  });
  window.addEventListener('resize', positionUnderline);

  // connect / disconnect
  $('connectBtn').addEventListener('click', onConnectClick);
  $('connectClose').addEventListener('click', () => { closeOverlay(); scale.disconnect(); });

  // theme toggle
  $('themeBtn').addEventListener('click', toggleTheme);
  syncThemeIcon();

  // manual entry
  $('manualBtn').addEventListener('click', () => $('manualModal').hidden = false);
  $('manualCancel').addEventListener('click', () => $('manualModal').hidden = true);
  $('manualForm').addEventListener('submit', onManualSubmit);

  // profiles
  $('addProfileBtn').addEventListener('click', () => openProfileModal(null));
  $('profileCancel').addEventListener('click', () => $('profileModal').hidden = true);
  $('profileForm').addEventListener('submit', onProfileSubmit);

  // export / import
  $('exportCsvBtn').addEventListener('click', onExportCsv);
  $('exportJsonBtn').addEventListener('click', onExportJson);
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', onImportFile);

  // dismiss modals on scrim click
  for (const id of ['profileModal', 'manualModal']) {
    $(id).addEventListener('click', (e) => { if (e.target.id === id) $(id).hidden = true; });
  }
  // dismiss the open form modal on Escape
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    for (const id of ['profileModal', 'manualModal']) { const m = $(id); if (m && !m.hidden) m.hidden = true; }
  });
}

function positionUnderline() {
  const active = $('tabs').querySelector('.tab.is-active');
  const u = $('tabUnderline');
  if (!active || !u) return;
  u.style.left = active.offsetLeft + 'px';
  u.style.width = active.offsetWidth + 'px';
}

// ── theme (dark / light) ────────────────────────────────────────────────────────
const currentTheme = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
function syncThemeIcon() { $('themeBtn').textContent = currentTheme() === 'light' ? '☀' : '☾'; }
function toggleTheme() {
  const next = currentTheme() === 'light' ? 'dark' : 'light';
  if (next === 'light') document.documentElement.dataset.theme = 'light';
  else document.documentElement.removeAttribute('data-theme');
  try { localStorage.setItem('occult-theme', next); } catch (e) { /* private mode */ }
  syncThemeIcon();
}

// ── scale (BLE) flow ───────────────────────────────────────────────────────────
function wireScale() {
  scale.on('state', (s) => {
    const btn = $('connectBtn');
    btn.classList.toggle('is-connected', s === 'connected');
    btn.classList.toggle('is-connecting', s === 'connecting');
    $('connLabel').textContent =
      s === 'connected' ? 'Measuring…' : s === 'connecting' ? 'Connecting…' : 'Measure';
    if (s === 'connecting') $('weighStatus').textContent = 'Connecting to scale…';
    if (s === 'connected') $('weighStatus').textContent = 'Step on the scale and hold still…';
  });

  // live weight while it settles
  scale.on('live', ({ weightKg, heartRate, phase, locked }) => {
    $('weighWeight').textContent = (weightKg ?? 0).toFixed(1);
    if (heartRate) { $('weighHr').hidden = false; $('weighHrVal').textContent = heartRate; }
    if (!locked) $('weighRing').style.width = phase === 'body' ? '50%' : '35%';
  });

  // weight settled → the scale now reads HR + body composition (~30 s). Keep the
  // overlay open and show progress instead of finishing on the weight alone.
  scale.on('locked', ({ weightKg }) => {
    $('weighWeight').textContent = weightKg.toFixed(1);
    $('weighStatus').textContent = 'Weight locked — stay on, reading heart rate & body composition…';
    $('weighRing').style.width = '60%';
  });

  scale.on('measuring', ({ heartRate, hasImpedance, ticks }) => {
    $('weighHr').hidden = false;
    $('weighHrVal').textContent = heartRate;
    $('weighStatus').textContent = hasImpedance ? 'Reading heart rate…' : 'Reading body composition…';
    $('weighRing').style.width = Math.min(95, 60 + ticks * 8) + '%';
  });

  // full measurement done (HR converged, or scale powered off, or timeout)
  scale.on('complete', async ({ weightKg, heartRate, impedanceRaw }) => {
    $('weighRing').style.width = '100%';
    $('weighStatus').textContent = 'Complete ✓';
    if (!state.profile) { toast('Create a profile first'); closeOverlay(); scale.disconnect(); return; }
    await saveReading({ weightKg, heartRate, impedanceRaw, source: 'scale' });
    setTimeout(() => { closeOverlay(); scale.disconnect(); }, 1100);
  });

  scale.on('error', (err) => { toast(err?.message || 'Bluetooth error'); closeOverlay(); });
}

async function onConnectClick() {
  if ($('connectBtn').classList.contains('is-connected')) { scale.disconnect(); return; }
  $('weighWeight').textContent = '0.0';
  $('weighHr').hidden = true;
  $('weighRing').style.width = '0%';
  $('connectOverlay').hidden = false;
  try {
    await scale.requestAndConnect();
  } catch (e) {
    // error toast already emitted via 'error'; overlay closed there
  }
}

function closeOverlay() { $('connectOverlay').hidden = true; }

// ── saving readings (derive snapshot from active profile) ───────────────────────
async function saveReading({ weightKg, heartRate, impedanceRaw, source }) {
  const p = state.profile;
  const derived = deriveReading({
    weightKg, impedanceRaw,
    age: ageFromBirthYear(p.birthYear),
    sex: p.sex,
    heightCm: p.heightCm,
    impedanceScale: p.impedanceScale,
  });
  await insertReading(state.db, {
    profileId: p.id,
    ts: new Date().toISOString(),
    weightKg, heartRate: heartRate ?? null, impedanceRaw: impedanceRaw ?? null,
    source,
    ...derived,
  });
  toast(`Saved ${weightKg.toFixed(1)} kg`);
  await refresh();
}

async function onManualSubmit(e) {
  e.preventDefault();
  if (!state.profile) { toast('Create a profile first'); return; }
  const weightKg = parseFloat($('mn_weight').value);
  if (!(weightKg > 0)) return;
  $('manualModal').hidden = true;
  $('manualForm').reset();
  await saveReading({ weightKg, heartRate: null, impedanceRaw: null, source: 'manual' });
}

async function onDeleteReading(id) {
  await deleteReading(state.db, id);
  await refresh();
  toast('Reading deleted');
}

// ── profile create / edit ───────────────────────────────────────────────────────
function startOnboarding() { openProfileModal(null, true); }

function openProfileModal(profile, onboarding = false) {
  state.editingProfileId = profile?.id ?? null;
  $('profileModalTitle').textContent =
    onboarding ? 'Welcome — set up your profile' : profile ? 'Edit profile' : 'New profile';
  $('pf_name').value = profile?.name ?? '';
  $('pf_sex').value = profile?.sex ?? 'male';
  // We store birthYear (stable over time) but ask the user for age.
  $('pf_age').value = profile?.birthYear ? (new Date().getFullYear() - profile.birthYear) : '';
  $('pf_heightCm').value = profile?.heightCm ?? '';
  $('profileModal').hidden = false;
}

async function onProfileSubmit(e) {
  e.preventDefault();
  const fields = {
    name: $('pf_name').value.trim() || 'Unnamed',
    sex: $('pf_sex').value,
    birthYear: $('pf_age').value ? (new Date().getFullYear() - parseInt($('pf_age').value, 10)) : null,
    heightCm: $('pf_heightCm').value ? parseFloat($('pf_heightCm').value) : null,
  };
  $('profileModal').hidden = true;

  if (state.editingProfileId != null) {
    await updateProfile(state.db, state.editingProfileId, fields);
    toast('Profile updated');
  } else {
    fields.color = PROFILE_COLORS[state.profiles.length % PROFILE_COLORS.length];
    const id = await createProfile(state.db, fields);
    if (!state.profiles.length || state.activeId == null) await setActiveProfileId(state.db, id);
    else await setActiveProfileId(state.db, id); // newly created → make active for convenience
    toast('Profile created');
  }
  await refresh();
}

async function onDeleteProfile(p) {
  if (!confirm(`Delete "${p.name}" and all its readings? This cannot be undone.`)) return;
  await deleteProfile(state.db, p.id);
  await refresh();
  toast('Profile deleted');
}

// ── export / import ─────────────────────────────────────────────────────────────
function download(filename, text, type = 'text/plain') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function onExportCsv() {
  if (!state.readings.length) { toast('No readings to export'); return; }
  const name = (state.profile?.name || 'profile').replace(/\s+/g, '_').toLowerCase();
  download(`occult_${name}.csv`, readingsToCsv(state.readings), 'text/csv');
}

async function onExportJson() {
  const payload = await exportAllJson(state.db);
  download('occult_backup.json', JSON.stringify(payload, null, 2), 'application/json');
}

async function onImportFile(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  if (!confirm('Importing replaces ALL current data. Continue?')) { e.target.value = ''; return; }
  try {
    const payload = JSON.parse(await file.text());
    await importAllJson(state.db, payload);
    await refresh();
    toast('Import complete');
  } catch (err) {
    toast('Import failed: ' + err.message);
  }
  e.target.value = '';
}

// ── toast ─────────────────────────────────────────────────────────────────────
function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = `<span class="t-mark">✦</span><span>${msg}</span>`;
  $('toastStack').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .4s'; }, 2600);
  setTimeout(() => t.remove(), 3100);
}
