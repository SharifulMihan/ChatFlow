import assert from 'assert';
import {
  geometryVote, nameVote,
  resolveDirection, finalizeSenders, evaluateConfidence,
  swapSides, applySideChoice, sampleSides, quickDirectionCheck,
  toList, formatDirectionDiagnostics
} from '../content/direction.js';
import { WhatsAppAdapter } from '../content/adapters/whatsapp.js';
import { ScanSession, mergeSnapshot, appendDeduplicated, abortableSleep } from '../content/scanner.js';

let passed = 0, failed = 0;
const pending = [];
function test(name, fn) {
  const run = async () => {
    try { await fn(); console.log(`  ✓ ${name}`); passed++; }
    catch (e) { console.error(`  ✗ ${name}: ${e.message}`); failed++; }
  };
  pending.push(run);
}

// ── Mock DOM rows (adapter level) ───────────────────────────────────────────
const PANE = { left: 0, right: 400, width: 400, top: 0, bottom: 800, height: 800 };
global.getComputedStyle = (node) => ({ backgroundColor: node.__bg || 'rgba(0, 0, 0, 0)' });

function mockRow({ i, mine, cls = true, rect = true, ticks = true, bg = true, dataIdPrefix = true }) {
  const bubble = {
    __bg: bg ? (mine ? 'rgb(217, 253, 211)' : 'rgb(255, 255, 255)') : 'rgba(0, 0, 0, 0)',
    parentElement: null,
    getBoundingClientRect: () => mine
      ? { left: 190, right: 390, width: 200 }
      : { left: 10, right: 210, width: 200 }
  };
  const row = {
    nodeType: 1,
    __bg: 'rgba(0, 0, 0, 0)',
    classList: { contains: c => cls && c === (mine ? 'message-out' : 'message-in') },
    closest: () => null,
    getAttribute: k => (k === 'data-id' ? `${dataIdPrefix ? (mine ? 'true' : 'false') : 'x'}_${i}` : null),
    getBoundingClientRect: () => ({ left: 0, right: 400, width: 400 }),
    querySelector(sel) {
      if (sel.includes('msg-container')) return rect || bg ? bubble : null;
      if (sel === '.message-out') return null;
      if (sel === '.message-in') return null;
      if (sel === '[data-testid="msg-meta"]') return { };
      if (sel.includes('msg-check') || sel.includes('msg-time')) return ticks && mine ? {} : null;
      return null;
    },
    querySelectorAll: () => []
  };
  if (!rect) bubble.getBoundingClientRect = () => ({ left: 0, right: 400, width: 400 });
  return row;
}

const wa = new WhatsAppAdapter();
function messagesFromRows(opts) {
  const ctx = { chatName: 'Raj', chatType: 'one-to-one', myName: null, paneRect: PANE };
  const out = [];
  for (let i = 0; i < 80; i++) {
    const mine = i % 3 === 0 ? true : (i % 3 === 1 ? false : i % 2 === 0); // roughly balanced
    const row = mockRow({ i, mine, ...opts(mine, i) });
    const raw = mine ? 'S.I.MiHAN' : 'Raj';
    const dirVotes = wa.collectDirectionVotes(row, row.getAttribute('data-id'), opts(mine, i).nameOff ? '' : raw, ctx);
    out.push({
      id: `m${i}`, truth: mine, type: 'text', text: `msg ${i}`, timestamp: `2026-01-11T10:${String(i % 60).padStart(2, '0')}:00.000Z`,
      sender: 'Raj', senderRaw: raw, isMe: false, dirVotes
    });
  }
  return out;
}
const accuracy = (msgs) => msgs.filter(m => m.isMe === m.truth).length / msgs.length;
const CTX = { chatType: 'one-to-one', chatName: 'Raj', myName: 'S.I.MiHAN' };

console.log('=== A. Signal helpers ===');
test('geometry: right half = me, left half = contact, full-width = no opinion', () => {
  assert.strictEqual(geometryVote({ left: 250, width: 140 }, PANE), true);
  assert.strictEqual(geometryVote({ left: 10, width: 140 }, PANE), false);
  assert.strictEqual(geometryVote({ left: 0, width: 400 }, PANE), null);
});
test('name vote: You/profile => me, chat name => contact, others => no opinion', () => {
  assert.strictEqual(nameVote('You', {}), true);
  assert.strictEqual(nameVote('S.I.MiHAN', { myName: 'S.I.MiHAN' }), true);
  assert.strictEqual(nameVote('Raj', { chatName: 'Raj', myName: 'S.I.MiHAN' }), false);
  assert.strictEqual(nameVote('1:22 AM', { chatName: 'Raj' }), null);
});
test('reply-quote labels are not signals (no quote data enters the votes)', () => {
  const row = mockRow({ i: 1, mine: false });
  const v = wa.collectDirectionVotes(row, 'false_1', '', { chatName: 'Raj', paneRect: PANE });
  assert.ok(!('quote' in v));
});

console.log('\n=== B. Mocked rows: one signal at a time ===');
test('classes missing (geometry + ticks + colour + name carry it)', () => {
  const msgs = messagesFromRows(() => ({ cls: false, dataIdPrefix: false }));
  const r = resolveDirection(msgs, CTX);
  assert.ok(!r.lowConfidence);
  assert.strictEqual(accuracy(msgs), 1);
});
test('geometry only', () => {
  const msgs = messagesFromRows(() => ({ cls: false, dataIdPrefix: false, ticks: false, bg: false, nameOff: true }));
  // ticks:false => no tick icon, but meta exists => tick vote false for all; drop it to isolate geometry
  msgs.forEach(m => { m.dirVotes.ticks = null; });
  const r = resolveDirection(msgs, CTX);
  assert.ok(!r.lowConfidence, r.reason);
  assert.strictEqual(accuracy(msgs), 1);
  assert.ok(r.counts.me > 0 && r.counts.contact > 0);
});
test('ticks only', () => {
  const msgs = messagesFromRows(() => ({ cls: false, dataIdPrefix: false, rect: false, bg: false, nameOff: true }));
  msgs.forEach(m => { m.dirVotes.geometry = null; });
  const r = resolveDirection(msgs, CTX);
  assert.ok(!r.lowConfidence, r.reason);
  assert.strictEqual(accuracy(msgs), 1);
});
test('colour only: split is found, but orientation is unverified => low confidence (asks the user)', () => {
  const msgs = messagesFromRows(() => ({ cls: false, dataIdPrefix: false, ticks: false, nameOff: true }));
  msgs.forEach(m => { m.dirVotes.ticks = null; m.dirVotes.geometry = null; m.dirVotes.name = null; });
  const r = resolveDirection(msgs, CTX);
  const acc = accuracy(msgs);
  assert.ok(acc === 1 || acc === 0, 'two clean groups (maybe swapped)');
  assert.ok(r.counts.me > 0 && r.counts.contact > 0);
  assert.strictEqual(r.lowConfidence, true);
  assert.strictEqual(r.reason, 'orientation_unverified');
});
test('conflicting signals: wrong class on every row is out-voted by geometry+ticks+colour+name', () => {
  const msgs = messagesFromRows(() => ({}));
  msgs.forEach(m => { m.dirVotes.class = false; }); // class says "message-in" everywhere
  const r = resolveDirection(msgs, CTX);
  assert.ok(!r.lowConfidence);
  assert.strictEqual(accuracy(msgs), 1);
  assert.ok(r.log.some(l => l.includes('"class" disagrees')), 'disagreement is logged');
});
test('conflict with a tie: falls back to alternative combination (drop class)', () => {
  const msgs = messagesFromRows(() => ({ ticks: false, bg: false, nameOff: true }));
  msgs.forEach(m => { m.dirVotes.ticks = null; m.dirVotes.class = false; });
  const r = resolveDirection(msgs, CTX);
  assert.ok(!r.lowConfidence, r.reason);
  assert.ok(Array.isArray(r.comboUsed), 'comboUsed is ALWAYS an array of strings');
  assert.ok(!r.comboUsed.includes('class'), 'class signal was dropped');
  assert.strictEqual(accuracy(msgs), 1);
  assert.ok(r.tried.length >= 2);
});
test('ALL rows return message-in => low-confidence path, never silent 100% one sender', () => {
  const msgs = [];
  for (let i = 0; i < 120; i++) {
    msgs.push({ id: `a${i}`, type: 'text', text: 't', timestamp: '2026-01-11T10:00:00.000Z', sender: 'Raj', senderRaw: 'Raj',
      isMe: false, dirVotes: { class: false, geometry: null, ticks: null, name: false } });
  }
  const r = resolveDirection(msgs, CTX);
  assert.strictEqual(r.lowConfidence, true);
  assert.ok(['one_side_empty', 'one_side_dominates'].includes(r.reason));
  assert.strictEqual(evaluateConfidence(msgs, 'one-to-one').low, true);
  assert.strictEqual(quickDirectionCheck(msgs, 'one-to-one').low, true);
});
test('short chat (<50 messages) is not flagged just for being one-sided', () => {
  const msgs = Array.from({ length: 20 }, (_, _i) => ({ type: 'text', isMe: false, dirVotes: { class: false } }));
  assert.strictEqual(resolveDirection(msgs, CTX).lowConfidence, false);
});

console.log('\n=== C. Names are cosmetic: direction decides ===');
test('bug case: every senderRaw is "Raj" but geometry splits => still exactly 2 participants', () => {
  const msgs = messagesFromRows(() => ({ cls: false, dataIdPrefix: false, ticks: false, bg: false }));
  msgs.forEach(m => { m.senderRaw = 'Raj'; m.dirVotes.name = false; m.dirVotes.ticks = null; });
  // geometry (1.0) vs name (1.0) tie on my rows => drop to alternative combos
  const r = resolveDirection(msgs, { ...CTX, myName: null });
  finalizeSenders(msgs, { chatType: 'one-to-one', chatName: 'Raj', profileName: 'S.I.MiHAN' });
  const names = new Set(msgs.map(m => m.sender));
  assert.deepStrictEqual([...names].sort(), ['Raj', 'S.I.MiHAN']);
  assert.ok(msgs.every(m => (m.sender === 'S.I.MiHAN') === m.isMe));
  assert.ok(!r.lowConfidence, r.reason);
});
test('"You", times and colons never become names; my name is never "You"', () => {
  const msgs = [
    { type: 'text', isMe: true, senderRaw: 'You::', sender: 'You::' },
    { type: 'text', isMe: true, senderRaw: '1:22 AM', sender: '1:22 AM' },
    { type: 'text', isMe: false, senderRaw: 'Raj::', sender: 'Raj::' }
  ];
  const r = finalizeSenders(msgs, { chatType: 'one-to-one', chatName: 'Raj' });
  assert.notStrictEqual(r.myName, 'You');
  assert.ok(!/\d:\d/.test(r.myName));
  assert.deepStrictEqual(r.participants.sort(), [r.myName, 'Raj'].sort());
});
test('"My name in exports" override wins', () => {
  const msgs = [{ type: 'text', isMe: true, senderRaw: 'You' }, { type: 'text', isMe: false, senderRaw: 'Raj' }];
  const r = finalizeSenders(msgs, { chatType: 'one-to-one', chatName: 'Raj', myNameOverride: 'Mihan' });
  assert.strictEqual(msgs[0].sender, 'Mihan');
  assert.strictEqual(r.myName, 'Mihan');
});
test('group chat keeps real names, merges case/space variants, maps me by direction', () => {
  const msgs = [
    { type: 'text', isMe: true, senderRaw: 'You' },
    { type: 'text', isMe: false, senderRaw: 'Ana  Lopez' },
    { type: 'text', isMe: false, senderRaw: 'ana lopez' },
    { type: 'text', isMe: false, senderRaw: 'Bo' }
  ];
  const r = finalizeSenders(msgs, { chatType: 'group', chatName: 'Team', profileName: 'Mihan' });
  assert.strictEqual(r.participants.length, 3);
});

console.log('\n=== D. Swap / Confirm dialog ===');
test('swap sides flips everything in memory; sample bubbles offered per side', () => {
  const msgs = messagesFromRows(() => ({}));
  resolveDirection(msgs, CTX);
  const before = msgs.filter(m => m.isMe).length;
  const samples = sampleSides(msgs, 3);
  assert.strictEqual(samples.left.length, 3);
  assert.strictEqual(samples.right.length, 3);
  assert.ok(samples.right[0].text && 'timestamp' in samples.right[0]);
  swapSides(msgs);
  assert.strictEqual(msgs.filter(m => m.isMe).length, msgs.length - before);
});
test('"Left side is me" / "Right side is me" apply to all messages', () => {
  const msgs = messagesFromRows(() => ({}));
  resolveDirection(msgs, CTX);
  applySideChoice(msgs, 'left');
  assert.ok(msgs.every(m => m.isMe === (m.side === 'left')));
  applySideChoice(msgs, 'right');
  assert.ok(msgs.every(m => m.isMe === (m.side === 'right')));
});

console.log('\n=== E. Phase machine (mock page): counter 0 in Phase 1, Phase 2 counts, Ready is passive ===');

function makePage({ total = 120, stall = false, beginning = false }) {
  // A fake chat page: rows are revealed from the bottom up when loadMore() is called
  let loaded = 60;
  const events = [];
  let scrollWrites = 0, clicks = 0;
  const makeMsg = (i) => ({
    id: `id${i}`, domId: `id${i}`, type: 'text', text: `message ${i}`,
    timestamp: new Date(2026, 0, 1, 10, i % 60).toISOString(), sender: 'x', senderRaw: i % 2 ? 'S.I.MiHAN' : 'Raj',
    isMe: i % 2 === 1, isOutgoing: i % 2 === 1, reactions: [],
    dirVotes: { class: i % 2 === 1, geometry: i % 2 === 1, ticks: null, name: null }
  });
  const container = {
    _top: 0, scrollHeight: 6000, clientHeight: 600,
    get scrollTop() { return this._top; },
    set scrollTop(v) { scrollWrites++; this._top = Math.max(0, Math.min(v, this.scrollHeight - this.clientHeight)); },
    dispatchEvent() {}
  };
  const adapter = {
    name: 'WhatsApp', promptClickCount: 0, rejectedSeparatorsCount: 0,
    healthCheck: () => ({ ok: true, results: [] }),
    getScrollContainer: () => container,
    getChatName: () => 'Raj',
    detectChatType: () => 'one-to-one',
    detectMyProfileName: () => 'S.I.MiHAN',
    resetSessionDates() {},
    peekOldestDate: () => new Date(2026, 0, 1),
    hasReachedTop: () => (beginning && loaded >= total) ? { reached: true, reason: 'whatsapp_encryption_notice' } : { reached: false },
    async scrollToLoadOlder() {
      if (!stall && loaded < total) { loaded = Math.min(total, loaded + 30); container.scrollHeight += 1000; }
      clicks++;
      return { newMessagesFound: true };
    },
    hasReachedBottom: (c) => ({ reached: c.scrollTop + c.clientHeight >= c.scrollHeight - 6 }),
    extractMessages() {
      // reveal everything loaded (simple model: the whole loaded list is in the DOM)
      return Array.from({ length: loaded }, (_, k) => makeMsg(total - loaded + k));
    }
  };
  return { adapter, container, events, counters: () => ({ scrollWrites, clicks }) };
}

// Make the mock environment tolerate browser-only globals used by the session
global.Event = global.Event || class {};
global.MutationObserver = class { observe() {} disconnect() {} };
global.window = global.window || { location: { href: 'https://web.whatsapp.com/' } };
global.document = global.document || { querySelector: () => null };

test('Phase 1 emits NO message counts; ends in Ready (never auto-starts Phase 2) when history loads fully', async () => {
  const page = makePage({ total: 120, beginning: true });
  const events = [];
  const s = new ScanSession(e => events.push(e), { adapter: page.adapter, container: page.container, doc: { querySelector: () => null } });
  const info = await s.loadHistory();
  assert.strictEqual(info.beginningReached, true);
  assert.strictEqual(s.state, 'ready');
  assert.ok(events.filter(e => e.phase === 'loading').every(e => e.count === undefined), 'no count in Phase 1');
  assert.ok(!events.some(e => e.phase === 'reading'), 'Phase 2 must not start by itself');
});
test('Stalled history (phone offline): Ready with partial state; nothing moves until Start scan', async () => {
  const page = makePage({ total: 120, stall: true });
  const s = new ScanSession(() => {}, { adapter: page.adapter, container: page.container, doc: { querySelector: () => null } });
  // shrink stall window for the test by faking Date.now
  const realNow = Date.now; let t = realNow();
  Date.now = () => (t += 2500); // each call advances 2.5s => stall after a few loops
  let info;
  try { info = await s.loadHistory(); } finally { Date.now = realNow; }
  assert.strictEqual(info.beginningReached, false);
  assert.strictEqual(info.stalled, true);
  assert.strictEqual(s.state, 'ready');
  const before = page.counters();
  await new Promise(r => setTimeout(r, 120));
  assert.deepStrictEqual(page.counters(), before, 'passive in Ready: no scrolling or clicking');
});
test('Stop loading ends Phase 1 at Ready, not counting', async () => {
  const page = makePage({ total: 400 });
  const events = [];
  const s = new ScanSession(e => events.push(e), { adapter: page.adapter, container: page.container, doc: { querySelector: () => null } });
  const p = s.loadHistory();
  setTimeout(() => s.stopLoading(), 30);
  const info = await p;
  assert.strictEqual(s.state, 'ready');
  assert.strictEqual(info.reason, 'user_stop');
  assert.ok(!events.some(e => e.phase === 'reading'));
});
test('Start scan: counter starts at 0, is monotonic, final total == last counter == exported list', async () => {
  const page = makePage({ total: 120, beginning: true });
  const events = [];
  const s = new ScanSession(e => events.push(e), { adapter: page.adapter, container: page.container, doc: { querySelector: () => null } });
  await s.loadHistory();
  const result = await s.startReading({});
  const reading = events.filter(e => e.phase === 'reading');
  assert.strictEqual(reading[0].count, 0, 'Phase 2 counter starts at 0');
  for (let i = 1; i < reading.length; i++) assert.ok(reading[i].count >= reading[i - 1].count, 'monotonic');
  const percents = reading.map(e => e.percent);
  for (let i = 1; i < percents.length; i++) assert.ok(percents[i] >= percents[i - 1], 'progress monotonic');
  assert.strictEqual(reading[reading.length - 1].count, result.messages.length);
  assert.strictEqual(result.integrity.totalMessages, result.messages.length);
  assert.strictEqual(result.isPartial, false);
  assert.deepStrictEqual(Object.keys(result.integrity.senderCounts).sort(), ['Raj', 'S.I.MiHAN']);
});
test('Partial history: result is flagged partial (export adds the "Partial export" note)', async () => {
  const page = makePage({ total: 120, beginning: false });
  const s = new ScanSession(() => {}, { adapter: page.adapter, container: page.container, doc: { querySelector: () => null } });
  s.beginningReached = false; s.state = 'ready';
  const result = await s.startReading({});
  assert.strictEqual(result.isPartial, true);
  assert.ok(result.oldestTimestamp);
});
test('Cancel discards everything', async () => {
  const page = makePage({ total: 400 });
  const s = new ScanSession(() => {}, { adapter: page.adapter, container: page.container, doc: { querySelector: () => null } });
  const p = s.loadHistory();
  setTimeout(() => s.cancel(), 20);
  await assert.rejects(p, /CANCELLED/);
});

console.log('\n=== F. Bug 1 & Bug 2 regression tests (comboUsed / toList & AbortController 10s wait) ===');
test('BUG 1: toList and formatDirectionDiagnostics handle array, string, Set, undefined, number, and plain object', () => {
  assert.deepStrictEqual(toList(['class', 'geometry']), ['class', 'geometry']);
  assert.deepStrictEqual(toList('all'), ['all']);
  assert.deepStrictEqual(toList(''), []);
  assert.deepStrictEqual(toList(new Set(['geometry', 'ticks'])), ['geometry', 'ticks']);
  assert.deepStrictEqual(toList(undefined), []);
  assert.deepStrictEqual(toList(null), []);
  assert.deepStrictEqual(toList(42), []);
  assert.deepStrictEqual(toList({ class: true, ticks: true }), ['class', 'ticks']);

  const variants = [
    ['class', 'geometry'],
    'all',
    new Set(['geometry', 'ticks']),
    undefined,
    null,
    123,
    { geometry: 1, color: 1 }
  ];
  for (const v of variants) {
    const out = formatDirectionDiagnostics({
      chatType: 'one-to-one',
      detectedMyName: 'S.I.MiHAN',
      direction: {
        comboUsed: v,
        tried: v,
        lowConfidence: false,
        reason: 'ok',
        meCount: 10,
        themCount: 12
      }
    });
    assert.ok(typeof out === 'string' && out.includes('Direction combo:'));
  }

  const msgs = messagesFromRows(() => ({}));
  const res = resolveDirection(msgs, CTX);
  assert.ok(Array.isArray(res.comboUsed), 'resolveDirection.comboUsed must always be an Array');
  assert.ok(res.comboUsed.every(s => typeof s === 'string'), 'every element in comboUsed must be a string');
});

test('BUG 2: Stop loading aborts a loop stuck in a 10-second wait in under 500 ms and enters Ready', async () => {
  const page = makePage({ total: 400 });
  page.adapter.scrollToLoadOlder = async (_container, _doc, _onProgress, ctrl) => {
    // Simulate a stalled 10-second wait inside the adapter (e.g. phone sync or network stall)
    await abortableSleep(10000, ctrl?.signal, ctrl);
    return { newMessagesFound: false, atTop: false };
  };
  const events = [];
  const s = new ScanSession(e => events.push(e), {
    adapter: page.adapter,
    container: page.container,
    doc: { querySelector: () => null }
  });

  const t0 = Date.now();
  const loadPromise = s.loadHistory();
  setTimeout(() => {
    const snap = s.stopLoading();
    assert.strictEqual(snap.status, 'phase1_stopped');
    assert.strictEqual(s.state, 'ready');
  }, 50);

  const info = await loadPromise;
  const elapsedMs = Date.now() - t0;
  assert.ok(elapsedMs < 500, `Expected stopLoading to abort 10s wait in <500ms, took ${elapsedMs}ms`);
  assert.strictEqual(s.state, 'ready');
  assert.strictEqual(info.reason, 'user_stop');
  assert.strictEqual(info.beginningReached, false);
  assert.ok(events.some(e => e.phase === 'ready'), 'Ready event emitted');
  assert.ok(!events.some(e => e.phase === 'reading'), 'Never starts counting on Stop loading');
});

test('BUG 2: Cancel aborts a loop stuck in a 10-second wait in under 500 ms', async () => {
  const page = makePage({ total: 400 });
  page.adapter.scrollToLoadOlder = async (_container, _doc, _onProgress, ctrl) => {
    await abortableSleep(10000, ctrl?.signal, ctrl);
    return { newMessagesFound: false, atTop: false };
  };
  const s = new ScanSession(() => {}, {
    adapter: page.adapter,
    container: page.container,
    doc: { querySelector: () => null }
  });

  const t0 = Date.now();
  const loadPromise = s.loadHistory();
  setTimeout(() => s.cancel(), 50);

  await assert.rejects(loadPromise, /CANCELLED/);
  const elapsedMs = Date.now() - t0;
  assert.ok(elapsedMs < 500, `Expected cancel to abort 10s wait in <500ms, took ${elapsedMs}ms`);
  assert.strictEqual(s.state, 'cancelled');
});

test('BUG 3: mergeSnapshot handles virtualized DOM non-contiguous / interior anchor overlap and deduplicates fallback', () => {
  const mk = (id, text = `msg ${id}`) => ({ id: `id_${id}`, domId: `dom_${id}`, type: 'text', text, sender: 'Raj', isMe: false });
  const master = [mk(1), mk(2), mk(3), mk(4), mk(5)];

  // Case 1: Backtrack or virtualized buffer where snapshot starts earlier (dom_2) and drops dom_4 (lazy-rendered), then adds dom_6, dom_7
  const snap1 = [mk(2), mk(3), mk(5), mk(6), mk(7)];
  const r1 = mergeSnapshot(master, snap1);
  assert.ok(r1.overlap > 0, 'Interior/subsequence anchor overlap should succeed');
  assert.strictEqual(r1.appended, 2);
  assert.deepStrictEqual(master.map(m => m.domId), ['dom_1', 'dom_2', 'dom_3', 'dom_4', 'dom_5', 'dom_6', 'dom_7']);

  // Case 2: Deduplicated append never duplicates already-seen domIds
  const added = appendDeduplicated(master, [mk(5), mk(6), mk(7), mk(8)]);
  assert.strictEqual(added, 1);
  assert.deepStrictEqual(master.map(m => m.domId), ['dom_1', 'dom_2', 'dom_3', 'dom_4', 'dom_5', 'dom_6', 'dom_7', 'dom_8']);
});

(async () => {
  for (const run of pending) await run();
  console.log(`\n=============================================`);
  console.log(`TOTAL TESTS: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
  process.exit(failed ? 1 : 0);
})();

