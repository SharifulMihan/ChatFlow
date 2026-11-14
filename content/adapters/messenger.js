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
  extractCleanIntroSystemText,
  truncateQuoteText,
  cleanMessageText,
  isPureAccessibilityLabel,
  isEmojiOnlySender,
  isReactionOnly,
  extractValidReactions,
  cleanReactionsList,
  isDurationChipText,
  containsEmojiGlyph,
  isReplyLabel,
  parseReplyLabel,
  extractReplySender,
  isBlockedUiName,
  validatePersonName,
  isParticipantOrAvatarNameOnly,
  isValidConversationDate,
  detectDateFormat,
  parseDateSeparatorText,
  looksLikeDateOrTimeSeparator,
  normalizeDateString,
  isLikeLabel,
  extractRowAccessibilityLabels,
  buildPrunedDomSkeleton,
  isTickLabel
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
      } catch (_) { }
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
    } catch (_) { }

    // 3. Check conversation intro block heading (the contact name at the very beginning of the chat)
    try {
      const introHeading = doc.querySelector('div[role="main"] [data-scope="messages_table"] h2, div[role="main"] [role="grid"] h2');
      if (introHeading && !this.isPinnedBannerElement(introHeading)) {
        const clean = sanitizeChatName(introHeading.innerText || introHeading.textContent || '', '');
        if (clean && this.isValidContactName(clean)) return clean;
      }
    } catch (_) { }

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
    } catch (_) { }

    // 5. Fallback to document.title without " | Messenger" or " - Messenger"
    try {
      if (doc.title) {
        const rawTitle = doc.title.replace(/\s*[|\-]\s*Messenger.*$/i, '').replace(/^\(\d+\)\s*/, '');
        const clean = sanitizeChatName(rawTitle, '');
        if (clean && this.isValidContactName(clean)) return clean;
      }
    } catch (_) { }

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
      } catch (_) { }
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
      } catch (_) { }
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
  hasReachedTop(container, _doc = (typeof document !== 'undefined' ? document : null), tracker = null) {
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
  hasReachedBottom(container, _doc = (typeof document !== 'undefined' ? document : null)) {
    if (!container) return { reached: true, reason: 'no_container' };
    const atBottom = (container.scrollTop + container.clientHeight >= container.scrollHeight - 6);
    return { reached: atBottom, reason: atBottom ? 'scroll_at_bottom' : 'scrolling' };
  }

  async scrollToLoadOlder(container, _doc = document, _onProgress = () => { }, ctrl = null) {
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
          try { sig.removeEventListener('abort', finish); } catch (_) { }
        }
        resolve();
      };
      if (sig && typeof sig.addEventListener === 'function') {
        try { sig.addEventListener('abort', finish, { once: true }); } catch (_) { }
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

  /** Reset sweep-local cursors before Pass 2 verification while preserving Pass 1 audit totals. */
  resetVerificationPassState() {
    this.activeDateSeparator = null;
    this.firstValidSeparator = null;
    this.previousSender = null;
    this.previousIsMe = false;
    this.rowParseCache = new WeakMap();
  }

  resetAuditStats() {
    this.rowElementIds = new WeakMap();
    this.rowParseCache = new WeakMap();
    this.classifyCallsCount = 0;
    this.rowParseCacheHits = 0;
    this.nextUniqueRowId = 1;
    this.seenStructuralToKey = new Map();
    this.auditUnique = {
      rows: new Map(),
      separators: new Map(),
      system: new Map(),
      replyLabels: new Map(),
      noise: new Map(),
      unrecognized: new Map(),
      otherIcons: new Map(),
      exportedMessages: new Set(),
      resolvedWeekdays: new Map(),
      rejectedSeparators: new Map()
    };
    this.auditStats = {
      candidateRowsSeen: 0,
      uniqueRowsSeen: 0,
      messagesExported: 0,
      separatorsCount: 0,
      uniqueSeparators: 0,
      systemRowsCount: 0,
      uniqueSystemRows: 0,
      replyLabelsCount: 0,
      uniqueReplyLabels: 0,
      orphanRepliesCount: 0,
      unparsedReplyLabelsCount: 0,
      noiseRowsCount: 0,
      uniqueNoiseRows: 0,
      unrecognizedCount: 0,
      uniqueUnrecognized: 0,
      otherIconMessagesCount: 0,
      sightings: {
        rowSightings: 0,
        separatorSightings: 0,
        systemSightings: 0,
        replyLabelSightings: 0,
        noiseSightings: 0,
        unrecognizedSightings: 0
      },
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

  /**
   * Assign a stable canonical identity to a DOM row across overlapping scroll snapshots.
   * Uses a WeakMap for live Element identity plus a structural content/neighbor signature
   * fallback when Messenger unmounts & remounts the same logical row, while preventing
   * distinct rows simultaneously present in the same snapshot from colliding.
   */
  getRowUniqueKey(row, kind = 'row', contentSig = '', neighborSig = '', currentSnapshotSet = null) {
    if (!this.rowElementIds) this.rowElementIds = new WeakMap();
    if (!this.seenStructuralToKey) this.seenStructuralToKey = new Map();

    if (row && typeof row === 'object' && this.rowElementIds.has(row)) {
      return this.rowElementIds.get(row);
    }

    const cleanContent = String(contentSig || '').replace(/\s+/g, ' ').trim().slice(0, 100);
    const cleanNeighbor = String(neighborSig || '').replace(/\s+/g, ' ').trim().slice(0, 100);
    const structuralSig = `${kind}|${cleanContent}|${cleanNeighbor}`;

    if (cleanContent && this.seenStructuralToKey.has(structuralSig)) {
      const prev = this.seenStructuralToKey.get(structuralSig);
      const stillInCurrentDom = prev?.el && currentSnapshotSet && currentSnapshotSet.has(prev.el);
      if (!stillInCurrentDom) {
        if (row && typeof row === 'object') {
          this.rowElementIds.set(row, prev.key);
          this.seenStructuralToKey.set(structuralSig, { key: prev.key, el: row });
        }
        return prev.key;
      }
    }

    const key = `u_${this.nextUniqueRowId++}`;
    if (row && typeof row === 'object') {
      this.rowElementIds.set(row, key);
      if (cleanContent) {
        this.seenStructuralToKey.set(structuralSig, { key, el: row });
      }
    }
    return key;
  }

  guessUnrecognizedType(row, recoveredText = '') {
    if (!row || !row.querySelector) return 'unclassified_content';
    if (row.querySelector('svg')) return 'unknown_svg';
    if (row.querySelector('canvas, [data-widget]')) return 'unknown_widget';
    if (row.querySelector('img, video, audio')) return 'unknown_media';
    if (row.querySelector('[role="img"]')) return 'unknown_role_img';
    if (recoveredText) return 'unclassified_text';
    return 'unclassified_content';
  }

  recordRowAudit(row, category, opts = {}) {
    if (!this.auditStats) this.resetAuditStats();
    const {
      contentSig = '',
      neighborSig = '',
      currentSnapshotSet = null
    } = opts;

    this.auditStats.sightings.rowSightings++;
    const rowKey = this.getRowUniqueKey(row, category, contentSig, neighborSig, currentSnapshotSet);

    const rowEntry = this.auditUnique.rows.get(rowKey);
    if (rowEntry) {
      rowEntry.sightings++;
    } else {
      this.auditUnique.rows.set(rowKey, { kind: category, sightings: 1 });
    }

    const bumpCategory = (map, sightingField) => {
      this.auditStats.sightings[sightingField]++;
      const prev = map.get(rowKey);
      if (prev) {
        prev.sightings++;
        return prev;
      }
      const created = { key: rowKey, sightings: 1 };
      map.set(rowKey, created);
      return created;
    };

    if (category === 'separator') bumpCategory(this.auditUnique.separators, 'separatorSightings');
    else if (category === 'system') bumpCategory(this.auditUnique.system, 'systemSightings');
    else if (category === 'reply-label') bumpCategory(this.auditUnique.replyLabels, 'replyLabelSightings');
    else if (category === 'ui-noise') bumpCategory(this.auditUnique.noise, 'noiseSightings');
    else if (category === 'UNRECOGNIZED') bumpCategory(this.auditUnique.unrecognized, 'unrecognizedSightings');

    this.auditStats.uniqueRowsSeen = this.auditUnique.rows.size;
    this.auditStats.candidateRowsSeen = this.auditUnique.rows.size;
    this.auditStats.uniqueSeparators = this.auditUnique.separators.size;
    this.auditStats.separatorsCount = this.auditUnique.separators.size;
    this.auditStats.uniqueSystemRows = this.auditUnique.system.size;
    this.auditStats.systemRowsCount = this.auditUnique.system.size;
    this.auditStats.uniqueReplyLabels = this.auditUnique.replyLabels.size;
    this.auditStats.replyLabelsCount = this.auditUnique.replyLabels.size;
    this.auditStats.uniqueNoiseRows = this.auditUnique.noise.size;
    this.auditStats.noiseRowsCount = this.auditUnique.noise.size;
    this.auditStats.uniqueUnrecognized = this.auditUnique.unrecognized.size;
    this.auditStats.unrecognizedCount = this.auditUnique.unrecognized.size;
    this.auditStats.otherIconMessagesCount = this.auditUnique.otherIcons.size;
    return rowKey;
  }

  getAuditSnapshot() {
    if (!this.auditStats) this.resetAuditStats();
    const unrecSamples = Array.from(this.auditUnique?.unrecognized?.values?.() || [])
      .filter(s => s && s.skeleton !== undefined)
      .slice(0, 10);
    const resolvedWeekdays = Array.from(this.auditUnique?.resolvedWeekdays?.values?.() || []).slice(0, 50);
    const rejectedSeparators = Array.from(this.auditUnique?.rejectedSeparators?.values?.() || []).slice(0, 50);

    return {
      uniqueRowsSeen: this.auditStats.uniqueRowsSeen,
      candidateRowsSeen: this.auditStats.uniqueRowsSeen,
      messagesExported: this.auditStats.messagesExported,
      uniqueSeparators: this.auditStats.uniqueSeparators,
      separatorsCount: this.auditStats.uniqueSeparators,
      uniqueSystemRows: this.auditStats.uniqueSystemRows,
      systemRowsCount: this.auditStats.uniqueSystemRows,
      uniqueReplyLabels: this.auditStats.uniqueReplyLabels,
      replyLabelsCount: this.auditStats.uniqueReplyLabels,
      orphanRepliesCount: this.auditStats.orphanRepliesCount || 0,
      unparsedReplyLabelsCount: this.auditStats.unparsedReplyLabelsCount || 0,
      uniqueNoiseRows: this.auditStats.uniqueNoiseRows,
      noiseRowsCount: this.auditStats.uniqueNoiseRows,
      uniqueUnrecognized: this.auditStats.uniqueUnrecognized,
      unrecognizedCount: this.auditStats.uniqueUnrecognized,
      otherIconMessagesCount: this.auditUnique?.otherIcons?.size || 0,
      classifyCallsCount: this.classifyCallsCount || 0,
      rowParseCacheHits: this.rowParseCacheHits || 0,
      sightings: { ...this.auditStats.sightings },
      unrecognizedSamples: unrecSamples,
      selectorHits: { ...this.auditStats.selectorHits },
      resolvedWeekdays,
      rejectedSeparators
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
    } catch (_) { }
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
    } catch (_) { }
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
    if (this.isEmojiImage(img)) return false;
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
    } catch (_) { }

    const insideMediaLink = !!img.closest?.('a[href*="/messenger_media"], a[href*="photo"], [aria-label*="Open photo" i], [aria-label*="view photo" i]');
    if (!insideMediaLink && w > 0 && h > 0 && w <= 48 && h <= 48 && Math.abs(w - h) <= 6) {
      return true;
    }

    // Contact name match on img alt (e.g. <img alt="Sudipta">, <img alt="Iqbal Mahmood"> on "Iqbal Mahmood Durjoy")
    if (alt && !/photo|image|attachment|picture|sticker|gif|open photo/i.test(alt)) {
      if (!insideMediaLink && isParticipantOrAvatarNameOnly(alt, { chatName })) {
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
      } catch (_) { }
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
    let replySenderIsMe = false;
    let replierName = '';
    let replierIsMe = null;
    let isSelfReply = false;
    let unparsedLabel = false;
    let isQuoteOnlyRow = false;
    let needsQuotePreview = false;

    if (!row || !row.querySelectorAll) {
      return {
        quoteSet,
        replyTo: externalPendingReply,
        replyHeaderEl: null,
        replierName: '',
        replierIsMe: null,
        isSelfReply: false,
        unparsedLabel: false,
        isQuoteOnlyRow: false,
        needsQuotePreview: false,
        hasQuoteContent: Boolean(externalPendingReply?.text || externalPendingReply?.mediaType)
      };
    }

    const markSubtreeQuoted = (el) => {
      if (!el) return;
      quoteSet.add(el);
      if (el.querySelectorAll) {
        for (const ch of Array.from(el.querySelectorAll('*'))) {
          quoteSet.add(ch);
        }
      }
    };

    const domBefore = (a, b) => {
      if (!a || !b || a === b || typeof a.compareDocumentPosition !== 'function') return false;
      return Boolean(a.compareDocumentPosition(b) & 4);
    };

    const highestContainerExcluding = (targetEl, excludedEls = []) => {
      if (!targetEl) return null;
      const blockers = excludedEls.filter(Boolean);
      let cur = targetEl;
      while (cur.parentElement && cur.parentElement !== row) {
        const parent = cur.parentElement;
        if (blockers.some(ex => parent === ex || parent.contains(ex))) {
          break;
        }
        cur = parent;
      }
      return cur;
    };

    // 1. Find innermost reply announcement header inside row ("Sudipta replied to you", "You replied to Sudipta")
    const allEls = Array.from(row.querySelectorAll('*'));
    const replyHeaderEl = allEls.find(node => {
      if (!node || quoteSet.has(node)) return false;
      if (node.querySelector?.('[data-scope="message_content"], [role="blockquote"], video, audio')) return false;
      const t = normalizeDateString(node.innerText || node.textContent || '');
      if (!t || t.length > 90 || !isReplyLabel(t)) return false;
      // Ensure we don't pick a wrapper that merely wraps an inner reply-label element + other content
      const childMatches = Array.from(node.querySelectorAll?.('*') || []).some(ch => {
        const ct = normalizeDateString(ch.innerText || ch.textContent || '');
        return ct && ct.length <= 90 && isReplyLabel(ct);
      });
      return !childMatches;
    });

    if (replyHeaderEl) {
      markSubtreeQuoted(replyHeaderEl);
      const headerText = normalizeDateString(replyHeaderEl.innerText || replyHeaderEl.textContent || '');
      const parsedLabel = parseReplyLabel(headerText, { chatName, myName: userAccount });
      if (parsedLabel.isReply) {
        if (parsedLabel.unparsed) unparsedLabel = true;
        replySender = parsedLabel.quotedSender || extractReplySender(headerText) || 'Unknown';
        replySenderIsMe = Boolean(parsedLabel.senderIsMe);
        replierName = parsedLabel.replierName || '';
        replierIsMe = parsedLabel.replierIsMe;
        isSelfReply = Boolean(parsedLabel.isSelfReply);
      }
    }

    if (!replySender && externalPendingReply && externalPendingReply.sender) {
      replySender = externalPendingReply.sender;
      if (externalPendingReply.senderIsMe || /^(?:me|you|yourself)$/i.test(replySender)) {
        replySenderIsMe = true;
      }
    }
    if (!replierName && externalPendingReply?.replierName) {
      replierName = externalPendingReply.replierName;
    }
    if (replierIsMe === null && externalPendingReply && externalPendingReply.replierIsMe !== undefined) {
      replierIsMe = externalPendingReply.replierIsMe;
    }

    // Collect leaf text elements & content media elements inside the row (excluding replyHeaderEl & UI badges)
    const dirAutoAll = Array.from(row.querySelectorAll('div[dir="auto"], span[dir="auto"]'));
    const leafTextEls = dirAutoAll.filter(node => {
      if (quoteSet.has(node)) return false;
      if (node.closest?.('[role="tooltip"], [data-testid*="reaction" i], [aria-label*="reaction" i], [aria-label*="reacted" i]')) return false;
      const hasChildDirAuto = Array.from(node.querySelectorAll?.('div[dir="auto"], span[dir="auto"]') || [])
        .some(ch => ch !== node && !quoteSet.has(ch));
      if (hasChildDirAuto) return false;
      const val = normalizeDateString(node.innerText || node.textContent || '');
      if (!val || isReplyLabel(val) || isPureAccessibilityLabel(val) || isDurationChipText(val)) return false;
      if (/^reactions?:?\s*(?:\?+|$)/i.test(val) || isReactionOnly(val, node)) return false;
      return true;
    });

    const contentMediaEls = allEls.filter(node => {
      if (quoteSet.has(node)) return false;
      if (node.closest?.('[role="tooltip"], [data-testid*="reaction" i], [aria-label*="reaction" i], [aria-label*="reacted" i]')) return false;
      const tag = (node.tagName || '').toUpperCase();
      if (tag === 'VIDEO' || tag === 'AUDIO') return true;
      if (tag === 'IMG') {
        return !this.isEmojiImage(node) && !this.isAvatarImage(node, row, chatName);
      }
      const aria = (node.getAttribute?.('aria-label') || '').trim();
      if (/\b(?:play\s+video|voice\s+message|audio\s+message)\b/i.test(aria) && !node.querySelector?.('video, audio, img')) {
        return true;
      }
      if (/^(?:gif|sticker)$/i.test(aria) && !node.querySelector?.('img, video')) {
        return true;
      }
      return false;
    });

    // 2. Find explicit quoted container(s)
    const explicitQuoteSelectors = [
      '[aria-label*="Replied to" i]',
      '[aria-label*="Replying to" i]',
      '[aria-label*="Original message" i]',
      '[data-testid*="quoted" i]',
      '[data-testid*="reply-quote" i]',
      '[data-scope="quoted_message" i]',
      '[class*="reply-preview" i]',
      '[class*="quoted" i]',
      '[class*="replied" i]',
      '[role="blockquote"]',
      'blockquote'
    ];
    let quotedContainer = row.querySelector?.(explicitQuoteSelectors.join(', '));
    // Guard against an outer wrapper matching class*="replied" or aria-label*="Replied to" and swallowing BOTH header/reply bubbles
    if (quotedContainer) {
      const totalItems = leafTextEls.length + contentMediaEls.length;
      const wrapsAllWithReply = totalItems >= 2 &&
        leafTextEls.every(n => quotedContainer.contains(n)) &&
        contentMediaEls.every(n => quotedContainer.contains(n));
      if (wrapsAllWithReply || (replyHeaderEl && quotedContainer.contains(replyHeaderEl))) {
        quotedContainer = null;
      }
    }

    // Also match Messenger accessibility wrapper whose text starts with "Original message:" or "<Name>: Original message:"
    if (!quotedContainer) {
      quotedContainer = allEls.find(node => {
        if (node === replyHeaderEl || node.contains(replyHeaderEl)) return false;
        const lastLeaf = leafTextEls[leafTextEls.length - 1];
        if (leafTextEls.length >= 2 && lastLeaf && node.contains(lastLeaf)) return false;
        const t = normalizeDateString(node.innerText || node.textContent || '');
        const hasChildOriginal = Array.from(node.children || []).some(ch => /^(?:[^\n:]{1,40}:\s*)?original\s+message:/i.test(normalizeDateString(ch.innerText || ch.textContent || '')));
        if (hasChildOriginal) return false;
        return /^(?:[^\n:]{1,40}:\s*)?original\s+message:/i.test(t) && t.length < 300;
      }) || null;
    }

    // Fallback 1: sibling stacking when >= 2 content siblings follow replyHeaderEl (quote + reply in same row)
    let hdrParentBlock = null;
    let hdrBlockEl = replyHeaderEl;
    if (replyHeaderEl) {
      while (
        hdrBlockEl.parentElement &&
        hdrBlockEl.parentElement !== row &&
        (hdrBlockEl.parentElement.children?.length || 0) <= 1
      ) {
        hdrBlockEl = hdrBlockEl.parentElement;
        markSubtreeQuoted(hdrBlockEl);
      }
      hdrParentBlock = hdrBlockEl.parentElement || row;
    }
    const contentSiblingsAfterHeader = hdrParentBlock
      ? Array.from(hdrParentBlock.children || []).filter(ch => {
        if (ch === hdrBlockEl || quoteSet.has(ch)) return false;
        if (ch.getAttribute?.('role') === 'tooltip') return false;
        const hasMedia = !!ch.querySelector?.('img:not([src*="emoji.php"]), video, audio') ||
          ['IMG', 'VIDEO', 'AUDIO'].includes((ch.tagName || '').toUpperCase());
        if (hasMedia) return true;
        const txt = normalizeDateString(ch.innerText || ch.textContent || '');
        if (!txt || isPureAccessibilityLabel(txt) || isDurationChipText(txt) || isReactionOnly(txt, ch)) return false;
        return true;
      })
      : [];

    if (!quotedContainer && replyHeaderEl && contentSiblingsAfterHeader.length >= 2) {
      quotedContainer = contentSiblingsAfterHeader[0];
    }

    // Fallback 2 (DOM-order bubble separation for 1-row complete replies with >= 2 content items)
    const isReplyRow = Boolean(replyHeaderEl || externalPendingReply || replySender);
    if (!quotedContainer && isReplyRow) {
      const lastLeaf = leafTextEls[leafTextEls.length - 1] || null;
      const lastMedia = contentMediaEls[contentMediaEls.length - 1] || null;

      if (contentMediaEls.length > 0 && lastLeaf && domBefore(contentMediaEls[0], lastLeaf)) {
        // Contact/me replied with text to a quoted media preview (e.g. Sudipta's "Sei" reply to video)
        quotedContainer = highestContainerExcluding(contentMediaEls[0], [lastLeaf, replyHeaderEl]);
      } else if (leafTextEls.length >= 2 && lastLeaf) {
        // Two or more text bubbles: preceding bubble(s) are quote, last bubble is actual reply
        quotedContainer = highestContainerExcluding(leafTextEls[0], [lastLeaf, replyHeaderEl]);
      } else if (leafTextEls.length === 1 && lastMedia && domBefore(leafTextEls[0], lastMedia)) {
        // Media reply quoting an earlier text message
        quotedContainer = highestContainerExcluding(leafTextEls[0], [lastMedia, replyHeaderEl]);
      }
    }

    // Case 2 (2-row split in Messenger: row contains ONLY [reply label + quote preview], real reply is in next row!)
    if (!quotedContainer && replyHeaderEl) {
      if (leafTextEls.length === 1 && contentMediaEls.length === 0) {
        const onlyLeaf = leafTextEls[0];
        const inBubbleScope = !!onlyLeaf.closest?.('[data-scope="message_content"], [data-testid="message-container"]');
        if (!inBubbleScope || this.looksLikeQuoteElement(onlyLeaf, row)) {
          quotedContainer = highestContainerExcluding(onlyLeaf, [replyHeaderEl]);
          isQuoteOnlyRow = true;
        }
      } else if (leafTextEls.length === 0 && contentMediaEls.length === 1) {
        quotedContainer = highestContainerExcluding(contentMediaEls[0], [replyHeaderEl]);
        isQuoteOnlyRow = true;
      } else if (leafTextEls.length === 0 && contentMediaEls.length === 0 && contentSiblingsAfterHeader.length === 1) {
        const onlySib = contentSiblingsAfterHeader[0];
        const inBubbleScope = !!(onlySib.matches?.('[data-scope="message_content"], [data-testid="message-container"]') ||
          onlySib.querySelector?.('[data-scope="message_content"], [data-testid="message-container"]'));
        if (!inBubbleScope || this.looksLikeQuoteElement(onlySib, row)) {
          quotedContainer = onlySib;
          isQuoteOnlyRow = true;
        }
      } else if (leafTextEls.length === 0 && contentMediaEls.length === 0) {
        isQuoteOnlyRow = true;
        needsQuotePreview = true;
      }
    }

    if (quotedContainer) {
      markSubtreeQuoted(quotedContainer);

      const rawQText = (quotedContainer.innerText || quotedContainer.textContent || '').trim();
      // Extract sender from "<Name>: Original message: ..." if present
      const origMatch = rawQText.match(/^([^\n:]{1,50}):\s*original\s+message:\s*([\s\S]*)$/i);
      if (origMatch) {
        const candidateSender = origMatch[1].trim();
        if (!replySender && !isBlockedUiName(candidateSender)) replySender = candidateSender;
        replyText = cleanMessageText(origMatch[2]).text;
      } else {
        let cleanedQ = rawQText.replace(/^(?:original\s+message:\s*)+/i, '').trim();
        if (replySender) {
          const esc = replySender.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          cleanedQ = cleanedQ.replace(new RegExp(`^${esc}\\s*:\\s*`, 'i'), '').trim();
        }
        cleanedQ = cleanedQ.replace(/^[^\n:]{1,40}:\s*original\s+message:\s*/i, '').trim();
        replyText = cleanMessageText(cleanedQ).text;
      }

      // Check for sticker / gif / video / voice / photo / file / link inside quoted container
      const qSticker = quotedContainer.querySelector?.('img[src*="stickers"], [aria-label*="sticker" i]') ||
        (quotedContainer.matches?.('img[src*="stickers"], [aria-label*="sticker" i]') ? quotedContainer : null);
      const qGif = quotedContainer.querySelector?.('[aria-label*="gif" i], img[src*=".gif"]') ||
        (quotedContainer.matches?.('[aria-label*="gif" i], img[src*=".gif"]') ? quotedContainer : null);
      const qVideo = quotedContainer.querySelector?.('video, [aria-label*="video" i], [aria-label*="play" i], [data-testid*="video" i]') ||
        (quotedContainer.matches?.('video, [aria-label*="video" i], [aria-label*="play" i]') ? quotedContainer : null);
      const qVoice = quotedContainer.querySelector?.('audio, [aria-label*="voice" i], [aria-label*="audio" i]') ||
        (quotedContainer.matches?.('audio, [aria-label*="voice" i], [aria-label*="audio" i]') ? quotedContainer : null);
      const qFile = quotedContainer.querySelector?.('a[href*="attachment"], a[download]') ||
        (quotedContainer.matches?.('a[href*="attachment"], a[download]') ? quotedContainer : null);
      const qImgs = quotedContainer.querySelectorAll ? Array.from(quotedContainer.querySelectorAll('img')) : [];
      if (quotedContainer.tagName === 'IMG') qImgs.push(quotedContainer);
      const qPhoto = qImgs.find(img => !this.isEmojiImage(img) && !this.isAvatarImage(img, quotedContainer, chatName));
      const qLinks = quotedContainer.querySelectorAll ? Array.from(quotedContainer.querySelectorAll('a[href^="http"]')) : [];
      if (quotedContainer.tagName === 'A' && /^https?:/i.test(quotedContainer.getAttribute?.('href') || '')) qLinks.push(quotedContainer);
      const qExtLink = qLinks.find(a => {
        const href = (a.getAttribute?.('href') || '').toLowerCase();
        return href.startsWith('http') && !href.includes('messenger.com/messages') && !href.includes('facebook.com/messages');
      });

      const isMediaPlaceholderText = !replyText || /^(?:attachment|video|photo|image|sticker|gif|link|voice message|audio message|\d{1,2}:\d{2})$/i.test(replyText);
      if (isMediaPlaceholderText) {
        if (qSticker) {
          replyMediaType = 'sticker';
          replyText = '';
        } else if (qGif) {
          replyMediaType = 'gif';
          replyText = '';
        } else if (qVideo) {
          replyMediaType = 'video';
          replyText = '';
        } else if (qVoice) {
          replyMediaType = 'voice';
          replyText = '';
        } else if (qFile || /^attachment$/i.test(replyText)) {
          replyMediaType = 'file';
          replyText = '';
        } else if (qPhoto) {
          replyMediaType = 'image';
          replyText = '';
        } else if (qExtLink) {
          replyMediaType = 'link';
          replyText = '';
        }
      } else if (qExtLink && /^https?:\/\/\S+$/i.test(replyText)) {
        replyMediaType = 'link';
        replyText = '';
      }

      const unquotedLeafCount = leafTextEls.filter(n => !quoteSet.has(n)).length;
      const unquotedMediaCount = contentMediaEls.filter(n => !quoteSet.has(n)).length;
      if (unquotedLeafCount === 0 && unquotedMediaCount === 0) {
        isQuoteOnlyRow = true;
      }
    }

    const rowHasQuoteContent = Boolean(replyText || replyMediaType);
    if (!rowHasQuoteContent && externalPendingReply) {
      if (!replyText && externalPendingReply.text) {
        replyText = String(externalPendingReply.text).replace(/^(?:[^\n:]{1,40}:\s*)?original\s+message:\s*/i, '').trim();
      }
      const extMedia = externalPendingReply.mediaType || (externalPendingReply.type && externalPendingReply.type !== 'text' ? externalPendingReply.type : null);
      if (!replyMediaType && extMedia) {
        replyMediaType = extMedia;
      }
    }

    const hasQuoteContent = Boolean(replyText || replyMediaType);

    let replyTo = null;
    if (hasQuoteContent || replySender) {
      if (replySender && /^(?:you|me|yourself)$/i.test(replySender)) {
        replySenderIsMe = true;
        replySender = (userAccount && !isBlockedUiName(userAccount)) ? userAccount : 'Me';
      } else if (replySender !== 'Unknown' && replySender && isBlockedUiName(replySender)) {
        replySender = '';
      }
      if (!replyMediaType && /^(?:\[?video\]?)$/i.test(replyText)) {
        replyMediaType = 'video';
        replyText = '';
      } else if (!replyMediaType && /^(?:\[?(?:photo|image)\]?)$/i.test(replyText)) {
        replyMediaType = 'image';
        replyText = '';
      } else if (!replyMediaType && /^(?:\[?(?:voice message|voice|audio)\]?)$/i.test(replyText)) {
        replyMediaType = 'voice';
        replyText = '';
      } else if (!replyMediaType && /^(?:\[?sticker\]?)$/i.test(replyText)) {
        replyMediaType = 'sticker';
        replyText = '';
      } else if (!replyMediaType && /^(?:\[?gif\]?)$/i.test(replyText)) {
        replyMediaType = 'gif';
        replyText = '';
      } else if (!replyMediaType && /^(?:\[?(?:file|attachment|document)\]?)$/i.test(replyText)) {
        replyMediaType = 'file';
        replyText = '';
      }

      const cleanTruncated = replyText ? truncateQuoteText(replyText, 140) : '';
      replyTo = {
        sender: replySender || 'Unknown',
        text: (replyMediaType && !cleanTruncated) ? '' : cleanTruncated,
        type: replyMediaType || 'text',
        mediaType: replyMediaType || null,
        senderIsMe: Boolean(replySenderIsMe)
      };
    }

    return {
      quoteSet,
      replyTo,
      replyHeaderEl,
      replierName,
      replierIsMe,
      isSelfReply,
      unparsedLabel,
      isQuoteOnlyRow,
      needsQuotePreview,
      hasQuoteContent
    };
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
    } catch (_) { }

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
    } catch (_) { }

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
    } catch (_) { }

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
    const firstLine = normalizeDateString(rawText.split(/\r?\n/)[0] || '');
    const ariaParsed = parseReplyLabel(aria, { chatName });
    const firstParsed = parseReplyLabel(firstLine, { chatName });
    const labelSample = `${aria}\n${rawText.slice(0, 100)}`;
    if (ariaParsed.isReply && ariaParsed.replierIsMe !== null) {
      nameVote = ariaParsed.replierIsMe;
    } else if (firstParsed.isReply && firstParsed.replierIsMe !== null) {
      nameVote = firstParsed.replierIsMe;
    } else if (/^(?:you\s+sent|sent\s+by\s+you|you:|you\s+replied|you\s+forwarded|আপনি\s+পাঠিয়েছেন|আপনি\s+উত্তর\s+দিয়েছেন)/im.test(labelSample)) {
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
    } catch (_) { }

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
   * Detect the logged-in user's profile name ONLY from validated non-button page elements.
   * NEVER reads aria-label or text of interface buttons (e.g. "Controls and settings").
   * Returns null if no valid person name is found.
   * @param {Document|Element} doc
   * @returns {string|null}
   */
  detectMyProfileName(doc = document) {
    try {
      const contactName = this.getChatName(doc) || '';
      const imgs = doc.querySelectorAll
        ? Array.from(doc.querySelectorAll('div[role="banner"] img[alt], a[href*="/me"] img[alt], a[href*="facebook.com/profile"] img[alt]'))
        : [];
      for (const img of imgs) {
        if (img.closest?.('button, [role="button"], [role="navigation"]')) continue;
        const rawAlt = (img.getAttribute('alt') || '').trim();
        const cleanedAlt = rawAlt.replace(/^(?:your\s+profile\s+picture|profile\s+picture\s+of)\s+/i, '').trim();
        const valid = validatePersonName(cleanedAlt, { contactName });
        if (valid) return valid;
      }
    } catch (_) { }
    return null;
  }

  /**
   * Resolve user account name from validated non-button page elements or fallback to 'Me'.
   * @param {Document|Element} doc
   * @returns {string}
   */
  getUserAccountName(doc = document) {
    return this.detectMyProfileName(doc) || 'Me';
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
        const hasContent = !!(txt || n.querySelector?.('img, video, audio, svg, canvas, a[href], [role="img"], [aria-label], [title]'));
        if (hasContent) candidateSet.add(n);
      }
    }

    // Fallback to direct children of container if needed (or uncovered sibling children)
    const directChildren = Array.from(container.children || []);
    if (candidateSet.size === 0) {
      hits.directChildFallback = directChildren.length;
      for (const ch of directChildren) {
        const txt = (ch.innerText || ch.textContent || '').trim();
        if (txt || ch.querySelector?.('img, video, audio, svg, canvas, a[href], [role="img"], [aria-label], [title]')) {
          candidateSet.add(ch);
        }
      }
    } else {
      for (const ch of directChildren) {
        if (Array.from(candidateSet).some(c => c === ch || ch.contains(c) || c.contains(ch))) continue;
        const txt = (ch.innerText || ch.textContent || '').trim();
        if (txt || ch.querySelector?.('img, video, audio, svg, canvas, a[href], [role="img"], [aria-label], [title]')) {
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
   * Read element text while excluding any <svg> subtrees (e.g. <svg><title>Thumbs up sign</title></svg>)
   * so inline SVG accessibility titles never leak as message body text.
   */
  getNodeTextExcludingSvg(node) {
    if (!node) return '';
    if (!node.querySelector?.('svg')) {
      return (node.innerText || node.textContent || '').trim();
    }
    const parts = [];
    const walk = (n) => {
      if (!n) return;
      if (n.nodeType === 3) {
        const t = n.nodeValue !== undefined && n.nodeValue !== null ? n.nodeValue : (n.textContent || '');
        if (t) parts.push(t);
        return;
      }
      if (n.nodeType === 1 && (n.tagName || '').toLowerCase() === 'svg') return;
      for (const ch of (n.childNodes || [])) walk(ch);
    };
    walk(node);
    return parts.join('').replace(/\s+/g, ' ').trim();
  }

  /**
   * Check whether a node lives inside a quote preview, reaction summary badge pill,
   * or hover action toolbar button ("More", "Reply", "React").
   */
  isIgnoredUiIconNode(node, quoteSet = new Set()) {
    if (!node) return true;
    if (quoteSet && quoteSet.size > 0) {
      if (quoteSet.has(node)) return true;
      for (const q of quoteSet) {
        if (q && q.contains && q.contains(node)) return true;
      }
    }
    if (node.closest?.('[role="tooltip"], [data-testid*="reaction" i], [aria-label*="reacted" i], [aria-label*="see who" i]')) {
      return true;
    }
    const rxAnc = node.closest?.('[aria-label]');
    if (rxAnc) {
      const rxAria = (rxAnc.getAttribute?.('aria-label') || '').trim();
      if (/^(?:\d+\s+reactions?|react(?:\s+to\s+message)?|reactions?:|see\s+who)/i.test(rxAria)) {
        return true;
      }
    }
    const btn = node.closest?.('[role="button"], button');
    if (btn) {
      const btnAria = (btn.getAttribute?.('aria-label') || '').trim();
      if (/^(?:more|reply|react|remove|forward|unsend|more\s+options|react\s+to\s+message|remove\s+reaction|open\s+more)$/i.test(btnAria)) {
        return true;
      }
    }
    const aria = (node.getAttribute?.('aria-label') || '').trim();
    const title = (node.getAttribute?.('title') || '').trim();
    const alt = (node.getAttribute?.('alt') || '').trim();
    if (isTickLabel(aria) || isTickLabel(title) || isTickLabel(alt)) return true;
    return false;
  }

  /**
   * Detect icon-only messages (Like thumbs-up, stickers, custom reaction stickers, GIFs,
   * emoji-only <img> rows, or labeled icon bubbles) when no text lines exist.
   * Returns null if normal text lines are present or no recognized icon message is found.
   */
  extractIconOnlyInfo(row, quoteSet = new Set(), chatName = '') {
    if (!row || !row.querySelectorAll) return null;
    const ownLines = this.extractCleanVisibleLines(row, quoteSet, chatName);
    if (ownLines.length > 0) return null;

    const allNodes = [row, ...Array.from(row.querySelectorAll('*'))];
    const readLabels = (el) => {
      const vals = [];
      for (const attr of ['aria-label', 'title', 'alt']) {
        const v = (el.getAttribute?.(attr) || '').replace(/\s+/g, ' ').trim();
        if (v) vals.push(v);
      }
      if ((el.tagName || '').toLowerCase() === 'svg') {
        const t = (el.querySelector?.('title')?.textContent || '').replace(/\s+/g, ' ').trim();
        if (t) vals.push(t);
      }
      if ((el.tagName || '').toLowerCase() === 'title' && el.closest?.('svg')) {
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (t) vals.push(t);
      }
      return vals;
    };

    // 1. Like (thumbs-up): small, medium, or large SVG / role="img"
    for (const el of allNodes) {
      if (this.isIgnoredUiIconNode(el, quoteSet)) continue;
      const roleAttr = (el.getAttribute?.('role') || '').toLowerCase();
      const tag = (el.tagName || '').toLowerCase();
      const testId = (el.getAttribute?.('data-testid') || '').toLowerCase();
      const hasSemanticSurface = roleAttr === 'img' || tag === 'svg' || tag === 'title' || tag === 'img' ||
        el.hasAttribute?.('aria-label') || el.hasAttribute?.('title') || testId.includes('like');
      if (!hasSemanticSurface) continue;
      if (tag === 'img' && this.isAvatarImage(el, row, chatName)) continue;

      const labels = readLabels(el);
      if (labels.some(l => isLikeLabel(l))) {
        return {
          type: 'like',
          text: '👍',
          description: 'Like',
          isEmojiOnly: false,
          isOtherIcon: false
        };
      }
    }

    // 2. Sticker / Custom reaction sticker / Animated sticker
    for (const el of allNodes) {
      if (this.isIgnoredUiIconNode(el, quoteSet)) continue;
      const tag = (el.tagName || '').toLowerCase();
      if (tag === 'img' && this.isAvatarImage(el, row, chatName)) continue;
      const src = (el.getAttribute?.('src') || '').toLowerCase();
      const testId = (el.getAttribute?.('data-testid') || '').toLowerCase();
      const labels = readLabels(el);
      const stickerLabel = labels.find(l =>
        /\b(?:sticker|custom\s+reaction|avatar\s+sticker|animated\s+sticker)\b/i.test(l)
      );
      if (src.includes('stickers') || testId.includes('sticker') || stickerLabel) {
        const desc = stickerLabel || labels[0] || 'Sticker';
        return {
          type: 'sticker',
          text: '[sticker]',
          description: desc,
          isEmojiOnly: false,
          isOtherIcon: false
        };
      }
    }

    // 3. GIF
    for (const el of allNodes) {
      if (this.isIgnoredUiIconNode(el, quoteSet)) continue;
      const tag = (el.tagName || '').toLowerCase();
      if (tag === 'img' && this.isAvatarImage(el, row, chatName)) continue;
      const src = (el.getAttribute?.('src') || '').toLowerCase();
      const testId = (el.getAttribute?.('data-testid') || '').toLowerCase();
      const labels = readLabels(el);
      const gifLabel = labels.find(l => /\bgif\b/i.test(l));
      if (src.includes('.gif') || testId.includes('gif') || gifLabel) {
        const desc = gifLabel || labels[0] || 'GIF';
        return {
          type: 'gif',
          text: '[gif]',
          description: desc,
          isEmojiOnly: false,
          isOtherIcon: false
        };
      }
    }

    // 4. Emoji-only <img> message (large inline emoji without text bubble)
    const nonAvatarImgs = Array.from(row.querySelectorAll('img')).filter(img =>
      !this.isIgnoredUiIconNode(img, quoteSet) && !this.isAvatarImage(img, row, chatName)
    );
    if (nonAvatarImgs.length > 0 && nonAvatarImgs.every(img => this.isEmojiImage(img))) {
      const emojiAlts = nonAvatarImgs
        .map(img => (img.getAttribute?.('alt') || '').trim())
        .filter(Boolean);
      const joined = emojiAlts.join('');
      if (joined) {
        return {
          type: 'text',
          text: joined,
          description: joined,
          isEmojiOnly: true,
          isOtherIcon: false
        };
      }
      return {
        type: 'other',
        text: '[emoji]',
        description: 'Emoji',
        isEmojiOnly: true,
        isOtherIcon: true
      };
    }

    // 5. Other visible labeled icon/media specifically inside a message bubble container
    const msgContainers = Array.from(row.querySelectorAll('[data-scope="message_content"], [data-testid="message-container"]'))
      .filter(mc => !this.isIgnoredUiIconNode(mc, quoteSet));
    for (const mc of msgContainers) {
      const innerEls = [mc, ...Array.from(mc.querySelectorAll('svg, img, canvas, [role="img"], [aria-label], [title]'))];
      for (const el of innerEls) {
        if (this.isIgnoredUiIconNode(el, quoteSet)) continue;
        if ((el.tagName || '').toLowerCase() === 'img' && this.isAvatarImage(el, row, chatName)) continue;
        const labels = readLabels(el).filter(l => !isDurationChipText(l) && !isPureAccessibilityLabel(l));
        if (labels.length > 0) {
          const desc = labels[0];
          return {
            type: 'other',
            text: `[${desc}]`,
            description: desc,
            isEmojiOnly: false,
            isOtherIcon: true
          };
        }
      }
    }

    return null;
  }

  /**
   * Extract visible text nodes from a row while excluding quote containers, tooltips, reactions, duration chips, and SVG titles.
   */
  extractCleanVisibleLines(row, quoteSet = new Set(), chatName = '') {
    const rawText = this.getNodeTextExcludingSvg(row);
    if (!row.querySelectorAll) return rawText ? [rawText] : [];

    const nodes = Array.from(row.querySelectorAll('div[dir="auto"], span[dir="auto"]'));
    const lines = [];
    const seen = new Set();

    for (const node of nodes) {
      if (quoteSet.has(node)) continue;
      if (node.closest?.('[role="tooltip"], [data-testid*="reaction" i], [aria-label*="reacted" i], [aria-label*="see who" i]')) continue;
      // Skip ancestor nodes that contain child dir="auto" nodes to avoid duplicate concatenation
      const hasChildDirAuto = Array.from(node.querySelectorAll?.('div[dir="auto"], span[dir="auto"]') || [])
        .some(ch => ch !== node && !quoteSet.has(ch));
      if (hasChildDirAuto) continue;

      const val = this.getNodeTextExcludingSvg(node);
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
        const val = this.getNodeTextExcludingSvg(a);
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
    if (!ctx.skipAuditLog) {
      this.classifyCallsCount = (this.classifyCallsCount || 0) + 1;
    }

    const container = ctx.container || null;
    const chatName = ctx.chatName || '';
    const dateFloor = ctx.dateFloor !== undefined ? ctx.dateFloor : this.activeDateSeparator;

    const rawText = (row.innerText || row.textContent || '').trim();
    const rawTextNoSvg = this.getNodeTextExcludingSvg(row);
    const normText = normalizeDateString(rawTextNoSvg || rawText);
    const role = (row.getAttribute?.('role') || '').toLowerCase();
    const aria = normalizeDateString(row.getAttribute?.('aria-label') || '');
    const insideBubble = !!row.querySelector?.('[data-scope="message_content"], [data-testid="message-container"], [aria-label*="sent" i]');

    // 1. Pinned banner or hover tooltip UI
    if (this.isPinnedBannerElement(row)) {
      return { kind: 'ui-noise', reason: 'pinned_banner' };
    }
    if (role === 'tooltip' || (!normText && !aria && !row.querySelector?.('img, video, audio, svg, a[href], canvas, [data-widget], [role="img"], [aria-label], [title]'))) {
      return { kind: 'ui-noise', reason: role === 'tooltip' ? 'tooltip' : 'empty_spacer' };
    }

    // 2. System / intro notices (encryption, group created/renamed, member added/removed)
    // Note: Calls ("Audio call", "Missed call") are MESSAGES per Part 2.5, not system rows!
    const introCheckText = normText || aria;
    if (introCheckText && INTRO_BLOCK_PATTERNS.some(rx => rx.test(introCheckText)) && !row.querySelector?.('[data-scope="message_content"]')) {
      return {
        kind: 'system',
        reason: 'intro_block',
        text: extractCleanIntroSystemText(rawText || aria) || rawText || aria
      };
    }
    if (normText && /^(?:.+?\s+(?:added|removed|left the group|changed the group|named the group|set the nickname|changed the theme|changed the emoji)|you\s+(?:joined|left|created)\s+this\s+group)/i.test(normText) &&
      !row.querySelector?.('[data-scope="message_content"]')) {
      return { kind: 'system', reason: 'group_system_event', text: rawText };
    }

    // 3. Date / time separator check
    // Note: Even if a separator or hover timestamp goes backwards chronologically, NEVER fall through to 'message'!
    if (normText && looksLikeDateOrTimeSeparator(normText, this.detectedDateFormat, this.baseSessionDate)) {
      const hasMedia = !!(row.querySelector?.('video, audio, svg') ||
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
    if (quoteInfo.unparsedLabel && this.auditStats && !ctx.skipAuditLog) {
      this.auditStats.unparsedReplyLabelsCount++;
    }

    // 4. Reply-label and/or quote-preview-only row (2-row / 3-row split in Messenger: MUST NOT emit as a message!)
    if (quoteInfo.isQuoteOnlyRow) {
      return {
        kind: 'reply-label',
        reason: quoteInfo.replyHeaderEl
          ? (quoteInfo.hasQuoteContent ? 'reply_label_and_quote' : 'reply_label_only')
          : 'standalone_quote_preview',
        replySender: quoteInfo.replyTo?.sender || (quoteInfo.replyHeaderEl ? extractReplySender(normText) : ''),
        senderIsMe: Boolean(quoteInfo.replyTo?.senderIsMe),
        replierName: quoteInfo.replierName || '',
        replierIsMe: quoteInfo.replierIsMe ?? null,
        isSelfReply: Boolean(quoteInfo.isSelfReply),
        quotedText: quoteInfo.replyTo?.text || '',
        quotedType: quoteInfo.replyTo?.type || 'text',
        quotedMediaType: quoteInfo.replyTo?.mediaType || null,
        needsQuotePreview: Boolean(quoteInfo.needsQuotePreview),
        hasQuoteContent: Boolean(quoteInfo.hasQuoteContent),
        rawText: normText
      };
    }

    const msgType = this.detectMessageType(row, normText, quoteInfo.quoteSet, chatName);
    const iconInfo = msgType === 'text' || msgType === 'like' || msgType === 'sticker' || msgType === 'gif' || msgType === 'other'
      ? this.extractIconOnlyInfo(row, quoteInfo.quoteSet, chatName)
      : null;

    // 4b. Fallback check for standalone reply header row without its own bubble
    if (normText && isReplyLabel(normText) && msgType === 'text' && !iconInfo && !quoteInfo.replyTo?.text && !quoteInfo.replyTo?.mediaType) {
      const hasOwnBubbleLines = this.extractCleanVisibleLines(row, quoteInfo.quoteSet, chatName).length > 0;
      if (!hasOwnBubbleLines) {
        const parsed = parseReplyLabel(normText, { chatName, myName: ctx.userAccount || 'Me' });
        return {
          kind: 'reply-label',
          reason: 'reply_label_only',
          replySender: parsed.quotedSender || extractReplySender(normText),
          senderIsMe: Boolean(parsed.senderIsMe),
          replierName: parsed.replierName || '',
          replierIsMe: parsed.replierIsMe ?? null,
          isSelfReply: Boolean(parsed.isSelfReply),
          quotedText: '',
          quotedType: 'text',
          quotedMediaType: null,
          needsQuotePreview: true,
          hasQuoteContent: false,
          rawText: normText
        };
      }
    }

    // 5. Reaction-only badge pill (never matches media/icon rows, "0:19", or "???")
    if (msgType === 'text' && !iconInfo && isReactionOnly(normText, row)) {
      return {
        kind: 'ui-noise',
        reason: 'reaction_badge',
        reactions: extractValidReactions(row, normText)
      };
    }

    // 6. UI noise labels (standalone avatar/participant name like "Iqbal Mahmood" on "Iqbal Mahmood Durjoy", "Seen by", etc.)
    if (msgType === 'text' && !iconInfo) {
      if (!insideBubble && !quoteInfo.replyTo &&
        isParticipantOrAvatarNameOnly(normText || aria, { chatName, myName: ctx.userAccount })) {
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
    if (msgType === 'text' && !iconInfo && !quoteInfo.replyTo) {
      const cleanLines = this.extractCleanVisibleLines(row, quoteInfo.quoteSet, chatName);
      const bodyJoined = cleanLines.join('\n').trim();
      const bodyClean = cleanMessageText(bodyJoined).text;
      if (bodyClean && looksLikeDateOrTimeSeparator(bodyClean, this.detectedDateFormat, this.baseSessionDate) &&
        !row.querySelector?.('[data-scope="message_content"], [data-testid="message-container"]')) {
        return { kind: 'ui-noise', reason: 'hover_timestamp', rawText: bodyClean };
      }
    }

    // 8. Real message row (media, Like, sticker, GIF, other icon, call, deleted, link, reply, or clean text bubble)
    if (msgType !== 'text') {
      const res = { kind: 'message', msgType, quoteInfo, iconInfo };
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

    // 8b. Emoji-only <img> message without text nodes
    if (iconInfo && iconInfo.type === 'text' && iconInfo.text) {
      const res = { kind: 'message', msgType: 'text', quoteInfo, cleanLines: [iconInfo.text], bodyText: iconInfo.text, iconInfo };
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
    const bodyText = cleanMessageText(cleanLines.join('\n')).text;
    // Also guard against standalone "Original message: ..." without a body bubble
    if (!bodyText && quoteInfo.replyTo && (quoteInfo.replyTo.text || quoteInfo.replyTo.mediaType) && cleanLines.length === 0) {
      // Pure quoted preview row directly after a standalone reply-label row
      return {
        kind: 'reply-label',
        reason: 'standalone_quote_preview',
        quotedText: quoteInfo.replyTo.text || '',
        quotedType: quoteInfo.replyTo.type || 'text',
        quotedMediaType: quoteInfo.replyTo.mediaType || null,
        replySender: quoteInfo.replyTo.sender,
        senderIsMe: Boolean(quoteInfo.replyTo.senderIsMe),
        replierName: quoteInfo.replierName || '',
        replierIsMe: quoteInfo.replierIsMe ?? null,
        needsQuotePreview: false,
        hasQuoteContent: true
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

    // 9. Anything with visible text or media that didn't fit cleanly -> check noise/intro before UNRECOGNIZED
    const recovered = rawTextNoSvg ? normalizeDateString(rawTextNoSvg) : (aria || '');
    if (!insideBubble && recovered && isParticipantOrAvatarNameOnly(recovered, { chatName, myName: ctx.userAccount })) {
      return { kind: 'ui-noise', reason: 'avatar_name_label' };
    }
    if (!insideBubble && recovered && INTRO_BLOCK_PATTERNS.some(rx => rx.test(recovered))) {
      return {
        kind: 'system',
        reason: 'intro_block',
        text: extractCleanIntroSystemText(rawText || aria) || recovered
      };
    }

    const imgs = row.querySelectorAll ? Array.from(row.querySelectorAll('img')) : [];
    const hasOnlyAvatarImgs = imgs.length > 0 && imgs.every(img => this.isAvatarImage(img, row, chatName));
    if (!recovered && hasOnlyAvatarImgs && !row.querySelector?.('video, audio, svg, canvas, [data-widget]')) {
      return { kind: 'ui-noise', reason: 'avatar_only_row' };
    }

    // Pure hover toolbar / action buttons without message content
    const hasAnyMedia = !!row.querySelector?.('img, video, audio, svg, canvas, [data-widget]');
    if (recovered || hasAnyMedia) {
      return {
        kind: 'UNRECOGNIZED',
        reason: 'unclassified_content',
        textPreview: (recovered || '').slice(0, 40),
        recoveredText: recovered
      };
    }

    return { kind: 'ui-noise', reason: 'no_visible_content' };
  }

  getRowCacheStamp(row) {
    if (!row || typeof row !== 'object') return '';
    const txt = (row.textContent || '').trim();
    const aria = row.getAttribute?.('aria-label') || '';
    const childCount = row.childElementCount ?? row.children?.length ?? 0;
    const mediaCount = row.querySelectorAll ? row.querySelectorAll('img, video, audio, svg').length : 0;
    const firstMedia = row.querySelector?.('img[src], video[src], audio[src]');
    const mediaSrc = (firstMedia?.getAttribute?.('src') || '').slice(0, 80);
    return `${childCount}:${mediaCount}:${aria}:${mediaSrc}|${txt}`;
  }

  cloneCachedMessage(msg) {
    if (!msg) return null;
    return {
      ...msg,
      fingerprint: msg.fingerprint ? { ...msg.fingerprint } : undefined,
      dirVotes: msg.dirVotes ? { ...msg.dirVotes } : undefined,
      replyTo: msg.replyTo ? { ...msg.replyTo } : null,
      reactions: Array.isArray(msg.reactions) ? [...msg.reactions] : []
    };
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
    const quoteOnlyRowEls = new Set();
    const currentSnapshotSet = new Set(topLevelRows);
    const pendingNextTextSamples = [];
    let seenIntroBlock = false;
    let previousMsg = null;
    let pendingReply = null;
    let pendingForwarded = false;
    // IMPORTANT (Part 4.3 fix): Track separator strictly top-to-bottom within THIS snapshot!
    // Never leak a bottom-of-viewport separator from Snapshot N into Snapshot N+1's top pre-separator rows.
    let localDateCursor = null;

    const getQuickRowDirection = (candidateRow) => {
      const align = this.detectAlignment(candidateRow, container, new Set(), chatName);
      const { isMe, dirVotes } = this.computeRowDirectionVotes(candidateRow, container, new Set(), chatName, align);
      const hasStrongDir = dirVotes.geometry !== null || dirVotes.class !== null || dirVotes.ticks !== null || dirVotes.name !== null;
      return { isMe, dirVotes, hasStrongDir };
    };

    const getNeighborSig = (idx, fallbackPrev = null) => {
      const prevTxt = (fallbackPrev?.text || (idx > 0 ? this.getNodeTextExcludingSvg(topLevelRows[idx - 1]) : '') || '')
        .replace(/\s+/g, ' ').trim().slice(0, 24);
      const nextTxt = (idx + 1 < topLevelRows.length ? this.getNodeTextExcludingSvg(topLevelRows[idx + 1]) : '')
        .replace(/\s+/g, ' ').trim().slice(0, 24);
      return `${prevTxt}|${nextTxt}`;
    };

    const fillPendingNextText = (msgObj) => {
      if (!msgObj || !pendingNextTextSamples.length) return;
      const preview = (msgObj.text || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      if (!preview) return;
      while (pendingNextTextSamples.length > 0) {
        const s = pendingNextTextSamples.shift();
        if (s && !s.nextMessageText) {
          s.nextMessageText = preview;
        }
      }
    };

    const flushOrphanReply = (reasonRowIdx) => {
      if (!pendingReply) return;
      const orphanMsg = this.buildOrphanReplyMessage(pendingReply, chatName, userAccount, localDateCursor, reasonRowIdx);
      if (orphanMsg && !seen.has(orphanMsg.id)) {
        seen.add(orphanMsg.id);
        messages.push(orphanMsg);
        previousMsg = orphanMsg;
        fillPendingNextText(orphanMsg);
        this.auditStats.messagesExported++;
      }
      this.auditStats.orphanRepliesCount++;
      pendingReply = null;
    };

    // Step 2: Classify and extract EVERY candidate row in DOM reading order
    for (let rowIdx = 0; rowIdx < topLevelRows.length; rowIdx++) {
      const row = topLevelRows[rowIdx];
      const rowStamp = this.getRowCacheStamp(row);
      const curDateMs = (localDateCursor && isValidConversationDate(localDateCursor)) ? localDateCursor.getTime() : 0;
      const curPendingSig = pendingReply
        ? `${pendingReply.sender || ''}|${pendingReply.text || ''}|${pendingReply.mediaType || ''}|${pendingReply.needsQuotePreview ? 1 : 0}`
        : '';

      if (!this.rowParseCache) this.rowParseCache = new WeakMap();
      let cacheEntry = !pendingForwarded ? this.rowParseCache.get(row) : null;
      const canUseCachedCls = Boolean(
        cacheEntry &&
        cacheEntry.stamp === rowStamp &&
        !(cacheEntry.cls.kind === 'separator' && cacheEntry.dateFloorMs !== curDateMs) &&
        !(pendingReply && cacheEntry.pendingSig !== curPendingSig && cacheEntry.cls.kind !== 'reply-label')
      );

      let cls;
      let contentSig;
      if (canUseCachedCls) {
        this.rowParseCacheHits = (this.rowParseCacheHits || 0) + 1;
        cls = cacheEntry.cls;
        contentSig = cacheEntry.contentSig;
      } else {
        cls = this.classifyRow(row, {
          container,
          chatName,
          userAccount,
          pendingReply,
          dateFloor: localDateCursor,
          skipBuildMsg: true
        });
        contentSig = (
          cls.rawText ||
          cls.text ||
          cls.bodyText ||
          cls.recoveredText ||
          cls.iconInfo?.description ||
          cls.iconInfo?.text ||
          extractRowAccessibilityLabels(row)[0] ||
          cls.reason ||
          ''
        );
        if (!pendingForwarded && row && typeof row === 'object') {
          cacheEntry = {
            stamp: rowStamp,
            cls,
            contentSig,
            dateFloorMs: curDateMs,
            pendingSig: curPendingSig,
            parsedMsg: null,
            parsedPendingSig: null
          };
          this.rowParseCache.set(row, cacheEntry);
        } else {
          cacheEntry = null;
        }
      }
      const neighborSig = getNeighborSig(rowIdx, previousMsg);

      if (cls.kind === 'system') {
        this.recordRowAudit(row, 'system', { contentSig, neighborSig, currentSnapshotSet });
        if (pendingReply) {
          flushOrphanReply(rowIdx - 1);
        }
        if (cls.reason === 'intro_block') {
          if (seenIntroBlock) continue;
          seenIntroBlock = true;
        }
        const sysMsg = this.buildSystemMessage(cls.text, localDateCursor);
        if (sysMsg && !seen.has(sysMsg.id)) {
          seen.add(sysMsg.id);
          messages.push(sysMsg);
        }
        continue;
      }

      if (cls.kind === 'separator') {
        const sepKey = this.recordRowAudit(row, 'separator', { contentSig, neighborSig, currentSnapshotSet });
        if (cls.parsedDate) {
          localDateCursor = cls.parsedDate;
          this.activeDateSeparator = cls.parsedDate;
          if (!this.firstValidSeparator) {
            this.firstValidSeparator = cls.parsedDate;
          }
          if (/^(?:mon|tue|wed|thu|fri|sat|sun|today|yesterday)/i.test(cls.rawText)) {
            const resolvedIso = cls.parsedDate.toISOString();
            const wdMapKey = `${sepKey}|${cls.rawText}=>${resolvedIso}`;
            const prevWd = this.auditUnique.resolvedWeekdays.get(wdMapKey);
            if (prevWd) {
              prevWd.sightings++;
            } else {
              this.auditUnique.resolvedWeekdays.set(wdMapKey, {
                raw: cls.rawText,
                resolved: resolvedIso,
                sightings: 1
              });
            }
          }
        } else {
          const cursorIso = localDateCursor ? localDateCursor.toISOString() : null;
          const rejMapKey = `${sepKey}|${cls.rawText}@${cursorIso || 'none'}`;
          const prevRej = this.auditUnique.rejectedSeparators.get(rejMapKey);
          if (prevRej) {
            prevRej.sightings++;
          } else {
            this.auditUnique.rejectedSeparators.set(rejMapKey, {
              raw: cls.rawText,
              activeCursor: cursorIso,
              sightings: 1
            });
          }
          this.rejectedSeparatorsCount = this.auditUnique.rejectedSeparators.size;
        }
        continue;
      }

      if (cls.kind === 'reply-label') {
        this.recordRowAudit(row, 'reply-label', { contentSig, neighborSig, currentSnapshotSet });
        quoteOnlyRowEls.add(row);
        if (cls.reason === 'standalone_quote_preview' && pendingReply) {
          const mergedMedia = pendingReply.mediaType || cls.quotedMediaType || null;
          const mergedText = pendingReply.text || cls.quotedText || '';
          pendingReply = {
            ...pendingReply,
            sender: pendingReply.sender && pendingReply.sender !== 'Unknown'
              ? pendingReply.sender
              : (cls.replySender || 'Unknown'),
            senderIsMe: Boolean(pendingReply.senderIsMe || cls.senderIsMe),
            replierName: pendingReply.replierName || cls.replierName || '',
            replierIsMe: pendingReply.replierIsMe ?? cls.replierIsMe ?? null,
            isSelfReply: Boolean(pendingReply.isSelfReply || cls.isSelfReply),
            text: mergedText,
            type: mergedMedia || cls.quotedType || pendingReply.type || 'text',
            mediaType: mergedMedia,
            needsQuotePreview: false,
            hasQuoteContent: Boolean(mergedText || mergedMedia),
            quoteRowEl: row
          };
          continue;
        }
        if (pendingReply) {
          flushOrphanReply(rowIdx - 1);
        }
        const initMedia = cls.quotedMediaType || (cls.quotedType && cls.quotedType !== 'text' ? cls.quotedType : null);
        pendingReply = {
          sender: cls.replySender || 'Unknown',
          senderIsMe: Boolean(cls.senderIsMe),
          replierName: cls.replierName || '',
          replierIsMe: cls.replierIsMe ?? null,
          isSelfReply: Boolean(cls.isSelfReply),
          text: cls.quotedText || '',
          type: initMedia || cls.quotedType || 'text',
          mediaType: initMedia,
          needsQuotePreview: Boolean(cls.needsQuotePreview),
          hasQuoteContent: Boolean(cls.hasQuoteContent || cls.quotedText || initMedia),
          quoteRowEl: row,
          rowIdx
        };
        continue;
      }

      if (cls.kind === 'ui-noise') {
        this.recordRowAudit(row, 'ui-noise', { contentSig, neighborSig, currentSnapshotSet });
        if (cls.reason === 'reaction_badge' && previousMsg && Array.isArray(cls.reactions)) {
          previousMsg.reactions = cleanReactionsList(
            [...(previousMsg.reactions || []), ...cls.reactions],
            { myName: userAccount }
          );
        } else if (cls.reason === 'duration_chip' && previousMsg && (previousMsg.type === 'video' || previousMsg.type === 'voice')) {
          if (!previousMsg.duration) previousMsg.duration = cls.duration;
        } else if (cls.forwarded) {
          pendingForwarded = true;
        }
        continue;
      }

      // 3-row split lookahead: if an unstyled standalone quote preview row follows a bare reply-label
      // (whether classified as plain message or fallback UNRECOGNIZED due to missing dir="auto"),
      // absorb it into pendingReply instead of flushing an orphan or turning quote preview into its own block.
      if ((cls.kind === 'message' || cls.kind === 'UNRECOGNIZED') &&
        pendingReply && pendingReply.needsQuotePreview && !pendingReply.hasQuoteContent && !cls.quoteInfo?.replyHeaderEl) {
        const hasBubbleScope = !!row.querySelector?.('[data-scope="message_content"], [data-testid="message-container"]');
        const looksLikeUnstyledQuote = (!hasBubbleScope || this.looksLikeQuoteElement(row, container)) &&
          this.extractRowReactions(row, new Set(), userAccount).length === 0;
        if (looksLikeUnstyledQuote) {
          let nextSameSideMsg = null;
          let msgChecked = 0;
          for (let k = rowIdx + 1; k < topLevelRows.length && msgChecked < 3; k++) {
            const pCls = this.classifyRow(topLevelRows[k], {
              container,
              chatName,
              userAccount,
              pendingReply: null,
              dateFloor: localDateCursor,
              skipBuildMsg: true,
              skipAuditLog: true
            });
            if (pCls.kind === 'ui-noise') continue;
            if (pCls.kind === 'system' || pCls.kind === 'separator' || pCls.kind === 'reply-label') break;
            if (pCls.kind === 'message') {
              msgChecked++;
              if (pCls.quoteInfo?.replyHeaderEl) break;
              const pDir = getQuickRowDirection(topLevelRows[k]);
              if (pendingReply.replierIsMe === null || pendingReply.replierIsMe === undefined || !pDir.hasStrongDir || pDir.isMe === pendingReply.replierIsMe) {
                nextSameSideMsg = topLevelRows[k];
                break;
              }
            }
          }
          if (nextSameSideMsg) {
            this.recordRowAudit(row, 'reply-label', { contentSig, neighborSig, currentSnapshotSet });
            const absorbedMedia = (cls.msgType && cls.msgType !== 'text') ? cls.msgType : null;
            const rawAbsorbed = cls.bodyText || cls.recoveredText || normalizeDateString(row.innerText || row.textContent || '');
            const absorbedText = absorbedMedia ? '' : truncateQuoteText(rawAbsorbed, 140);
            quoteOnlyRowEls.add(row);
            pendingReply = {
              ...pendingReply,
              text: absorbedText,
              type: absorbedMedia || 'text',
              mediaType: absorbedMedia,
              needsQuotePreview: false,
              hasQuoteContent: Boolean(absorbedText || absorbedMedia),
              quoteRowEl: row
            };
            continue;
          }
        }
      }

      if (cls.kind === 'UNRECOGNIZED') {
        if (pendingReply) {
          flushOrphanReply(rowIdx - 1);
        }
        const uKey = this.recordRowAudit(row, 'UNRECOGNIZED', {
          contentSig: contentSig || this.guessUnrecognizedType(row, cls.recoveredText),
          neighborSig,
          currentSnapshotSet
        });
        const uEntry = this.auditUnique.unrecognized.get(uKey);
        if (uEntry && uEntry.skeleton === undefined) {
          const qDir = getQuickRowDirection(row);
          const labels = extractRowAccessibilityLabels(row);
          const skRedacted = buildPrunedDomSkeleton(row, { maxChars: 800, includeSampleText: false });
          const skWithText = buildPrunedDomSkeleton(row, { maxChars: 800, includeSampleText: true });
          uEntry.id = uKey;
          uEntry.index = rowIdx;
          uEntry.scrollTop = container.scrollTop || 0;
          uEntry.direction = qDir.hasStrongDir ? (qDir.isMe ? 'right' : 'left') : 'unknown';
          uEntry.typeGuess = this.guessUnrecognizedType(row, cls.recoveredText);
          uEntry.labels = labels;
          uEntry.text = (cls.recoveredText || '').slice(0, 40);
          uEntry.textPreview = (cls.textPreview || cls.recoveredText || '').slice(0, 40);
          uEntry.prevMessageText = (previousMsg?.text || '').replace(/\s+/g, ' ').trim().slice(0, 40);
          uEntry.nextMessageText = '';
          uEntry.skeletonRedacted = skRedacted;
          uEntry.skeletonWithText = skWithText;
          uEntry.skeleton = skRedacted;
          pendingNextTextSamples.push(uEntry);
        } else if (uEntry && !uEntry.nextMessageText) {
          pendingNextTextSamples.push(uEntry);
        }

        const unrecMsg = this.buildUnrecognizedMessage(row, container, chatName, userAccount, cls, localDateCursor, rowIdx);
        if (unrecMsg && !seen.has(unrecMsg.id)) {
          seen.add(unrecMsg.id);
          messages.push(unrecMsg);
          previousMsg = unrecMsg;
        }
        pendingForwarded = false;
        continue;
      }

      // cls.kind === 'message'
      const msgRowKey = this.recordRowAudit(row, 'message', {
        contentSig: `${cls.msgType || 'text'}:${contentSig}`,
        neighborSig,
        currentSnapshotSet
      });
      if (cls.iconInfo?.isOtherIcon || cls.msgType === 'other') {
        const prevOther = this.auditUnique.otherIcons.get(msgRowKey);
        if (prevOther) {
          prevOther.sightings++;
        } else {
          this.auditUnique.otherIcons.set(msgRowKey, {
            key: msgRowKey,
            description: cls.iconInfo?.description || contentSig,
            sightings: 1
          });
        }
        this.auditStats.otherIconMessagesCount = this.auditUnique.otherIcons.size;
      }

      let pendingForThisRow = pendingReply;
      let keepPendingForNext = false;
      let clsForRow = cls;

      if (pendingReply) {
        if (cls.quoteInfo?.replyHeaderEl) {
          // Next row starts its own self-contained reply -> flush prior unconsumed reply as orphan
          flushOrphanReply(rowIdx - 1);
          pendingForThisRow = null;
        } else if (pendingReply.replierIsMe !== null && pendingReply.replierIsMe !== undefined) {
          const rowDir = getQuickRowDirection(row);
          if (rowDir.hasStrongDir && rowDir.isMe !== pendingReply.replierIsMe) {
            let foundReplierSoon = false;
            let checkedMsgs = 0;
            for (let k = rowIdx + 1; k < topLevelRows.length && checkedMsgs < 3; k++) {
              const pCls = this.classifyRow(topLevelRows[k], {
                container,
                chatName,
                userAccount,
                pendingReply: null,
                dateFloor: localDateCursor,
                skipBuildMsg: true,
                skipAuditLog: true
              });
              if (pCls.kind === 'ui-noise') continue;
              if (pCls.kind === 'system' || pCls.kind === 'reply-label') break;
              if (pCls.kind === 'message') {
                checkedMsgs++;
                if (pCls.quoteInfo?.replyHeaderEl) break;
                const pDir = getQuickRowDirection(topLevelRows[k]);
                if (!pDir.hasStrongDir || pDir.isMe === pendingReply.replierIsMe) {
                  foundReplierSoon = true;
                  break;
                }
              }
            }
            if (foundReplierSoon) {
              keepPendingForNext = true;
            } else {
              flushOrphanReply(rowIdx - 1);
            }
            pendingForThisRow = null;
            clsForRow = { ...cls, quoteInfo: null };
          }
        }
      }

      if (quoteOnlyRowEls.has(row)) {
        continue;
      }

      const effectivePendingSig = pendingForThisRow ? curPendingSig : '';
      let msg = null;
      if (
        !pendingForwarded &&
        canUseCachedCls &&
        cacheEntry?.parsedMsg &&
        (cacheEntry.parsedPendingSig === effectivePendingSig || (!pendingForThisRow && cacheEntry.parsedMsg.replyTo))
      ) {
        msg = this.cloneCachedMessage(cacheEntry.parsedMsg);
        if (msg) {
          if (!msg.timestamp && localDateCursor && isValidConversationDate(localDateCursor)) {
            msg.timestamp = localDateCursor.toISOString();
            msg.timestampApproximate = true;
          }
          this.previousSender = msg.sender || this.previousSender;
          if (typeof msg.isMe === 'boolean') this.previousIsMe = msg.isMe;
        }
      } else {
        msg = this.parseMessengerRow(row, container, chatName, userAccount, pendingForThisRow, {
          classification: clsForRow,
          localDateCursor,
          rowIdx,
          forwarded: pendingForwarded
        });
        if (!pendingForwarded && cacheEntry && msg) {
          cacheEntry.parsedMsg = this.cloneCachedMessage(msg);
          cacheEntry.parsedPendingSig = effectivePendingSig;
        }
      }
      if (!keepPendingForNext) {
        pendingReply = null;
      }
      pendingForwarded = false;

      if (msg) {
        fillPendingNextText(msg);
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
          if (msgRowKey && this.auditUnique?.exportedMessages) {
            this.auditUnique.exportedMessages.add(msgRowKey);
            this.auditStats.messagesExported = this.auditUnique.exportedMessages.size;
          } else {
            this.auditStats.messagesExported++;
          }

          if (this.loggedMessageCount < 50) {
            this.loggedMessageCount++;
            if (typeof window !== 'undefined' && (window.__CHATFLOW_DEBUG__ || (typeof localStorage !== 'undefined' && localStorage.getItem('chatflow_debug') === 'true'))) {
              console.log(`[ChatFlow Debug #${this.loggedMessageCount}] sender="${msg.sender}" isMe=${msg.isMe} ts=${msg.timestamp} text="${msg.text.slice(0, 40)}"`);
            }
          }
        }
      }
    }

    if (pendingReply) {
      flushOrphanReply(topLevelRows.length - 1);
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

  buildOrphanReplyMessage(pending, defaultChatName, userAccount, dateCursor, rowIdx = 0) {
    if (!pending || (!pending.text && !pending.mediaType && !pending.sender)) return null;
    const isMe = pending.replierIsMe === true;
    const fallbackContact = (defaultChatName && !isEmojiOnlySender(defaultChatName)) ? defaultChatName : 'Contact';
    const validReplier = pending.replierName &&
      !isEmojiOnlySender(pending.replierName) &&
      !isBlockedUiName(pending.replierName) &&
      (!defaultChatName || !isParticipantOrAvatarNameOnly(pending.replierName, { chatName: defaultChatName }));
    const sender = isMe ? (userAccount || 'Me') : (validReplier ? pending.replierName : fallbackContact);
    const ts = dateCursor && isValidConversationDate(dateCursor) ? dateCursor : null;
    const qText = pending.text ? truncateQuoteText(pending.text, 140) : '';
    const qMedia = pending.mediaType || (pending.type && pending.type !== 'text' ? pending.type : null);
    const replyTo = {
      sender: pending.sender || 'Unknown',
      text: (qMedia && !qText) ? '' : qText,
      type: qMedia || 'text',
      mediaType: qMedia || null,
      senderIsMe: Boolean(pending.senderIsMe)
    };
    const text = '(reply content not captured)';
    const dirVoteVal = isMe ? 1 : (pending.replierIsMe === false ? -1 : 0);
    return {
      id: this.hashString(`msgr_orphan|${rowIdx}|${ts ? ts.toISOString() : 'none'}|${sender}|${replyTo.sender}|${replyTo.text}`),
      domId: null,
      fingerprint: { sender, type: 'text', text, isMe },
      timestamp: ts ? ts.toISOString() : null,
      timestampApproximate: true,
      sender,
      senderRaw: sender,
      text,
      type: 'text',
      incomplete: true,
      replyTo,
      isOutgoing: isMe,
      isMe,
      dirVotes: { geometry: null, class: null, ticks: null, name: dirVoteVal || null, previous: null, total: dirVoteVal },
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
    if (externalPendingReply?.quoteRowEl && externalPendingReply.quoteRowEl === el) return null;

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
    if (!quoteInfo.replyHeaderEl && quoteInfo.isQuoteOnlyRow) {
      return null;
    }
    const quoteSet = quoteInfo.quoteSet || new Set();
    const replyTo = quoteInfo.replyTo || null;
    const type = cls.msgType || this.detectMessageType(el, normalizeDateString(this.getNodeTextExcludingSvg(el) || rawText), quoteSet, defaultChatName);
    const iconInfo = cls.iconInfo || (['like', 'sticker', 'gif', 'other'].includes(type) || (type === 'text' && !this.extractCleanVisibleLines(el, quoteSet, defaultChatName).length)
      ? this.extractIconOnlyInfo(el, quoteSet, defaultChatName)
      : null);

    // Extract clean reactions attached inside the row (filtering out durations like 0:19 or ???)
    const reactions = this.extractRowReactions(el, quoteSet, userAccount);

    // Extract video/voice duration metadata (e.g. "0:05") without turning it into text or reaction
    const duration = (type === 'video' || type === 'voice') ? this.extractMediaDuration(el, quoteSet) : null;

    // Check forwarded indicator inside this row or from preceding label
    const forwarded = !!(opts.forwarded || /\bforwarded\b/i.test(rawText.slice(0, 80)) || el.querySelector?.('[aria-label*="forwarded" i]'));

    // 4. Sender & isMe Direction Votes
    const align = this.detectAlignment(el, container, quoteSet, defaultChatName);
    const dirResult = this.computeRowDirectionVotes(el, container, quoteSet, defaultChatName, align);
    let isMe = dirResult.isMe;
    const dirVotes = dirResult.dirVotes;

    const effectiveReplierIsMe = quoteInfo.replierIsMe ?? externalPendingReply?.replierIsMe ?? null;
    const effectiveReplierName = quoteInfo.replierName || externalPendingReply?.replierName || '';
    const hasStrongRowDir = dirVotes.geometry !== null || dirVotes.class !== null || dirVotes.ticks !== null || dirVotes.name !== null;
    if (!hasStrongRowDir && effectiveReplierIsMe !== null && effectiveReplierIsMe !== undefined) {
      isMe = Boolean(effectiveReplierIsMe);
    }

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
      if (!sender && effectiveReplierName && !isEmojiOnlySender(effectiveReplierName) && !isBlockedUiName(effectiveReplierName)) {
        // In 1-to-1 chats where Messenger shortens labels (e.g. "Iqbal Mahmood" for "Iqbal Mahmood Durjoy"),
        // keep full chatName so one contact is never split into two participants.
        if (!defaultChatName || !isParticipantOrAvatarNameOnly(effectiveReplierName, { chatName: defaultChatName })) {
          sender = effectiveReplierName;
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
    const fallbackClean = (
      cls.bodyText ||
      (iconInfo?.text) ||
      cls.cleanLines?.join('\n') ||
      cleanMessageText(this.getNodeTextExcludingSvg(el)).text ||
      ''
    );
    let text = this.extractText(el, type, fallbackClean, quoteSet, defaultChatName, duration, iconInfo);
    if (type === 'text') {
      text = cleanMessageText(text).text;
      // Strip any trailing hover timestamp or "Original message:" leak
      if (replyTo && replyTo.text && text.startsWith(replyTo.text) && text.length > replyTo.text.length) {
        text = text.slice(replyTo.text.length).replace(/^[\s:\-]+/, '').trim();
      }
      if (!text) return null;
      if (replyTo && !replyTo.mediaType && replyTo.text && text === replyTo.text && this.looksLikeQuoteElement(el, container)) {
        return null;
      }
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
    const descHint = iconInfo?.description ? iconInfo.description.slice(0, 30) : '';
    const tsKey = timestamp ? timestamp.toISOString() : 'ts_pending';
    const id = domId
      ? `msgr_${domId}`
      : this.hashString(`msgr_${sender}|${tsKey}|${type}|${text.slice(0, 80)}|${mediaSrcHint}|${descHint}`);

    const fingerprint = {
      sender,
      type,
      text: text.slice(0, 100),
      isMe
    };

    const mediaDescription = (iconInfo?.description && !iconInfo.isEmojiOnly) ? iconInfo.description : null;

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
      ...(mediaDescription ? { mediaDescription } : {}),
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
  extractRowReactions(row, quoteSet = new Set(), userAccount = 'Me') {
    const reactions = [];
    if (!row || !row.querySelectorAll) return reactions;

    const rxEls = Array.from(row.querySelectorAll('[aria-label*="reaction" i], [aria-label*="reacted" i], [data-testid*="reaction" i]'));
    for (const rxEl of rxEls) {
      if (quoteSet.has(rxEl)) continue;
      const aria = (rxEl.getAttribute?.('aria-label') || '').trim();
      // Skip standalone message-level custom reaction stickers inside message bubbles
      if (/\bcustom\s+reaction\s+sticker\b/i.test(aria) && rxEl.getAttribute?.('role') === 'img') continue;
      const txt = (rxEl.innerText || rxEl.textContent || '').trim();
      const parsed = extractValidReactions(rxEl, `${aria} ${txt}`, { myName: userAccount });
      reactions.push(...parsed);
    }
    return cleanReactionsList(reactions, { myName: userAccount });
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
      return nodes.find(n => !inQuote(n) && !this.isIgnoredUiIconNode(n, quoteSet)) || null;
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
    if (nonQuoteQuery('img[src*="stickers"], [aria-label*="sticker" i], [data-testid*="sticker" i], [title*="sticker" i]')) {
      return 'sticker';
    }

    const iconInfo = !ownLines ? this.extractIconOnlyInfo(el, quoteSet, chatName) : null;
    if (iconInfo && (iconInfo.type === 'sticker' || iconInfo.type === 'gif')) {
      return iconInfo.type;
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

    if (iconInfo && iconInfo.type === 'like') {
      return 'like';
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

    if (iconInfo && iconInfo.type === 'other') {
      return 'other';
    }

    return 'text';
  }

  extractText(el, type, fallbackText, quoteSet = new Set(), chatName = '', duration = null, iconInfo = null) {
    switch (type) {
      case 'like': return '👍';
      case 'voice': return duration ? `[voice message (${duration})]` : '[voice message]';
      case 'sticker': return '[sticker]';
      case 'gif': return '[gif]';
      case 'video': return duration ? `[video (${duration})]` : '[video]';
      case 'image': return '[image]';
      case 'file': return '[file]';
      case 'call': return fallbackText || '[call]';
      case 'deleted': return '[Message unsent]';
      case 'other': return iconInfo?.text || fallbackText || '[icon]';
      case 'link': {
        const lines = this.extractCleanVisibleLines(el, quoteSet, chatName);
        if (lines.length > 0) return lines.join(' — ');
        const href = el.querySelector?.('a[href^="http"]')?.getAttribute?.('href');
        return href || fallbackText || '[Shared link]';
      }
      case 'system': return fallbackText;
      case 'text':
      default: {
        const lines = this.extractCleanVisibleLines(el, quoteSet, chatName);
        if (lines.length > 0) {
          return lines.join('\n');
        }
        if (fallbackText) return fallbackText;
        const iconFallback = iconInfo || this.extractIconOnlyInfo(el, quoteSet, chatName);
        return iconFallback?.text || '';
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
    } catch (_) { }

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
