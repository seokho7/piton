'use strict';

const STORAGE_KEY = 'lm_scripts';

const DEFAULT_CODE = `(function () {
  'use strict';

  // Your code here

})();
`;

// ── DOM ────────────────────────────────────────────────────────────
const editor    = document.getElementById('editor');
const hlLayer   = document.getElementById('hl-layer');
const lnCol     = document.getElementById('ln-col');
const codeCol   = document.getElementById('code-col');
const btnSave   = document.getElementById('btn-save');
const btnBack   = document.getElementById('btn-back');
const btnRun    = document.getElementById('btn-run');
const chkEnabled= document.getElementById('chk-enabled');
const tlTitle   = document.getElementById('tl-title');
const dirtyDot  = document.getElementById('dirty-dot');
const sbCursor  = document.getElementById('sb-cursor');
const sbMatches = document.getElementById('sb-matches');
const sbSaved   = document.getElementById('sb-saved');
const notif     = document.getElementById('notif');

// ── Meta panel DOM ─────────────────────────────────────────────────
const metaName   = document.getElementById('meta-name');
const metaDesc   = document.getElementById('meta-description');
const metaMatch  = document.getElementById('meta-match');
const metaRunAt  = document.getElementById('meta-run-at');
const META_FIELD_ELS = [metaName, metaDesc, metaMatch, metaRunAt];

// ── State ──────────────────────────────────────────────────────────
let scriptId  = null;
let dirty     = false;
let curLineEl = null;
let hlRaf     = null;

// ── Storage ────────────────────────────────────────────────────────
async function loadAll() {
  const r = await chrome.storage.local.get(STORAGE_KEY);
  return r[STORAGE_KEY] ?? [];
}
async function saveAll(scripts) {
  await chrome.storage.local.set({ [STORAGE_KEY]: scripts });
}
function uid() {
  return crypto.randomUUID ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

// ── Metadata parser ────────────────────────────────────────────────
function parseMeta(code) {
  const m = {
    name: '', namespace: '', version: '', description: '', author: '',
    matches: [], runAt: 'document_end', grant: 'none',
  };
  const hMatch = code.match(/\/\/ ==UserScript==([\s\S]*?)\/\/ ==\/UserScript==/);
  if (!hMatch) return m;
  const re = /\/\/ @(\S+)\s+(.*)/g;
  let hit;
  while ((hit = re.exec(hMatch[1])) !== null) {
    const [, k, v] = hit;
    const val = v.trim();
    switch (k.toLowerCase()) {
      case 'name':        m.name = val; break;
      case 'namespace':   m.namespace = val; break;
      case 'version':     m.version = val; break;
      case 'description': m.description = val; break;
      case 'author':      m.author = val; break;
      case 'match':
      case 'include':     m.matches.push(val); break;
      case 'run-at':      m.runAt = val.replace(/-/g, '_'); m.runAtRaw = val; break;
      case 'grant':       m.grant = val; break;
    }
  }
  return m;
}

// ── Syntax highlighter ─────────────────────────────────────────────
const KW = new Set([
  'break','case','catch','class','const','continue','debugger','default','delete',
  'do','else','export','extends','finally','for','function','if','import','in',
  'instanceof','let','new','of','return','static','super','switch','this','throw',
  'try','typeof','var','void','while','with','yield','async','await',
  'null','undefined','true','false','NaN','Infinity',
]);

function esc(s) {
  return s.replace(/[&<>]/g, c => c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;');
}

function highlight(code) {
  const out = [];
  let i = 0;
  const len = code.length;

  while (i < len) {
    const cc = code.charCodeAt(i);

    // '/' — single-line or multi-line comment
    if (cc === 47) {
      const nx = code.charCodeAt(i + 1);
      if (nx === 47) { // '//'
        let j = i;
        while (j < len && code.charCodeAt(j) !== 10) j++;
        const line = code.slice(i, j);
        const isMeta = line.includes('// @') || line.includes('UserScript==');
        out.push(`<span class="${isMeta ? 'meta' : 'cmt'}">${esc(line)}</span>`);
        i = j;
        continue;
      }
      if (nx === 42) { // '/*'
        let j = i + 2;
        while (j < len - 1 && !(code.charCodeAt(j) === 42 && code.charCodeAt(j + 1) === 47)) j++;
        j = Math.min(j + 2, len);
        out.push(`<span class="cmt">${esc(code.slice(i, j))}</span>`);
        i = j;
        continue;
      }
    }

    // Template literal '`' = 96
    if (cc === 96) {
      let j = i + 1;
      while (j < len && code.charCodeAt(j) !== 96) { if (code.charCodeAt(j) === 92) j++; j++; }
      j = Math.min(j + 1, len);
      out.push(`<span class="str">${esc(code.slice(i, j))}</span>`);
      i = j;
      continue;
    }

    // Double-quote '"' = 34
    if (cc === 34) {
      let j = i + 1;
      while (j < len && code.charCodeAt(j) !== 34 && code.charCodeAt(j) !== 10) { if (code.charCodeAt(j) === 92) j++; j++; }
      j = Math.min(j + 1, len);
      out.push(`<span class="str">${esc(code.slice(i, j))}</span>`);
      i = j;
      continue;
    }

    // Single-quote "'" = 39
    if (cc === 39) {
      let j = i + 1;
      while (j < len && code.charCodeAt(j) !== 39 && code.charCodeAt(j) !== 10) { if (code.charCodeAt(j) === 92) j++; j++; }
      j = Math.min(j + 1, len);
      out.push(`<span class="str">${esc(code.slice(i, j))}</span>`);
      i = j;
      continue;
    }

    // Identifier / keyword: [a-zA-Z_$]
    // (cc|32) maps A-Z → a-z for a single range check
    if ((cc | 32) >= 97 && (cc | 32) <= 122 || cc === 95 || cc === 36) {
      let j = i;
      while (j < len) {
        const d = code.charCodeAt(j);
        if (!((d | 32) >= 97 && (d | 32) <= 122 || d >= 48 && d <= 57 || d === 95 || d === 36)) break;
        j++;
      }
      const word = code.slice(i, j);
      out.push(KW.has(word) ? `<span class="kw">${esc(word)}</span>` : esc(word));
      i = j;
      continue;
    }

    // Number: [0-9] or '.' followed by digit
    const c2cc = code.charCodeAt(i + 1);
    if (cc >= 48 && cc <= 57 || cc === 46 && c2cc >= 48 && c2cc <= 57) {
      let j = i;
      // 0x / 0b / 0o prefix: (c2cc|32) → x=120 b=98 o=111
      if (cc === 48 && ((c2cc | 32) === 120 || (c2cc | 32) === 98 || (c2cc | 32) === 111)) {
        j += 2;
        while (j < len) {
          const d = code.charCodeAt(j);
          if (!((d | 32) >= 97 && (d | 32) <= 102 || d >= 48 && d <= 57 || d === 95)) break;
          j++;
        }
      } else {
        while (j < len) {
          const d = code.charCodeAt(j);
          if (!(d >= 48 && d <= 57 || d === 46 || d === 95)) break;
          j++;
        }
        if (j < len && (code.charCodeAt(j) | 32) === 101) { // e/E
          j++;
          if (j < len && (code.charCodeAt(j) === 43 || code.charCodeAt(j) === 45)) j++; // +/-
          while (j < len && code.charCodeAt(j) >= 48 && code.charCodeAt(j) <= 57) j++;
        }
        if (j < len && code.charCodeAt(j) === 110) j++; // BigInt n
      }
      out.push(`<span class="num">${esc(code.slice(i, j))}</span>`);
      i = j;
      continue;
    }

    out.push(esc(code[i]));
    i++;
  }

  return out.join('');
}

// ── Editor sync ────────────────────────────────────────────────────
function syncHighlight() {
  hlLayer.innerHTML = highlight(editor.value) + '\n';
  // Keep textarea sized to match the pre layer so scrolling works correctly
  const h = hlLayer.scrollHeight;
  const w = hlLayer.scrollWidth;
  editor.style.height  = h + 'px';
  editor.style.minWidth = w + 'px';
}

function syncLineNumbers() {
  const val      = editor.value;
  const selStart = editor.selectionStart;

  // Count lines via charCode — no split('\n') array allocation
  let total = 1, curLine = 1;
  for (let i = 0; i < val.length; i++) {
    if (val.charCodeAt(i) === 10) {
      total++;
      if (i < selStart) curLine++;
    }
  }

  if (lnCol.childElementCount !== total) {
    // Full rebuild using pre-allocated array — no per-iteration concat
    const parts = new Array(total);
    for (let i = 0; i < total; i++) {
      parts[i] = i + 1 === curLine
        ? `<span class="cur">${i + 1}</span>`
        : `<span>${i + 1}</span>`;
    }
    lnCol.innerHTML = parts.join('');
    curLineEl = lnCol.children[curLine - 1] || null;
  } else {
    // O(1): swap class on cached element only
    if (curLineEl) curLineEl.classList.remove('cur');
    curLineEl = lnCol.children[curLine - 1] || null;
    if (curLineEl) curLineEl.classList.add('cur');
  }

  lnCol.scrollTop = codeCol.scrollTop;
}

function syncCursor() {
  const val      = editor.value;
  const selStart = editor.selectionStart;
  // Charcode scan — no slice + split('\n') allocation
  let line = 1, lastNl = -1;
  for (let i = 0; i < selStart; i++) {
    if (val.charCodeAt(i) === 10) { line++; lastNl = i; }
  }
  sbCursor.textContent = `Ln ${line}, Col ${selStart - lastNl}`;
}

function populateMetaInputs(meta) {
  metaName.value  = meta.name;
  metaDesc.value  = meta.description;
  metaMatch.value = meta.matches.join(', ');
  metaRunAt.value = (meta.runAtRaw || meta.runAt.replace(/_/g, '-')) || 'document-end';
}

function buildHeader() {
  const name    = metaName.value.trim() || 'New Script';
  const desc    = metaDesc.value.trim();
  const matches = metaMatch.value.split(',').map(s => s.trim()).filter(Boolean);
  const runAt   = metaRunAt.value || 'document-end';
  return [
    '// ==UserScript==',
    `// @name         ${name}`,
    `// @description  ${desc}`,
    ...(matches.length ? matches.map(m => `// @match        ${m}`) : ['// @match        *://example.com/*']),
    `// @run-at       ${runAt}`,
    '// ==/UserScript==',
  ].join('\n');
}

function fullCode() {
  return buildHeader() + '\n\n' + editor.value.trim();
}

function syncMeta() {
  const name = metaName.value.trim() || 'New Script';
  tlTitle.textContent   = name;
  document.title        = `${name} — piton`;
  const n = metaMatch.value.split(',').map(s => s.trim()).filter(Boolean).length;
  sbMatches.textContent = `${n} match${n !== 1 ? 'es' : ''}`;
}

function onMetaChange() {
  syncMeta();
  markDirty();
}

function markDirty() {
  if (!dirty) {
    dirty = true;
    dirtyDot.classList.add('show');
    sbSaved.className = 'sb-unsaved';
    sbSaved.innerHTML = `<svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="5"/></svg> Unsaved`;
  }
}

function markClean() {
  dirty = false;
  dirtyDot.classList.remove('show');
  sbSaved.className = 'sb-saved';
  sbSaved.innerHTML = `<svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor"><path d="M13.78 4.22a.75.75 0 010 1.06l-7.25 7.25a.75.75 0 01-1.06 0L2.22 9.28a.75.75 0 011.06-1.06L6 10.94l6.72-6.72a.75.75 0 011.06 0z"/></svg> Saved`;
}

function fullSync() {
  if (hlRaf) { cancelAnimationFrame(hlRaf); hlRaf = null; }
  syncHighlight();
  syncLineNumbers();
  syncCursor();
  syncMeta();
}

// ── Smart editing ──────────────────────────────────────────────────
const PAIRS = { '(':')', '[':']', '{':'}', '"':'"', "'":"'" };

editor.addEventListener('keydown', e => {
  const { selectionStart: s, selectionEnd: end } = editor;
  const val = editor.value;

  // Ctrl/Cmd+S → save
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    doSave();
    return;
  }

  // Tab key
  if (e.key === 'Tab') {
    e.preventDefault();
    if (s === end) {
      insert('  ');
    } else {
      const sel = val.slice(s, end);
      const lines = sel.split('\n');
      const replacement = e.shiftKey
        ? lines.map(l => l.startsWith('  ') ? l.slice(2) : l.replace(/^\t/, ''))
        : lines.map(l => '  ' + l);
      const newText = replacement.join('\n');
      editor.value = val.slice(0, s) + newText + val.slice(end);
      editor.selectionStart = s;
      editor.selectionEnd   = s + newText.length;
      onEdit();
    }
    return;
  }

  // Auto-close brackets & quotes
  if (PAIRS[e.key] && s === end && !e.ctrlKey && !e.metaKey) {
    const next = val[s];
    if (!next || /[\s)}\]'"]/.test(next)) {
      e.preventDefault();
      editor.value = val.slice(0, s) + e.key + PAIRS[e.key] + val.slice(end);
      editor.selectionStart = editor.selectionEnd = s + 1;
      onEdit();
      return;
    }
  }

  // Skip over matching closing char
  if (Object.values(PAIRS).includes(e.key) && val[s] === e.key && s === end) {
    e.preventDefault();
    editor.selectionStart = editor.selectionEnd = s + 1;
    return;
  }

  // Enter: preserve indent + extra for {[(
  if (e.key === 'Enter') {
    const lineStart = val.lastIndexOf('\n', s - 1) + 1;
    const curLine   = val.slice(lineStart, s);
    const indent    = curLine.match(/^(\s*)/)[1];
    const lastCh    = curLine.trimEnd().slice(-1);
    const extra     = '{[('.includes(lastCh) ? '  ' : '';

    if (indent || extra) {
      e.preventDefault();
      const nl = '\n' + indent + extra;
      editor.value = val.slice(0, s) + nl + val.slice(end);
      editor.selectionStart = editor.selectionEnd = s + nl.length;
      onEdit();
    }
  }
});

function insert(text) {
  const { selectionStart: s, selectionEnd: e_ } = editor;
  const val = editor.value;
  editor.value = val.slice(0, s) + text + val.slice(e_);
  editor.selectionStart = editor.selectionEnd = s + text.length;
  onEdit();
}

function onEdit() {
  syncCursor();
  syncLineNumbers();
  markDirty();
  if (hlRaf) cancelAnimationFrame(hlRaf);
  hlRaf = requestAnimationFrame(() => { syncHighlight(); hlRaf = null; });
}

editor.addEventListener('input', onEdit);

function syncScroll() {
  hlLayer.style.transform =
    `translate(-${codeCol.scrollLeft}px, -${codeCol.scrollTop}px)`;
  lnCol.scrollTop = codeCol.scrollTop;
}
editor.addEventListener('scroll', syncScroll);
codeCol.addEventListener('scroll', syncScroll);

editor.addEventListener('click',  syncCursor);
editor.addEventListener('keyup',  e => {
  if (/^Arrow|Home|End|Page/.test(e.key)) { syncCursor(); syncLineNumbers(); }
});

// ── Save ────────────────────────────────────────────────────────────
async function doSave() {
  try {
    if (!editor.value.trim()) { notify('Script is empty', 'err'); return; }

    const name    = metaName.value.trim() || 'New Script';
    const desc    = metaDesc.value.trim();
    const matches = metaMatch.value.split(',').map(s => s.trim()).filter(Boolean);
    const runAt   = metaRunAt.value.replace(/-/g, '_') || 'document_end';
    const code    = fullCode();
    const scripts = await loadAll();

    const entry = (base = {}) => ({
      ...base,
      name, description: desc, matches, runAt,
      code, enabled: chkEnabled.checked,
      updatedAt: Date.now(),
    });

    if (scriptId) {
      const idx = scripts.findIndex(s => s.id === scriptId);
      if (idx !== -1) {
        scripts[idx] = entry(scripts[idx]);
      } else {
        scripts.push(entry({ id: scriptId, createdAt: Date.now() }));
      }
    } else {
      scriptId = uid();
      scripts.push(entry({ id: scriptId, createdAt: Date.now() }));
      history.replaceState(null, '', `?id=${scriptId}`);
    }

    await saveAll(scripts);
    markClean();
    notify('Saved!', 'ok');

    chrome.runtime.sendMessage({ type: 'INJECT_NOW', scriptId }).catch(() => {});
  } catch (err) {
    notify(`Save failed: ${err.message}`, 'err');
    console.error('[piton] doSave error:', err);
  }
}

// ── Run on active tab ───────────────────────────────────────────────
async function doRun() {
  if (!editor.value.trim()) { notify('Nothing to run', 'err'); return; }

  try {
    const allTabs = await chrome.tabs.query({});
    const tab = allTabs
      .filter(t => t.url && !/^(chrome|chrome-extension):/.test(t.url))
      .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
    if (!tab) { notify('No valid tab found', 'err'); return; }

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world:  'MAIN',
      func:   (c) => {
        const s = document.createElement('script');
        s.textContent = c;
        (document.head || document.documentElement).appendChild(s);
        s.remove();
      },
      args: [editor.value],
    });
    notify('Executed on tab!', 'ok');
  } catch(e) {
    notify(`Error: ${e.message}`, 'err');
  }
}

// ── Notify ──────────────────────────────────────────────────────────
let notifTimer;
function notify(msg, type = '') {
  notif.textContent = msg;
  notif.className = `notif show${type ? ' ' + type : ''}`;
  clearTimeout(notifTimer);
  notifTimer = setTimeout(() => notif.classList.remove('show'), 2600);
}

// ── Init ────────────────────────────────────────────────────────────
const HEADER_RE = /\/\/ ==UserScript==([\s\S]*?)\/\/ ==\/UserScript==\n?/;

function stripHeader(code) {
  return code.replace(HEADER_RE, '').trimStart();
}

function setDefaultMeta(matchOverride) {
  metaName.value  = '';
  metaDesc.value  = '';
  metaMatch.value = matchOverride || '*://example.com/*';
  metaRunAt.value = 'document-end';
}

async function init() {
  const params = new URLSearchParams(location.search);
  const id     = params.get('id');
  const tabUrl = params.get('tabUrl');

  if (id) {
    scriptId = id;
    const scripts = await loadAll();
    const found   = scripts.find(s => s.id === id);
    if (found) {
      populateMetaInputs(parseMeta(found.code || ''));
      editor.value       = stripHeader(found.code || '') || DEFAULT_CODE;
      chkEnabled.checked = found.enabled !== false;
    } else {
      setDefaultMeta();
      editor.value = DEFAULT_CODE;
      notify('Script not found — starting fresh', 'err');
      scriptId = null;
    }
  } else {
    let matchOverride;
    if (tabUrl) {
      try { matchOverride = `*://${new URL(tabUrl).hostname}/*`; } catch {}
    }
    setDefaultMeta(matchOverride);
    editor.value = DEFAULT_CODE;
  }

  fullSync();
  markClean();
  editor.focus();
  editor.selectionStart = editor.selectionEnd = 0;
}

// ── Bindings ────────────────────────────────────────────────────────
btnSave.addEventListener('click', doSave);
btnRun .addEventListener('click', doRun);
btnBack.addEventListener('click', () => window.close());

[metaName, metaDesc, metaMatch].forEach(el =>
  el.addEventListener('input', onMetaChange)
);
metaRunAt.addEventListener('change', onMetaChange);

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    doSave();
  }
});

window.addEventListener('beforeunload', e => {
  if (dirty) { e.preventDefault(); e.returnValue = ''; }
});

init();
