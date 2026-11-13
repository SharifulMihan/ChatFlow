/**
 * messenger.js
 * ChatFlow platform adapter for Facebook Messenger (https://www.messenger.com/* and https://www.facebook.com/messages/*).
 * Implements the BaseAdapter interface.
 * Uses stable semantic hooks (roles, aria-labels, data attributes, tag hierarchy)
 * rather than obfuscated classes.
 */

import { BaseAdapter } from './base.js';
import {
  sanitizeChatName,
  INTRO_BLOCK_PATTERNS,
  cleanMessageText,
  isPureAccessibilityLabel,
  isEmojiOnlySender,
  isReactionOnly,
  isReplyLabel,
  extractReplySender,
  isValidConversationDate,
  detectDateFormat,
  parseDateSeparatorText
} from '../selectors.js';

export class MessengerAdapter extends BaseAdapter {
  constructor() {
    super('Messenger');

    this.baseSessionDate = new Date();
    this.activeDateSeparator = null;
    this.firstValidSeparator = null;
    this.rejectedSeparatorsCount = 0;
    this.detectedDateFormat = 'MDY';
    this.allSeenSeparators = [];
    this.previousSender = null;
    this.previousIsMe = false;
    this.loggedMessageCount = 0;

    this.selectors = {
      scrollContainer: [
        'div[role="main"] div[data-scope="messages_table"]',
        'div[role="main"] div[role="grid"]',
        'div[role="main"] div[role="region"]',
        'div[role="main"]'
      ],
      chatHeader: [
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
      ]
    };
  }

  detect(url = window.location.href) {
    if (!url || typeof url !== 'string') return false;
    return url.startsWith('https://www.messenger.com') ||
           url.startsWith('https://www.facebook.com/messages') ||
           url.startsWith('http://www.messenger.com') ||
           url.startsWith('http://www.facebook.com/messages');
  }

  cleanChatName(str) {
    return sanitizeChatName(str, '');
  }

  isPinnedBannerElement(el) {
    if (!el || (typeof Element !== 'undefined' && !(el instanceof Element))) return false;
    const pinnedContainer = el.closest?.('[aria-label*="pinned" i], [data-testid*="pinned" i], [class*="pinned" i]');
    if (pinnedContainer) return true;
    const text = (el.innerText || el.textContent || '').trim();
    if (/^(pinned message|পিন করা মেসেজ)/i.test(text)) return true;
    return false;
  }

  isValidContactName(str) {
    if (!str || typeof str !== 'string') return false;
    const s = str.trim();
    if (!s || s.length < 2) return false;

    const presenceBlacklist = [
      /\bactive\s+(now|\d+\w*\s+ago)\b/i,
      /\bactive\s+yesterday\b/i,
      /\bactive\s+today\b/i,
      /\bend-to-end encrypted\b/i,
      /\bjoined messenger\b/i,
      /\boptions\b/i,
      /\bconversation information\b/i,
      /\bchat details\b/i,
      /\bsearch in conversation\b/i,
      /\bchange theme\b/i,
      /\bmute notifications\b/i,
      /^messenger$/i,
      /^pinned message/i,
      /^পিন করা মেসেজ/i
    ];

    for (const rx of presenceBlacklist) {
      if (rx.test(s)) return false;
    }
    return true;
  }

  getChatName(doc = document) {
    // 1. Read visible title first from conversation header, strictly ignoring pinned message banners
    for (const sel of this.selectors.chatHeader) {
      try {
        const el = doc.querySelector(sel);
        if (el && !this.isPinnedBannerElement(el)) {
          const val = el.innerText || el.textContent || '';
          const clean = sanitizeChatName(val, '');
          if (clean && this.isValidContactName(clean)) return clean;
        }
      } catch (_) {}
    }

    // 2. Scan main header candidates, ignoring presence strings and pinned banners
    try {
      const header = doc.querySelector('div[role="main"] header') || doc.querySelector('div[role="main"]');
      if (header) {
        const candidates = header.querySelectorAll('h1, h2, span[role="heading"], span[dir="auto"], div[dir="auto"]');
        for (const c of candidates) {
          if (this.isPinnedBannerElement(c)) continue;
          const val = (c.innerText || c.textContent || '').trim();
          const clean = sanitizeChatName(val, '');
          if (clean && this.isValidContactName(clean) && clean.length < 70) {
            return clean;
          }
        }
      }
    } catch (_) {}

    // 3. Check conversation intro block heading (the contact name at the very beginning of the chat)
    try {
      const introHeading = doc.querySelector('div[role="main"] [data-scope="messages_table"] h2, div[role="main"] [role="grid"] h2');
      if (introHeading && !this.isPinnedBannerElement(introHeading)) {
        const clean = sanitizeChatName(introHeading.innerText || introHeading.textContent || '', '');
        if (clean && this.isValidContactName(clean)) return clean;
      }
    } catch (_) {}

    // 4. Check active conversation in left navigation list
    try {
      const activeNav = doc.querySelector('div[role="navigation"] [aria-selected="true"], div[role="navigation"] [aria-current="page"]');
      if (activeNav) {
        const spans = activeNav.querySelectorAll('span[dir="auto"]');
        for (const sp of spans) {
          const val = (sp.innerText || sp.textContent || '').trim();
          const clean = sanitizeChatName(val, '');
          if (clean && this.isValidContactName(clean)) return clean;
        }
      }
    } catch (_) {}

    // 5. Fallback to document.title without " | Messenger" or " - Messenger"
    try {
      if (doc.title) {
        const rawTitle = doc.title.replace(/\s*[|\-]\s*Messenger.*$/i, '').replace(/^\(\d+\)\s*/, '');
        const clean = sanitizeChatName(rawTitle, '');
        if (clean && this.isValidContactName(clean)) return clean;
      }
    } catch (_) {}

    return 'Messenger chat';
  }

  getScrollContainer(doc = document) {
    const main = doc.querySelector('div[role="main"]') || doc;

    for (const sel of this.selectors.scrollContainer) {
      try {
        const el = doc.querySelector(sel);
        if (el && el.scrollHeight > el.clientHeight && el.clientHeight > 200) {
          return el;
        }
      } catch (_) {}
    }

    // Dynamic heuristic inside div[role="main"]
    const divs = main.querySelectorAll('div');
    for (const cand of divs) {
      if (cand.scrollHeight > cand.clientHeight && cand.clientHeight > 250) {
        // Must contain row or message elements
        if (cand.querySelector('[role="row"], [role="gridcell"], div[dir="auto"]')) {
          return cand;
        }
      }
    }

    return null;
  }

  /**
   * Determine whether the conversation beginning / top has been reached in Messenger.
   * Treat top as reached when ANY of these conditions are met:
   * 1. Intro block in DOM (avatar header, encryption notice in English/Bengali, group creation notice)
   * 2. scrollTop <= 2 and stays <= 2 after idle wait
   * 3. Loading spinner gone and the first message's position stopped changing for 3 consecutive checks
   * 4. Hard cap of attempts reached
   * @param {HTMLElement} container
   * @param {Document|Element} [doc=document]
   * @param {Object} [tracker=null]
   * @returns {{ reached: boolean, reason?: string }}
   */
  hasReachedTop(container, doc = (typeof document !== 'undefined' ? document : null), tracker = null) {
    if (!container) return { reached: true, reason: 'no_container' };

    // 1. Intro block pattern detection in DOM
    const textSample = (container.innerText || container.textContent || '').slice(0, 3000);
    for (const rx of INTRO_BLOCK_PATTERNS) {
      if (rx.test(textSample)) {
        return { reached: true, reason: 'intro_block_detected' };
      }
    }

    // Check first child or intro block avatar element in message container
    const firstBlock = container.querySelector('div[data-scope="messages_table"] > div:first-child, div[role="grid"] > div:first-child, div[role="row"]:first-child');
    if (firstBlock) {
      const topText = (firstBlock.innerText || firstBlock.textContent || '').trim();
      for (const rx of INTRO_BLOCK_PATTERNS) {
        if (rx.test(topText)) {
          return { reached: true, reason: 'intro_block_first_child' };
        }
      }
    }

    // 2. scrollTop <= 2 and verified idle
    if (container.scrollTop <= 2) {
      if (tracker && tracker.scrollTopZeroChecks >= 2) {
        return { reached: true, reason: 'scrollTop_zero_idle' };
      }
    }

    // 3. First visible message position & signature static for 3 consecutive checks
    if (tracker) {
      const firstRow = container.querySelector('[role="row"], [role="gridcell"], div[dir="auto"]');
      if (firstRow) {
        const sig = (firstRow.innerText || firstRow.textContent || '').slice(0, 40) + '@' + firstRow.offsetTop;
        if (tracker.lastTopSig && tracker.lastTopSig === sig) {
          tracker.topStableCount = (tracker.topStableCount || 0) + 1;
          if (tracker.topStableCount >= 3) {
            return { reached: true, reason: 'top_element_static_3_checks' };
          }
        } else {
          tracker.topStableCount = 0;
          tracker.lastTopSig = sig;
        }
      }

      // 4. Hard cap of attempts
      if (tracker.attempts >= 40) {
        return { reached: true, reason: 'phase1_attempts_cap_40' };
      }
    }

    return { reached: false };
  }

  /**
   * Determine whether the conversation bottom has been reached in Messenger.
   * @param {HTMLElement} container
   * @param {Document|Element} [doc=document]
   * @returns {{ reached: boolean, reason?: string }}
   */
  hasReachedBottom(container, doc = (typeof document !== 'undefined' ? document : null)) {
    if (!container) return { reached: true, reason: 'no_container' };
    const atBottom = (container.scrollTop + container.clientHeight >= container.scrollHeight - 6);
    return { reached: atBottom, reason: atBottom ? 'scroll_at_bottom' : 'scrolling' };
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

    // Scroll up to trigger Messenger infinite load
    container.scrollTop = 0;
    container.dispatchEvent(new Event('scroll', { bubbles: true }));

    // Read-only safety rule: Messenger loads automatically via upward scroll.
    // Abort immediately on signal or stop flag.
    for (let i = 0; i < 4; i++) {
      if (isStopped()) break;
      await waitMs(110);
      if (isStopped()) break;
    }

    if (isStopped()) {
      return { newMessagesFound: false, atTop: false };
    }

    const atTop = container.scrollTop === 0;
    return { newMessagesFound: true, atTop };
  }

  /**
   * Reset session dates before starting forward scan.
   */
  resetSessionDates() {
    this.baseSessionDate = new Date();
    this.activeDateSeparator = null;
    this.firstValidSeparator = null;
    this.rejectedSeparatorsCount = 0;
    this.detectedDateFormat = 'MDY';
    this.allSeenSeparators = [];
    this.previousSender = null;
    this.previousIsMe = false;
    this.loggedMessageCount = 0;
  }

  /**
   * Cheap, read-only peek at the oldest loaded date (first date separator in DOM order).
   * Does not extract or count messages.
   * @returns {Date|null}
   */
  peekOldestDate(doc = document) {
    try {
      const root = doc.querySelector('[role="main"]') || doc;
      const nodes = root.querySelectorAll('h4, span[dir="auto"], div[dir="auto"]');
      for (let i = 0; i < nodes.length && i < 80; i++) {
        const text = (nodes[i].innerText || nodes[i].textContent || '').trim();
        if (!text || text.length > 50) continue;
        const d = parseDateSeparatorText(text, this.detectedDateFormat || 'MDY', null, new Date());
        if (d) return d;
      }
    } catch (_) {}
    return null;
  }

  /**
   * Check if a DOM element is a standalone date/time separator row.
   * Standalone centered row outside any message bubble, matching strict date/time pattern.
   * @param {Element} el
   * @returns {boolean}
   */
  isDateSeparatorElement(el) {
    if (!el || (typeof Element !== 'undefined' && !(el instanceof Element))) return false;
    // Date separator cannot contain message action buttons, avatars, or media
    if (el.querySelector('img[src*="fbcdn"], img[src*="scontent"], video, audio, [aria-label*="React" i], [aria-label*="Reply" i], [aria-label*="More" i]')) {
      return false;
    }
    const text = (el.innerText || el.textContent || '').trim();
    if (!text || text.length > 50) return false;
    return parseDateSeparatorText(text, this.detectedDateFormat, this.activeDateSeparator, this.baseSessionDate) !== null;
  }

  /**
   * Detect whether a message bubble is outgoing (Me) or incoming (Other)
   * based on physical bounding box geometry and flex alignment.
   * In 1-to-1 chats, this is the primary source of truth.
   * @param {Element} el
   * @param {Element} container
   * @returns {{ isMe: boolean, confidence: number, reason: string }}
   */
  detectAlignment(el, container) {
    if (!el || !container) return { isMe: false, confidence: 0, reason: 'no_element' };

    // 1. Physical geometry comparison
    try {
      const bubble = el.querySelector('div[dir="auto"]')?.closest('div') || el;
      if (bubble && typeof bubble.getBoundingClientRect === 'function' && typeof container.getBoundingClientRect === 'function') {
        const bRect = bubble.getBoundingClientRect();
        const cRect = container.getBoundingClientRect();
        if (bRect.width > 0 && cRect.width > 0) {
          const distRight = cRect.right - bRect.right;
          const distLeft = bRect.left - cRect.left;
          const rightRatio = distRight / cRect.width;
          const leftRatio = distLeft / cRect.width;

          // Outgoing (Me): right margin is small (< 35%), left margin is significant (> 15%)
          if (rightRatio < 0.35 && leftRatio > 0.15) {
            return { isMe: true, confidence: 0.95, reason: 'geom_right' };
          }
          // Incoming (Other): left margin is small (< 35%), right margin is significant (> 15%)
          if (leftRatio < 0.35 && rightRatio > 0.15) {
            return { isMe: false, confidence: 0.95, reason: 'geom_left' };
          }
        }
      }
    } catch (_) {}

    // 2. CSS / flex alignment fallback
    try {
      if (typeof window !== 'undefined' && window.getComputedStyle) {
        const style = window.getComputedStyle(el);
        if (style.justifyContent === 'flex-end' || style.alignItems === 'flex-end') {
          return { isMe: true, confidence: 0.85, reason: 'css_flex_end' };
        }
        if (style.justifyContent === 'flex-start' || style.alignItems === 'flex-start') {
          return { isMe: false, confidence: 0.85, reason: 'css_flex_start' };
        }
      }
    } catch (_) {}

    return { isMe: false, confidence: 0, reason: 'unknown' };
  }

  /**
   * Resolve user account name from profile navigation or fallback to 'Me'.
   * @param {Document|Element} doc
   * @returns {string}
   */
  getUserAccountName(doc = document) {
    try {
      const profileImg = doc.querySelector('div[role="navigation"] img[alt], div[role="banner"] img[alt]');
      if (profileImg) {
        const alt = (profileImg.getAttribute('alt') || '').trim();
        if (alt && !/profile|account|messenger|settings|menu/i.test(alt) && !isEmojiOnlySender(alt)) {
          return alt;
        }
      }
      const accountBtn = doc.querySelector('[aria-label*="account" i], [aria-label*="profile" i]');
      if (accountBtn) {
        const m = accountBtn.getAttribute('aria-label').match(/(?:profile|account|logged in as)\s+([^,.(]+)/i);
        if (m && m[1] && !isEmojiOnlySender(m[1])) {
          return m[1].trim();
        }
      }
    } catch (_) {}
    return 'Me';
  }

  extractMessages(doc = document) {
    const container = this.getScrollContainer(doc);
    if (!container) return [];

    const chatName = this.getChatName(doc);
    const userAccount = this.getUserAccountName(doc);

    // Collect candidate message rows inside the scroll container
    const rawCandidates = Array.from(
      container.querySelectorAll('[role="row"], [role="gridcell"], [data-scope="messages_table"] > div, div[role="region"] > div')
    );
    const allCandidates = rawCandidates.length > 0 ? rawCandidates : Array.from(container.children);

    // Filter to top-level elements only (eliminate nested duplicate rows)
    const topLevelRows = allCandidates.filter(c => {
      return !allCandidates.some(parent => parent !== c && parent.contains(c));
    });

    // Step 1: Detect date separator format from visible date strings
    for (const row of topLevelRows) {
      if (this.isDateSeparatorElement(row)) {
        const text = (row.innerText || row.textContent || '').trim();
        const d = parseDateSeparatorText(text, 'MDY', null, this.baseSessionDate);
        if (d && !this.allSeenSeparators.includes(text)) {
          this.allSeenSeparators.push(text);
        }
      }
    }
    if (this.allSeenSeparators.length > 0) {
      this.detectedDateFormat = detectDateFormat(this.allSeenSeparators);
    }

    const messages = [];
    const seen = new Set();
    let previousMsg = null;
    let pendingReply = null;

    // Step 2: Extract messages in DOM reading order
    for (const row of topLevelRows) {
      const rawText = (row.innerText || row.textContent || '').trim();

      // Skip conversation intro blocks (encryption notice, group creation)
      for (const rx of INTRO_BLOCK_PATTERNS) {
        if (rx.test(rawText)) continue;
      }
      if (this.isPinnedBannerElement(row)) continue;

      // 2a. Check Date / Time Separator
      if (this.isDateSeparatorElement(row)) {
        const parsedSep = parseDateSeparatorText(rawText, this.detectedDateFormat, this.activeDateSeparator, this.baseSessionDate);
        if (parsedSep) {
          this.activeDateSeparator = parsedSep;
          if (!this.firstValidSeparator) {
            this.firstValidSeparator = parsedSep;
          }
          continue;
        } else {
          this.rejectedSeparatorsCount = (this.rejectedSeparatorsCount || 0) + 1;
        }
      }

      // 2b. Reply Label handling (e.g. "Nadira Fairuxa replied to you")
      if (isReplyLabel(rawText)) {
        pendingReply = {
          sender: extractReplySender(rawText),
          text: null
        };
        continue;
      }

      // 2c. Quoted preview directly following a reply label:
      if (pendingReply && pendingReply.text === null) {
        // If row is a pure accessibility line, skip
        if (!isPureAccessibilityLabel(rawText)) {
          pendingReply.text = rawText;
          continue;
        }
      }

      // 2d. Reaction badge handling: attach to previous message, never emit as a message
      if (isReactionOnly(rawText, row)) {
        if (previousMsg) {
          const emojiImg = row.querySelector('img[alt]');
          const rxText = emojiImg ? emojiImg.getAttribute('alt') : (rawText.slice(0, 4) || '❤️');
          if (rxText && !previousMsg.reactions.includes(rxText)) {
            previousMsg.reactions.push(rxText);
          }
        }
        continue;
      }

      // 2e. Pure accessibility label (e.g. "You sent", "Seen by ...", "Enter, Message sent"): skip completely
      if (isPureAccessibilityLabel(rawText) && !row.querySelector('img, video, audio')) {
        continue;
      }

      // 2f. Parse message row
      const msg = this.parseMessengerRow(row, container, chatName, userAccount, pendingReply);
      if (msg) {
        if (pendingReply && pendingReply.text && !msg.replyTo) {
          msg.replyTo = { sender: pendingReply.sender, text: pendingReply.text };
        }
        pendingReply = null; // consumed

        if (!seen.has(msg.id)) {
          seen.add(msg.id);
          messages.push(msg);
          previousMsg = msg;

          // Console debug logging for first 50 messages
          if (this.loggedMessageCount < 50) {
            this.loggedMessageCount++;
            if (typeof window !== 'undefined' && (window.__CHATFLOW_DEBUG__ || (typeof localStorage !== 'undefined' && localStorage.getItem('chatflow_debug') === 'true'))) {
              console.log(`[ChatFlow Debug #${this.loggedMessageCount}] sender="${msg.sender}" isMe=${msg.isMe} ts=${msg.timestamp} text="${msg.text.slice(0, 40)}"`);
            }
          }
        }
      }
    }

    return messages;
  }

  parseMessengerRow(el, container, defaultChatName, userAccount, externalPendingReply = null) {
    if (!el || (typeof Element !== 'undefined' && !(el instanceof Element))) return null;

    const rawText = (el.innerText || el.textContent || '').trim();
    const hasMedia = !!el.querySelector('img, video, audio');
    if (!rawText && !hasMedia) return null;

    // 1. Accessibility clean
    const { text: cleanedText, isOnlyAccessibility } = cleanMessageText(rawText);
    if (isOnlyAccessibility && !hasMedia) return null;

    // 2. Check for system notices first
    const type = this.detectMessageType(el, rawText);
    if (type === 'system') {
      const ts = this.activeDateSeparator || null;
      return {
        id: this.hashString(`sys|${ts ? ts.toISOString() : 'none'}|${rawText}`),
        timestamp: ts ? ts.toISOString() : null,
        timestampApproximate: true,
        sender: 'System',
        text: rawText,
        type: 'system',
        isOutgoing: false,
        isMe: false,
        reactions: []
      };
    }

    // 3. Detect internal reply within the same row element
    let internalReplyTo = null;
    let quoteElement = null;

    const replyLabelChild = Array.from(el.querySelectorAll('*')).find(child => isReplyLabel(child.innerText || child.textContent));
    const quotedContainer = el.querySelector('[aria-label*="Replied to" i], [aria-label*="Replying to" i], [class*="quoted" i], [class*="replied" i]');

    if (quotedContainer) {
      quoteElement = quotedContainer;
      const qText = (quotedContainer.innerText || quotedContainer.textContent || '').trim();
      const qClean = cleanMessageText(qText);
      const qSender = replyLabelChild ? extractReplySender(replyLabelChild.textContent || '') : '';
      if (qClean.text) {
        internalReplyTo = { sender: qSender, text: qClean.text };
      }
    } else if (replyLabelChild) {
      const rSender = extractReplySender(replyLabelChild.textContent || '');
      internalReplyTo = { sender: rSender, text: '' };
    }

    const replyTo = internalReplyTo || (externalPendingReply && externalPendingReply.text ? externalPendingReply : null);

    // 4. Sender & isMe Detection
    // Signal a: Physical geometry & alignment
    let isMe = false;
    const align = this.detectAlignment(el, container);
    if (align.confidence >= 0.8) {
      isMe = align.isMe;
    }

    // Signal b: Accessibility text confirmation
    const ariaLabel = el.getAttribute('aria-label') || '';
    const elTextSample = rawText.slice(0, 50);

    if (/^(?:you\s+sent|sent\s+by\s+you|you:|you\s+replied|আপনি\s+পাঠিয়েছেন|আপনি\s+উত্তর\s+দিয়েছেন)/i.test(ariaLabel) ||
        /^(?:you\s+sent|you\s+replied|আপনি\s+পাঠিয়েছেন)/i.test(elTextSample)) {
      isMe = true;
    } else if (/^([^\n:]+)\s+sent/i.test(ariaLabel)) {
      isMe = false;
    }

    // Resolve Sender Name
    let sender = '';
    if (isMe) {
      sender = userAccount || 'Me';
    } else {
      // In group chats, inspect sender label or avatar alt
      const authorEl = el.querySelector('h4, span[role="heading"]');
      if (authorEl) {
        const authorName = (authorEl.innerText || authorEl.textContent || '').trim();
        if (authorName && this.isValidContactName(authorName) && !isEmojiOnlySender(authorName)) {
          sender = authorName;
        }
      }

      if (!sender) {
        sender = (defaultChatName && !isEmojiOnlySender(defaultChatName)) ? defaultChatName : 'Contact';
      }
    }

    sender = (sender || (isMe ? 'Me' : 'Contact')).trim();
    if (isEmojiOnlySender(sender)) {
      sender = isMe ? 'Me' : (defaultChatName || 'Contact');
    }

    this.previousSender = sender;
    this.previousIsMe = isMe;

    // 5. Timestamp resolution
    let timestamp = null;
    let timestampApproximate = true;

    const explicitTime = this.extractExplicitTime(el);
    if (explicitTime && isValidConversationDate(explicitTime)) {
      if (this.activeDateSeparator) {
        timestamp = new Date(
          this.activeDateSeparator.getFullYear(),
          this.activeDateSeparator.getMonth(),
          this.activeDateSeparator.getDate(),
          explicitTime.getHours(),
          explicitTime.getMinutes()
        );
      } else {
        timestamp = explicitTime;
      }
      timestampApproximate = false;
    } else if (this.activeDateSeparator && isValidConversationDate(this.activeDateSeparator)) {
      timestamp = this.activeDateSeparator;
      timestampApproximate = true;
    } else {
      timestamp = null;
      timestampApproximate = true;
    }

    // 6. Extract message text (strictly excluding any quoted preview or reply label)
    let text = this.extractText(el, type, cleanedText || rawText, quoteElement);
    if (type === 'text') {
      const textClean = cleanMessageText(text);
      text = textClean.text;
      if (!text) return null;
    }

    // 7. Stable deterministic ID & Row Fingerprint
    const explicitId = el.getAttribute('data-id') ||
                       el.getAttribute('id') ||
                       el.getAttribute('data-message-id') ||
                       el.querySelector('a[href*="/messages/t/"]')?.getAttribute('href') ||
                       '';

    const domId = explicitId ? String(explicitId).replace(/^msgr_/, '') : null;
    const tsKey = timestamp ? timestamp.toISOString() : 'ts_pending';
    const id = domId ? `msgr_${domId}` : this.hashString(`msgr_${sender}|${tsKey}|${text.slice(0, 80)}`);

    const fingerprint = {
      sender,
      type,
      text: text.slice(0, 100),
      isMe
    };

    return {
      id,
      domId,
      fingerprint,
      timestamp: timestamp ? timestamp.toISOString() : null,
      timestampApproximate,
      sender,
      text,
      type,
      replyTo,
      isOutgoing: isMe,
      isMe,
      reactions: []
    };
  }

  detectMessageType(el, rawText) {
    if (/you unsent a message|unsent a message|message was removed/i.test(rawText)) return 'deleted';
    if (/missed (audio|video)?\s*call|call ended|started a call/i.test(rawText)) return 'call';
    if (/end-to-end encrypted|created the group|named the group|added you to/i.test(rawText)) return 'system';

    if (el.querySelector('audio, [aria-label*="voice message"], [aria-label*="audio message"]')) return 'voice';
    if (el.querySelector('img[src*="stickers"], [aria-label*="sticker"]')) return 'sticker';
    if (el.querySelector('video, [aria-label*="video"]')) return 'video';

    // Photos & Images (ensure emojis/reactions are not detected as images)
    const imgEl = el.querySelector('img[src*="fbcdn"], img[src*="scontent"], img[alt*="photo"], img[alt*="image"]');
    if (imgEl) {
      const alt = imgEl.getAttribute('alt') || '';
      const src = imgEl.getAttribute('src') || '';
      if (!isReactionOnly(alt) && !src.includes('emoji.php')) {
        return 'image';
      }
    }

    if (el.querySelector('a[href*="attachment"], a[download]')) return 'file';

    return 'text';
  }

  extractText(el, type, fallbackText, quoteElement = null) {
    switch (type) {
      case 'voice':   return '[voice message]';
      case 'sticker': return '[sticker]';
      case 'video':   return '[video]';
      case 'image':   return '[image]';
      case 'file':    return '[file]';
      case 'call':    return '[call]';
      case 'deleted': return '[Message unsent]';
      case 'system':  return fallbackText;
      case 'text':
      default: {
        const textNodes = Array.from(el.querySelectorAll('div[dir="auto"], span[dir="auto"]'));
        for (const node of textNodes) {
          if (quoteElement && quoteElement.contains(node)) continue;
          const val = (node.innerText || node.textContent || '').trim();
          if (val && !isReplyLabel(val) && !isPureAccessibilityLabel(val)) {
            return val;
          }
        }
        return fallbackText;
      }
    }
  }

  /**
   * Parse date/time separator dividers in Messenger.
   * Returns a Date object if the element represents a date separator, or null.
   */
  parseDateSeparator(el) {
    if (!el) return null;
    const text = (el.innerText || el.textContent || '').trim();
    return parseDateSeparatorText(text, this.detectedDateFormat, this.activeDateSeparator, this.baseSessionDate);
  }

  extractExplicitTime(el) {
    const aria = el.getAttribute('aria-label') || '';
    if (aria) {
      const m = aria.match(/(\d{1,2}:\d{2}\s*(?:am|pm))/i);
      if (m) {
        return this.parseFuzzyDate(m[1]);
      }
    }
    return null;
  }

  parseFuzzyDate(str) {
    try {
      const now = new Date();

      if (/^today/i.test(str)) {
        const t = this.extractTimeParts(str);
        if (t) return new Date(now.getFullYear(), now.getMonth(), now.getDate(), t.hours, t.minutes);
      }

      if (/^yesterday/i.test(str)) {
        const y = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const t = this.extractTimeParts(str);
        if (t) return new Date(y.getFullYear(), y.getMonth(), y.getDate(), t.hours, t.minutes);
      }

      const parsed = new Date(str);
      if (!isNaN(parsed.getTime())) return parsed;

      // Try time only (e.g. "10:32 AM")
      const t = this.extractTimeParts(str);
      if (t) return new Date(now.getFullYear(), now.getMonth(), now.getDate(), t.hours, t.minutes);
    } catch (_) {}

    return null;
  }

  extractTimeParts(str) {
    const m = str.match(/(\d{1,2}):(\d{2})\s*([ap]m)?/i);
    if (!m) return null;
    let hours = parseInt(m[1], 10);
    const minutes = parseInt(m[2], 10);
    const meridiem = (m[3] || '').toLowerCase();
    if (meridiem === 'pm' && hours < 12) hours += 12;
    if (meridiem === 'am' && hours === 12) hours = 0;
    return { hours, minutes };
  }

  hashString(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return 'msgr_' + Math.abs(hash).toString(36);
  }

  healthCheck(doc = document) {
    const container = this.getScrollContainer(doc);
    const chatName = this.getChatName(doc);
    const results = [
      { name: 'scrollContainer', found: !!container, selector: 'div[role="main"] div[data-scope="messages_table"]' },
      { name: 'chatHeader', found: !!(chatName && chatName !== 'Messenger chat' && chatName !== 'Unknown Chat'), selector: this.selectors.chatHeader[0] },
      { name: 'messageRows', found: !!(container && (container.querySelector('[role="row"], [role="gridcell"]') || container.children.length > 0)), selector: '[role="row"], [role="gridcell"]' }
    ];
    return { ok: results.every(r => r.found), results };
  }
}
