/**
 * whatsapp.js
 * ChatFlow platform adapter for WhatsApp Web (https://web.whatsapp.com/*).
 * Implements the BaseAdapter interface. Encapsulates all WhatsApp DOM selectors,
 * contact name parsing (skipping presence text), phone-sync trigger auto-click,
 * and message normalization.
 */

import { BaseAdapter } from './base.js';
import {
  sanitizeChatName,
  sanitizeSenderName,
  validatePersonName,
  isTickLabel,
  isLocalizedYou,
  truncateQuoteText,
  OUTGOING_TICK_SELECTORS,
  INTRO_BLOCK_PATTERNS,
  LOCALIZED_DELETED_PATTERNS,
  cleanMessageText
} from '../selectors.js';
import { geometryVote, nameVote } from '../direction.js';

export class WhatsAppAdapter extends BaseAdapter {
  constructor() {
    super('WhatsApp');

    this.promptClickCount = 0;
    this.lastPromptClickTime = 0;

    this.selectors = {
      scrollContainer: {
        primary: '#main div[data-testid="conversation-panel-messages"]',
        fallbacks: [
          '#main div[tabindex="-1"][data-tab]',
          '#main .copyable-area [role="application"]',
          '#main div[role="region"]',
          '#main [data-tab="8"]',
          '#main [data-tab="7"]',
          '#main [data-tab="6"]',
          '#main .message-list-v2',
          '#main [class*="message-list"]',
          '#main [class*="msg-container"]',
          '#main div[tabindex="0"]'
        ]
      },
      messageRow: {
        primary: '#main [data-id]',
        fallbacks: [
          '[data-id]',
          '#main .message-in, #main .message-out',
          '.message-in, .message-out',
          '[class*="message-in"], [class*="message-out"]',
          '[data-testid="msg-container"]'
        ]
      },
      messageText: {
        primary: '[data-testid="msg-container"] span.selectable-text',
        fallbacks: [
          'span.selectable-text.copyable-text',
          'span.selectable-text',
          '[class*="copyable-text"] span',
          '.copyable-text'
        ]
      },
      chatHeader: {
        primary: '#main header [data-testid="conversation-info-header-chat-title"] span[title]',
        fallbacks: [
          '#main header [data-testid="conversation-info-header-chat-title"] span',
          '#main header [data-testid="conversation-info-header-chat-title"]',
          '#main header div[role="button"] > div:first-child span[title]',
          '#main header div[role="button"] > div:first-child span[dir="auto"]',
          '#main header h2 span[title]',
          '#main header h2 span[dir="auto"]',
          '#main header h2',
          '[data-testid="conversation-info-header-chat-title"] span'
        ]
      },
      replyQuote: {
        primary: '[data-testid="quoted-message"]',
        fallbacks: [
          'div[aria-label*="Quoted"]',
          '[class*="quoted-message"]'
        ]
      }
    };
  }

  detect(url = window.location.href) {
    if (!url || typeof url !== 'string') return false;
    return url.startsWith('https://web.whatsapp.com') || url.startsWith('http://web.whatsapp.com');
  }

  /**
   * Filter out presence and status indicators.
   */
  isValidContactName(text) {
    if (!text || typeof text !== 'string') return false;
    const t = text.trim();
    if (!t) return false;

    const presencePatterns = [
      /\blast seen\b/i,
      /^online$/i,
      /^typing\b/i,
      /^recording audio\b/i,
      /^click here for (contact|group) info/i,
      /\btoday at\b/i,
      /\byesterday at\b/i,
      /\b\d{1,2}:\d{2}\s*(am|pm)\b/i,
      /^mute notifications/i,
      /^custom notifications/i
    ];

    for (const pat of presencePatterns) {
      if (pat.test(t)) return false;
    }
    return true;
  }

  cleanChatName(str) {
    return sanitizeChatName(str, '');
  }

  getChatName(doc = document) {
    // 1. Direct title selectors
    for (const sel of [this.selectors.chatHeader.primary, ...this.selectors.chatHeader.fallbacks]) {
      try {
        const el = doc.querySelector(sel);
        if (el) {
          const val = el.getAttribute('title') || el.innerText || el.textContent || '';
          const clean = sanitizeChatName(val, '');
          if (clean && this.isValidContactName(clean)) return clean;
        }
      } catch (_) {}
    }

    // 2. Scan header elements, deliberately skipping conversation-info-header-chat-status
    try {
      const mainHeader = doc.querySelector('#main header');
      if (mainHeader) {
        const statusBox = mainHeader.querySelector('[data-testid="conversation-info-header-chat-status"]');
        const candidates = mainHeader.querySelectorAll('span[title], span[dir="auto"], div[title]');
        for (const el of candidates) {
          if (statusBox && statusBox.contains(el)) continue;
          const val = el.getAttribute('title') || el.innerText || el.textContent || '';
          const clean = sanitizeChatName(val, '');
          if (clean && this.isValidContactName(clean)) return clean;
        }
      }
    } catch (_) {}

    // 3. Fallback: check active item in left sidebar list (#pane-side)
    try {
      const activeItem = doc.querySelector('#pane-side [aria-selected="true"], #pane-side [class*="active"], #pane-side [class*="selected"]');
      if (activeItem) {
        const candidates = activeItem.querySelectorAll('span[title], span[dir="auto"]');
        for (const el of candidates) {
          const val = el.getAttribute('title') || el.innerText || el.textContent || '';
          const clean = sanitizeChatName(val, '');
          if (clean && this.isValidContactName(clean)) return clean;
        }
      }
    } catch (_) {}

    return 'WhatsApp chat';
  }

  /**
   * Detect whether the active WhatsApp chat is 'one-to-one' or 'group'.
   * Uses #main header subtitle/status and group-info hints.
   * @param {Document} [doc=document]
   * @returns {'one-to-one'|'group'}
   */
  detectChatType(doc = document) {
    try {
      const mainHeader = doc.querySelector('#main header');
      if (!mainHeader) return 'one-to-one';

      const statusEl = mainHeader.querySelector(
        '[data-testid="conversation-info-header-chat-status"], span[title]'
      );
      const headerText = (mainHeader.innerText || mainHeader.textContent || '').trim();
      const subtitleText = (statusEl?.getAttribute('title') || statusEl?.innerText || statusEl?.textContent || '').trim();

      // Explicit group hints
      if (/click here for group info|tap here for group info|group info/i.test(headerText) ||
          /click here for group info|tap here for group info/i.test(subtitleText)) {
        return 'group';
      }
      if (mainHeader.querySelector('[data-testid="default-group"], [data-icon="default-group"]')) {
        return 'group';
      }

      // Explicit 1-to-1 presence hints
      if (/^(?:online|typing\.{0,3}|recording audio\.{0,3}|last seen\b.*|click here for contact info)$/i.test(subtitleText)) {
        return 'one-to-one';
      }

      // Subtitle listing member names separated by commas (e.g. "Alice, Bob, You")
      if (subtitleText && subtitleText.includes(',') && !/\b(?:last seen|today|yesterday)\b/i.test(subtitleText)) {
        const parts = subtitleText.split(',').map(p => p.trim()).filter(Boolean);
        if (parts.length >= 2) return 'group';
      }
    } catch (_) {}

    return 'one-to-one';
  }

  /**
   * Detect the current user's display name from profile/account element or outgoing messages.
   * @param {Document} [doc=document]
   * @returns {string|null}
   */
  detectMyProfileName(doc = document) {
    try {
      const contactName = this.getChatName ? (this.getChatName(doc) || '') : '';
      const profileSelectors = [
        'header [data-testid="menu-bar-user-avatar"] img[alt]',
        '[data-testid="drawer-left"] [data-testid="col-main-profile"] span[dir="auto"]',
        'header img[alt][src*="pp"]'
      ];
      for (const sel of profileSelectors) {
        const el = doc.querySelector(sel);
        if (el) {
          // Skip interface button labels unless it's an avatar img alt that passes strict person-name validation
          if (el.tagName !== 'IMG' && el.closest?.('button, [role="button"]')) continue;
          const raw = el.getAttribute('alt') || el.textContent || '';
          const clean = validatePersonName(raw, { contactName });
          if (clean) return clean;
        }
      }
    } catch (_) {}
    return null;
  }

  getScrollContainer(doc = document) {
    const primary = doc.querySelector(this.selectors.scrollContainer.primary);
    if (primary) return primary;

    for (const fb of this.selectors.scrollContainer.fallbacks) {
      try {
        const el = doc.querySelector(fb);
        if (el) return el;
      } catch (_) {}
    }

    // Dynamic heuristic fallback for scrollable container inside #main
    const mainEl = doc.querySelector('#main') || doc;
    const candidates = mainEl.querySelectorAll('div');
    for (const cand of candidates) {
      if (cand.scrollHeight > cand.clientHeight && cand.clientHeight > 200) {
        return cand;
      }
    }

    return null;
  }

  /**
   * Determine whether the conversation beginning / top has been reached in WhatsApp.
   * @param {HTMLElement} container
   * @param {Document|Element} [doc=document]
   * @param {Object} [tracker=null]
   * @returns {{ reached: boolean, reason?: string }}
   */
  hasReachedTop(container, doc = (typeof document !== 'undefined' ? document : null), tracker = null) {
    if (!container) return { reached: true, reason: 'no_container' };

    // 1. Check for encryption banner (English & Bengali)
    const textSample = (container.innerText || container.textContent || '').slice(0, 3000);
    for (const rx of INTRO_BLOCK_PATTERNS) {
      if (rx.test(textSample)) {
        return { reached: true, reason: 'whatsapp_encryption_notice' };
      }
    }

    if (doc) {
      const secureNotice = doc.querySelector('[data-testid="chat-secure-notice"]');
      if (secureNotice) {
        return { reached: true, reason: 'chat_secure_notice' };
      }
    }

    // 2. scrollTop <= 2 and no older messages trigger present
    const hasOlderTrigger = doc ? !!this.findOlderMessagesTrigger(doc) : false;
    if (container.scrollTop <= 2 && !hasOlderTrigger) {
      if (tracker && tracker.scrollTopZeroChecks >= 2) {
        return { reached: true, reason: 'whatsapp_top_idle' };
      }
    }

    // 3. Static message signature for 3 checks
    if (tracker) {
      const firstRow = doc?.querySelector(this.selectors.messageRow.primary) || container.querySelector?.('[data-id]');
      if (firstRow) {
        const sig = (firstRow.getAttribute?.('data-id') || firstRow.innerText || '').slice(0, 40) + '@' + (firstRow.offsetTop || 0);
        if (tracker.lastTopSig && tracker.lastTopSig === sig) {
          tracker.topStableCount = (tracker.topStableCount || 0) + 1;
          if (tracker.topStableCount >= 3 && !hasOlderTrigger) {
            return { reached: true, reason: 'top_element_static_3_checks' };
          }
        } else {
          tracker.topStableCount = 0;
          tracker.lastTopSig = sig;
        }
      }

      // 4. Hard cap
      if (tracker.attempts >= 45) {
        return { reached: true, reason: 'phase1_attempts_cap_45' };
      }
    }

    return { reached: false };
  }

  /**
   * Determine whether the conversation bottom has been reached in WhatsApp.
   * @param {HTMLElement} container
   * @param {Document|Element} [doc=(typeof document !== 'undefined' ? document : null)]
   * @returns {{ reached: boolean, reason?: string }}
   */
  hasReachedBottom(container, _doc = (typeof document !== 'undefined' ? document : null)) {
    if (!container) return { reached: true, reason: 'no_container' };
    const atBottom = (container.scrollTop + container.clientHeight >= container.scrollHeight - 6);
    return { reached: atBottom, reason: atBottom ? 'scroll_at_bottom' : 'scrolling' };
  }

  /**
   * Locate the "Click here to get older messages from your phone" trigger.
   * Supports English, Bengali, and additional common language localizations.
   */
  findOlderMessagesTrigger(doc = document) {
    const main = doc.querySelector('#main') || doc;

    const selectors = [
      '[data-testid="btn-load-more-messages"]',
      '[data-testid="load-older-messages"]',
      '[data-testid*="older-messages"]',
      '[data-testid*="load-more"]',
      'button[class*="load-more"]',
      'div[class*="load-more"]'
    ];

    for (const sel of selectors) {
      try {
        const el = main.querySelector(sel);
        if (el) return el;
      } catch (_) {}
    }

    // Explicit English & Bengali patterns + international variants
    const olderRx = /(older messages|get older messages|load older|see older|from your phone|messages from your phone|পুরোনো মেসেজ|পুরানো মেসেজ|ফোন থেকে পুরোনো|ফোন থেকে পুরানো|মেসেজ পেতে এখানে ক্লিক করুন|mensajes anteriores|mensajes más antiguos|mensagens anteriores|mensagens mais antigas|पुराने संदेश)/i;
    const clickables = main.querySelectorAll('button, div[role="button"], span[role="button"], [tabindex="0"], a');

    for (const el of clickables) {
      const text = (el.innerText || el.textContent || '').trim();
      if (olderRx.test(text) && text.length < 150) {
        return el;
      }
    }

    const candidates = main.querySelectorAll('span, div, p');
    for (const el of candidates) {
      if (el.children.length <= 2) {
        const text = (el.innerText || el.textContent || '').trim();
        if (olderRx.test(text) && text.length < 150) {
          const parent = el.closest('[role="button"], button, [tabindex], [class*="button"]');
          return parent || el;
        }
      }
    }

    return null;
  }

  /**
   * Dispatch full synthetic click and pointer sequence on older messages trigger.
   * Auto-retries max 3 clicks per stall with delays.
   */
  triggerLoadOlderMessages(doc = document) {
    const el = this.findOlderMessagesTrigger(doc);
    if (!el) return false;

    const now = Date.now();
    // Throttle: max 3 clicks per stall; must wait at least 2500ms between attempts
    if (this.promptClickCount >= 3) {
      if (now - this.lastPromptClickTime < 15000) {
        return false;
      } else {
        this.promptClickCount = 0; // reset after cool-down window
      }
    }

    if (now - this.lastPromptClickTime < 2200) {
      return false;
    }

    this.promptClickCount++;
    this.lastPromptClickTime = now;

    try {
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
    } catch (_) {}

    try {
      if (typeof el.click === 'function') el.click();

      const opts = { bubbles: true, cancelable: true, view: window };
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new PointerEvent('pointerup', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.dispatchEvent(new MouseEvent('click', opts));

      if (el.firstElementChild) {
        try {
          if (typeof el.firstElementChild.click === 'function') el.firstElementChild.click();
          el.firstElementChild.dispatchEvent(new MouseEvent('click', opts));
        } catch (_) {}
      }

      return true;
    } catch (_) {
      return false;
    }
  }

  async scrollToLoadOlder(container, doc = document, onProgress = () => {}, ctrl = null) {
    const isStopped = () => !!(ctrl?.cancelled || ctrl?.finalized || ctrl?.signal?.aborted);
    const waitMs = (ms) => new Promise(resolve => {
      if (isStopped()) { resolve(); return; }
      const sig = ctrl?.signal;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(t);
        if (sig && typeof sig.removeEventListener === 'function') {
          try { sig.removeEventListener('abort', finish); } catch (_) {}
        }
        resolve();
      };
      if (sig && typeof sig.addEventListener === 'function') {
        try { sig.addEventListener('abort', finish, { once: true }); } catch (_) {}
      }
      const t = setTimeout(finish, ms);
    });

    // 1. Scroll container to top
    container.scrollTop = 0;
    container.dispatchEvent(new Event('scroll', { bubbles: true }));

    if (isStopped()) {
      return { newMessagesFound: false, atTop: false };
    }

    // 2. Check for "Click here to get older messages from your phone"
    const clickedOlder = this.triggerLoadOlderMessages(doc);
    if (clickedOlder) {
      onProgress({
        phase: 'syncing_phone',
        statusText: 'Fetching older messages from your phone...'
      });

      // Wait up to 6.5s for phone sync to deliver messages, aborting immediately on signal
      const startTime = Date.now();
      while (Date.now() - startTime < 6500) {
        if (isStopped()) break;
        await waitMs(250);
        if (isStopped()) break;

        container.scrollTop = 0;
        container.dispatchEvent(new Event('scroll', { bubbles: true }));
        if (!this.findOlderMessagesTrigger(doc)) break;
      }
      return { newMessagesFound: !isStopped(), atTop: false };
    }

    // 3. Normal scroll wait with immediate signal abort
    for (let i = 0; i < 4; i++) {
      if (isStopped()) break;
      await waitMs(110);
      if (isStopped()) break;
    }

    if (isStopped()) {
      return { newMessagesFound: false, atTop: false };
    }

    const atTop = container.scrollTop === 0 && !this.findOlderMessagesTrigger(doc);
    return { newMessagesFound: true, atTop };
  }

  extractMessages(doc = document) {
    const rows = [];
    for (const sel of [this.selectors.messageRow.primary, ...this.selectors.messageRow.fallbacks]) {
      try {
        const found = doc.querySelectorAll(sel);
        if (found && found.length > 0) {
          for (const el of found) {
            if (el.parentElement && el.parentElement.closest && el.parentElement.closest('[data-id]')) {
              continue;
            }
            rows.push(el);
          }
          if (rows.length > 0) break;
        }
      } catch (_) {}
    }

    const chatName = this.getChatName(doc);
    const chatType = this.detectChatType(doc);
    const profileName = this.detectMyProfileName(doc);
    const pane = this.getScrollContainer(doc);
    const context = {
      chatName: chatName && chatName !== 'WhatsApp chat' ? chatName : null,
      chatType,
      myName: profileName,
      paneRect: pane && pane.getBoundingClientRect ? pane.getBoundingClientRect() : null
    };

    const messages = [];
    const seen = new Set();

    for (const row of rows) {
      const msg = this.parseMessageRow(row, context);
      if (msg && !seen.has(msg.id)) {
        seen.add(msg.id);
        messages.push(msg);
      }
    }

    // NOTE: display names are NOT resolved here. Direction (isMe) is decided at the end of the scan
    // by content/direction.js, and names are derived from it.

    if (messages.length > 0) {
      this.promptClickCount = 0;
    }

    return messages;
  }

  /**
   * Find the quoted-message element inside a message row, if any.
   * @param {Element} el
   * @returns {Element|null}
   */
  findQuoteElement(el) {
    const allQuoteSelectors = [this.selectors.replyQuote.primary, ...this.selectors.replyQuote.fallbacks];
    for (const sel of allQuoteSelectors) {
      try {
        const found = el.querySelector(sel);
        if (found) return found;
      } catch (_) {}
    }
    return null;
  }

  /**
   * Extract structured reply quote { sender, text, type } from a quoted-message element.
   * Quote labels belong to replyTo.sender and must never create participants.
   * @param {Element} quoteEl
   * @param {Object} context
   * @returns {{ sender: string, text: string, type: string }|null}
   */
  extractQuote(quoteEl, context = {}) {
    if (!quoteEl) return null;
    try {
      const senderNode = quoteEl.querySelector('span[dir="auto"], div[dir="auto"]');
      const rawSender = (senderNode?.innerText || senderNode?.textContent || '').trim();
      const qSender = sanitizeSenderName(rawSender, { myName: context.myName }) || rawSender || '';

      const qType = this.detectMediaType(quoteEl) || 'text';

      // Extract quoted text excluding the sender header node
      let qText = '';
      const textNodes = quoteEl.querySelectorAll('.quoted-mention, span.selectable-text, [data-testid="quoted-text"]');
      if (textNodes.length > 0) {
        qText = Array.from(textNodes)
          .filter(n => !senderNode || (n !== senderNode && !senderNode.contains(n)))
          .map(n => n.innerText || n.textContent || '')
          .join(' ')
          .trim();
      }
      if (!qText) {
        const full = (quoteEl.innerText || quoteEl.textContent || '').trim();
        qText = rawSender && full.startsWith(rawSender)
          ? full.slice(rawSender.length).trim()
          : full;
      }
      qText = qText.replace(/\s+/g, ' ').trim();
      const mediaType = qType !== 'text' ? qType : null;
      const cleanText = mediaType && (!qText || qText === `[${qType}]`) ? '' : truncateQuoteText(qText, 140);

      if (!qSender && !cleanText && !mediaType) return null;
      return {
        sender: qSender || 'Unknown',
        text: cleanText,
        type: qType,
        mediaType,
        senderIsMe: Boolean(isLocalizedYou(rawSender))
      };
    } catch (_) {
      return null;
    }
  }

  parseMessageRow(el, context = {}) {
    if (!el || (typeof Element !== 'undefined' && !(el instanceof Element))) return null;

    const dataId = el.getAttribute('data-id') || '';

    // 1. Parse data-pre-plain-text "[time, date] Sender: " (name = cosmetic + one vote)
    const prePlainText = el.getAttribute('data-pre-plain-text') ||
                         el.querySelector('[data-pre-plain-text]')?.getAttribute('data-pre-plain-text') ||
                         '';
    const { timestamp, sender: rawPreSender } = this.parsePrePlainText(prePlainText);

    // 2. Message type detection
    const type = this.detectMessageType(el);

    // 3. Direction: collect independent votes. Final isMe is decided later by direction.js.
    const dirVotes = this.collectDirectionVotes(el, dataId, rawPreSender, context);
    const provisional = Object.values(dirVotes).filter(v => v === true || v === false);
    const isOutgoing = provisional.length
      ? provisional.filter(Boolean).length > provisional.length / 2
      : false;

    // 3b. senderRaw keeps the original name string; display sender is derived at the end from isMe.
    const senderRaw = type === 'system' ? 'System' : (rawPreSender || '');
    const sender = type === 'system'
      ? 'System'
      : (isOutgoing ? (context.myName || 'Me') : (context.chatName || 'Contact'));

    // 4. Detect reply/quote BEFORE extracting body so body never duplicates quote
    const quoteEl = this.findQuoteElement(el);
    const replyTo = this.extractQuote(quoteEl, context);

    // 5. Extract message body (excluding quoteEl)
    let text = this.extractText(el, type, quoteEl);
    if (!text && type === 'text') return null;
    if (type === 'text') {
      const clean = cleanMessageText(text);
      text = clean.text || text;
    }

    // Verify body !== quoted text unless the bubble genuinely has its own non-quote text node
    if (replyTo && replyTo.text && text && text.trim() === replyTo.text.trim()) {
      const ownTextNodes = Array.from(el.querySelectorAll('span.selectable-text, .copyable-text'))
        .filter(n => !quoteEl || !quoteEl.contains(n));
      if (ownTextNodes.length === 0) {
        if (type === 'text') return null;
      }
    }

    // 6. Edited flag & reactions
    const metaText = (el.querySelector('[data-testid="msg-meta"]')?.textContent || '').trim();
    const isEdited = !!(el.querySelector('[data-testid="edited-message-label"]') || /\bEdited\b/i.test(metaText));
    const reactions = this.extractReactions(el);

    // Unique stable ID
    const tsStr = timestamp ? timestamp.toISOString() : '';
    const key = dataId || this.hashString(`${tsStr}|${sender}|${text.slice(0, 50)}`);

    const fingerprint = {
      sender,
      type,
      text: text.slice(0, 100),
      isMe: isOutgoing
    };

    return {
      id: key,
      domId: dataId || null,
      fingerprint,
      timestamp: timestamp ? timestamp.toISOString() : null,
      timestampApproximate: false,
      sender,
      senderRaw,
      text,
      type,
      replyTo,
      isOutgoing,
      isMe: isOutgoing,
      dirVotes,
      isEdited,
      reactions
    };
  }

  /**
   * Find the visual bubble element of a row (the element that is shifted left/right).
   */
  findBubble(el) {
    const cand = el.querySelector('[data-testid="msg-container"]') ||
                 el.querySelector('[data-pre-plain-text]')?.parentElement ||
                 el.querySelector('.copyable-text')?.parentElement ||
                 null;
    return cand || el;
  }

  /** Background colour of the bubble (first non-transparent colour from bubble up to the row). */
  getBubbleColor(el) {
    try {
      if (typeof getComputedStyle !== 'function') return null;
      let node = this.findBubble(el);
      for (let i = 0; node && i < 6; i++) {
        const bg = getComputedStyle(node).backgroundColor || '';
        const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
        if (m && (m[4] === undefined || parseFloat(m[4]) > 0.5)) {
          return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
        }
        if (node === el) break;
        node = node.parentElement;
      }
    } catch (_) {}
    return null;
  }

  /**
   * Independent direction signals. true = mine, false = contact's, null = no opinion.
   * Reply-quote labels are NOT signals (the quote element is excluded from every check).
   */
  collectDirectionVotes(el, dataId, rawPreSender, context = {}) {
    const votes = { class: null, geometry: null, ticks: null, name: null, colorRgb: null };

    // a) Container class / ancestor / data-id prefix
    try {
      const hasOut = el.classList?.contains('message-out') || !!el.closest?.('.message-out') || !!el.querySelector?.('.message-out');
      const hasIn = el.classList?.contains('message-in') || !!el.closest?.('.message-in') || !!el.querySelector?.('.message-in');
      if (hasOut && !hasIn) votes.class = true;
      else if (hasIn && !hasOut) votes.class = false;
      else if (dataId.startsWith('true_')) votes.class = true;
      else if (dataId.startsWith('false_')) votes.class = false;
    } catch (_) {}

    // b) Geometry relative to the message pane
    try {
      if (context.paneRect && typeof el.getBoundingClientRect === 'function') {
        votes.geometry = geometryVote(this.findBubble(el).getBoundingClientRect(), context.paneRect);
      }
    } catch (_) {}

    // c) Delivery status icons (only outgoing messages have ticks)
    try {
      const meta = el.querySelector('[data-testid="msg-meta"]');
      if (el.querySelector(OUTGOING_TICK_SELECTORS)) {
        votes.ticks = true;
      } else {
        const labelled = Array.from(el.querySelectorAll('[aria-label]'))
          .some(n => isTickLabel(n.getAttribute('aria-label')));
        if (labelled) votes.ticks = true;
        else if (meta) votes.ticks = false;
      }
    } catch (_) {}

    // d) Bubble colour (clustered later across the first 50 rows)
    votes.colorRgb = this.getBubbleColor(el);

    // e) data-pre-plain-text name vs my profile name / chat name
    votes.name = nameVote(rawPreSender, { myName: context.myName, chatName: context.chatName, chatType: context.chatType });

    return votes;
  }

  extractReactions(el) {
    try {
      const rxEls = el.querySelectorAll('[data-testid="reaction-bubble"], button[aria-label*="reaction" i]');
      const out = [];
      for (const r of rxEls) {
        const txt = (r.innerText || r.textContent || r.getAttribute('aria-label') || '').trim();
        if (txt) out.push(txt.replace(/\s+/g, ' '));
      }
      return Array.from(new Set(out));
    } catch (_) {
      return [];
    }
  }

  /**
   * Cheap, read-only peek at the OLDEST loaded message date (no extraction, no counting).
   * Used by the "Loaded back to ..." status lines.
   * @returns {Date|null}
   */
  peekOldestDate(doc = document) {
    try {
      const main = doc.querySelector('#main') || doc;
      const nodes = main.querySelectorAll('[data-pre-plain-text]');
      for (let i = 0; i < nodes.length && i < 12; i++) {
        const { timestamp } = this.parsePrePlainText(nodes[i].getAttribute('data-pre-plain-text'));
        if (timestamp) return timestamp;
      }
    } catch (_) {}
    return null;
  }

  parsePrePlainText(str) {
    if (!str) return { timestamp: null, sender: null };

    // Format: "[1:22 AM, 11/5/2026] Name: "
    // Name is everything after "] " up to the LAST ":" (handles colons inside display names).
    const bracketMatch = str.match(/\[(\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AaPp][Mm])?),\s*([0-9./-]+)\]\s*(.+)$/);
    if (!bracketMatch) return { timestamp: null, sender: null };

    const [, timeStr, dateStr, rest] = bracketMatch;
    const lastColonIdx = rest.lastIndexOf(':');
    const rawSender = lastColonIdx > 0 ? rest.slice(0, lastColonIdx) : rest;
    const date = this.parseDateTime(dateStr, timeStr);

    return {
      timestamp: date,
      sender: sanitizeSenderName(rawSender)
    };
  }

  parseDateTime(dateStr, timeStr) {
    try {
      const parts = dateStr.split(/[./-]/).map(Number);
      let day, month, year;
      if (parts[0] > 1000) {
        [year, month, day] = parts;
      } else {
        // WhatsApp web uses D/M/YYYY or M/D/YYYY based on locale; if second > 12 it's M/D/Y
        const [p1, p2, p3] = parts;
        if (p2 > 12 && p1 <= 12) {
          month = p1; day = p2; year = p3;
        } else {
          day = p1; month = p2; year = p3;
        }
      }
      if (year < 100) year += 2000;

      let hours = 0, minutes = 0;
      const tMatch = timeStr.match(/(\d{1,2}):(\d{2})/);
      if (tMatch) {
        hours = parseInt(tMatch[1], 10);
        minutes = parseInt(tMatch[2], 10);
      }
      if (/pm/i.test(timeStr) && hours < 12) hours += 12;
      if (/am/i.test(timeStr) && hours === 12) hours = 0;

      const d = new Date(year, month - 1, day, hours, minutes);
      return isNaN(d.getTime()) ? null : d;
    } catch {
      return null;
    }
  }

  detectMediaType(el) {
    if (!el) return null;
    if (el.querySelector('[data-testid="audio-player"], [data-icon="audio-play"], [data-testid="ptt-play"]')) return 'voice';
    if (el.querySelector('[data-testid="sticker"], [class*="sticker"]')) return 'sticker';
    if (el.querySelector('[data-testid="media-play"], video')) return 'video';
    if (el.querySelector('img[src*="blob:"], [data-testid="image-thumb"], [class*="image-thumb"]')) return 'image';
    if (el.querySelector('[data-testid="document-thumb"], [data-icon="document"]')) return 'file';
    if (el.querySelector('[data-testid="location-thumb"], [data-icon="location"]')) return 'location';
    if (el.querySelector('[data-testid="vcard-container"], [data-icon="contact"]')) return 'contact';
    if (el.querySelector('[data-testid="poll-container"], [data-icon="poll"]')) return 'poll';
    if (el.querySelector('[data-icon="missed-call"], [data-icon="call"]')) return 'call';
    return null;
  }

  detectMessageType(el) {
    const media = this.detectMediaType(el);
    if (media) return media;

    const textContent = el.textContent || '';
    for (const rx of LOCALIZED_DELETED_PATTERNS) {
      if (rx.test(textContent)) return 'deleted';
    }
    if (textContent.includes('Messages and calls are end-to-end encrypted') ||
        el.querySelector('[data-testid="system-message-container"]')) {
      return 'system';
    }

    return 'text';
  }

  extractText(el, type, quoteEl = null) {
    switch (type) {
      case 'voice': {
        const durEl = el.querySelector('[data-testid="audio-player"] span, [data-testid="ptt-duration"]');
        const dur = durEl ? (durEl.textContent || '').trim() : '';
        return /\d+:\d{2}/.test(dur) ? `[voice message (${dur})]` : '[voice message]';
      }
      case 'sticker': return '[sticker]';
      case 'video':   return '[video]';
      case 'image':   return '[image]';
      case 'file': {
        const nameEl = el.querySelector('[data-testid="document-thumb"] span[title], [data-testid="document-name"]');
        const fname = nameEl ? (nameEl.getAttribute('title') || nameEl.textContent || '').trim() : '';
        return fname ? `[document: ${fname}]` : '[file]';
      }
      case 'location': return '[location]';
      case 'contact':  return '[contact]';
      case 'poll':     return '[poll]';
      case 'call': {
        const callTxt = (el.textContent || '').toLowerCase();
        return callTxt.includes('missed') ? '[call (missed)]' : '[call]';
      }
      case 'deleted': return 'This message was deleted';
      case 'system':
        return (el.innerText || el.textContent || '').trim();
      case 'text':
      default: {
        const selectors = [this.selectors.messageText.primary, ...this.selectors.messageText.fallbacks];
        for (const sel of selectors) {
          try {
            const candidates = el.querySelectorAll(sel);
            for (const cand of candidates) {
              if (quoteEl && quoteEl.contains(cand)) continue;
              const txt = cand.innerText || cand.textContent || '';
              if (txt.trim()) return txt;
            }
          } catch (_) {}
        }

        const copyables = el.querySelectorAll('.copyable-text');
        for (const c of copyables) {
          if (quoteEl && quoteEl.contains(c)) continue;
          const txt = c.innerText || c.textContent || '';
          if (txt.trim()) return txt;
        }

        // Fallback: full text minus quoteEl text if present
        let raw = (el.innerText || el.textContent || '').trim();
        if (quoteEl) {
          const qRaw = (quoteEl.innerText || quoteEl.textContent || '').trim();
          if (qRaw && raw.startsWith(qRaw)) {
            raw = raw.slice(qRaw.length).trim();
          }
        }
        return raw;
      }
    }
  }

  hashString(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return 'wa_' + Math.abs(hash).toString(36);
  }

  healthCheck(doc = document) {
    const results = [
      { name: 'scrollContainer', found: !!this.getScrollContainer(doc), selector: this.selectors.scrollContainer.primary },
      { name: 'chatHeader', found: this.getChatName(doc) !== 'Unknown Chat', selector: this.selectors.chatHeader.primary },
      { name: 'messageRow', found: !!doc.querySelector(this.selectors.messageRow.primary), selector: this.selectors.messageRow.primary }
    ];
    return { ok: results.every(r => r.found), results };
  }
}
