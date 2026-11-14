/**
 * sidepanel.js
 * ChatFlow Side Panel Dashboard Controller.
 * Supports WhatsApp Web and Facebook Messenger with unified analytics,
 * theme switching, and document exports.
 */

import { buildTxtContent, downloadTxt } from '../lib/exporter-txt.js';
import { exportDocx } from '../lib/exporter-docx.js';
import { exportPdf } from '../lib/exporter-pdf.js';
import {
  DEFAULT_EXPORT_OPTIONS,
  normalizeExportOptions,
  prepareMessagesForExport,
  groupMessagesForExport,
  computeParticipantStats,
  buildStats,
  formatExportTime,
  formatMediaChip,
  formatReplyQuoteParts,
  resolveMyExportName,
  isBlockedUiName,
  validatePersonName,
  cleanReactionsList
} from '../lib/transcript.js';
import { sanitizeChatName, getInitials, isValidConversationDate } from '../content/selectors.js';
import {
  swapSides,
  applySideChoice,
  sampleSides,
  finalizeSenders,
  evaluateConfidence,
  participantWarnings,
  toList,
  formatDirectionDiagnostics
} from '../content/direction.js';
import {
  RELEASE_HIGHLIGHTS,
  CHANGELOG_SUMMARY,
  getExtensionVersion
} from '../src/version.js';
import { runVersionMigrations } from '../background/service-worker.js';

// Fixed participant colors shared across Overview, Participants tab, Export preview, and .docx
const ME_UI_COLOR = '#2DB87A';      // Matches .docx #1B5E3F
const CONTACT_UI_COLOR = '#3B82F6'; // Matches .docx #1D4ED8
const EXTRA_UI_COLORS = ['#9333EA', '#EA580C', '#0D9488', '#E11D48', '#4F46E5', '#CA8A04'];
const STOP_WATCHDOG_MS = 2000;      // Max time "Stop loading" button can stay on "Stopping..."

// ─── App States ───────────────────────────────────────────────────────────────

const AppState = {
  NOT_SUPPORTED: 'not-supported',
  SELECT_CHAT: 'select-chat',
  READY: 'ready',
  SCANNING: 'scanning',
  COMPLETE: 'complete',
  ERROR: 'error'
};

let currentTab = null;
let currentPlatform = 'WhatsApp';
let cachedMessages = null;
let cachedStats = null;
let activeRailTab = 'overview';
let pollTimer = null;
let currentScanPhase = 'idle'; // 'idle' | 'loading' | 'ready' | 'reading' | 'verifying' | 'preparing'
let autoStartEnabled = false;
let thoroughScanEnabled = false;
let hideReadyTip = false;
let pendingExportAction = null; // 'docx' | 'txt' | null when Confirm dialog is opened pre-export
let stopWatchdogTimer = null;

function formatPassDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '0.0s';
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60000) return `${(n / 1000).toFixed(1)}s`;
  const mins = Math.floor(n / 60000);
  const secs = Math.round((n % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

function formatAuditTimings(audit = {}) {
  const hasP1 = typeof audit?.pass1DurationMs === 'number';
  const p1 = hasP1 ? `P1 ${formatPassDuration(audit.pass1DurationMs)}` : '';
  const p2 = audit?.verificationRan
    ? `P2 ${formatPassDuration(audit.pass2DurationMs || 0)}`
    : (hasP1 ? 'P2 skipped' : '');
  return [p1, p2].filter(Boolean).join(' · ') || '-';
}
let recordedErrors = [];
let lastFatalError = null;
let attachedErrorWindow = null;

const $ = id => (typeof document !== 'undefined' ? document.getElementById(id) : null);

function isConnectionLostError(errOrMsg) {
  const msg = typeof errOrMsg === 'string' ? errOrMsg : (errOrMsg?.message || '');
  return /receiving end does not exist|message port closed|extension context invalidated|could not establish connection|could not connect to|content script not responding|no response from|disconnected|lost connection/i.test(msg);
}

function appendDiagnosticsWarning(note) {
  const el = $('diag-direction-log');
  if (!el || !note) return;
  const stamp = new Date().toLocaleTimeString();
  const prev = (el.textContent && el.textContent !== 'No scan yet.') ? `${el.textContent}\n` : '';
  el.textContent = `${prev}[${stamp}] Warning: ${note}`;
}

function recordStepError(step, errOrMsg) {
  const stepName = step || 'unknown';
  const errObj = errOrMsg && typeof errOrMsg === 'object' ? (errOrMsg.error || errOrMsg.reason || errOrMsg) : null;
  const message = errObj?.message || (typeof errOrMsg === 'string' ? errOrMsg : String(errOrMsg || 'Unknown error'));
  const stack = errObj?.stack || (errOrMsg?.filename ? `${errOrMsg.filename}:${errOrMsg.lineno || 0}:${errOrMsg.colno || 0}` : '');
  const entry = {
    timestamp: new Date().toISOString(),
    step: stepName,
    message,
    stack
  };
  recordedErrors.push(entry);
  if (recordedErrors.length > 50) {
    recordedErrors = recordedErrors.slice(-50);
  }

  if (cachedStats && cachedStats.integrity) {
    cachedStats.integrity.checksIncomplete = true;
    cachedStats.integrity.diagnosticsError = message;
    cachedStats.integrity.stepErrors = recordedErrors.slice();
  }

  const stackFirstLine = stack ? `\n  ${stack.split('\n').slice(0, 3).join('\n  ')}` : '';
  appendDiagnosticsWarning(`[${stepName}] ${message}${stackFirstLine}`);
  return entry;
}

function getRecordedErrors() {
  return recordedErrors.slice();
}

function clearRecordedErrors() {
  recordedErrors = [];
  lastFatalError = null;
}

function buildErrorDetailsText(extraError = null) {
  const entries = recordedErrors.slice();
  if (extraError) {
    entries.push({
      timestamp: new Date().toISOString(),
      step: extraError.step || 'fatal',
      message: extraError.message || String(extraError),
      stack: extraError.stack || ''
    });
  } else if (lastFatalError && !entries.some(e => e.message === lastFatalError.message && e.step === lastFatalError.step)) {
    entries.push(lastFatalError);
  }
  const payload = {
    extension: 'ChatFlow',
    version: getExtensionVersion(),
    platform: cachedStats?.platform || currentPlatform,
    chatName: cachedStats?.chatName || '',
    timestamp: new Date().toISOString(),
    errors: entries
  };
  return JSON.stringify(payload, null, 2);
}

async function copyErrorDetails(extraError = null) {
  const details = buildErrorDetailsText(extraError);
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(details);
      showToast('Error details copied');
      return true;
    }
  } catch (_) { }
  showToast('Failed to copy error details');
  return false;
}

function installGlobalErrorHandlers() {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return;
  }
  if (attachedErrorWindow === window) {
    return;
  }
  attachedErrorWindow = window;

  const recoverFromGlobalError = (step, rawEvent) => {
    const entry = recordStepError(step, rawEvent);
    const scanViewVisible = $('state-scanning') && !$('state-scanning').classList.contains('hidden');
    if (scanViewVisible || currentScanPhase === 'reading' || currentScanPhase === 'preparing') {
      currentScanPhase = 'idle';
      if (Array.isArray(cachedMessages) && cachedMessages.length > 0 && cachedStats) {
        try {
          renderCompleteDashboard();
        } catch (_) { }
      } else {
        setState(AppState.ERROR, {
          message: `An unexpected error occurred (${entry.message}).`,
          connectionLost: isConnectionLostError(entry.message),
          errorEntry: entry
        });
      }
    } else if (cachedMessages && cachedMessages.length > 0 && $('state-complete') && !$('state-complete').classList.contains('hidden')) {
      const checksBanner = $('checks-warning-banner');
      if (checksBanner) checksBanner.classList.remove('hidden');
      const checksDesc = $('checks-warning-desc');
      if (checksDesc) checksDesc.textContent = `Some checks could not run (${entry.step}): ${entry.message}`;
    }

    const btnDocx = $('btn-export-docx');
    if (btnDocx && btnDocx.disabled) {
      btnDocx.disabled = false;
      btnDocx.textContent = 'Word (.docx)';
    }
  };

  window.addEventListener('error', (event) => {
    recoverFromGlobalError('window.onerror', event);
  });

  window.addEventListener('unhandledrejection', (event) => {
    recoverFromGlobalError('unhandledrejection', event);
  });
}

// ─── State Switcher ───────────────────────────────────────────────────────────

function setState(state, data = {}) {
  const views = {
    [AppState.NOT_SUPPORTED]: $('state-not-supported'),
    [AppState.SELECT_CHAT]: $('state-select-chat'),
    [AppState.READY]: $('state-ready'),
    [AppState.SCANNING]: $('state-scanning'),
    [AppState.COMPLETE]: $('state-complete'),
    [AppState.ERROR]: $('state-error')
  };

  for (const [key, el] of Object.entries(views)) {
    if (el) el.classList.toggle('hidden', key !== state);
  }

  if (state === AppState.ERROR) {
    const rawMsg = data.message || 'Unable to read conversation.';
    const connLost = !!(data.connectionLost || data.versionMismatch || isConnectionLostError(rawMsg));
    lastFatalError = data.errorEntry || {
      timestamp: new Date().toISOString(),
      step: data.step || 'scan',
      message: rawMsg,
      stack: data.stack || ''
    };
    if ($('error-message')) {
      $('error-message').textContent = data.versionMismatch
        ? rawMsg
        : (connLost
          ? 'Lost connection to the chat page. Refresh the chat tab and try again.'
          : rawMsg);
    }
    const reloadBtn = $('btn-reload-tab');
    const retryBtn = $('btn-retry');
    if (reloadBtn) reloadBtn.classList.toggle('hidden', !connLost);
    if (retryBtn) {
      retryBtn.classList.toggle('btn-outline', connLost);
      retryBtn.classList.toggle('btn-primary', !connLost);
    }
  }

  if (state === AppState.READY && data.chatName) {
    const cleanName = sanitizeChatName(data.chatName);
    $('top-chat-title').textContent = cleanName;
    $('top-avatar').textContent = getInitials(cleanName);
    $('ready-title-text').textContent = `Scan "${cleanName}"`;
    prefillMyNameUi(data.platform || currentPlatform, data.detectedMyName || '');
  } else if (state === AppState.READY) {
    prefillMyNameUi(data.platform || currentPlatform, data.detectedMyName || '');
  }
}

// ─── Rail Navigation Switcher ─────────────────────────────────────────────────

function switchTab(tabId) {
  activeRailTab = tabId;

  const buttons = {
    overview: $('nav-btn-overview'),
    participants: $('nav-btn-participants'),
    export: $('nav-btn-export'),
    settings: $('nav-btn-settings')
  };

  for (const [key, btn] of Object.entries(buttons)) {
    if (btn) {
      btn.classList.toggle('active', key === tabId);
      btn.setAttribute('aria-selected', key === tabId ? 'true' : 'false');
    }
  }

  const panels = {
    overview: $('tab-overview'),
    participants: $('tab-participants'),
    export: $('tab-export'),
    settings: $('tab-settings')
  };

  for (const [key, panel] of Object.entries(panels)) {
    if (panel) {
      panel.classList.toggle('hidden', key !== tabId);
    }
  }
}

// ─── Platform & Tab Discovery ─────────────────────────────────────────────────

function getPlatformFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  if (url.startsWith('https://web.whatsapp.com') || url.startsWith('http://web.whatsapp.com')) {
    return 'WhatsApp';
  }
  if (url.startsWith('https://www.messenger.com') || url.startsWith('http://www.messenger.com') ||
    url.startsWith('https://www.facebook.com/messages') || url.startsWith('http://www.facebook.com/messages')) {
    return 'Messenger';
  }
  return null;
}

// ─── Platform Theme & Action Icon ─────────────────────────────────────────────

function setPlatformTheme(platformName) {
  const platKey = (platformName || '').toLowerCase();
  let themeAttr = 'neutral';
  if (platKey.includes('whatsapp')) {
    themeAttr = 'whatsapp';
  } else if (platKey.includes('messenger')) {
    themeAttr = 'messenger';
  }

  document.documentElement.setAttribute('data-platform', themeAttr);
  updateToolbarIcon(themeAttr);
}

function updateToolbarIcon(platformKey) {
  let folder = 'icons/neutral';
  if (platformKey === 'whatsapp') {
    folder = 'icons/whatsapp';
  } else if (platformKey === 'messenger') {
    folder = 'icons/messenger';
  }

  try {
    chrome.action.setIcon({
      path: {
        16: `../${folder}/icon16.png`,
        32: `../${folder}/icon32.png`,
        48: `../${folder}/icon48.png`,
        128: `../${folder}/icon128.png`
      }
    }).catch(() => { });
  } catch (_) { }
}

/**
 * Robustly find an open WhatsApp or Messenger tab.
 */
async function findSupportedTab() {
  // 1. Check active tab in last focused window
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (getPlatformFromUrl(tab?.url)) return tab;
  } catch (_) { }

  // 2. Check active tab in current window
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (getPlatformFromUrl(tab?.url)) return tab;
  } catch (_) { }

  // 3. Check any active tab in any window
  try {
    const activeTabs = await chrome.tabs.query({ active: true });
    for (const t of activeTabs) {
      if (getPlatformFromUrl(t?.url)) return t;
    }
  } catch (_) { }

  // 4. Query specifically for known platform URLs
  try {
    const waTabs = await chrome.tabs.query({ url: '*://web.whatsapp.com/*' });
    if (waTabs && waTabs.length > 0) {
      const active = waTabs.find(t => t.active);
      return active || waTabs[0];
    }
  } catch (_) { }

  try {
    const msgrTabs = await chrome.tabs.query({ url: ['*://www.messenger.com/*', '*://www.facebook.com/messages/*'] });
    if (msgrTabs && msgrTabs.length > 0) {
      const active = msgrTabs.find(t => t.active);
      return active || msgrTabs[0];
    }
  } catch (_) { }

  // 5. Broad scan across all tabs
  try {
    const all = await chrome.tabs.query({});
    const found = all.find(t => getPlatformFromUrl(t?.url));
    if (found) return found;
  } catch (_) { }

  return null;
}

// ─── Version Management, What's New & Content Script Handshake ───────────────

function syncVersionLabels() {
  const versionText = `ChatFlow v${getExtensionVersion()}`;
  const settingEl = $('setting-ext-version');
  if (settingEl) settingEl.textContent = versionText;
  const footerEl = $('app-footer-version');
  if (footerEl) footerEl.textContent = versionText;
}

function renderSettingsChangelog() {
  const container = $('settings-changelog-content');
  if (!container || typeof document === 'undefined' || typeof document.createElement !== 'function') return;
  container.innerHTML = '';

  const entries = Array.isArray(CHANGELOG_SUMMARY) ? CHANGELOG_SUMMARY : [];
  if (entries.length === 0) {
    container.textContent = `ChatFlow v${getExtensionVersion()}`;
    return;
  }

  for (const rel of entries) {
    const card = document.createElement('div');
    card.className = 'changelog-entry';

    const hdr = document.createElement('div');
    hdr.className = 'changelog-entry-hdr';
    const dateSuffix = rel.date ? ` (${rel.date})` : '';
    hdr.textContent = `v${rel.version}${dateSuffix}`;
    card.appendChild(hdr);

    const sections = Array.isArray(rel.sections) ? rel.sections : [];
    for (const sec of sections.slice(0, 4)) {
      if (!sec.items || sec.items.length === 0) continue;
      const sh = document.createElement('div');
      sh.className = 'changelog-section-hdr';
      sh.textContent = sec.heading;
      card.appendChild(sh);

      const ul = document.createElement('ul');
      ul.className = 'changelog-list';
      for (const item of sec.items.slice(0, 6)) {
        const li = document.createElement('li');
        li.textContent = item;
        ul.appendChild(li);
      }
      card.appendChild(ul);
    }

    container.appendChild(card);
  }
}

function storageLocalGetAsync(keys) {
  if (typeof chrome === 'undefined' || !chrome.storage?.local?.get) {
    return Promise.resolve({});
  }
  return new Promise((resolve) => {
    try {
      const p = chrome.storage.local.get(keys, (res) => resolve(res || {}));
      if (p && typeof p.then === 'function') p.then((res) => resolve(res || {})).catch(() => resolve({}));
    } catch (_) {
      resolve({});
    }
  });
}

function storageLocalSetAsync(patch) {
  if (typeof chrome === 'undefined' || !chrome.storage?.local?.set) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    try {
      const p = chrome.storage.local.set(patch, () => resolve());
      if (p && typeof p.then === 'function') p.then(() => resolve()).catch(() => resolve());
    } catch (_) {
      resolve();
    }
  });
}

async function checkAndRenderWhatsNew(hooks = {}) {
  const card = $('whats-new-card');
  if (!card) return false;
  try {
    const currentVer = getExtensionVersion();
    const res = hooks.readStorage
      ? await hooks.readStorage()
      : await storageLocalGetAsync(['chatflow_update_notice', 'chatflow_dismissed_whats_new_version']);

    const notice = res?.chatflow_update_notice;
    const dismissedVer = res?.chatflow_dismissed_whats_new_version;
    const shouldShow = Boolean(
      notice &&
      notice.updatedTo === currentVer &&
      notice.dismissed !== true &&
      dismissedVer !== currentVer &&
      notice.updatedFrom &&
      notice.updatedFrom !== currentVer
    );

    if (!shouldShow) {
      card.classList.add('hidden');
      return false;
    }

    const titleEl = $('whats-new-title');
    if (titleEl) {
      const localized = (typeof chrome !== 'undefined' && chrome.i18n?.getMessage?.('whatsNewTitle', [currentVer])) || '';
      titleEl.textContent = localized || `ChatFlow was updated to v${currentVer}`;
    }

    const listEl = $('whats-new-list');
    if (listEl) {
      listEl.innerHTML = '';
      const bullets = (Array.isArray(RELEASE_HIGHLIGHTS) && RELEASE_HIGHLIGHTS.length > 0)
        ? RELEASE_HIGHLIGHTS.slice(0, 5)
        : [`Updated ChatFlow to v${currentVer}`];
      for (const line of bullets) {
        if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
          const li = document.createElement('li');
          li.textContent = line;
          listEl.appendChild(li);
        }
      }
    }

    card.classList.remove('hidden');
    return true;
  } catch (_) {
    card.classList.add('hidden');
    return false;
  }
}

async function dismissWhatsNew(hooks = {}) {
  const card = $('whats-new-card');
  if (card) card.classList.add('hidden');
  try {
    const currentVer = getExtensionVersion();
    const res = hooks.readStorage
      ? await hooks.readStorage()
      : await storageLocalGetAsync(['chatflow_update_notice']);
    const prevNotice = res?.chatflow_update_notice && typeof res.chatflow_update_notice === 'object'
      ? res.chatflow_update_notice
      : null;
    const patch = {
      chatflow_dismissed_whats_new_version: currentVer,
      ...(prevNotice ? { chatflow_update_notice: { ...prevNotice, dismissed: true } } : {})
    };
    if (hooks.writeStorage) {
      await hooks.writeStorage(patch);
    } else {
      await storageLocalSetAsync(patch);
    }
  } catch (_) {}
}

function getVersionMismatchMessage() {
  if (typeof chrome !== 'undefined' && chrome.i18n?.getMessage) {
    const msg = chrome.i18n.getMessage('versionMismatchNotice');
    if (msg) return msg;
  }
  return 'ChatFlow was updated. Reload this chat tab to finish updating.';
}

async function verifyContentScriptVersion(tabId, hooks = {}) {
  if (!tabId) return { ok: false, versionMismatch: false, notReady: true };
  const panelVersion = getExtensionVersion();
  const sendPing = hooks.sendMessage
    ? (id) => hooks.sendMessage(id, { type: 'PING' })
    : (id) => chrome.tabs.sendMessage(id, { type: 'PING' });

  let ping = null;
  try {
    ping = await sendPing(tabId);
  } catch (_) { }

  if (!ping?.ok && !hooks.skipInject && !hooks.sendMessage) {
    const ready = await ensureContentScriptReady(tabId);
    if (ready) {
      try {
        ping = await sendPing(tabId);
      } catch (_) { }
    }
  }

  if (!ping || !ping.ok) {
    return { ok: false, versionMismatch: false, notReady: true };
  }

  const contentVersion = typeof ping.version === 'string' ? ping.version.trim() : '';
  if (!contentVersion || contentVersion !== panelVersion) {
    stopLoadingTimers();
    currentScanPhase = 'idle';
    const mismatchMsg = getVersionMismatchMessage();
    if (!hooks.silent) {
      setState(AppState.ERROR, {
        message: mismatchMsg,
        connectionLost: true,
        versionMismatch: true,
        step: 'version_handshake'
      });
    }
    return {
      ok: false,
      versionMismatch: true,
      contentVersion: contentVersion || 'unknown',
      panelVersion,
      message: mismatchMsg
    };
  }

  return { ok: true, versionMismatch: false, contentVersion, panelVersion };
}

/**
 * Ensure content-script.js is injected and answering PINGs.
 */
async function ensureContentScriptReady(tabId) {
  if (!tabId) return false;

  // Test ping first
  try {
    const ping = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    if (ping?.ok) return true;
  } catch (_) { }

  // Inject content script dynamically
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/content-script.js']
    });

    await new Promise(r => setTimeout(r, 160));

    const ping = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    if (ping?.ok) return true;
  } catch (_) { }

  return false;
}

/**
 * Inspect page DOM to check if a conversation is open and extract its clean name.
 */
async function getChatInfoFromPage(tabId, platform) {
  if (!tabId) return { hasOpenChat: false, chatName: '' };

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      args: [platform],
      func: (plat) => {
        function universalSanitize(raw) {
          if (!raw || typeof raw !== 'string') return '';
          let s = raw.replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E]/g, '').replace(/\s+/g, ' ').trim();
          s = s.replace(/^(?:conversation\s+(?:titled|with|in|about)|chat\s+with|group\s+chat|conversa(?:ción)?\s+(?:con|titulada?)|unterhaltung\s+mit(?:\s+dem\s+titel)?)\s+/i, '');
          s = s.replace(/^(?:শিরোনামযুক্ত কথোপকথন|গ্রুপ চ্যাট)\s+/i, '');
          s = s.replace(/\s*[-_]?\s*(?:এর সাথে কথোপকথন|এর সাথে চ্যাট|শিরোনামযুক্ত কথোপকথন)$/i, '');
          s = s.replace(/\s+(?:active\s+(?:now|\d+\w*\s+ago|yesterday|today)|typing\.*|muted|online|last seen\b.*)$/i, '');
          s = s.replace(/^["'“”«»]+|["'“”«»]+$/g, '').trim();
          return s;
        }

        function isPinnedBanner(el) {
          if (!el || !(el instanceof Element)) return false;
          return !!el.closest('[aria-label*="pinned" i], [data-testid*="pinned" i], [class*="pinned" i]') ||
            /^(pinned message|পিন করা মেসেজ)/i.test((el.innerText || el.textContent || '').trim());
        }

        if (plat === 'WhatsApp') {
          const main = document.querySelector('#main');
          const hasOpenChat = !!main;

          function isValidWA(str) {
            if (!str || typeof str !== 'string') return false;
            const s = str.trim();
            if (!s) return false;
            const bad = [
              /\blast seen\b/i, /^online$/i, /^typing\b/i, /^recording audio\b/i,
              /^click here for (contact|group) info/i, /\btoday at\b/i, /\byesterday at\b/i,
              /\b\d{1,2}:\d{2}\s*(am|pm)\b/i, /^mute notifications/i
            ];
            return !bad.some(rx => rx.test(s));
          }

          let chatName = '';
          const selectors = [
            '#main header [data-testid="conversation-info-header-chat-title"] span[title]',
            '#main header [data-testid="conversation-info-header-chat-title"] span',
            '#main header [data-testid="conversation-info-header-chat-title"]',
            '#main header div[role="button"] > div:first-child span[title]',
            '#main header div[role="button"] > div:first-child span[dir="auto"]',
            '#main header h2 span[title]',
            '#main header h2 span[dir="auto"]',
            '#main header h2'
          ];

          for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el) {
              const val = universalSanitize(el.getAttribute('title') || el.innerText || el.textContent || '');
              if (val && isValidWA(val)) { chatName = val; break; }
            }
          }

          if (!chatName && main) {
            const header = main.querySelector('header');
            if (header) {
              const statusBox = header.querySelector('[data-testid="conversation-info-header-chat-status"]');
              const spans = header.querySelectorAll('span[title], span[dir="auto"]');
              for (const sp of spans) {
                if (statusBox && statusBox.contains(sp)) continue;
                const val = universalSanitize(sp.getAttribute('title') || sp.innerText || sp.textContent || '');
                if (val && isValidWA(val)) { chatName = val; break; }
              }
            }
          }

          if (!chatName) {
            const activeItem = document.querySelector('#pane-side [aria-selected="true"], #pane-side [class*="active"], #pane-side [class*="selected"]');
            if (activeItem) {
              const spans = activeItem.querySelectorAll('span[title], span[dir="auto"]');
              for (const sp of spans) {
                const val = universalSanitize(sp.getAttribute('title') || sp.innerText || sp.textContent || '');
                if (val && isValidWA(val)) { chatName = val; break; }
              }
            }
          }

          return { hasOpenChat, chatName: chatName || (hasOpenChat ? 'Active Chat' : '') };
        } else {
          // Messenger
          const main = document.querySelector('div[role="main"]');
          const hasOpenChat = !!(main && (main.querySelector('[role="row"], [role="gridcell"], div[dir="auto"]') || main.querySelector('header')));

          function isValidMsgr(str) {
            if (!str || typeof str !== 'string') return false;
            const s = str.trim();
            if (!s || s.length < 2) return false;
            const bad = [
              /\bactive\s+(now|\d+\w*\s+ago)\b/i, /\bactive\s+yesterday\b/i,
              /\bend-to-end encrypted\b/i, /\bjoined messenger\b/i,
              /\boptions\b/i, /\bconversation information\b/i, /^messenger$/i,
              /^pinned message/i, /^পিন করা মেসেজ/i
            ];
            return !bad.some(rx => rx.test(s));
          }

          let chatName = '';
          const headers = [
            'div[role="main"] header h1',
            'div[role="main"] header h2',
            'div[role="main"] header span[role="heading"]',
            'div[role="main"] header div[dir="auto"]',
            'div[role="main"] header span[dir="auto"]',
            'div[role="main"] h1',
            'div[role="main"] h2',
            'div[data-pagelet*="Header"] h1',
            'div[data-pagelet*="Header"] h2',
            'div[data-pagelet*="Header"] span[dir="auto"]'
          ];

          for (const sel of headers) {
            const el = document.querySelector(sel);
            if (el && !isPinnedBanner(el)) {
              const val = universalSanitize(el.innerText || el.textContent || '');
              if (val && isValidMsgr(val)) { chatName = val; break; }
            }
          }

          if (!chatName && main) {
            const header = main.querySelector('header') || main;
            const candidates = header.querySelectorAll('h1, h2, span[role="heading"], span[dir="auto"], div[dir="auto"]');
            for (const c of candidates) {
              if (isPinnedBanner(c)) continue;
              const val = universalSanitize(c.innerText || c.textContent || '');
              if (val && isValidMsgr(val) && val.length < 70) { chatName = val; break; }
            }
          }

          if (!chatName) {
            const activeNav = document.querySelector('div[role="navigation"] [aria-selected="true"], div[role="navigation"] [aria-current="page"]');
            if (activeNav) {
              const spans = activeNav.querySelectorAll('span[dir="auto"]');
              for (const sp of spans) {
                const val = universalSanitize(sp.innerText || sp.textContent || '');
                if (val && isValidMsgr(val)) { chatName = val; break; }
              }
            }
          }

          return { hasOpenChat, chatName: chatName || (hasOpenChat ? 'Messenger chat' : '') };
        }
      }
    });

    const res = results?.[0]?.result || { hasOpenChat: false, chatName: '' };
    return {
      hasOpenChat: res.hasOpenChat,
      chatName: sanitizeChatName(res.chatName, res.hasOpenChat ? 'Chat' : '')
    };
  } catch (_) {
    return { hasOpenChat: false, chatName: '' };
  }
}

// ─── Initialization ───────────────────────────────────────────────────────────

async function init() {
  try {
    currentTab = await findSupportedTab();

    if (!currentTab || !getPlatformFromUrl(currentTab.url)) {
      setPlatformTheme('neutral');
      $('top-chat-title').textContent = 'WhatsApp or Messenger';
      $('top-avatar').textContent = 'CF';
      $('top-platform-badge').classList.add('hidden');
      setState(AppState.NOT_SUPPORTED);
      return;
    }

    currentPlatform = getPlatformFromUrl(currentTab.url);
    setPlatformTheme(currentPlatform);

    // Update Platform Badge in Top Bar
    const badge = $('top-platform-badge');
    if (badge) {
      badge.textContent = currentPlatform;
      badge.classList.remove('hidden');
      badge.classList.toggle('messenger', currentPlatform === 'Messenger');
    }

    // Inspect conversation state
    const info = await getChatInfoFromPage(currentTab.id, currentPlatform);

    if (!info.hasOpenChat) {
      $('top-chat-title').textContent = 'No chat open';
      $('top-avatar').textContent = 'CF';
      $('select-chat-desc').textContent = `Click any chat on ${currentPlatform} to start analyzing and exporting.`;
      setState(AppState.SELECT_CHAT);
      return;
    }

    const chatName = sanitizeChatName(info.chatName) || 'Active Chat';
    $('top-chat-title').textContent = chatName;
    $('top-avatar').textContent = getInitials(chatName);

    // Check existing scan data in session storage
    const session = await chrome.runtime.sendMessage({
      type: 'GET_SESSION',
      keys: ['chatName', 'platform', 'stats', 'messages']
    });

    if (session?.data?.stats && session?.data?.messages &&
      session?.data?.chatName === chatName &&
      session?.data?.platform === currentPlatform) {
      cachedStats = JSON.parse(session.data.stats);
      const raw = JSON.parse(session.data.messages);
      cachedMessages = raw.map(m => ({
        ...m,
        timestamp: m.timestamp ? new Date(m.timestamp) : null
      }));
      renderCompleteDashboard();
      return;
    }

    // Ready to scan!
    setState(AppState.READY, { chatName });

    // Check content script readiness and version handshake (prompts reload if outdated)
    await verifyContentScriptVersion(currentTab.id).catch(() => { });
  } catch (err) {
    setState(AppState.ERROR, { message: err.message });
  }
}

// ─── Per-Chat Preferences in chrome.storage.local (Names/Flags Only) ────────

function getChatPrefKey(platform, chatName) {
  const clean = sanitizeChatName(chatName) || 'Chat';
  return `${(platform || 'WhatsApp').toLowerCase()}::${clean.toLowerCase()}`;
}

let cachedMyNameByPlatform = {};
let lastPageDetectedMyName = '';

function normalizePlatformKey(platform) {
  return (platform || '').toLowerCase().includes('messenger') ? 'messenger' : 'whatsapp';
}

function cleanUserMyNameSetting(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const trimmed = raw.replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!trimmed || isBlockedUiName(trimmed)) return '';
  return trimmed;
}

function syncMyNameInputs(val, sourceId = null) {
  const ids = ['ready-my-name', 'scan-ready-my-name', 'exp-my-name', 'setting-my-name'];
  for (const id of ids) {
    if (id === sourceId) continue;
    const el = $(id);
    if (el && el.value !== val) el.value = val;
  }
}

async function loadPlatformMyName(platform) {
  try {
    const pKey = normalizePlatformKey(platform || currentPlatform);
    const res = await chrome.storage.local.get(['chatflow_my_name_by_platform', 'chatflow_my_name']);
    const rawMap = (res && typeof res.chatflow_my_name_by_platform === 'object' && res.chatflow_my_name_by_platform) || {};
    const cleanedGlobal = cleanUserMyNameSetting(res?.chatflow_my_name || '');
    const cleanedPlat = cleanUserMyNameSetting(rawMap[pKey] || '');

    // Purge blocked UI strings (e.g. "Controls and Settings") if previously stored
    const needsPurge = (res?.chatflow_my_name && !cleanedGlobal) || (rawMap[pKey] && !cleanedPlat);
    if (needsPurge) {
      const nextMap = { ...rawMap };
      if (rawMap[pKey] && !cleanedPlat) nextMap[pKey] = '';
      chrome.storage.local.set({
        chatflow_my_name_by_platform: nextMap,
        ...(res?.chatflow_my_name && !cleanedGlobal ? { chatflow_my_name: '' } : {})
      }).catch(() => { });
      try {
        const ls = localStorage.getItem('chatflow_my_name');
        if (ls && !cleanUserMyNameSetting(ls)) localStorage.removeItem('chatflow_my_name');
      } catch (_) { }
    }

    cachedMyNameByPlatform = { ...cachedMyNameByPlatform, ...rawMap, [pKey]: cleanedPlat };
    return cleanedPlat || cleanedGlobal || '';
  } catch (_) {
    return '';
  }
}

async function savePlatformMyName(platform, rawVal) {
  const pKey = normalizePlatformKey(platform || currentPlatform);
  const val = cleanUserMyNameSetting(rawVal);
  cachedMyNameByPlatform[pKey] = val;
  try {
    localStorage.setItem('chatflow_my_name', val);
  } catch (_) { }
  try {
    const res = await chrome.storage.local.get(['chatflow_my_name_by_platform']);
    const prevMap = (res && typeof res.chatflow_my_name_by_platform === 'object' && res.chatflow_my_name_by_platform) || {};
    const nextMap = { ...prevMap, [pKey]: val };
    await chrome.storage.local.set({
      chatflow_my_name_by_platform: nextMap,
      chatflow_my_name: val
    });
  } catch (_) { }
}

async function prefillMyNameUi(platform = currentPlatform, detectedRaw = '') {
  const saved = await loadPlatformMyName(platform);
  const contactName = $('top-chat-title')?.textContent || cachedStats?.chatName || '';
  const validDetected = validatePersonName(detectedRaw, { contactName }) || '';
  if (validDetected) lastPageDetectedMyName = validDetected;
  const fallbackDetected = validDetected || validatePersonName(cachedStats?.integrity?.pageDetectedMyName || lastPageDetectedMyName, { contactName }) || '';
  const activeEl = document.activeElement?.id || '';
  const currentTyped = ids => ids.map(id => $(id)?.value || '').find(v => v.trim());
  const valueToShow = saved || cleanUserMyNameSetting(currentTyped(['ready-my-name', 'scan-ready-my-name', 'exp-my-name'])) || fallbackDetected || '';
  syncMyNameInputs(valueToShow, ['ready-my-name', 'scan-ready-my-name', 'exp-my-name', 'setting-my-name'].includes(activeEl) ? activeEl : null);
}

async function loadChatPrefs(platform, chatName) {
  try {
    const key = getChatPrefKey(platform, chatName);
    const pKey = normalizePlatformKey(platform);
    const res = await chrome.storage.local.get(['chatflow_chat_prefs', 'chatflow_my_name', 'chatflow_my_name_by_platform']);
    const map = res?.chatflow_chat_prefs || {};
    const chatPref = { ...(map[key] || {}) };
    if (chatPref.myName && isBlockedUiName(chatPref.myName)) {
      chatPref.myName = '';
    }
    const platMap = res?.chatflow_my_name_by_platform || {};
    const platName = cleanUserMyNameSetting(platMap[pKey] || '');
    const globalName = cleanUserMyNameSetting(res?.chatflow_my_name || '');
    return {
      ...chatPref,
      globalMyName: platName || globalName || ''
    };
  } catch (_) {
    return { globalMyName: '' };
  }
}

async function saveChatPrefs(platform, chatName, patch) {
  try {
    const key = getChatPrefKey(platform, chatName);
    const pKey = normalizePlatformKey(platform);
    const res = await chrome.storage.local.get(['chatflow_chat_prefs', 'chatflow_my_name_by_platform']);
    const map = res?.chatflow_chat_prefs || {};
    map[key] = {
      ...(map[key] || {}),
      ...patch,
      updatedAt: new Date().toISOString()
    };
    const toSave = { chatflow_chat_prefs: map };
    if (typeof patch.myName === 'string') {
      const cleaned = cleanUserMyNameSetting(patch.myName);
      const prevPlatMap = res?.chatflow_my_name_by_platform || {};
      toSave.chatflow_my_name_by_platform = { ...prevPlatMap, [pKey]: cleaned };
      toSave.chatflow_my_name = cleaned;
    }
    await chrome.storage.local.set(toSave);
  } catch (_) { }
}

// ─── Scan Stepper & Phase View Switcher ──────────────────────────────────────

let loadingElapsedTimer = null;
let loadingStartedAt = 0;
let lastOldestIso = null;
let lastOldestChangeAt = 0;
let stallTimer = null;

function formatElapsedSec(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatShortDate(isoOrDate) {
  if (!isoOrDate) return null;
  const d = (isoOrDate instanceof Date) ? isoOrDate : new Date(isoOrDate);
  if (isNaN(d.getTime()) || !isValidConversationDate(d)) return null;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function setStepperPhase(phase, { beginningReached = true } = {}) {
  currentScanPhase = phase;
  const s1 = $('step-1');
  const s2 = $('step-2');
  const s3 = $('step-3');
  const d1 = s1?.querySelector('.step-dot');
  const d2 = s2?.querySelector('.step-dot');
  const d3 = s3?.querySelector('.step-dot');

  [s1, s2, s3].forEach(el => el?.classList.remove('active', 'done', 'warn'));
  if (d1) d1.textContent = '1';
  if (d2) d2.textContent = '2';
  if (d3) d3.textContent = '3';

  const s2Label = s2?.querySelector('.step-label');
  if (s2Label) {
    s2Label.textContent = phase === 'verifying' ? 'Verifying' : 'Reading messages';
  }

  if (phase === 'loading') {
    s1?.classList.add('active');
  } else if (phase === 'ready') {
    if (beginningReached) {
      s1?.classList.add('done');
      if (d1) d1.textContent = '✓';
    } else {
      s1?.classList.add('warn');
      if (d1) d1.textContent = '!';
    }
  } else if (phase === 'reading' || phase === 'verifying') {
    s1?.classList.add('done');
    if (d1) d1.textContent = '✓';
    s2?.classList.add('active');
  } else if (phase === 'preparing') {
    s1?.classList.add('done');
    s2?.classList.add('done');
    if (d1) d1.textContent = '✓';
    if (d2) d2.textContent = '✓';
    s3?.classList.add('active');
  }

  const views = {
    loading: $('view-loading'),
    ready: $('view-ready'),
    reading: $('view-reading'),
    preparing: $('view-preparing')
  };
  const viewKey = phase === 'verifying' ? 'reading' : phase;
  for (const [k, el] of Object.entries(views)) {
    if (el) el.classList.toggle('hidden', k !== viewKey);
  }
  const verifyBox = $('verify-progress-box');
  if (verifyBox) {
    verifyBox.classList.toggle('hidden', phase !== 'verifying');
  }
  if (phase === 'reading') {
    if ($('verifying-bar')) $('verifying-bar').style.width = '0%';
    if ($('verifying-progress')) $('verifying-progress').setAttribute('aria-valuenow', '0');
    if ($('verifying-label')) $('verifying-label').textContent = 'Verifying coverage...';
  }

  const titles = {
    loading: 'Loading chat history...',
    ready: 'Ready to scan',
    reading: 'Reading messages',
    verifying: 'Verifying',
    preparing: 'Preparing your results...'
  };
  const titleText = titles[phase] || 'Scanning...';
  if ($('scan-title')) $('scan-title').textContent = titleText;
  if ($('scan-live')) $('scan-live').textContent = titleText;
}

function startLoadingTimers() {
  loadingStartedAt = Date.now();
  lastOldestIso = null;
  lastOldestChangeAt = Date.now();
  hideStallPrompt();

  if (loadingElapsedTimer) clearInterval(loadingElapsedTimer);
  loadingElapsedTimer = setInterval(() => {
    const elapsedEl = $('loading-elapsed');
    if (elapsedEl) {
      elapsedEl.textContent = `Elapsed: ${formatElapsedSec(Date.now() - loadingStartedAt)}`;
    }
  }, 1000);

  if (stallTimer) clearInterval(stallTimer);
  stallTimer = setInterval(() => {
    if (lastOldestChangeAt > 0 && Date.now() - lastOldestChangeAt >= 10000) {
      showStallPrompt();
    }
  }, 1000);
}

function stopLoadingTimers() {
  if (loadingElapsedTimer) clearInterval(loadingElapsedTimer);
  if (stallTimer) clearInterval(stallTimer);
  if (stopWatchdogTimer) clearTimeout(stopWatchdogTimer);
  loadingElapsedTimer = null;
  stallTimer = null;
  stopWatchdogTimer = null;
  lastOldestChangeAt = 0;
  hideStallPrompt();
}

function showStallPrompt() {
  const hint = $('scan-stall-hint');
  const btn = $('btn-stop-loading');
  if (hint) hint.classList.remove('hidden');
  if (btn) btn.classList.add('highlight-prompt');
}

function hideStallPrompt() {
  const hint = $('scan-stall-hint');
  const btn = $('btn-stop-loading');
  if (hint) hint.classList.add('hidden');
  if (btn) btn.classList.remove('highlight-prompt');
}

// ─── Scan Execution (Two-Step Protocol: LOAD_HISTORY -> Ready -> START_READING)

async function startScan(opts = {}) {
  return beginLoadHistory(opts);
}

async function beginLoadHistory({ isLoadMore = false } = {}) {
  resetGroupBySenderToggle();
  if (!currentTab?.id) {
    currentTab = await findSupportedTab();
    if (!currentTab) {
      setState(AppState.NOT_SUPPORTED);
      return;
    }
  }

  setState(AppState.SCANNING);
  setStepperPhase('loading');
  if ($('loading-oldest')) $('loading-oldest').textContent = 'Looking for older messages...';
  if ($('loading-elapsed')) $('loading-elapsed').textContent = 'Elapsed: 0:00';

  const btnStop = $('btn-stop-loading');
  if (btnStop) {
    btnStop.disabled = false;
    btnStop.querySelector('span')
      ? (btnStop.querySelector('span').textContent = 'Stop loading')
      : (btnStop.textContent = 'Stop loading');
  }

  startLoadingTimers();

  try {
    const handshake = await verifyContentScriptVersion(currentTab.id);
    if (handshake.versionMismatch) {
      stopLoadingTimers();
      return;
    }
    if (!handshake.ok) {
      const isReady = await ensureContentScriptReady(currentTab.id);
      if (!isReady) {
        throw new Error(`Could not connect to ${currentPlatform}. Please reload the tab (F5) and click Refresh.`);
      }
      const postInject = await verifyContentScriptVersion(currentTab.id);
      if (postInject.versionMismatch) {
        stopLoadingTimers();
        return;
      }
    }

    const result = await chrome.tabs.sendMessage(currentTab.id, {
      type: 'LOAD_HISTORY',
      expectedVersion: getExtensionVersion()
    });
    stopLoadingTimers();

    if (result?.versionMismatch) {
      currentScanPhase = 'idle';
      setState(AppState.ERROR, {
        message: getVersionMismatchMessage(),
        connectionLost: true,
        versionMismatch: true,
        step: 'version_handshake'
      });
      return;
    }

    // If user already pressed Stop loading or Cancel and transitioned away from 'loading', do not overwrite
    if (currentScanPhase === 'ready') {
      if (result && result.ok) updateReadyView(result);
      return;
    }
    if (currentScanPhase === 'idle' || currentScanPhase === 'reading') {
      return;
    }

    if (!result) throw new Error(`No response from ${currentPlatform} scanner. Reload tab and retry.`);
    if (result.cancelled) {
      currentScanPhase = 'idle';
      const info = await getChatInfoFromPage(currentTab.id, currentPlatform);
      setState(AppState.READY, { chatName: info.chatName });
      return;
    }
    if (!result.ok) throw new Error(result.error || 'Failed to load chat history');

    // Auto-start Phase 2 ONLY when setting is ON, full history was reached, and not a manual "Load more"
    if (autoStartEnabled && result.beginningReached && !isLoadMore) {
      await beginReadingPhase();
      return;
    }

    showReadyToScan(result);
  } catch (err) {
    stopLoadingTimers();
    if (currentScanPhase === 'ready') return;
    currentScanPhase = 'idle';
    setState(AppState.ERROR, { message: err.message, connectionLost: isConnectionLostError(err) });
  }
}

function showReadyToScan(info = {}) {
  stopLoadingTimers();
  const btnStop = $('btn-stop-loading');
  if (btnStop) {
    btnStop.disabled = false;
    const sp = btnStop.querySelector('span');
    if (sp) sp.textContent = 'Stop loading';
    else btnStop.textContent = 'Stop loading';
  }

  const beginningReached = !!info.beginningReached;
  setStepperPhase('ready', { beginningReached });
  updateReadyView(info);
  prefillMyNameUi(info.platform || currentPlatform, info.detectedMyName || '');

  const btnStart = $('btn-start-scan');
  if (btnStart) {
    btnStart.disabled = false;
    btnStart.focus();
  }

  // Show floating tip unless user clicked "Don't show again"
  const tip = $('ready-tip');
  const tipText = $('ready-tip-text');
  if (tip && tipText) {
    if (hideReadyTip) {
      tip.classList.add('hidden');
    } else {
      if (beginningReached) {
        tipText.textContent = 'Tip: The beginning of the chat is loaded. Click Start scan whenever you are ready.';
      } else if (currentPlatform === 'WhatsApp') {
        tipText.textContent = 'Tip: Keep your phone unlocked with WhatsApp open, or scroll up in the chat to load older messages before clicking Start scan.';
      } else {
        tipText.textContent = 'Tip: You can scroll up in the Messenger chat window to load more history, or click Start scan to read from here.';
      }
      tip.classList.remove('hidden');
    }
  }
}

function updateReadyView(info = {}) {
  const beginningReached = !!info.beginningReached;
  const dateFmt = formatShortDate(info.oldestDate || lastOldestIso) || 'earliest loaded message';

  const badge = $('ready-badge');
  const badgeText = $('ready-badge-text');
  if (badge && badgeText) {
    badge.classList.toggle('full', beginningReached);
    badge.classList.toggle('partial', !beginningReached);
    badgeText.textContent = beginningReached ? 'Full history loaded' : 'Partial history';
  }

  const s1 = $('step-1');
  const d1 = s1?.querySelector('.step-dot');
  if (s1 && d1) {
    s1.classList.toggle('done', beginningReached);
    s1.classList.toggle('warn', !beginningReached);
    d1.textContent = beginningReached ? '✓' : '!';
  }

  const statusEl = $('ready-status');
  const msgEl = $('ready-message');
  if (statusEl) {
    statusEl.textContent = beginningReached
      ? `Beginning of chat reached — ready to scan from ${dateFmt}`
      : `History loaded back to ${dateFmt}`;
  }
  if (msgEl) {
    msgEl.textContent = info.message || (!beginningReached
      ? 'Scroll up in the chat to load older messages, or click Start scan to read from here.'
      : '');
  }
}

async function beginReadingPhase() {
  if (!currentTab?.id) return;

  // Hide tip & disable Start scan immediately so it cannot be double-clicked
  $('ready-tip')?.classList.add('hidden');
  const btnStart = $('btn-start-scan');
  if (btnStart) btnStart.disabled = true;

  // Reset Phase 2 UI counter to 0
  setStepperPhase('reading');
  if ($('scan-count')) $('scan-count').textContent = '0';
  if ($('scan-count-label')) $('scan-count-label').textContent = 'Messages read: 0';
  if ($('reading-bar')) $('reading-bar').style.width = '0%';
  if ($('reading-progress')) $('reading-progress').setAttribute('aria-valuenow', '0');
  if ($('reading-date')) $('reading-date').textContent = 'Reading from the top...';
  if ($('reading-speed')) $('reading-speed').textContent = '';
  $('reading-direction-note')?.classList.add('hidden');

  try {
    const handshake = await verifyContentScriptVersion(currentTab.id);
    if (handshake.versionMismatch) return;
    if (!handshake.ok) {
      throw new Error(`Could not connect to ${currentPlatform}. Please reload the tab (F5) and retry.`);
    }

    const topTitle = $('top-chat-title')?.textContent || '';
    const prefs = await loadChatPrefs(currentPlatform, topTitle);
    const typedReady = cleanUserMyNameSetting($('scan-ready-my-name')?.value || $('ready-my-name')?.value || '');
    const myNameOverride = typedReady || cleanUserMyNameSetting(prefs.myName || prefs.globalMyName || $('setting-my-name')?.value || '');
    if (typedReady) {
      savePlatformMyName(currentPlatform, typedReady);
    }

    const result = await chrome.tabs.sendMessage(currentTab.id, {
      type: 'START_READING',
      expectedVersion: getExtensionVersion(),
      options: { myNameOverride, thoroughVerify: thoroughScanEnabled }
    });

    if (result?.versionMismatch) {
      currentScanPhase = 'idle';
      setState(AppState.ERROR, {
        message: getVersionMismatchMessage(),
        connectionLost: true,
        versionMismatch: true,
        step: 'version_handshake'
      });
      return;
    }

    if (!result) throw new Error(`No response from ${currentPlatform} scanner. Reload tab and retry.`);
    if (result.cancelled) {
      currentScanPhase = 'idle';
      const info = await getChatInfoFromPage(currentTab.id, currentPlatform);
      setState(AppState.READY, { chatName: info.chatName });
      return;
    }
    if (!result.ok) throw new Error(result.error || 'Scan process failed');

    setStepperPhase('preparing');
    await finalizeAndSaveScan(result.payload);
  } catch (err) {
    currentScanPhase = 'idle';
    recordStepError('reading_phase', err);
    setState(AppState.ERROR, {
      message: err?.message || 'Unable to read conversation.',
      stack: err?.stack || '',
      step: 'reading_phase',
      connectionLost: isConnectionLostError(err)
    });
  }
}

async function runVerifyNow(hooks = {}) {
  if (!cachedMessages || cachedMessages.length === 0) {
    showToast('Scan a conversation first before verifying');
    return null;
  }
  const btn = $('btn-cc-verify-now');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Verifying...';
  }
  try {
    const tabId = hooks.tabId || currentTab?.id || (await findSupportedTab())?.id;
    if (!tabId) throw new Error('No active WhatsApp or Messenger tab found.');
    if (!hooks.skipReadyCheck) {
      const handshake = await verifyContentScriptVersion(tabId);
      if (handshake.versionMismatch) {
        return null;
      }
      if (!handshake.ok) {
        const ready = await ensureContentScriptReady(tabId);
        if (!ready) throw new Error('Content script not responding. Reload the tab.');
      }
    }

    setState(AppState.SCANNING);
    setStepperPhase('verifying');
    if ($('scan-count')) $('scan-count').textContent = cachedMessages.length.toLocaleString();
    if ($('scan-count-label')) $('scan-count-label').textContent = `Messages read: ${cachedMessages.length.toLocaleString()}`;
    if ($('verifying-bar')) $('verifying-bar').style.width = '0%';
    if ($('verifying-progress')) $('verifying-progress').setAttribute('aria-valuenow', '0');

    const topTitle = $('top-chat-title')?.textContent || cachedStats?.chatName || '';
    const prefs = await loadChatPrefs(currentPlatform, topTitle);
    const myNameOverride = cleanUserMyNameSetting(
      $('exp-my-name')?.value || $('setting-my-name')?.value || prefs.myName || prefs.globalMyName || ''
    );
    const integ = cachedStats?.integrity || {};
    const aud = integ.audit || {};

    const sendFn = hooks.sendMessage || ((id, msg) => chrome.tabs.sendMessage(id, msg));
    const resp = await sendFn(tabId, {
      type: 'VERIFY_NOW',
      expectedVersion: getExtensionVersion(),
      payload: {
        masterList: cachedMessages,
        scanMeta: {
          chatName: cachedStats?.chatName || topTitle,
          platform: cachedStats?.platform || currentPlatform,
          chatType: integ.chatType || 'one-to-one',
          beginningReached: integ.beginningReached !== false,
          endReason: integ.endReason || 'complete',
          overlapMergesCount: integ.overlapMergesCount || 0,
          noOverlapEventsCount: integ.noOverlapEventsCount || 0,
          gapEvents: aud.gapEvents || [],
          pass1DurationMs: aud.pass1DurationMs || 0,
          myNameOverride,
          pass1Audit: {
            ...aud,
            uniqueRowsSeen: aud.uniqueRowsSeen ?? aud.candidateRowsSeen ?? cachedMessages.length,
            candidateRowsSeen: aud.uniqueRowsSeen ?? aud.candidateRowsSeen ?? cachedMessages.length
          }
        }
      }
    });

    if (!resp) throw new Error('No response from scanner');
    if (resp.cancelled) {
      currentScanPhase = 'idle';
      setState(AppState.COMPLETE);
      showToast('Verification cancelled');
      return null;
    }
    if (!resp.ok) throw new Error(resp.error || 'Verification failed');

    setStepperPhase('preparing');
    await finalizeAndSaveScan(resp.payload);
    const newAudit = resp.payload?.integrity?.audit || {};
    showToast(newAudit.verificationLabel || 'Verification complete');
    return resp.payload;
  } catch (err) {
    currentScanPhase = 'idle';
    recordStepError('verify_now', err);
    if (cachedMessages && cachedStats) {
      setState(AppState.COMPLETE);
    }
    showToast(`Verification error: ${err?.message || 'failed'}`);
    return null;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Verify now';
    }
  }
}

async function finalizeAndSaveScan(payload, options = DEFAULT_EXPORT_OPTIONS, hooks = {}) {
  clearRecordedErrors();
  resetGroupBySenderToggle();
  const exportOpts = normalizeExportOptions(options);
  const safePayload = payload && typeof payload === 'object' ? payload : {};
  const {
    messages,
    chatName: rawChatName,
    platform = currentPlatform,
    chatType = 'one-to-one',
    isPartial = false,
    oldestTimestamp = null,
    integrity: rawIntegrity = null
  } = safePayload;

  const chatName = sanitizeChatName(rawChatName) || 'Active Chat';
  if (!Array.isArray(messages) || messages.length === 0) {
    const emptyErr = new Error('No messages found in this chat.');
    recordStepError('validate_messages', emptyErr);
    throw emptyErr;
  }

  const integrity = rawIntegrity && typeof rawIntegrity === 'object'
    ? rawIntegrity
    : {};

  let revived = [];
  try {
    hooks?.beforeStep?.('revive_messages');
    revived = messages.map(m => ({
      ...(m && typeof m === 'object' ? m : {}),
      timestamp: m?.timestamp ? new Date(m.timestamp) : null
    }));
  } catch (reviveErr) {
    recordStepError('revive_messages', reviveErr);
    revived = messages.filter(Boolean);
  }

  // Apply any remembered per-chat side choice, swap, or validated myName in memory (non-fatal)
  let prefs = { globalMyName: '' };
  try {
    hooks?.beforeStep?.('preferences_and_direction');
    prefs = await loadChatPrefs(platform, chatName);
    const typedReady = cleanUserMyNameSetting($('scan-ready-my-name')?.value || $('ready-my-name')?.value || exportOpts.myName || '');
    const myNameOverride = typedReady || cleanUserMyNameSetting(prefs.myName || prefs.globalMyName || '');
    const validPageName = validatePersonName(integrity?.detectedMyName || '', { contactName: chatName }) || '';
    integrity.pageDetectedMyName = validPageName;
    if (validPageName) lastPageDetectedMyName = validPageName;

    if (prefs.meSide === 'left' || prefs.meSide === 'right') {
      applySideChoice(revived, prefs.meSide);
    } else if (prefs.swapped) {
      swapSides(revived);
    }

    const hasBlockedSender = revived.some(m => isBlockedUiName(m.sender || '') || isBlockedUiName(m.replyTo?.sender || ''));
    if (prefs.meSide || prefs.swapped || myNameOverride || hasBlockedSender || (integrity?.detectedMyName && isBlockedUiName(integrity.detectedMyName))) {
      const names = finalizeSenders(revived, {
        chatType,
        chatName,
        profileName: validPageName || null,
        myNameOverride
      });
      integrity.detectedMyName = names.myName;
      integrity.senderCounts = names.counts;
      if (integrity.sanityCheck) {
        integrity.sanityCheck.myName = names.myName;
        integrity.sanityCheck.contactName = names.contactName;
      }
      if (prefs.confirmed && integrity.direction) {
        integrity.direction.lowConfidence = false;
        integrity.direction.confirmedByUser = true;
      }
    }
  } catch (prefErr) {
    integrity.checksIncomplete = true;
    integrity.diagnosticsError = prefErr.message;
    recordStepError('preferences_and_direction', prefErr);
  }

  let stats = null;
  try {
    hooks?.beforeStep?.('service_worker_save');
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      const saveResult = await chrome.runtime.sendMessage({
        type: 'SCAN_COMPLETE',
        payload: {
          messages: revived,
          chatName,
          platform,
          chatType,
          isPartial,
          oldestTimestamp,
          integrity,
          options: exportOpts,
          myName: exportOpts.myName || '',
          detectedMyName: integrity.pageDetectedMyName || exportOpts.detectedMyName || ''
        }
      });

      if (saveResult?.stepErrors?.length) {
        for (const swErr of saveResult.stepErrors) {
          recordStepError(swErr.step || 'service_worker', swErr);
        }
        integrity.checksIncomplete = true;
      }

      if (saveResult?.ok && saveResult.stats) {
        stats = saveResult.stats;
      } else if (saveResult?.error) {
        recordStepError('service_worker_save', saveResult.error);
        integrity.checksIncomplete = true;
      }
    }
  } catch (saveErr) {
    integrity.checksIncomplete = true;
    recordStepError('service_worker_save', saveErr);
  }

  if (!stats) {
    try {
      hooks?.beforeStep?.('local_stats');
      stats = buildStats(revived, chatName, platform);
      stats.isPartial = isPartial;
      stats.oldestTimestamp = oldestTimestamp;
      stats.integrity = integrity;
      stats.chatType = chatType;
    } catch (statsErr) {
      recordStepError('local_stats', statsErr);
      stats = {
        chatName,
        platform,
        totalMessages: revived.length,
        dateRange: { start: null, end: null },
        senderCounts: {},
        typeCounts: {},
        isPartial,
        oldestTimestamp,
        integrity: { ...integrity, checksIncomplete: true },
        chatType
      };
    }
  }

  cachedMessages = revived;
  cachedStats = stats;
  currentScanPhase = 'idle';

  try {
    renderCompleteDashboard(exportOpts, hooks);
  } catch (renderErr) {
    if (cachedStats?.integrity) {
      cachedStats.integrity.checksIncomplete = true;
      cachedStats.integrity.diagnosticsError = renderErr.message;
    }
    recordStepError('render_complete_dashboard', renderErr);
  }

  // If confidence is still low and user hasn't confirmed sides yet, prompt "Confirm who is who"
  try {
    hooks?.beforeStep?.('confirm_direction_prompt');
    if (cachedStats?.integrity?.direction?.lowConfidence && !prefs.confirmed) {
      openConfirmDirectionDialog();
    }
  } catch (promptErr) {
    recordStepError('confirm_direction_prompt', promptErr);
  }
}

// ─── Dashboard Rendering ──────────────────────────────────────────────────────

function renderCompleteDashboard(options = undefined, hooks = {}) {
  syncVersionLabels();
  setState(AppState.COMPLETE);
  if (!cachedStats) return;

  const opts = options !== undefined ? normalizeExportOptions(options) : undefined;
  const chatName = sanitizeChatName(cachedStats.chatName) || 'Conversation';
  const platform = cachedStats.platform || currentPlatform;
  const total = cachedStats.totalMessages || (cachedMessages ? cachedMessages.length : 0);

  const failedSteps = [];
  const runStep = (stepName, fn) => {
    try {
      hooks?.beforeStep?.(stepName);
      fn();
    } catch (err) {
      failedSteps.push(stepName);
      recordStepError(stepName, err);
    }
  };

  let checksFailedDuringRender = !!(cachedStats.integrity?.checksIncomplete || recordedErrors.length > 0);

  // 0a. Render Scan Complete Summary + Health Card (#complete-card)
  runStep('summary_card', () => {
    renderCompleteCard(cachedMessages || [], cachedStats, checksFailedDuringRender);
  });

  // 0. Partial Scan Banner Notice
  runStep('partial_banner', () => {
    const partialBanner = $('partial-scan-banner');
    if (cachedStats?.isPartial) {
      partialBanner?.classList.remove('hidden');
      let dateStr = 'earliest loaded date';
      if (cachedStats.oldestTimestamp) {
        const d = new Date(cachedStats.oldestTimestamp);
        if (!isNaN(d.getTime())) {
          dateStr = d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
        }
      } else if (cachedMessages && cachedMessages[0]?.timestamp) {
        dateStr = cachedMessages[0].timestamp.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
      }
      const dateEl = $('partial-oldest-date');
      if (dateEl) dateEl.textContent = `Partial export: starts from ${dateStr}`;
    } else {
      partialBanner?.classList.add('hidden');
    }
  });

  // 0b. Post-Scan Self-Check: Participant sanity check warnings & low confidence (non-fatal)
  runStep('sender_warning_banner', () => {
    const senderBanner = $('sender-warning-banner');
    const sanityWarnings = toList(cachedStats.integrity?.sanityCheck?.warnings);
    const lowConf = !!cachedStats.integrity?.direction?.lowConfidence;

    if (senderBanner) {
      const warningText = lowConf
        ? 'Could not tell for sure which messages are yours. Click "Confirm who is who" in the Participants tab.'
        : (sanityWarnings[0] || '');
      if (warningText) {
        const descEl = $('sender-warning-desc');
        if (descEl) descEl.textContent = warningText;
        senderBanner.classList.remove('hidden');
      } else {
        senderBanner.classList.add('hidden');
      }
    }
  });

  // 0c. Populate Export My Name, Rename Participants, and Live Mini Preview
  runStep('export_controls', () => {
    populateExportControls();
  });
  runStep('export_preview', () => {
    renderExportPreview(opts);
  });

  // 1. Top Bar
  runStep('top_bar', () => {
    if ($('top-chat-title')) $('top-chat-title').textContent = chatName;
    if ($('top-avatar')) $('top-avatar').textContent = getInitials(chatName);

    const badge = $('top-platform-badge');
    if (badge) {
      badge.textContent = platform;
      badge.classList.remove('hidden');
      badge.classList.toggle('messenger', platform === 'Messenger');
    }
  });

  // 2. Highlight Card (Total Messages, Recent Delta, Gold Line Chart)
  runStep('overview_stats', () => {
    if ($('hl-total-messages')) $('hl-total-messages').textContent = total.toLocaleString();

    const recentCount = calculateRecentDelta(cachedMessages);
    if ($('hl-delta-week')) $('hl-delta-week').textContent = `+${recentCount.toLocaleString()} recent`;

    // Grid Cards (Participants & Date Range)
    const pStats = computeParticipantStats(cachedMessages || []);
    if ($('card-participants-count')) {
      $('card-participants-count').textContent = pStats.length === 2
        ? '2 people'
        : (pStats.length === 1 ? '1 person' : `${pStats.length} people`);
    }

    const dStart = cachedStats.dateRange?.start ? new Date(cachedStats.dateRange.start) : null;
    const dEnd = cachedStats.dateRange?.end ? new Date(cachedStats.dateRange.end) : null;

    if (dStart && dEnd && isValidConversationDate(dStart) && isValidConversationDate(dEnd)) {
      const days = Math.max(1, Math.round((dEnd - dStart) / (1000 * 60 * 60 * 24)));
      if ($('card-days-span')) $('card-days-span').textContent = `${days.toLocaleString()} days`;

      const startFmt = dStart.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
      const endFmt = dEnd.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
      if ($('card-date-range')) $('card-date-range').textContent = `${startFmt} - ${endFmt}`;

      if ($('exp-from-date')) $('exp-from-date').value = dStart.toISOString().slice(0, 10);
      if ($('exp-to-date')) $('exp-to-date').value = dEnd.toISOString().slice(0, 10);
    } else {
      if ($('card-days-span')) $('card-days-span').textContent = 'Active';
      if ($('card-date-range')) $('card-date-range').textContent = 'Recent';
    }
  });

  runStep('gold_line_chart', () => {
    renderGoldLineChart(cachedMessages);
  });

  // Update Scan Integrity & Coverage Audit metrics in Settings Tab
  runStep('integrity_metrics', () => {
    if (cachedStats.integrity) {
      const audit = cachedStats.integrity.audit || {};
      const intCand = $('int-candidates');
      const intTot = $('int-total-msgs');
      const intSsn = $('int-sep-sys-noise');
      const intUnr = $('int-unrecognized');
      const intMer = $('int-overlap-merges');
      const intGap = $('int-no-overlap');
      const intDif = $('int-verify-diffs');
      const intRej = $('int-rejected-seps');
      const intVer = $('int-verify-status');
      const intTim = $('int-pass-timings');

      const unrecCount = audit.uniqueUnrecognized ?? audit.unrecognizedCount ?? 0;
      const gapCount = audit.gapsCount ?? cachedStats.integrity.noOverlapEvents ?? 0;
      const diffCount = audit.verificationDifferencesCount || 0;
      const recoveredCount = audit.verificationRecoveredCount || 0;
      const candUnique = audit.uniqueRowsSeen ?? audit.candidateRowsSeen ?? total;
      const sepUnique = audit.uniqueSeparators ?? audit.separatorsCount ?? 0;
      const sysUnique = audit.uniqueSystemRows ?? audit.systemRowsCount ?? 0;
      const noiseUnique = audit.uniqueNoiseRows ?? audit.noiseRowsCount ?? 0;
      const sightings = audit.sightings || null;
      const verifyStatus = audit.verificationStatus || (
        audit.verificationRan
          ? (recoveredCount > 0 ? `Recovered ${recoveredCount} message${recoveredCount === 1 ? '' : 's'}` : 'Ran')
          : 'Skipped'
      );

      if (intCand) {
        intCand.textContent = sightings?.rowSightings != null && sightings.rowSightings !== candUnique
          ? `${candUnique.toLocaleString()} (${sightings.rowSightings.toLocaleString()} sightings)`
          : candUnique.toLocaleString();
      }
      if (intTot) intTot.textContent = (cachedStats.integrity.totalCaptured || total).toLocaleString();
      if (intSsn) {
        intSsn.textContent = `${sepUnique} / ${sysUnique} / ${noiseUnique}`;
      }
      if (intUnr) {
        intUnr.textContent = unrecCount.toLocaleString();
        intUnr.style.color = unrecCount > 0 ? '#f59e0b' : 'var(--text-primary)';
      }
      if (intMer) intMer.textContent = (cachedStats.integrity.overlapMerges || 0).toLocaleString();
      if (intGap) {
        intGap.textContent = gapCount.toLocaleString();
        intGap.style.color = gapCount > 0 ? 'var(--negative)' : 'var(--text-primary)';
      }
      if (intDif) {
        intDif.textContent = diffCount.toLocaleString();
        intDif.style.color = diffCount > 0 ? '#f59e0b' : 'var(--text-primary)';
      }
      if (intRej) intRej.textContent = (cachedStats.integrity.rejectedSeparatorsCount || 0).toLocaleString();
      if (intVer) intVer.textContent = verifyStatus;
      if (intTim) intTim.textContent = formatAuditTimings(audit);
    }
  });

  // 4. Monthly Activity Breakdown Table
  runStep('activity_table', () => {
    renderActivityTable(cachedMessages, total);
  });

  // 5. Weekday Bar Chart
  runStep('weekday_chart', () => {
    renderWeekdayChart(cachedMessages);
  });

  // 6. Participants Tab List
  runStep('participants_tab', () => {
    renderParticipantsTab(cachedMessages || [], total);
  });

  // Update amber "Some checks could not run" card if any sub-step failed
  const hasAnyError = !!(failedSteps.length > 0 || checksFailedDuringRender || recordedErrors.length > 0);
  if (hasAnyError && failedSteps.length > 0) {
    try {
      renderCompleteCard(cachedMessages || [], cachedStats, true);
    } catch (_) { }
  }

  const checksBanner = $('checks-warning-banner');
  if (checksBanner) {
    checksBanner.classList.toggle('hidden', !hasAnyError);
    if (hasAnyError) {
      const checksDesc = $('checks-warning-desc');
      if (checksDesc) {
        const lastErr = recordedErrors[recordedErrors.length - 1];
        checksDesc.textContent = lastErr
          ? `Step "${lastErr.step}" failed (${lastErr.message}). Check Settings > Diagnostics.`
          : 'Scan finished, but one or more post-scan checks hit an error.';
      }
    }
  }

  // Render Diagnostics last so all recorded sub-step errors appear in Settings > Diagnostics
  runStep('diagnostics_log', () => {
    renderDiagnosticsLog(cachedStats.integrity);
  });

  runStep('switch_tab', () => {
    switchTab(activeRailTab);
  });
}

// ─── Scan Complete Card & Health Checklist ───────────────────────────────────

function getParticipantUiColor(p, idx) {
  if (p.isMe) return ME_UI_COLOR;
  if (idx === 0 || idx === 1) return CONTACT_UI_COLOR;
  return EXTRA_UI_COLORS[(idx - 1) % EXTRA_UI_COLORS.length];
}

function buildParticipantRowsHtml(pStats) {
  return pStats.map((p, idx) => {
    const color = getParticipantUiColor(p, idx);
    const initials = getInitials(p.name);
    const youBadge = p.isMe ? `<span class="you-badge">You</span>` : '';
    return `
      <div class="participant-item">
        <div class="participant-header">
          <div class="participant-name-wrap">
            <div class="avatar-tile sm" style="color:${color};">${escapeHtml(initials)}</div>
            <span class="participant-name">${escapeHtml(p.name)}</span>
            ${youBadge}
          </div>
          <div style="display:flex; align-items:center; gap:8px;">
            <span class="participant-count">${p.count.toLocaleString()}</span>
            <span class="participant-share">${p.sharePct}%</span>
          </div>
        </div>
        <div class="flat-progress-track">
          <div class="flat-progress-bar" style="width:${p.sharePct}%; background:${color};"></div>
        </div>
      </div>
    `;
  }).join('');
}

function renderCompleteCard(messages, stats, checksIncompleteFlag = false) {
  const total = stats.totalMessages || messages.length || 0;
  if ($('cc-total')) $('cc-total').textContent = total.toLocaleString();

  const dStart = stats.dateRange?.start ? formatShortDate(stats.dateRange.start) : null;
  const dEnd = stats.dateRange?.end ? formatShortDate(stats.dateRange.end) : null;
  if ($('cc-range')) {
    $('cc-range').textContent = (dStart && dEnd) ? `${dStart} – ${dEnd}` : 'Recent';
  }

  const pStats = computeParticipantStats(messages);
  const ccPart = $('cc-participants');
  if (ccPart) {
    ccPart.innerHTML = buildParticipantRowsHtml(pStats);
  }

  const ccSplit = $('cc-split');
  if (ccSplit) {
    ccSplit.innerHTML = pStats.map((p, idx) => {
      const color = getParticipantUiColor(p, idx);
      return `<div class="split-seg" style="width:${Math.max(2, p.sharePct)}%; background:${color};" title="${escapeHtml(p.name)}: ${p.sharePct}%"></div>`;
    }).join('');
  }

  // Coverage Audit & Scan Health Checklist
  const audit = stats.integrity?.audit || {};
  const unrecCount = audit.uniqueUnrecognized ?? audit.unrecognizedCount ?? 0;
  const gapCount = audit.gapsCount ?? stats.integrity?.noOverlapEventsCount ?? 0;
  const diffCount = audit.verificationDifferencesCount || 0;
  const recoveredCount = audit.verificationRecoveredCount || 0;
  const sepCount = audit.uniqueSeparators ?? audit.separatorsCount ?? 0;
  const sysCount = audit.uniqueSystemRows ?? audit.systemRowsCount ?? 0;
  const noiseCount = audit.uniqueNoiseRows ?? audit.noiseRowsCount ?? 0;
  const candCount = audit.uniqueRowsSeen ?? audit.candidateRowsSeen ?? total;
  const unrecSampleSummaries = (audit.unrecognizedSamples || []).slice(0, 3).map(s => {
    const dir = s.direction || 'unknown';
    const guess = s.typeGuess || 'unknown';
    const label = (Array.isArray(s.labels) && (s.labels.find(l => !/^role=/.test(l)) || s.labels[0])) || s.ariaLabel || '';
    const ctx = [
      s.prevMessageText ? `after "${String(s.prevMessageText).slice(0, 30)}"` : '',
      s.nextMessageText ? `before "${String(s.nextMessageText).slice(0, 30)}"` : ''
    ].filter(Boolean).join(' ');
    return `${dir} ${guess}${label ? ` (${String(label).slice(0, 50)})` : ''}${ctx ? ` ${ctx}` : ''}`;
  });

  const verifyStatus = audit.verificationStatus || (
    audit.verificationRan
      ? (recoveredCount > 0 ? `Recovered ${recoveredCount} message${recoveredCount === 1 ? '' : 's'}` : 'Ran')
      : 'Skipped'
  );
  const verifyLabel = audit.verificationLabel || (
    audit.verificationRan
      ? (recoveredCount > 0
        ? `Verification: recovered ${recoveredCount} message${recoveredCount === 1 ? '' : 's'}`
        : (diffCount > 0 ? `Verification: ran (${diffCount} differences)` : 'Verification: ran cleanly (0 differences)'))
      : 'Verification: not needed'
  );

  if ($('cc-aud-candidates')) $('cc-aud-candidates').textContent = candCount.toLocaleString();
  if ($('cc-aud-exported')) $('cc-aud-exported').textContent = total.toLocaleString();
  if ($('cc-aud-nonmsg')) $('cc-aud-nonmsg').textContent = `${sepCount} / ${sysCount} / ${noiseCount}`;
  if ($('cc-aud-unrec')) $('cc-aud-unrec').textContent = unrecCount.toLocaleString();
  if ($('cc-aud-gaps')) $('cc-aud-gaps').textContent = gapCount.toLocaleString();
  if ($('cc-aud-diffs')) $('cc-aud-diffs').textContent = diffCount.toLocaleString();
  if ($('cc-aud-verify-status')) $('cc-aud-verify-status').textContent = verifyStatus;
  if ($('cc-aud-timings')) $('cc-aud-timings').textContent = formatAuditTimings(audit);
  if ($('cc-verify-note')) $('cc-verify-note').textContent = verifyLabel;

  const dirLow = !!stats.integrity?.direction?.lowConfidence;
  let checksFailed = !!(checksIncompleteFlag || stats.integrity?.checksIncomplete);
  const hasIncompleteAudit = (unrecCount > 0 || gapCount > 0 || diffCount > 0 || dirLow || checksFailed);

  const completeCard = $('complete-card');
  const checkIcon = $('complete-check-icon');
  const completeTitle = $('complete-title');
  const incompleteBanner = $('cc-incomplete-banner');
  const incompleteReason = $('cc-incomplete-reason');
  const debugBar = $('cc-debug-bar');

  if (completeCard) completeCard.classList.toggle('is-incomplete', hasIncompleteAudit);
  if (checkIcon) checkIcon.textContent = hasIncompleteAudit ? '!' : '✓';
  if (completeTitle) {
    completeTitle.textContent = hasIncompleteAudit ? 'Scan may be incomplete' : 'Scan complete';
  }
  if (incompleteBanner) {
    incompleteBanner.classList.toggle('hidden', !hasIncompleteAudit);
  }
  if (incompleteReason && hasIncompleteAudit) {
    const reasons = [];
    if (unrecCount > 0) {
      const sampleHint = unrecSampleSummaries.length > 0 ? `: ${unrecSampleSummaries.join('; ')}` : '';
      reasons.push(`${unrecCount} unrecognized row(s)${sampleHint}`);
    }
    if (gapCount > 0) reasons.push(`${gapCount} scroll gap(s)`);
    if (diffCount > 0) reasons.push(`${diffCount} verification diff(s)`);
    if (dirLow) reasons.push('low sender confidence');
    if (checksFailed) reasons.push('incomplete diagnostics');
    incompleteReason.textContent = `${reasons.join(', ')}. Copy the debug report or review Settings > Diagnostics.`;
  }
  if (debugBar) {
    debugBar.classList.toggle('hidden', !hasIncompleteAudit);
  }

  const healthList = $('health-list');
  if (!healthList) return;

  let items = [];

  try {
    const isPartial = !!stats.isPartial;
    const hasValidDates = !!(dStart && dEnd);
    const dupCount = stats.integrity?.duplicates || 0;

    items = [
      {
        ok: !dirLow,
        title: !dirLow
          ? `Both participants identified (${pStats.map(p => p.name).slice(0, 2).join(' & ') || 'OK'})`
          : 'Sender direction needs confirmation',
        detail: !dirLow
          ? 'Outgoing and incoming messages were separated with high signal agreement.'
          : 'Click "Confirm who is who" to verify which side of the conversation is yours.'
      },
      {
        ok: hasValidDates,
        title: hasValidDates ? 'All dates valid' : 'Some timestamps were estimated',
        detail: hasValidDates
          ? `Every message has a verified timestamp between ${dStart} and ${dEnd}.`
          : 'Some messages did not expose an exact date header and inherited neighboring dates.'
      },
      {
        ok: !isPartial && gapCount === 0,
        title: !isPartial && gapCount === 0
          ? 'Full chat history reached'
          : (gapCount > 0 ? `${gapCount} scroll gap(s) detected` : `Partial history (from ${dStart || 'loaded point'})`),
        detail: !isPartial && gapCount === 0
          ? 'The scanner verified the top of the conversation and every scroll overlap matched cleanly.'
          : (gapCount > 0
            ? 'One or more snapshots had no overlap even after backtracking. Copy the debug report or rescan.'
            : 'Only messages loaded up to the starting point were included; Rescan to load older messages.')
      },
      {
        ok: dupCount === 0,
        title: dupCount === 0 ? 'No duplicate messages' : `${dupCount} duplicate row(s) merged`,
        detail: 'Overlapping scroll snapshots were deduplicated using message IDs and content fingerprints.'
      }
    ];

    if (unrecCount > 0) {
      const sampleDetail = unrecSampleSummaries.length > 0
        ? ` Examples: ${unrecSampleSummaries.join('; ')}.`
        : '';
      items.push({
        ok: false,
        title: `${unrecCount} unrecognized row(s) preserved`,
        detail: `Rows with unknown DOM structure were exported as "[Unrecognized message]" instead of being dropped.${sampleDetail} Copy debug report for pruned DOM skeletons.`
      });
    }
    if (diffCount > 0) {
      items.push({
        ok: false,
        title: `Pass 2 found ${diffCount} difference(s) (${recoveredCount} recovered)`,
        detail: 'The verification pass differed from Pass 1; missing rows were merged into the master list at their anchored positions.'
      });
    }
  } catch (err) {
    checksFailed = true;
    appendDiagnosticsWarning(`Scan health check error: ${err.message}`);
  }

  if (checksFailed) {
    items.push({
      ok: false,
      title: 'Some checks could not run',
      detail: stats.integrity?.diagnosticsError || 'A diagnostic check encountered an unexpected format and was skipped safely. See Settings > Diagnostics for details.'
    });
  }

  healthList.innerHTML = '';
  for (const item of items) {
    const li = document.createElement('li');
    li.className = 'health-item';
    li.setAttribute('role', 'button');
    li.setAttribute('tabindex', '0');
    li.setAttribute('aria-expanded', 'false');
    li.innerHTML = `
      <div class="health-row">
        <span class="health-icon ${item.ok ? 'ok' : 'warn'}" aria-hidden="true">${item.ok ? '✓' : '⚠'}</span>
        <span>${escapeHtml(item.title)}</span>
      </div>
      <div class="health-detail hidden">${escapeHtml(item.detail)}</div>
    `;
    const toggleDetail = () => {
      const det = li.querySelector('.health-detail');
      if (!det) return;
      const hidden = det.classList.toggle('hidden');
      li.setAttribute('aria-expanded', hidden ? 'false' : 'true');
    };
    li.addEventListener('click', toggleDetail);
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleDetail();
      }
    });
    healthList.appendChild(li);
  }
}

function renderDiagnosticsLog(integrity) {
  const el = $('diag-direction-log');
  if (!el) return;
  try {
    let text = `ChatFlow v${getExtensionVersion()}\n${formatDirectionDiagnostics(integrity)}`;
    const audit = integrity?.audit;
    if (audit) {
      const uRows = audit.uniqueRowsSeen ?? audit.candidateRowsSeen ?? 0;
      const uSep = audit.uniqueSeparators ?? audit.separatorsCount ?? 0;
      const uSys = audit.uniqueSystemRows ?? audit.systemRowsCount ?? 0;
      const uRep = audit.uniqueReplyLabels ?? audit.replyLabelsCount ?? 0;
      const uNoise = audit.uniqueNoiseRows ?? audit.noiseRowsCount ?? 0;
      const uUnrec = audit.uniqueUnrecognized ?? audit.unrecognizedCount ?? 0;
      const sightings = audit.sightings;
      const sightStr = sightings ? ` (sightings: rows=${sightings.rowSightings ?? 0}, seps=${sightings.separatorSightings ?? 0}, noise=${sightings.noiseSightings ?? 0}, unrec=${sightings.unrecognizedSightings ?? 0})` : '';
      const verStatus = audit.verificationStatus || (audit.verificationRan ? 'Ran' : 'Skipped');
      text += `\n\n--- Coverage Audit ---\n` +
        `Unique candidates: ${uRows}${sightStr}\n` +
        `Exported total: ${audit.finalTotal ?? audit.messagesExported ?? 0}\n` +
        `Separators: ${uSep}, System: ${uSys}, Reply labels: ${uRep}, Noise: ${uNoise}, Other icons: ${audit.otherIconMessagesCount ?? 0}\n` +
        `Unrecognized: ${uUnrec}\n` +
        `Scroll gaps: ${audit.gapsCount ?? 0} (retries: ${audit.gapRetriesCount ?? 0})\n` +
        `Verification: ${verStatus} (diffs: ${audit.verificationDifferencesCount ?? 0}, recovered: ${audit.verificationRecoveredCount ?? 0}, ran: ${!!audit.verificationRan})\n` +
        `Pass timings: ${formatAuditTimings(audit)}\n` +
        `Date order violations: ${(audit.dateOrderViolations || []).length}\n` +
        `Audit status: ${audit.healthy ? 'HEALTHY' : 'INCOMPLETE / REVIEW RECOMMENDED'}`;
    }
    if (recordedErrors.length > 0) {
      text += `\n\n--- Error Log (${recordedErrors.length}) ---\n` +
        recordedErrors.map(e => `[${e.timestamp}] [${e.step}] ${e.message}${e.stack ? `\n${e.stack}` : ''}`).join('\n');
    }
    el.textContent = text;
  } catch (err) {
    el.textContent = `Diagnostics log error: ${err.message}`;
    if (cachedStats?.integrity) {
      cachedStats.integrity.checksIncomplete = true;
      cachedStats.integrity.diagnosticsError = err.message;
    }
  }
}

// ─── Inline SVG Gold Line Chart (with 2-Participant Split Lines) ─────────────

function renderGoldLineChart(messages) {
  const container = $('hl-line-chart-box');
  if (!container || !messages || messages.length === 0) return;

  const buckets = {};
  const meBuckets = {};
  const themBuckets = {};
  messages.forEach(m => {
    if (m.timestamp) {
      const d = (m.timestamp instanceof Date) ? m.timestamp : new Date(m.timestamp);
      if (isValidConversationDate(d)) {
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        buckets[key] = (buckets[key] || 0) + 1;
        if (m.isMe || m.isOutgoing) meBuckets[key] = (meBuckets[key] || 0) + 1;
        else themBuckets[key] = (themBuckets[key] || 0) + 1;
      }
    }
  });

  const keys = Object.keys(buckets).sort();
  if (keys.length < 2) {
    const firstKey = keys[0] || '2026-01';
    keys.push(firstKey);
  }

  const values = keys.map(k => buckets[k] || 0);
  const meVals = keys.map(k => meBuckets[k] || 0);
  const themVals = keys.map(k => themBuckets[k] || 0);

  const w = 140;
  const h = 48;
  const max = Math.max(...values, 1);
  const min = 0;
  const range = max - min || 1;

  const buildPath = (arr) => {
    const pts = arr.map((val, idx) => {
      const x = (idx / (arr.length - 1)) * (w - 16) + 8;
      const y = h - ((val - min) / range) * (h - 16) - 8;
      return { x, y };
    });
    let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
    for (let i = 1; i < pts.length; i++) {
      const prev = pts[i - 1];
      const curr = pts[i];
      const cx = ((prev.x + curr.x) / 2).toFixed(1);
      d += ` C ${cx} ${prev.y.toFixed(1)}, ${cx} ${curr.y.toFixed(1)}, ${curr.x.toFixed(1)} ${curr.y.toFixed(1)}`;
    }
    return d;
  };

  const dMe = buildPath(meVals);
  const dThem = buildPath(themVals);

  container.innerHTML = `
    <svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
      <path d="${dThem}" fill="none" stroke="${CONTACT_UI_COLOR}" stroke-width="2" stroke-linecap="round" opacity="0.85" />
      <path d="${dMe}" fill="none" stroke="${ME_UI_COLOR}" stroke-width="2.5" stroke-linecap="round" />
    </svg>
  `;
}

// ─── Activity Table Breakdown ─────────────────────────────────────────────────

function renderActivityTable(messages, total) {
  const tbody = $('activity-table-body');
  if (!tbody) return;
  tbody.innerHTML = '';

  if (!messages || messages.length === 0) return;

  const buckets = {};
  messages.forEach(m => {
    if (m.timestamp) {
      const d = (m.timestamp instanceof Date) ? m.timestamp : new Date(m.timestamp);
      if (isValidConversationDate(d)) {
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        buckets[key] = (buckets[key] || 0) + 1;
      }
    }
  });

  const keys = Object.keys(buckets).sort().reverse().slice(0, 5);

  let prevCount = null;
  keys.forEach(key => {
    const count = buckets[key];
    const share = total > 0 ? ((count / total) * 100).toFixed(1) : '0';

    let changeHtml = '<span style="color:var(--text-muted);">-</span>';
    if (prevCount !== null) {
      const diff = count - prevCount;
      const pct = prevCount > 0 ? ((diff / prevCount) * 100).toFixed(0) : '0';
      if (diff >= 0) {
        changeHtml = `<span class="val-positive">+${pct}%</span>`;
      } else {
        changeHtml = `<span class="val-negative">${pct}%</span>`;
      }
    }
    prevCount = count;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(key)}</td>
      <td>${count.toLocaleString()}</td>
      <td>${share}%</td>
      <td>${changeHtml}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ─── Messages by Weekday Chart ────────────────────────────────────────────────

function renderWeekdayChart(messages) {
  const container = $('weekday-chart-container');
  if (!container) return;
  container.innerHTML = '';

  const dayCounts = [0, 0, 0, 0, 0, 0, 0];
  const dayLabels = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

  (messages || []).forEach(m => {
    if (m.timestamp) {
      const d = (m.timestamp instanceof Date) ? m.timestamp : new Date(m.timestamp);
      if (isValidConversationDate(d)) {
        dayCounts[d.getDay()]++;
      }
    }
  });

  const maxVal = Math.max(...dayCounts, 1);
  const peakIdx = dayCounts.indexOf(maxVal);

  dayLabels.forEach((lbl, idx) => {
    const cnt = dayCounts[idx];
    const heightPct = Math.max(10, Math.round((cnt / maxVal) * 100));
    const isPeak = idx === peakIdx && cnt > 0;

    const col = document.createElement('div');
    col.className = 'weekday-col';
    col.innerHTML = `
      <div class="weekday-bar ${isPeak ? 'peak' : ''}" style="height:${heightPct}%;" title="${lbl}: ${cnt.toLocaleString()} messages"></div>
      <span class="weekday-lbl">${lbl}</span>
    `;
    container.appendChild(col);
  });
}

// ─── Participants Tab List & Direction Actions ────────────────────────────────

function renderParticipantsTab(messages = [], _total = 1) {
  const container = $('tab-participants-list');
  if (!container) return;

  const pStats = computeParticipantStats(messages);
  if (pStats.length === 0) {
    container.innerHTML = '<div style="color:var(--text-muted); padding:12px; font-size:12px;">No participants found.</div>';
    return;
  }

  container.innerHTML = buildParticipantRowsHtml(pStats);

  // Direction check status bar
  const dirBox = $('direction-status');
  const dirIcon = $('direction-status-icon');
  const dirText = $('direction-status-text');
  const btnConfirm = $('btn-confirm-who');
  const lowConf = !!cachedStats?.integrity?.direction?.lowConfidence;

  if (dirBox && dirIcon && dirText) {
    dirBox.classList.toggle('ok', !lowConf);
    dirBox.classList.toggle('warn', lowConf);
    dirIcon.textContent = lowConf ? '⚠' : '✓';
    dirText.textContent = lowConf
      ? 'Could not tell which side is you — please confirm'
      : 'Direction check passed';
    if (btnConfirm) {
      btnConfirm.classList.toggle('hidden', !lowConf);
    }
  }
}

async function applyInMemoryDirectionUpdate({ swap = false, meSide = null, myName = null } = {}) {
  if (!cachedMessages || cachedMessages.length === 0) return;

  if (meSide === 'left' || meSide === 'right') {
    applySideChoice(cachedMessages, meSide);
  } else if (swap) {
    swapSides(cachedMessages);
  }

  const chatName = sanitizeChatName(cachedStats?.chatName) || 'Conversation';
  const platform = cachedStats?.platform || currentPlatform;
  const chatType = cachedStats?.chatType || cachedStats?.integrity?.chatType || 'one-to-one';
  const rawOverride = myName !== null ? myName : ($('exp-my-name')?.value || $('setting-my-name')?.value || $('scan-ready-my-name')?.value || $('ready-my-name')?.value || '');
  const effectiveMyName = cleanUserMyNameSetting(rawOverride);
  const validPageProfile = validatePersonName(cachedStats?.integrity?.pageDetectedMyName || cachedStats?.integrity?.detectedMyName || lastPageDetectedMyName, { contactName: chatName }) || null;

  const names = finalizeSenders(cachedMessages, {
    chatType,
    chatName,
    profileName: validPageProfile,
    myNameOverride: effectiveMyName
  });

  const senderCounts = {};
  for (const m of cachedMessages) {
    if (m.type === 'system') continue;
    senderCounts[m.sender] = (senderCounts[m.sender] || 0) + 1;
  }

  const conf = evaluateConfidence(cachedMessages, chatType);
  const warnings = participantWarnings(cachedMessages, chatType, senderCounts);

  if (cachedStats) {
    cachedStats.senderCounts = senderCounts;
    if (cachedStats.integrity) {
      cachedStats.integrity.senderCounts = senderCounts;
      cachedStats.integrity.detectedMyName = names.myName;
      if (cachedStats.integrity.direction) {
        cachedStats.integrity.direction.lowConfidence = false;
        cachedStats.integrity.direction.confirmedByUser = true;
        cachedStats.integrity.direction.meCount = conf.meCount;
        cachedStats.integrity.direction.themCount = conf.themCount;
      }
      if (cachedStats.integrity.sanityCheck) {
        cachedStats.integrity.sanityCheck.warnings = warnings;
        cachedStats.integrity.sanityCheck.myName = names.myName;
        cachedStats.integrity.sanityCheck.contactName = names.contactName;
      }
    }
  }

  // Persist per-chat choice (no message text)
  const prefs = await loadChatPrefs(platform, chatName);
  await saveChatPrefs(platform, chatName, {
    myName: effectiveMyName,
    meSide: meSide || (swap ? null : prefs.meSide),
    swapped: swap ? !prefs.swapped : !!prefs.swapped,
    confirmed: true
  });

  // Update session storage so reload preserves the updated split
  await chrome.runtime.sendMessage({
    type: 'SCAN_COMPLETE',
    payload: {
      messages: cachedMessages,
      chatName,
      platform,
      chatType,
      isPartial: !!cachedStats?.isPartial,
      oldestTimestamp: cachedStats?.oldestTimestamp || null,
      integrity: cachedStats?.integrity || null
    }
  }).catch(() => { });

  renderCompleteDashboard();
}

function openConfirmDirectionDialog() {
  const backdrop = $('direction-backdrop');
  if (!backdrop || !cachedMessages) return;

  const samples = sampleSides(cachedMessages, 3);
  const renderSamples = (el, list) => {
    if (!el) return;
    if (!list || list.length === 0) {
      el.innerHTML = '<div class="dir-sample-bubble" style="color:var(--text-muted);">No text samples on this side</div>';
      return;
    }
    el.innerHTML = list.map(s => {
      const t = s.timestamp ? formatExportTime(s.timestamp, 'auto', false, currentPlatform) : '';
      return `
        <div class="dir-sample-bubble">
          <span>${escapeHtml(s.text)}</span>
          ${t ? `<span class="dir-sample-time">${escapeHtml(t)}</span>` : ''}
        </div>
      `;
    }).join('');
  };

  renderSamples($('dir-samples-left'), samples.left);
  renderSamples($('dir-samples-right'), samples.right);

  backdrop.classList.add('open');
  $('btn-right-is-me')?.focus();
}

function closeConfirmDirectionDialog() {
  $('direction-backdrop')?.classList.remove('open');
}

// ─── Recent Delta Calculation ─────────────────────────────────────────────────

function calculateRecentDelta(messages) {
  if (!messages || messages.length === 0) return 0;
  let lastDate = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].timestamp) {
      const d = (messages[i].timestamp instanceof Date) ? messages[i].timestamp : new Date(messages[i].timestamp);
      if (isValidConversationDate(d)) {
        lastDate = d;
        break;
      }
    }
  }
  if (!lastDate) return 0;

  const sevenDaysBefore = new Date(lastDate.getTime() - 7 * 24 * 60 * 60 * 1000);
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].timestamp) {
      const d = (messages[i].timestamp instanceof Date) ? messages[i].timestamp : new Date(messages[i].timestamp);
      if (isValidConversationDate(d) && d.getTime() >= sevenDaysBefore.getTime()) {
        count++;
      }
    }
  }
  return count;
}

// ─── Export Options, Preview & Handlers ───────────────────────────────────────

function populateExportControls() {
  const platform = cachedStats?.platform || currentPlatform;
  const pKey = normalizePlatformKey(platform);
  const contactName = cachedStats?.chatName || '';
  const lsSaved = cleanUserMyNameSetting((typeof localStorage !== 'undefined' && localStorage.getItem('chatflow_my_name')) || '');
  const savedMyName = cleanUserMyNameSetting(cachedMyNameByPlatform[pKey] || '') || lsSaved;
  const rawDetected = cachedStats?.integrity?.pageDetectedMyName || cachedStats?.integrity?.detectedMyName || lastPageDetectedMyName || '';
  const validDetected = validatePersonName(rawDetected, { contactName }) || '';
  const displayVal = savedMyName || validDetected || '';

  const activeId = typeof document !== 'undefined' ? (document.activeElement?.id || '') : '';
  syncMyNameInputs(displayVal, ['ready-my-name', 'scan-ready-my-name', 'exp-my-name', 'setting-my-name'].includes(activeId) ? activeId : null);

  const renameList = $('exp-rename-list');
  if (renameList && cachedStats?.senderCounts) {
    renameList.innerHTML = '';
    for (const name of Object.keys(cachedStats.senderCounts)) {
      if (!name || name === 'System') continue;
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; align-items:center; gap:6px;';
      const lbl = document.createElement('span');
      lbl.textContent = name;
      lbl.style.cssText = 'flex:1; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'flat-input exp-rename-input';
      inp.dataset.origName = name;
      inp.placeholder = 'Nickname';
      inp.style.cssText = 'flex:1; font-size:11px; padding:4px 6px;';
      inp.addEventListener('input', renderExportPreview);
      row.appendChild(lbl);
      row.appendChild(inp);
      renameList.appendChild(row);
    }
  }
}

function resetGroupBySenderToggle({ refreshPreview = false } = {}) {
  const el = $('exp-group-sender');
  if (el) el.checked = false;
  if (refreshPreview && Array.isArray(cachedMessages) && cachedMessages.length > 0) {
    try {
      renderExportPreview();
    } catch (_) { }
  }
}

async function migrateGroupBySenderSetting() {
  try {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('chatflow_group_by_sender')) {
      localStorage.setItem('chatflow_group_by_sender', 'false');
    }
  } catch (_) { }

  resetGroupBySenderToggle();

  if (typeof chrome === 'undefined' || !chrome.storage?.local) return false;
  try {
    const res = await chrome.storage.local.get([
      'chatflow_group_sender_migrated_v1',
      'chatflow_group_by_sender',
      'groupBySender',
      'chatflow_export_options'
    ]);
    const updates = {};
    let changed = false;

    if (res?.chatflow_group_by_sender !== undefined && res.chatflow_group_by_sender !== false) {
      updates.chatflow_group_by_sender = false;
      changed = true;
    }
    if (res?.groupBySender !== undefined && res.groupBySender !== false) {
      updates.groupBySender = false;
      changed = true;
    }
    if (
      res?.chatflow_export_options &&
      typeof res.chatflow_export_options === 'object' &&
      res.chatflow_export_options.groupBySender === true
    ) {
      updates.chatflow_export_options = {
        ...res.chatflow_export_options,
        groupBySender: false
      };
      changed = true;
    }
    if (!res?.chatflow_group_sender_migrated_v1) {
      updates.chatflow_group_sender_migrated_v1 = true;
      changed = true;
    }
    if (changed) {
      await chrome.storage.local.set(updates);
    }
    return changed;
  } catch (_) {
    return false;
  }
}

function getExportOptions(overrides = {}) {
  const isCustom = $('seg-filter')?.classList?.contains('active');
  const renameMap = {};
  if (typeof document !== 'undefined' && typeof document.querySelectorAll === 'function') {
    document.querySelectorAll('.exp-rename-input').forEach(inp => {
      const orig = inp.dataset?.origName;
      const val = (inp.value || '').trim();
      if (orig && val && val !== orig) {
        renameMap[orig] = val;
      }
    });
  }

  const chatName = cachedStats?.chatName || 'Conversation';
  const platform = cachedStats?.platform || currentPlatform;
  const rawDetected = cachedStats?.integrity?.pageDetectedMyName || cachedStats?.integrity?.detectedMyName || lastPageDetectedMyName || '';
  const validDetected = validatePersonName(rawDetected, { contactName: chatName }) || '';
  const typedMyName = cleanUserMyNameSetting($('exp-my-name')?.value || $('scan-ready-my-name')?.value || $('ready-my-name')?.value || $('setting-my-name')?.value || '');

  return normalizeExportOptions({
    layout: $('exp-layout')?.value || 'bubbles',
    colorMode: $('exp-color-mode')?.value || 'color',
    dateFormat: $('exp-date-format')?.value || 'auto',
    timeFormat: $('exp-time-format')?.value || 'auto',
    pageSize: $('exp-page-size')?.value || 'A4',
    fontSize: $('exp-font-size')?.value || 'M',
    myName: typedMyName,
    detectedMyName: validDetected,
    renameMap,
    includeSummary: $('exp-summary')?.checked ?? true,
    includeTimestamps: $('exp-timestamps')?.checked ?? true,
    groupBySender: Boolean($('exp-group-sender')?.checked === true),
    showReactions: $('exp-reactions')?.checked ?? true,
    showMediaLabels: $('exp-media-labels')?.checked ?? true,
    showSystemMessages: $('exp-system-messages')?.checked ?? true,
    hideQuotedReplies: $('exp-hide-quotes')?.checked ?? false,
    dateRangeStart: isCustom ? ($('exp-from-date')?.value || null) : null,
    dateRangeEnd: isCustom ? ($('exp-to-date')?.value || null) : null,
    chatName,
    platform,
    chatType: cachedStats?.chatType || cachedStats?.integrity?.chatType || 'one-to-one',
    isPartial: !!cachedStats?.isPartial,
    oldestTimestamp: cachedStats?.oldestTimestamp || null
  }, overrides);
}

function renderExportPreview(optionsOverride = undefined) {
  const box = $('exp-live-preview');
  if (!box) return;
  if (!cachedMessages || cachedMessages.length === 0) {
    box.textContent = 'Scan a chat to preview the export layout.';
    return;
  }

  const options = optionsOverride !== undefined
    ? normalizeExportOptions(getExportOptions(), optionsOverride)
    : getExportOptions();
  const prepared = prepareMessagesForExport(cachedMessages, options);
  const { days, participants } = groupMessagesForExport(prepared.slice(0, 30), {
    groupBySender: options.groupBySender,
    colorMode: options.colorMode
  });
  const colorBySender = new Map(participants.map(p => [p.name, p.colorHex]));
  const isGroup = participants.length > 2 || options.chatType === 'group';
  const resolvedMyName = resolveMyExportName({
    myNameSetting: options.myName,
    detectedName: options.detectedMyName,
    contactName: options.chatName
  });

  box.innerHTML = '';
  let blocksShown = 0;

  for (const day of days) {
    if (blocksShown >= 5) break;
    const dateEl = document.createElement('div');
    dateEl.style.cssText = 'text-align:center; font-size:10px; color:var(--text-muted); margin:4px 0 6px; font-weight:600;';
    dateEl.textContent = day.dayLabel;
    box.appendChild(dateEl);

    for (const block of day.blocks) {
      if (blocksShown >= 5) break;
      blocksShown++;

      if (block.isSystem) {
        const sys = document.createElement('div');
        sys.style.cssText = 'text-align:center; font-style:italic; font-size:10px; color:var(--text-muted); margin:4px 0;';
        sys.textContent = block.items[0]?.msg?.text || '';
        box.appendChild(sys);
        continue;
      }

      const wrap = document.createElement('div');
      wrap.style.cssText = options.layout === 'bubbles'
        ? `margin-bottom:6px; padding:5px 8px; border-radius:8px; max-width:85%; ${block.isMe ? 'margin-left:auto; background:rgba(45,184,122,0.14);' : 'margin-right:auto; background:rgba(128,128,128,0.12);'}`
        : 'margin-bottom:6px;';

      const hdr = document.createElement('div');
      hdr.style.cssText = 'font-size:10.5px; margin-bottom:2px;';
      const nameSpan = document.createElement('strong');
      nameSpan.style.color = `#${block.colorHex}`;
      nameSpan.textContent = block.sender;
      hdr.appendChild(nameSpan);

      if (options.includeTimestamps && block.firstTimestamp) {
        const tSpan = document.createElement('span');
        tSpan.style.cssText = 'color:var(--text-muted); font-size:9.5px; margin-left:6px;';
        tSpan.textContent = formatExportTime(block.firstTimestamp, options.timeFormat, block.items[0]?.msg?.timestampApproximate, options.platform);
        hdr.appendChild(tSpan);
      }
      wrap.appendChild(hdr);

      for (const item of block.items) {
        const { msg } = item;
        const isLike = msg.type === 'like';
        const isMedia = !isLike && msg.type && msg.type !== 'text' && msg.type !== 'deleted';
        if (isMedia && !options.showMediaLabels) continue;

        if (!options.hideQuotedReplies && msg.replyTo && typeof msg.replyTo === 'object') {
          const parts = formatReplyQuoteParts(msg.replyTo, msg, {
            myName: resolvedMyName,
            chatName: options.chatName,
            isGroup,
            colorMode: options.colorMode,
            colorBySender
          });
          if (parts && (parts.headerText || parts.bodyText)) {
            const qDiv = document.createElement('div');
            qDiv.style.cssText = `border-left:3px solid #${parts.borderColorHex}; background:rgba(0,0,0,0.08); padding:4px 6px; border-radius:4px; margin:2px 0 4px;`;
            const qHdr = document.createElement('div');
            qHdr.style.cssText = 'font-size:8.5pt; font-weight:700; color:#6B7280;';
            qHdr.textContent = parts.headerText;
            qDiv.appendChild(qHdr);
            if (parts.bodyText) {
              const qTxt = document.createElement('div');
              qTxt.style.cssText = 'font-size:9pt; font-style:italic; color:#6B7280;';
              qTxt.textContent = parts.bodyText;
              qDiv.appendChild(qTxt);
            }
            wrap.appendChild(qDiv);
          }
        }

        const line = document.createElement('div');
        if (isLike) {
          line.style.cssText = 'font-size:10.5pt;';
          const thumbSpan = document.createElement('span');
          thumbSpan.textContent = msg.text || '👍';
          line.appendChild(thumbSpan);
          if (options.showMediaLabels) {
            const labelSpan = document.createElement('span');
            labelSpan.style.cssText = 'font-style:italic; color:var(--text-muted); margin-left:4px;';
            labelSpan.textContent = 'Like';
            line.appendChild(labelSpan);
          }
          if (msg.isEdited) {
            line.appendChild(document.createTextNode(' (edited)'));
          }
        } else {
          line.style.cssText = (msg.type === 'deleted' || isMedia) ? 'font-style:italic; color:var(--text-muted); font-size:10.5pt;' : 'font-size:10.5pt;';
          line.textContent = msg.type === 'deleted'
            ? 'This message was deleted'
            : (isMedia ? formatMediaChip(msg) : (msg.text || '')) + (msg.isEdited ? ' (edited)' : '');
        }
        wrap.appendChild(line);

        const rxList = cleanReactionsList(toList(msg.reactions), { myName: resolvedMyName });
        if (options.showReactions && rxList.length) {
          const rx = document.createElement('div');
          rx.style.cssText = 'font-size:9.5px; color:var(--text-muted);';
          rx.textContent = `Reactions: ${rxList.join(' ')}`;
          wrap.appendChild(rx);
        }
      }
      box.appendChild(wrap);
    }
  }
}

async function handleExportDocx(skipConfidencePrompt = false) {
  if (!cachedMessages) return;

  if (!skipConfidencePrompt && cachedStats?.integrity?.direction?.lowConfidence) {
    pendingExportAction = 'docx';
    openConfirmDirectionDialog();
    return;
  }

  const btn = $('btn-export-docx');
  const origText = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Generating .docx...';
  }

  try {
    const options = getExportOptions();
    await exportDocx(cachedMessages, cachedStats, options, ({ percent, fallbackToCompact }) => {
      if (!btn) return;
      if (percent >= 90) {
        btn.textContent = 'Packing Word file...';
      } else if (percent > 0) {
        btn.textContent = `Generating .docx (${percent}%)...`;
      }
      if (fallbackToCompact) {
        showToast('Large chat (>20k): using Compact layout');
      }
    });
    showToast('Saved to Downloads');
  } catch (err) {
    recordStepError('export_docx', err);
    showToast(`Export error: ${err.message}`);
  } finally {
    if (btn) {
      btn.innerHTML = origText;
      btn.disabled = false;
    }
    resetGroupBySenderToggle({ refreshPreview: true });
  }
}

function handleExportPdf() {
  if (!cachedMessages) return;
  try {
    const options = getExportOptions();
    exportPdf(cachedMessages, cachedStats, options);
    showToast('Opened print preview for PDF');
  } catch (err) {
    recordStepError('export_pdf', err);
    showToast(`PDF error: ${err.message}`);
  } finally {
    resetGroupBySenderToggle({ refreshPreview: true });
  }
}

function handleExportTxt(skipConfidencePrompt = false) {
  if (!cachedMessages) return;

  if (!skipConfidencePrompt && cachedStats?.integrity?.direction?.lowConfidence) {
    pendingExportAction = 'txt';
    openConfirmDirectionDialog();
    return;
  }

  try {
    const options = getExportOptions();
    const content = buildTxtContent(cachedMessages, cachedStats, options);
    downloadTxt(content, cachedStats?.chatName || 'Conversation', cachedStats?.platform || currentPlatform);
    showToast('Saved to Downloads');
  } catch (err) {
    recordStepError('export_txt', err);
    showToast(`Export error: ${err.message}`);
  } finally {
    resetGroupBySenderToggle({ refreshPreview: true });
  }
}

function buildDebugReport(includeSampleText = false) {
  const dir = cachedStats?.integrity?.direction || {};
  const audit = cachedStats?.integrity?.audit || {};
  const unrecSamples = (audit.unrecognizedSamples || []).slice(0, 10).map(s => {
    const skeleton = includeSampleText
      ? (s.skeletonWithText || s.skeleton || '')
      : (s.skeletonRedacted || s.skeleton || '');
    const entry = {
      id: s.id || null,
      sightings: s.sightings ?? 1,
      scrollTop: s.scrollTop ?? null,
      direction: s.direction || 'unknown',
      typeGuess: s.typeGuess || 'unknown',
      labels: Array.isArray(s.labels) ? s.labels.slice(0, 8) : (s.ariaLabel ? [s.ariaLabel] : []),
      skeleton
    };
    if (includeSampleText) {
      if (s.text != null) entry.text = s.text;
      if (s.textPreview != null) entry.textPreview = s.textPreview;
      if (s.prevMessageText != null) entry.prevMessageText = s.prevMessageText;
      if (s.nextMessageText != null) entry.nextMessageText = s.nextMessageText;
    }
    return entry;
  });

  const uniqueRowsSeen = audit.uniqueRowsSeen ?? audit.candidateRowsSeen ?? 0;
  const uniqueSeparators = audit.uniqueSeparators ?? audit.separatorsCount ?? 0;
  const uniqueSystemRows = audit.uniqueSystemRows ?? audit.systemRowsCount ?? 0;
  const uniqueReplyLabels = audit.uniqueReplyLabels ?? audit.replyLabelsCount ?? 0;
  const uniqueNoiseRows = audit.uniqueNoiseRows ?? audit.noiseRowsCount ?? 0;
  const uniqueUnrecognized = audit.uniqueUnrecognized ?? audit.unrecognizedCount ?? 0;

  const report = {
    extension: 'ChatFlow',
    version: getExtensionVersion(),
    platform: cachedStats?.platform || currentPlatform,
    chatType: cachedStats?.integrity?.chatType || 'unknown',
    counts: {
      uniqueRowsSeen,
      candidateRowsSeen: uniqueRowsSeen,
      messagesExported: audit.messagesExported ?? (cachedStats?.totalMessages || 0),
      uniqueSeparators,
      separatorsCount: uniqueSeparators,
      uniqueSystemRows,
      systemRowsCount: uniqueSystemRows,
      uniqueReplyLabels,
      replyLabelsCount: uniqueReplyLabels,
      uniqueNoiseRows,
      noiseRowsCount: uniqueNoiseRows,
      uniqueUnrecognized,
      unrecognizedCount: uniqueUnrecognized,
      otherIconMessagesCount: audit.otherIconMessagesCount ?? 0,
      orphanRepliesCount: audit.orphanRepliesCount ?? 0,
      sightings: audit.sightings || {
        rowSightings: audit.candidateRowsSeen ?? 0,
        separatorSightings: audit.separatorsCount ?? 0,
        systemSightings: audit.systemRowsCount ?? 0,
        replyLabelSightings: audit.replyLabelsCount ?? 0,
        noiseSightings: audit.noiseRowsCount ?? 0,
        unrecognizedSightings: audit.unrecognizedCount ?? 0
      },
      gapsCount: audit.gapsCount ?? (cachedStats?.integrity?.noOverlapEventsCount || 0),
      verificationRan: Boolean(audit.verificationRan),
      verificationSkipped: audit.verificationSkipped !== undefined ? Boolean(audit.verificationSkipped) : !audit.verificationRan,
      verificationStatus: audit.verificationStatus || (audit.verificationRan ? 'Ran' : 'Skipped'),
      verificationLabel: audit.verificationLabel || (audit.verificationRan ? 'Verification: ran cleanly' : 'Verification: not needed'),
      verificationMode: audit.verificationMode || 'smart',
      verificationTriggerReasons: audit.verificationTriggerReasons || [],
      pass1DurationMs: audit.pass1DurationMs ?? null,
      pass2DurationMs: audit.pass2DurationMs ?? 0,
      classifyCallsCount: audit.classifyCallsCount ?? null,
      rowParseCacheHits: audit.rowParseCacheHits ?? null,
      verificationDifferencesCount: audit.verificationDifferencesCount ?? 0,
      verificationRecoveredCount: audit.verificationRecoveredCount ?? 0,
      finalTotal: audit.finalTotal ?? (cachedStats?.totalMessages || 0),
      senderCounts: audit.senderCounts || cachedStats?.senderCounts || {},
      duplicates: cachedStats?.integrity?.duplicates || 0,
      rejectedSeparators: cachedStats?.integrity?.rejectedSeparatorsCount || 0
    },
    healthy: audit.healthy !== undefined ? audit.healthy : !cachedStats?.integrity?.hasWarning,
    direction: {
      confidence: dir.lowConfidence ? 'low' : 'high',
      comboUsed: toList(dir.comboUsed),
      agreement: dir.agreement || {},
      counts: { me: dir.meCount ?? dir.counts?.me ?? 0, contact: dir.themCount ?? dir.counts?.contact ?? 0 }
    },
    selectorHits: audit.selectorHits || {},
    gapEvents: audit.gapEvents || [],
    verificationDetails: audit.verificationDetails || [],
    dateOrderViolations: audit.dateOrderViolations || [],
    resolvedWeekdays: audit.resolvedWeekdays || [],
    rejectedSeparators: audit.rejectedSeparators || [],
    unrecognizedSamples: unrecSamples,
    stepErrors: recordedErrors.slice(),
    beginningReached: !!cachedStats?.integrity?.beginningReached,
    sanityCheckWarnings: toList(cachedStats?.integrity?.sanityCheck?.warnings),
    locale: typeof navigator !== 'undefined' ? navigator.language : 'en',
    timestamp: new Date().toISOString()
  };

  if (includeSampleText && Array.isArray(cachedMessages)) {
    report.sampleMessages = cachedMessages.slice(0, 10).map((m, idx) => ({
      idx,
      type: m.type,
      isMe: !!m.isMe,
      timestamp: m.timestamp || null,
      textPreview: (m.text || '').slice(0, 80)
    }));
  }

  return report;
}

async function copyDebugReport(includeSampleText = false) {
  const report = buildDebugReport(includeSampleText);
  try {
    await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
    showToast(includeSampleText ? 'Debug report copied (with sample text)' : 'Debug report copied (no chat text)');
  } catch (_) {
    showToast('Failed to copy debug report');
  }
}

async function handleReportProblem() {
  const includeSample = !!($('chk-include-sample-text')?.checked);
  await copyDebugReport(includeSample);
}

function applyI18n() {
  if (typeof chrome === 'undefined' || !chrome.i18n?.getMessage) return;
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    const msg = chrome.i18n.getMessage(key);
    if (msg) el.textContent = msg;
  });
}

// ─── Toast System ─────────────────────────────────────────────────────────────

let toastTimer = null;
function showToast(message) {
  const toast = $('toast');
  const toastText = $('toast-text');
  if (!toast || !toastText) return;

  toastText.textContent = message;
  toast.classList.add('show');

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}

// ─── Scan Progress & Chat Switch Listener ─────────────────────────────────────

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'SCAN_PROGRESS') {
      updateScanProgress(msg.payload);
    } else if (msg?.type === 'CHAT_CHANGED') {
      handleChatChanged(msg.payload);
    } else if (msg?.type === 'RUNTIME_ERROR') {
      recordStepError(`content:${msg.payload?.step || 'runtime'}`, msg.payload);
    }
  });
}

function handleChatChanged({ chatName }) {
  const currentView = document.querySelector('main > section:not(.hidden)');
  // Never interrupt an active loading/reading/preparing step, but in passive "ready" state reset cleanly
  if (currentView?.id === 'state-scanning' && currentScanPhase !== 'ready') return;

  const cleanName = sanitizeChatName(chatName, 'Chat');
  if (!cleanName || cleanName === 'Messenger chat' || cleanName === 'WhatsApp chat') return;

  $('top-chat-title').textContent = cleanName;
  $('top-avatar').textContent = getInitials(cleanName);
  $('ready-title-text').textContent = `Scan "${cleanName}"`;

  if (currentView?.id === 'state-scanning' && currentScanPhase === 'ready') {
    currentScanPhase = 'idle';
    setState(AppState.READY, { chatName: cleanName });
    return;
  }

  if (currentView?.id !== 'state-ready' && currentView?.id !== 'state-complete') {
    setState(AppState.READY, { chatName: cleanName });
  }
}

function updateScanProgress(payload = {}) {
  const { phase } = payload;

  // Phase 1: Loading history (NEVER show or increment a message counter)
  if (phase === 'loading') {
    if (currentScanPhase !== 'loading') {
      setStepperPhase('loading');
    }
    const oldestFmt = formatShortDate(payload.oldestDate);
    const oldestEl = $('loading-oldest');
    if (oldestEl) {
      oldestEl.textContent = oldestFmt
        ? `Loaded back to ${oldestFmt}...`
        : 'Looking for older messages...';
    }
    if (payload.oldestDate && payload.oldestDate !== lastOldestIso) {
      lastOldestIso = payload.oldestDate;
      lastOldestChangeAt = Date.now();
      hideStallPrompt();
    }
    if (typeof payload.elapsedMs === 'number' && $('loading-elapsed')) {
      $('loading-elapsed').textContent = `Elapsed: ${formatElapsedSec(payload.elapsedMs)}`;
    }
    return;
  }

  // Passive "Ready to scan" state (transition from loading or live updates when user scrolls up manually)
  if (phase === 'ready') {
    if (payload.oldestDate) {
      lastOldestIso = payload.oldestDate;
    }
    if (currentScanPhase === 'loading') {
      showReadyToScan(payload);
    } else if (currentScanPhase === 'ready') {
      updateReadyView(payload);
    }
    return;
  }

  // Phase 2: Reading messages (the ONLY pass that counts, monotonically from 0)
  if (phase === 'reading') {
    if (currentScanPhase !== 'reading') {
      setStepperPhase('reading');
    }
    const count = Math.max(0, payload.count || 0);
    const pct = Math.min(100, Math.max(0, payload.percent || 0));

    if ($('scan-count')) $('scan-count').textContent = count.toLocaleString();
    if ($('scan-count-label')) $('scan-count-label').textContent = `Messages read: ${count.toLocaleString()}`;
    if ($('reading-bar')) $('reading-bar').style.width = `${pct}%`;
    if ($('reading-progress')) $('reading-progress').setAttribute('aria-valuenow', String(pct));

    const dateEl = $('reading-date');
    if (dateEl) {
      const dFmt = formatShortDate(payload.currentDate);
      dateEl.textContent = dFmt ? `Reading: ${dFmt}` : 'Reading messages...';
    }

    const speedEl = $('reading-speed');
    if (speedEl) {
      const parts = [];
      if (payload.rate && payload.rate > 0) parts.push(`${payload.rate} msgs/s`);
      if (typeof payload.etaSec === 'number' && payload.etaSec > 0) parts.push(`~${payload.etaSec}s left`);
      speedEl.textContent = parts.join(' · ');
    }

    const dirNote = $('reading-direction-note');
    if (dirNote) {
      dirNote.classList.toggle('hidden', !payload.directionLow);
    }
    return;
  }

  // Optional Verification Pass (progress bar ONLY — never recounts messages!)
  if (phase === 'verifying') {
    if (currentScanPhase !== 'verifying') {
      setStepperPhase('verifying');
    }
    const rawPct = payload.verifyPercent ?? payload.percent ?? 0;
    const pct = Math.min(100, Math.max(0, rawPct));
    if ($('verifying-bar')) $('verifying-bar').style.width = `${pct}%`;
    if ($('verifying-progress')) $('verifying-progress').setAttribute('aria-valuenow', String(pct));
    if ($('verifying-label')) $('verifying-label').textContent = `Verifying coverage... (${pct}%)`;
    return;
  }

  // Phase 3: Preparing results
  if (phase === 'preparing') {
    setStepperPhase('preparing');
  }
}

// ─── Theme Management ─────────────────────────────────────────────────────────

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  $('theme-dark-btn')?.classList.toggle('active', theme === 'dark');
  $('theme-light-btn')?.classList.toggle('active', theme === 'light');
  chrome.storage.local.set({ chatflow_theme: theme }).catch(() => { });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(text) {
  return (text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Realtime Observer ────────────────────────────────────────────────────────

function startChatObserver() {
  if (pollTimer) clearInterval(pollTimer);

  pollTimer = setInterval(async () => {
    const currentView = document.querySelector('main > section:not(.hidden)');
    const stateId = currentView?.id;

    if (stateId === 'state-scanning') return;

    const tab = await findSupportedTab();
    if (!tab) {
      if (stateId !== 'state-not-supported') init();
      return;
    }

    currentTab = tab;
    const plat = getPlatformFromUrl(tab.url);
    setPlatformTheme(plat);
    const info = await getChatInfoFromPage(currentTab.id, plat);

    if (!info.hasOpenChat) {
      if (stateId !== 'state-select-chat' && stateId !== 'state-complete') {
        init();
      }
      return;
    }

    const currentTitle = $('top-chat-title')?.textContent;
    const cleanInfoName = sanitizeChatName(info.chatName);
    if (cleanInfoName && cleanInfoName !== currentTitle && cleanInfoName !== 'Detecting chat...') {
      init();
    }
  }, 2200);
}

// ─── Event Wiring ─────────────────────────────────────────────────────────────

if (typeof window !== 'undefined') {
  installGlobalErrorHandlers();
}

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('DOMContentLoaded', () => {
    installGlobalErrorHandlers();
    syncVersionLabels();
    renderSettingsChangelog();
    runVersionMigrations().catch(() => { });
    migrateGroupBySenderSetting().catch(() => { });
    resetGroupBySenderToggle();

    $('btn-whats-new-close')?.addEventListener('click', () => {
      dismissWhatsNew();
    });
    $('btn-whats-new-changelog')?.addEventListener('click', async () => {
      await dismissWhatsNew();
      switchTab('settings');
      const detailsEl = $('settings-changelog-details');
      if (detailsEl) detailsEl.open = true;
      $('settings-changelog-box')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    });

    $('btn-copy-error-details')?.addEventListener('click', () => copyErrorDetails());
    $('btn-copy-substep-error')?.addEventListener('click', () => copyErrorDetails());

    // Theme, Auto-Start, Thorough Scan, and Tip preferences initialization
    chrome.storage.local.get(['chatflow_theme', 'chatflow_auto_start', 'chatflow_thorough_scan', 'chatflow_hide_ready_tip', 'chatflow_my_name', 'chatflow_my_name_by_platform'], (res) => {
      const theme = res?.chatflow_theme || 'dark';
      applyTheme(theme);

      autoStartEnabled = !!res?.chatflow_auto_start;
      const autoToggle = $('setting-auto-start');
      if (autoToggle) autoToggle.checked = autoStartEnabled;

      thoroughScanEnabled = !!res?.chatflow_thorough_scan;
      const thoroughToggle = $('setting-thorough-scan');
      if (thoroughToggle) thoroughToggle.checked = thoroughScanEnabled;

      hideReadyTip = !!res?.chatflow_hide_ready_tip;

      if (res?.chatflow_my_name_by_platform && typeof res.chatflow_my_name_by_platform === 'object') {
        cachedMyNameByPlatform = { ...res.chatflow_my_name_by_platform };
      }
      const pKey = normalizePlatformKey(currentPlatform);
      const platName = cleanUserMyNameSetting(cachedMyNameByPlatform[pKey] || '');
      const cleanedGlobal = cleanUserMyNameSetting(res?.chatflow_my_name || '');
      const initialName = platName || cleanedGlobal || '';

      // Purge any stale blocked UI name ("Controls and Settings") stored previously
      if ((res?.chatflow_my_name && !cleanedGlobal) || (cachedMyNameByPlatform[pKey] && !platName)) {
        chrome.storage.local.set({
          chatflow_my_name: cleanedGlobal,
          chatflow_my_name_by_platform: { ...cachedMyNameByPlatform, [pKey]: platName }
        }).catch(() => { });
      }

      try {
        if (initialName) localStorage.setItem('chatflow_my_name', initialName);
        else localStorage.removeItem('chatflow_my_name');
      } catch (_) { }
      syncMyNameInputs(initialName);
    });

    $('theme-dark-btn')?.addEventListener('click', () => applyTheme('dark'));
    $('theme-light-btn')?.addEventListener('click', () => applyTheme('light'));

    // Rail Tab Navigation
    $('nav-btn-overview')?.addEventListener('click', () => switchTab('overview'));
    $('nav-btn-participants')?.addEventListener('click', () => switchTab('participants'));
    $('nav-btn-export')?.addEventListener('click', () => switchTab('export'));
    $('nav-btn-settings')?.addEventListener('click', () => switchTab('settings'));

    // Top Bar Refresh: Clears cached session data and immediately triggers a fresh rescan
    $('top-btn-refresh')?.addEventListener('click', handleTopRefresh);

    async function handleTopRefresh() {
      const refreshBtn = $('top-btn-refresh');
      if (refreshBtn) refreshBtn.classList.add('spinning');

      try {
        if (currentTab?.id) {
          await chrome.tabs.sendMessage(currentTab.id, { type: 'CANCEL_SCAN' }).catch(() => { });
        }

        await chrome.runtime.sendMessage({ type: 'CLEAR_SESSION' }).catch(() => { });
        cachedMessages = null;
        cachedStats = null;
        currentScanPhase = 'idle';
        stopLoadingTimers();

        currentTab = await findSupportedTab();
        if (!currentTab) {
          setState(AppState.NOT_SUPPORTED);
          return;
        }

        const plat = getPlatformFromUrl(currentTab.url);
        if (!plat) {
          setState(AppState.NOT_SUPPORTED);
          return;
        }

        currentPlatform = plat;
        setPlatformTheme(plat);

        const info = await getChatInfoFromPage(currentTab.id, plat);
        if (!info.hasOpenChat) {
          setState(AppState.SELECT_CHAT);
          showToast('Please open a conversation to scan');
          return;
        }

        setState(AppState.READY, { chatName: info.chatName });
        await startScan();
      } catch (err) {
        showToast(`Refresh error: ${err.message}`);
      } finally {
        if (refreshBtn) refreshBtn.classList.remove('spinning');
      }
    }

    // Debug Logging Toggle
    const debugToggle = $('setting-debug-mode');
    if (debugToggle) {
      try { debugToggle.checked = localStorage.getItem('chatflow_debug') === 'true'; } catch (_) { }
      debugToggle.addEventListener('change', () => {
        try { localStorage.setItem('chatflow_debug', debugToggle.checked ? 'true' : 'false'); } catch (_) { }
        showToast(debugToggle.checked ? 'Debug logging enabled' : 'Debug logging disabled');
      });
    }

    // Auto-Start Reading Toggle (Part 6.5)
    const autoStartToggle = $('setting-auto-start');
    if (autoStartToggle) {
      autoStartToggle.addEventListener('change', () => {
        autoStartEnabled = autoStartToggle.checked;
        chrome.storage.local.set({ chatflow_auto_start: autoStartEnabled }).catch(() => { });
        showToast(autoStartEnabled ? 'Auto-start enabled for full history' : 'Manual Start scan enabled');
      });
    }

    // Reset Helpful Tips Button (Part 6.3)
    $('btn-tips-reset')?.addEventListener('click', () => {
      hideReadyTip = false;
      chrome.storage.local.set({ chatflow_hide_ready_tip: false }).catch(() => { });
      showToast('Tips will be shown again');
    });

    // Thorough Scan Toggle (always run Pass 2 verification; default OFF)
    const thoroughToggle = $('setting-thorough-scan');
    if (thoroughToggle) {
      thoroughToggle.addEventListener('change', () => {
        thoroughScanEnabled = thoroughToggle.checked;
        chrome.storage.local.set({ chatflow_thorough_scan: thoroughScanEnabled }).catch(() => { });
        showToast(thoroughScanEnabled ? 'Thorough verification enabled' : 'Smart verification enabled (faster)');
      });
    }

    // Diagnostics Selector Health Check
    $('btn-run-healthcheck')?.addEventListener('click', async () => {
      const container = $('healthcheck-container');
      if (!container) return;
      container.textContent = 'Running diagnostics...';

      if (!currentTab?.id) {
        currentTab = await findSupportedTab();
      }
      if (!currentTab?.id) {
        container.textContent = 'No active WhatsApp or Messenger tab found.';
        return;
      }

      try {
        const isReady = await ensureContentScriptReady(currentTab.id);
        if (!isReady) {
          container.textContent = 'Content script not responding. Reload the tab (F5).';
          return;
        }

        const res = await chrome.tabs.sendMessage(currentTab.id, { type: 'RUN_HEALTHCHECK' });
        if (res && res.ok && res.health) {
          const lines = toList(res.health.results).map(r => `${r?.found ? '✓' : '✗'} ${r?.name || 'selector'}: ${r?.found ? 'OK' : 'NOT FOUND'}`);
          container.innerHTML = `<div style="margin-bottom:4px;"><strong>${escapeHtml(res.platform)}</strong>: "${escapeHtml(res.chatName)}"</div>` +
            lines.map(l => `<div style="color:${l.startsWith('✓') ? 'var(--primary-green)' : 'var(--negative)'}">${escapeHtml(l)}</div>`).join('');
        } else {
          container.textContent = `Diagnostic check failed: ${res?.error || 'Unknown error'}`;
        }
      } catch (err) {
        container.textContent = `Diagnostics error: ${err.message}`;
      }
    });

    // Verify Scan Integrity Button
    $('btn-verify-scan')?.addEventListener('click', async () => {
      const resEl = $('verify-scan-result');
      const verifyBtn = $('btn-verify-scan');
      if (!cachedMessages || cachedMessages.length === 0) {
        if (resEl) resEl.textContent = 'No messages captured yet. Please scan a chat first.';
        return;
      }
      if (verifyBtn) verifyBtn.disabled = true;
      if (resEl) resEl.textContent = 'Running verification check against chat DOM...';

      try {
        if (!currentTab?.id) {
          currentTab = await findSupportedTab();
        }
        if (!currentTab?.id) throw new Error('No active chat tab found.');
        const isReady = await ensureContentScriptReady(currentTab.id);
        if (!isReady) throw new Error('Content script not responding. Reload the tab (F5).');

        const resp = await chrome.tabs.sendMessage(currentTab.id, {
          type: 'VERIFY_SCAN',
          masterList: cachedMessages
        });
        if (!resp || !resp.ok) {
          throw new Error(resp?.error || 'Verification check failed.');
        }
        if (resEl) {
          resEl.textContent = resp.result?.message || 'Verification complete.';
          resEl.style.color = resp.result?.ok ? 'var(--primary-green)' : 'var(--negative)';
        }
      } catch (err) {
        if (resEl) {
          resEl.textContent = `Verification error: ${err.message}`;
          resEl.style.color = 'var(--negative)';
        }
      } finally {
        if (verifyBtn) verifyBtn.disabled = false;
      }
    });

    // Platform Launch Buttons
    $('btn-open-wa')?.addEventListener('click', async () => {
      const waTabs = await chrome.tabs.query({ url: '*://web.whatsapp.com/*' });
      if (waTabs.length > 0) {
        await chrome.tabs.update(waTabs[0].id, { active: true });
        if (waTabs[0].windowId) await chrome.windows.update(waTabs[0].windowId, { focused: true });
      } else {
        await chrome.tabs.create({ url: 'https://web.whatsapp.com' });
      }
      setTimeout(init, 600);
    });

    $('btn-open-msgr')?.addEventListener('click', async () => {
      const msgrTabs = await chrome.tabs.query({ url: ['*://www.messenger.com/*', '*://www.facebook.com/messages/*'] });
      if (msgrTabs.length > 0) {
        await chrome.tabs.update(msgrTabs[0].id, { active: true });
        if (msgrTabs[0].windowId) await chrome.windows.update(msgrTabs[0].windowId, { focused: true });
      } else {
        await chrome.tabs.create({ url: 'https://www.messenger.com' });
      }
      setTimeout(init, 600);
    });

    // ─── Scan Actions (Phase 1 -> Ready -> Phase 2) ──────────────────────────
    $('btn-scan')?.addEventListener('click', () => beginLoadHistory({ isLoadMore: false }));

    $('btn-stop-loading')?.addEventListener('click', async () => {
      const btn = $('btn-stop-loading');
      if (btn) {
        btn.disabled = true;
        const sp = btn.querySelector('span');
        if (sp) sp.textContent = 'Stopping...';
        else btn.textContent = 'Stopping...';
      }

      let settled = false;
      const finishToReady = (snap = {}) => {
        if (settled) return;
        settled = true;
        if (stopWatchdogTimer) {
          clearTimeout(stopWatchdogTimer);
          stopWatchdogTimer = null;
        }
        showReadyToScan({
          beginningReached: !!snap.beginningReached,
          reason: snap.reason || 'user_stop',
          oldestDate: snap.oldestDate || lastOldestIso || null
        });
      };

      // 2-second watchdog: never let the button stay on "Stopping..." for more than 2 seconds
      if (stopWatchdogTimer) clearTimeout(stopWatchdogTimer);
      stopWatchdogTimer = setTimeout(() => {
        stopWatchdogTimer = null;
        if (settled || currentScanPhase !== 'loading') return;
        appendDiagnosticsWarning('Stop loading acknowledgement timed out after 2s; forced Ready to scan state and retrying STOP_LOADING.');
        finishToReady({ beginningReached: false, reason: 'watchdog_stop', oldestDate: lastOldestIso });

        // Retry telling the content script to abort up to 3 times in the background
        if (currentTab?.id) {
          for (let attempt = 1; attempt <= 3; attempt++) {
            setTimeout(() => {
              if (currentTab?.id && currentScanPhase === 'ready') {
                chrome.tabs.sendMessage(currentTab.id, { type: 'STOP_LOADING' }).catch(() => { });
              }
            }, attempt * 350);
          }
        }
      }, STOP_WATCHDOG_MS);

      try {
        if (!currentTab?.id) {
          currentTab = await findSupportedTab();
        }
        if (!currentTab?.id) {
          finishToReady({ beginningReached: false, reason: 'user_stop', oldestDate: lastOldestIso });
          return;
        }
        const resp = await chrome.tabs.sendMessage(currentTab.id, { type: 'STOP_LOADING' });
        if (resp && (resp.ok || resp.status === 'phase1_stopped')) {
          finishToReady(resp);
        } else {
          finishToReady({ beginningReached: false, reason: 'user_stop', oldestDate: lastOldestIso });
        }
      } catch (err) {
        if (stopWatchdogTimer) {
          clearTimeout(stopWatchdogTimer);
          stopWatchdogTimer = null;
        }
        settled = true;
        stopLoadingTimers();
        currentScanPhase = 'idle';
        if (isConnectionLostError(err)) {
          setState(AppState.ERROR, {
            message: 'Lost connection to the chat page. Refresh the chat tab and try again.',
            connectionLost: true
          });
        } else {
          finishToReady({ beginningReached: false, reason: 'user_stop', oldestDate: lastOldestIso });
        }
      }
    });

    $('btn-start-scan')?.addEventListener('click', () => beginReadingPhase());

    $('btn-load-more')?.addEventListener('click', () => beginLoadHistory({ isLoadMore: true }));

    const cancelActiveScan = async () => {
      stopLoadingTimers();
      currentScanPhase = 'idle';
      const tabId = currentTab?.id;
      // Tell content script to abort with a short 800ms race so UI never hangs
      if (tabId) {
        Promise.race([
          chrome.tabs.sendMessage(tabId, { type: 'CANCEL_SCAN' }).catch(() => { }),
          new Promise(r => setTimeout(r, 800))
        ]).catch(() => { });
      }
      const cleanTitle = sanitizeChatName($('top-chat-title')?.textContent || 'Active Chat');
      setState(AppState.READY, { chatName: cleanTitle });
      try {
        const info = await Promise.race([
          getChatInfoFromPage(tabId, currentPlatform),
          new Promise(r => setTimeout(() => r(null), 1200))
        ]);
        if (info?.chatName && currentScanPhase === 'idle') {
          setState(AppState.READY, { chatName: info.chatName });
        }
      } catch (_) { }
    };

    $('btn-cancel')?.addEventListener('click', cancelActiveScan);
    $('btn-ready-cancel')?.addEventListener('click', cancelActiveScan);
    $('btn-reading-cancel')?.addEventListener('click', cancelActiveScan);

    // Floating Tip Dismiss & "Don't show again"
    $('btn-tip-close')?.addEventListener('click', () => {
      $('ready-tip')?.classList.add('hidden');
    });

    $('btn-tip-never')?.addEventListener('click', () => {
      hideReadyTip = true;
      $('ready-tip')?.classList.add('hidden');
      chrome.storage.local.set({ chatflow_hide_ready_tip: true }).catch(() => { });
    });

    // Rescan actions
    const triggerFullRescan = async () => {
      await chrome.runtime.sendMessage({ type: 'CLEAR_SESSION' });
      cachedMessages = null;
      cachedStats = null;
      beginLoadHistory({ isLoadMore: false });
    };

    $('btn-rescan-all')?.addEventListener('click', triggerFullRescan);
    $('btn-sum-rescan')?.addEventListener('click', triggerFullRescan);
    $('rail-btn-rescan')?.addEventListener('click', triggerFullRescan);

    // Completion Summary Card Quick Downloads
    $('btn-sum-docx')?.addEventListener('click', () => handleExportDocx(false));
    $('btn-sum-txt')?.addEventListener('click', () => handleExportTxt(false));

    // Direction Confirmation & Swap Sides Buttons
    $('btn-confirm-who')?.addEventListener('click', openConfirmDirectionDialog);

    const onSwapClicked = async () => {
      await applyInMemoryDirectionUpdate({ swap: true });
      showToast('Swapped sides');
    };
    $('btn-swap-participants')?.addEventListener('click', onSwapClicked);
    $('btn-swap-settings')?.addEventListener('click', onSwapClicked);
    $('btn-dialog-swap')?.addEventListener('click', async () => {
      await applyInMemoryDirectionUpdate({ swap: true });
      openConfirmDirectionDialog(); // refresh sample bubbles
      showToast('Swapped sides');
    });

    const onSideConfirmed = async (side) => {
      closeConfirmDirectionDialog();
      await applyInMemoryDirectionUpdate({ meSide: side });
      showToast(side === 'left' ? 'Left side set as you' : 'Right side set as you');
      if (pendingExportAction === 'docx') {
        pendingExportAction = null;
        await handleExportDocx(true);
      } else if (pendingExportAction === 'txt') {
        pendingExportAction = null;
        handleExportTxt(true);
      }
    };
    $('btn-left-is-me')?.addEventListener('click', () => onSideConfirmed('left'));
    $('btn-right-is-me')?.addEventListener('click', () => onSideConfirmed('right'));
    $('btn-dialog-later')?.addEventListener('click', () => {
      pendingExportAction = null;
      closeConfirmDirectionDialog();
    });

    $('direction-backdrop')?.addEventListener('click', (e) => {
      if (e.target === $('direction-backdrop')) {
        pendingExportAction = null;
        closeConfirmDirectionDialog();
      }
    });

    // Export Segmented Control
    const segAll = $('seg-all');
    const segFilter = $('seg-filter');
    const dateBox = $('export-date-box');

    segAll?.addEventListener('click', () => {
      segAll.classList.add('active');
      segFilter.classList.remove('active');
      if (dateBox) dateBox.style.display = 'none';
    });

    segFilter?.addEventListener('click', () => {
      segFilter.classList.add('active');
      segAll.classList.remove('active');
      if (dateBox) dateBox.style.display = 'flex';
    });
    $('btn-cc-verify-now')?.addEventListener('click', () => {
      runVerifyNow();
    });

    // Export Buttons & Live Preview Listeners
    $('btn-export-docx')?.addEventListener('click', () => handleExportDocx(false));
    $('btn-export-pdf')?.addEventListener('click', handleExportPdf);
    $('btn-export-txt')?.addEventListener('click', () => handleExportTxt(false));
    $('btn-report-problem')?.addEventListener('click', handleReportProblem);
    $('btn-copy-debug-report')?.addEventListener('click', () => {
      const inc = !!($('chk-include-sample-text')?.checked);
      copyDebugReport(inc);
    });
    $('btn-cc-copy-debug')?.addEventListener('click', () => {
      const inc = !!($('chk-cc-include-sample')?.checked);
      copyDebugReport(inc);
    });

    const previewControlIds = [
      'exp-layout', 'exp-color-mode', 'exp-date-format', 'exp-time-format',
      'exp-page-size', 'exp-font-size', 'exp-my-name', 'exp-summary',
      'exp-timestamps', 'exp-group-sender', 'exp-reactions',
      'exp-media-labels', 'exp-system-messages', 'exp-hide-quotes',
      'exp-from-date', 'exp-to-date'
    ];
    for (const id of previewControlIds) {
      $(id)?.addEventListener('change', renderExportPreview);
      $(id)?.addEventListener('input', renderExportPreview);
    }

    let myNameSaveTimer = null;
    const syncMyNamePref = async (rawVal, sourceId = null, immediate = false) => {
      const val = cleanUserMyNameSetting(rawVal);
      syncMyNameInputs(rawVal.trim() === '' ? '' : (isBlockedUiName(rawVal) ? '' : rawVal), sourceId);
      const applyAndSave = async () => {
        await savePlatformMyName(cachedStats?.platform || currentPlatform, val);
        if (cachedMessages && cachedMessages.length > 0) {
          await applyInMemoryDirectionUpdate({ myName: val });
        }
      };
      if (myNameSaveTimer) clearTimeout(myNameSaveTimer);
      if (immediate) {
        await applyAndSave();
      } else {
        myNameSaveTimer = setTimeout(applyAndSave, 250);
      }
    };

    for (const id of ['ready-my-name', 'scan-ready-my-name', 'exp-my-name', 'setting-my-name']) {
      $(id)?.addEventListener('input', (e) => {
        syncMyNamePref(e.target.value || '', id, false);
      });
      $(id)?.addEventListener('change', (e) => {
        const val = cleanUserMyNameSetting(e.target.value || '');
        if (e.target.value && !val) {
          e.target.value = '';
          showToast('Ignored interface button label as display name');
        }
        syncMyNameInputs(val, id);
        syncMyNamePref(val, id, true);
      });
    }

    // Toast Dismiss
    $('toast-close')?.addEventListener('click', () => {
      $('toast')?.classList.remove('show');
    });

    // Clear Data Popover (Rail bottom & Settings tab)
    const popover = $('popover-backdrop');

    const openClearPopover = () => popover?.classList.add('open');
    const closeClearPopover = () => popover?.classList.remove('open');

    $('rail-btn-clear')?.addEventListener('click', openClearPopover);
    $('btn-settings-clear')?.addEventListener('click', openClearPopover);
    $('popover-cancel')?.addEventListener('click', closeClearPopover);

    popover?.addEventListener('click', (e) => {
      if (e.target === popover) closeClearPopover();
    });

    $('popover-confirm')?.addEventListener('click', async () => {
      closeClearPopover();
      await chrome.runtime.sendMessage({ type: 'CLEAR_SESSION' });
      cachedMessages = null;
      cachedStats = null;
      const info = await getChatInfoFromPage(currentTab?.id, currentPlatform);
      if (info.hasOpenChat) {
        setState(AppState.READY, { chatName: info.chatName });
      } else {
        setState(AppState.SELECT_CHAT);
      }
      showToast('Conversation data cleared');
    });

    $('btn-retry')?.addEventListener('click', init);

    $('btn-reload-tab')?.addEventListener('click', async () => {
      const reloadBtn = $('btn-reload-tab');
      if (reloadBtn) {
        reloadBtn.disabled = true;
        reloadBtn.textContent = 'Reloading tab...';
      }
      try {
        if (!currentTab?.id) {
          currentTab = await findSupportedTab();
        }
        if (currentTab?.id) {
          await chrome.tabs.reload(currentTab.id);
          setTimeout(() => {
            if (reloadBtn) {
              reloadBtn.disabled = false;
              reloadBtn.innerHTML = '<span>Reload tab</span>';
            }
            init();
          }, 1800);
          return;
        }
      } catch (err) {
        showToast(`Reload error: ${err.message}`);
      }
      if (reloadBtn) {
        reloadBtn.disabled = false;
        reloadBtn.innerHTML = '<span>Reload tab</span>';
      }
      init();
    });

    // Escape key closes open dialogs or floating tip
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if ($('direction-backdrop')?.classList.contains('open')) {
          pendingExportAction = null;
          closeConfirmDirectionDialog();
        } else if ($('popover-backdrop')?.classList.contains('open')) {
          closeClearPopover();
        } else if ($('ready-tip') && !$('ready-tip').classList.contains('hidden')) {
          $('ready-tip').classList.add('hidden');
        }
      }
    });

    // Chrome Tabs Change Listeners: instant theme and platform synchronization
    if (chrome.tabs?.onActivated) {
      chrome.tabs.onActivated.addListener(async (activeInfo) => {
        try {
          const tab = await chrome.tabs.get(activeInfo.tabId);
          const plat = getPlatformFromUrl(tab?.url);
          setPlatformTheme(plat);
        } catch (_) { }
        init();
      });
    }
    if (chrome.tabs?.onUpdated) {
      chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
        if (changeInfo.url) {
          const plat = getPlatformFromUrl(changeInfo.url);
          setPlatformTheme(plat);
        }
        if ((changeInfo.status === 'complete' || changeInfo.url) && currentTab?.id === tabId) {
          init();
        }
      });
    }

    // Initial Boot
    applyI18n();
    syncVersionLabels();
    renderSettingsChangelog();
    checkAndRenderWhatsNew().catch(() => { });
    init();
    startChatObserver();
  });
}

function setPanelTestState({ messages, stats, platform, scanPhase, thoroughScan } = {}) {
  if (messages !== undefined) cachedMessages = messages;
  if (stats !== undefined) cachedStats = stats;
  if (platform !== undefined) currentPlatform = platform;
  if (scanPhase !== undefined) currentScanPhase = scanPhase;
  if (thoroughScan !== undefined) thoroughScanEnabled = Boolean(thoroughScan);
}

function getPanelTestState() {
  return {
    cachedMessages,
    cachedStats,
    currentPlatform,
    currentScanPhase,
    thoroughScanEnabled,
    recordedErrors: recordedErrors.slice()
  };
}

export {
  AppState,
  setState,
  setStepperPhase,
  updateScanProgress,
  finalizeAndSaveScan,
  runVerifyNow,
  formatPassDuration,
  formatAuditTimings,
  renderCompleteDashboard,
  getExportOptions,
  renderExportPreview,
  handleExportDocx,
  handleExportPdf,
  handleExportTxt,
  resetGroupBySenderToggle,
  migrateGroupBySenderSetting,
  recordStepError,
  getRecordedErrors,
  clearRecordedErrors,
  buildErrorDetailsText,
  copyErrorDetails,
  buildDebugReport,
  renderDiagnosticsLog,
  installGlobalErrorHandlers,
  setPanelTestState,
  getPanelTestState,
  syncVersionLabels,
  renderSettingsChangelog,
  checkAndRenderWhatsNew,
  dismissWhatsNew,
  verifyContentScriptVersion
};
