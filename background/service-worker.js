/**
 * service-worker.js
 * Background service worker for ChatFlow (MV3).
 * Handles side panel opening, toolbar icon switching, and session message storage.
 * Completely local — zero external network calls.
 */

import { buildTranscript, buildStats } from '../lib/transcript.js';

// Open side panel when extension action icon clicked
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

// ─── Toolbar Icon Synchronization ─────────────────────────────────────────────

async function syncToolbarIcon(tabId) {
  if (!tabId) return;
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

    chrome.action.setIcon({
      path: {
        16: `${folder}/icon16.png`,
        32: `${folder}/icon32.png`,
        48: `${folder}/icon48.png`,
        128: `${folder}/icon128.png`
      }
    }).catch(() => {});
  } catch (_) {}
}

chrome.tabs.onActivated.addListener(({ tabId }) => syncToolbarIcon(tabId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === 'complete') {
    syncToolbarIcon(tabId);
  }
});

// ─── Message Router ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {
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

    default:
      sendResponse({ error: 'Unknown message type: ' + msg.type });
  }
});

async function handleScanComplete(payload, sendResponse) {
  try {
    const {
      messages: rawMessages,
      chatName,
      platform = 'WhatsApp',
      isPartial = false,
      oldestTimestamp = null,
      integrity = null,
      chatType = null
    } = payload;

    const messages = rawMessages.map(m => ({
      ...m,
      timestamp: m.timestamp ? new Date(m.timestamp) : null
    }));

    const stats = buildStats(messages, chatName, platform);
    stats.isPartial = isPartial;
    stats.oldestTimestamp = oldestTimestamp;
    stats.integrity = integrity;
    stats.chatType = chatType;

    const transcript = buildTranscript(messages);

    await chrome.storage.session.set({
      messages: JSON.stringify(messages),
      transcript,
      chatName,
      platform,
      stats: JSON.stringify(stats)
    });

    sendResponse({ ok: true, stats, transcriptLength: transcript.length });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }
}
