// Chart.js theming + builders. Chart.js is loaded as a global (UMD script in
// index.html), so we read it off window. Each builder destroys any prior chart
// bound to the same canvas before drawing, so re-renders never leak instances.

const Chart = window.Chart;
const registry = new WeakMap(); // canvas -> Chart instance

let themed = false;
function ensureTheme() {
  if (themed || !Chart) return;
  themed = true;
  Chart.defaults.font.family = "'JetBrains Mono', monospace";
  Chart.defaults.font.size = 10;
  Chart.defaults.color = '#6e6b85';
  Chart.defaults.borderColor = 'rgba(255,255,255,0.07)';
  Chart.defaults.plugins.legend.display = false;
  Chart.defaults.animation.duration = 700;
  Chart.defaults.maintainAspectRatio = false;
}

function reset(canvas) {
  const prev = registry.get(canvas);
  if (prev) prev.destroy();
}

function gradient(ctx, color) {
  const g = ctx.createLinearGradient(0, 0, 0, 200);
  g.addColorStop(0, hexA(color, 0.28));
  g.addColorStop(1, hexA(color, 0.0));
  return g;
}

// hex (#rrggbb) -> rgba string at alpha a
function hexA(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return `rgba(216,162,74,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/**
 * A clean line chart (weight, body fat, muscle, BMI…).
 * @param canvas  <canvas>
 * @param opts    { labels:string[], values:number[], color, unit, spark? }
 */
export function lineChart(canvas, { labels, values, color = '#a06bff', unit = '', spark = false }) {
  if (!Chart || !canvas) return;
  ensureTheme();
  reset(canvas);
  const ctx = canvas.getContext('2d');
  const chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: values,
        borderColor: color,
        backgroundColor: gradient(ctx, color),
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
      plugins: {
        tooltip: spark ? { enabled: false } : {
          backgroundColor: '#0d0d13',
          borderColor: 'rgba(255,255,255,0.13)',
          borderWidth: 1,
          titleColor: '#b8b5cc',
          bodyColor: '#f2f0ff',
          padding: 10,
          displayColors: false,
          callbacks: { label: (c) => `${c.formattedValue}${unit}` },
        },
      },
      scales: spark
        ? { x: { display: false }, y: { display: false } }
        : {
            x: { grid: { display: false }, ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 6 } },
            y: { grid: { color: 'rgba(255,255,255,0.06)' }, ticks: { maxTicksLimit: 5 }, border: { display: false } },
          },
      interaction: { mode: 'index', intersect: false },
    },
  });
  registry.set(canvas, chart);
  return chart;
}

/**
 * Body-composition donut. segments: [{label, value, color}].
 */
export function donut(canvas, segments) {
  if (!Chart || !canvas) return;
  ensureTheme();
  reset(canvas);
  const ctx = canvas.getContext('2d');
  const chart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: segments.map((s) => s.label),
      datasets: [{
        data: segments.map((s) => s.value),
        backgroundColor: segments.map((s) => s.color),
        borderColor: (getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#08080c'),
        borderWidth: 4,
        hoverOffset: 6,
      }],
    },
    options: {
      cutout: '70%',
      plugins: {
        legend: { display: true, position: 'bottom', labels: { boxWidth: 9, boxHeight: 9, padding: 14, usePointStyle: true, color: '#b8b5cc' } },
        tooltip: {
          backgroundColor: '#0d0d13', borderColor: 'rgba(255,255,255,0.13)', borderWidth: 1,
          titleColor: '#b8b5cc', bodyColor: '#f2f0ff', padding: 10, displayColors: false,
          callbacks: { label: (c) => `${c.label}: ${c.formattedValue} kg` },
        },
      },
    },
  });
  registry.set(canvas, chart);
  return chart;
}
