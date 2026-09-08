'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.join(__dirname, '..', 'shared', 'storage.js'),
  'utf8'
);

function createStorage(initialLocal = {}, initialSession = {}) {
  const stores = {
    local: { ...initialLocal },
    session: { ...initialSession },
  };
  const listeners = [];
  const reads = [];

  function area(name) {
    return {
      async get(keys) {
        reads.push({ area: name, keys });
        if (keys == null) return { ...stores[name] };
        const selected = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(
          selected.filter(key => key in stores[name]).map(key => [key, stores[name][key]])
        );
      },
      async set(values) {
        const changes = {};
        for (const [key, value] of Object.entries(values)) {
          changes[key] = { oldValue: stores[name][key], newValue: value };
          stores[name][key] = value;
        }
        for (const listener of listeners) listener(changes, name);
      },
      async remove(keys) {
        const selected = Array.isArray(keys) ? keys : [keys];
        const changes = {};
        for (const key of selected) {
          if (!(key in stores[name])) continue;
          changes[key] = { oldValue: stores[name][key], newValue: undefined };
          delete stores[name][key];
        }
        for (const listener of listeners) listener(changes, name);
      },
    };
  }

  const context = vm.createContext({
    chrome: {
      storage: {
        local: area('local'),
        session: area('session'),
        onChanged: { addListener(listener) { listeners.push(listener); } },
      },
    },
    console,
  });
  vm.runInContext(source, context);
  return { api: context.PitonStorage, stores, chrome: context.chrome, reads };
}

test('migrates legacy scripts without losing source code', async () => {
  const legacy = [{
    id: 'one',
    name: 'One',
    matches: ['*://example.com/*'],
    enabled: true,
    code: 'console.log(1)',
  }];
  const { api, stores } = createStorage({ lm_scripts: legacy });

  const metadata = await api.listMetadata();
  assert.equal(metadata.length, 1);
  assert.equal('code' in metadata[0], false);
  assert.equal(stores.local.lm_scripts, undefined);
  assert.equal(stores.local[api.codeKey('one')], 'console.log(1)');
  assert.equal((await api.getScript('one')).code, 'console.log(1)');
});

test('updates metadata independently and removes source on delete', async () => {
  const indexKey = 'piton_script_index_v1';
  const sessionKey = 'piton_script_index_cache_v1';
  const metadata = [{ id: 'one', name: 'One', enabled: true, matches: [] }];
  const { api, stores } = createStorage(
    {
      [indexKey]: metadata,
      'piton_script_code_v1:one': 'old code',
    },
    { [sessionKey]: metadata }
  );

  await api.setEnabled('one', false);
  assert.equal((await api.getScript('one')).enabled, false);
  assert.equal((await api.getScript('one')).code, 'old code');

  await api.put({ id: 'one', name: 'Renamed', code: 'new code' });
  assert.deepEqual(
    JSON.parse(JSON.stringify(await api.getScript('one'))),
    { id: 'one', name: 'Renamed', enabled: false, matches: [], code: 'new code' }
  );

  await api.remove('one');
  assert.equal(await api.getScript('one'), null);
  assert.equal(stores.local[api.codeKey('one')], undefined);
});

test('metadata loads without waiting for session storage or reading source code', async () => {
  const metadata = [{ id: 'one', name: 'One', matches: [] }];
  const { api, chrome, reads } = createStorage({ piton_script_index_v1: metadata });
  chrome.storage.session.get = () => new Promise(() => {});
  chrome.storage.session.set = () => new Promise(() => {});

  let result;
  api.listMetadata().then(value => { result = value; });
  await new Promise(setImmediate);
  assert.deepEqual(result, metadata);
  assert.deepEqual(reads, [{ area: 'local', keys: 'piton_script_index_v1' }]);
});

test('persistent metadata wins over an obsolete session cache', async () => {
  const { api } = createStorage(
    { piton_script_index_v1: [] },
    { piton_script_index_cache_v1: [{ id: 'deleted', name: 'Deleted' }] }
  );
  assert.equal((await api.listMetadata()).length, 0);
});

test('an in-flight read cannot overwrite a newer storage event', async () => {
  const { api, chrome } = createStorage();
  let resolveRead;
  chrome.storage.local.get = () => new Promise(resolve => { resolveRead = resolve; });
  const loading = api.listMetadata();
  await new Promise(setImmediate);
  const latest = [{ id: 'new', name: 'New' }];
  await chrome.storage.local.set({ piton_script_index_v1: latest });
  resolveRead({ piton_script_index_v1: [] });
  assert.deepEqual(await loading, latest);
  assert.deepEqual(await api.listMetadata(), latest);
});

test('legacy fallback does not replace an index created during its read', async () => {
  const { api, chrome, stores } = createStorage();
  let resolveLegacy;
  chrome.storage.local.get = keys => keys === 'piton_script_index_v1'
    ? Promise.resolve({})
    : new Promise(resolve => { resolveLegacy = resolve; });
  const loading = api.listMetadata();
  await new Promise(setImmediate);
  const latest = [{ id: 'new', name: 'New' }];
  await chrome.storage.local.set({ piton_script_index_v1: latest });
  resolveLegacy({});
  assert.deepEqual(await loading, latest);
  assert.deepEqual(stores.local.piton_script_index_v1, latest);
});
