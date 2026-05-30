'use strict';

const STORAGE_KEY = 'lm_scripts';

// ── Storage ────────────────────────────────────────────────────────
async function load() {
  const r = await chrome.storage.local.get(STORAGE_KEY);
  return r[STORAGE_KEY] ?? [];
}

async function save(scripts) {
  await chrome.storage.local.set({ [STORAGE_KEY]: scripts });
}

function uid() {
  return (crypto.randomUUID ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2));
}

// ── URL matching (mirrors background.js) ──────────────────────────
function matchPattern(pattern, url) {
  if (!pattern || !url) return false;
  try {
    const re = new RegExp(
      '^' +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.') +
      '$',
      'i'
    );
    return re.test(url);
  } catch { return false; }
}

function scriptMatches(script, url) {
  return (script.matches ?? []).some(p => matchPattern(p, url));
}

// ── DOM helpers ────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

let toastTimer;
function toast(msg, ms = 2200) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function openEditor(id) {
  const base = chrome.runtime.getURL('editor/editor.html');
  let url = id ? `${base}?id=${id}` : base;

  if (!id) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.url && !/^(chrome|chrome-extension|about):/.test(tab.url)) {
        url += `?tabUrl=${encodeURIComponent(tab.url)}`;
      }
    } catch {}
  }

  chrome.tabs.create({ url });
  window.close();
}

// ── Render card ────────────────────────────────────────────────────
function renderCard(script, currentUrl) {
  const isMatch = currentUrl && scriptMatches(script, currentUrl);

  const card = document.createElement('div');
  card.className = `card${script.enabled ? '' : ' off'}${isMatch ? ' matched' : ''}`;
  card.dataset.id = script.id;

  // Tags
  const tags = (script.matches ?? []);
  const tagHtml = tags.slice(0, 2).map(t =>
    `<span class="tag" title="${esc(t)}">${esc(t)}</span>`
  ).join('');
  const moreHtml = tags.length > 2
    ? `<span class="tag-more">+${tags.length - 2}</span>` : '';

  card.innerHTML = `
    <div class="card-body">
      <div class="card-name">${esc(script.name || 'Unnamed Script')}</div>
      <div class="card-tags">${tagHtml}${moreHtml}</div>
    </div>
    <div class="card-actions">
      <label class="toggle" title="${script.enabled ? 'Disable' : 'Enable'}">
        <input type="checkbox" ${script.enabled ? 'checked' : ''}>
        <span class="track"></span>
        <span class="thumb"></span>
      </label>
      <button class="icon-btn edit" title="Edit">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
          <path d="M11.013 1.427a1.75 1.75 0 012.474 0l1.086 1.086a1.75 1.75 0 010 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 01-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61zm1.414 1.06a.25.25 0 00-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 000-.354l-1.086-1.086zM11.189 6.25L9.75 4.81l-6.286 6.287a.25.25 0 00-.064.108l-.558 1.953 1.953-.558a.249.249 0 00.108-.064l6.286-6.286z"/>
        </svg>
      </button>
      <button class="icon-btn del" title="Delete">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
          <path d="M11 1.75V3h2.25a.75.75 0 010 1.5H2.75a.75.75 0 010-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75zM4.496 6.675l.66 6.6a.25.25 0 00.249.225h5.19a.25.25 0 00.249-.225l.66-6.6a.75.75 0 011.492.149l-.66 6.6A1.748 1.748 0 0110.595 15h-5.19a1.75 1.75 0 01-1.741-1.575l-.66-6.6a.75.75 0 011.492-.15zM6.5 1.75V3h3V1.75a.25.25 0 00-.25-.25h-2.5a.25.25 0 00-.25.25z"/>
        </svg>
      </button>
    </div>
  `;

  // Toggle
  card.querySelector('input[type="checkbox"]').addEventListener('change', async e => {
    const scripts = await load();
    const idx = scripts.findIndex(s => s.id === script.id);
    if (idx !== -1) {
      scripts[idx].enabled = e.target.checked;
      await save(scripts);
      card.classList.toggle('off', !e.target.checked);
      await refreshPageBar();
    }
  });

  // Edit
  card.querySelector('.edit').addEventListener('click', () => openEditor(script.id));

  // Delete
  card.querySelector('.del').addEventListener('click', async () => {
    const scripts = await load();
    await save(scripts.filter(s => s.id !== script.id));
    await refresh();
    toast('Script deleted');
  });

  return card;
}

// ── Page bar ───────────────────────────────────────────────────────
let currentUrl = '';

async function refreshPageBar() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentUrl = tab?.url || '';
    let host = '—';
    if (currentUrl) {
      try { host = new URL(currentUrl).hostname || currentUrl.slice(0, 40); }
      catch { host = currentUrl.slice(0, 40); }
    }
    $('page-host').textContent = host;

    const scripts = await load();
    const count = scripts.filter(s => s.enabled && scriptMatches(s, currentUrl)).length;
    $('active-count').textContent = count;
    $('page-pill').classList.toggle('lit', count > 0);
  } catch {}
}

// ── Main render ────────────────────────────────────────────────────
async function refresh() {
  const scripts = await load();
  const query   = $('search').value.toLowerCase().trim();

  // Only show scripts that match the current site
  const siteScripts = currentUrl
    ? scripts.filter(s => scriptMatches(s, currentUrl))
    : [];

  const filtered = siteScripts.filter(s =>
    !query ||
    (s.name || '').toLowerCase().includes(query) ||
    (s.description || '').toLowerCase().includes(query) ||
    (s.matches || []).some(m => m.toLowerCase().includes(query))
  );

  const list  = $('script-list');
  const empty = $('empty');

  list.innerHTML = '';

  if (filtered.length === 0) {
    empty.classList.add('show');
  } else {
    empty.classList.remove('show');
    filtered.forEach(s => list.appendChild(renderCard(s, currentUrl)));
  }

  const total = scripts.length;
  $('footer-info').textContent = `${total} total · ${siteScripts.length} here`;
}

// ── Import / Export ────────────────────────────────────────────────
async function doExport() {
  const scripts = await load();
  if (!scripts.length) { toast('Nothing to export'); return; }
  const blob = new Blob([JSON.stringify(scripts, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), {
    href: url,
    download: `piton-${new Date().toISOString().slice(0,10)}.json`,
  });
  a.click();
  URL.revokeObjectURL(url);
}

async function doImport(file) {
  try {
    const raw      = await file.text();
    const imported = JSON.parse(raw);
    if (!Array.isArray(imported)) throw new Error('Expected JSON array');

    const existing = await load();
    const existIds = new Set(existing.map(s => s.id));
    let added = 0;

    for (const s of imported) {
      if (!s.name || !s.code) continue;
      if (s.id && existIds.has(s.id)) continue;
      existing.push({ ...s, id: uid(), importedAt: Date.now() });
      added++;
    }

    await save(existing);
    await refresh();
    toast(`Imported ${added} script${added !== 1 ? 's' : ''}`);
  } catch(e) {
    toast(`Import failed: ${e.message}`);
  }
}

// ── Event bindings ─────────────────────────────────────────────────
$('btn-dashboard').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
  window.close();
});
$('btn-new').addEventListener('click', () => openEditor());
$('search').addEventListener('input', refresh);
$('btn-export').addEventListener('click', doExport);
$('btn-import').addEventListener('click', () => $('file-import').click());
$('file-import').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (f) await doImport(f);
  e.target.value = '';
});

// Sync when storage changes (e.g. editor saves)
chrome.storage.onChanged.addListener(changes => {
  if (changes[STORAGE_KEY]) refresh();
});

// ── Init ───────────────────────────────────────────────────────────
(async () => {
  await refreshPageBar();
  await refresh();
})();
