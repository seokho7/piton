'use strict';

const STORAGE_KEY = 'lm_scripts';

// In-memory cache: avoids async storage read on every tab event
let _scriptCache = null;
// Compiled regex cache: avoids re-compiling the same pattern strings
const patternCache = new Map();

async function getScripts() {
  if (_scriptCache !== null) return _scriptCache;
  const r = await chrome.storage.local.get(STORAGE_KEY);
  _scriptCache = r[STORAGE_KEY] ?? [];
  return _scriptCache;
}

// Keep cache in sync when storage changes (e.g. editor saves)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && STORAGE_KEY in changes) {
    _scriptCache = changes[STORAGE_KEY].newValue ?? [];
  }
});

function matchPattern(pattern, url) {
  if (!pattern || !url) return false;
  let re = patternCache.get(pattern);
  if (re === undefined) {
    try {
      re = new RegExp(
        '^' +
        pattern
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*/g, '.*')
          .replace(/\?/g, '.') +
        '$',
        'i'
      );
    } catch {
      re = null;
    }
    patternCache.set(pattern, re);
  }
  return re ? re.test(url) : false;
}

function scriptMatchesUrl(script, url) {
  return (script.matches ?? []).some(p => matchPattern(p, url));
}

// Track injected scripts per tab to avoid duplicates within same page load
const injected = new Set();

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const url = tab.url || tab.pendingUrl;
  if (!url || /^(chrome|chrome-extension|about|data|blob|javascript):/.test(url)) return;

  // Clear injection cache on new navigation
  if (changeInfo.status === 'loading') {
    for (const key of [...injected]) {
      if (key.startsWith(`${tabId}:`)) injected.delete(key);
    }
  }

  const scripts = await getScripts();
  updateBadge(tabId, url, scripts);

  for (const script of scripts) {
    if (!script.enabled) continue;
    if (!scriptMatchesUrl(script, url)) continue;

    const runAt = script.runAt || 'document_end';
    const key = `${tabId}:${script.id}`;

    const shouldInject =
      (runAt === 'document_start' && changeInfo.status === 'loading') ||
      ((runAt === 'document_end' || runAt === 'document_idle') && changeInfo.status === 'complete');

    if (!shouldInject || injected.has(key)) continue;
    injected.add(key);

    const runCode = script.code.replace(
      /\/\/ ==UserScript==([\s\S]*?)\/\/ ==\/UserScript==\n?/, ''
    );
    chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (code) => {
        const s = document.createElement('script');
        s.textContent = code;
        (document.head || document.documentElement).appendChild(s);
        s.remove();
      },
      args: [runCode],
      injectImmediately: runAt === 'document_start',
    }).catch(e => {
      console.error(`[piton] inject "${script.name}":`, e.message);
    });
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url) return;
    const scripts = await getScripts();
    updateBadge(tabId, tab.url, scripts);
  } catch {}
});

function updateBadge(tabId, url, scripts) {
  if (!url || /^(chrome|chrome-extension|about):/.test(url)) {
    chrome.action.setBadgeText({ text: '', tabId }).catch(() => {});
    return;
  }
  const count = scripts.filter(s => s.enabled && scriptMatchesUrl(s, url)).length;
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : '', tabId }).catch(() => {});
  if (count > 0) {
    chrome.action.setBadgeBackgroundColor({ color: '#3fb950', tabId }).catch(() => {});
  }
}

// Keep service worker alive — MV3 terminates idle workers after ~30s
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'keepalive') getScripts();
});
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'GET_ACTIVE_SCRIPTS') {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.url) return sendResponse({ url: '', count: 0 });
        const scripts = await getScripts();
        const count = scripts.filter(s => s.enabled && scriptMatchesUrl(s, tab.url)).length;
        sendResponse({ url: tab.url, count });
      } catch {
        sendResponse({ url: '', count: 0 });
      }
    })();
    return true;
  }

  if (msg.type === 'INJECT_NOW') {
    (async () => {
      try {
        _scriptCache = null; // scripts just changed — force fresh read
        const scripts = await getScripts();
        const script  = scripts.find(s => s.id === msg.scriptId);
        if (!script || !script.enabled) { sendResponse({}); return; }

        const runCode = script.code.replace(
          /\/\/ ==UserScript==([\s\S]*?)\/\/ ==\/UserScript==\n?/, ''
        );

        // Clear stale injected keys for this script so updates re-inject
        for (const key of [...injected]) {
          if (key.endsWith(`:${script.id}`)) injected.delete(key);
        }

        const tabs = await chrome.tabs.query({});
        for (const tab of tabs) {
          const url = tab.url;
          if (!url || /^(chrome|chrome-extension|about|data|blob):/.test(url)) continue;
          if (!scriptMatchesUrl(script, url)) continue;

          injected.add(`${tab.id}:${script.id}`);
          chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world:  'MAIN',
            func: (code) => {
              const s = document.createElement('script');
              s.textContent = code;
              (document.head || document.documentElement).appendChild(s);
              s.remove();
            },
            args: [runCode],
            injectImmediately: true,
          }).catch(e => {
            console.error(`[piton] INJECT_NOW "${script.name}":`, e.message);
          });
        }
        sendResponse({});
      } catch (e) {
        sendResponse({});
      }
    })();
    return true;
  }
});
