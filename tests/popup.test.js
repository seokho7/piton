'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const metadata = [{
  id: 'one', name: 'One', enabled: true, matches: ['*://example.com/*'],
}];
const tab = { id: 1, windowId: 1, url: 'https://example.com/' };
const flush = () => new Promise(setImmediate);

function element() {
  const classes = new Set();
  return {
    value: '', textContent: '', dataset: {}, children: [], attributes: {},
    classList: {
      add(name) { classes.add(name); },
      remove(name) { classes.delete(name); },
      toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); },
      contains(name) { return classes.has(name); },
    },
    addEventListener() {},
    setAttribute(name, value) { this.attributes[name] = value; },
    appendChild(child) { this.children.push(child); },
    replaceChildren(fragment) { this.children = fragment?.children || []; },
  };
}

function openPopup({ query = async () => [tab], sessionGet = async () => ({}),
  localGet = async () => ({ piton_script_index_v1: metadata }) } = {}) {
  const elements = new Map();
  const storageListeners = [];
  const reads = [];
  const context = vm.createContext({
    console, URL, setTimeout, clearTimeout,
    performance: { mark() {}, measure() {}, now: () => 0 },
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
      },
      createElement: element,
      createDocumentFragment: element,
    },
    chrome: {
      tabs: { query },
      storage: {
        local: {
          get(keys) { reads.push(keys); return localGet(keys); },
          async set() {}, async remove() {},
        },
        session: { get: sessionGet, async set() {} },
        onChanged: { addListener(listener) { storageListeners.push(listener); } },
      },
    },
  });
  for (const file of ['shared/storage.js', 'popup/popup.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context);
  }
  return {
    elements, reads,
    changeMetadata(value) {
      for (const listener of storageListeners) {
        listener({ piton_script_index_v1: { newValue: value } }, 'local');
      }
    },
  };
}

test('renders scripts even when optional session storage never responds', async () => {
  const { elements } = openPopup({ sessionGet: () => new Promise(() => {}) });
  await flush();
  assert.equal(elements.get('list-wrap')?.attributes['aria-busy'], 'false');
  assert.equal(elements.get('script-list').children[0].dataset.id, 'one');
  assert.equal(elements.get('page-host').textContent, 'example.com');
});

test('starts metadata loading while the active tab query is pending', async () => {
  let resolveTab;
  const { elements, reads } = openPopup({
    query: () => new Promise(resolve => { resolveTab = resolve; }),
  });
  await flush();
  assert.ok(reads.includes('piton_script_index_v1'));
  resolveTab([tab]);
  await flush();
  assert.equal(elements.get('script-list').children.length, 1);
});

test('ignores an obsolete popup snapshot for the same tab and URL', async () => {
  const { elements } = openPopup({
    sessionGet: async () => ({
      piton_popup_snapshots_v1: {
        1: { tabId: 1, url: tab.url, host: 'example.com', total: 0, activeCount: 0, scripts: [] },
      },
    }),
  });
  await flush();
  assert.equal(elements.get('script-list').children.length, 1);
});

test('preserves metadata changes received before the active tab is available', async () => {
  let resolveTab;
  const popup = openPopup({ query: () => new Promise(resolve => { resolveTab = resolve; }) });
  await flush();
  popup.changeMetadata([]);
  resolveTab([tab]);
  await flush();
  assert.equal(popup.elements.get('script-list').children.length, 0);
  assert.equal(popup.elements.get('footer-info').textContent, '0 total · 0 here');
});

test('updates the open list after a script is deleted', async () => {
  const popup = openPopup();
  await flush();
  popup.changeMetadata([]);
  assert.equal(popup.elements.get('script-list').children.length, 0);
  assert.equal(popup.elements.get('empty').classList.contains('show'), true);
});
