'use strict';

performance.mark('piton-popup-start');

const $ = id => document.getElementById(id);
const patternCache = new Map();

let currentUrl = '';
let state = { url: '', host: '—', total: 0, activeCount: 0, scripts: [] };
let toastTimer;

function uid() {
  return crypto.randomUUID ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function esc(value) {
  return String(value).replace(/[&<>"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  })[char]);
}

function matchPattern(pattern, url) {
  if (!pattern || !url) return false;
  let regex = patternCache.get(pattern);
  if (regex === undefined) {
    try {
      regex = new RegExp(
        '^' + pattern
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')
          .replace(/\?/g, '.') + '$',
        'i'
      );
    } catch {
      regex = null;
    }
    patternCache.set(pattern, regex);
  }
  return regex ? regex.test(url) : false;
}

function scriptMatches(script, url) {
  return (script.matches ?? []).some(pattern => matchPattern(pattern, url));
}

function hostFromPattern(pattern) {
  const noScheme = pattern.replace(/^[^:]+:\/\//, '');
  return noScheme.split('/')[0] || pattern;
}

function scriptMatchesHost(script, url) {
  if (!url) return false;
  let host;
  try { host = new URL(url).hostname; } catch { return false; }
  return (script.matches ?? []).some(pattern => {
    const patternHost = hostFromPattern(pattern);
    if (patternHost === '*') return true;
    const clean = patternHost.replace(/^\*\./, '');
    return host === clean || host.endsWith(`.${clean}`);
  });
}

function makePopupData(url, scripts) {
  let host = '—';
  if (url) {
    try { host = new URL(url).hostname || url.slice(0, 40); }
    catch { host = url.slice(0, 40); }
  }
  return {
    url,
    host,
    total: scripts.length,
    activeCount: scripts.filter(script => script.enabled && scriptMatches(script, url)).length,
    scripts: url ? scripts.filter(script => scriptMatchesHost(script, url)) : [],
  };
}

async function timedRequest(name, request) {
  const start = performance.now();
  try {
    return await request;
  } finally {
    performance.measure(name, { start, end: performance.now() });
  }
}

async function requestPopupData() {
  // Start both required reads immediately. Optional caches must never block
  // the first render or hide changes made since the last popup was opened.
  const [[tab], scripts] = await Promise.all([
    timedRequest('piton-popup-tab', chrome.tabs.query({ active: true, currentWindow: true })),
    timedRequest('piton-popup-metadata', PitonStorage.listMetadata()),
  ]);
  return makePopupData(tab?.url || tab?.pendingUrl || '', scripts);
}

function toast(message, ms = 2200) {
  const element = $('toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove('show'), ms);
}

async function openEditor(id) {
  const base = chrome.runtime.getURL('editor/editor.html');
  let url = id ? `${base}?id=${id}` : base;

  if (!id && currentUrl && !/^(chrome|chrome-extension|about):/.test(currentUrl)) {
    url += `?tabUrl=${encodeURIComponent(currentUrl)}`;
  }

  await chrome.tabs.create({ url });
  window.close();
}

function cardElement(script) {
  const card = document.createElement('div');
  const matched = scriptMatches(script, currentUrl);
  const tags = script.matches ?? [];
  const tagHtml = tags.slice(0, 2).map(tag =>
    `<span class="tag" title="${esc(tag)}">${esc(tag)}</span>`
  ).join('');
  const moreHtml = tags.length > 2
    ? `<span class="tag-more">+${tags.length - 2}</span>`
    : '';

  card.className = `card${script.enabled ? '' : ' off'}${matched ? ' matched' : ''}`;
  card.dataset.id = script.id;
  card.innerHTML = `
    <div class="card-body">
      <div class="card-name">${esc(script.name || 'Unnamed Script')}</div>
      <div class="card-tags">${tagHtml}${moreHtml}</div>
    </div>
    <div class="card-actions">
      <label class="toggle" title="${script.enabled ? 'Disable' : 'Enable'}">
        <input type="checkbox" ${script.enabled ? 'checked' : ''} aria-label="Toggle script">
        <span class="track"></span>
        <span class="thumb"></span>
      </label>
      <button class="icon-btn edit" title="Edit" aria-label="Edit script">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
          <path d="M11.013 1.427a1.75 1.75 0 012.474 0l1.086 1.086a1.75 1.75 0 010 2.474l-8.61 8.61c-.21.21-.47.364-.756.445l-3.251.93a.75.75 0 01-.927-.928l.929-3.25c.081-.286.235-.547.445-.758l8.61-8.61zm1.414 1.06a.25.25 0 00-.354 0L10.811 3.75l1.439 1.44 1.263-1.263a.25.25 0 000-.354l-1.086-1.086zM11.189 6.25L9.75 4.81l-6.286 6.287a.25.25 0 00-.064.108l-.558 1.953 1.953-.558a.249.249 0 00.108-.064l6.286-6.286z"/>
        </svg>
      </button>
      <button class="icon-btn del" title="Delete" aria-label="Delete script">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="currentColor">
          <path d="M11 1.75V3h2.25a.75.75 0 010 1.5H2.75a.75.75 0 010-1.5H5V1.75C5 .784 5.784 0 6.75 0h2.5C10.216 0 11 .784 11 1.75zM4.496 6.675l.66 6.6a.25.25 0 00.249.225h5.19a.25.25 0 00.249-.225l.66-6.6a.75.75 0 011.492.149l-.66 6.6A1.748 1.748 0 0110.595 15h-5.19a1.75 1.75 0 01-1.741-1.575l-.66-6.6a.75.75 0 011.492-.15zM6.5 1.75V3h3V1.75a.25.25 0 00-.25-.25h-2.5a.25.25 0 00-.25.25z"/>
        </svg>
      </button>
    </div>`;
  return card;
}

function render() {
  const query = $('search').value.toLowerCase().trim();
  const filtered = state.scripts.filter(script =>
    !query ||
    (script.name || '').toLowerCase().includes(query) ||
    (script.description || '').toLowerCase().includes(query) ||
    (script.matches || []).some(match => match.toLowerCase().includes(query))
  );

  const fragment = document.createDocumentFragment();
  for (const script of filtered) fragment.appendChild(cardElement(script));
  $('script-list').replaceChildren(fragment);
  $('empty').classList.toggle('show', filtered.length === 0);
  $('list-wrap').setAttribute('aria-busy', 'false');

  $('page-host').textContent = state.host;
  $('active-count').textContent = state.activeCount;
  $('page-pill').classList.toggle('lit', state.activeCount > 0);
  $('footer-info').textContent = `${state.total} total · ${state.scripts.length} here`;
}

function applyMetadata(metadata) {
  state = makePopupData(currentUrl, metadata);
  render();
}

async function doExport() {
  const scripts = await PitonStorage.listScripts();
  if (!scripts.length) { toast('Nothing to export'); return; }
  const blob = new Blob([JSON.stringify(scripts, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = Object.assign(document.createElement('a'), {
    href: url,
    download: `piton-${new Date().toISOString().slice(0, 10)}.json`,
  });
  anchor.click();
  URL.revokeObjectURL(url);
}

async function doImport(file) {
  try {
    const imported = JSON.parse(await file.text());
    if (!Array.isArray(imported)) throw new Error('Expected JSON array');

    const existing = await PitonStorage.listMetadata();
    const existingIds = new Set(existing.map(script => script.id));
    const additions = [];

    for (const script of imported) {
      if (!script.name || !script.code) continue;
      if (script.id && existingIds.has(script.id)) continue;
      const id = uid();
      existingIds.add(id);
      additions.push({ ...script, id, importedAt: Date.now() });
    }

    await PitonStorage.putMany(additions);
    toast(`Imported ${additions.length} script${additions.length !== 1 ? 's' : ''}`);
  } catch (error) {
    toast(`Import failed: ${error.message}`);
  }
}

$('btn-dashboard').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard/dashboard.html') });
  window.close();
});
$('btn-new').addEventListener('click', () => openEditor());
$('search').addEventListener('input', render);
$('btn-export').addEventListener('click', doExport);
$('btn-import').addEventListener('click', () => $('file-import').click());
$('file-import').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (file) await doImport(file);
  event.target.value = '';
});

$('script-list').addEventListener('change', async event => {
  if (!event.target.matches('input[type="checkbox"]')) return;
  const card = event.target.closest('.card');
  const script = state.scripts.find(item => item.id === card?.dataset.id);
  if (!script) return;

  const enabled = event.target.checked;
  script.enabled = enabled;
  card.classList.toggle('off', !enabled);
  state.activeCount = state.scripts.filter(item => item.enabled && scriptMatches(item, currentUrl)).length;
  $('active-count').textContent = state.activeCount;
  $('page-pill').classList.toggle('lit', state.activeCount > 0);

  try {
    await PitonStorage.setEnabled(script.id, enabled);
  } catch (error) {
    event.target.checked = !enabled;
    script.enabled = !enabled;
    card.classList.toggle('off', enabled);
    toast(`Save failed: ${error.message}`);
  }
});

$('script-list').addEventListener('click', async event => {
  const button = event.target.closest('button');
  const card = event.target.closest('.card');
  if (!button || !card) return;
  if (button.classList.contains('edit')) return openEditor(card.dataset.id);
  if (button.classList.contains('del')) {
    await PitonStorage.remove(card.dataset.id);
    toast('Script deleted');
  }
});

(async () => {
  let latestMetadata;
  let initialized = false;
  PitonStorage.onMetadataChanged(metadata => {
    latestMetadata = metadata;
    if (initialized) applyMetadata(metadata);
  });
  state = await requestPopupData();
  currentUrl = state.url;
  if (latestMetadata !== undefined) state = makePopupData(currentUrl, latestMetadata);
  initialized = true;
  render();
  performance.mark('piton-popup-ready');
  performance.measure('piton-popup-init', 'piton-popup-start', 'piton-popup-ready');
  performance.measure('piton-popup-navigation-to-ready', { start: 0, end: 'piton-popup-ready' });
})().catch(error => {
  $('list-wrap').setAttribute('aria-busy', 'false');
  $('script-list').replaceChildren();
  $('empty').classList.add('show');
  toast(`Load failed: ${error.message}`);
});
