'use strict';

const STORAGE_KEY = 'lm_scripts';

let _cache = null;

async function load() {
  if (_cache !== null) return _cache;
  const r = await chrome.storage.local.get(STORAGE_KEY);
  _cache = r[STORAGE_KEY] ?? [];
  return _cache;
}

async function save(scripts) {
  _cache = scripts;
  await chrome.storage.local.set({ [STORAGE_KEY]: scripts });
}

function uid() {
  return crypto.randomUUID ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function openEditor(id) {
  const base = chrome.runtime.getURL('editor/editor.html');
  const url  = id ? `${base}?id=${id}` : base;
  chrome.tabs.create({ url });
}

// Extract readable host from a @match pattern
function hostFromPattern(pattern) {
  try {
    const noScheme = pattern.replace(/^[^:]+:\/\//, '');
    return noScheme.split('/')[0] || pattern;
  } catch {
    return pattern;
  }
}

// Group scripts by unique host derived from their matches array
function groupByHost(scripts) {
  const groups = new Map(); // host → Set of script ids (to avoid dups)
  const scriptMap = new Map(scripts.map(s => [s.id, s]));

  for (const s of scripts) {
    const patterns = s.matches ?? [];
    if (patterns.length === 0) {
      const key = '(no match pattern)';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s.id);
    } else {
      const seen = new Set();
      for (const p of patterns) {
        const host = hostFromPattern(p);
        if (seen.has(host)) continue;
        seen.add(host);
        if (!groups.has(host)) groups.set(host, []);
        groups.get(host).push(s.id);
      }
    }
  }

  // Sort: named hosts first, then (no match)
  const sorted = [...groups.entries()].sort(([a], [b]) => {
    if (a.startsWith('(')) return 1;
    if (b.startsWith('(')) return -1;
    return a.localeCompare(b);
  });

  return { sorted, scriptMap };
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, c =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'
  );
}

function renderGroup(host, ids, scriptMap, query) {
  const scripts = ids.map(id => scriptMap.get(id)).filter(Boolean);

  const filtered = query
    ? scripts.filter(s =>
        (s.name || '').toLowerCase().includes(query) ||
        (s.matches || []).some(m => m.toLowerCase().includes(query))
      )
    : scripts;

  if (filtered.length === 0) return null;

  const group = document.createElement('div');
  group.className = 'site-group';

  group.innerHTML = `
    <div class="site-header">
      <span class="site-host">${esc(host)}</span>
      <span class="site-count">${filtered.length}</span>
    </div>
  `;

  for (const script of filtered) {
    const row = document.createElement('div');
    row.className = `script-row${script.enabled === false ? ' off' : ''}`;
    row.dataset.id = script.id;

    const patternPreview = (script.matches ?? []).slice(0, 2).join(', ');

    row.innerHTML = `
      <label class="toggle" title="${script.enabled === false ? 'Enable' : 'Disable'}">
        <input type="checkbox" ${script.enabled !== false ? 'checked' : ''}>
        <span class="track"></span>
        <span class="thumb"></span>
      </label>
      <span class="script-name">${esc(script.name || 'Unnamed Script')}</span>
      <span class="script-patterns" title="${esc((script.matches ?? []).join(', '))}">${esc(patternPreview)}</span>
      <div class="row-actions">
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

    row.querySelector('input[type="checkbox"]').addEventListener('change', async e => {
      const scripts = await load();
      const idx = scripts.findIndex(s => s.id === script.id);
      if (idx !== -1) {
        scripts[idx].enabled = e.target.checked;
        await save(scripts);
        row.classList.toggle('off', !e.target.checked);
      }
    });

    row.querySelector('.edit').addEventListener('click', () => openEditor(script.id));

    row.querySelector('.del').addEventListener('click', async () => {
      const scripts = await load();
      await save(scripts.filter(s => s.id !== script.id));
      refresh();
    });

    group.appendChild(row);
  }

  return group;
}

async function refresh() {
  const scripts  = await load();
  const query    = document.getElementById('search').value.toLowerCase().trim();
  const content  = document.getElementById('content');
  const empty    = document.getElementById('empty');

  content.innerHTML = '';

  if (scripts.length === 0) {
    empty.classList.add('show');
    return;
  }
  empty.classList.remove('show');

  const { sorted, scriptMap } = groupByHost(scripts);
  let anyRendered = false;

  for (const [host, ids] of sorted) {
    const group = renderGroup(host, ids, scriptMap, query);
    if (group) { content.appendChild(group); anyRendered = true; }
  }

  if (!anyRendered) {
    content.innerHTML = `<p style="padding:40px 0;text-align:center;color:var(--text3)">No matches for "${esc(query)}"</p>`;
  }
}

// ── Init ───────────────────────────────────────────────────────────
document.getElementById('btn-back').addEventListener('click', () => window.close());
document.getElementById('btn-new').addEventListener('click', () => openEditor());
document.getElementById('btn-empty').addEventListener('click', () => openEditor());
document.getElementById('search').addEventListener('input', refresh);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && STORAGE_KEY in changes) {
    _cache = changes[STORAGE_KEY].newValue ?? [];
    refresh();
  }
});

refresh();
