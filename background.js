'use strict';

importScripts('shared/storage.js');

// Compiled regex cache: avoids re-compiling the same pattern strings
const patternCache = new Map();

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

function popupData(url, scripts) {
  let host = '—';
  if (url) {
    try { host = new URL(url).hostname || url.slice(0, 40); }
    catch { host = url.slice(0, 40); }
  }
  return {
    url,
    host,
    total: scripts.length,
    activeCount: scripts.filter(s => s.enabled && scriptMatchesUrl(s, url)).length,
    scripts: url ? scripts.filter(s => scriptMatchesHost(s, url)) : [],
  };
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

  const scripts = await PitonStorage.listMetadata();
  updateBadge(tabId, url, scripts);

  const pending = [];
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
    pending.push(PitonStorage.getScript(script.id).then(fullScript => {
      if (!fullScript) return;
      const runCode = fullScript.code.replace(
        /\/\/ ==UserScript==([\s\S]*?)\/\/ ==\/UserScript==\n?/, ''
      );
      return chrome.scripting.executeScript({
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
    }));
  }
  await Promise.all(pending);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url) return;
    const scripts = await PitonStorage.listMetadata();
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

// Warm the metadata cache at Chrome's minimum recurring alarm interval.
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'keepalive') PitonStorage.listMetadata();
});
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'GET_POPUP_DATA') {
    (async () => {
      try {
        const [[tab], scripts] = await Promise.all([
          chrome.tabs.query({ active: true, currentWindow: true }),
          PitonStorage.listMetadata(),
        ]);
        sendResponse(popupData(tab?.url || '', scripts));
      } catch {
        sendResponse(popupData('', []));
      }
    })();
    return true;
  }

  if (msg.type === 'GET_ACTIVE_SCRIPTS') {
    (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab?.url) return sendResponse({ url: '', count: 0 });
        const scripts = await PitonStorage.listMetadata();
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
        const script = await PitonStorage.getScript(msg.scriptId);
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
