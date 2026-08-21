'use strict';

(() => {
  const HEARTBEAT_MS = 20_000;
  const RETRY_MS = 1_000;
  let port = null;
  let heartbeatTimer = null;
  let retryTimer = null;

  function clearTimers() {
    clearTimeout(heartbeatTimer);
    clearTimeout(retryTimer);
    heartbeatTimer = null;
    retryTimer = null;
  }

  function disconnect() {
    clearTimers();
    if (!port) return;
    const current = port;
    port = null;
    try { current.disconnect(); } catch {}
  }

  function scheduleHeartbeat() {
    heartbeatTimer = setTimeout(() => {
      if (!port || document.visibilityState !== 'visible') return;
      try {
        port.postMessage('ping');
        scheduleHeartbeat();
      } catch {
        disconnect();
        scheduleRetry();
      }
    }, HEARTBEAT_MS);
  }

  function scheduleRetry() {
    if (document.visibilityState !== 'visible' || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, RETRY_MS);
  }

  function connect() {
    if (port || document.visibilityState !== 'visible') return;
    try {
      port = chrome.runtime.connect({ name: 'piton-keepalive' });
      port.onDisconnect.addListener(() => {
        port = null;
        clearTimers();
        scheduleRetry();
      });
      port.postMessage('ping');
      scheduleHeartbeat();
    } catch {
      port = null;
      scheduleRetry();
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') connect();
    else disconnect();
  });

  connect();
})();
