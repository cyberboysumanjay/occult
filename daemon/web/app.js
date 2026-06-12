/* occultd dashboard — app.js
   Vanilla JS, no build step. Requires Chart.js 4 loaded before this script.
   Polls /api/profile and /api/readings every 30 seconds.
   Tab structure: Today | Trends | History                                   */

'use strict';

// ── constants ────────────────────────────────────────────────────────────────
const REFRESH_MS    = 30_000;
const SPARK_PTS     = 16;    // sparkline uses last N readings
const API = {
  profile:  './api/profile',
  readings: './api/readings',
  settings: './api/settings',
  tgTest:   './api/telegram/test',
};

// ── state ─────────────────────────────────────────────────────────────────────
let cachedReadings = [];
let activeTab      = 'today';

// Chart instance registry keyed by canvas id string (destroy-before-redraw)
const chartRegistry = {};

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ── number formatters ─────────────────────────────────────────────────────────
const fmtKg    = v => v != null ? (+v).toFixed(1) : null;
const fmtPct   = v => v != null ? (+v).toFixed(1) : null;
const fmtNum1  = v => v != null ? (+v).toFixed(1) : '—';
const fmtInt   = v => v != null ? Math.round(+v).toString() : '—';

/** Format ISO timestamp → "Jun 12, 2025, 09:41" */
function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/** Format ISO timestamp → "Jun 12" short form for sparkline labels */
function fmtShortDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Relative time: "3 h ago", "2 d ago", "just now" */
function fmtRelative(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (hours < 24) return `${hours} h ago`;
  return `${days} d ago`;
}

// ── BMI class → token for badge styling ──────────────────────────────────────
function bmiToken(cls) {
  if (!cls) return '';
  return cls.split(' ')[0]; // e.g. "overweight" from "overweight"
}

function bmiTagClass(bmi) {
  if (bmi == null) return '';
  if (bmi < 18.5) return 'warn';
  if (bmi < 25)   return 'good';
  if (bmi < 30)   return 'warn';
  return 'bad';
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
  return r.json();
}

// ── field helpers shared between onboarding and settings ─────────────────────
function birthYearToAge(birthYear) {
  return new Date().getFullYear() - birthYear;
}
function ageToBirthYear(age) {
  return new Date().getFullYear() - age;
}
function validateProfile(name, age, heightCm) {
  if (!name || !name.trim()) return 'Name is required.';
  if (!age || Number(age) <= 0 || isNaN(Number(age))) return 'A valid age is required.';
  if (!heightCm || Number(heightCm) <= 0 || isNaN(Number(heightCm))) return 'A valid height is required.';
  return '';
}
function buildSettingsBody(fields) {
  const {
    name, sex, age, heightCm,
    botToken, chatId,
    namePrefixes, rssiThreshold, minWeightKg, maxWeightKg, cooldownSeconds,
  } = fields;
  const prefixes = (namePrefixes || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  return {
    profile: {
      name: name.trim(), sex,
      birthYear: ageToBirthYear(Number(age)),
      heightCm:  Number(heightCm),
    },
    telegram: { botToken: botToken || '', chatId: chatId || '' },
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
function showOnboarding(serverSettings) {
  return new Promise(resolve => {
    const overlay   = $('onboarding-overlay');
    const form      = $('onboarding-form');
    const errEl     = $('onboarding-error');
    const submitBtn = $('onboarding-submit');

    if (serverSettings?.telegram?.botToken) $('ob-bot-token').value = serverSettings.telegram.botToken;
    if (serverSettings?.telegram?.chatId)   $('ob-chat-id').value   = serverSettings.telegram.chatId;

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
      if (validErr) { errEl.textContent = validErr; errEl.hidden = false; return; }

      submitBtn.disabled = true;
      submitBtn.textContent = '…';

      try {
        const sc = serverSettings?.scale || {};
        const body = buildSettingsBody({
          name, sex, age, heightCm, botToken, chatId,
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
async function openSettings() {
  const modal = $('settings-modal');
  const errEl = $('settings-error');
  const tgRes = $('st-tg-result');

  errEl.hidden = true;
  tgRes.textContent = '';
  tgRes.className = 'tg-result';

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

  $('st-name').value      = p.name      || '';
  $('st-sex').value       = p.sex       || 'male';
  $('st-age').value       = p.birthYear ? birthYearToAge(p.birthYear) : '';
  $('st-height').value    = p.heightCm  || '';
  $('st-bot-token').value = tg.botToken || '';
  $('st-chat-id').value   = tg.chatId   || '';
  $('st-prefixes').value  = (sc.namePrefixes || []).join(', ');
  $('st-rssi').value      = sc.rssiThreshold   ?? '';
  $('st-min-kg').value    = sc.minWeightKg     ?? '';
  $('st-max-kg').value    = sc.maxWeightKg     ?? '';
  $('st-cooldown').value  = sc.cooldownSeconds ?? '';

  modal.hidden = false;
  $('st-name').focus();
}

function initSettings() {
  const modal     = $('settings-modal');
  const form      = $('settings-form');
  const errEl     = $('settings-error');
  const tgTestBtn = $('st-tg-test');
  const tgRes     = $('st-tg-result');
  const toast     = $('settings-toast');
  const saveBtn   = $('settings-save');

  $('settings-btn').addEventListener('click', openSettings);

  const closeModal = () => { modal.hidden = true; };
  $('settings-close').addEventListener('click', closeModal);
  $('settings-cancel').addEventListener('click', closeModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !modal.hidden) closeModal(); });

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

  form.addEventListener('submit', async e => {
    e.preventDefault();
    errEl.hidden = true;

    const name     = $('st-name').value;
    const sex      = $('st-sex').value;
    const age      = $('st-age').value;
    const heightCm = $('st-height').value;

    const validErr = validateProfile(name, age, heightCm);
    if (validErr) { errEl.textContent = validErr; errEl.hidden = false; return; }

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

function showToast(el, message) {
  el.textContent = message;
  el.hidden = false;
  setTimeout(() => { el.hidden = true; }, 2800);
}

// ── status dot / connecting banner ───────────────────────────────────────────
function setStatus(state) {
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

// ── render profile name in header ─────────────────────────────────────────────
function renderProfile(profile) {
  const el = $('profile-name');
  if (el && profile?.name) el.textContent = profile.name;
}

// ── Chart helpers (mirrors charts.js from the PWA) ────────────────────────────

/** Apply Chart.js global defaults once. */
function ensureChartTheme() {
  if (!window.Chart) return;
  Chart.defaults.font.family = "'JetBrains Mono', ui-monospace, monospace";
  Chart.defaults.font.size   = 10;
  Chart.defaults.color       = '#6e6b85';
  Chart.defaults.borderColor = 'rgba(255,255,255,0.07)';
  Chart.defaults.plugins.legend.display  = false;
  Chart.defaults.animation.duration = 700;
  Chart.defaults.maintainAspectRatio = false;
}

/** Destroy any previously registered chart on this canvas id, then store the new one. */
function registerChart(id, instance) {
  if (chartRegistry[id]) {
    try { chartRegistry[id].destroy(); } catch (_) {}
  }
  chartRegistry[id] = instance;
}

/** Convert hex (#rrggbb) to rgba string. */
function hexA(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return `rgba(216,162,74,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Gold gradient fill for line charts. */
function goldGradient(ctx, color) {
  const g = ctx.createLinearGradient(0, 0, 0, 200);
  g.addColorStop(0, hexA(color, 0.28));
  g.addColorStop(1, hexA(color, 0.0));
  return g;
}

/**
 * Draw a line chart on a canvas.
 * @param {HTMLCanvasElement} canvas
 * @param {object} opts  { id, labels, values, color, unit, spark }
 */
function lineChart(canvas, { id, labels, values, color = '#a06bff', unit = '', spark = false }) {
  if (!window.Chart || !canvas) return;
  const ctx = canvas.getContext('2d');
  const instance = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: values,
        borderColor: color,
        backgroundColor: goldGradient(ctx, color),
        borderWidth: 2,
        fill: true,
        tension: 0.35,
        pointRadius: 0,
        pointHoverRadius: spark ? 0 : 4,
        pointHoverBackgroundColor: color,
        pointBackgroundColor: color,
      }],
    },
    options: {
      responsive: true,
      plugins: {
        tooltip: spark ? { enabled: false } : {
          backgroundColor: '#0d0d13',
          borderColor: 'rgba(255,255,255,0.13)',
          borderWidth: 1,
          titleColor: '#b8b5cc',
          bodyColor: '#f2f0ff',
          padding: 10,
          displayColors: false,
          callbacks: { label: c => `${c.formattedValue}${unit}` },
        },
      },
      scales: spark
        ? { x: { display: false }, y: { display: false } }
        : {
            x: {
              grid: { display: false },
              ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 6, color: '#6e6b85',
                       font: { family: "'JetBrains Mono', monospace", size: 10 } },
              border: { color: 'rgba(255,255,255,0.07)' },
            },
            y: {
              grid: { color: 'rgba(255,255,255,0.06)' },
              ticks: { maxTicksLimit: 5, color: '#6e6b85',
                       font: { family: "'JetBrains Mono', monospace", size: 10 } },
              border: { display: false },
            },
          },
      interaction: { mode: 'index', intersect: false },
    },
  });
  if (id) registerChart(id, instance);
  return instance;
}

/**
 * Draw a doughnut composition chart.
 * @param {HTMLCanvasElement} canvas
 * @param {string} id  canvas element id for registry
 * @param {Array}  segments  [{label, value, color}]
 */
function donutChart(canvas, id, segments) {
  if (!window.Chart || !canvas || !segments.length) return;
  const ctx = canvas.getContext('2d');
  const instance = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: segments.map(s => s.label),
      datasets: [{
        data: segments.map(s => s.value),
        backgroundColor: segments.map(s => s.color),
        borderColor: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#08080c',
        borderWidth: 4,
        hoverOffset: 6,
      }],
    },
    options: {
      responsive: true,
      cutout: '70%',
      plugins: {
        legend: {
          display: true, position: 'bottom',
          labels: { boxWidth: 9, boxHeight: 9, padding: 14, usePointStyle: true, color: '#b8b5cc' },
        },
        tooltip: {
          backgroundColor: '#0d0d13', borderColor: 'rgba(255,255,255,0.13)', borderWidth: 1,
          titleColor: '#b8b5cc', bodyColor: '#f2f0ff', padding: 10, displayColors: false,
          callbacks: { label: c => `${c.label}: ${(+c.formattedValue).toFixed(1)} kg` },
        },
      },
    },
  });
  registerChart(id, instance);
  return instance;
}

// ── count-up animation (mirrors PWA render.js) ───────────────────────────────
function countUp(node, to, { digits = 1, dur = 750 } = {}) {
  if (to == null) { node.textContent = '—'; return; }
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    node.textContent = (+to).toFixed(digits); return;
  }
  const start = performance.now();
  function tick(t) {
    const k     = Math.min(1, (t - start) / dur);
    const eased = 1 - Math.pow(1 - k, 3);
    node.textContent = (to * eased).toFixed(digits);
    if (k < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

// ── favorability-aware delta chip ────────────────────────────────────────────
function deltaChip(curr, prev, { higherIsBetter = false, digits = 1, unit = '' } = {}) {
  if (curr == null || prev == null) return '';
  const d = curr - prev;
  if (Math.abs(d) < Math.pow(10, -digits) / 2) return `<span class="metric-delta">·</span>`;
  const arrow = d > 0 ? '▲' : '▼';
  const favorable = higherIsBetter ? d > 0 : d < 0;
  const cls = favorable ? 'down' : 'up'; // 'down' = green (good), 'up' = amber (unfavorable)
  return `<span class="metric-delta ${cls}">${arrow} ${Math.abs(d).toFixed(digits)}${unit}</span>`;
}

// ── metric card builder ───────────────────────────────────────────────────────
function buildMetricCard(label, value, unit, curr, prev, opts = {}) {
  const { sub = '', higherIsBetter = false, tag = '', tagClass = '', color = '' } = opts;
  const article = document.createElement('article');
  article.className = 'metric';
  if (color) article.style.setProperty('--accent', color);
  article.innerHTML = `
    <div class="metric-top">
      <span class="metric-label">${label}</span>
      ${deltaChip(curr, prev, { higherIsBetter })}
    </div>
    <div class="metric-value">${value}${unit ? `<span class="metric-unit">${unit}</span>` : ''}</div>
    <div class="metric-sub">${sub}</div>
    ${tag ? `<span class="metric-tag ${tagClass}">${tag}</span>` : ''}`;
  return article;
}

// ── TODAY renderer ────────────────────────────────────────────────────────────
function renderToday(readings) {
  const heroEl = $('today-hero');
  const gridEl = $('today-grid');

  if (!readings.length) {
    heroEl.innerHTML = `
      <div class="hero-empty-msg">
        <div class="hero-big-text">No readings yet</div>
        <p style="color:var(--muted);font-size:12px;margin:8px 0 0">
          No readings yet — step on the scale.
        </p>
      </div>`;
    gridEl.innerHTML = '';
    return;
  }

  const latest = readings[readings.length - 1];
  const prev   = readings.length > 1 ? readings[readings.length - 2] : null;

  // ── hero tile (full-width) ──
  heroEl.innerHTML = `
    <div class="hero-eyebrow">Latest weigh-in · <span>${fmtRelative(latest.ts)}</span></div>
    <div class="hero-weight-row">
      <span class="hero-weight" id="hero-weight-val">0.0</span>
      <span class="hero-unit">kg</span>
    </div>
    <div id="hero-delta"></div>
    <div class="hero-spark-wrap"><canvas id="hero-spark"></canvas></div>`;

  // count-up animation
  countUp($('hero-weight-val'), latest.weightKg, { digits: 1 });

  // delta vs previous
  const deltaWrap = $('hero-delta');
  if (prev && prev.weightKg != null && latest.weightKg != null) {
    const d   = latest.weightKg - prev.weightKg;
    const dir = d < 0 ? 'down' : d > 0 ? 'up' : '';
    const arrow = d < 0 ? '▼' : d > 0 ? '▲' : '·';
    deltaWrap.innerHTML = `<span class="hero-delta-badge ${dir}">${arrow} ${Math.abs(d).toFixed(1)} kg since ${fmtShortDate(prev.ts)}</span>`;
  }

  // sparkline — last SPARK_PTS readings
  const recent = readings.slice(-SPARK_PTS);
  const sparkCanvas = $('hero-spark');
  if (sparkCanvas) {
    lineChart(sparkCanvas, {
      id: 'hero-spark',
      labels: recent.map(() => ''),
      values: recent.map(r => r.weightKg),
      color: '#a06bff',
      spark: true,
    });
  }

  // ── metric tiles ──
  const cards = [
    buildMetricCard(
      'Body fat', fmtNum1(latest.bodyFatPct), '%',
      latest.bodyFatPct, prev?.bodyFatPct,
      {
        color: 'var(--c-fat)',
        sub: latest.fatMassKg != null
          ? `${fmtNum1(latest.fatMassKg)} kg fat · ${fmtNum1(latest.ffmKg)} kg lean` : '',
      }
    ),
    buildMetricCard(
      'Body water', fmtNum1(latest.bodyWaterPct), '%',
      latest.bodyWaterPct, prev?.bodyWaterPct,
      {
        color: 'var(--c-water)', higherIsBetter: true,
        sub: latest.tbwL != null ? `${fmtNum1(latest.tbwL)} L total` : '',
      }
    ),
    buildMetricCard(
      'BMI', fmtNum1(latest.bmi), '',
      latest.bmi, prev?.bmi,
      {
        color: 'var(--c-bmi)',
        tag: latest.bmiClass || '',
        tagClass: bmiTagClass(latest.bmi),
      }
    ),
    buildMetricCard(
      'Resting burn', latest.bmrKcal != null ? fmtInt(latest.bmrKcal) : '—', '',
      null, null,
      { color: 'var(--c-energy)', sub: 'kcal/day · Mifflin-St Jeor' }
    ),
    buildMetricCard(
      'Heart rate', latest.heartRate != null ? fmtInt(latest.heartRate) : '—', 'bpm',
      null, null,
      {
        color: 'var(--c-hr)',
        sub: latest.heartRate != null ? 'at last weigh-in' : 'not captured',
      }
    ),
    buildMetricCard(
      'Fat mass', fmtNum1(latest.fatMassKg), 'kg',
      latest.fatMassKg, prev?.fatMassKg,
      { color: 'var(--c-mass)' }
    ),
    buildMetricCard(
      'Lean mass', fmtNum1(latest.ffmKg), 'kg',
      latest.ffmKg, prev?.ffmKg,
      { color: 'var(--c-lean)', higherIsBetter: true, sub: 'fat-free mass' }
    ),
  ];

  gridEl.innerHTML = '';
  // bento placement: 4 stat tiles, then a 2×2 weight-trend chart tile, then the rest
  cards.slice(0, 4).forEach((card, i) => {
    card.style.animationDelay = `${i * 55}ms`;
    gridEl.appendChild(card);
  });

  if (readings.length >= 2) {
    const chartTile = document.createElement('article');
    chartTile.className = 'tile chart';
    chartTile.style.animationDelay = '220ms';
    chartTile.innerHTML = `
      <h3>Weight trend</h3>
      <div class="now">${fmtNum1(latest.weightKg)} kg</div>
      <div class="holder"><canvas id="today-trend"></canvas></div>`;
    gridEl.appendChild(chartTile);
    lineChart(chartTile.querySelector('canvas'), {
      id: 'today-trend',
      labels: readings.map(r => fmtShortDate(r.ts)),
      values: readings.map(r => r.weightKg),
      color: '#ff6f5c',
      unit: ' kg',
    });
  }

  cards.slice(4).forEach((card, i) => {
    card.style.animationDelay = `${(i + 5) * 55}ms`;
    gridEl.appendChild(card);
  });
}

// ── TRENDS renderer ───────────────────────────────────────────────────────────
function renderTrends(readings) {
  const gridEl = $('trends-grid');

  if (readings.length < 2) {
    gridEl.innerHTML = `
      <div class="chart-card">
        <h3 class="chart-card-title">Trends</h3>
        <p class="metric-sub" style="padding:8px 0">Need at least two weigh-ins to chart a trend.</p>
      </div>`;
    return;
  }

  const labels = readings.map(r => fmtShortDate(r.ts));
  const latest = readings[readings.length - 1];
  gridEl.innerHTML = '';

  const series = [
    { title: 'Weight',    key: 'weightKg',    unit: ' kg', color: '#ff6f5c', now: fmtNum1(latest.weightKg) + ' kg',  id: 'chart-weight' },
    { title: 'Body fat',  key: 'bodyFatPct',  unit: '%',   color: '#ff8a4c', now: fmtNum1(latest.bodyFatPct) + '%',  id: 'chart-fat'    },
    { title: 'BMI',       key: 'bmi',         unit: '',    color: '#a06bff', now: fmtNum1(latest.bmi),               id: 'chart-bmi'    },
  ];

  for (const s of series) {
    const card = document.createElement('div');
    card.className = 'chart-card';
    card.innerHTML = `
      <h3 class="chart-card-title">${s.title}</h3>
      <div class="chart-now">${s.now}</div>
      <div class="chart-holder"><canvas id="${s.id}"></canvas></div>`;
    gridEl.appendChild(card);
    lineChart(card.querySelector('canvas'), {
      id: s.id,
      labels,
      values: readings.map(r => r[s.key]),
      color: s.color,
      unit: s.unit,
    });
  }

  // composition donut
  const segs = [];
  if (latest.fatMassKg != null) segs.push({ label: 'Fat',       value: latest.fatMassKg, color: '#ff8a4c' });
  if (latest.ffmKg     != null) segs.push({ label: 'Lean mass', value: latest.ffmKg,     color: '#5d8bff' });

  if (segs.length) {
    const donutCard = document.createElement('div');
    donutCard.className = 'chart-card';
    donutCard.innerHTML = `
      <h3 class="chart-card-title">Composition · latest</h3>
      <div class="chart-now">${fmtNum1(latest.weightKg)} kg</div>
      <div class="chart-holder tall"><canvas id="chart-donut"></canvas></div>`;
    gridEl.appendChild(donutCard);
    donutChart(donutCard.querySelector('canvas'), 'chart-donut', segs);
  }
}

// ── HISTORY renderer ──────────────────────────────────────────────────────────
function renderHistory(readings) {
  const wrapEl = $('history-wrap');

  if (!readings.length) {
    wrapEl.innerHTML = `<div style="padding:28px;color:var(--muted);font-size:12px">No readings recorded yet.</div>`;
    return;
  }

  const rows = [...readings].reverse().map(r => `
    <tr>
      <td>${fmtDateTime(r.ts)}${r.source === 'seed' ? ' <span class="source-badge">demo</span>' : ''}</td>
      <td class="num">${fmtKg(r.weightKg) ?? '—'}</td>
      <td class="num hide-sm">${r.bodyFatPct != null ? fmtPct(r.bodyFatPct) + '%' : '—'}</td>
      <td class="num hide-sm">${r.bmi != null ? (+r.bmi).toFixed(1) : '—'}</td>
      <td class="num hide-sm">${r.heartRate != null ? r.heartRate : '—'}</td>
      <td style="text-align:right">
        <button class="del-btn" data-id="${r.id}" title="Delete reading" aria-label="Delete reading">✕</button>
      </td>
    </tr>`).join('');

  wrapEl.innerHTML = `
    <div class="history-scroll">
      <table class="ledger" aria-label="Reading history">
        <thead>
          <tr>
            <th>When</th>
            <th>Weight</th>
            <th class="hide-sm">Fat %</th>
            <th class="hide-sm">BMI</th>
            <th class="hide-sm">HR</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  // Wire delete buttons
  wrapEl.querySelectorAll('.del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
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
  });
}

// ── tab switching ─────────────────────────────────────────────────────────────
function initTabs() {
  const tabBar     = $('tab-bar');
  const underline  = $('tab-underline');

  function activateTab(name) {
    activeTab = name;

    // Update button states
    tabBar.querySelectorAll('.tab-btn').forEach(btn => {
      const active = btn.dataset.tab === name;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    // Update panel visibility
    document.querySelectorAll('.tab-panel').forEach(panel => {
      panel.classList.toggle('is-active', panel.id === `panel-${name}`);
    });

    // Move underline
    const activeBtn = tabBar.querySelector(`.tab-btn[data-tab="${name}"]`);
    if (activeBtn && underline) {
      underline.style.left  = activeBtn.offsetLeft + 'px';
      underline.style.width = activeBtn.offsetWidth + 'px';
    }

    // Render the active tab from cached data
    renderActiveTab();
  }

  tabBar.addEventListener('click', e => {
    const btn = e.target.closest('.tab-btn');
    if (btn && btn.dataset.tab) activateTab(btn.dataset.tab);
  });

  // Set initial underline position after layout
  requestAnimationFrame(() => activateTab('today'));
}

/** Re-render whichever tab is currently active using cachedReadings. */
function renderActiveTab() {
  if (activeTab === 'today')   renderToday(cachedReadings);
  if (activeTab === 'trends')  renderTrends(cachedReadings);
  if (activeTab === 'history') renderHistory(cachedReadings);
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
    const [profile, readings] = await Promise.all([
      apiFetch(API.profile),
      apiFetch(API.readings),
    ]);

    renderProfile(profile);
    cachedReadings = Array.isArray(readings) ? readings : [];
    renderActiveTab();
    updateRefreshLabel();
    setStatus('live');
  } catch (err) {
    console.warn('[occultd] fetch error:', err.message);
    setStatus('error');
    if (!cachedReadings.length) {
      renderToday([]);
    }
  }
}

// ── theme toggle ──────────────────────────────────────────────────────────────
function initTheme() {
  const btn   = $('theme-btn');
  const saved = localStorage.getItem('occultd-theme');
  if (saved) {
    document.documentElement.setAttribute('data-theme', saved);
    if (btn) btn.textContent = saved === 'light' ? '◑' : '◐';
  }

  btn?.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next    = current === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next === 'dark' ? '' : next);
    localStorage.setItem('occultd-theme', next);
    btn.textContent = next === 'light' ? '◑' : '◐';
    // Destroy all charts so they redraw with the new colour context
    Object.keys(chartRegistry).forEach(id => {
      try { chartRegistry[id].destroy(); } catch (_) {}
      delete chartRegistry[id];
    });
    renderActiveTab();
  });
}

// ── boot ──────────────────────────────────────────────────────────────────────
async function init() {
  ensureChartTheme();
  initTheme();
  initTabs();
  initSettings();

  let serverSettings = null;
  try {
    serverSettings = await apiFetch(API.settings);
  } catch (err) {
    console.warn('[occultd] could not fetch settings on boot:', err.message);
  }

  if (serverSettings && serverSettings.onboarded === false) {
    await showOnboarding(serverSettings);
  }

  refresh();
  setInterval(refresh, REFRESH_MS);
}

document.addEventListener('DOMContentLoaded', init);

// Reveal/hide the (secret) bot-token fields — delegated so it covers both the
// onboarding and settings inputs without per-element wiring.
document.addEventListener('change', (e) => {
  const cb = e.target.closest?.('.reveal-cb');
  if (!cb) return;
  const input = document.getElementById(cb.dataset.target);
  if (input) input.type = cb.checked ? 'text' : 'password';
});
