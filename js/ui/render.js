// DOM renderers for the Today, Trends, and History panels.
// Readings already carry their derived snapshot (from bodycomp.deriveReading at
// save time), so rendering is pure presentation — no recomputation here.

import { kg, pct, num, fmtDate, fmtRelative, fmtDateTime } from '../util/format.js';
import { lineChart, donut } from './charts.js';

// ── small helpers ────────────────────────────────────────────────────────────
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};

/** Favorability-aware delta chip. higherIsBetter flips the good/bad coloring. */
function deltaChip(curr, prev, { higherIsBetter = false, digits = 1, unit = '' } = {}) {
  if (curr == null || prev == null) return '';
  const d = curr - prev;
  if (Math.abs(d) < Math.pow(10, -digits) / 2) return `<span class="metric-delta">·</span>`;
  const arrow = d > 0 ? '▲' : '▼';
  const favorable = higherIsBetter ? d > 0 : d < 0;
  const cls = favorable ? 'down' : 'up'; // 'down' styled green, 'up' styled amber
  return `<span class="metric-delta ${cls}">${arrow} ${Math.abs(d).toFixed(digits)}${unit}</span>`;
}

function countUp(node, to, { digits = 1, dur = 750 } = {}) {
  if (to == null) { node.textContent = '—'; return; }
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    node.textContent = (+to).toFixed(digits); return;
  }
  const start = performance.now();
  const from = 0;
  function tick(t) {
    const k = Math.min(1, (t - start) / dur);
    const eased = 1 - Math.pow(1 - k, 3);
    node.textContent = (from + (to - from) * eased).toFixed(digits);
    if (k < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

const bmiTagClass = (b) => (b == null ? '' : b < 18.5 ? 'warn' : b < 25 ? 'good' : b < 30 ? 'warn' : 'bad');

// ── Today ──────────────────────────────────────────────────────────────────
export function renderToday({ heroEl, gridEl, readings, profile }) {
  const accent = profile?.color || '#a06bff';
  heroEl.style.setProperty('--accent', accent);

  if (!profile) {
    heroEl.innerHTML = `
      <div class="hero-empty">
        <div class="big">Welcome to occult</div>
        <p>Create your profile to start measuring.</p>
      </div>`;
    gridEl.innerHTML = '';
    return;
  }

  if (!readings.length) {
    heroEl.innerHTML = `
      <div class="hero-empty">
        <div class="big">No readings yet</div>
        <p>Press <b>Measure</b> and step on the scale — or add a manual weigh-in with ＋.</p>
      </div>`;
    gridEl.innerHTML = '';
    return;
  }

  const latest = readings[readings.length - 1];
  const prev = readings.length > 1 ? readings[readings.length - 2] : null;

  heroEl.innerHTML = `
    <div class="hero-eyebrow">Latest weigh-in · <span>${fmtRelative(latest.ts)}</span></div>
    <div class="hero-weight"><span id="heroWeightVal">0.0</span><span class="hero-unit">kg</span></div>
    <div id="heroDelta"></div>
    <div class="hero-spark"><canvas id="heroSpark"></canvas></div>`;

  countUp(heroEl.querySelector('#heroWeightVal'), latest.weightKg, { digits: 1 });

  const deltaWrap = heroEl.querySelector('#heroDelta');
  if (prev) {
    const d = latest.weightKg - prev.weightKg;
    const dir = d < 0 ? 'down' : d > 0 ? 'up' : '';
    const arrow = d < 0 ? '▼' : d > 0 ? '▲' : '·';
    deltaWrap.innerHTML = `<span class="hero-delta ${dir}">${arrow} ${Math.abs(d).toFixed(1)} kg since ${fmtDate(prev.ts)}</span>`;
  }

  // hero sparkline — last 16 weigh-ins
  const recent = readings.slice(-16);
  lineChart(heroEl.querySelector('#heroSpark'), {
    labels: recent.map((r) => ''),
    values: recent.map((r) => r.weightKg),
    color: accent,
    spark: true,
  });

  // instrument cards
  const cards = [
    metricCard('Body fat', pctVal(latest.bodyFatPct), '%', latest.bodyFatPct, prev?.bodyFatPct,
      { color: 'var(--c-fat)', sub: latest.fatMassKg != null ? `${kg(latest.fatMassKg)} fat · ${kg(latest.ffmKg)} lean` : '' }),
    metricCard('Body water', pctVal(latest.bodyWaterPct), '%', latest.bodyWaterPct, prev?.bodyWaterPct,
      { color: 'var(--c-water)', higherIsBetter: true, sub: latest.tbwL != null ? `${num(latest.tbwL, 1)} L total` : '' }),
    metricCard('BMI', numVal(latest.bmi), '', latest.bmi, prev?.bmi,
      { color: 'var(--c-bmi)', sub: '', tag: latest.bmiClass, tagClass: bmiTagClass(latest.bmi) }),
    metricCard('Resting burn', latest.bmrKcal != null ? String(latest.bmrKcal) : '—', '', null, null,
      { color: 'var(--c-energy)', sub: 'kcal/day · Mifflin-St Jeor' }),
    metricCard('Heart rate', latest.heartRate != null ? String(latest.heartRate) : '—', 'bpm', null, null,
      { color: 'var(--c-hr)', sub: latest.heartRate != null ? 'at last weigh-in' : 'not captured' }),
    metricCard('Fat mass', numVal(latest.fatMassKg), 'kg', latest.fatMassKg, prev?.fatMassKg, { color: 'var(--c-mass)', sub: '' }),
    metricCard('Lean mass', numVal(latest.ffmKg), 'kg', latest.ffmKg, prev?.ffmKg, { color: 'var(--c-lean)', higherIsBetter: true, sub: 'fat-free mass' }),
  ];
  gridEl.innerHTML = '';
  // bento placement: 4 stat tiles, then a 2×2 weight-trend chart tile, then the rest
  cards.slice(0, 4).forEach((c, i) => { c.style.animationDelay = `${i * 55}ms`; gridEl.appendChild(c); });

  if (readings.length >= 2) {
    const chartTile = el('article', 'metric chart-tile');
    chartTile.style.animationDelay = '220ms';
    chartTile.innerHTML = `
      <h3>Weight trend</h3>
      <div class="now">${kg(latest.weightKg)}</div>
      <div class="holder"><canvas></canvas></div>`;
    gridEl.appendChild(chartTile);
    lineChart(chartTile.querySelector('canvas'), {
      labels: readings.map((r) => fmtDate(r.ts)),
      values: readings.map((r) => r.weightKg),
      color: '#ff6f5c',
      unit: ' kg',
    });
  }

  cards.slice(4).forEach((c, i) => { c.style.animationDelay = `${(i + 5) * 55}ms`; gridEl.appendChild(c); });
}

const pctVal = (v) => (v == null ? '—' : v.toFixed(1));
const numVal = (v) => (v == null ? '—' : v.toFixed(1));

function metricCard(label, value, unit, curr, prev, opts = {}) {
  const { sub = '', higherIsBetter = false, tag = '', tagClass = '', color = '' } = opts;
  const node = el('article', 'metric');
  if (color) node.style.setProperty('--accent', color);
  node.innerHTML = `
    <div class="metric-top">
      <span class="metric-label">${label}</span>
      ${deltaChip(curr, prev, { higherIsBetter })}
    </div>
    <div class="metric-value">${value}${unit ? `<span class="metric-unit">${unit}</span>` : ''}</div>
    ${sub ? `<div class="metric-sub">${sub}</div>` : '<div class="metric-sub"></div>'}
    ${tag ? `<span class="metric-tag ${tagClass}">${tag}</span>` : ''}`;
  return node;
}

// ── Trends ───────────────────────────────────────────────────────────────────
export function renderTrends({ gridEl, readings, profile }) {
  const accent = profile?.color || '#a06bff';
  if (readings.length < 2) {
    gridEl.innerHTML = `<div class="chart-card"><h3>Trends</h3><p class="metric-sub">Need at least two weigh-ins to chart a trend. Keep weighing in.</p></div>`;
    return;
  }
  const labels = readings.map((r) => fmtDate(r.ts));
  const latest = readings[readings.length - 1];
  gridEl.innerHTML = '';

  const series = [
    { title: 'Weight', key: 'weightKg', unit: ' kg', color: '#ff6f5c', now: kg(latest.weightKg) },
    { title: 'Body fat', key: 'bodyFatPct', unit: '%', color: '#ff8a4c', now: pct(latest.bodyFatPct) },
    { title: 'BMI', key: 'bmi', unit: '', color: '#a06bff', now: num(latest.bmi, 1) },
  ];

  for (const s of series) {
    const card = el('div', 'chart-card');
    card.innerHTML = `<h3>${s.title}</h3><div class="chart-now">${s.now}</div><div class="chart-holder"><canvas></canvas></div>`;
    gridEl.appendChild(card);
    lineChart(card.querySelector('canvas'), {
      labels,
      values: readings.map((r) => r[s.key]),
      color: s.color,
      unit: s.unit,
    });
  }

  // composition donut from the latest reading (segments sum to weight)
  const card = el('div', 'chart-card');
  card.innerHTML = `<h3>Composition · latest</h3><div class="chart-now">${kg(latest.weightKg)}</div><div class="chart-holder tall"><canvas></canvas></div>`;
  gridEl.appendChild(card);
  const segs = [];
  if (latest.fatMassKg != null) segs.push({ label: 'Fat', value: latest.fatMassKg, color: '#ff8a4c' });
  if (latest.ffmKg != null) segs.push({ label: 'Lean mass', value: latest.ffmKg, color: '#5d8bff' });
  donut(card.querySelector('canvas'), segs);
}

const round1 = (v) => Math.round(v * 10) / 10;

// ── History ──────────────────────────────────────────────────────────────────
export function renderHistory({ wrapEl, readings, onDelete }) {
  if (!readings.length) {
    wrapEl.innerHTML = `<div style="padding:28px;color:var(--muted);font-size:12px">No readings recorded yet.</div>`;
    return;
  }
  const rows = [...readings].reverse().map((r) => `
    <tr>
      <td>${fmtDateTime(r.ts)}${r.source === 'seed' ? ' <span class="metric-tag" style="font-size:8px">demo</span>' : ''}</td>
      <td class="num">${num(r.weightKg, 1)}</td>
      <td class="num hide-sm">${r.bodyFatPct != null ? r.bodyFatPct.toFixed(1) : '—'}</td>
      <td class="num hide-sm">${r.bmi != null ? r.bmi.toFixed(1) : '—'}</td>
      <td class="num hide-sm">${r.heartRate ?? '—'}</td>
      <td style="text-align:right"><button class="row-del" data-id="${r.id}" title="Delete">✕</button></td>
    </tr>`).join('');

  wrapEl.innerHTML = `
    <table class="ledger">
      <thead><tr>
        <th>When</th><th>Weight</th><th class="hide-sm">Fat %</th>
        <th class="hide-sm">BMI</th><th class="hide-sm">HR</th><th></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  wrapEl.querySelectorAll('.row-del').forEach((b) =>
    b.addEventListener('click', () => onDelete(Number(b.dataset.id))));
}
