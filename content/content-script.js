/**
 * content-script.js
 * ChatFlow content script for WhatsApp Web and Facebook Messenger.
 * Runs on https://web.whatsapp.com/*, https://www.messenger.com/*, https://www.facebook.com/messages/*
 * MV3 content scripts dynamically import scanner modules via chrome.runtime.getURL.
 * READ-ONLY: never sends messages, never clicks chats, never modifies user content.
 *
 * Scan protocol (the panel drives every transition; nothing starts counting on its own):
 *   LOAD_HISTORY   -> Phase 1 (loads history, no counting). Responds when Phase 1 ends ("ready").
 *   STOP_LOADING   -> ends Phase 1 early (goes to "ready", never counts)
 *   START_READING  -> Phase 2 + 3 (the ONLY pass that counts). Responds with the result.
 *   CANCEL_SCAN    -> discards everything
 *   SESSION_STATUS -> { state } so the panel can detect reloads/resets
 */

(() => {
  // Active scan session (persists between "Ready to scan" and "Start scan")
  let session = null;
  let scannerModule = null;

  const BUSY_STATES = new Set(['loading', 'reading', 'preparing']);

  async function loadScanner() {
    if (!scannerModule) {
      scannerModule = await import(chrome.runtime.getURL('content/scanner.js'));
    }
    return scannerModule;
  }

  function sendProgress(payload) {
    chrome.runtime.sendMessage({ type: 'SCAN_PROGRESS', payload }).catch(() => {});
  }

  function discardSession() {
    if (session) {
      try { session.cancel(); } catch (_) {}
    }
    session = null;
  }

  // ─── Message Router ──────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.type) {
      case 'PING':
        sendResponse({ ok: true, url: location.href });
        break;

      case 'LOAD_HISTORY':
        handleLoadHistory(sendResponse);
        return true; // async

      case 'START_SCAN':
        handleLegacyStartScan(msg.options || {}, sendResponse);
        return true; // async

      case 'STOP_LOADING':
      case 'FINALIZE_SCAN': // legacy alias: no longer starts counting
        handleStopLoading(sendResponse);
        return true; // async

      case 'START_READING':
        handleStartReading(msg.options || {}, sendResponse);
        return true; // async

      case 'CANCEL_SCAN':
        discardSession();
        sendResponse({ ok: true });
        break;

      case 'SESSION_STATUS':
        sendResponse({ ok: true, state: session ? session.state : 'none', url: location.href });
        break;

      case 'RUN_HEALTHCHECK':
        handleHealthCheck(sendResponse);
        return true; // async

      case 'VERIFY_SCAN':
        handleVerifyScan(msg.masterList, sendResponse);
        return true; // async

      default:
        sendResponse({ error: 'Unknown message type' });
    }
  });

  // ─── Handlers ────────────────────────────────────────────────────────────────

  async function handleLoadHistory(sendResponse) {
    try {
      const mod = await loadScanner();
      if (!session || session.cancelled || session.state === 'done') {
        session = mod.createSession(sendProgress);
      }
      if (BUSY_STATES.has(session.state)) {
        if (session.state === 'loading') {
          try { session.stopLoading(); } catch (_) {}
        } else {
          sendResponse({ ok: false, error: 'A scan step is already running.' });
          return;
        }
      }
      const mySession = session;
      const info = await mySession.loadHistory();
      sendResponse({ ok: true, state: 'ready', ...info, chatName: mySession.chatName, platform: mySession.adapter?.name });
    } catch (err) {
      if (err.message === 'CANCELLED') {
        sendResponse({ ok: false, cancelled: true });
      } else {
        sendResponse({ ok: false, error: err.message });
      }
    }
  }

  async function handleStopLoading(sendResponse) {
    try {
      if (session) {
        const snap = session.stopLoading();
        sendResponse({
          ok: true,
          status: 'phase1_stopped',
          state: 'ready',
          ...snap,
          chatName: session.chatName,
          platform: session.adapter?.name
        });
        return;
      }
      // If STOP_LOADING arrived when no active session existed, create a passive ready session
      const mod = await loadScanner();
      session = mod.createSession(sendProgress);
      session._init();
      session.beginningReached = false;
      session.endReason = 'user_stop';
      session._enterReady();
      sendResponse({
        ok: true,
        status: 'phase1_stopped',
        state: 'ready',
        ...session.readySnapshot(),
        chatName: session.chatName,
        platform: session.adapter?.name
      });
    } catch (err) {
      sendResponse({
        ok: true,
        status: 'phase1_stopped',
        state: 'ready',
        beginningReached: false,
        reason: 'user_stop',
        oldestDate: null,
        warning: err.message
      });
    }
  }

  async function handleStartReading(options, sendResponse) {
    try {
      const mod = await loadScanner();
      if (!session || session.cancelled) {
        session = mod.createSession(sendProgress);
        session._init();
        session.beginningReached = false;
        session.endReason = 'user_stop';
        session.state = 'ready';
      }
      if (session.state === 'loading') {
        session.stopLoading();
      }
      const mySession = session;
      const result = await mySession.startReading(options);
      session = null;
      sendResponse({ ok: true, payload: result });
    } catch (err) {
      session = null;
      if (err.message === 'CANCELLED') {
        sendResponse({ ok: false, cancelled: true });
      } else {
        sendResponse({ ok: false, error: err.message });
      }
    }
  }

  async function handleLegacyStartScan(options, sendResponse) {
    try {
      const mod = await loadScanner();
      if (!session || session.cancelled || session.state === 'done') {
        session = mod.createSession(sendProgress);
      }
      const mySession = session;
      await mySession.loadHistory();
      const result = await mySession.startReading(options);
      session = null;
      sendResponse({ ok: true, payload: result });
    } catch (err) {
      session = null;
      if (err.message === 'CANCELLED') {
        sendResponse({ ok: false, cancelled: true });
      } else {
        sendResponse({ ok: false, error: err.message });
      }
    }
  }

  async function handleVerifyScan(masterList, sendResponse) {
    try {
      const { getAdapter } = await import(chrome.runtime.getURL('content/adapters/index.js'));
      const adapter = getAdapter(window.location.href);
      if (!adapter) {
        sendResponse({ ok: false, error: 'Unsupported platform' });
        return;
      }
      const container = adapter.getScrollContainer(document);
      if (!container) {
        sendResponse({ ok: false, error: 'Scroll container not found' });
        return;
      }
      const { verifyScan } = await import(chrome.runtime.getURL('content/scanner.js'));
      const result = await verifyScan(container, masterList);
      sendResponse({ ok: true, result });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  }

  async function handleHealthCheck(sendResponse) {
    try {
      const { getAdapter } = await import(chrome.runtime.getURL('content/adapters/index.js'));
      const adapter = getAdapter(window.location.href);
      if (!adapter) {
        sendResponse({ ok: false, error: 'Unsupported platform' });
        return;
      }
      const health = adapter.healthCheck(document);
      const chatName = adapter.getChatName(document);
      sendResponse({ ok: true, health, chatName, platform: adapter.name });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  }

  // ─── Instant Chat Switch & Rename Observer ─────────────────────────────────
  let lastReportedChatName = '';
  let switchDebounceTimer = null;

  function notifyChatChange() {
    // Never interrupt an active step. In "Ready to scan" a chat switch resets to idle.
    if (session && BUSY_STATES.has(session.state)) return;
    if (switchDebounceTimer) clearTimeout(switchDebounceTimer);

    switchDebounceTimer = setTimeout(async () => {
      try {
        const { getAdapter } = await import(chrome.runtime.getURL('content/adapters/index.js'));
        const adapter = getAdapter(window.location.href);
        if (!adapter) return;

        const currentName = adapter.getChatName(document);
        if (currentName &&
            currentName !== lastReportedChatName &&
            currentName !== 'Messenger chat' &&
            currentName !== 'WhatsApp chat' &&
            currentName !== 'Unknown Chat') {
          const switched = lastReportedChatName !== '';
          lastReportedChatName = currentName;
          if (switched && session && session.state === 'ready' && session.chatName !== currentName) {
            discardSession();
          }
          chrome.runtime.sendMessage({
            type: 'CHAT_CHANGED',
            payload: { chatName: currentName, platform: adapter.name }
          }).catch(() => {});
        }
      } catch (_) {}
    }, 280);
  }

  window.addEventListener('popstate', notifyChatChange);
  window.addEventListener('hashchange', notifyChatChange);

  // Observe title element for conversation navigation / rename
  const titleEl = document.querySelector('title');
  if (titleEl) {
    new MutationObserver(notifyChatChange).observe(titleEl, { childList: true, characterData: true, subtree: true });
  }

  // Fallback observer on main or body
  const bodyObserver = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.target && m.target.nodeType === 1) {
        const tag = m.target.tagName;
        if (tag === 'HEADER' || tag === 'H1' || tag === 'H2' || m.target.getAttribute?.('role') === 'heading') {
          notifyChatChange();
          break;
        }
      }
    }
  });

  if (document.body) {
    bodyObserver.observe(document.body, { childList: true, subtree: true });
  }
})();
