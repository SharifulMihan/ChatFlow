/**
 * scratch/test_messenger_bugreport.js
 * Comprehensive verification suite for Messenger bug-report Parts 1-7:
 *  - classifyRow() across all supplied & mocked row fixtures
 *  - UNRECOGNIZED capture & "[Unrecognized message]" emission
 *  - Sender & direction attribution across all 7 required message types
 *  - Date & weekday resolution ("Thu 5:12 PM" relative to scan date) + non-decreasing validation
 *  - Overlap merge with identical repeated short messages, gap backtracking, virtualized DOM
 *  - Two-pass verification reconciliation
 *  - Grouping within 5 minutes, unique month headings, clean media/reaction/unrecognized exports
 */

import assert from 'node:assert/strict';
import { MessengerAdapter } from '../content/adapters/messenger.js';
import {
  parseDateSeparatorText,
  extractValidReactions,
  isReactionOnly
} from '../content/selectors.js';
import { resolveDirection, finalizeSenders } from '../content/direction.js';
import {
  mergeSnapshot,
  reconcileVerificationPass,
  ScanSession
} from '../content/scanner.js';
import {
  prepareMessagesForExport,
  groupMessagesForExport
} from '../lib/transcript.js';
import { buildDocxDocument } from '../lib/exporter-docx.js';
import { buildTxtContent } from '../lib/exporter-txt.js';
import { buildPdfHtml } from '../lib/exporter-pdf.js';
import { createRequire } from 'node:module';
import {
  ROW_FIXTURES,
  createMockPane,
  parseHtmlElement
} from '../fixtures/messenger_samples.js';

const require = createRequire(import.meta.url);
let docx = null;
try { docx = require('../lib/docx.umd.js'); } catch (_) {}

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ FAIL: ${name}\n    ${err?.stack || err}`);
    failed++;
  }
}

const SCAN_DATE_NOV_13_FRI = new Date(2026, 10, 13, 19, 5, 0); // Fri Nov 13, 2026

console.log('\n=== PART 1 & 2: classifyRow() & Fixture Classification ===');

await test('Missed contact row HTML structure ("Cp boss esob ki bole") is extracted with left direction and stripped label', () => {
  const adapter = new MessengerAdapter();
  adapter.resetSessionDates();
  const { container } = createMockPane([ROW_FIXTURES.missedContactText]);
  const rows = adapter.enumerateCandidateRows(container);
  assert.equal(rows.length, 1);

  const cls = adapter.classifyRow(rows[0], {
    container,
    chatName: 'Sudipta Roy',
    dateCursor: new Date(2026, 9, 22, 14, 0, 0)
  });
  assert.equal(cls.kind, 'message');
  assert.equal(cls.msg.type, 'text');
  assert.equal(cls.msg.text, 'Cp boss esob ki bole');
  assert.equal(cls.msg.isMe, false, 'missed contact row must attribute to contact (left geometry + avatar + hidden label)');
  assert.ok(cls.msg.reactions.some(r => r.includes('😂')));
  assert.ok(!cls.msg.text.includes('Sudipta sent'), 'hidden accessibility label stripped');
});

await test('Exported outgoing row HTML structure ("Dhaka gesos?") is extracted as my message', () => {
  const adapter = new MessengerAdapter();
  adapter.resetSessionDates();
  const { container } = createMockPane([ROW_FIXTURES.exportedMyText]);
  const rows = adapter.enumerateCandidateRows(container);
  const cls = adapter.classifyRow(rows[0], {
    container,
    chatName: 'Sudipta Roy',
    dateCursor: new Date(2026, 9, 22, 15, 19, 0)
  });
  assert.equal(cls.kind, 'message');
  assert.equal(cls.msg.text, 'Dhaka gesos?');
  assert.equal(cls.msg.isMe, true);
});

await test('Reply with video-thumbnail quote exports ONLY "Sei" by contact, never standalone "Video"', () => {
  const adapter = new MessengerAdapter();
  adapter.resetSessionDates();
  const { container } = createMockPane([ROW_FIXTURES.replyWithVideoThumbQuote]);
  const rows = adapter.enumerateCandidateRows(container);
  const cls = adapter.classifyRow(rows[0], { container, chatName: 'Sudipta Roy' });
  assert.equal(cls.kind, 'message');
  assert.equal(cls.msg.type, 'text', 'quoted video thumbnail must not hijack reply message type');
  assert.equal(cls.msg.text, 'Sei');
  assert.equal(cls.msg.isMe, false);
  assert.ok(cls.msg.replyTo, 'replyTo preserved');
  assert.equal(cls.msg.replyTo.sender, 'Me');
});

await test('Reply with text quote separates quoted text into replyTo without duplicating in body', () => {
  const adapter = new MessengerAdapter();
  adapter.resetSessionDates();
  const { container } = createMockPane([ROW_FIXTURES.replyWithTextQuote]);
  const rows = adapter.enumerateCandidateRows(container);
  const cls = adapter.classifyRow(rows[0], { container, chatName: 'Sudipta Roy' });
  assert.equal(cls.kind, 'message');
  assert.equal(cls.msg.text, 'Ek marar shathe arek mara');
  assert.equal(cls.msg.isMe, true);
  assert.equal(cls.msg.replyTo?.text, 'Valoi toh math er sathe toh cp er connection acei');
  assert.equal(cls.msg.replyTo?.sender, 'Sudipta');
});

await test('Contact photo (sketch) ignores avatar <img> and captures photo + real ❤️ reaction', () => {
  const adapter = new MessengerAdapter();
  adapter.resetSessionDates();
  const { container } = createMockPane([ROW_FIXTURES.contactPhoto]);
  const rows = adapter.enumerateCandidateRows(container);
  const cls = adapter.classifyRow(rows[0], { container, chatName: 'Sudipta Roy' });
  assert.equal(cls.kind, 'message');
  assert.equal(cls.msg.type, 'image');
  assert.equal(cls.msg.isMe, false);
  assert.ok(cls.msg.reactions.some(r => r.includes('❤️')));
});

await test('Outgoing video captures 0:05 duration and rejects duration chip from reactions', () => {
  const adapter = new MessengerAdapter();
  adapter.resetSessionDates();
  const { container } = createMockPane([ROW_FIXTURES.myVideo]);
  const rows = adapter.enumerateCandidateRows(container);
  const cls = adapter.classifyRow(rows[0], { container, chatName: 'Sudipta Roy' });
  assert.equal(cls.kind, 'message');
  assert.equal(cls.msg.type, 'video');
  assert.equal(cls.msg.duration, '0:05');
  assert.equal(cls.msg.isMe, true);
  assert.ok(cls.msg.reactions.some(r => r.includes('😂')));
  assert.ok(!cls.msg.reactions.includes('0:05'));
});

await test('Forwarded image is classified as image with forwarded=true and strips "Sudipta forwarded an image"', () => {
  const adapter = new MessengerAdapter();
  adapter.resetSessionDates();
  const { container } = createMockPane([ROW_FIXTURES.forwardedImage]);
  const rows = adapter.enumerateCandidateRows(container);
  const cls = adapter.classifyRow(rows[0], { container, chatName: 'Sudipta Roy' });
  assert.equal(cls.kind, 'message');
  assert.equal(cls.msg.type, 'image');
  assert.equal(cls.msg.forwarded, true);
  assert.equal(cls.msg.isMe, false);
  assert.ok(!cls.msg.text.includes('forwarded an image'));
});

await test('Reactions filter never accepts durations ("0:19") or "???"', () => {
  const adapter = new MessengerAdapter();
  adapter.resetSessionDates();
  const { container } = createMockPane([ROW_FIXTURES.reactionWithInvalidDuration]);
  const rows = adapter.enumerateCandidateRows(container);
  const cls = adapter.classifyRow(rows[0], { container, chatName: 'Sudipta Roy' });
  assert.equal(cls.kind, 'message');
  assert.ok(cls.msg.reactions.some(r => r.includes('❤️')));
  assert.ok(!cls.msg.reactions.some(r => r.includes('0:19') || r.includes('?')));
  assert.equal(isReactionOnly('0:19', rows[0]), false);
  assert.equal(isReactionOnly('???', rows[0]), false);
  assert.deepStrictEqual(extractValidReactions(['0:19', '???', '😂 2', '👍']), ['😂', '👍']);
});

await test('Hover timestamps, centered separators, avatar labels, and calls classify accurately', () => {
  const adapter = new MessengerAdapter();
  adapter.resetSessionDates();
  adapter.baseSessionDate = SCAN_DATE_NOV_13_FRI;

  const { container: c1 } = createMockPane([ROW_FIXTURES.hoverTimestamp]);
  const r1 = adapter.enumerateCandidateRows(c1)[0];
  const cls1 = adapter.classifyRow(r1, { container: c1, chatName: 'Sudipta Roy' });
  assert.ok(cls1.kind === 'separator' || cls1.kind === 'ui-noise', `hover timestamp kind=${cls1.kind}`);
  assert.notEqual(cls1.kind, 'message');

  const { container: c2 } = createMockPane([ROW_FIXTURES.avatarLabelOnly]);
  const r2 = adapter.enumerateCandidateRows(c2)[0];
  const cls2 = adapter.classifyRow(r2, { container: c2, chatName: 'Sudipta Roy' });
  assert.equal(cls2.kind, 'ui-noise', 'standalone avatar name "Sudipta" is ui-noise, never message');

  const { container: c3 } = createMockPane([ROW_FIXTURES.callRow]);
  const r3 = adapter.enumerateCandidateRows(c3)[0];
  const cls3 = adapter.classifyRow(r3, { container: c3, chatName: 'Sudipta Roy' });
  assert.equal(cls3.kind, 'message');
  assert.equal(cls3.msg.type, 'call');
  assert.equal(cls3.msg.isMe, false);
});

await test('UNRECOGNIZED row is never silently dropped: logged with <=2000 char outerHTML and emitted as [Unrecognized message]', () => {
  const adapter = new MessengerAdapter();
  adapter.resetSessionDates();
  const { doc, main, container } = createMockPane([
    ROW_FIXTURES.dateSepOct22,
    ROW_FIXTURES.unrecognizedWeirdRow
  ]);
  const msgs = adapter.extractMessages(doc);
  const audit = adapter.getAuditSnapshot();

  assert.equal(audit.unrecognizedCount, 1);
  assert.equal(audit.unrecognizedSamples.length, 1);
  assert.ok(audit.unrecognizedSamples[0].outerHTML.length <= 2000);
  assert.ok(audit.unrecognizedSamples[0].textPreview.includes('Custom Interactive Poll Card'));

  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].type, 'unrecognized');
  assert.ok(msgs[0].text.startsWith('[Unrecognized message]'));
  assert.ok(msgs[0].text.includes('Custom Interactive Poll Card #42'));
});

console.log('\n=== PART 3: Direction & Sender Detection Across All 7 Message Types ===');

await test('Direction self-check resolves all 7 message types accurately in 1-to-1 chat', () => {
  const adapter = new MessengerAdapter();
  adapter.resetSessionDates();
  adapter.baseSessionDate = SCAN_DATE_NOV_13_FRI;

  const { doc } = createMockPane([
    ROW_FIXTURES.dateSepOct22,
    ROW_FIXTURES.contactText,              // 1. contact text ("Ho")
    ROW_FIXTURES.myText,                   // 2. my text ("27 tarik preli")
    ROW_FIXTURES.contactPhoto,             // 3. contact photo
    ROW_FIXTURES.myVideo,                  // 4. my video
    ROW_FIXTURES.replyWithVideoThumbQuote, // 5. contact reply ("Sei")
    ROW_FIXTURES.replyWithTextQuote,       // 6. my reply ("Ek marar shathe arek mara")
    ROW_FIXTURES.contactLinkPost           // 7. contact link post
  ], 'Sudipta Roy');

  const extracted = adapter.extractMessages(doc);
  assert.equal(extracted.length, 7);

  const dir = resolveDirection(extracted, { chatType: 'one-to-one', chatName: 'Sudipta Roy', myName: 'Mihan' });
  assert.equal(dir.lowConfidence, false, `Expected high direction confidence, got reason=${dir.reason}`);

  finalizeSenders(extracted, { chatType: 'one-to-one', chatName: 'Sudipta Roy', profileName: 'Mihan' });
  const expected = [
    { text: 'Ho', isMe: false, sender: 'Sudipta Roy', type: 'text' },
    { text: '27 tarik preli', isMe: true, sender: 'Mihan', type: 'text' },
    { isMe: false, sender: 'Sudipta Roy', type: 'image' },
    { isMe: true, sender: 'Mihan', type: 'video', duration: '0:05' },
    { text: 'Sei', isMe: false, sender: 'Sudipta Roy', type: 'text' },
    { text: 'Ek marar shathe arek mara', isMe: true, sender: 'Mihan', type: 'text' },
    { isMe: false, sender: 'Sudipta Roy', type: 'link' }
  ];

  expected.forEach((exp, idx) => {
    assert.equal(extracted[idx].isMe, exp.isMe, `row ${idx} isMe`);
    assert.equal(extracted[idx].sender, exp.sender, `row ${idx} sender`);
    assert.equal(extracted[idx].type, exp.type, `row ${idx} type`);
    if (exp.text) assert.equal(extracted[idx].text, exp.text, `row ${idx} text`);
    if (exp.duration) assert.equal(extracted[idx].duration, exp.duration, `row ${idx} duration`);
  });
});

console.log('\n=== PART 4: Dates, Weekdays & Reading-Order Chronology ===');

await test('Weekday "Thu 5:12 PM" on Friday Nov 13, 2026 resolves to Thu Nov 12, 2026 (NOT Oct 22)', () => {
  const oct23Floor = new Date(2026, 9, 23, 15, 29, 0); // Fri Oct 23, 2026
  const resolved = parseDateSeparatorText('Thu 5:12 PM', 'MDY', oct23Floor, SCAN_DATE_NOV_13_FRI);
  assert.ok(resolved instanceof Date && !isNaN(resolved));
  assert.equal(resolved.getFullYear(), 2026);
  assert.equal(resolved.getMonth(), 10, 'Month 10 = November');
  assert.equal(resolved.getDate(), 12, 'Date 12 = Thu Nov 12');
  assert.equal(resolved.getHours(), 17);
  assert.equal(resolved.getMinutes(), 12);
});

await test('Snapshot extraction starts localDateCursor at null so Sep 4 from Snapshot 1 never leaks before Jun 10 in Snapshot 2', () => {
  const adapter = new MessengerAdapter();
  adapter.resetSessionDates();
  adapter.baseSessionDate = SCAN_DATE_NOV_13_FRI;

  // Snapshot 1 ends in September
  const snap1 = createMockPane([
    `<div role="row" data-rect="0,10,760,24"><h4 dir="auto" data-scope="date_break" data-rect="300,10,160,20">Sep 4, 2026, 4:16 AM</h4></div>`,
    ROW_FIXTURES.contactPhoto
  ]);
  const msgs1 = adapter.extractMessages(snap1.doc);
  assert.equal(msgs1.length, 1);

  // Snapshot 2 starts with pre-separator message above Jun 10 -> must NOT inherit Sep 4!
  const snap2 = createMockPane([
    ROW_FIXTURES.contactText,
    `<div role="row" data-rect="0,10,760,24"><h4 dir="auto" data-scope="date_break" data-rect="300,10,160,20">Jun 10, 2026, 1:32 AM</h4></div>`,
    ROW_FIXTURES.exportedMyText
  ]);
  const msgs2 = adapter.extractMessages(snap2.doc);
  assert.equal(msgs2[0].timestamp, null, 'pre-separator row starts null rather than inheriting Sep 4 across snapshots');
  assert.equal(new Date(msgs2[1].timestamp).getMonth(), 5, 'Jun = month index 5');
});

await test('_finalize enforces non-decreasing dates in reading order without re-sorting messages and logs violations', () => {
  const adapter = new MessengerAdapter();
  const s = new ScanSession(() => {}, { adapter, container: {}, doc: { querySelector: () => null } });
  const list = [
    { type: 'text', text: 'June msg', isMe: true, timestamp: '2026-06-10T01:32:00.000Z', dirVotes: { geometry: true } },
    { type: 'text', text: 'Aug msg', isMe: false, timestamp: '2026-08-13T10:13:00.000Z', dirVotes: { geometry: false } },
    // Backwards violation injected in DOM order:
    { type: 'text', text: 'Out-of-order date msg', isMe: false, timestamp: '2026-06-01T00:00:00.000Z', dirVotes: { geometry: false } },
    { type: 'text', text: 'Sept msg', isMe: true, timestamp: '2026-09-04T04:16:00.000Z', dirVotes: { geometry: true } }
  ];
  const res = s._finalize(list, {
    overlapMergesCount: 1,
    noOverlapEventsCount: 0,
    gapEvents: [],
    myNameOverride: 'Mihan',
    isWhatsApp: false
  });
  // Reading order must NOT be re-sorted!
  assert.deepStrictEqual(res.messages.map(m => m.text), ['June msg', 'Aug msg', 'Out-of-order date msg', 'Sept msg']);
  assert.equal(res.integrity.audit.dateOrderViolations.length, 1);
  assert.equal(res.messages[2].timestamp, '2026-08-13T10:13:00.000Z', 'backwards timestamp ignored in favor of runningDate');
});

console.log('\n=== PART 5 & 7.2: Overlap Merge, Repeated Short Messages, Gaps, Virtualized List & Pass 2 ===');

await test('Overlap merge preserves consecutive identical short messages ("Ho", "Ho", "Ho")', () => {
  const master = [
    { type: 'text', text: 'Start', isMe: true, sender: 'Mihan' },
    { type: 'text', text: 'Ho', isMe: false, sender: 'Sudipta Roy' },
    { type: 'text', text: 'Ho', isMe: false, sender: 'Sudipta Roy' }
  ];
  const snapshot = [
    { type: 'text', text: 'Ho', isMe: false, sender: 'Sudipta Roy' },
    { type: 'text', text: 'Ho', isMe: false, sender: 'Sudipta Roy' },
    { type: 'text', text: 'Ho', isMe: false, sender: 'Sudipta Roy' },
    { type: 'text', text: 'End', isMe: true, sender: 'Mihan' }
  ];
  const m = mergeSnapshot(master, snapshot);
  assert.equal(m.overlap, 2);
  assert.equal(master.map(x => x.text).join('|'), 'Start|Ho|Ho|Ho|End');
});

await test('reconcileVerificationPass recovers a message skipped by Pass 1 into its exact anchored reading position', () => {
  const pass1 = [
    { domId: 'm1', type: 'text', text: 'Valoi toh math er sathe toh cp er connection acei', isMe: false },
    // Pass 1 missed 'm2' ("Cp boss esob ki bole")!
    { domId: 'm3', type: 'image', text: '', isMe: false },
    { domId: 'm4', type: 'text', text: 'Dhaka gesos?', isMe: true },
    { domId: 'm5', type: 'text', text: 'Ho', isMe: false }
  ];
  const pass2 = [
    { domId: 'm1', type: 'text', text: 'Valoi toh math er sathe toh cp er connection acei', isMe: false },
    { domId: 'm2', type: 'text', text: 'Cp boss esob ki bole', isMe: false },
    { domId: 'm3', type: 'image', text: '', isMe: false },
    { domId: 'm4', type: 'text', text: 'Dhaka gesos?', isMe: true },
    { domId: 'm5', type: 'text', text: 'Ho', isMe: false }
  ];
  const rec = reconcileVerificationPass(pass1, pass2);
  assert.equal(rec.differencesCount, 1);
  assert.equal(rec.recoveredCount, 1);
  assert.deepStrictEqual(pass1.map(m => m.domId), ['m1', 'm2', 'm3', 'm4', 'm5']);
  assert.equal(pass1[1].text, 'Cp boss esob ki bole');
});

await test('ScanSession on mocked virtualized Messenger list with gap backtrack + Pass 2 produces complete audit', async () => {
  // Simulate 16 virtualized rows (height 120px each = 1920px). Container clientHeight = 600px.
  // Pass 1 step = 40% (240px), Pass 2 step = 30% (180px) starting at 120px.
  const allRowsHtml = [
    `<div role="row" data-rect="0,10,760,24"><h4 dir="auto" data-scope="date_break" data-rect="300,10,160,20">Oct 22, 2026, 2:22 PM</h4></div>`,
    ROW_FIXTURES.missedContactText,
    ROW_FIXTURES.exportedMyText,
    ROW_FIXTURES.contactText,
    ROW_FIXTURES.myText,
    ROW_FIXTURES.contactPhoto,
    ROW_FIXTURES.myVideo,
    ROW_FIXTURES.replyWithTextQuote,
    ROW_FIXTURES.replyWithVideoThumbQuote,
    ROW_FIXTURES.forwardedImage,
    ROW_FIXTURES.callRow,
    ROW_FIXTURES.contactLinkPost,
    // Identical consecutive short messages
    `<div role="row" data-rect="0,1440,760,40"><div data-scope="message_content" data-rect="52,1444,80,30"><div dir="auto">Ok</div></div></div>`,
    `<div role="row" data-rect="0,1560,760,40"><div data-scope="message_content" data-rect="52,1564,80,30"><div dir="auto">Ok</div></div></div>`,
    `<div role="row" data-rect="0,1680,760,40"><div data-scope="message_content" data-rect="540,1684,80,30"><div dir="auto">Sei</div></div></div>`
  ];
  const parsedRows = allRowsHtml.map((h, i) => {
    const el = parseHtmlElement(h);
    el._attrs['data-vidx'] = String(i);
    return el;
  });

  // Virtualized container: only renders window [scrollTop - 80 .. scrollTop + clientHeight + 80],
  // unmounting off-screen rows dynamically. Assign sequential virtual Y positions.
  const ROW_H = 120;
  const totalHeight = parsedRows.length * ROW_H;
  const adapter = new MessengerAdapter();
  const vContainer = {
    clientHeight: 600,
    scrollHeight: totalHeight,
    _top: 0,
    get scrollTop() { return this._top; },
    set scrollTop(v) { this._top = Math.max(0, Math.min(v, this.scrollHeight - this.clientHeight)); },
    dispatchEvent: () => true,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 760, height: 600, right: 760, bottom: 600 }),
    get children() {
      const startIdx = Math.max(0, Math.floor((this._top - 60) / ROW_H));
      const endIdx = Math.min(parsedRows.length, Math.ceil((this._top + this.clientHeight + 60) / ROW_H));
      return parsedRows.slice(startIdx, endIdx);
    },
    querySelectorAll: (sel) => {
      const visible = vContainer.children;
      if (sel.includes('[role="row"]') || sel.includes('[data-scope="message_content"]')) {
        if (sel.trim().startsWith('[role="row"]')) return visible;
      }
      const out = [];
      for (const ch of visible) {
        if (sel.includes('h4') && ch.querySelector?.('h4')) out.push(ch.querySelector('h4'));
        else if (ch.querySelectorAll) out.push(...ch.querySelectorAll(sel));
      }
      return out;
    },
    querySelector: (sel) => vContainer.querySelectorAll(sel)[0] || null
  };
  const vDoc = {
    body: vContainer,
    querySelector: (sel) => (sel.includes('[role="main"]') || sel.includes('[role="grid"]') ? vContainer : vContainer.querySelector(sel)),
    querySelectorAll: (sel) => vContainer.querySelectorAll(sel)
  };

  adapter.detectChatName = () => 'Sudipta Roy';
  adapter.findMessageContainer = () => vContainer;
  adapter.hasReachedTop = (c) => ({ reached: c.scrollTop <= 2, reason: 'scrollTop_zero_idle' });
  adapter.hasReachedBottom = (c) => ({ reached: c.scrollTop + c.clientHeight >= c.scrollHeight - 4 });

  const prevMO = globalThis.MutationObserver;
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  let result;
  try {
    const session = new ScanSession(() => {}, { adapter, container: vContainer, doc: vDoc });
    session.beginningReached = true;
    session.state = 'ready';
    result = await session.startReading({ myNameOverride: 'Mihan' });
  } finally {
    globalThis.MutationObserver = prevMO;
  }

  // 1 separator + 14 messages = 14 exported messages (all virtualized rows captured cleanly, zero drops)
  assert.equal(result.messages.length, 14, `Expected all 14 virtualized messages captured, got ${result.messages.length}`);
  assert.equal(result.integrity.audit.verificationRan, true);
  assert.equal(result.integrity.audit.gapsCount, 0);
  assert.equal(result.integrity.audit.unrecognizedCount, 0);
  assert.equal(result.integrity.audit.healthy, true);
});

console.log('\n=== PART 6: Export Grouping, Unique Month Headings, Unrecognized & Clean Formatting ===');

await test('"Group messages by sender" within 5 min shares 1 header block and renders Video duration + Unrecognized', async () => {
  const sampleMsgs = [
    { type: 'text', sender: 'Mihan', isMe: true, text: 'Club theke kintu riyaj r akif er sate ektu ektu porichoy ache', timestamp: '2026-06-10T10:49:00.000Z', timestampApproximate: true },
    { type: 'text', sender: 'Mihan', isMe: true, text: 'Inference er bisoye arektu janish', timestamp: '2026-06-10T10:49:20.000Z', timestampApproximate: true },
    { type: 'video', sender: 'Mihan', isMe: true, text: '🎬 Video', duration: '0:05', timestamp: '2026-06-10T10:51:00.000Z', reactions: ['😂', '0:19', '???'] },
    { type: 'unrecognized', sender: 'Sudipta Roy', isMe: false, text: '[Unrecognized message] Mystery poll', timestamp: '2026-10-22T14:22:00.000Z' }
  ];

  const prepared = prepareMessagesForExport(sampleMsgs, { groupBySender: true });
  const { days } = groupMessagesForExport(prepared, { groupBySender: true });

  // Day 1 (June 10): 3 consecutive "Mihan" messages within 2 minutes -> MUST form 1 single block!
  assert.equal(days[0].blocks.length, 1, '3 consecutive same-sender msgs within 5 min share 1 block');
  assert.equal(days[0].blocks[0].items.length, 3);
  assert.equal(days[0].blocks[0].items[0].showTime, true);
  assert.equal(days[0].blocks[0].items[1].showTime, false);
  assert.equal(days[0].blocks[0].items[2].showTime, false);
  // Dirty reactions stripped in prepareMessagesForExport:
  assert.deepStrictEqual(days[0].blocks[0].items[2].msg.reactions, ['😂']);

  // TXT export check
  const txt = buildTxtContent(sampleMsgs, { chatName: 'Sudipta Roy', platform: 'Messenger', integrity: { audit: { unrecognizedCount: 1 } } }, { groupBySender: true, platform: 'Messenger' });
  assert.ok(txt.includes('Unrecognized rows: 1'));
  assert.ok(txt.includes('🎬 Video (0:05)'));
  assert.ok(txt.includes('[Unrecognized message] Mystery poll'));
  assert.ok(!txt.includes('0:19'));
  assert.ok(!txt.includes('???'));

  // PDF HTML check
  const pdf = buildPdfHtml(sampleMsgs, { chatName: 'Sudipta Roy', platform: 'Messenger', integrity: { audit: { unrecognizedCount: 1 } } }, { groupBySender: true, platform: 'Messenger' });
  assert.ok(pdf.includes('<th>Unrecognized rows</th><td>1</td>'));
  assert.ok(pdf.includes('msg-line muted italic'));
  assert.ok(pdf.includes('[Unrecognized message] Mystery poll'));

  // DOCX build check
  if (docx) {
    const doc = await buildDocxDocument(docx, sampleMsgs, { chatName: 'Sudipta Roy', platform: 'Messenger', integrity: { audit: { unrecognizedCount: 1 } } }, { groupBySender: true, platform: 'Messenger', layout: 'bubbles' });
    const buf = await docx.Packer.toBuffer(doc);
    assert.ok(buf.length > 5000);
  }
});

console.log('\n=============================================');
console.log(`TOTAL TESTS: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
if (failed > 0) process.exit(1);
