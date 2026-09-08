'use strict';

// Shared storage layer for extension pages and the service worker.
// Script metadata stays small and hot; source code is fetched only when needed.
globalThis.PitonStorage = (() => {
  const LEGACY_KEY = 'lm_scripts';
  const INDEX_KEY = 'piton_script_index_v1';
  const CODE_PREFIX = 'piton_script_code_v1:';

  let metadataCache = null;
  let loadPromise = null;
  let metadataRevision = 0;
  const listeners = new Set();
  const codeCache = new Map();

  const codeKey = id => `${CODE_PREFIX}${id}`;

  function withoutCode(script) {
    const { code: _code, ...metadata } = script;
    return metadata;
  }

  function cacheMetadata(metadata) {
    metadataCache = metadata;
    return metadata;
  }

  async function migrateLegacy() {
    const revision = metadataRevision;
    const stored = await chrome.storage.local.get([INDEX_KEY, LEGACY_KEY]);
    if (revision !== metadataRevision) return metadataCache;

    if (Array.isArray(stored[INDEX_KEY])) {
      return cacheMetadata(stored[INDEX_KEY]);
    }

    const legacy = Array.isArray(stored[LEGACY_KEY]) ? stored[LEGACY_KEY] : [];
    const metadata = legacy.map(withoutCode);
    const sources = {};

    for (const script of legacy) {
      if (script?.id) {
        const code = script.code ?? '';
        sources[codeKey(script.id)] = code;
        codeCache.set(script.id, code);
      }
    }

    // Sources first, index second, legacy removal last: interrupted migration
    // always retains either the old complete record or the new complete record.
    if (Object.keys(sources).length) await chrome.storage.local.set(sources);
    await chrome.storage.local.set({ [INDEX_KEY]: metadata });
    cacheMetadata(metadata);
    if (LEGACY_KEY in stored) await chrome.storage.local.remove(LEGACY_KEY);

    return metadata;
  }

  async function listMetadata() {
    if (metadataCache !== null) return metadataCache;
    if (loadPromise) return loadPromise;

    loadPromise = (async () => {
      // Read only the small index. A session cache adds another IPC round trip
      // and can be stale after a write in another extension page.
      const revision = metadataRevision;
      const stored = await chrome.storage.local.get(INDEX_KEY);
      if (revision !== metadataRevision) return metadataCache;
      if (Array.isArray(stored[INDEX_KEY])) return cacheMetadata(stored[INDEX_KEY]);
      return migrateLegacy();
    })();

    try {
      return await loadPromise;
    } finally {
      loadPromise = null;
    }
  }

  async function writeMetadata(metadata) {
    await chrome.storage.local.set({ [INDEX_KEY]: metadata });
    cacheMetadata(metadata);
    return metadata;
  }

  async function freshMetadata() {
    await listMetadata();
    const stored = await chrome.storage.local.get(INDEX_KEY);
    return Array.isArray(stored[INDEX_KEY]) ? stored[INDEX_KEY] : [];
  }

  async function getScript(id) {
    const metadata = await listMetadata();
    const found = metadata.find(script => script.id === id);
    if (!found) return null;
    if (codeCache.has(id)) return { ...found, code: codeCache.get(id) };
    const stored = await chrome.storage.local.get(codeKey(id));
    const code = stored[codeKey(id)] ?? '';
    codeCache.set(id, code);
    return { ...found, code };
  }

  async function listScripts() {
    const metadata = await listMetadata();
    if (!metadata.length) return [];
    const keys = metadata.map(script => codeKey(script.id));
    const sources = await chrome.storage.local.get(keys);
    return metadata.map(script => {
      const code = sources[codeKey(script.id)] ?? '';
      codeCache.set(script.id, code);
      return { ...script, code };
    });
  }

  async function put(script) {
    if (!script?.id) throw new Error('Script id is required');

    const metadata = await freshMetadata();
    const index = metadata.findIndex(item => item.id === script.id);
    const previous = index === -1 ? {} : metadata[index];
    const nextMetadata = { ...previous, ...withoutCode(script) };
    const next = index === -1
      ? [...metadata, nextMetadata]
      : metadata.map((item, i) => i === index ? nextMetadata : item);

    if ('code' in script) {
      const code = script.code ?? '';
      await chrome.storage.local.set({ [codeKey(script.id)]: code });
      codeCache.set(script.id, code);
    }
    await writeMetadata(next);
    return { ...nextMetadata, code: script.code };
  }

  async function putMany(scripts) {
    if (!scripts.length) return listMetadata();
    const metadata = await freshMetadata();
    const byId = new Map(metadata.map(script => [script.id, script]));
    const sources = {};

    for (const script of scripts) {
      if (!script?.id) throw new Error('Script id is required');
      byId.set(script.id, { ...(byId.get(script.id) || {}), ...withoutCode(script) });
      if ('code' in script) {
        const code = script.code ?? '';
        sources[codeKey(script.id)] = code;
        codeCache.set(script.id, code);
      }
    }

    if (Object.keys(sources).length) await chrome.storage.local.set(sources);
    return writeMetadata([...byId.values()]);
  }

  async function setEnabled(id, enabled) {
    const metadata = await freshMetadata();
    let changed = false;
    const next = metadata.map(script => {
      if (script.id !== id) return script;
      changed = true;
      return { ...script, enabled };
    });
    if (changed) await writeMetadata(next);
    return changed;
  }

  async function remove(id) {
    const metadata = await freshMetadata();
    const next = metadata.filter(script => script.id !== id);
    if (next.length === metadata.length) return false;
    await writeMetadata(next);
    await chrome.storage.local.remove(codeKey(id));
    codeCache.delete(id);
    return true;
  }

  function notify(metadata) {
    for (const listener of listeners) listener(metadata);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [key, change] of Object.entries(changes)) {
      if (!key.startsWith(CODE_PREFIX)) continue;
      const id = key.slice(CODE_PREFIX.length);
      if (change.newValue === undefined) codeCache.delete(id);
      else codeCache.set(id, change.newValue);
    }
    if (!(INDEX_KEY in changes)) return;
    metadataRevision += 1;
    const metadata = Array.isArray(changes[INDEX_KEY].newValue)
      ? changes[INDEX_KEY].newValue
      : [];
    cacheMetadata(metadata);
    notify(metadata);
  });

  return Object.freeze({
    INDEX_KEY,
    codeKey,
    listMetadata,
    listScripts,
    getScript,
    put,
    putMany,
    setEnabled,
    remove,
    onMetadataChanged(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
})();
