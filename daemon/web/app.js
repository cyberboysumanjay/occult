/* occultd dashboard — app.js
   Vanilla JS, no build step. Requires Chart.js 4 loaded before this script.
   Polls /api/profile, /api/latest, /api/readings every 30 seconds.           */

'use strict';

// ── constants ────────────────────────────────────────────────────────────────
const REFRESH_MS   = 30_000;
const MAX_CHART_PTS = 90;   // show last N readings on the weight trend
const API = {
  profile:  './api/profile',
  latest:   './api/latest',
  readings: './api/readings',
  settings: './api/settings',
  tgTest:   './api/telegram/test',
};

// ── state ─────────────────────────────────────────────────────────────────────
let weightChart   = null;   // Chart.js instance
let lastRefreshTs = null;

// ── DOM refs (populated in init) ──────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ── number formatters ─────────────────────────────────────────────────────────
const fmtKg  = v => v != null ? (+v).toFixed(1) : null;
const fmtPct = v => v != null ? (+v).toFixed(1) : null;
const fmtInt = v => v != null ? Math.round(+v).toString() : null;
const fmtBmi = v => v != null ? (+v).toFixed(1) : null;

/** Format ISO timestamp to human-readable local string */
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/** Short date for the chart X-axis labels */
function fmtShortDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ── BMI class → CSS token + display label ─────────────────────────────────────
// The API sends WHO labels like "obese (class I)"; the colour token is the first
// word ("obese") so every obese subclass still gets its badge colour.
function bmiInfo(cls) {
  if (!cls) return { token: '', label: '' };
  return { token: cls.split(' ')[0], label: cls };
}

// ── safe fetch wrapper ────────────────────────────────────────────────────────
async function apiFetch(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ── JSON POST helper ──────────────────────────────────────────────────────────
async function apiPost(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  // Always parse JSON; caller must check .ok
  return r.json();
}

// ── field helpers shared between onboarding and settings ─────────────────────

/** Convert birthYear stored on server → display age */
function birthYearToAge(birthYear) {
  return new Date().getFullYear() - birthYear;
}

/** Convert user-entered age → birthYear for POST */
function ageToBirthYear(age) {
  return new Date().getFullYear() - age;
}

/**
 * Validate the three required profile fields.
 * Returns an error string, or '' if valid.
 */
function validateProfile(name, age, heightCm) {
  if (!name || !name.trim()) return 'Name is required.';
  if (!age || Number(age) <= 0 || isNaN(Number(age))) return 'A valid age is required.';
  if (!heightCm || Number(heightCm) <= 0 || isNaN(Number(heightCm))) return 'A valid height is required.';
  return '';
}

/**
 * Build the body object for POST /api/settings.
 * All numeric fields are coerced with Number(); namePrefixes parsed from CSV.
 */
function buildSettingsBody(fields) {
  const {
    name, sex, age, heightCm,
    botToken, chatId,
    namePrefixes, rssiThreshold, minWeightKg, maxWeightKg, cooldownSeconds,
  } = fields;

  const prefixes = (namePrefixes || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  return {
    profile: {
      name: name.trim(),
      sex,
      birthYear: ageToBirthYear(Number(age)),
      heightCm:  Number(heightCm),
    },
    telegram: {
      botToken: botToken || '',
      chatId:   chatId   || '',
    },
    scale: {
      namePrefixes:    prefixes.length ? prefixes : ['Cult', 'CULT'],
      rssiThreshold:   Number(rssiThreshold),
      minWeightKg:     Number(minWeightKg),
      maxWeightKg:     Number(maxWeightKg),
      cooldownSeconds: Number(cooldownSeconds),
    },
  };
}

// ── onboarding overlay ────────────────────────────────────────────────────────

/**
 * Show the onboarding overlay and resolve the returned Promise when the user
 * successfully completes it.  Pre-fills Telegram if the server has values.
 */
function showOnboarding(serverSettings) {
  return new Promise(resolve => {
    const overlay = $('onboarding-overlay');
    const form    = $('onboarding-form');
    const errEl   = $('onboarding-error');
    const submitBtn = $('onboarding-submit');

    // Pre-fill Telegram if already set (unlikely on first run, but safe)
    if (serverSettings?.telegram?.botToken) {
      $('ob-bot-token').value = serverSettings.telegram.botToken;
    }
    if (serverSettings?.telegram?.chatId) {
      $('ob-chat-id').value = serverSettings.telegram.chatId;
    }

    overlay.hidden = false;
    $('ob-name').focus();

    form.addEventListener('submit', async e => {
      e.preventDefault();
      errEl.hidden = true;

      const name     = $('ob-name').value;
      const sex      = $('ob-sex').value;
      const age      = $('ob-age').value;
      const heightCm = $('ob-height').value;
      const botToken = $('ob-bot-token').value.trim();
      const chatId   = $('ob-chat-id').value.trim();

      const validErr = validateProfile(name, age, heightCm);
      if (validErr) {
        errEl.textContent = validErr;
        errEl.hidden = false;
        return;
      }

      submitBtn.disabled = true;
      submitBtn.textContent = '…';

      try {
        // Use default scale values from server if available, else sensible fallback
        const sc = serverSettings?.scale || {};
        const body = buildSettingsBody({
          name, sex, age, heightCm,
          botToken, chatId,
          namePrefixes:    (sc.namePrefixes || ['Cult', 'CULT']).join(','),
          rssiThreshold:   sc.rssiThreshold   ?? -80,
          minWeightKg:     sc.minWeightKg     ?? 5,
          maxWeightKg:     sc.maxWeightKg     ?? 300,
          cooldownSeconds: sc.cooldownSeconds ?? 20,
        });

        const res = await apiPost(API.settings, body);
        if (res.ok) {
          overlay.hidden = true;
          resolve();
        } else {
          errEl.textContent = res.error || 'Server rejected the settings.';
          errEl.hidden = false;
        }
      } catch (err) {
        console.warn('[occultd] onboarding save error:', err.message);
        errEl.textContent = 'Could not reach the server. Check that occultd is running.';
        errEl.hidden = false;
      } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Begin';
      }
    });
  });
}

// ── settings modal ────────────────────────────────────────────────────────────

/** Open the settings modal and pre-fill all fields from server. */
async function openSettings() {
  const modal   = $('settings-modal');
  const errEl   = $('settings-error');
  const tgRes   = $('st-tg-result');

  // Reset any stale state
  errEl.hidden = true;
  tgRes.textContent = '';
  tgRes.className = 'tg-result';

  // Fetch current settings
  let s;
  try {
    s = await apiFetch(API.settings);
  } catch (err) {
    console.warn('[occultd] settings fetch error:', err.message);
    s = { profile: {}, telegram: {}, scale: {} };
  }

  const p  = s.profile  || {};
  const tg = s.telegram || {};
  const sc = s.scale    || {};

  // Fill profile
  $('st-name').value   = p.name      || '';
  $('st-sex').value    = p.sex       || 'male';
  $('st-age').value    = p.birthYear ? birthYearToAge(p.birthYear) : '';
  $('st-height').value = p.heightCm  || '';

  // Fill telegram
  $('st-bot-token').value = tg.botToken || '';
  $('st-chat-id').value   = tg.chatId   || '';

  // Fill advanced
  $('st-prefixes').value = (sc.namePrefixes || []).join(', ');
  $('st-rssi').value     = sc.rssiThreshold   ?? '';
  $('st-min-kg').value   = sc.minWeightKg     ?? '';
  $('st-max-kg').value   = sc.maxWeightKg     ?? '';
  $('st-cooldown').value = sc.cooldownSeconds ?? '';

  modal.hidden = false;
  $('st-name').focus();
}

/** Wire up the settings modal interactions (called once in init). */
function initSettings() {
  const modal     = $('settings-modal');
  const form      = $('settings-form');
  const errEl     = $('settings-error');
  const tgTestBtn = $('st-tg-test');
  const tgRes     = $('st-tg-result');
  const toast     = $('settings-toast');
  const saveBtn   = $('settings-save');

  // Open via gear button
  $('settings-btn').addEventListener('click', openSettings);

  // Close via X or Cancel
  const closeModal = () => { modal.hidden = true; };
  $('settings-close').addEventListener('click', closeModal);
  $('settings-cancel').addEventListener('click', closeModal);

  // Close on backdrop click
  modal.addEventListener('click', e => {
    if (e.target === modal) closeModal();
  });

  // Telegram test button
  tgTestBtn.addEventListener('click', async () => {
    tgRes.textContent = '';
    tgRes.className = 'tg-result';
    tgTestBtn.disabled = true;

    const botToken = $('st-bot-token').value.trim();
    const chatId   = $('st-chat-id').value.trim();

    try {
      const res = await apiPost(API.tgTest, { botToken, chatId });
      if (res.ok) {
        tgRes.textContent = '✓ sent';
        tgRes.classList.add('tg-ok');
      } else {
        tgRes.textContent = '✕ ' + (res.error || 'failed');
        tgRes.classList.add('tg-err');
      }
    } catch (err) {
      console.warn('[occultd] telegram test error:', err.message);
      tgRes.textContent = '✕ ' + err.message;
      tgRes.classList.add('tg-err');
    } finally {
      tgTestBtn.disabled = false;
    }
  });

  // Save
  form.addEventListener('submit', async e => {
    e.preventDefault();
    errEl.hidden = true;

    const name     = $('st-name').value;
    const sex      = $('st-sex').value;
    const age      = $('st-age').value;
    const heightCm = $('st-height').value;

    const validErr = validateProfile(name, age, heightCm);
    if (validErr) {
      errEl.textContent = validErr;
      errEl.hidden = false;
      return;
    }

    saveBtn.disabled = true;

    try {
      const body = buildSettingsBody({
        name, sex, age, heightCm,
        botToken:        $('st-bot-token').value.trim(),
        chatId:          $('st-chat-id').value.trim(),
        namePrefixes:    $('st-prefixes').value,
        rssiThreshold:   $('st-rssi').value,
        minWeightKg:     $('st-min-kg').value,
        maxWeightKg:     $('st-max-kg').value,
        cooldownSeconds: $('st-cooldown').value,
      });

      const res = await apiPost(API.settings, body);
      if (res.ok) {
        modal.hidden = true;
        showToast(toast, 'Saved.');
        refresh();
      } else {
        errEl.textContent = res.error || 'Server rejected the settings.';
        errEl.hidden = false;
      }
    } catch (err) {
      console.warn('[occultd] settings save error:', err.message);
      errEl.textContent = 'Could not reach the server.';
      errEl.hidden = false;
    } finally {
      saveBtn.disabled = false;
    }
  });
}

/** Briefly show a toast element, then hide it. */
function showToast(el, message) {
  el.textContent = message;
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 2800);
}

// ── status dot / connecting banner ───────────────────────────────────────────
function setStatus(state) {
  // state: 'connecting' | 'live' | 'error'
  const dot    = $('live-dot');
  const text   = $('status-text');
  const banner = $('connecting-banner');

  dot.className = 'live-dot';
  if (state === 'live') {
    dot.classList.add('active');
    text.textContent = 'live';
    banner.classList.remove('visible');
  } else if (state === 'error') {
    dot.classList.add('error');
    text.textContent = 'error';
    banner.classList.add('visible');
  } else {
    text.textContent = 'connecting…';
    banner.classList.add('visible');
  }
}

// ── render profile in header ──────────────────────────────────────────────────
function renderProfile(profile) {
  const el = $('profile-name');
  if (el && profile?.name) el.textContent = profile.name;
}

// ── render hero card (latest reading) ────────────────────────────────────────
function renderHero(reading) {
  const hero = $('hero-card');

  // Empty state
  if (!reading || Object.keys(reading).length === 0) {
    hero.innerHTML = `
      <div class="hero-empty-msg">
        <div class="hero-big-text">No readings yet</div>
        <p style="color:var(--muted);font-size:12px;margin:4px 0 0">Step on the scale to begin.</p>
      </div>`;
    return;
  }

  const bmi   = bmiInfo(reading.bmiClass);
  const hrHtml = reading.heartRate != null
    ? `<div class="hero-metric">
         <span class="hero-metric-label" style="color:var(--c-hr)">Heart rate</span>
         <span class="hero-metric-value" style="color:var(--c-hr)">${reading.heartRate}<span class="unit">bpm</span></span>
       </div>`
    : '';

  hero.innerHTML = `
    <div class="hero-ornament">
      <svg viewBox="0 0 200 200" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="100" cy="100" r="96" stroke="currentColor" stroke-width="0.8" stroke-dasharray="4 6"/>
        <circle cx="100" cy="100" r="72" stroke="currentColor" stroke-width="0.5" stroke-dasharray="2 8"/>
        <circle cx="100" cy="100" r="48" stroke="currentColor" stroke-width="0.4"/>
        <line x1="100" y1="4"   x2="100" y2="196" stroke="currentColor" stroke-width="0.4" stroke-dasharray="3 9"/>
        <line x1="4"   y1="100" x2="196" y2="100" stroke="currentColor" stroke-width="0.4" stroke-dasharray="3 9"/>
        <line x1="32"  y1="32"  x2="168" y2="168" stroke="currentColor" stroke-width="0.3" stroke-dasharray="2 10"/>
        <line x1="168" y1="32"  x2="32"  y2="168" stroke="currentColor" stroke-width="0.3" stroke-dasharray="2 10"/>
        <circle cx="100" cy="100" r="5" fill="currentColor" opacity="0.4"/>
      </svg>
    </div>

    <div class="hero-eyebrow">
      Latest reading &nbsp;·&nbsp; <span>${fmtDate(reading.ts)}</span>
    </div>

    <div class="hero-weight-row">
      <span class="hero-weight">${fmtKg(reading.weightKg)}</span>
      <span class="hero-unit">kg</span>
    </div>

    <div class="hero-metrics">
      <div class="hero-metric">
        <span class="hero-metric-label" style="color:var(--c-bmi)">BMI</span>
        <span class="hero-metric-value" style="color:var(--c-bmi)">
          ${fmtBmi(reading.bmi)}
          ${bmi.label ? `<span class="bmi-badge ${bmi.token}">${bmi.label}</span>` : ''}
        </span>
      </div>
      ${reading.bodyFatPct != null ? `
      <div class="hero-metric">
        <span class="hero-metric-label" style="color:var(--c-fat)">Body fat</span>
        <span class="hero-metric-value" style="color:var(--c-fat)">${fmtPct(reading.bodyFatPct)}<span class="unit">%</span></span>
      </div>` : ''}
      ${reading.bmrKcal != null ? `
      <div class="hero-metric">
        <span class="hero-metric-label" style="color:var(--c-energy)">BMR</span>
        <span class="hero-metric-value" style="color:var(--c-energy)">${fmtInt(reading.bmrKcal)}<span class="unit">kcal</span></span>
      </div>` : ''}
      ${reading.bodyWaterPct != null ? `
      <div class="hero-metric">
        <span class="hero-metric-label" style="color:var(--c-water)">Body water</span>
        <span class="hero-metric-value" style="color:var(--c-water)">${fmtPct(reading.bodyWaterPct)}<span class="unit">%</span></span>
      </div>` : ''}
      ${hrHtml}
    </div>`;
}

// ── render weight trend chart ─────────────────────────────────────────────────
function renderChart(readings) {
  // Take last MAX_CHART_PTS readings (array is already sorted asc by ts)
  const pts = readings.slice(-MAX_CHART_PTS);

  const labels = pts.map(r => fmtShortDate(r.ts));
  const data   = pts.map(r => r.weightKg);

  // Update value label
  const lastVal = data.length ? data[data.length - 1] : null;
  const el = $('chart-current-val');
  if (el) el.textContent = lastVal != null ? `${fmtKg(lastVal)} kg` : '—';

  const ctx = $('weight-chart');
  if (!ctx) return;

  const gold = getComputedStyle(document.documentElement)
    .getPropertyValue('--gold').trim() || '#d8a24a';
  const goldSoft = 'rgba(216,162,74,0.12)';
  const mutedColor = 'rgba(200,190,170,0.25)';

  if (weightChart) {
    // Update existing chart data in-place
    weightChart.data.labels = labels;
    weightChart.data.datasets[0].data = data;
    weightChart.update('none'); // skip animation on refresh
    return;
  }

  weightChart = new window.Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data,
        borderColor: gold,
        borderWidth: 2,
        pointRadius: pts.length > 20 ? 0 : 3,
        pointHoverRadius: 5,
        pointBackgroundColor: gold,
        fill: true,
        backgroundColor: (context) => {
          const chart = context.chart;
          const { ctx: c, chartArea } = chart;
          if (!chartArea) return goldSoft;
          const grad = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
          grad.addColorStop(0, 'rgba(216,162,74,0.22)');
          grad.addColorStop(1, 'rgba(216,162,74,0.01)');
          return grad;
        },
        tension: 0.35,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(14,16,20,0.92)',
          borderColor: 'rgba(216,162,74,0.35)',
          borderWidth: 1,
          titleColor: '#bdb6a6',
          bodyColor: '#ece4d3',
          titleFont: { family: "'IBM Plex Mono', monospace", size: 10 },
          bodyFont:  { family: "'IBM Plex Mono', monospace", size: 13 },
          callbacks: {
            label: ctx => ` ${fmtKg(ctx.parsed.y)} kg`,
          },
        },
      },
      scales: {
        x: {
          grid: { color: mutedColor, drawTicks: false },
          ticks: {
            color: '#7e786c',
            font: { family: "'IBM Plex Mono', monospace", size: 10 },
            maxRotation: 0,
            maxTicksLimit: 8,
          },
          border: { color: mutedColor },
        },
        y: {
          grid: { color: mutedColor, drawTicks: false },
          ticks: {
            color: '#7e786c',
            font: { family: "'IBM Plex Mono', monospace", size: 10 },
            callback: v => `${v} kg`,
            maxTicksLimit: 5,
          },
          border: { color: mutedColor },
        },
      },
    },
  });
}

// ── render history table ──────────────────────────────────────────────────────
function renderTable(readings) {
  const tbody = $('hist-tbody');
  if (!tbody) return;

  // Most-recent first
  const rows = [...readings].reverse();

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:22px">No readings recorded.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(r => `
    <tr>
      <td>${fmtDate(r.ts)}</td>
      <td class="num">${fmtKg(r.weightKg) ?? '<span class="em-dash">—</span>'}</td>
      <td class="num hide-sm">${fmtBmi(r.bmi) ?? '<span class="em-dash">—</span>'}</td>
      <td class="num hide-sm">${r.bodyFatPct != null ? fmtPct(r.bodyFatPct) + '%' : '<span class="em-dash">—</span>'}</td>
      <td class="num hide-sm">${fmtInt(r.bmrKcal) ?? '<span class="em-dash">—</span>'}</td>
      <td class="num"><span class="source-badge">${r.source ?? '—'}</span></td>
      <td class="col-actions"><button class="del-btn" data-id="${r.id}" title="Delete reading" aria-label="Delete reading">✕</button></td>
    </tr>`).join('');
}

// ── update footer refresh time ────────────────────────────────────────────────
function updateRefreshLabel() {
  const el = $('footer-refresh');
  if (!el) return;
  const now = new Date();
  el.textContent = `Last updated ${now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
}

// ── main refresh cycle ────────────────────────────────────────────────────────
async function refresh() {
  setStatus('connecting');
  try {
    // Fetch all three endpoints in parallel
    const [profile, latest, readings] = await Promise.all([
      apiFetch(API.profile),
      apiFetch(API.latest),
      apiFetch(API.readings),
    ]);

    renderProfile(profile);
    renderHero(latest);
    renderChart(Array.isArray(readings) ? readings : []);
    renderTable(Array.isArray(readings) ? readings : []);
    updateRefreshLabel();
    setStatus('live');
  } catch (err) {
    console.warn('[occultd] fetch error:', err.message);
    setStatus('error');
    // On the first load (no chart yet) render empty hero gracefully
    if (!weightChart) {
      renderHero({});
      renderTable([]);
    }
  }
}

// ── theme toggle ──────────────────────────────────────────────────────────────
function initTheme() {
  const btn = $('theme-btn');
  const saved = localStorage.getItem('occultd-theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);

  btn?.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next === 'dark' ? '' : next);
    localStorage.setItem('occultd-theme', next);
    btn.textContent = next === 'light' ? '◑' : '◐';
    // Rebuild chart with new colour context
    if (weightChart) {
      weightChart.destroy();
      weightChart = null;
      // re-fetch to repaint (or just re-render with cached data if we had it)
      refresh();
    }
  });
}

// ── delete reading ────────────────────────────────────────────────────────────
function initDeleteListener() {
  const tbody = $('hist-tbody');
  if (!tbody) return;
  tbody.addEventListener('click', async e => {
    const btn = e.target.closest('.del-btn');
    if (!btn) return;
    const id = btn.dataset.id;
    if (!confirm('Delete this reading? This cannot be undone.')) return;
    try {
      const res = await fetch('./api/readings/' + id, { method: 'DELETE' });
      if (res.ok || res.status === 204) {
        await refresh();
      } else {
        console.warn('[occultd] delete failed:', res.status);
      }
    } catch (err) {
      console.warn('[occultd] delete error:', err.message);
    }
  });
}

// ── boot ──────────────────────────────────────────────────────────────────────
async function init() {
  initTheme();
  initDeleteListener();
  initSettings();

  // Check whether the user has completed onboarding.
  // If not, block until the wizard resolves before starting the dashboard.
  let serverSettings = null;
  try {
    serverSettings = await apiFetch(API.settings);
  } catch (err) {
    console.warn('[occultd] could not fetch settings on boot:', err.message);
    // Proceed to dashboard anyway — server may not support the endpoint yet.
  }

  if (serverSettings && serverSettings.onboarded === false) {
    await showOnboarding(serverSettings);
  }

  refresh();
  setInterval(refresh, REFRESH_MS);
}

document.addEventListener('DOMContentLoaded', init);
