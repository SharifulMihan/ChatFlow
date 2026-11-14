/**
 * service-worker.js
 * Background service worker for ChatFlow (MV3).
 * Handles side panel opening, toolbar icon switching, and session message storage.
 * Completely local — zero external network calls.
 */

import { buildTranscript, buildStats, normalizeExportOptions } from '../lib/transcript.js';
import { isBlockedUiName } from '../content/selectors.js';
import { getExtensionVersion } from '../src/version.js';

export const OBSOLETE_STORAGE_KEYS = [
  'chatflow_legacy_options',
  'chatflow_always_verify',
  'chatflow_old_cache'
];

const VERSION_MIGRATIONS = [
  {
    id: 'normalize-settings-and-prune-legacy',
    run: (data, patch, removeKeys) => {
      // Force "Group messages by sender" OFF by default across updates
      if (data.chatflow_group_by_sender !== false) {
        patch.chatflow_group_by_sender = false;
      }

      // Preserve user's saved display name unless it was an accidentally captured UI label
      if (typeof data.chatflow_my_name === 'string' && isBlockedUiName(data.chatflow_my_name)) {
        patch.chatflow_my_name = '';
      }
      if (data.chatflow_my_name_by_platform && typeof data.chatflow_my_name_by_platform === 'object') {
        const cleanedMap = { ...data.chatflow_my_name_by_platform };
        let changed = false;
        for (const [k, v] of Object.entries(cleanedMap)) {
          if (typeof v === 'string' && isBlockedUiName(v)) {
            cleanedMap[k] = '';
            changed = true;
          }
        }
        if (changed) patch.chatflow_my_name_by_platform = cleanedMap;
      }

      for (const obsoleteKey of OBSOLETE_STORAGE_KEYS) {
        if (obsoleteKey in data) removeKeys.push(obsoleteKey);
      }
    }
  }
];

function storageLocalGet(keys) {
  if (typeof chrome === 'undefined' || !chrome.storage?.local?.get) {
    return Promise.resolve({});
  }
  return new Promise((resolve) => {
    try {
      const maybePromise = chrome.storage.local.get(keys, (res) => resolve(res || {}));
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then((res) => resolve(res || {})).catch(() => resolve({}));
      }
    } catch (_) {
      resolve({});
    }
  });
}

function storageLocalSet(patch) {
  if (!patch || Object.keys(patch).length === 0) return Promise.resolve();
  if (typeof chrome === 'undefined' || !chrome.storage?.local?.set) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    try {
      const maybePromise = chrome.storage.local.set(patch, () => resolve());
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then(resolve).catch(reject);
      }
    } catch (err) {
      reject(err);
    }
  });
}

function storageLocalRemove(keys) {
  const list = Array.isArray(keys) ? keys.filter(Boolean) : [keys].filter(Boolean);
  if (list.length === 0) return Promise.resolve();
  if (typeof chrome === 'undefined' || !chrome.storage?.local?.remove) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    try {
      const maybePromise = chrome.storage.local.remove(list, () => resolve());
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then(resolve).catch(() => resolve());
      }
    } catch (_) {
      resolve();
    }
  });
}

/**
 * Run keyed storage migrations on extension install, update, or startup.
 * Never throws so broken storage cannot block the side panel or scans.
 */
export async function runVersionMigrations({
  previousVersion = null,
  currentVersion = getExtensionVersion(),
  reason = 'startup'
} = {}) {
  try {
    const keysToRead = [
      'chatflow_schema_version',
      'chatflow_my_name',
      'chatflow_my_name_by_platform',
      'chatflow_chat_prefs',
      'chatflow_theme',
      'chatflow_auto_start',
      'chatflow_thorough_scan',
      'chatflow_hide_ready_tip',
      'chatflow_group_by_sender',
      ...OBSOLETE_STORAGE_KEYS
    ];
    const data = await storageLocalGet(keysToRead);
    const patch = {};
    const removeKeys = [];

    for (const step of VERSION_MIGRATIONS) {
      step.run(data, patch, removeKeys, { previousVersion, currentVersion, reason });
    }

    if (data.chatflow_schema_version !== currentVersion) {
      patch.chatflow_schema_version = currentVersion;
    }

    if (Object.keys(patch).length > 0) {
      await storageLocalSet(patch);
    }
    if (removeKeys.length > 0) {
      await storageLocalRemove(removeKeys);
    }

    return {
      ok: true,
      currentVersion,
      previousVersion,
      updatedKeys: Object.keys(patch),
      removedKeys: removeKeys
    };
  } catch (err) {
    return {
      ok: false,
      currentVersion,
      previousVersion,
      error: err?.message || String(err)
    };
  }
}

export async function handleInstalled(details = {}) {
  const reason = details?.reason || 'install';
  const previousVersion = details?.previousVersion || null;
  const currentVersion = getExtensionVersion();

  const migrationResult = await runVersionMigrations({ previousVersion, currentVersion, reason });

  try {
    if (reason === 'update' && previousVersion && previousVersion !== currentVersion) {
      await storageLocalSet({
        chatflow_update_notice: {
          updatedFrom: previousVersion,
          updatedTo: currentVersion,
          dismissed: false,
          updatedAt: new Date().toISOString()
        }
      });
    } else if (reason === 'install') {
      await storageLocalRemove(['chatflow_update_notice', 'chatflow_dismissed_whats_new_version']);
    }
  } catch (_) {}

  return {
    ok: true,
    reason,
    previousVersion,
    currentVersion,
    migrationResult
  };
}

const IS_SERVICE_WORKER_CONTEXT = typeof chrome !== 'undefined' && typeof window === 'undefined';

if (IS_SERVICE_WORKER_CONTEXT && chrome.runtime?.onInstalled) {
  chrome.runtime.onInstalled.addListener((details) => {
    handleInstalled(details).catch(() => {});
  });
}

// Open side panel when extension action icon clicked
if (IS_SERVICE_WORKER_CONTEXT && chrome.action?.onClicked) {
  chrome.action.onClicked.addListener(async (tab) => {
    if (tab?.id) {
      await chrome.sidePanel.open({ tabId: tab.id });
      await chrome.sidePanel.setOptions({
        tabId: tab.id,
        path: 'sidepanel/index.html',
        enabled: true
      });
    }
  });
}

// ─── Toolbar Icon Synchronization ─────────────────────────────────────────────

async function syncToolbarIcon(tabId) {
  if (!tabId || typeof chrome === 'undefined' || !chrome.tabs) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab?.url) return;
    const url = tab.url.toLowerCase();

    let folder = 'icons/neutral';
    if (url.includes('web.whatsapp.com')) {
      folder = 'icons/whatsapp';
    } else if (url.includes('messenger.com') || url.includes('facebook.com/messages')) {
      folder = 'icons/messenger';
    }

    chrome.action?.setIcon?.({
      path: {
        16: `${folder}/icon16.png`,
        32: `${folder}/icon32.png`,
        48: `${folder}/icon48.png`,
        128: `${folder}/icon128.png`
      }
    }).catch(() => {});
  } catch (_) {}
}

if (IS_SERVICE_WORKER_CONTEXT && chrome.tabs?.onActivated) {
  chrome.tabs.onActivated.addListener(({ tabId }) => syncToolbarIcon(tabId));
}
if (IS_SERVICE_WORKER_CONTEXT && chrome.tabs?.onUpdated) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url || changeInfo.status === 'complete') {
      syncToolbarIcon(tabId);
    }
  });
}

// ─── Message Router ──────────────────────────────────────────────────────────

if (IS_SERVICE_WORKER_CONTEXT && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg?.type) {
      case 'SCAN_PROGRESS':
        chrome.runtime.sendMessage({ type: 'SCAN_PROGRESS', payload: msg.payload }).catch(() => {});
        break;

      case 'SCAN_COMPLETE':
        handleScanComplete(msg.payload, sendResponse);
        return true;

      case 'CLEAR_SESSION':
        chrome.storage.session.clear(() => sendResponse({ ok: true }));
        return true;

      case 'GET_SESSION':
        chrome.storage.session.get(msg.keys || null, (data) => sendResponse({ ok: true, data }));
        return true;

      case 'SET_SESSION':
        chrome.storage.session.set(msg.data, () => sendResponse({ ok: true }));
        return true;

      case 'RUNTIME_ERROR':
        sendResponse({ ok: true });
        break;

      default:
        sendResponse({ error: 'Unknown message type: ' + msg?.type });
    }
  });
}

export async function handleScanComplete(payload = {}, sendResponse = () => {}) {
  const stepErrors = [];
  const record = (step, err) => {
    stepErrors.push({
      step,
      message: err?.message || String(err),
      stack: err?.stack || ''
    });
  };

  try {
    const safePayload = payload && typeof payload === 'object' ? payload : {};
    const {
      messages: rawMessages,
      chatName,
      platform = 'WhatsApp',
      isPartial = false,
      oldestTimestamp = null,
      integrity = null,
      chatType = null,
      options: rawOptions = undefined,
      myName = '',
      detectedMyName = ''
    } = safePayload;

    if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
      const res = {
        ok: false,
        error: 'No messages could be extracted from this conversation.',
        stepErrors: [{ step: 'validate_messages', message: 'Empty or missing messages array', stack: '' }]
      };
      sendResponse(res);
      return res;
    }

    const messages = rawMessages.map(m => ({
      ...(m && typeof m === 'object' ? m : {}),
      timestamp: m?.timestamp ? new Date(m.timestamp) : null
    }));

    let stats;
    try {
      stats = buildStats(messages, chatName, platform);
      stats.isPartial = isPartial;
      stats.oldestTimestamp = oldestTimestamp;
      stats.integrity = integrity;
      stats.chatType = chatType;
    } catch (err) {
      record('service_worker_build_stats', err);
      stats = {
        chatName: chatName || 'Conversation',
        platform,
        totalMessages: messages.length,
        dateRange: { start: null, end: null },
        senderCounts: {},
        typeCounts: {},
        isPartial,
        oldestTimestamp,
        integrity,
        chatType
      };
    }

    const transcriptOptions = normalizeExportOptions(rawOptions, {
      chatName: chatName || stats.chatName || '',
      platform,
      myName,
      detectedMyName
    });

    let transcript = '';
    try {
      transcript = buildTranscript(messages, {}, transcriptOptions);
    } catch (err) {
      record('service_worker_build_transcript', err);
    }

    try {
      if (typeof chrome !== 'undefined' && chrome.storage?.session?.set) {
        await chrome.storage.session.set({
          messages: JSON.stringify(messages),
          transcript,
          chatName,
          platform,
          stats: JSON.stringify(stats)
        });
      }
    } catch (err) {
      record('service_worker_storage_save', err);
    }

    const res = { ok: true, stats, transcriptLength: transcript.length, stepErrors };
    sendResponse(res);
    return res;
  } catch (err) {
    const res = {
      ok: false,
      error: err?.message || String(err),
      stack: err?.stack || '',
      stepErrors
    };
    sendResponse(res);
    return res;
  }
}
