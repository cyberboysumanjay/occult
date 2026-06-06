// Profiles panel: avatar cards with latest stats + activate/edit/delete actions.
// The create/edit modal itself is owned by app.js (it holds the form DOM);
// this module only renders the grid and wires the per-card action callbacks.

import { ageFromBirthYear, kg, pct } from '../util/format.js';

const initials = (name) => (name || '?').trim().charAt(0).toUpperCase();

/**
 * @param gridEl            container
 * @param profiles          Profile[]
 * @param activeId          number|null
 * @param latestByProfile   Map<id, Reading|null>
 * @param handlers          { onActivate, onEdit, onDelete }
 */
export function renderProfiles({ gridEl, profiles, activeId, latestByProfile, handlers }) {
  gridEl.innerHTML = '';
  if (!profiles.length) {
    gridEl.innerHTML = `<div class="metric-sub" style="padding:20px">No profiles yet — create one to start tracking.</div>`;
    return;
  }

  for (const p of profiles) {
    const accent = p.color || '#d8a24a';
    const age = ageFromBirthYear(p.birthYear);
    const latest = latestByProfile.get(p.id) || null;
    const isActive = p.id === activeId;

    const card = document.createElement('article');
    card.className = 'profile-card' + (isActive ? ' is-active' : '');
    card.style.setProperty('--accent', accent);
    card.innerHTML = `
      ${isActive ? '<span class="active-flag">active</span>' : ''}
      <div class="profile-avatar" style="background:${accent}">${initials(p.name)}</div>
      <h4>${escapeHtml(p.name)}</h4>
      <div class="profile-meta">${p.sex || '—'} · ${age != null ? age + ' yrs' : 'age ?'} · ${p.heightCm ? p.heightCm + ' cm' : 'height ?'}</div>
      <div class="profile-stats">
        <div><span class="s-val">${latest ? kg(latest.weightKg).replace(' kg', '') : '—'}</span><span class="s-lbl">kg</span></div>
        <div><span class="s-val">${latest && latest.bodyFatPct != null ? latest.bodyFatPct.toFixed(1) : '—'}</span><span class="s-lbl">fat %</span></div>
        <div><span class="s-val">${latest && latest.smmKg != null ? latest.smmKg.toFixed(1) : '—'}</span><span class="s-lbl">muscle</span></div>
      </div>
      <div class="profile-actions">
        ${isActive ? '' : '<button class="mini-btn" data-act="activate">Set active</button>'}
        <button class="mini-btn" data-act="edit">Edit</button>
        <button class="mini-btn danger" data-act="delete">Delete</button>
      </div>`;

    card.querySelector('[data-act="activate"]')?.addEventListener('click', () => handlers.onActivate(p.id));
    card.querySelector('[data-act="edit"]').addEventListener('click', () => handlers.onEdit(p));
    card.querySelector('[data-act="delete"]').addEventListener('click', () => handlers.onDelete(p));
    gridEl.appendChild(card);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
