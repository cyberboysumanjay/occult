// Shared formatting + small date helpers.

export const kg = (v, d = 1) => (v == null ? '—' : `${Number(v).toFixed(d)} kg`);
export const pct = (v, d = 1) => (v == null ? '—' : `${Number(v).toFixed(d)}%`);
export const num = (v, d = 0) => (v == null ? '—' : Number(v).toFixed(d));

export function ageFromBirthYear(birthYear, now = new Date()) {
  if (!birthYear) return null;
  return now.getFullYear() - birthYear;
}

export function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function fmtDateTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

export function fmtRelative(iso) {
  const then = new Date(iso).getTime();
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return fmtDate(iso);
}

// Stable per-profile accent palette (used when creating a profile).
export const PROFILE_COLORS = [
  '#5b8cff', '#22c39a', '#ff8a3d', '#c77dff', '#ff5d8f', '#ffd23f', '#3dd1e8', '#9ae66e',
];
