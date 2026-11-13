/**
 * scanner.js
 * Platform-independent ChatFlow scanning orchestrator.
 * Explicit Two-Phase state machine with Snapshot Overlap Merging:
 *   Phase 1 ("up"): Navigate to conversation beginning with multi-factor top detection
 *   Phase 2 ("down"): Forward sweep (at most 50% viewport) with DOM-settle wait & order-based overlap merging
 *   Phase 3 ("finalize"): Date validation, integrity report, and clean master transcript
 */

import { getAdapter } from './adapters/index.js';
import {
  resolveDirection,
  finalizeSenders,
  participantWarnings,
  quickDirectionCheck,
  toList
} from './direction.js';
import {
  isValidConversationDate,
  sanitizeSenderName,
  isTimeOrDateString,
  isLocalizedYou
} from './selectors.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const PHASE1_MAX_ATTEMPTS = 45;       // Hard cap on upward scroll attempts
const PHASE1_TIMEOUT_MS = 25000;       // Max ms before forced transition to Phase 2
const DOWNWARD_STEP_RATIO = 0.48;      // Step size <= 50% of container clientHeight
const DOM_QUIET_MS = 300;              // Required ms of no DOM mutations before reading
const DOM_MAX_WAIT_MS = 1500;          // Ceiling on DOM settle wait
const MUTATION_WAIT_MS = 1200;         // Max ms to wait for MutationObserver in Phase 1

// ─── Debug Logger ────────────────────────────────────────────────────────────

function isDebugEnabled() {
  try {
    return window.__CHATFLOW_DEBUG__ === true ||
           (typeof localStorage !== 'undefined' && localStorage.getItem('chatflow_debug') === 'true');
  } catch (_) {
    return false;
  }
}

function debugLog(...args) {
  if (isDebugEnabled()) {
    console.log('[ChatFlow Scanner]', ...args);
  }
}

// ─── Utilities ──────────────────────────────────────────────────────────────

/**
 * Sleep for `ms`, resolving early (without throwing) as soon as `signal` aborts
 * or `ctrl` is cancelled/finalized.
 * @param {number} ms
 * @param {AbortSignal|null} [signal]
 * @param {Object|null} [ctrl]
 * @returns {Promise<void>}
 */
export function abortableSleep(ms, signal = null, ctrl = null) {
  const sig = signal || ctrl?.signal || null;
  if (sig?.aborted || ctrl?.cancelled || ctrl?.finalized) {
    return Promise.resolve();
  }
  return new Promise(resolve => {
    let done = false;
    let timer = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (sig && typeof sig.removeEventListener === 'function') {
        try { sig.removeEventListener('abort', finish); } catch (_) {}
      }
      resolve();
    };
    if (sig && typeof sig.addEventListener === 'function') {
      try { sig.addEventListener('abort', finish, { once: true }); } catch (_) {}
    }
    timer = setTimeout(finish, Math.max(0, ms));
    if (sig?.aborted || ctrl?.cancelled || ctrl?.finalized) {
      finish();
    }
  });
}

function randomDelay(min = 100, max = 200, ctrl = null) {
  const ms = min + Math.random() * (max - min);
  return abortableSleep(ms, ctrl?.signal || null, ctrl);
}

/**
 * Wait for DOM to be quiet (no mutations for quietMs, or max timeout maxWaitMs).
 * Races against ctrl.signal so "Stop loading" or "Cancel" resolves immediately.
 */
function waitForDomQuiet(container, quietMs = DOM_QUIET_MS, maxWaitMs = DOM_MAX_WAIT_MS, ctrl = null) {
  const sig = ctrl?.signal || null;
  if (sig?.aborted || ctrl?.cancelled || ctrl?.finalized) {
    return Promise.resolve();
  }
  return new Promise(resolve => {
    let resolved = false;
    let quietTimer = null;
    let maxTimer = null;

    const cleanup = () => {
      if (!resolved) {
        resolved = true;
        if (quietTimer) clearTimeout(quietTimer);
        if (maxTimer) clearTimeout(maxTimer);
        try { obs.disconnect(); } catch (_) {}
        if (sig && typeof sig.removeEventListener === 'function') {
          try { sig.removeEventListener('abort', cleanup); } catch (_) {}
        }
        resolve();
      }
    };

    const resetQuietTimer = () => {
      if (resolved) return;
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(cleanup, quietMs);
    };

    const obs = new MutationObserver(() => {
      resetQuietTimer();
    });

    if (sig && typeof sig.addEventListener === 'function') {
      try { sig.addEventListener('abort', cleanup, { once: true }); } catch (_) {}
    }

    try {
      obs.observe(container, { childList: true, subtree: true });
    } catch (_) {
      cleanup();
      return;
    }
    resetQuietTimer();
    maxTimer = setTimeout(cleanup, maxWaitMs);

    if (sig?.aborted || ctrl?.cancelled || ctrl?.finalized) {
      cleanup();
    }
  });
}

function waitForMutations(container, timeoutMs = MUTATION_WAIT_MS, ctrl = null) {
  const sig = ctrl?.signal || null;
  if (sig?.aborted || ctrl?.cancelled || ctrl?.finalized) {
    return Promise.resolve(false);
  }
  return new Promise(resolve => {
    let resolved = false;
    let timer = null;

    const cleanup = (val = false) => {
      if (!resolved) {
        resolved = true;
        if (timer) clearTimeout(timer);
        try { obs.disconnect(); } catch (_) {}
        if (sig && typeof sig.removeEventListener === 'function') {
          try { sig.removeEventListener('abort', onAbort); } catch (_) {}
        }
        resolve(Boolean(val));
      }
    };

    const onAbort = () => cleanup(false);

    const obs = new MutationObserver(() => cleanup(true));
    if (sig && typeof sig.addEventListener === 'function') {
      try { sig.addEventListener('abort', onAbort, { once: true }); } catch (_) {}
    }

    try {
      obs.observe(container, { childList: true, subtree: true });
    } catch (_) {
      cleanup(false);
      return;
    }

    timer = setTimeout(() => cleanup(false), timeoutMs);

    if (sig?.aborted || ctrl?.cancelled || ctrl?.finalized) {
      cleanup(false);
    }
  });
}

// ─── Snapshot Overlap Merging ───────────────────────────────────────────────

function mergeRowMetadata(mItem, sItem) {
  if (!mItem || !sItem) return;
  if (sItem.reactions && sItem.reactions.length > 0) {
    mItem.reactions = Array.from(new Set([...(mItem.reactions || []), ...sItem.reactions]));
  }
  if (!mItem.timestamp && sItem.timestamp) {
    mItem.timestamp = sItem.timestamp;
    mItem.timestampApproximate = sItem.timestampApproximate;
  }
}

/**
 * Compare two message rows for equality.
 * Uses authoritative DOM IDs if present; otherwise matches type, text, and sender/direction.
 */
export function isRowMatch(a, b) {
  if (!a || !b) return false;
  if (a.domId && b.domId) return a.domId === b.domId;
  if (a.type !== b.type || a.text !== b.text) return false;
  if (a.sender !== b.sender && Boolean(a.isMe) !== Boolean(b.isMe)) return false;
  // If reply quotes exist, verify they match
  const qA = typeof a.replyTo === 'object' ? a.replyTo?.text : a.replyTo;
  const qB = typeof b.replyTo === 'object' ? b.replyTo?.text : b.replyTo;
  if (qA && qB && qA !== qB) return false;
  return true;
}

/**
 * Append rows from snapshot to masterList while skipping any row already present
 * in masterList (by domId or recent tail match).
 * @param {Object[]} masterList
 * @param {Object[]} rows
 * @returns {number} count of newly appended rows
 */
export function appendDeduplicated(masterList, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const existingDomIds = new Set();
  for (let i = 0; i < masterList.length; i++) {
    if (masterList[i]?.domId) existingDomIds.add(masterList[i].domId);
  }
  const tailStart = Math.max(0, masterList.length - 80);
  let appended = 0;
  for (const sItem of rows) {
    if (!sItem) continue;
    if (sItem.domId && existingDomIds.has(sItem.domId)) continue;
    if (!sItem.domId) {
      let dupInTail = false;
      for (let mIdx = masterList.length - 1; mIdx >= tailStart; mIdx--) {
        if (isRowMatch(masterList[mIdx], sItem)) {
          dupInTail = true;
          break;
        }
      }
      if (dupInTail) continue;
    }
    masterList.push(sItem);
    if (sItem.domId) existingDomIds.add(sItem.domId);
    appended++;
  }
  return appended;
}

/**
 * Merge a new snapshot into masterList by finding the longest overlap between
 * the end of masterList and the start of snapshot, with an anchor/subsequence
 * fallback for virtualized DOMs where an older top row remains mounted or an
 * intermediate row is lazily rendered.
 * Preserves identical consecutive messages ("Ok", "Ok", "Ok").
 * @param {Object[]} masterList
 * @param {Object[]} snapshot
 * @returns {{ overlap: number, appended: number }}
 */
export function mergeSnapshot(masterList, snapshot) {
  if (!snapshot || snapshot.length === 0) {
    return { overlap: 0, appended: 0 };
  }

  if (masterList.length === 0) {
    masterList.push(...snapshot);
    return { overlap: 0, appended: snapshot.length };
  }

  // Pass 1: Fast exact contiguous suffix-of-masterList to prefix-of-snapshot match
  const maxK = Math.min(snapshot.length, masterList.length);
  let bestK = 0;

  for (let k = maxK; k >= 1; k--) {
    let match = true;
    for (let i = 0; i < k; i++) {
      const mIdx = masterList.length - k + i;
      if (!isRowMatch(masterList[mIdx], snapshot[i])) {
        match = false;
        break;
      }
    }
    if (match) {
      bestK = k;
      break;
    }
  }

  if (bestK > 0) {
    // Merge newer metadata (reactions, explicit timestamps) into overlapping rows
    for (let i = 0; i < bestK; i++) {
      mergeRowMetadata(masterList[masterList.length - bestK + i], snapshot[i]);
    }

    const toAppend = snapshot.slice(bestK);
    const appended = appendDeduplicated(masterList, toAppend);
    return { overlap: bestK, appended };
  }

  // Pass 2: Anchor / Subsequence overlap fallback in the recent tail of masterList
  // Handles virtualized DOM re-ordering, backtracks, or a lazy-rendered row in the overlap window.
  const tailWindow = Math.min(masterList.length, 200);
  const tailStart = masterList.length - tailWindow;
  let matchedCount = 0;
  let lastMatchedSnapIdx = -1;
  let searchFromMasterIdx = tailStart;

  for (let sIdx = 0; sIdx < snapshot.length; sIdx++) {
    const sItem = snapshot[sIdx];
    if (!sItem) continue;

    let foundMIdx = -1;
    // Prefer exact domId match anywhere in the tail window
    if (sItem.domId) {
      for (let mIdx = masterList.length - 1; mIdx >= tailStart; mIdx--) {
        if (masterList[mIdx]?.domId === sItem.domId) {
          foundMIdx = mIdx;
          break;
        }
      }
    } else {
      // Order-preserving match in the tail window for rows without domId
      for (let mIdx = searchFromMasterIdx; mIdx < masterList.length; mIdx++) {
        if (isRowMatch(masterList[mIdx], sItem)) {
          foundMIdx = mIdx;
          break;
        }
      }
    }

    if (foundMIdx !== -1) {
      mergeRowMetadata(masterList[foundMIdx], sItem);
      matchedCount++;
      lastMatchedSnapIdx = sIdx;
      searchFromMasterIdx = Math.max(searchFromMasterIdx, foundMIdx + 1);
    }
  }

  if (matchedCount > 0) {
    const remaining = snapshot.slice(lastMatchedSnapIdx + 1);
    const appended = appendDeduplicated(masterList, remaining);
    return { overlap: matchedCount, appended };
  }

  return { overlap: 0, appended: 0 };
}

// ─── Scan Session (3-phase state machine, manual start) ──────────────────────
//
//   idle ──loadHistory()──▶ loading ──(beginning | stall | stop)──▶ ready
//   ready ──loadHistory()──▶ loading            (Load more history)
//   ready ──startReading()──▶ reading ──▶ preparing ──▶ done
//   any ──cancel()──▶ cancelled (everything discarded)
//
// Phase 1 ("loading") only loads history into the page. It NEVER extracts or counts messages.
// "ready" is completely passive: read-only MutationObserver for the oldest date, nothing else.
// Phase 2 ("reading") is the ONLY pass that collects and counts messages (counter starts at 0).
// Phase 3 ("preparing") finalizes: direction, names, dates, integrity, stats.

export const STALL_MS = 10000;             // no growth for ~10s => stalled
export const PHASE1_SAFETY_CAP_MS = 15 * 60 * 1000;
export const UI_EMIT_INTERVAL_MS = 250;    // <= 4 UI updates per second
export const READY_WATCH_INTERVAL_MS = 500; // <= 2 updates per second
export const DIRECTION_CHECK_EVERY = 200;

// Reasons that prove we are at the REAL beginning of the chat
export const TRUE_BEGINNING_REASONS = new Set([
  'whatsapp_encryption_notice',
  'chat_secure_notice',
  'intro_block_detected'
]);

export class ScanController {
  constructor() {
    this.cancelled = false;
    this.finalized = false; // adapters read this as "stop loading now"
    this.stopReason = null;
    this.phaseController = null;
  }
  get signal() {
    return this.phaseController ? this.phaseController.signal : null;
  }
  resetPhaseSignal() {
    if (this.phaseController) {
      try { this.phaseController.abort('phase_reset'); } catch (_) {}
    }
    this.phaseController = typeof AbortController !== 'undefined' ? new AbortController() : null;
    return this.signal;
  }
  cancel() {
    this.cancelled = true;
    this.stopReason = 'user_cancel';
    if (this.phaseController) {
      try { this.phaseController.abort('user_cancel'); } catch (_) {}
    }
  }
  finalize() {
    this.finalized = true;
    this.stopReason = 'user_stop';
    if (this.phaseController) {
      try { this.phaseController.abort('user_stop'); } catch (_) {}
    }
  }
}

export class ScanSession extends ScanController {
  /**
   * @param {(payload:Object)=>void} onEvent receives progress/state payloads
   * @param {{adapter?:Object, container?:Element, doc?:Document}} [env] injectable for tests
   */
  constructor(onEvent = () => {}, env = {}) {
    super();
    this.onEvent = onEvent;
    this.env = env;
    this.state = 'idle';
    this.adapter = null;
    this.container = null;
    this.chatName = '';
    this.chatType = 'one-to-one';
    this.profileName = null;
    this.beginningReached = false;
    this.endReason = null;
    this.oldestDate = null;
    this.rounds = 0;
    this._lastEmit = 0;
    this._observer = null;
    this._watchTimer = null;
    this.phase1StartedAt = 0;
  }

  // ── plumbing ──────────────────────────────────────────────────────────────

  get doc() { return this.env.doc || document; }

  emit(payload, force = false) {
    const now = Date.now();
    if (!force && now - this._lastEmit < UI_EMIT_INTERVAL_MS) return;
    this._lastEmit = now;
    try {
      this.onEvent({
        state: this.state,
        chatName: this.chatName,
        platform: this.adapter?.name,
        ...payload
      });
    } catch (_) {}
  }

  setState(state, extra = {}) {
    this.state = state;
    this.emit({ phase: state, ...extra }, true);
  }

  _init() {
    if (this.adapter) return;
    const adapter = this.env.adapter || getAdapter(window.location.href);
    if (!adapter) {
      throw new Error('Unsupported platform. ChatFlow supports WhatsApp Web and Facebook Messenger.');
    }
    this.adapter = adapter;
    try {
      const health = adapter.healthCheck ? adapter.healthCheck(this.doc) : { ok: true, results: [] };
      if (health && !health.ok) {
        const missing = toList(health.results).filter(r => r && !r.found).map(r => r.name).join(', ');
        debugLog(`${adapter.name} selector warning:`, missing);
      }
    } catch (err) {
      debugLog('healthCheck warning:', err);
    }
    this.container = this.env.container || adapter.getScrollContainer(this.doc);
    if (!this.container) {
      throw new Error(`Unable to locate ${adapter.name} message container. Please make sure a chat is open.`);
    }
    this.chatName = adapter.getChatName(this.doc);
    this.chatType = adapter.detectChatType ? adapter.detectChatType(this.doc) : 'one-to-one';
    this.profileName = adapter.detectMyProfileName ? adapter.detectMyProfileName(this.doc) : null;
  }

  _check() {
    if (this.cancelled) throw new Error('CANCELLED');
  }

  _peekOldest() {
    try {
      const d = this.adapter?.peekOldestDate?.(this.doc);
      if (d && isValidConversationDate(d)) {
        if (!this.oldestDate || d < this.oldestDate) this.oldestDate = d;
        return d;
      }
    } catch (_) {}
    return this.oldestDate;
  }

  // ── Phase 1: load history (no extraction, no counting) ────────────────────

  /**
   * Loads as much history as possible, then enters "ready". Never starts Phase 2.
   * @returns {Promise<{beginningReached:boolean, reason:string, oldestDate:string|null, stalled:boolean}>}
   */
  async loadHistory() {
    this._init();
    this._check();
    this.stopWatching();
    this.finalized = false; // a previous "Stop loading" must not stop this new round
    this.stopReason = null;
    const phaseSignal = this.resetPhaseSignal();
    this.rounds++;
    this.adapter.promptClickCount = 0;
    this.adapter.resetSessionDates?.();

    const container = this.container;
    const adapter = this.adapter;
    this.setState('loading', { oldestDate: this._iso(this._peekOldest()), elapsedMs: 0, stalled: false });

    const tracker = { attempts: 0, scrollTopZeroChecks: 0, topStableCount: 0, lastTopSig: null };
    const startedAt = Date.now();
    this.phase1StartedAt = startedAt;
    let lastGrowthAt = startedAt;
    let lastHeight = container.scrollHeight;
    let lastOldest = this._peekOldest()?.getTime() || 0;
    let reason = 'stalled';
    let beginning = false;
    let stalled = false;

    while (true) {
      this._check();
      if (this.finalized || phaseSignal?.aborted) { reason = 'user_stop'; break; }

      const top = adapter.hasReachedTop(container, this.doc, tracker);
      if (top && top.reached) {
        reason = top.reason || 'top';
        beginning = TRUE_BEGINNING_REASONS.has(reason);
        break;
      }

      const now = Date.now();
      if (now - lastGrowthAt >= STALL_MS) { reason = 'stalled'; stalled = true; break; }
      if (now - startedAt >= PHASE1_SAFETY_CAP_MS) { reason = 'safety_cap'; stalled = true; break; }

      tracker.attempts++;
      await adapter.scrollToLoadOlder(container, this.doc, (extra) => {
        if (this.finalized || phaseSignal?.aborted || this.state !== 'loading') return;
        this.emit({
          phase: 'loading',
          syncing: extra?.phase === 'syncing_phone',
          oldestDate: this._iso(this.oldestDate),
          elapsedMs: Date.now() - startedAt,
          stalled: Date.now() - lastGrowthAt >= STALL_MS * 0.6
        });
      }, this);
      this._check();
      if (this.finalized || phaseSignal?.aborted) { reason = 'user_stop'; break; }

      await waitForMutations(container, MUTATION_WAIT_MS, this);
      this._check();
      if (this.finalized || phaseSignal?.aborted) { reason = 'user_stop'; break; }

      await randomDelay(80, 160, this);
      this._check();
      if (this.finalized || phaseSignal?.aborted) { reason = 'user_stop'; break; }

      tracker.scrollTopZeroChecks = container.scrollTop <= 2 ? tracker.scrollTopZeroChecks + 1 : 0;

      // Growth = the page got taller or an older date appeared
      const oldest = this._peekOldest()?.getTime() || 0;
      if (container.scrollHeight > lastHeight + 2 || (oldest && (!lastOldest || oldest < lastOldest))) {
        lastGrowthAt = Date.now();
        tracker.attempts = 0;
        tracker.topStableCount = 0;
      }
      lastHeight = container.scrollHeight;
      lastOldest = oldest || lastOldest;

      this.emit({
        phase: 'loading',
        oldestDate: this._iso(this.oldestDate),
        elapsedMs: Date.now() - startedAt,
        stalled: Date.now() - lastGrowthAt >= STALL_MS * 0.6
      });
    }

    this.beginningReached = beginning;
    this.endReason = reason;
    debugLog('Phase 1 ended', { reason, beginning, rounds: this.rounds, oldest: this.oldestDate });
    if (this.state !== 'ready') {
      this._enterReady();
    }
    return this.readySnapshot({ stalled });
  }

  /** User pressed "Stop loading": ends Phase 1 immediately and goes to "Ready to scan" (never starts counting). */
  stopLoading() {
    this.finalize();
    if (this.state === 'loading') {
      this.endReason = 'user_stop';
      this._enterReady();
    }
    return this.readySnapshot({ status: 'phase1_stopped' });
  }

  // ── Ready (passive) ───────────────────────────────────────────────────────

  readySnapshot(extra = {}) {
    return {
      beginningReached: this.beginningReached,
      reason: this.endReason,
      oldestDate: this._iso(this._peekOldest()),
      ...extra
    };
  }

  _enterReady() {
    this.setState('ready', this.readySnapshot());
    this.startWatching();
  }

  /** Read-only observer: lets the "History loaded back to ..." line follow manual scrolling. */
  startWatching() {
    this.stopWatching();
    const container = this.container;
    if (!container || typeof MutationObserver === 'undefined') return;
    const tick = () => {
      this._watchTimer = null;
      if (this.state !== 'ready' || this.cancelled) return;
      const before = this.oldestDate ? this.oldestDate.getTime() : 0;
      const d = this._peekOldest();
      const beginning = (() => {
        try {
          const r = this.adapter.hasReachedTop(container, this.doc, null);
          return !!(r && r.reached && TRUE_BEGINNING_REASONS.has(r.reason));
        } catch (_) { return false; }
      })();
      const changed = (d ? d.getTime() : 0) !== before;
      if (changed || beginning !== this.beginningReached) {
        if (beginning) this.beginningReached = true;
        this.emit({ phase: 'ready', ...this.readySnapshot(), oldestChanged: changed }, true);
      }
    };
    this._observer = new MutationObserver(() => {
      if (!this._watchTimer) this._watchTimer = setTimeout(tick, READY_WATCH_INTERVAL_MS);
    });
    this._observer.observe(container, { childList: true, subtree: true });
  }

  stopWatching() {
    if (this._observer) { try { this._observer.disconnect(); } catch (_) {} }
    this._observer = null;
    if (this._watchTimer) clearTimeout(this._watchTimer);
    this._watchTimer = null;
  }

  // ── Phase 2 + 3: read downward (the ONLY counting pass) ───────────────────

  /**
   * @param {{myNameOverride?:string}} [options]
   */
  async startReading(options = {}) {
    this._init();
    this._check();
    if (this.state === 'loading') throw new Error('Still loading history. Stop loading first.');
    this.stopWatching();
    this.finalized = false;
    this.stopReason = null;
    const phaseSignal = this.resetPhaseSignal();

    const adapter = this.adapter;
    const container = this.container;
    const isWhatsApp = adapter.name === 'WhatsApp';

    // Phase 2 starts: counter resets to 0, scroll to the very top of what is loaded
    const masterList = [];
    let overlapMergesCount = 0;
    let noOverlapEventsCount = 0;
    const startedAt = Date.now();
    let lastPercent = 0;
    let directionLowLive = false;
    let nextDirectionCheck = DIRECTION_CHECK_EVERY;

    const progressPayload = () => {
      const maxScroll = Math.max(1, container.scrollHeight - container.clientHeight);
      const raw = Math.round((container.scrollTop / maxScroll) * 100);
      lastPercent = Math.min(100, Math.max(lastPercent, raw)); // monotonic
      const elapsed = (Date.now() - startedAt) / 1000;
      const rate = elapsed > 0.5 ? masterList.length / elapsed : 0;
      const eta = lastPercent >= 3 ? Math.round(elapsed * (100 - lastPercent) / lastPercent) : null;
      let current = null;
      for (let i = masterList.length - 1; i >= 0; i--) {
        if (masterList[i].timestamp) { current = masterList[i].timestamp; break; }
      }
      return {
        phase: 'reading',
        count: masterList.length,
        percent: lastPercent,
        currentDate: current,
        rate: Math.round(rate * 10) / 10,
        etaSec: eta,
        elapsedMs: Date.now() - startedAt,
        directionLow: directionLowLive
      };
    };

    this.setState('reading', { count: 0, percent: 0, currentDate: null, rate: 0, etaSec: null, elapsedMs: 0 });

    adapter.resetSessionDates?.();
    container.scrollTop = 0;
    container.dispatchEvent(new Event('scroll', { bubbles: true }));
    await waitForDomQuiet(container, 350, 1500, this);
    this._check();

    mergeSnapshot(masterList, adapter.extractMessages(this.doc));
    this.emit(progressPayload());

    let atBottomCount = 0;
    let lastScrollTop = -1;
    let forwardSteps = 0;
    const maxForwardSteps = 20000;
    let userStopped = false;

    while (atBottomCount < 3 && forwardSteps < maxForwardSteps) {
      this._check();
      if (this.finalized || phaseSignal?.aborted) { userStopped = true; break; }

      const prevScrollTop = container.scrollTop;
      const step = Math.max(180, Math.floor(container.clientHeight * DOWNWARD_STEP_RATIO));
      container.scrollTop += step;
      container.dispatchEvent(new Event('scroll', { bubbles: true }));
      forwardSteps++;

      await waitForDomQuiet(container, DOM_QUIET_MS, DOM_MAX_WAIT_MS, this);
      this._check();
      if (this.finalized || phaseSignal?.aborted) { userStopped = true; break; }

      const snapshot = adapter.extractMessages(this.doc);
      const mergeRes = mergeSnapshot(masterList, snapshot);

      if (mergeRes.overlap > 0) {
        overlapMergesCount++;
      } else if (snapshot.length > 0 && masterList.length > 0 && container.scrollTop !== prevScrollTop) {
        container.scrollTop = prevScrollTop + Math.max(80, Math.floor(step * 0.35));
        container.dispatchEvent(new Event('scroll', { bubbles: true }));
        await waitForDomQuiet(container, DOM_QUIET_MS, DOM_MAX_WAIT_MS, this);
        this._check();
        const retrySnap = adapter.extractMessages(this.doc);
        const retryMerge = mergeSnapshot(masterList, retrySnap);
        if (retryMerge.overlap > 0) {
          overlapMergesCount++;
        } else {
          noOverlapEventsCount++;
          debugLog('No overlap detected after backtrack. Appending deduplicated snapshot to avoid message loss.');
          appendDeduplicated(masterList, retrySnap);
        }
      }

      // Live direction self-check every 200 messages (cheap, non-mutating, non-fatal)
      if (masterList.length >= nextDirectionCheck) {
        nextDirectionCheck = masterList.length + DIRECTION_CHECK_EVERY;
        try {
          const q = quickDirectionCheck(masterList, this.chatType);
          directionLowLive = !!q.low;
          if (q.low) debugLog('Live direction check: LOW CONFIDENCE', q);
        } catch (liveErr) {
          debugLog('Live direction check warning:', liveErr);
        }
      }

      this.emit(progressPayload());

      const bottomResult = adapter.hasReachedBottom(container, this.doc);
      const isStuck = (container.scrollTop === lastScrollTop);
      if (bottomResult.reached || isStuck) {
        atBottomCount++;
        await abortableSleep(220, phaseSignal, this);
        this._check();
        if (this.finalized || phaseSignal?.aborted) { userStopped = true; break; }
        mergeSnapshot(masterList, adapter.extractMessages(this.doc));
      } else {
        atBottomCount = 0;
        lastScrollTop = container.scrollTop;
      }
    }
    this._check();

    if (!userStopped) {
      container.scrollTop = container.scrollHeight;
      container.dispatchEvent(new Event('scroll', { bubbles: true }));
      await waitForDomQuiet(container, 300, 1000, this);
      this._check();
      mergeSnapshot(masterList, adapter.extractMessages(this.doc));
    }

    // Last counter value shown == final total (forced, un-throttled)
    lastPercent = 100;
    this.emit({ ...progressPayload(), percent: 100 }, true);

    // ─── Phase 3: prepare summary ─────────────────────────────────────────
    this.setState('preparing', { count: masterList.length });
    const result = this._finalize(masterList, {
      overlapMergesCount,
      noOverlapEventsCount,
      userStopped,
      myNameOverride: options.myNameOverride,
      isWhatsApp
    });
    this.setState('done', { count: masterList.length });
    return result;
  }

  _finalize(masterList, { overlapMergesCount, noOverlapEventsCount, myNameOverride, isWhatsApp }) {
    const adapter = this.adapter;

    // Dates: WhatsApp times are exact; only Messenger may be approximate
    let firstValidTimestamp = null;
    for (const m of masterList) {
      if (m.timestamp && isValidConversationDate(new Date(m.timestamp))) { firstValidTimestamp = m.timestamp; break; }
    }
    if (firstValidTimestamp) {
      for (const msg of masterList) {
        if (!msg.timestamp) { msg.timestamp = firstValidTimestamp; msg.timestampApproximate = !isWhatsApp; }
        else break;
      }
    }
    let runningDate = firstValidTimestamp;
    for (const msg of masterList) {
      if (msg.timestamp) {
        if (isValidConversationDate(new Date(msg.timestamp))) runningDate = msg.timestamp;
        else { msg.timestamp = runningDate; msg.timestampApproximate = !isWhatsApp; }
      } else if (runningDate) {
        msg.timestamp = runningDate;
        msg.timestampApproximate = !isWhatsApp;
      }
      if (isWhatsApp) msg.timestampApproximate = false;
    }

    const validDates = masterList
      .map(m => (m.timestamp ? new Date(m.timestamp) : null))
      .filter(d => isValidConversationDate(d))
      .sort((a, b) => a - b);
    const startDate = validDates[0] ? validDates[0].toISOString() : null;
    const endDate = validDates[validDates.length - 1] ? validDates[validDates.length - 1].toISOString() : null;

    // Chat type: Messenger has no header hint, so infer groups from distinct names
    let chatType = this.chatType;
    if (adapter.name !== 'WhatsApp' && !adapter.detectChatType) {
      const names = new Map();
      for (const m of masterList) {
        if (m.type === 'system' || m.isMe) continue;
        const c = sanitizeSenderName(m.sender);
        if (c) names.set(c, (names.get(c) || 0) + 1);
      }
      const real = [...names.values()].filter(n => n >= 3).length;
      chatType = real >= 2 ? 'group' : 'one-to-one';
    }

    // DIRECTION decides the split. Names are derived afterwards.
    // Wrapped in try/catch so a diagnostic or self-check error is NEVER fatal.
    let checksIncomplete = false;
    let diagnosticsError = null;
    let direction = {
      lowConfidence: false,
      reason: 'ok',
      comboId: 'all',
      comboUsed: ['all'],
      tried: ['all'],
      triedDetails: [],
      meCount: 0,
      themCount: 0,
      counts: { me: 0, contact: 0 },
      agreement: {},
      log: []
    };
    let names = {
      myName: myNameOverride || this.profileName || 'Me',
      contactName: this.chatName || 'Contact',
      participants: [],
      counts: {},
      changed: 0
    };
    let warnings = [];

    try {
      direction = resolveDirection(masterList, { chatType, chatName: this.chatName, myName: this.profileName });
      direction.comboUsed = toList(direction.comboUsed).map(String);
      if (direction.comboUsed.length === 0) direction.comboUsed = ['all'];
      direction.tried = toList(direction.tried).map(String);
    } catch (dirErr) {
      checksIncomplete = true;
      diagnosticsError = `Direction self-check error: ${dirErr?.message || String(dirErr)}`;
      direction.log = [diagnosticsError];
      debugLog('Non-fatal direction self-check error:', dirErr);
    }

    try {
      names = finalizeSenders(masterList, {
        chatType, chatName: this.chatName, profileName: this.profileName, myNameOverride
      });
      warnings = toList(participantWarnings(masterList, chatType, names.counts));
      if (direction.lowConfidence) {
        warnings.unshift('Could not tell which messages are yours. Please confirm who is who.');
      }
    } catch (nameErr) {
      checksIncomplete = true;
      const msg = `Sender finalization warning: ${nameErr?.message || String(nameErr)}`;
      diagnosticsError = diagnosticsError ? `${diagnosticsError}; ${msg}` : msg;
      debugLog('Non-fatal sender finalization error:', nameErr);
    }

    const senderCounts = {};
    for (const m of masterList) {
      if (m.type === 'system') continue;
      const s = m.sender || (m.isMe ? names.myName : names.contactName) || 'Participant';
      m.sender = s;
      senderCounts[s] = (senderCounts[s] || 0) + 1;
    }

    // Duplicate check
    let duplicates = 0;
    const seenIds = new Set();
    for (let i = 0; i < masterList.length; i++) {
      const m = masterList[i];
      if (m.domId) {
        if (seenIds.has(m.domId)) duplicates++;
        seenIds.add(m.domId);
      }
    }

    const integrity = {
      totalMessages: masterList.length,
      totalCaptured: masterList.length,
      senderCounts,
      chatType,
      detectedMyName: names.myName,
      overlapMergesCount,
      overlapMerges: overlapMergesCount,
      noOverlapEventsCount,
      noOverlapEvents: noOverlapEventsCount,
      rejectedSeparatorsCount: adapter.rejectedSeparatorsCount || 0,
      duplicates,
      beginningReached: this.beginningReached,
      endReason: this.endReason,
      direction,
      checksIncomplete,
      diagnosticsError,
      sanityCheck: {
        correctedCount: names.changed,
        warnings,
        myName: names.myName,
        contactName: names.contactName,
        participants: toList(names.participants)
      },
      hasWarning: noOverlapEventsCount > 0 || warnings.length > 0 || checksIncomplete,
      warningMessage: noOverlapEventsCount > 0
        ? 'Some messages may be missing, rescan recommended (snapshot gap detected).'
        : (warnings[0] || (checksIncomplete ? 'Some checks could not run' : null))
    };

    try {
      debugLog('Scan completed', { total: masterList.length, startDate, endDate, direction: toList(direction.comboUsed) });
    } catch (_) {}

    return {
      messages: masterList,
      chatName: this.chatName,
      platform: adapter.name,
      chatType,
      isPartial: !this.beginningReached,
      dateRange: { start: startDate, end: endDate },
      oldestTimestamp: startDate,
      integrity
    };
  }

  _iso(d) { return d ? new Date(d).toISOString() : null; }

  cancel() {
    super.cancel();
    this.stopWatching();
    this.state = 'cancelled';
  }
}

export function createSession(onEvent, env) {
  return new ScanSession(onEvent, env);
}

/**
 * Backwards-compatible wrapper that runs loadHistory() followed by startReading().
 * Note: The side panel uses the two-step protocol (LOAD_HISTORY -> ready -> START_READING).
 * @param {(payload: Object) => void} [onProgress]
 * @returns {ScanSession}
 */
export function startScan(onProgress) {
  const session = new ScanSession(onProgress);
  session.promise = (async () => {
    await session.loadHistory();
    return session.startReading();
  })();
  return session;
}

/**
 * Verification pass: scrolls up sample distance and checks that visible messages
 * are present in masterList in the same relative order.
 * @param {HTMLElement} container
 * @param {Object[]} masterList
 * @returns {Promise<{ ok: boolean, sampledCount: number, matchedCount: number, error?: string }>}
 */
export async function verifyScan(container, masterList) {
  if (!container || !masterList || masterList.length === 0) {
    return { ok: false, error: 'No scan data to verify.' };
  }

  const adapter = getAdapter(window.location.href);
  if (!adapter) return { ok: false, error: 'No adapter.' };

  const currentScroll = container.scrollTop;
  // Scroll up ~20% of scrollHeight to sample earlier visible rows
  const sampleTarget = Math.max(0, currentScroll - Math.floor(container.clientHeight * 2));
  container.scrollTop = sampleTarget;
  container.dispatchEvent(new Event('scroll', { bubbles: true }));

  await new Promise(r => setTimeout(r, 400));
  const sample = adapter.extractMessages(document);

  if (!sample || sample.length === 0) {
    return { ok: true, sampledCount: 0, matchedCount: 0, message: 'No messages in sampled view.' };
  }

  let matched = 0;
  for (const s of sample) {
    const exists = masterList.some(m => isRowMatch(m, s));
    if (exists) matched++;
  }

  // Restore scroll
  container.scrollTop = currentScroll;
  container.dispatchEvent(new Event('scroll', { bubbles: true }));

  const matchRatio = matched / sample.length;
  return {
    ok: matchRatio >= 0.9,
    sampledCount: sample.length,
    matchedCount: matched,
    matchRatio: Math.round(matchRatio * 100),
    message: matchRatio >= 0.9
      ? `Verification passed: ${matched}/${sample.length} sampled messages confirmed in transcript.`
      : `Verification warning: ${matched}/${sample.length} messages matched.`
  };
}

/**
 * Post-scan participant sanity check & automatic correction.
 * - Sanitizes all sender names and maps localized "You" to myName.
 * - In one-to-one chats, enforces exactly 2 participants (me & contact).
 * - In group chats, merges case/whitespace variants.
 * - Flags anomalies: 1-to-1 with >2 senders, <3 messages in 100+ message chat, or time-pattern senders.
 * @param {Object[]} messages
 * @param {{ platform?: string, chatType?: 'one-to-one'|'group', chatName?: string, myName?: string|null }} [options={}]
 * @returns {{ correctedCount: number, warnings: string[], myName: string, contactName: string|null, participants: string[] }}
 */
export function runParticipantSanityCheck(messages, options = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { correctedCount: 0, warnings: [], myName: options.myName || 'Me', contactName: null, participants: [] };
  }

  const chatType = options.chatType || 'one-to-one';
  const rawChatName = options.chatName && !/^(?:WhatsApp chat|Messenger chat|Unknown Chat|Chat)$/i.test(options.chatName)
    ? options.chatName
    : null;

  // 1. Detect raw anomalies before correction
  const rawSenders = new Set();
  let hadTimeSender = false;
  for (const m of messages) {
    if (m.type === 'system') continue;
    const s = (m.sender || '').trim();
    if (s) rawSenders.add(s);
    if (isTimeOrDateString(s)) hadTimeSender = true;
  }

  // 2. Determine myName (from options, or most frequent outgoing non-"You" sender)
  let myName = options.myName ? sanitizeSenderName(options.myName) : null;
  if (!myName) {
    const outCounts = {};
    for (const m of messages) {
      if (m.type === 'system') continue;
      if (m.isMe || m.isOutgoing) {
        const clean = sanitizeSenderName(m.sender);
        if (clean && !isLocalizedYou(clean)) {
          outCounts[clean] = (outCounts[clean] || 0) + 1;
        }
      }
    }
    myName = Object.entries(outCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Me';
  }

  // 3. Determine contactName for 1-to-1 chats
  let contactName = rawChatName ? sanitizeSenderName(rawChatName) : null;
  if (chatType === 'one-to-one' && !contactName) {
    const inCounts = {};
    for (const m of messages) {
      if (m.type === 'system') continue;
      if (!m.isMe && !m.isOutgoing) {
        const clean = sanitizeSenderName(m.sender, { myName });
        if (clean && clean !== myName) {
          inCounts[clean] = (inCounts[clean] || 0) + 1;
        }
      }
    }
    contactName = Object.entries(inCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Contact';
  }

  // 4. Normalize & enforce
  let correctedCount = 0;
  const canonicalGroupNames = new Map(); // lowercase collapsed -> canonical display name

  for (const m of messages) {
    if (m.type === 'system') {
      m.sender = 'System';
      continue;
    }

    const original = m.sender;
    const isOut = !!(m.isMe || m.isOutgoing);
    let clean = sanitizeSenderName(original, { myName });

    if (chatType === 'one-to-one') {
      const target = isOut ? myName : (contactName || 'Contact');
      if (!clean || clean !== target) {
        clean = target;
      }
    } else {
      if (!clean) {
        clean = isOut ? myName : 'Contact';
      } else {
        const key = clean.toLowerCase().replace(/\s+/g, ' ');
        if (!canonicalGroupNames.has(key)) {
          canonicalGroupNames.set(key, clean);
        }
        clean = canonicalGroupNames.get(key);
      }
    }

    if (clean !== original) {
      m.sender = clean;
      if (m.fingerprint) m.fingerprint.sender = clean;
      correctedCount++;
    }
  }

  // 5. Post-correction checks & warnings
  const finalCounts = {};
  for (const m of messages) {
    if (m.type === 'system') continue;
    finalCounts[m.sender] = (finalCounts[m.sender] || 0) + 1;
  }

  const warnings = [];
  if (hadTimeSender) {
    warnings.push('Detected and corrected timestamp-like sender names.');
  }
  if (chatType === 'one-to-one' && rawSenders.size > 2) {
    warnings.push(`One-to-one chat had ${rawSenders.size} raw sender labels; normalized to ${Object.keys(finalCounts).length} participants.`);
  }
  if (messages.length >= 100) {
    for (const [name, cnt] of Object.entries(finalCounts)) {
      if (cnt < 3) {
        warnings.push(`Participant "${name}" has only ${cnt} message(s) in a ${messages.length}-message chat.`);
      }
    }
  }

  return {
    correctedCount,
    warnings,
    myName,
    contactName,
    participants: Object.keys(finalCounts)
  };
}
