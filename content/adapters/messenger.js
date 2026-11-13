/**
 * messenger.js
 * ChatFlow platform adapter for Facebook Messenger (https://www.messenger.com/* and https://www.facebook.com/messages/*).
 * Implements the BaseAdapter interface.
 * Uses stable semantic hooks (roles, aria-labels, data attributes, tag hierarchy)
 * rather than obfuscated classes.
 */

import { BaseAdapter } from './base.js';
import { geometryVote } from '../direction.js';

function parseRgb(bg) {
  if (!bg || typeof bg !== 'string') return null;
  const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
  if (!m) return null;
  if (m[4] !== undefined && parseFloat(m[4]) === 0) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
import {
  sanitizeChatName,
  INTRO_BLOCK_PATTERNS,
  cleanMessageText,
  isPureAccessibilityLabel,
  isEmojiOnlySender,
  isReactionOnly,
  extractValidReactions,
  isDurationChipText,
  containsEmojiGlyph,
  isReplyLabel,
  extractReplySender,
  isValidConversationDate,
  detectDateFormat,
  parseDateSeparatorText,
  looksLikeDateOrTimeSeparator,
  normalizeDateString
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

    // Fallback for short single-screen conversations / mocks where scrollHeight === clientHeight
    for (const sel of this.selectors.scrollContainer) {
      try {
        const el = doc.querySelector(sel);
        if (el && (el.clientHeight > 0 || el.querySelector?.('[role="row"], [role="gridcell"]'))) {
          return el;
        }
      } catch (_) {}
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
   * Reset session dates and audit counters before starting forward scan.
   */
  resetSessionDates() {
    this.baseSessionDate = new Date();
    this.activeDateSeparator = null;
    this.firstValidSeparator = null;
    this.rejectedSeparatorsCount = 0;
    this.detectedDateFormat = 'MDY';
    this.allSeenSeparators = [];
    this.resolvedWeekdaysLog = [];
    this.dateOrderViolations = [];
    this.previousSender = null;
    this.previousIsMe = false;
    this.loggedMessageCount = 0;
    this.resetAuditStats();
  }

  resetAuditStats() {
    this.auditStats = {
      candidateRowsSeen: 0,
      messagesExported: 0,
      separatorsCount: 0,
      systemRowsCount: 0,
      replyLabelsCount: 0,
      noiseRowsCount: 0,
      unrecognizedCount: 0,
      unrecognizedSamples: [],
      selectorHits: {
        roleRow: 0,
        gridcell: 0,
        messagesTableChild: 0,
        regionChild: 0,
        directChildFallback: 0,
        totalCandidates: 0
      },
      resolvedWeekdays: [],
      rejectedSeparators: []
    };
  }

  getAuditSnapshot() {
    if (!this.auditStats) this.resetAuditStats();
    return {
      candidateRowsSeen: this.auditStats.candidateRowsSeen,
      messagesExported: this.auditStats.messagesExported,
      separatorsCount: this.auditStats.separatorsCount,
      systemRowsCount: this.auditStats.systemRowsCount,
      replyLabelsCount: this.auditStats.replyLabelsCount,
      noiseRowsCount: this.auditStats.noiseRowsCount,
      unrecognizedCount: this.auditStats.unrecognizedCount,
      unrecognizedSamples: this.auditStats.unrecognizedSamples.slice(0, 25),
      selectorHits: { ...this.auditStats.selectorHits },
      resolvedWeekdays: this.auditStats.resolvedWeekdays.slice(0, 20),
      rejectedSeparators: this.auditStats.rejectedSeparators.slice(0, 20)
    };
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
   * Check whether `el` is visually centered outside any message bubble.
   * Used so real chat messages containing dates/weekdays inside left/right bubbles are not mistreated as dividers.
   */
  isCenteredOutsideBubble(el, container) {
    if (!el) return false;
    try {
      // Explicit date divider / heading / tooltip tags
      const tag = (el.tagName || '').toUpperCase();
      const scope = el.getAttribute?.('data-scope') || '';
      const role = el.getAttribute?.('role') || '';
      if (tag === 'H4' || tag === 'H3' || scope === 'date_break' || role === 'tooltip') return true;
      if (el.querySelector?.('[data-scope="date_break"], h4[dir="auto"]')) return true;

      if (typeof el.getBoundingClientRect === 'function' && container && typeof container.getBoundingClientRect === 'function') {
        const cRect = container.getBoundingClientRect();
        if (cRect.width > 0) {
          const textNode = el.querySelector?.('span, div[dir="auto"]') || el;
          const bRect = (textNode.getBoundingClientRect ? textNode.getBoundingClientRect() : el.getBoundingClientRect());
          if (bRect.width > 0 && bRect.width < cRect.width * 0.65) {
            const cCenter = (cRect.left + cRect.right) / 2;
            const bCenter = (bRect.left + bRect.right) / 2;
            const offset = Math.abs(bCenter - cCenter) / cRect.width;
            return offset <= 0.14;
          }
          // Full-row span without bubble styling -> inspect computed style text-align
          if (typeof window !== 'undefined' && window.getComputedStyle) {
            const st = window.getComputedStyle(el);
            if (st.textAlign === 'center' || st.justifyContent === 'center' || st.alignItems === 'center') return true;
          }
        }
      }
    } catch (_) {}
    // In headless/JSDOM mocks where rects are 0, treat date-only text outside bubble classes/avatars as centered separator
    const hasBubbleCue = !!(
      el.classList?.contains('message-in') ||
      el.classList?.contains('message-out') ||
      el.getAttribute?.('data-testid')?.includes('message') ||
      el.querySelector?.('[data-scope="message_content"], img[alt]')
    );
    return !hasBubbleCue;
  }

  /**
   * Check if a DOM element is a standalone date/time separator row.
   * Standalone centered row outside any message bubble, matching strict date/time pattern.
   * @param {Element} el
   * @param {Element} [container=null]
   * @param {Date|null} [dateFloor=null]
   * @returns {boolean}
   */
  isDateSeparatorElement(el, container = null, dateFloor = null) {
    if (!el || (typeof Element !== 'undefined' && !(el instanceof Element))) return false;
    if (el.querySelector?.('video, audio, [aria-label*="React" i], [aria-label*="Reply" i], [aria-label*="More" i]')) {
      return false;
    }
    const imgs = el.querySelectorAll ? Array.from(el.querySelectorAll('img')) : [];
    if (imgs.some(img => !this.isAvatarImage(img, el, '') && !this.isEmojiImage(img))) {
      return false;
    }
    const text = normalizeDateString(el.innerText || el.textContent || '');
    if (!text || text.length > 55) return false;
    if (!looksLikeDateOrTimeSeparator(text, this.detectedDateFormat, this.baseSessionDate)) return false;
    if (container && !this.isCenteredOutsideBubble(el, container)) return false;
    if (dateFloor === undefined) return true;
    return parseDateSeparatorText(text, this.detectedDateFormat, dateFloor, this.baseSessionDate) !== null;
  }

  /**
   * Identify profile / "Seen by" avatar images so they are NEVER treated as message photos.
   */
  isAvatarImage(img, row = null, chatName = '') {
    if (!img) return false;
    const alt = normalizeDateString(img.getAttribute?.('alt') || '');
    const aria = normalizeDateString(img.getAttribute?.('aria-label') || '');
    const combinedLabel = (alt || aria).toLowerCase();

    if (/^(?:profile picture|seen by\b)/i.test(combinedLabel) || /\bseen by\b/i.test(combinedLabel)) {
      return true;
    }
    if (img.closest?.('[data-testid*="avatar" i], [aria-label*="profile" i], [aria-label*="seen by" i], [aria-label*="active" i]')) {
      return true;
    }

    // Check explicit or rendered dimensions
    let w = parseInt(img.getAttribute?.('width') || img.width || 0, 10);
    let h = parseInt(img.getAttribute?.('height') || img.height || 0, 10);
    try {
      if ((!w || !h) && typeof img.getBoundingClientRect === 'function') {
        const r = img.getBoundingClientRect();
        if (r && r.width > 0 && r.height > 0) {
          w = r.width;
          h = r.height;
        }
      }
    } catch (_) {}

    const insideMediaLink = !!img.closest?.('a[href*="/messenger_media"], a[href*="photo"], [aria-label*="Open photo" i], [aria-label*="view photo" i]');
    if (!insideMediaLink && w > 0 && h > 0 && w <= 48 && h <= 48 && Math.abs(w - h) <= 6) {
      return true;
    }

    // Contact name match on img alt (e.g. <img alt="Sudipta"> or <img alt="Sudipta Roy">)
    const cleanChat = (chatName || '').trim().toLowerCase();
    const firstWord = cleanChat.split(/\s+/)[0] || '';
    if (alt && !/photo|image|attachment|picture|sticker|gif|open photo/i.test(alt)) {
      if (cleanChat && (alt.toLowerCase() === cleanChat || (firstWord.length >= 2 && alt.toLowerCase() === firstWord))) {
        return true;
      }
      // If inside a row that also has text bubble content and alt looks like a short person name positioned on the left
      if (row) {
        const hasBubbleText = !!row.querySelector?.('[data-scope="message_content"], div[dir="auto"], span[dir="auto"]');
        const looksLikePersonName = alt.length >= 2 && alt.length <= 40 && !/\d{3,}/.test(alt);
        if (hasBubbleText && looksLikePersonName && !insideMediaLink) {
          try {
            if (typeof img.getBoundingClientRect === 'function' && typeof row.getBoundingClientRect === 'function') {
              const ir = img.getBoundingClientRect();
              const rr = row.getBoundingClientRect();
              if (rr.width > 0 && ir.width > 0 && ir.left - rr.left < rr.width * 0.25 && ir.width <= 52) {
                return true;
              }
            } else {
              // Mock DOM without layout: alt matches a name and isn't an attachment photo
              return true;
            }
          } catch (_) {
            return true;
          }
        }
      }
    }

    return false;
  }

  /**
   * Identify small inline emoji/reaction sprites so they are not counted as message photos.
   */
  isEmojiImage(img) {
    if (!img) return false;
    const src = (img.getAttribute?.('src') || '').toLowerCase();
    const alt = (img.getAttribute?.('alt') || '').trim();
    if (src.includes('emoji.php') || src.includes('/images/emoji')) return true;
    if (img.closest?.('[data-testid*="emoji" i], [data-testid*="reaction" i], [aria-label*="reaction" i], [aria-label*="reacted" i]')) {
      return true;
    }
    if (alt && containsEmojiGlyph(alt) && alt.length <= 8) return true;
    return false;
  }

  /**
   * Check whether a row shows a contact avatar on the left (strong indicator of incoming message).
   */
  hasLeftContactAvatar(row, container, chatName = '') {
    if (!row) return false;
    const imgs = row.querySelectorAll ? Array.from(row.querySelectorAll('img')) : [];
    for (const img of imgs) {
      if (!this.isAvatarImage(img, row, chatName)) continue;
      // Ignore right-side "Seen by" small avatars
      const alt = (img.getAttribute?.('alt') || '').toLowerCase();
      const aria = (img.getAttribute?.('aria-label') || img.closest?.('[aria-label]')?.getAttribute?.('aria-label') || '').toLowerCase();
      if (/seen by/.test(alt) || /seen by/.test(aria)) continue;
      try {
        if (container && typeof img.getBoundingClientRect === 'function' && typeof container.getBoundingClientRect === 'function') {
          const ir = img.getBoundingClientRect();
          const cr = container.getBoundingClientRect();
          if (cr.width > 0 && ir.width > 0) {
            const centerX = (ir.left + ir.right) / 2;
            if (centerX - cr.left < cr.width * 0.35) return true;
            continue;
          }
        }
      } catch (_) {}
      // In mock DOM without geometry, non-seen avatar in a contact row is on the left
      return true;
    }
    return false;
  }

  /**
   * Collect all elements inside `row` that belong to a quoted reply preview,
   * and extract `{ quoteElements, replyTo }`.
   * Crucial: prevents quoted text, images, or video thumbnails from polluting the real reply message!
   */
  findReplyQuoteInfo(row, chatName = '', userAccount = 'Me', externalPendingReply = null) {
    const quoteSet = new Set();
    let replySender = '';
    let replyText = '';
    let replyMediaType = null;

    if (!row || !row.querySelectorAll) {
      return { quoteSet, replyTo: externalPendingReply };
    }

    // 1. Find reply announcement header inside row ("Sudipta replied to you", "You replied to Sudipta")
    const allEls = Array.from(row.querySelectorAll('*'));
    const replyHeaderEl = allEls.find(node => {
      if (!node || quoteSet.has(node)) return false;
      const t = normalizeDateString(node.innerText || node.textContent || '');
      return t && t.length <= 80 && isReplyLabel(t);
    });

    if (replyHeaderEl) {
      quoteSet.add(replyHeaderEl);
      const headerText = normalizeDateString(replyHeaderEl.innerText || replyHeaderEl.textContent || '');
      const target = extractReplySender(headerText);
      // If "Sudipta replied to you", quoted original sender was "Me"
      // If "You replied to Sudipta", quoted original sender was "Sudipta"
      if (target) replySender = target;
    }

    // 2. Find explicit quoted container(s)
    const explicitQuoteSelectors = [
      '[aria-label*="Replied to" i]',
      '[aria-label*="Replying to" i]',
      '[aria-label*="Original message" i]',
      '[data-testid*="quoted" i]',
      '[data-testid*="reply-quote" i]',
      '[class*="quoted" i]',
      '[class*="replied" i]',
      '[role="blockquote"]',
      'blockquote'
    ];
    let quotedContainer = row.querySelector?.(explicitQuoteSelectors.join(', '));

    // Also match Messenger accessibility wrapper whose text starts with "Original message:" or "<Name>: Original message:"
    if (!quotedContainer) {
      quotedContainer = allEls.find(node => {
        if (node === replyHeaderEl || node.contains(replyHeaderEl)) return false;
        // Pick the deepest / tightest element starting with Original message that doesn't wrap the whole row
        const t = normalizeDateString(node.innerText || node.textContent || '');
        const hasChildOriginal = Array.from(node.children || []).some(ch => /^(?:[^\n:]{1,40}:\s*)?original\s+message:/i.test(normalizeDateString(ch.innerText || ch.textContent || '')));
        if (hasChildOriginal) return false;
        return /^(?:[^\n:]{1,40}:\s*)?original\s+message:/i.test(t) && t.length < 300;
      }) || null;
    }

    // Fallback: if row has a replyHeaderEl and stacked blocks where the upper block is a media thumbnail / muted quote above the final reply bubble
    if (!quotedContainer && replyHeaderEl) {
      const parentBlock = replyHeaderEl.parentElement || row;
      const siblings = Array.from(parentBlock.children || []).filter(ch => ch !== replyHeaderEl);
      if (siblings.length >= 2) {
        // Upper sibling(s) before the final sibling are the quoted preview!
        quotedContainer = siblings[0];
      }
    }

    if (quotedContainer) {
      quoteSet.add(quotedContainer);
      for (const ch of Array.from(quotedContainer.querySelectorAll?.('*') || [])) {
        quoteSet.add(ch);
      }

      const rawQText = (quotedContainer.innerText || quotedContainer.textContent || '').trim();
      // Extract sender from "<Name>: Original message: ..." if present
      const origMatch = rawQText.match(/^([^\n:]{1,50}):\s*original\s+message:\s*([\s\S]*)$/i);
      if (origMatch) {
        if (!replySender) replySender = origMatch[1].trim();
        replyText = cleanMessageText(origMatch[2]).text;
      } else {
        const cleanedQ = rawQText.replace(/^original\s+message:\s*/i, '').trim();
        replyText = cleanMessageText(cleanedQ).text;
      }

      // Check for video/image thumbnail inside quoted container (e.g. Sudipta's "Sei" reply to video)
      const qVideo = quotedContainer.querySelector?.('video, [aria-label*="video" i], [aria-label*="play" i], [data-testid*="video" i]');
      const qImgs = quotedContainer.querySelectorAll ? Array.from(quotedContainer.querySelectorAll('img')) : [];
      const qPhoto = qImgs.find(img => !this.isEmojiImage(img) && !this.isAvatarImage(img, quotedContainer, chatName));

      if (!replyText || /^(?:attachment|video|photo|image|\d{1,2}:\d{2})$/i.test(replyText)) {
        if (qVideo) {
          replyMediaType = 'video';
          replyText = '[video]';
        } else if (qPhoto) {
          replyMediaType = 'image';
          replyText = '[image]';
        } else if (/^attachment$/i.test(replyText)) {
          replyMediaType = 'file';
          replyText = '[attachment]';
        }
      }
    }

    let replyTo = null;
    if (replyText || replySender || replyMediaType) {
      if (replySender && /^you$/i.test(replySender)) replySender = userAccount || 'Me';
      replyTo = {
        sender: replySender,
        text: replyText || (replyMediaType ? `[${replyMediaType}]` : ''),
        ...(replyMediaType ? { type: replyMediaType } : {})
      };
    } else if (externalPendingReply && (externalPendingReply.text || externalPendingReply.sender)) {
      replyTo = {
        sender: externalPendingReply.sender || '',
        text: externalPendingReply.text || '',
        ...(externalPendingReply.type ? { type: externalPendingReply.type } : {})
      };
    }

    return { quoteSet, replyTo, replyHeaderEl };
  }

  /**
   * Locate the primary bubble or media element inside a row (excluding quotes, avatars, tooltips, reactions).
   */
  findPrimaryBubble(row, quoteSet = new Set(), chatName = '') {
    if (!row || !row.querySelectorAll) return row;

    const preferredSelectors = [
      '[data-scope="message_content"]',
      '[data-testid="message-container"]',
      'div[dir="auto"]',
      'span[dir="auto"]',
      'video',
      'audio',
      'a[href*="/messenger_media"]'
    ];

    for (const sel of preferredSelectors) {
      const nodes = Array.from(row.querySelectorAll(sel));
      for (const node of nodes) {
        if (quoteSet.has(node)) continue;
        if (node.closest?.('[role="tooltip"], [data-testid*="reaction" i], [aria-label*="reaction" i]')) continue;
        const txt = normalizeDateString(node.innerText || node.textContent || '');
        if (txt && (isReplyLabel(txt) || isPureAccessibilityLabel(txt) || isDurationChipText(txt))) continue;
        // Avoid full-row wrapper that also wraps the left avatar
        if (node === row) continue;
        return node;
      }
    }

    // Fallback: content image outside quote & avatar
    const imgs = Array.from(row.querySelectorAll('img'));
    const contentImg = imgs.find(img => !quoteSet.has(img) && !this.isAvatarImage(img, row, chatName) && !this.isEmojiImage(img));
    if (contentImg) {
      return contentImg.closest?.('a, div') || contentImg;
    }

    return row;
  }

  /**
   * Detect whether a message bubble is outgoing (Me) or incoming (Other)
   * using geometry, left-avatar absence, CSS flex alignment, accessibility hints, and bubble color.
   */
  detectAlignment(el, container, quoteSet = new Set(), chatName = '') {
    if (!el || !container) return { isMe: false, confidence: 0, reason: 'no_element', bubble: el };

    const bubble = this.findPrimaryBubble(el, quoteSet, chatName) || el;

    // 1. Physical geometry comparison on the primary bubble (NOT the full row wrapper)
    try {
      const targetRectEl = (bubble && typeof bubble.getBoundingClientRect === 'function' && bubble.getBoundingClientRect().width > 0)
        ? bubble
        : el;
      if (targetRectEl && typeof targetRectEl.getBoundingClientRect === 'function' && typeof container.getBoundingClientRect === 'function') {
        const bRect = targetRectEl.getBoundingClientRect();
        const cRect = container.getBoundingClientRect();
        if (bRect.width > 0 && cRect.width > 0) {
          const vote = geometryVote(bRect, cRect);
          if (vote === true) {
            return { isMe: true, confidence: 0.95, reason: 'geom_right', bubble, bRect, cRect };
          }
          if (vote === false) {
            return { isMe: false, confidence: 0.95, reason: 'geom_left', bubble, bRect, cRect };
          }
          const distRight = cRect.right - bRect.right;
          const distLeft = bRect.left - cRect.left;
          if (distRight / cRect.width < 0.35 && distLeft / cRect.width > 0.15) {
            return { isMe: true, confidence: 0.9, reason: 'geom_margin_right', bubble, bRect, cRect };
          }
          if (distLeft / cRect.width < 0.35 && distRight / cRect.width > 0.15) {
            return { isMe: false, confidence: 0.9, reason: 'geom_margin_left', bubble, bRect, cRect };
          }
        }
      }
    } catch (_) {}

    // 2. Contact avatar presence on the left side of the row
    if (this.hasLeftContactAvatar(el, container, chatName)) {
      return { isMe: false, confidence: 0.9, reason: 'left_contact_avatar', bubble };
    }

    // 3. Explicit class hints / CSS flex alignment
    const cls = (el.getAttribute?.('class') || '').toLowerCase();
    if (/\bmessage-out\b|\boutgoing\b|\bsent-by-me\b/.test(cls)) {
      return { isMe: true, confidence: 0.9, reason: 'class_out', bubble };
    }
    if (/\bmessage-in\b|\bincoming\b/.test(cls)) {
      return { isMe: false, confidence: 0.9, reason: 'class_in', bubble };
    }

    try {
      if (typeof window !== 'undefined' && window.getComputedStyle) {
        const nodes = [el, bubble].filter(Boolean);
        for (const n of nodes) {
          const style = window.getComputedStyle(n);
          if (style.justifyContent === 'flex-end' || style.alignItems === 'flex-end' || style.alignSelf === 'flex-end') {
            return { isMe: true, confidence: 0.85, reason: 'css_flex_end', bubble };
          }
          if (style.justifyContent === 'flex-start' || style.alignItems === 'flex-start' || style.alignSelf === 'flex-start') {
            return { isMe: false, confidence: 0.85, reason: 'css_flex_start', bubble };
          }
        }
      }
    } catch (_) {}

    return { isMe: false, confidence: 0, reason: 'unknown', bubble };
  }

  /**
   * Collect multi-signal direction votes (`geometry`, `class`, `ticks`, `name`, `colorRgb`, `adapter`)
   * for any Messenger row (text, media, call, link, reply).
   */
  computeRowDirectionVotes(el, container, quoteSet, chatName, align) {
    const rawText = (el.innerText || el.textContent || '').trim();
    const aria = el.getAttribute?.('aria-label') || '';
    const bubble = align?.bubble || el;

    // Geometry vote
    let geoVote = null;
    try {
      const rTarget = (bubble && typeof bubble.getBoundingClientRect === 'function' && bubble.getBoundingClientRect().width > 0) ? bubble : el;
      if (rTarget?.getBoundingClientRect && container?.getBoundingClientRect) {
        geoVote = geometryVote(rTarget.getBoundingClientRect(), container.getBoundingClientRect());
      }
    } catch (_) {}

    // Left avatar / CSS alignment vote
    const hasLeftAvatar = this.hasLeftContactAvatar(el, container, chatName);
    let classVote = hasLeftAvatar ? false : null;
    if (classVote === null) {
      if (align.reason === 'css_flex_end' || align.reason === 'class_out') classVote = true;
      else if (align.reason === 'css_flex_start' || align.reason === 'class_in') classVote = false;
    }

    // Ticks / Seen / Sent status indicator
    let ticksVote = null;
    if (/\b(?:you\s+sent|sent\s+by\s+you|message\s+sent)\b/i.test(aria) ||
        /^(?:you\s+sent|enter,\s*message\s*sent)/i.test(rawText) ||
        el.querySelector?.('[aria-label*="Delivered" i], [aria-label*="Sent" i]')) {
      ticksVote = true;
    }

    // Accessibility label name vote ("You sent..." vs "<Contact> sent..." / "<Contact> replied...")
    let nameVote = null;
    const labelSample = `${aria}\n${rawText.slice(0, 100)}`;
    if (/^(?:you\s+sent|sent\s+by\s+you|you:|you\s+replied|you\s+forwarded|আপনি\s+পাঠিয়েছেন|আপনি\s+উত্তর\s+দিয়েছেন)/im.test(labelSample)) {
      nameVote = true;
    } else if (/^(?:[^\n:]{1,50}\s+(?:sent|replied\s+to\s+you|forwarded))\b/im.test(labelSample)) {
      nameVote = false;
    }

    // Bubble fill color (Messenger uses blue/purple gradient/solid for outgoing, dark/light gray for incoming)
    let colorRgb = null;
    try {
      if (typeof window !== 'undefined' && window.getComputedStyle && bubble) {
        const bg = window.getComputedStyle(bubble).backgroundColor;
        colorRgb = parseRgb(bg);
      }
    } catch (_) {}

    // Combine priority signals
    let isMe = false;
    if (geoVote !== null) {
      isMe = geoVote;
    } else if (nameVote !== null) {
      isMe = nameVote;
    } else if (classVote !== null) {
      isMe = classVote;
    } else if (ticksVote === true) {
      isMe = true;
    } else if (align.confidence > 0) {
      isMe = align.isMe;
    }

    return {
      isMe,
      dirVotes: {
        geometry: geoVote,
        class: classVote,
        ticks: ticksVote,
        name: nameVote,
        colorRgb,
        adapter: isMe
      }
    };
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
        const m = (accountBtn.getAttribute('aria-label') || '').match(/(?:profile|account|logged in as)\s+([^,.(]+)/i);
        if (m && m[1] && !isEmojiOnlySender(m[1])) {
          return m[1].trim();
        }
      }
    } catch (_) {}
    return 'Me';
  }

  /**
   * Enumerate every candidate row inside the Messenger message pane without grabbing outer multi-row wrappers.
   */
  enumerateCandidateRows(container) {
    if (!container) return [];
    const hits = this.auditStats ? this.auditStats.selectorHits : {
      roleRow: 0, gridcell: 0, messagesTableChild: 0, regionChild: 0, directChildFallback: 0, totalCandidates: 0
    };

    const roleRowsAll = Array.from(container.querySelectorAll('[role="row"]'));
    // Leaf rows (exclude any outer wrapper that itself contains multiple role="row" descendants)
    const leafRoleRows = roleRowsAll.filter(r => !roleRowsAll.some(inner => inner !== r && r.contains(inner)));
    hits.roleRow = leafRoleRows.length;

    const candidateSet = new Set(leafRoleRows);

    const gridcells = Array.from(container.querySelectorAll('[role="gridcell"]'));
    hits.gridcell = gridcells.length;
    for (const gc of gridcells) {
      if (leafRoleRows.some(r => r === gc || r.contains(gc) || gc.contains(r))) continue;
      candidateSet.add(gc);
    }

    const scopeSelectors = [
      { key: 'messagesTableChild', sel: '[data-scope="messages_table"] > div' },
      { key: 'regionChild', sel: 'div[role="region"] > div' }
    ];
    for (const { key, sel } of scopeSelectors) {
      const nodes = Array.from(container.querySelectorAll(sel));
      hits[key] = nodes.length;
      for (const n of nodes) {
        if (leafRoleRows.some(r => r === n || r.contains(n) || n.contains(r))) continue;
        // Skip big group wrappers containing multiple child rows/gridcells
        const childRowCount = n.querySelectorAll?.('[role="row"], [role="gridcell"]').length || 0;
        if (childRowCount > 1) continue;
        const txt = (n.innerText || n.textContent || '').trim();
        const hasContent = !!(txt || n.querySelector?.('img, video, audio, a[href], [aria-label]'));
        if (hasContent) candidateSet.add(n);
      }
    }

    // Fallback to direct children of container if needed (or uncovered sibling children)
    const directChildren = Array.from(container.children || []);
    if (candidateSet.size === 0) {
      hits.directChildFallback = directChildren.length;
      for (const ch of directChildren) {
        const txt = (ch.innerText || ch.textContent || '').trim();
        if (txt || ch.querySelector?.('img, video, audio, a[href], [aria-label]')) {
          candidateSet.add(ch);
        }
      }
    } else {
      for (const ch of directChildren) {
        if (Array.from(candidateSet).some(c => c === ch || ch.contains(c) || c.contains(ch))) continue;
        const txt = (ch.innerText || ch.textContent || '').trim();
        if (txt || ch.querySelector?.('img, video, audio, a[href], [aria-label]')) {
          candidateSet.add(ch);
        }
      }
    }

    // Remove nested children when parent is already an atomic candidate row
    const arr = Array.from(candidateSet);
    const topLevel = arr.filter(c => !arr.some(p => p !== c && p.contains(c)));

    // Sort in DOM document order
    topLevel.sort((a, b) => {
      if (a === b) return 0;
      if (typeof a.compareDocumentPosition === 'function') {
        const pos = a.compareDocumentPosition(b);
        if (pos & 4) return -1; // b follows a
        if (pos & 2) return 1;  // b precedes a
      }
      return 0;
    });

    hits.totalCandidates = topLevel.length;
    return topLevel;
  }

  /**
   * Extract visible text nodes from a row while excluding quote containers, tooltips, reactions, and duration chips.
   */
  extractCleanVisibleLines(row, quoteSet = new Set(), chatName = '') {
    const rawText = (row.innerText || row.textContent || '').trim();
    if (!row.querySelectorAll) return rawText ? [rawText] : [];

    const nodes = Array.from(row.querySelectorAll('div[dir="auto"], span[dir="auto"]'));
    const lines = [];
    const seen = new Set();

    for (const node of nodes) {
      if (quoteSet.has(node)) continue;
      if (node.closest?.('[role="tooltip"], [data-testid*="reaction" i], [aria-label*="reaction" i], [aria-label*="reacted" i]')) continue;
      // Skip ancestor nodes that contain child dir="auto" nodes to avoid duplicate concatenation
      const hasChildDirAuto = Array.from(node.querySelectorAll?.('div[dir="auto"], span[dir="auto"]') || [])
        .some(ch => ch !== node && !quoteSet.has(ch));
      if (hasChildDirAuto) continue;

      const val = (node.innerText || node.textContent || '').trim();
      if (!val) continue;
      const norm = normalizeDateString(val);
      if (!norm) continue;
      if (isReplyLabel(norm) || isPureAccessibilityLabel(norm) || isDurationChipText(norm)) continue;
      if (/^reactions?:?\s*(?:\?+|$)/i.test(norm)) continue;
      if (isReactionOnly(norm, node)) continue;
      // Skip bare sender name label outside the bubble when another message exists
      if (chatName && norm.toLowerCase() === chatName.split(/\s+/)[0].toLowerCase() && nodes.length > 1 && node.tagName !== 'DIV') {
        continue;
      }
      if (!seen.has(norm)) {
        seen.add(norm);
        lines.push(val);
      }
    }

    if (lines.length === 0) {
      const scopeAnchors = Array.from(row.querySelectorAll('[data-scope="message_content"] a[href]'));
      for (const a of scopeAnchors) {
        if (quoteSet.has(a)) continue;
        const val = (a.innerText || a.textContent || '').trim();
        const norm = normalizeDateString(val);
        if (norm && !isPureAccessibilityLabel(norm) && !isDurationChipText(norm) && !seen.has(norm)) {
          seen.add(norm);
          lines.push(val);
        }
      }
    }

    return lines;
  }

  /**
   * Classify every candidate row into one exact category:
   * 'message' | 'separator' | 'system' | 'reply-label' | 'ui-noise' | 'UNRECOGNIZED'
   * Never drops a row silently.
   * @param {Element} row
   * @param {Object} [ctx={}]
   * @returns {Object}
   */
  classifyRow(row, ctx = {}) {
    if (!row || (typeof Element !== 'undefined' && !(row instanceof Element))) {
      return { kind: 'ui-noise', reason: 'invalid_element' };
    }

    const container = ctx.container || null;
    const chatName = ctx.chatName || '';
    const dateFloor = ctx.dateFloor !== undefined ? ctx.dateFloor : this.activeDateSeparator;

    const rawText = (row.innerText || row.textContent || '').trim();
    const normText = normalizeDateString(rawText);
    const role = (row.getAttribute?.('role') || '').toLowerCase();
    const aria = normalizeDateString(row.getAttribute?.('aria-label') || '');

    // 1. Pinned banner or hover tooltip UI
    if (this.isPinnedBannerElement(row)) {
      return { kind: 'ui-noise', reason: 'pinned_banner' };
    }
    if (role === 'tooltip' || (!normText && !row.querySelector?.('img, video, audio, a[href]'))) {
      return { kind: 'ui-noise', reason: role === 'tooltip' ? 'tooltip' : 'empty_spacer' };
    }

    // 2. System / intro notices (encryption, group created/renamed, member added/removed)
    // Note: Calls ("Audio call", "Missed call") are MESSAGES per Part 2.5, not system rows!
    if (normText && INTRO_BLOCK_PATTERNS.some(rx => rx.test(normText))) {
      return { kind: 'system', reason: 'intro_block', text: rawText };
    }
    if (normText && /^(?:.+?\s+(?:added|removed|left the group|changed the group|named the group|set the nickname|changed the theme|changed the emoji)|you\s+(?:joined|left|created)\s+this\s+group)/i.test(normText) &&
        !row.querySelector?.('[data-scope="message_content"]')) {
      return { kind: 'system', reason: 'group_system_event', text: rawText };
    }

    // 3. Date / time separator check
    // Note: Even if a separator or hover timestamp goes backwards chronologically, NEVER fall through to 'message'!
    if (normText && looksLikeDateOrTimeSeparator(normText, this.detectedDateFormat, this.baseSessionDate)) {
      const hasMedia = !!(row.querySelector?.('video, audio') ||
        Array.from(row.querySelectorAll?.('img') || []).some(img => !this.isAvatarImage(img, row, chatName) && !this.isEmojiImage(img)));
      const centered = !container ? this.isCenteredOutsideBubble(row, null) : this.isCenteredOutsideBubble(row, container);
      if (!hasMedia && centered) {
        const parsedSep = parseDateSeparatorText(normText, this.detectedDateFormat, dateFloor, this.baseSessionDate);
        return {
          kind: 'separator',
          rawText: normText,
          parsedDate: parsedSep,
          rejectedBackwards: !parsedSep
        };
      }
    }

    // Check quoted reply structure early so quote media/text does not confuse row classification
    const quoteInfo = this.findReplyQuoteInfo(row, chatName, ctx.userAccount || 'Me', ctx.pendingReply || null);
    const msgType = this.detectMessageType(row, normText, quoteInfo.quoteSet, chatName);

    // 4. Standalone reply header row (e.g. "Sudipta replied to you", "You replied to Sudipta") without its own bubble
    if (normText && isReplyLabel(normText) && msgType === 'text' && !quoteInfo.replyTo?.text) {
      const hasOwnBubbleLines = this.extractCleanVisibleLines(row, quoteInfo.quoteSet, chatName).length > 0;
      if (!hasOwnBubbleLines) {
        return {
          kind: 'reply-label',
          replySender: extractReplySender(normText),
          rawText: normText
        };
      }
    }

    // 5. Reaction-only badge pill (never matches media rows, "0:19", or "???")
    if (msgType === 'text' && isReactionOnly(normText, row)) {
      return {
        kind: 'ui-noise',
        reason: 'reaction_badge',
        reactions: extractValidReactions(row, normText)
      };
    }

    // 6. UI noise labels (standalone avatar name "Sudipta", "Seen by", forwarded label without media, duration chip without video, "Reactions: ???")
    if (msgType === 'text') {
      // Standalone avatar / contact name label outside any explicit bubble wrapper (e.g. "Sudipta" or "Sudipta Roy")
      const cleanChat = normalizeDateString(chatName).toLowerCase();
      const firstToken = cleanChat.split(/\s+/)[0] || '';
      const normLower = normText.toLowerCase();
      const insideBubble = !!row.querySelector?.('[data-scope="message_content"], [data-testid="message-container"], [aria-label*="sent" i]');
      if (!insideBubble && cleanChat && (normLower === cleanChat || (firstToken.length >= 2 && normLower === firstToken)) && !quoteInfo.replyTo) {
        return { kind: 'ui-noise', reason: 'avatar_name_label' };
      }

      const ownBodyLines = this.extractCleanVisibleLines(row, quoteInfo.quoteSet, chatName);
      if (ownBodyLines.length === 0) {
        if (isDurationChipText(normText)) {
          return { kind: 'ui-noise', reason: 'duration_chip', duration: normText };
        }
        if (/^(?:reactions?:?\s*(?:\?+|\d{1,2}:\d{2})*|\?+)$/i.test(normText)) {
          return { kind: 'ui-noise', reason: 'malformed_reaction_label' };
        }
        if (/^(?:[^\n:]{1,40}\s+)?forwarded(?:\s+an?\s+(?:image|photo|video|message|file|attachment))?$/i.test(normText)) {
          return { kind: 'ui-noise', reason: 'forwarded_label', forwarded: true };
        }
        if (isPureAccessibilityLabel(normText)) {
          return { kind: 'ui-noise', reason: 'accessibility_label' };
        }
      }
    }

    // 7. Hover timestamp row inside message wrapper with no message content
    if (msgType === 'text' && !quoteInfo.replyTo) {
      const cleanLines = this.extractCleanVisibleLines(row, quoteInfo.quoteSet, chatName);
      const bodyJoined = cleanLines.join('\n').trim();
      const bodyClean = cleanMessageText(bodyJoined).text;
      if (bodyClean && looksLikeDateOrTimeSeparator(bodyClean, this.detectedDateFormat, this.baseSessionDate) &&
          !row.querySelector?.('[data-scope="message_content"], [data-testid="message-container"]')) {
        return { kind: 'ui-noise', reason: 'hover_timestamp', rawText: bodyClean };
      }
    }

    // 8. Real message row (media, call, deleted, link, reply, or clean text bubble)
    if (msgType !== 'text') {
      const res = { kind: 'message', msgType, quoteInfo };
      if (!ctx.skipBuildMsg) {
        res.msg = this.parseMessengerRow(row, container, chatName, ctx.userAccount || 'Me', ctx.pendingReply || null, {
          classification: res,
          localDateCursor: ctx.dateCursor !== undefined ? ctx.dateCursor : dateFloor,
          rowIdx: ctx.rowIdx || 0,
          forwarded: Boolean(ctx.pendingForwarded)
        });
      }
      return res;
    }

    const cleanLines = this.extractCleanVisibleLines(row, quoteInfo.quoteSet, chatName);
    let bodyText = cleanMessageText(cleanLines.join('\n')).text;
    // Also guard against standalone "Original message: ..." without a body bubble
    if (!bodyText && quoteInfo.replyTo && quoteInfo.replyTo.text && cleanLines.length === 0) {
      // Pure quoted preview row directly after a standalone reply-label row
      return {
        kind: 'reply-label',
        reason: 'standalone_quote_preview',
        quotedText: quoteInfo.replyTo.text,
        replySender: quoteInfo.replyTo.sender
      };
    }

    if (bodyText) {
      const res = { kind: 'message', msgType: 'text', quoteInfo, cleanLines, bodyText };
      if (!ctx.skipBuildMsg) {
        res.msg = this.parseMessengerRow(row, container, chatName, ctx.userAccount || 'Me', ctx.pendingReply || null, {
          classification: res,
          localDateCursor: ctx.dateCursor !== undefined ? ctx.dateCursor : dateFloor,
          rowIdx: ctx.rowIdx || 0,
          forwarded: Boolean(ctx.pendingForwarded)
        });
      }
      return res;
    }

    // 9. Anything with visible text or media that didn't fit cleanly -> UNRECOGNIZED (never silently drop!)
    const hasAnyMedia = !!row.querySelector?.('img, video, audio, svg');
    if (normText || aria || hasAnyMedia) {
      return {
        kind: 'UNRECOGNIZED',
        reason: 'unclassified_content',
        textPreview: (normText || aria).slice(0, 120),
        recoveredText: normText || aria || ''
      };
    }

    return { kind: 'ui-noise', reason: 'no_visible_content' };
  }

  extractMessages(doc = document) {
    const container = this.getScrollContainer(doc);
    if (!container) return [];
    if (!this.auditStats) this.resetAuditStats();

    const chatName = this.getChatName(doc);
    const userAccount = this.getUserAccountName(doc);
    const topLevelRows = this.enumerateCandidateRows(container);

    // Step 1: Detect date separator format from visible date strings
    for (const row of topLevelRows) {
      if (this.isDateSeparatorElement(row, container, undefined)) {
        const text = normalizeDateString(row.innerText || row.textContent || '');
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
    let pendingForwarded = false;
    // IMPORTANT (Part 4.3 fix): Track separator strictly top-to-bottom within THIS snapshot!
    // Never leak a bottom-of-viewport separator from Snapshot N into Snapshot N+1's top pre-separator rows.
    let localDateCursor = null;

    // Step 2: Classify and extract EVERY candidate row in DOM reading order
    for (let rowIdx = 0; rowIdx < topLevelRows.length; rowIdx++) {
      const row = topLevelRows[rowIdx];
      this.auditStats.candidateRowsSeen++;

      const cls = this.classifyRow(row, {
        container,
        chatName,
        userAccount,
        pendingReply,
        dateFloor: localDateCursor,
        skipBuildMsg: true
      });

      if (cls.kind === 'system') {
        this.auditStats.systemRowsCount++;
        const sysMsg = this.buildSystemMessage(cls.text, localDateCursor);
        if (sysMsg && !seen.has(sysMsg.id)) {
          seen.add(sysMsg.id);
          messages.push(sysMsg);
        }
        continue;
      }

      if (cls.kind === 'separator') {
        this.auditStats.separatorsCount++;
        if (cls.parsedDate) {
          localDateCursor = cls.parsedDate;
          this.activeDateSeparator = cls.parsedDate;
          if (!this.firstValidSeparator) {
            this.firstValidSeparator = cls.parsedDate;
          }
          if (/^(?:mon|tue|wed|thu|fri|sat|sun|today|yesterday)/i.test(cls.rawText)) {
            this.auditStats.resolvedWeekdays.push({
              raw: cls.rawText,
              resolved: cls.parsedDate.toISOString()
            });
          }
        } else {
          this.rejectedSeparatorsCount = (this.rejectedSeparatorsCount || 0) + 1;
          this.auditStats.rejectedSeparators.push({
            raw: cls.rawText,
            activeCursor: localDateCursor ? localDateCursor.toISOString() : null
          });
        }
        continue;
      }

      if (cls.kind === 'reply-label') {
        this.auditStats.replyLabelsCount++;
        if (cls.quotedText) {
          pendingReply = {
            sender: pendingReply?.sender || cls.replySender || '',
            text: cls.quotedText
          };
        } else {
          pendingReply = {
            sender: cls.replySender || '',
            text: null
          };
        }
        continue;
      }

      if (cls.kind === 'ui-noise') {
        this.auditStats.noiseRowsCount++;
        if (cls.reason === 'reaction_badge' && previousMsg && Array.isArray(cls.reactions)) {
          for (const rx of cls.reactions) {
            if (!previousMsg.reactions.includes(rx)) previousMsg.reactions.push(rx);
          }
        } else if (cls.reason === 'duration_chip' && previousMsg && (previousMsg.type === 'video' || previousMsg.type === 'voice')) {
          if (!previousMsg.duration) previousMsg.duration = cls.duration;
        } else if (cls.forwarded) {
          pendingForwarded = true;
        }
        continue;
      }

      if (cls.kind === 'UNRECOGNIZED') {
        this.auditStats.unrecognizedCount++;
        const sample = {
          index: rowIdx,
          scrollTop: container.scrollTop || 0,
          textPreview: (cls.textPreview || '').slice(0, 120),
          tag: (row.tagName || '').toLowerCase(),
          role: row.getAttribute?.('role') || '',
          ariaLabel: row.getAttribute?.('aria-label') || '',
          outerHTML: (row.outerHTML || '').slice(0, 2000)
        };
        if (this.auditStats.unrecognizedSamples.length < 25) {
          this.auditStats.unrecognizedSamples.push(sample);
        }

        const unrecMsg = this.buildUnrecognizedMessage(row, container, chatName, userAccount, cls, localDateCursor, rowIdx);
        if (unrecMsg && !seen.has(unrecMsg.id)) {
          seen.add(unrecMsg.id);
          messages.push(unrecMsg);
          previousMsg = unrecMsg;
        }
        pendingReply = null;
        pendingForwarded = false;
        continue;
      }

      // cls.kind === 'message'
      const msg = this.parseMessengerRow(row, container, chatName, userAccount, pendingReply, {
        classification: cls,
        localDateCursor,
        rowIdx,
        forwarded: pendingForwarded
      });
      pendingReply = null;
      pendingForwarded = false;

      if (msg) {
        // Avoid accidental DOM-node duplicate while never collapsing distinct messages under the same minute
        let finalId = msg.id;
        if (!msg.domId && seen.has(finalId)) {
          let suffix = 2;
          while (seen.has(`${finalId}_${suffix}`)) suffix++;
          finalId = `${finalId}_${suffix}`;
          msg.id = finalId;
        }
        if (!seen.has(msg.id)) {
          seen.add(msg.id);
          messages.push(msg);
          previousMsg = msg;
          this.auditStats.messagesExported++;

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

  buildSystemMessage(rawText, dateCursor) {
    const ts = dateCursor && isValidConversationDate(dateCursor) ? dateCursor : null;
    const text = normalizeDateString(rawText);
    if (!text) return null;
    return {
      id: this.hashString(`sys|${ts ? ts.toISOString() : 'none'}|${text}`),
      timestamp: ts ? ts.toISOString() : null,
      timestampApproximate: true,
      sender: 'System',
      text,
      type: 'system',
      isOutgoing: false,
      isMe: false,
      reactions: []
    };
  }

  buildUnrecognizedMessage(el, container, chatName, userAccount, cls, dateCursor, rowIdx = 0) {
    const align = this.detectAlignment(el, container, new Set(), chatName);
    const { isMe, dirVotes } = this.computeRowDirectionVotes(el, container, new Set(), chatName, align);
    const sender = isMe ? (userAccount || 'Me') : ((chatName && !isEmojiOnlySender(chatName)) ? chatName : 'Contact');
    const ts = dateCursor && isValidConversationDate(dateCursor) ? dateCursor : null;
    const recovered = (cls.recoveredText || '').trim();
    const text = recovered ? `[Unrecognized message] ${recovered}` : '[Unrecognized message]';

    return {
      id: this.hashString(`unrec|${rowIdx}|${ts ? ts.toISOString() : 'none'}|${recovered.slice(0, 80)}`),
      domId: null,
      fingerprint: { sender, type: 'unrecognized', text: text.slice(0, 100), isMe },
      timestamp: ts ? ts.toISOString() : null,
      timestampApproximate: true,
      sender,
      senderRaw: sender,
      text,
      type: 'unrecognized',
      isOutgoing: isMe,
      isMe,
      dirVotes,
      reactions: []
    };
  }

  parseMessengerRow(el, container, defaultChatName, userAccount, externalPendingReply = null, opts = {}) {
    if (!el || (typeof Element !== 'undefined' && !(el instanceof Element))) return null;

    const rawText = (el.innerText || el.textContent || '').trim();
    const cls = opts.classification || this.classifyRow(el, {
      container,
      chatName: defaultChatName,
      userAccount,
      pendingReply: externalPendingReply,
      dateFloor: opts.localDateCursor
    });

    if (cls.kind === 'system') {
      return this.buildSystemMessage(cls.text || rawText, opts.localDateCursor ?? this.activeDateSeparator);
    }
    if (cls.kind !== 'message' && cls.kind !== 'UNRECOGNIZED') {
      return null;
    }

    const quoteInfo = cls.quoteInfo || this.findReplyQuoteInfo(el, defaultChatName, userAccount, externalPendingReply);
    const quoteSet = quoteInfo.quoteSet || new Set();
    const replyTo = quoteInfo.replyTo || null;
    const type = cls.msgType || this.detectMessageType(el, normalizeDateString(rawText), quoteSet, defaultChatName);

    // Extract clean reactions attached inside the row (filtering out durations like 0:19 or ???)
    const reactions = this.extractRowReactions(el, quoteSet);

    // Extract video/voice duration metadata (e.g. "0:05") without turning it into text or reaction
    const duration = (type === 'video' || type === 'voice') ? this.extractMediaDuration(el, quoteSet) : null;

    // Check forwarded indicator inside this row or from preceding label
    const forwarded = !!(opts.forwarded || /\bforwarded\b/i.test(rawText.slice(0, 80)) || el.querySelector?.('[aria-label*="forwarded" i]'));

    // 4. Sender & isMe Direction Votes
    const align = this.detectAlignment(el, container, quoteSet, defaultChatName);
    const { isMe, dirVotes } = this.computeRowDirectionVotes(el, container, quoteSet, defaultChatName, align);

    // Resolve Sender Name
    let sender = '';
    if (isMe) {
      sender = userAccount || 'Me';
    } else {
      const authorEl = el.querySelector?.('h4, span[role="heading"]');
      if (authorEl && !quoteSet.has(authorEl)) {
        const authorName = normalizeDateString(authorEl.innerText || authorEl.textContent || '');
        if (authorName && this.isValidContactName(authorName) && !isEmojiOnlySender(authorName) && !looksLikeDateOrTimeSeparator(authorName)) {
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

    // 5. Timestamp resolution using strictly THIS snapshot's localDateCursor above this row
    const activeSep = opts.localDateCursor !== undefined ? opts.localDateCursor : this.activeDateSeparator;
    let timestamp = null;
    let timestampApproximate = true;

    const explicitTime = this.extractExplicitTime(el);
    if (explicitTime && isValidConversationDate(explicitTime)) {
      if (activeSep && isValidConversationDate(activeSep)) {
        timestamp = new Date(
          activeSep.getFullYear(),
          activeSep.getMonth(),
          activeSep.getDate(),
          explicitTime.getHours(),
          explicitTime.getMinutes()
        );
      } else {
        timestamp = explicitTime;
      }
      timestampApproximate = false;
    } else if (activeSep && isValidConversationDate(activeSep)) {
      timestamp = activeSep;
      timestampApproximate = true;
    } else {
      timestamp = null;
      timestampApproximate = true;
    }

    // 6. Extract message text (strictly excluding quoted preview, avatars, reply labels, duration chips, and hidden tooltips)
    const fallbackClean = (cls.bodyText || cls.cleanLines?.join('\n') || cleanMessageText(rawText).text || '');
    let text = this.extractText(el, type, fallbackClean, quoteSet, defaultChatName, duration);
    if (type === 'text') {
      text = cleanMessageText(text).text;
      // Strip any trailing hover timestamp or "Original message:" leak
      if (replyTo && replyTo.text && text.startsWith(replyTo.text) && text.length > replyTo.text.length) {
        text = text.slice(replyTo.text.length).replace(/^[\s:\-]+/, '').trim();
      }
      if (!text) return null;
    }

    // 7. Stable deterministic ID & Row Fingerprint
    const explicitId = el.getAttribute?.('data-id') ||
                       el.getAttribute?.('id') ||
                       el.getAttribute?.('data-message-id') ||
                       el.querySelector?.('a[href*="/messages/t/"]')?.getAttribute?.('href') ||
                       '';

    const domId = explicitId ? String(explicitId).replace(/^msgr_/, '') : null;
    const mediaSrcHint = (type === 'image' || type === 'video')
      ? (el.querySelector?.('img:not([src*="emoji.php"]), video')?.getAttribute?.('src') || '').slice(-24)
      : '';
    const tsKey = timestamp ? timestamp.toISOString() : 'ts_pending';
    const id = domId
      ? `msgr_${domId}`
      : this.hashString(`msgr_${sender}|${tsKey}|${type}|${text.slice(0, 80)}|${mediaSrcHint}`);

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
      senderRaw: sender,
      text,
      type,
      ...(duration ? { duration } : {}),
      ...(forwarded ? { forwarded: true } : {}),
      replyTo,
      isOutgoing: isMe,
      isMe,
      dirVotes,
      reactions
    };
  }

  /**
   * Extract valid emoji reactions inside a row (outside quoted container).
   */
  extractRowReactions(row, quoteSet = new Set()) {
    const reactions = [];
    const seen = new Set();
    if (!row || !row.querySelectorAll) return reactions;

    const rxEls = Array.from(row.querySelectorAll('[aria-label*="reaction" i], [aria-label*="reacted" i], [data-testid*="reaction" i]'));
    for (const rxEl of rxEls) {
      if (quoteSet.has(rxEl)) continue;
      const aria = rxEl.getAttribute?.('aria-label') || '';
      const txt = (rxEl.innerText || rxEl.textContent || '').trim();
      const parsed = extractValidReactions(rxEl, `${aria} ${txt}`);
      for (const r of parsed) {
        if (!seen.has(r)) {
          seen.add(r);
          reactions.push(r);
        }
      }
    }
    return reactions;
  }

  /**
   * Extract media duration chip like "0:05" or "0:19" from a video or voice row.
   */
  extractMediaDuration(row, quoteSet = new Set()) {
    if (!row || !row.querySelectorAll) return null;
    const candidates = Array.from(row.querySelectorAll('span, div'));
    for (const c of candidates) {
      if (quoteSet.has(c)) continue;
      if (c.children && c.children.length > 0) continue;
      const t = normalizeDateString(c.innerText || c.textContent || '');
      if (isDurationChipText(t)) return t;
    }
    return null;
  }

  /**
   * Detect Messenger row message type while strictly ignoring quoted reply elements, contact avatars, and emoji sprites.
   */
  detectMessageType(el, rawText, quoteSet = new Set(), chatName = '') {
    const inQuote = (node) => {
      if (!node || !quoteSet || quoteSet.size === 0) return false;
      if (quoteSet.has(node)) return true;
      for (const q of quoteSet) {
        if (q && q.contains && q.contains(node)) return true;
      }
      return false;
    };

    const nonQuoteQuery = (sel) => {
      const nodes = el.querySelectorAll ? Array.from(el.querySelectorAll(sel)) : [];
      return nodes.find(n => !inQuote(n)) || null;
    };

    const ownLines = this.extractCleanVisibleLines(el, quoteSet, chatName).join(' ').trim();
    const checkText = ownLines || rawText || '';

    if (/\b(?:you\s+unsent\s+a\s+message|unsent\s+a\s+message|this\s+message\s+(?:was\s+removed|is\s+unavailable)|message\s+removed)\b/i.test(checkText)) {
      return 'deleted';
    }
    if (/^(?:audio\s+call|video\s+call|missed\s+(?:audio|video)?\s*call|call\s+ended|started\s+a\s+call|you\s+missed\s+a\s+call)$/i.test(normalizeDateString(checkText)) ||
        (/\b(?:missed\s+(?:audio|video)?\s*call|audio\s+call|video\s+call)\b/i.test(checkText) && checkText.length < 80)) {
      return 'call';
    }

    if (nonQuoteQuery('audio, [aria-label*="voice message" i], [aria-label*="audio message" i], [aria-label*="voice clip" i]')) {
      return 'voice';
    }
    if (nonQuoteQuery('img[src*="stickers"], [aria-label*="sticker" i]')) {
      return 'sticker';
    }

    // Video detection (outside quoted reply preview)
    const videoEl = nonQuoteQuery('video, [aria-label*="video" i], [aria-label*="Play video" i], [data-testid*="video" i]');
    if (videoEl) {
      return 'video';
    }
    // Also detect video preview card with an image thumbnail + play button + duration chip outside quote
    const hasPlayBtn = !!nonQuoteQuery('[aria-label*="play" i], svg[aria-label*="play" i], [data-testid*="play" i]');
    const hasDur = !!this.extractMediaDuration(el, quoteSet);
    if (hasPlayBtn && hasDur) {
      return 'video';
    }

    // Photos & Images (outside quote, avatars, and reaction/emoji sprites)
    const imgs = el.querySelectorAll ? Array.from(el.querySelectorAll('img')) : [];
    const realPhotoImg = imgs.find(img => {
      if (inQuote(img)) return false;
      if (this.isAvatarImage(img, el, chatName)) return false;
      if (this.isEmojiImage(img)) return false;
      const src = (img.getAttribute?.('src') || '').toLowerCase();
      const alt = (img.getAttribute?.('alt') || '').toLowerCase();
      return src.includes('fbcdn') || src.includes('scontent') || src.startsWith('blob:') ||
             /photo|image|attachment|open photo/i.test(alt) ||
             !!img.closest?.('a[href*="/messenger_media"], [aria-label*="Open photo" i]');
    });
    if (realPhotoImg) {
      return 'image';
    }

    if (nonQuoteQuery('a[href*="attachment"], a[download]')) {
      return 'file';
    }

    const httpLinks = el.querySelectorAll ? Array.from(el.querySelectorAll('a[href]')).filter(a => {
      if (inQuote(a)) return false;
      const href = (a.getAttribute?.('href') || '').toLowerCase();
      return href.startsWith('http') && !href.includes('messenger.com/messages') && !href.includes('facebook.com/messages');
    }) : [];
    if (/^click to see post$/i.test(normalizeDateString(checkText)) || httpLinks.length > 0) {
      if (!ownLines || httpLinks.length > 0) {
        return 'link';
      }
    }

    return 'text';
  }

  extractText(el, type, fallbackText, quoteSet = new Set(), chatName = '', duration = null) {
    switch (type) {
      case 'voice':   return duration ? `[voice message (${duration})]` : '[voice message]';
      case 'sticker': return '[sticker]';
      case 'video':   return duration ? `[video (${duration})]` : '[video]';
      case 'image':   return '[image]';
      case 'file':    return '[file]';
      case 'call':    return fallbackText || '[call]';
      case 'deleted': return '[Message unsent]';
      case 'link': {
        const lines = this.extractCleanVisibleLines(el, quoteSet, chatName);
        if (lines.length > 0) return lines.join(' — ');
        const href = el.querySelector?.('a[href^="http"]')?.getAttribute?.('href');
        return href || fallbackText || '[Shared link]';
      }
      case 'system':  return fallbackText;
      case 'text':
      default: {
        const lines = this.extractCleanVisibleLines(el, quoteSet, chatName);
        if (lines.length > 0) {
          return lines.join('\n');
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
    const text = normalizeDateString(el.innerText || el.textContent || '');
    return parseDateSeparatorText(text, this.detectedDateFormat, this.activeDateSeparator, this.baseSessionDate);
  }

  extractExplicitTime(el) {
    const aria = el.getAttribute?.('aria-label') || '';
    if (aria) {
      const m = normalizeDateString(aria).match(/(\d{1,2}:\d{2}\s*(?:am|pm))/i);
      if (m) {
        return this.parseFuzzyDate(m[1]);
      }
    }
    return null;
  }

  parseFuzzyDate(str) {
    try {
      const now = this.baseSessionDate || new Date();
      const s = normalizeDateString(str);

      if (/^today/i.test(s)) {
        const t = this.extractTimeParts(s);
        if (t) return new Date(now.getFullYear(), now.getMonth(), now.getDate(), t.hours, t.minutes);
      }

      if (/^yesterday/i.test(s)) {
        const y = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const t = this.extractTimeParts(s);
        if (t) return new Date(y.getFullYear(), y.getMonth(), y.getDate(), t.hours, t.minutes);
      }

      const t = this.extractTimeParts(s);
      if (/^\d{1,2}:\d{2}\s*(?:am|pm)?$/i.test(s) && t) {
        return new Date(now.getFullYear(), now.getMonth(), now.getDate(), t.hours, t.minutes);
      }

      const parsed = new Date(s);
      if (!isNaN(parsed.getTime())) return parsed;
    } catch (_) {}

    return null;
  }

  extractTimeParts(str) {
    const m = normalizeDateString(str).match(/(\d{1,2}):(\d{2})\s*([ap]m)?/i);
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
    const candidates = container ? this.enumerateCandidateRows(container) : [];
    const results = [
      { name: 'scrollContainer', found: !!container, selector: 'div[role="main"] div[data-scope="messages_table"]' },
      { name: 'chatHeader', found: !!(chatName && chatName !== 'Messenger chat' && chatName !== 'Unknown Chat'), selector: this.selectors.chatHeader[0] },
      { name: 'messageRows', found: candidates.length > 0, selector: '[role="row"], [role="gridcell"]' }
    ];
    return { ok: results.every(r => r.found), results };
  }
}
