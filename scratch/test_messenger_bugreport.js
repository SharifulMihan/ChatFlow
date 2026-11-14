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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { execSync } from 'node:child_process';
import {
  APP_VERSION,
  APP_VERSION_TAG,
  APP_DISPLAY_VERSION,
  RELEASE_DATE,
  RELEASE_HIGHLIGHTS,
  CHANGELOG_SUMMARY,
  getExtensionVersion
} from '../src/version.js';
import {
  validateRepoVersions,
  bumpVersionString,
  buildReleaseZip,
  isValidChromeVersion
} from '../scripts/version-manager.js';
import { MessengerAdapter } from '../content/adapters/messenger.js';
import { WhatsAppAdapter } from '../content/adapters/whatsapp.js';
import {
  parseDateSeparatorText,
  extractValidReactions,
  cleanReactionsList,
  parseStructuredReactions,
  isReactionOnly,
  isBlockedUiName,
  validatePersonName,
  resolveMyExportName,
  sanitizeSenderName,
  parseReplyLabel,
  isReplyLabel,
  isParticipantOrAvatarNameOnly,
  extractCleanIntroSystemText
} from '../content/selectors.js';
import { resolveDirection, finalizeSenders, pickMyName } from '../content/direction.js';
import {
  mergeSnapshot,
  reconcileVerificationPass,
  ScanSession,
  shouldRunSmartVerification,
  countReadingOrderDateViolations,
  runOnDemandVerification
} from '../content/scanner.js';
import {
  DEFAULT_EXPORT_OPTIONS,
  normalizeExportOptions,
  prepareMessagesForExport,
  groupMessagesForExport,
  formatReplyQuoteParts,
  truncateQuoteText,
  buildTranscript,
  buildStats
} from '../lib/transcript.js';
import { buildDocxDocument, renderMessageBlock as renderDocxBlock } from '../lib/exporter-docx.js';
import { buildTxtContent, renderMessageBlock as renderTxtBlock } from '../lib/exporter-txt.js';
import { buildPdfHtml } from '../lib/exporter-pdf.js';
import {
  OBSOLETE_STORAGE_KEYS,
  runVersionMigrations,
  handleInstalled,
  handleScanComplete
} from '../background/service-worker.js';
import {
  AppState,
  setState,
  setStepperPhase,
  updateScanProgress,
  finalizeAndSaveScan,
  runVerifyNow,
  getExportOptions,
  handleExportPdf,
  handleExportTxt,
  resetGroupBySenderToggle,
  migrateGroupBySenderSetting,
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
} from '../sidepanel/sidepanel.js';
import {
  ROW_FIXTURES,
  createMockPane,
  parseHtmlElement
} from '../fixtures/messenger_samples.js';

let docx = null;
try {
  const docxCode = fs.readFileSync(path.resolve('lib/vendor/docx.min.js'), 'utf8');
  const ctx = {
    window: {},
    globalThis: {},
    TextEncoder,
    TextDecoder,
    Uint8Array,
    Buffer,
    setTimeout,
    clearTimeout,
    Blob: typeof Blob !== 'undefined' ? Blob : undefined
  };
  vm.createContext(ctx);
  vm.runInContext(docxCode, ctx);
  docx = ctx.docx || ctx.window.docx;
} catch (_) { }

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
  assert.deepStrictEqual(extractValidReactions(['0:19', '???', '😂 2', '👍']), ['😂 2', '👍']);
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

await test('UNRECOGNIZED row is never silently dropped: logged with <=800 char pruned skeleton and emitted as [Unrecognized message]', () => {
  const adapter = new MessengerAdapter();
  adapter.resetSessionDates();
  const { doc } = createMockPane([
    ROW_FIXTURES.dateSepOct22,
    ROW_FIXTURES.unrecognizedWeirdRow
  ]);
  const msgs = adapter.extractMessages(doc);
  const audit = adapter.getAuditSnapshot();

  assert.equal(audit.unrecognizedCount, 1);
  assert.equal(audit.uniqueUnrecognized, 1);
  assert.equal(audit.unrecognizedSamples.length, 1);
  assert.ok(audit.unrecognizedSamples[0].skeleton.length <= 800);
  assert.ok(audit.unrecognizedSamples[0].sightings >= 1);
  assert.ok(audit.unrecognizedSamples[0].direction);
  assert.ok(audit.unrecognizedSamples[0].typeGuess);
  assert.ok(Array.isArray(audit.unrecognizedSamples[0].labels));
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
  const s = new ScanSession(() => { }, { adapter, container: {}, doc: { querySelector: () => null } });
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
    observe() { }
    disconnect() { }
  };
  let result;
  try {
    const session = new ScanSession(() => { }, { adapter, container: vContainer, doc: vDoc });
    session.beginningReached = true;
    session.state = 'ready';
    result = await session.startReading({ myNameOverride: 'Mihan', thoroughVerify: true });
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
  assert.ok(docx, 'docx UMD bundle must load from lib/vendor/docx.min.js');
  const { doc, Packer } = await buildDocxDocument(
    sampleMsgs,
    { chatName: 'Sudipta Roy', platform: 'Messenger', integrity: { audit: { unrecognizedCount: 1 } } },
    { groupBySender: true, platform: 'Messenger', layout: 'bubbles' },
    () => { },
    docx
  );
  const buf = await Packer.toBuffer(doc);
  assert.ok(buf.length > 5000);
});

console.log('\n=== EXPORT FIXES: REPLIES, MY NAME BLOCKLIST & REACTIONS ===');

function unzipDocxDocumentXml(buf, tag) {
  const tmpDir = path.resolve('scratch', `_tmp_unzip_${tag}`);
  const zipPath = path.resolve('scratch', `_tmp_${tag}.zip`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(zipPath, { force: true });
  fs.writeFileSync(zipPath, buf);
  execSync(`powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${tmpDir}' -Force"`, { stdio: 'pipe' });
  const xml = fs.readFileSync(path.join(tmpDir, 'word', 'document.xml'), 'utf8');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(zipPath, { force: true });
  return xml;
}

await test('Nested Messenger DOM reply without role="blockquote" separates quote from reply body', () => {
  const adapter = new MessengerAdapter();
  adapter.resetSessionDates();
  const html = `
    <div role="row" data-rect="120,300,520,88">
      <div role="presentation">
        <div role="none">
          <div><span>You replied to Sudipta</span></div>
          <div>
            <div><span>Valoi toh math er sathe toh cp er connection acei</span></div>
          </div>
          <div data-scope="message_content"><div dir="auto">Ek marar shathe arek mara</div></div>
        </div>
      </div>
    </div>
  `;
  const { container } = createMockPane([html]);
  const rows = adapter.enumerateCandidateRows(container);
  const res = adapter.classifyRow(rows[0], { container, chatName: 'Sudipta Roy', myName: 'Shariful Mihan' }, 0);
  assert.strictEqual(res.kind, 'message');
  assert.strictEqual(res.msg.isMe, true);
  assert.strictEqual(res.msg.text, 'Ek marar shathe arek mara');
  assert.ok(res.msg.replyTo, 'replyTo should be extracted');
  assert.strictEqual(res.msg.replyTo.text, 'Valoi toh math er sathe toh cp er connection acei');
  assert.strictEqual(res.msg.replyTo.sender, 'Sudipta');
});

await test('Problem 1: Reply quote block formatting in .docx XML, .txt, and .pdf (text, media, own quote, >140 truncation, Bengali, RTL, compact, bw)', async () => {
  assert.ok(docx, 'docx must be loaded');
  const longText = 'A'.repeat(180) + ' END';
  const msgs = [
    // 1. Outgoing reply to contact text
    {
      id: 'r1',
      sender: 'Controls and Settings', // Should be normalized away to resolved myName
      direction: 'out',
      time: '4:49 PM',
      timestamp: new Date(2026, 9, 22, 16, 49, 0).getTime(),
      text: 'Ek marar shathe arek mara',
      replyTo: { sender: 'Sudipta', text: 'Valoi toh math er sathe toh cp er connection acei' },
      reactions: ['😂 Sudipta Roy']
    },
    // 2. Contact replying to my video (media chip + never "Replying to you")
    {
      id: 'r2',
      sender: 'Sudipta Roy',
      direction: 'in',
      time: '5:28 PM',
      timestamp: new Date(2026, 9, 22, 17, 28, 0).getTime(),
      text: 'Sei',
      replyTo: { sender: 'you', mediaType: 'Video', text: '▶ 0:05' }
    },
    // 3. Long quote (>140 chars truncated with …) & photo quote
    {
      id: 'r3',
      sender: 'Shariful Mihan',
      direction: 'out',
      time: '5:30 PM',
      timestamp: new Date(2026, 9, 22, 17, 30, 0).getTime(),
      text: 'Got it!',
      replyTo: { sender: 'Sudipta Roy', text: longText }
    },
    // 4. Bengali & RTL Arabic quotes
    {
      id: 'r4',
      sender: 'Sudipta Roy',
      direction: 'in',
      time: '5:31 PM',
      timestamp: new Date(2026, 9, 22, 17, 31, 0).getTime(),
      text: 'একদম ঠিক বলেছো',
      replyTo: { sender: 'Me', text: 'ভালোই তো ম্যাথ এর সাথে তো সিপি এর কানেকশন আছেই' }
    },
    {
      id: 'r5',
      sender: 'Shariful Mihan',
      direction: 'out',
      time: '5:32 PM',
      timestamp: new Date(2026, 9, 22, 17, 32, 0).getTime(),
      text: 'مرحبا بك',
      replyTo: { sender: 'Sudipta Roy', text: 'مرحبا كيف حالك اليوم' }
    },
    // 5. Dirty colon/Original message label inside quote text should be stripped cleanly
    {
      id: 'r6',
      sender: 'Sudipta Roy',
      direction: 'in',
      time: '5:33 PM',
      timestamp: new Date(2026, 9, 22, 17, 33, 0).getTime(),
      text: 'Hae',
      replyTo: { sender: 'Shariful Mihan', text: 'Original message: Test clean quote' }
    }
  ];

  // Check truncateQuoteText directly
  const trunc = truncateQuoteText(longText, 140);
  assert.strictEqual([...trunc].length, 140);
  assert.ok(trunc.endsWith('…'));

  // Check formatReplyQuoteParts never leaks "Replying to you" or "Controls and Settings"
  const partsOwn = formatReplyQuoteParts(msgs[1], { myName: 'Shariful Mihan', chatName: 'Sudipta Roy' });
  assert.strictEqual(partsOwn.header, '↪ Replying to Shariful Mihan · 🎬 Video');
  assert.strictEqual(partsOwn.body, '');

  const partsText = formatReplyQuoteParts(msgs[0], { myName: 'Shariful Mihan', chatName: 'Sudipta Roy' });
  assert.strictEqual(partsText.header, '↪ Replying to Sudipta');
  assert.strictEqual(partsText.body, 'Valoi toh math er sathe toh cp er connection acei');

  const opts = {
    platform: 'Messenger',
    myName: 'Shariful Mihan',
    chatName: 'Sudipta Roy',
    groupBySender: true,
    layout: 'bubbles',
    theme: 'color',
    pageSize: 'A4'
  };

  // TXT verification
  const txt = buildTxtContent(msgs, { chatName: 'Sudipta Roy', platform: 'Messenger', detectedMyName: 'Controls and Settings' }, opts);
  assert.ok(txt.includes('↪ Replying to Sudipta'));
  assert.ok(txt.includes('↪ Replying to Shariful Mihan · 🎬 Video'));
  assert.ok(txt.includes('ভ') && txt.includes('ভালোই তো ম্যাথ এর সাথে তো সিপি এর কানেকশন আছেই'));
  assert.ok(txt.includes('Reactions: 😂 Sudipta Roy'));
  assert.ok(!txt.includes('Controls and Settings'));
  assert.ok(!txt.includes('Replying to you'));
  assert.ok(!txt.includes('Original message:'));
  assert.ok(!txt.includes('Sudipta:\nValoi'));

  // PDF HTML verification
  const pdf = buildPdfHtml(msgs, { chatName: 'Sudipta Roy', platform: 'Messenger', detectedMyName: 'Controls and Settings' }, opts);
  assert.ok(pdf.includes('class="quote-box"'));
  assert.ok(pdf.includes('↪ Replying to Shariful Mihan · 🎬 Video'));
  assert.ok(!pdf.includes('Controls and Settings'));
  assert.ok(!pdf.includes('Replying to you'));
  assert.ok(!pdf.includes('Original message:'));

  // DOCX bubbles + color verification (unpack OOXML)
  const { doc: docColor, Packer: PackerColor } = await buildDocxDocument(msgs, { chatName: 'Sudipta Roy', platform: 'Messenger' }, opts, () => { }, docx);
  const xmlColor = unzipDocxDocumentXml(await PackerColor.toBuffer(docColor), 'color');
  assert.ok(xmlColor.includes('↪ Replying to Sudipta'), 'quote header in XML');
  assert.ok(xmlColor.includes('↪ Replying to Shariful Mihan · 🎬 Video'), 'media quote chip in XML');
  assert.ok(xmlColor.includes('w:sz w:val="17"'), '8.5pt quote header font size');
  assert.ok(xmlColor.includes('w:sz w:val="18"'), '9pt quote body font size');
  assert.ok(xmlColor.includes('w:sz w:val="21"'), '10.5pt reply body font size');
  assert.ok(xmlColor.includes('w:sz="24"'), '3pt left border on quote block');
  assert.ok(/w:color[^>]*w:val="6B7280"/.test(xmlColor), 'muted gray quote color');
  assert.ok(xmlColor.includes('DBEAFE') || xmlColor.includes('E5E7EB'), 'shaded quote overlay background');
  assert.ok(xmlColor.includes('w:bidi'), 'RTL support in XML');
  assert.ok(xmlColor.includes('Test clean quote'), 'cleaned quote body preserved');
  assert.ok(!xmlColor.includes('Controls and Settings'), 'never leaks Controls and Settings');
  assert.ok(!xmlColor.includes('Replying to you'), 'never leaks Replying to you');
  assert.ok(!xmlColor.includes('Original message:'), 'strips Original message: prefix');
  assert.ok(!xmlColor.includes('Sudipta:'), 'no stray Sudipta: prefix');

  // DOCX compact + B&W mode verification
  const { doc: docCompactBw, Packer: PackerBw } = await buildDocxDocument(
    msgs,
    { chatName: 'Sudipta Roy', platform: 'Messenger' },
    { ...opts, layout: 'compact', colorMode: 'bw', groupBySender: false },
    () => { },
    docx
  );
  const xmlBw = unzipDocxDocumentXml(await PackerBw.toBuffer(docCompactBw), 'compact_bw');
  assert.ok(xmlBw.includes('↪ Replying to Sudipta'));
  assert.ok(xmlBw.includes('w:sz="24"'));
  assert.ok(xmlBw.includes('E5E7EB') || xmlBw.includes('D1D5DB'));
  assert.ok(!xmlBw.includes('Controls and Settings'));
});

await test('Problem 2: UI blocklist rejects "Controls and settings" & variants; name priority & validation work', () => {
  const blockedSamples = [
    'Controls and settings',
    'Account Controls and Settings',
    'Settings',
    'Menu',
    'Profile',
    'Your profile',
    'Account',
    'Chats',
    'Messenger',
    'Facebook',
    'Notifications',
    'Marketplace',
    'More',
    'Search',
    'Close',
    'Back',
    'Info',
    'Call',
    'Video chat',
    'সেটিংস',
    'নিয়ন্ত্রণ ও সেটিংস',
    'Controles y configuración'
  ];
  for (const s of blockedSamples) {
    assert.strictEqual(isBlockedUiName(s), true, `Expected blocked: ${s}`);
    assert.strictEqual(validatePersonName(s, 'Sudipta Roy'), null, `Expected null validation: ${s}`);
    assert.strictEqual(sanitizeSenderName(s, 'Sudipta Roy'), null, `Expected null sanitize: ${s}`);
  }

  // Non-name strings rejected
  assert.strictEqual(validatePersonName('X', 'Sudipta Roy'), null, '1 char rejected');
  assert.strictEqual(validatePersonName('10:42 PM', 'Sudipta Roy'), null, 'time rejected');
  assert.strictEqual(validatePersonName('Oct 22, 2026', 'Sudipta Roy'), null, 'date rejected');
  assert.strictEqual(validatePersonName('!!! ???', 'Sudipta Roy'), null, 'symbols only rejected');
  assert.strictEqual(validatePersonName('Sudipta Roy', 'Sudipta Roy'), null, 'contact name collision rejected');

  // Valid name accepted
  assert.strictEqual(validatePersonName('Shariful Mihan', 'Sudipta Roy'), 'Shariful Mihan');

  // Setting overrides detected name; detected overrides fallback; fallback is "Me"
  assert.strictEqual(
    resolveMyExportName({ settingName: 'Mihan Custom', detectedName: 'Shariful Mihan', contactName: 'Sudipta Roy' }),
    'Mihan Custom'
  );
  assert.strictEqual(
    resolveMyExportName({ settingName: 'Controls and Settings', detectedName: 'Shariful Mihan', contactName: 'Sudipta Roy' }),
    'Shariful Mihan'
  );
  assert.strictEqual(
    resolveMyExportName({ settingName: '', detectedName: 'Controls and Settings', contactName: 'Sudipta Roy' }),
    'Me'
  );

  // Mock Messenger DOM with account controls button vs valid name
  const adapter = new MessengerAdapter();
  const mockDocBad = parseHtmlElement(`
    <div>
      <div role="banner">
        <div role="button" aria-label="Account Controls and Settings"></div>
        <button aria-label="Notifications">Notifications</button>
      </div>
      <div role="main"><h1>Sudipta Roy</h1></div>
    </div>
  `);
  const fakeDoc = {
    querySelector: (sel) => mockDocBad.querySelector(sel),
    querySelectorAll: (sel) => mockDocBad.querySelectorAll(sel)
  };
  assert.strictEqual(adapter.detectMyProfileName(fakeDoc, 'Sudipta Roy'), null);
  assert.strictEqual(adapter.getUserAccountName(fakeDoc, 'Sudipta Roy'), 'Me');
  assert.strictEqual(pickMyName('', 'Account Controls and Settings', 'Sudipta Roy'), 'Me');
});

await test('Reactions cleanup strips accessibility text, phrases, and duplicates', () => {
  assert.deepStrictEqual(cleanReactionsList(['1 reaction with 😂; see who 😂 😂']), ['😂']);
  assert.deepStrictEqual(cleanReactionsList(['Sudipta Roy reacted with ❤️', '❤️']), ['❤️ Sudipta Roy']);
  assert.deepStrictEqual(cleanReactionsList(['2 reactions with 😂', '0:19', '???']), ['😂 2']);
  const parsed = parseStructuredReactions('1 reaction with 😂; see who 😂 😂');
  assert.strictEqual(parsed.length, 1);
  assert.strictEqual(parsed[0].emoji, '😂');
  assert.strictEqual(parsed[0].count, 1);
  assert.strictEqual(parsed[0].who.length, 0);
});

// ─── BUG 1 & BUG 2: Completion Options / Resilience & groupBySender OFF ─────
function createSidepanelTestEnv() {
  const elements = new Map();
  const makeClassList = (initial = []) => {
    const set = new Set(initial);
    return {
      add: (...cls) => cls.forEach(c => set.add(c)),
      remove: (...cls) => cls.forEach(c => set.delete(c)),
      contains: (c) => set.has(c),
      toggle: (c, force) => {
        if (force === undefined) {
          if (set.has(c)) { set.delete(c); return false; }
          set.add(c); return true;
        }
        if (force) set.add(c);
        else set.delete(c);
        return !!force;
      }
    };
  };
  const makeEl = (id, props = {}) => {
    const el = {
      id,
      value: '',
      checked: false,
      disabled: false,
      textContent: '',
      innerHTML: '',
      style: {},
      dataset: {},
      attributes: {},
      children: [],
      classList: makeClassList(props.hidden ? ['hidden'] : []),
      setAttribute: function (k, v) { this.attributes[k] = String(v); },
      getAttribute: function (k) { return this.attributes[k] ?? null; },
      appendChild: function (child) { this.children.push(child); return child; },
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => { },
      click: () => { },
      ...props
    };
    elements.set(id, el);
    return el;
  };

  for (const id of [
    'state-not-supported', 'state-select-chat', 'state-ready', 'state-scanning',
    'partial-scan-banner', 'sender-warning-banner', 'checks-warning-banner',
    'cc-incomplete-banner', 'cc-debug-bar', 'btn-reload-tab',
    'verify-progress-box', 'view-loading', 'view-ready', 'view-reading',
    'view-preparing', 'reading-direction-note', 'whats-new-card'
  ]) {
    makeEl(id, { hidden: true });
  }
  for (const [idx, stepId] of [[1, 'step-1'], [2, 'step-2'], [3, 'step-3']]) {
    const dot = makeEl(`${stepId}-dot`, { textContent: String(idx) });
    const label = makeEl(`${stepId}-label`, { textContent: idx === 2 ? 'Reading messages' : `Step ${idx}` });
    makeEl(stepId, {
      querySelector: (sel) => (sel === '.step-dot' ? dot : (sel === '.step-label' ? label : null))
    });
  }
  for (const id of [
    'state-complete', 'state-error', 'complete-card', 'complete-check-icon',
    'complete-title', 'cc-incomplete-reason', 'cc-total', 'cc-range',
    'cc-participants', 'cc-split', 'cc-aud-candidates', 'cc-aud-exported',
    'cc-aud-nonmsg', 'cc-aud-unrec', 'cc-aud-gaps', 'cc-aud-diffs',
    'cc-aud-verify-status', 'cc-aud-timings', 'cc-verify-bar', 'cc-verify-note',
    'btn-cc-verify-now', 'setting-thorough-scan',
    'whats-new-title', 'whats-new-list', 'btn-whats-new-changelog', 'btn-whats-new-close',
    'setting-ext-version', 'app-footer-version',
    'settings-changelog-details', 'settings-changelog-content',
    'scan-title', 'scan-live', 'scan-count', 'scan-count-label',
    'reading-progress', 'reading-bar', 'reading-date', 'reading-speed',
    'verifying-label', 'verifying-progress', 'verifying-bar',
    'health-list', 'partial-oldest-date', 'sender-warning-desc',
    'checks-warning-desc', 'btn-copy-substep-error', 'btn-copy-error-details',
    'btn-retry', 'error-message', 'top-chat-title', 'top-avatar',
    'top-platform-badge', 'hl-total-messages', 'hl-delta-week',
    'card-participants-count', 'card-days-span', 'card-date-range',
    'exp-from-date', 'exp-to-date', 'hl-line-chart-box',
    'activity-table-body', 'weekday-chart-box', 'tab-participants-list',
    'direction-status', 'direction-status-icon', 'direction-status-text',
    'btn-confirm-who', 'toast', 'toast-text', 'exp-live-preview',
    'exp-rename-list', 'int-candidates', 'int-total-msgs', 'int-sep-sys-noise',
    'int-unrecognized', 'int-overlap-merges', 'int-no-overlap',
    'int-verify-diffs', 'int-rejected-seps', 'int-verify-status',
    'int-pass-timings', 'btn-export-docx'
  ]) {
    if (!elements.has(id)) makeEl(id);
  }
  makeEl('diag-direction-log', { textContent: 'No scan yet.' });
  makeEl('exp-layout', { value: 'bubbles' });
  makeEl('exp-color-mode', { value: 'color' });
  makeEl('exp-date-format', { value: 'auto' });
  makeEl('exp-time-format', { value: 'auto' });
  makeEl('exp-page-size', { value: 'A4' });
  makeEl('exp-font-size', { value: 'M' });
  makeEl('exp-my-name', { value: '' });
  makeEl('exp-summary', { checked: true });
  makeEl('exp-timestamps', { checked: true });
  makeEl('exp-group-sender', { checked: false });
  makeEl('exp-reactions', { checked: true });
  makeEl('exp-media-labels', { checked: true });
  makeEl('exp-system-messages', { checked: true });
  makeEl('exp-hide-quotes', { checked: false });

  const localStore = {};
  const sessionStore = {};
  const lsStore = new Map();
  const windowListeners = new Map();
  let clipboardText = '';
  let lastBlobParts = [];
  let failSendMessage = false;

  const mockDoc = {
    activeElement: null,
    body: { appendChild: () => { }, removeChild: () => { } },
    getElementById: (id) => elements.get(id) || null,
    querySelectorAll: () => [],
    createElement: (_tag) => ({
      className: '',
      innerHTML: '',
      textContent: '',
      href: '',
      download: '',
      style: {},
      dataset: {},
      children: [],
      classList: makeClassList(),
      setAttribute: () => { },
      getAttribute: () => null,
      addEventListener: () => { },
      appendChild: function (child) { this.children.push(child); return child; },
      querySelectorAll: () => [],
      click: () => { }
    })
  };

  const mockWindow = {
    addEventListener: (type, fn) => {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(fn);
    },
    dispatchEvent: (type, ev) => {
      for (const fn of (windowListeners.get(type) || [])) fn(ev);
    },
    open: () => ({})
  };

  const mockChrome = {
    runtime: {
      getManifest: () => ({ version: APP_VERSION }),
      sendMessage: async (msg) => {
        if (failSendMessage) throw new Error('Simulated port failure');
        if (msg?.type === 'SCAN_COMPLETE') {
          let resp = null;
          await handleScanComplete(msg.payload, (r) => { resp = r; });
          return resp;
        }
        if (msg?.type === 'GET_SESSION') return { ok: true, data: { ...sessionStore } };
        if (msg?.type === 'CLEAR_SESSION') {
          for (const k of Object.keys(sessionStore)) delete sessionStore[k];
          return { ok: true };
        }
        return { ok: true };
      }
    },
    tabs: {
      sendMessage: async () => ({ ok: true, version: APP_VERSION })
    },
    storage: {
      local: {
        get: (keys, cb) => {
          const keyList = Array.isArray(keys) ? keys : (typeof keys === 'string' ? [keys] : Object.keys(localStore));
          const out = {};
          for (const k of keyList) if (k in localStore) out[k] = localStore[k];
          if (typeof cb === 'function') cb(out);
          return Promise.resolve(out);
        },
        set: (obj, cb) => {
          Object.assign(localStore, obj || {});
          if (typeof cb === 'function') cb();
          return Promise.resolve();
        },
        remove: (keys, cb) => {
          const keyList = Array.isArray(keys) ? keys : [keys];
          for (const k of keyList) delete localStore[k];
          if (typeof cb === 'function') cb();
          return Promise.resolve();
        }
      },
      session: {
        set: (obj, cb) => {
          Object.assign(sessionStore, obj || {});
          if (typeof cb === 'function') cb();
          return Promise.resolve();
        }
      }
    }
  };

  const prevDescriptors = new Map();
  const installGlobals = () => {
    const patches = {
      document: mockDoc,
      window: mockWindow,
      chrome: mockChrome,
      navigator: { language: 'en-US', clipboard: { writeText: async (t) => { clipboardText = String(t); } } },
      localStorage: {
        getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
        setItem: (k, v) => lsStore.set(k, String(v)),
        removeItem: (k) => lsStore.delete(k)
      },
      Blob: class MockBlob {
        constructor(parts, opts) {
          this.parts = parts;
          this.type = opts?.type || '';
          lastBlobParts = parts;
        }
      },
      URL: {
        createObjectURL: () => 'blob:mock-chatflow',
        revokeObjectURL: () => { }
      }
    };
    for (const [key, val] of Object.entries(patches)) {
      prevDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { value: val, configurable: true, writable: true });
    }
    installGlobalErrorHandlers();
  };

  const restoreGlobals = () => {
    for (const [key, desc] of prevDescriptors.entries()) {
      if (desc) Object.defineProperty(globalThis, key, desc);
      else delete globalThis[key];
    }
  };

  return {
    elements,
    el: (id) => elements.get(id),
    localStore,
    lsStore,
    mockWindow,
    setFailSendMessage: (v) => { failSendMessage = !!v; },
    getClipboardText: () => clipboardText,
    getLastBlobText: () => lastBlobParts.join(''),
    installGlobals,
    restoreGlobals
  };
}

function makeCompletionFixtures(platform) {
  const isMsgr = platform === 'Messenger';
  const contactName = isMsgr ? 'Sudipta Roy' : 'Raj Roy';
  const baseTs = new Date(2026, 9, 22, 16, 48, 0).getTime();
  return {
    chatName: contactName,
    platform,
    chatType: 'one-to-one',
    isPartial: false,
    oldestTimestamp: new Date(baseTs).toISOString(),
    messages: [
      {
        id: `${platform}-1`,
        sender: contactName,
        isMe: false,
        isOutgoing: false,
        type: 'text',
        text: 'Valoi toh math er sathe toh cp er connection acei',
        timestamp: new Date(baseTs).toISOString(),
        reactions: ['😂']
      },
      {
        id: `${platform}-2`,
        sender: 'Me',
        isMe: true,
        isOutgoing: true,
        type: 'text',
        text: 'Ek marar shathe arek mara',
        replyTo: {
          sender: contactName,
          senderIsMe: false,
          text: 'Valoi toh math er sathe toh cp er connection acei'
        },
        timestamp: new Date(baseTs + 60 * 1000).toISOString(),
        reactions: []
      },
      {
        id: `${platform}-3`,
        sender: 'Me',
        isMe: true,
        isOutgoing: true,
        type: 'text',
        text: 'Dhaka gesos?',
        timestamp: new Date(baseTs + 120 * 1000).toISOString(),
        reactions: []
      }
    ],
    integrity: {
      detectedMyName: 'Shariful Mihan',
      totalCaptured: 3,
      direction: { lowConfidence: false, meCount: 2, themCount: 1 },
      sanityCheck: { warnings: [] },
      audit: {
        candidateRowsSeen: 5,
        messagesExported: 3,
        separatorsCount: 1,
        systemRowsCount: 0,
        replyLabelsCount: 1,
        noiseRowsCount: 0,
        unrecognizedCount: 0,
        gapsCount: 0,
        verificationDifferencesCount: 0,
        verificationRan: true,
        healthy: true,
        finalTotal: 3
      }
    }
  };
}

await test('BUG 1: Full completion pipeline succeeds on WhatsApp and Messenger with default, {}, and undefined options', async () => {
  const env = createSidepanelTestEnv();
  env.installGlobals();
  try {
    for (const platform of ['WhatsApp', 'Messenger']) {
      const fixture = makeCompletionFixtures(platform);
      const msgsDate = fixture.messages.map(m => ({ ...m, timestamp: new Date(m.timestamp) }));

      // Direct transcript / stats / exporter calls with {}, undefined, and null
      for (const optVariant of [DEFAULT_EXPORT_OPTIONS, {}, undefined, null]) {
        const transcript = buildTranscript(msgsDate, {}, optVariant);
        assert.ok(transcript.includes('Ek marar shathe arek mara'), `${platform} transcript missing reply body`);
        const stats = buildStats(msgsDate, fixture.chatName, platform);
        const txt = buildTxtContent(msgsDate, stats, optVariant);
        assert.ok(txt.includes('Ek marar shathe arek mara'), `${platform} txt missing body`);
        const pdf = buildPdfHtml(msgsDate, stats, optVariant);
        assert.ok(pdf.includes('Ek marar shathe arek mara'), `${platform} pdf missing body`);
        const { total } = await buildDocxDocument(msgsDate, stats, optVariant, () => { }, docx);
        assert.strictEqual(total, 3);

        // Background service worker completion
        let swResp = null;
        await handleScanComplete({ ...fixture, options: optVariant }, (r) => { swResp = r; });
        assert.strictEqual(swResp.ok, true, `${platform} service worker failed: ${swResp?.error}`);
        assert.deepStrictEqual(swResp.stepErrors, []);

        // Full sidepanel completion flow
        clearRecordedErrors();
        await finalizeAndSaveScan(fixture, optVariant);
        assert.strictEqual(
          getRecordedErrors().length,
          0,
          `${platform} recorded unexpected errors: ${JSON.stringify(getRecordedErrors())}`
        );
        assert.strictEqual(env.el('state-complete').classList.contains('hidden'), false, `${platform} results should be visible`);
        assert.strictEqual(env.el('state-error').classList.contains('hidden'), true, `${platform} error view must stay hidden`);
        assert.strictEqual(env.el('checks-warning-banner').classList.contains('hidden'), true, `${platform} checks banner must stay hidden`);
        assert.strictEqual(env.el('hl-total-messages').textContent, '3');
      }
    }
  } finally {
    env.restoreGlobals();
  }
});

await test('BUG 1: Sub-step failure and service-worker failure keep results visible with amber card, Copy error details, and Diagnostics log', async () => {
  const env = createSidepanelTestEnv();
  env.installGlobals();
  try {
    const fixture = makeCompletionFixtures('Messenger');
    await finalizeAndSaveScan(fixture, undefined, {
      beforeStep: (stepName) => {
        if (stepName === 'gold_line_chart') {
          throw new Error('Simulated chart render boom');
        }
      }
    });

    assert.strictEqual(env.el('state-complete').classList.contains('hidden'), false, 'Results view must still be shown');
    assert.strictEqual(env.el('state-error').classList.contains('hidden'), true, 'Red Scan Notice must NOT replace results');
    assert.strictEqual(env.el('checks-warning-banner').classList.contains('hidden'), false, 'Amber "Some checks could not run" card must appear');
    assert.ok(env.el('checks-warning-desc').textContent.includes('gold_line_chart'));
    assert.ok(env.el('checks-warning-desc').textContent.includes('Simulated chart render boom'));

    const errors = getRecordedErrors();
    assert.ok(errors.some(e => e.step === 'gold_line_chart' && e.message.includes('Simulated chart render boom') && e.stack.length > 0));
    const diagText = env.el('diag-direction-log').textContent;
    assert.ok(diagText.includes('gold_line_chart'), 'Diagnostics log must record failing step name');
    assert.ok(diagText.includes('Simulated chart render boom'), 'Diagnostics log must record error message');

    const copied = await copyErrorDetails();
    assert.strictEqual(copied, true);
    const parsed = JSON.parse(env.getClipboardText());
    assert.ok(parsed.errors.some(e => e.step === 'gold_line_chart' && e.message.includes('Simulated chart render boom')));

    // Also test service worker sendMessage failure still shows results via local buildStats fallback
    env.setFailSendMessage(true);
    await finalizeAndSaveScan(makeCompletionFixtures('WhatsApp'));
    assert.strictEqual(env.el('state-complete').classList.contains('hidden'), false, 'Fallback results must appear if service worker fails');
    assert.strictEqual(env.el('checks-warning-banner').classList.contains('hidden'), false);
    assert.ok(getRecordedErrors().some(e => e.step === 'service_worker_save'));
  } finally {
    env.restoreGlobals();
  }
});

await test('BUG 1: Zero-message unusable scan opens Scan Notice with Copy error details, and global handlers prevent stuck UI', async () => {
  const html = fs.readFileSync(path.resolve('sidepanel/index.html'), 'utf8');
  assert.ok(html.includes('id="btn-copy-error-details"'), 'Missing Copy error details button in #state-error');
  assert.ok(html.includes('Some checks could not run'), 'Missing "Some checks could not run" amber card');
  assert.ok(html.includes('id="btn-copy-substep-error"'), 'Missing Copy error details button in amber card');

  const env = createSidepanelTestEnv();
  env.installGlobals();
  try {
    clearRecordedErrors();
    await assert.rejects(
      () => finalizeAndSaveScan({ messages: [], chatName: 'Empty', platform: 'Messenger' }),
      /No messages found/
    );
    setState(AppState.ERROR, { message: 'No messages found in this chat.' });
    assert.strictEqual(env.el('state-error').classList.contains('hidden'), false);
    await copyErrorDetails();
    const errPayload = JSON.parse(env.getClipboardText());
    assert.ok(errPayload.errors.length >= 1);

    // Trigger global error while stuck in scanning with no messages
    setPanelTestState({ messages: null, stats: null, scanPhase: 'reading' });
    env.el('state-scanning').classList.remove('hidden');
    env.el('state-error').classList.add('hidden');
    env.mockWindow.dispatchEvent('unhandledrejection', { reason: new Error('Simulated async scan crash') });
    assert.strictEqual(getPanelTestState().currentScanPhase, 'idle', 'Global handler must clear stuck scan phase');
    assert.strictEqual(env.el('state-error').classList.contains('hidden'), false, 'Global handler must show error state instead of spinner');
    assert.ok(getRecordedErrors().some(e => e.step === 'unhandledrejection' && e.message.includes('Simulated async scan crash')));
  } finally {
    env.restoreGlobals();
  }
});

await test('BUG 2: Group messages by sender defaults OFF, migrates stored true -> false, and resets after export/rescan', async () => {
  const html = fs.readFileSync(path.resolve('sidepanel/index.html'), 'utf8');
  assert.match(html, /id="exp-group-sender"[^>]*>/);
  assert.doesNotMatch(html, /id="exp-group-sender"[^>]*\bchecked\b/);
  assert.strictEqual(DEFAULT_EXPORT_OPTIONS.groupBySender, false);
  assert.strictEqual(normalizeExportOptions(undefined).groupBySender, false);

  const env = createSidepanelTestEnv();
  env.installGlobals();
  try {
    // 1. Default options produce ungrouped (1 message per block) across exporters
    const fixture = makeCompletionFixtures('WhatsApp');
    const msgsDate = fixture.messages.map(m => ({ ...m, timestamp: new Date(m.timestamp) }));
    const stats = buildStats(msgsDate, fixture.chatName, 'WhatsApp');

    const groupedDefault = groupMessagesForExport(msgsDate);
    assert.strictEqual(groupedDefault.days[0].blocks.length, 3, 'When groupBySender is OFF, each consecutive message has its own header block');
    const txtDefault = buildTxtContent(msgsDate, stats, {});
    assert.strictEqual((txtDefault.match(/^\[[^\]]+\] Me:/gm) || []).length, 2, 'TXT must print sender header on every outgoing message when OFF');

    const htmlDefault = buildPdfHtml(msgsDate, stats, undefined);
    assert.strictEqual((htmlDefault.match(/class="sender-name"[^>]*>Me</g) || []).length, 2, 'PDF must print sender header per message when OFF');

    const { doc } = await buildDocxDocument(msgsDate, stats, undefined, () => { }, docx);
    const bodyXml = JSON.stringify(doc);
    assert.ok(bodyXml.includes('Dhaka gesos?'));

    // 2. Migration overwrites any stored true value with false
    env.localStore.chatflow_group_by_sender = true;
    env.localStore.groupBySender = true;
    env.localStore.chatflow_export_options = { layout: 'bubbles', groupBySender: true };
    env.lsStore.set('chatflow_group_by_sender', 'true');
    env.el('exp-group-sender').checked = true;

    await migrateGroupBySenderSetting();
    assert.strictEqual(env.localStore.chatflow_group_by_sender, false);
    assert.strictEqual(env.localStore.groupBySender, false);
    assert.strictEqual(env.localStore.chatflow_export_options.groupBySender, false);
    assert.strictEqual(env.localStore.chatflow_group_sender_migrated_v1, true);
    assert.strictEqual(env.el('exp-group-sender').checked, false);
    assert.strictEqual(getExportOptions().groupBySender, false);

    // 3. Turning it ON manually groups ONLY that single export, then resets to false
    await finalizeAndSaveScan(fixture);
    env.el('exp-group-sender').checked = true;
    assert.strictEqual(getExportOptions().groupBySender, true);

    handleExportTxt(true);
    const exportedTxt = env.getLastBlobText();
    assert.strictEqual((exportedTxt.match(/^Me:/gm) || []).length, 0, 'Grouped TXT uses time-prefixed sender header block once');
    assert.strictEqual(env.el('exp-group-sender').checked, false, 'Must reset to false right after TXT export');

    env.el('exp-group-sender').checked = true;
    handleExportPdf();
    assert.strictEqual(env.el('exp-group-sender').checked, false, 'Must reset to false right after PDF export');

    // 4. After new scan / rescan, toggle is also reset to false
    env.el('exp-group-sender').checked = true;
    await finalizeAndSaveScan(fixture);
    assert.strictEqual(env.el('exp-group-sender').checked, false, 'Must reset to false after new scan');

    env.el('exp-group-sender').checked = true;
    resetGroupBySenderToggle();
    assert.strictEqual(env.el('exp-group-sender').checked, false);
  } finally {
    env.restoreGlobals();
  }
});

console.log('\n=== MESSENGER REPLY GROUPING, NOISE HARDENING & SHARED RENDERER SNAPSHOTS ===');

await test('parseReplyLabel handles localized variants, self-replies, Bengali NFC/NFD, and unparsed fallback', () => {
  const r1 = parseReplyLabel('You replied to Iqbal Mahmood', { chatName: 'Iqbal Mahmood Durjoy', myName: 'S.I.MiHAN' });
  assert.deepStrictEqual(
    { isReply: r1.isReply, replierIsMe: r1.replierIsMe, quotedSender: r1.quotedSender, senderIsMe: r1.senderIsMe, unparsed: r1.unparsed },
    { isReply: true, replierIsMe: true, quotedSender: 'Iqbal Mahmood', senderIsMe: false, unparsed: false }
  );

  const r2 = parseReplyLabel('Iqbal Mahmood replied to you', { chatName: 'Iqbal Mahmood Durjoy', myName: 'S.I.MiHAN' });
  assert.strictEqual(r2.isReply, true);
  assert.strictEqual(r2.replierName, 'Iqbal Mahmood');
  assert.strictEqual(r2.replierIsMe, false);
  assert.strictEqual(r2.quotedSender, 'S.I.MiHAN');
  assert.strictEqual(r2.senderIsMe, true);

  const rSelfMe = parseReplyLabel('You replied to yourself', { myName: 'S.I.MiHAN' });
  assert.strictEqual(rSelfMe.isSelfReply, true);
  assert.strictEqual(rSelfMe.replierIsMe, true);
  assert.strictEqual(rSelfMe.senderIsMe, true);
  assert.strictEqual(rSelfMe.quotedSender, 'S.I.MiHAN');

  const rSelfOther = parseReplyLabel('Iqbal Mahmood replied to themselves', { myName: 'S.I.MiHAN' });
  assert.strictEqual(rSelfOther.isSelfReply, true);
  assert.strictEqual(rSelfOther.replierIsMe, false);
  assert.strictEqual(rSelfOther.quotedSender, 'Iqbal Mahmood');
  assert.strictEqual(rSelfOther.senderIsMe, false);

  const rGroup = parseReplyLabel('Rahim replied to Karim', { chatName: 'CS Study Group', myName: 'S.I.MiHAN' });
  assert.strictEqual(rGroup.replierName, 'Rahim');
  assert.strictEqual(rGroup.quotedSender, 'Karim');
  assert.strictEqual(rGroup.replierIsMe, false);
  assert.strictEqual(rGroup.senderIsMe, false);

  const bnNfd = 'নাবিলা উত্তর দিয়েছেন'.normalize('NFD');
  assert.strictEqual(isReplyLabel(bnNfd), true);
  const rBn = parseReplyLabel('আপনি Iqbal-কে উত্তর দিয়েছেন', { chatName: 'Iqbal', myName: 'S.I.MiHAN' });
  assert.strictEqual(rBn.isReply, true);
  assert.strictEqual(rBn.replierIsMe, true);
  assert.strictEqual(rBn.quotedSender, 'Iqbal');

  const rFallback = parseReplyLabel('Someone replied', { myName: 'S.I.MiHAN' });
  assert.strictEqual(rFallback.isReply, true);
  assert.strictEqual(rFallback.unparsed, true);
  assert.strictEqual(rFallback.quotedSender, 'Unknown');
});

await test('Messenger extractMessages groups split-row replies (1-row, 2-row Iqbal, 3-row unstyled, media, self, Bengali, group, orphan) without ever emitting quote rows as messages', async () => {
  const adapter = new MessengerAdapter();
  adapter.resetSessionDates();
  adapter.baseSessionDate = new Date(2026, 10, 14, 18, 0, 0);

  // 1-to-1 Iqbal Mahmood Durjoy suite covering split patterns 1-7 & 9
  const rowsHtml = [
    '<div role="row" data-rect="200,40,300,24"><div>Nov 13, 2026, 5:10 PM</div></div>',
    // (1) 2-row Iqbal reply to me ("Durjoy?" -> "Hae")
    '<div role="row" data-rect="12,80,320,42"><div><span>Iqbal Mahmood replied to you</span></div><div data-testid="reply-quote">Durjoy?</div></div>',
    '<div role="row" data-rect="12,124,180,36"><div data-scope="message_content"><div dir="auto">Hae</div></div></div>',
    // (2) 2-row My reply to Iqbal ("Taka ta je dilam na" -> "Sunday nia aisso")
    '<div role="row" data-rect="360,170,320,42"><div><span>You replied to Iqbal Mahmood</span></div><div data-testid="reply-quote">Taka ta je dilam na</div></div>',
    '<div role="row" data-rect="360,214,320,36"><div data-scope="message_content"><div dir="auto">Sunday nia aisso</div></div></div>',
    // (3) Reply + following plain bubble (following bubble must NOT inherit replyTo)
    '<div role="row" data-rect="360,256,320,36"><div data-scope="message_content"><div dir="auto">Ar lab kemon holo?</div></div></div>',
    // (4) 3-row unstyled split (separate label -> plain unstyled quote -> reply bubble with reaction)
    '<div role="row" data-rect="12,300,240,22"><span>Iqbal Mahmood replied to you</span></div>',
    '<div role="row" data-rect="12,324,220,26"><div><span>Tmra to choilla gela</span></div></div>',
    '<div role="row" data-rect="12,354,320,40"><div data-scope="message_content"><div dir="auto">Bhai ki korbo lab er time hoiya jaitesilo</div></div><div aria-label="1 reaction with ❤️">❤️</div></div>',
    // (5) 2-row photo quote ("Sundor") + 2-row video quote ("Eta dekh")
    '<div role="row" data-rect="12,404,240,56"><div><span>Iqbal Mahmood replied to you</span></div><div data-testid="reply-quote"><img src="https://cdn.example/sketch.jpg" width="64" height="64" alt="Photo" /></div></div>',
    '<div role="row" data-rect="12,464,140,36"><div data-scope="message_content"><div dir="auto">Sundor</div></div></div>',
    '<div role="row" data-rect="360,504,240,56"><div><span>You replied to Iqbal Mahmood</span></div><div data-testid="reply-quote"><video src="https://cdn.example/clip.mp4"></video><span>0:05</span></div></div>',
    '<div role="row" data-rect="360,564,180,36"><div data-scope="message_content"><div dir="auto">Eta dekh</div></div></div>',
    // (6) Self-replies ("You replied to yourself" & "Iqbal Mahmood replied to themselves")
    '<div role="row" data-rect="360,608,280,40"><div><span>You replied to yourself</span></div><div data-testid="reply-quote">Amar plan</div></div>',
    '<div role="row" data-rect="360,652,180,36"><div data-scope="message_content"><div dir="auto">Updated</div></div></div>',
    '<div role="row" data-rect="12,696,280,40"><div><span>Iqbal Mahmood replied to themselves</span></div><div data-testid="reply-quote">Kalke 9ta</div></div>',
    '<div role="row" data-rect="12,740,180,36"><div data-scope="message_content"><div dir="auto">10ta korsi</div></div></div>',
    // (7) Opposite-side intervening message while my reply stays attached to the following outgoing reply
    '<div role="row" data-rect="360,784,280,40"><div><span>You replied to Iqbal Mahmood</span></div><div data-testid="reply-quote">Ki obostha?</div></div>',
    '<div role="row" data-rect="12,828,160,36"><div data-scope="message_content"><div dir="auto">Wait ek sec</div></div></div>',
    '<div role="row" data-rect="360,868,200,36"><div data-scope="message_content"><div dir="auto">Ha bol</div></div></div>',
    // (8) Bengali 2-row reply
    '<div role="row" data-rect="360,910,280,40"><div><span>আপনি Iqbal Mahmood-কে উত্তর দিয়েছেন</span></div><div data-testid="reply-quote">কেমন আছো?</div></div>',
    '<div role="row" data-rect="360,954,200,36"><div data-scope="message_content"><div dir="auto">ভালো আছি</div></div></div>'
  ];

  const { doc } = createMockPane(rowsHtml, 'Iqbal Mahmood Durjoy');
  adapter.getChatName = () => 'Iqbal Mahmood Durjoy';
  adapter.getUserAccountName = () => 'S.I.MiHAN';

  const msgs = adapter.extractMessages(doc);
  const quoteTextsAsBody = new Set(['Durjoy?', 'Taka ta je dilam na', 'Tmra to choilla gela', 'Amar plan', 'Kalke 9ta', 'Ki obostha?', 'কেমন আছো?']);
  for (const m of msgs) {
    assert.ok(!quoteTextsAsBody.has(m.text), `Quote preview text must NEVER become message body: got "${m.text}"`);
  }

  assert.strictEqual(msgs.length, 11, `Expected 11 actual messages without duplicate quote blocks, got ${msgs.length}: ${msgs.map(m => m.text).join(' | ')}`);

  // Check Iqbal 2-row reply -> ONE message, full chatName preserved (not truncated to "Iqbal Mahmood")
  assert.strictEqual(msgs[0].sender, 'Iqbal Mahmood Durjoy');
  assert.strictEqual(msgs[0].isMe, false);
  assert.strictEqual(msgs[0].text, 'Hae');
  assert.deepStrictEqual(msgs[0].replyTo, {
    sender: 'S.I.MiHAN',
    text: 'Durjoy?',
    type: 'text',
    mediaType: null,
    senderIsMe: true
  });

  // Check my reply -> "Sunday nia aisso"
  assert.strictEqual(msgs[1].sender, 'S.I.MiHAN');
  assert.strictEqual(msgs[1].isMe, true);
  assert.strictEqual(msgs[1].text, 'Sunday nia aisso');
  assert.strictEqual(msgs[1].replyTo.sender, 'Iqbal Mahmood');
  assert.strictEqual(msgs[1].replyTo.text, 'Taka ta je dilam na');

  // Following plain bubble must NOT inherit replyTo
  assert.strictEqual(msgs[2].text, 'Ar lab kemon holo?');
  assert.strictEqual(msgs[2].replyTo, null);

  // 3-row unstyled split + reaction
  assert.strictEqual(msgs[3].text, 'Bhai ki korbo lab er time hoiya jaitesilo');
  assert.strictEqual(msgs[3].replyTo.text, 'Tmra to choilla gela');
  assert.strictEqual(msgs[3].replyTo.senderIsMe, true);
  assert.ok(msgs[3].reactions.some(r => r.includes('❤️')));

  // Photo & Video quote chips
  assert.strictEqual(msgs[4].text, 'Sundor');
  assert.strictEqual(msgs[4].replyTo.mediaType, 'image');
  assert.strictEqual(msgs[4].replyTo.text, '');

  assert.strictEqual(msgs[5].text, 'Eta dekh');
  assert.strictEqual(msgs[5].replyTo.mediaType, 'video');
  assert.strictEqual(msgs[5].replyTo.text, '');

  // Self-replies
  assert.strictEqual(msgs[6].text, 'Updated');
  assert.strictEqual(msgs[6].replyTo.senderIsMe, true);
  assert.strictEqual(msgs[6].replyTo.text, 'Amar plan');
  assert.strictEqual(msgs[7].text, '10ta korsi');
  assert.strictEqual(msgs[7].replyTo.senderIsMe, false);
  assert.strictEqual(msgs[7].replyTo.text, 'Kalke 9ta');

  // Opposite-side intervening message stayed clean, outgoing pending reply attached after it
  assert.strictEqual(msgs[8].text, 'Wait ek sec');
  assert.strictEqual(msgs[8].isMe, false);
  assert.strictEqual(msgs[8].replyTo, null);
  assert.strictEqual(msgs[9].text, 'Ha bol');
  assert.strictEqual(msgs[9].isMe, true);
  assert.strictEqual(msgs[9].replyTo.text, 'Ki obostha?');

  // Bengali 2-row reply
  assert.strictEqual(msgs[10].text, 'ভালো আছি');
  assert.strictEqual(msgs[10].replyTo.sender, 'Iqbal Mahmood');
  assert.strictEqual(msgs[10].replyTo.text, 'কেমন আছো?');
});

await test('Orphan reply fallback and Group chat reply attribution work cleanly', () => {
  const adapter = new MessengerAdapter();
  adapter.resetSessionDates();
  const orphanPane = createMockPane([
    '<div role="row" data-rect="360,80,280,40"><div><span>You replied to Iqbal</span></div><div data-testid="reply-quote">Old question</div></div>',
    '<div role="row" data-rect="12,130,180,36"><div data-scope="message_content"><div dir="auto">Other msg</div></div></div>',
    '<div role="row" data-rect="12,174,180,36"><div data-scope="message_content"><div dir="auto">Second msg</div></div></div>'
  ], 'Iqbal Mahmood Durjoy');
  adapter.getChatName = () => 'Iqbal Mahmood Durjoy';
  adapter.getUserAccountName = () => 'S.I.MiHAN';

  const orphanMsgs = adapter.extractMessages(orphanPane.doc);
  assert.strictEqual(orphanMsgs[0].text, '(reply content not captured)');
  assert.strictEqual(orphanMsgs[0].incomplete, true);
  assert.strictEqual(orphanMsgs[0].isMe, true);
  assert.strictEqual(orphanMsgs[0].replyTo.text, 'Old question');
  assert.strictEqual(orphanMsgs[1].text, 'Other msg');
  assert.strictEqual(orphanMsgs[1].replyTo, null);
  assert.strictEqual(adapter.getAuditSnapshot().orphanRepliesCount, 1);

  const grpAdapter = new MessengerAdapter();
  grpAdapter.resetSessionDates();
  const grpPane = createMockPane([
    '<div role="row" data-rect="12,80,280,40"><div><span>Karim replied to Rahim</span></div><div data-testid="reply-quote">Class hobe?</div></div>',
    '<div role="row" data-rect="12,126,180,36"><div data-scope="message_content"><div dir="auto">Hae 2tay</div></div></div>'
  ], 'CS Study Group');
  grpAdapter.getChatName = () => 'CS Study Group';
  grpAdapter.getUserAccountName = () => 'S.I.MiHAN';

  const grpMsgs = grpAdapter.extractMessages(grpPane.doc);
  assert.strictEqual(grpMsgs.length, 1);
  assert.strictEqual(grpMsgs[0].sender, 'Karim');
  assert.strictEqual(grpMsgs[0].replyTo.sender, 'Rahim');
  assert.strictEqual(grpMsgs[0].replyTo.text, 'Class hobe?');
  assert.strictEqual(grpMsgs[0].text, 'Hae 2tay');
});

await test('Encryption intro strips contact header & deduplicates; partial participant name ("Iqbal Mahmood") is ui-noise, never UNRECOGNIZED', () => {
  const cleanedIntro = extractCleanIntroSystemText('Iqbal Mahmood Durjoy Messages and calls are secured with end-to-end encryption. Learn more');
  assert.strictEqual(cleanedIntro, 'Messages and calls are secured with end-to-end encryption.');
  assert.strictEqual(isParticipantOrAvatarNameOnly('Iqbal Mahmood', { chatName: 'Iqbal Mahmood Durjoy' }), true);
  assert.strictEqual(isParticipantOrAvatarNameOnly('Shariful Islam', { myName: 'Shariful Islam Mihan' }), true);
  assert.strictEqual(isParticipantOrAvatarNameOnly('Hello there', { chatName: 'Iqbal Mahmood Durjoy' }), false);

  const adapter = new MessengerAdapter();
  adapter.resetSessionDates();
  const pane = createMockPane([
    '<div role="row" data-rect="150,40,400,60"><div>Iqbal Mahmood Durjoy Messages and calls are secured with end-to-end encryption. Learn more</div></div>',
    '<div role="row" data-rect="150,110,400,60"><div>Iqbal Mahmood Durjoy Messages and calls are secured with end-to-end encryption. Learn more</div></div>',
    '<div role="row" data-rect="12,180,140,20"><span>Iqbal Mahmood</span></div>',
    '<div role="row" data-rect="12,210,180,36"><div data-scope="message_content"><div dir="auto">Hi</div></div></div>'
  ], 'Iqbal Mahmood Durjoy');
  adapter.getChatName = () => 'Iqbal Mahmood Durjoy';
  adapter.getUserAccountName = () => 'S.I.MiHAN';

  const msgs = adapter.extractMessages(pane.doc);
  const sysMsgs = msgs.filter(m => m.type === 'system');
  assert.strictEqual(sysMsgs.length, 1, 'Duplicate intro blocks should deduplicate to 1');
  assert.strictEqual(sysMsgs[0].text, 'Messages and calls are secured with end-to-end encryption.');
  assert.strictEqual(msgs.some(m => m.type === 'unrecognized'), false, 'Partial avatar name must never become UNRECOGNIZED');
  assert.strictEqual(adapter.getAuditSnapshot().unrecognizedCount, 0);
  assert.strictEqual(msgs.filter(m => m.type === 'text').length, 1);
  assert.strictEqual(msgs.find(m => m.type === 'text').text, 'Hi');
});

await test('Approximate time legend appears in .docx, .txt, and .pdf only when timestampApproximate messages exist', async () => {
  const approxMsgs = [
    {
      id: 'a1',
      sender: 'Iqbal Mahmood Durjoy',
      direction: 'in',
      timestamp: new Date(2026, 10, 13, 17, 10, 0).getTime(),
      timestampApproximate: true,
      text: 'Hae',
      type: 'text'
    }
  ];
  const exactMsgs = [
    {
      id: 'e1',
      sender: 'Iqbal Mahmood Durjoy',
      direction: 'in',
      timestamp: new Date(2026, 10, 13, 17, 10, 0).getTime(),
      timestampApproximate: false,
      text: 'Hae',
      type: 'text'
    }
  ];
  const legend = '~ Approximate time (Messenger shows exact times only at some points in the chat).';
  const stats = { chatName: 'Iqbal Mahmood Durjoy', platform: 'Messenger', chatType: 'one_to_one' };
  const opts = { platform: 'Messenger', chatName: 'Iqbal Mahmood Durjoy', myName: 'S.I.MiHAN', includeSummary: true, includeTimestamps: true };

  assert.ok(buildTxtContent(approxMsgs, stats, opts).includes(legend));
  assert.ok(buildPdfHtml(approxMsgs, stats, opts).includes(legend));
  const approxDocx = await buildDocxDocument(approxMsgs, stats, opts, () => { }, docx);
  const approxXml = unzipDocxDocumentXml(await approxDocx.Packer.toBuffer(approxDocx.doc), 'approx_yes');
  assert.ok(approxXml.includes(legend));

  assert.ok(!buildTxtContent(exactMsgs, stats, { ...opts, platform: 'WhatsApp' }).includes(legend));
  assert.ok(!buildPdfHtml(exactMsgs, stats, { ...opts, platform: 'WhatsApp' }).includes(legend));
  const exactDocx = await buildDocxDocument(exactMsgs, stats, { ...opts, platform: 'WhatsApp' }, () => { }, docx);
  const exactXml = unzipDocxDocumentXml(await exactDocx.Packer.toBuffer(exactDocx.doc), 'approx_no');
  assert.ok(!exactXml.includes(legend));
});

await test('WhatsApp vs Messenger produce identical normalized replyTo and identical .docx / .txt reply block output via shared renderers', async () => {
  const fixedTs = new Date(2026, 10, 13, 17, 10, 0);

  // 1. Extract via WhatsAppAdapter
  const waAdapter = new WhatsAppAdapter();
  const waPane = createMockPane([
    `<div role="row" data-id="false_1@c.us_AAA" class="message-in" data-pre-plain-text="[5:10 PM, 11/13/2026] Iqbal: ">
      <div data-testid="quoted-message"><span dir="auto">You</span><span class="selectable-text">Durjoy?</span></div>
      <span class="selectable-text copyable-text">Hae</span>
    </div>`,
    `<div role="row" data-id="true_1@c.us_BBB" class="message-out" data-pre-plain-text="[5:10 PM, 11/13/2026] You: ">
      <div data-testid="quoted-message"><span dir="auto">Iqbal</span><span class="selectable-text">Taka ta je dilam na</span></div>
      <span class="selectable-text copyable-text">Sunday nia aisso</span>
    </div>`
  ], 'Iqbal');
  const waCtx = { chatName: 'Iqbal', myName: 'S.I.MiHAN', chatType: 'one_to_one' };
  const waRows = Array.from(waPane.container.children);
  const waMsgs = waRows.map(r => ({
    ...waAdapter.parseMessageRow(r, waCtx),
    timestamp: fixedTs.getTime(),
    timestampApproximate: false
  }));
  waMsgs[0].isMe = false;
  waMsgs[0].direction = 'in';
  waMsgs[0].sender = 'Iqbal';
  waMsgs[1].isMe = true;
  waMsgs[1].direction = 'out';
  waMsgs[1].sender = 'S.I.MiHAN';

  // 2. Extract via MessengerAdapter (2-row split replies)
  const msgrAdapter = new MessengerAdapter();
  msgrAdapter.resetSessionDates();
  const msgrPane = createMockPane([
    '<div role="row" data-rect="12,60,300,40"><div><span>Iqbal replied to you</span></div><div data-testid="reply-quote">Durjoy?</div></div>',
    '<div role="row" data-rect="12,104,160,36"><div data-scope="message_content"><div dir="auto">Hae</div></div></div>',
    '<div role="row" data-rect="360,150,300,40"><div><span>You replied to Iqbal</span></div><div data-testid="reply-quote">Taka ta je dilam na</div></div>',
    '<div role="row" data-rect="360,194,240,36"><div data-scope="message_content"><div dir="auto">Sunday nia aisso</div></div></div>'
  ], 'Iqbal');
  msgrAdapter.getChatName = () => 'Iqbal';
  msgrAdapter.getUserAccountName = () => 'S.I.MiHAN';
  const msgrMsgs = msgrAdapter.extractMessages(msgrPane.doc).map(m => ({
    ...m,
    timestamp: fixedTs.getTime(),
    timestampApproximate: false,
    direction: m.isMe ? 'out' : 'in'
  }));

  assert.strictEqual(waMsgs.length, 2);
  assert.strictEqual(msgrMsgs.length, 2);
  assert.deepStrictEqual(msgrMsgs[0].replyTo, waMsgs[0].replyTo, 'Incoming replyTo shape must match WhatsApp identically');
  assert.deepStrictEqual(msgrMsgs[1].replyTo, waMsgs[1].replyTo, 'Outgoing replyTo shape must match WhatsApp identically');

  // 3. Pass both through prepareMessagesForExport + groupMessagesForExport + shared renderers
  const sharedOpts = {
    platform: 'Shared',
    chatName: 'Iqbal',
    myName: 'S.I.MiHAN',
    groupBySender: false,
    layout: 'bubbles',
    colorMode: 'color',
    includeTimestamps: true
  };
  const waBlocks = groupMessagesForExport(prepareMessagesForExport(waMsgs, sharedOpts), { groupBySender: false }).days[0].blocks;
  const msgrBlocks = groupMessagesForExport(prepareMessagesForExport(msgrMsgs, sharedOpts), { groupBySender: false }).days[0].blocks;

  assert.strictEqual(waBlocks.length, 2);
  assert.strictEqual(msgrBlocks.length, 2, 'Messenger must produce 2 single reply blocks, NEVER 4');

  const txtCtx = {
    includeTimestamps: true,
    groupBySender: false,
    showReactions: true,
    showMediaLabels: true,
    hideQuotedReplies: false,
    timeFormat: '12h',
    platform: 'Shared',
    resolvedMyName: 'S.I.MiHAN',
    chatName: 'Iqbal',
    isGroupChat: false
  };
  const docxCtx = {
    docxLib: docx,
    effectiveLayout: 'bubbles',
    isBW: false,
    colorMode: 'color',
    isGroupChat: false,
    resolvedMyName: 'S.I.MiHAN',
    chatName: 'Iqbal',
    colorBySender: new Map([['S.I.MiHAN', '1B5E3F'], ['Iqbal', '1D4ED8']]),
    includeTimestamps: true,
    groupBySender: false,
    timeFormat: '12h',
    platform: 'Shared',
    showReactions: true,
    showMediaLabels: true,
    hideQuotedReplies: false
  };

  for (let i = 0; i < 2; i++) {
    assert.deepStrictEqual(renderTxtBlock(msgrBlocks[i], txtCtx), renderTxtBlock(waBlocks[i], txtCtx), `TXT reply block #${i} must be identical`);
    assert.strictEqual(JSON.stringify(renderDocxBlock(msgrBlocks[i], docxCtx)), JSON.stringify(renderDocxBlock(waBlocks[i], docxCtx)), `DOCX reply block #${i} must be identical`);
  }

  // Also check full .docx export of Messenger replies produces 2 reply quote boxes & no duplicate body paragraphs
  const { doc, Packer } = await buildDocxDocument(msgrMsgs, { chatName: 'Iqbal', platform: 'Messenger', chatType: 'one_to_one' }, { ...sharedOpts, platform: 'Messenger', includeSummary: false }, () => { }, docx);
  const fullXml = unzipDocxDocumentXml(await Packer.toBuffer(doc), 'msgr_iqbal_snapshot');
  assert.strictEqual((fullXml.match(/w:val="ChatQuote"/g) || []).length, 2);
  assert.ok(fullXml.includes('↪ Replying to S.I.MiHAN'));
  assert.ok(fullXml.includes('↪ Replying to Iqbal'));
  assert.ok(fullXml.includes('Sunday nia aisso'));
});

console.log('\n=== PART 10: Icon-Only Messages (Like/Sticker/GIF/Emoji), Unique Counts & Pruned Skeletons ===');

await test('Like (thumbs-up) icon-only rows in left and right directions extract as type "like" with text "👍" and no SVG title leak', () => {
  const adapter = new MessengerAdapter();
  adapter.resetSessionDates();
  adapter.getChatName = () => 'Sudipta Roy';
  adapter.getUserAccountName = () => 'Mihan';
  const svgPath = 'M 10 20 C 30 40 50 60 70 80 L 90 100 '.repeat(8).trim();
  const pane = createMockPane([
    `<div role="row" data-rect="12,60,120,44"><div role="img" aria-label="Like, thumbs up" data-rect="16,64,36,36"><svg viewBox="0 0 36 36"><title id="js_1">Thumbs up sign</title><path d="${svgPath}"></path></svg></div></div>`,
    `<div role="row" data-rect="420,120,120,44"><div role="img" aria-label="Thumbs up" data-rect="500,124,36,36"><svg viewBox="0 0 36 36"><title id="js_2">Thumbs up sign</title><path d="${svgPath}"></path></svg></div></div>`,
    `<div role="row" data-rect="12,180,120,44"><div role="img" aria-label="লাইক, থাম্বস আপ" data-rect="16,184,36,36"><svg viewBox="0 0 36 36"><title id="js_3">Thumbs up sign</title><path d="${svgPath}"></path></svg></div></div>`,
    `<div role="row" data-rect="420,240,120,44"><div data-rect="500,244,36,36"><svg viewBox="0 0 36 36"><title id="js_4">Thumbs up sign</title><path d="${svgPath}"></path></svg></div></div>`
  ], 'Sudipta Roy');

  const msgs = adapter.extractMessages(pane.doc);
  assert.strictEqual(msgs.length, 4, 'All 4 thumbs-up rows must be extracted');
  for (let i = 0; i < 4; i++) {
    assert.strictEqual(msgs[i].type, 'like', `row ${i} type must be like`);
    assert.strictEqual(msgs[i].text, '👍', `row ${i} text must be 👍`);
    assert.ok(!String(msgs[i].text).includes('Thumbs up sign'), 'SVG title must never leak into message text');
  }
  assert.strictEqual(msgs[0].isMe, false);
  assert.strictEqual(msgs[1].isMe, true);
  assert.strictEqual(msgs[2].isMe, false);
  assert.strictEqual(msgs[3].isMe, true);

  const audit = adapter.getAuditSnapshot();
  assert.strictEqual(audit.uniqueUnrecognized, 0);
  assert.strictEqual(audit.unrecognizedCount, 0);
});

await test('Stickers, GIFs, emoji-only <img> rows, and unknown icon bubbles extract cleanly; Like never dropped when showMediaLabels=false', async () => {
  const { buildPdfHtml: buildPdfFn } = await import('../lib/exporter-pdf.js');
  const { renderExportPreview: renderPreviewFn } = await import('../sidepanel/sidepanel.js');

  const adapter = new MessengerAdapter();
  adapter.resetSessionDates();
  adapter.getChatName = () => 'Sudipta Roy';
  adapter.getUserAccountName = () => 'Mihan';
  const pane = createMockPane([
    `<div role="row" data-rect="12,40,160,120"><div role="img" aria-label="Sticker, Animated waving hand" data-rect="16,44,120,110"></div></div>`,
    `<div role="row" data-rect="420,170,220,140"><img alt="Happy dance GIF" src="https://media.giphy.com/media/abc/giphy.gif" data-rect="424,174,180,130" /></div>`,
    `<div role="row" data-rect="12,320,100,40"><img alt="😂" src="https://static.xx.fbcdn.net/images/emoji.php/v9/t1/16/1f602.png" data-rect="16,324,32,32" /></div>`,
    `<div role="row" data-rect="420,370,100,40"><img alt="❤️" src="https://static.xx.fbcdn.net/images/emoji.php/v9/t2/16/2764.png" data-rect="500,374,32,32" /></div>`,
    `<div role="row" data-rect="12,420,140,50"><div data-scope="message_content" role="img" aria-label="Custom Poker Chip Badge" data-rect="16,424,48,40"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"></circle></svg></div></div>`
  ], 'Sudipta Roy');

  const msgs = adapter.extractMessages(pane.doc);
  assert.strictEqual(msgs.length, 5);
  assert.strictEqual(msgs[0].type, 'sticker');
  assert.ok(msgs[0].mediaDescription.includes('Animated waving hand'));
  assert.strictEqual(msgs[1].type, 'gif');
  assert.ok(msgs[1].mediaDescription.includes('Happy dance GIF'));
  assert.strictEqual(msgs[2].type, 'text');
  assert.strictEqual(msgs[2].text, '😂');
  assert.strictEqual(msgs[2].isMe, false);
  assert.strictEqual(msgs[3].type, 'text');
  assert.strictEqual(msgs[3].text, '❤️');
  assert.strictEqual(msgs[3].isMe, true);
  assert.strictEqual(msgs[4].type, 'other');

  const audit = adapter.getAuditSnapshot();
  assert.strictEqual(audit.uniqueUnrecognized, 0);
  assert.strictEqual(audit.otherIconMessagesCount, 1);

  const exportMsgs = [
    { type: 'like', text: '👍', isMe: false, sender: 'Sudipta Roy', timestamp: new Date(2026, 10, 12, 17, 12).getTime(), direction: 'in' },
    { ...msgs[0], isMe: true, sender: 'Mihan', timestamp: new Date(2026, 10, 12, 17, 13).getTime(), direction: 'out' },
    { ...msgs[1], isMe: false, sender: 'Sudipta Roy', timestamp: new Date(2026, 10, 12, 17, 14).getTime(), direction: 'in' }
  ];
  const stats = { chatName: 'Sudipta Roy', platform: 'Messenger', chatType: 'one_to_one' };

  // When showMediaLabels is OFF, Like STILL exports as 👍 across TXT, DOCX, PDF, and Preview
  const optsOff = { platform: 'Messenger', chatName: 'Sudipta Roy', myName: 'Mihan', showMediaLabels: false, includeSummary: false, groupBySender: false };
  const txtOff = buildTxtContent(exportMsgs, stats, optsOff);
  assert.ok(txtOff.includes('👍'), 'TXT must include 👍 even when showMediaLabels is OFF');
  assert.ok(!txtOff.includes('[Sticker'), 'Sticker is skipped when showMediaLabels is OFF');

  const { doc: docOff, Packer: PackerOff } = await buildDocxDocument(exportMsgs, stats, optsOff, () => { }, docx);
  const xmlOff = unzipDocxDocumentXml(await PackerOff.toBuffer(docOff), 'like_off');
  assert.ok(xmlOff.includes('👍'), 'DOCX must include 👍 even when showMediaLabels is OFF');
  assert.ok(!xmlOff.includes('> Like<') && !xmlOff.includes('>Like<'), 'DOCX must not append Like label when showMediaLabels is OFF');

  const pdfOff = buildPdfFn(exportMsgs, stats, optsOff);
  assert.ok(pdfOff.includes('👍'), 'PDF must include 👍 even when showMediaLabels is OFF');
  assert.ok(!pdfOff.includes('>Like<'), 'PDF must not show Like label when showMediaLabels is OFF');

  // When showMediaLabels is ON, Like shows 👍 + muted Like label, and Sticker/GIF chips appear
  const optsOn = { ...optsOff, showMediaLabels: true };
  const txtOn = buildTxtContent(exportMsgs, stats, optsOn);
  assert.ok(txtOn.includes('👍') && txtOn.includes('Animated waving hand') && txtOn.includes('Happy dance GIF'));

  const { doc: docOn, Packer: PackerOn } = await buildDocxDocument(exportMsgs, stats, optsOn, () => { }, docx);
  const xmlOn = unzipDocxDocumentXml(await PackerOn.toBuffer(docOn), 'like_on');
  assert.ok(xmlOn.includes('👍') && xmlOn.includes(' Like') && xmlOn.includes('Animated waving hand'));

  const pdfOn = buildPdfFn(exportMsgs, stats, optsOn);
  assert.ok(pdfOn.includes('👍') && pdfOn.includes('>Like<') && pdfOn.includes('Animated waving hand'));

  // Preview rendering check for Like when showMediaLabels OFF vs ON
  const env = createSidepanelTestEnv();
  const capturedLines = [];
  env.installGlobals();
  try {
    const origCreateEl = document.createElement;
    document.createElement = (tag) => {
      const el = origCreateEl(tag);
      el.children = [];
      el.appendChild = (ch) => { el.children.push(ch); capturedLines.push(ch); return ch; };
      return el;
    };
    if (!document.createTextNode) {
      document.createTextNode = (t) => ({ nodeType: 3, textContent: String(t) });
    }
    env.el('exp-live-preview').appendChild = (ch) => { capturedLines.push(ch); return ch; };
    setPanelTestState({ messages: exportMsgs, stats, platform: 'Messenger' });
    env.el('exp-media-labels').checked = false;
    renderPreviewFn();
    const textDumpOff = JSON.stringify(capturedLines);
    assert.ok(textDumpOff.includes('👍'), 'Preview must keep 👍 when showMediaLabels is OFF');
    assert.ok(!textDumpOff.includes('"Like"'), 'Preview must omit Like label when showMediaLabels is OFF');

    capturedLines.length = 0;
    env.el('exp-media-labels').checked = true;
    renderPreviewFn();
    const textDumpOn = JSON.stringify(capturedLines);
    assert.ok(textDumpOn.includes('👍') && textDumpOn.includes('"Like"'), 'Preview must show 👍 and Like label when showMediaLabels is ON');
  } finally {
    env.restoreGlobals();
  }
});

await test('12 overlapping snapshots of same Like + weekday separator produce 1 message, uniqueRowsSeen deduplicated, and sightings=12', () => {
  const adapter = new MessengerAdapter();
  adapter.resetSessionDates();
  adapter.baseSessionDate = SCAN_DATE_NOV_13_FRI;
  adapter.getChatName = () => 'Sudipta Roy';
  adapter.getUserAccountName = () => 'Mihan';

  const pane = createMockPane([
    `<div role="row" data-rect="0,10,760,24"><h4 dir="auto" data-scope="date_break" data-rect="300,10,160,20">Mon 3:28 PM</h4></div>`,
    `<div role="row" data-rect="12,50,180,36"><div data-scope="message_content"><div dir="auto">Ki obostha</div></div></div>`,
    `<div role="row" data-rect="12,96,120,44"><div role="img" aria-label="Like, thumbs up" data-rect="16,100,36,36"><svg viewBox="0 0 36 36"><title id="js_99">Thumbs up sign</title><path d="M 1 2 L 3 4"></path></svg></div></div>`
  ], 'Sudipta Roy');

  const master = [];
  for (let snap = 0; snap < 12; snap++) {
    // Re-extracting the same live DOM rows across 12 overlapping scroll steps
    const msgs = adapter.extractMessages(pane.doc);
    mergeSnapshot(master, msgs);
  }

  const likes = master.filter(m => m.type === 'like');
  assert.strictEqual(likes.length, 1, 'Overlapping snapshots must collapse into 1 Like message');
  assert.strictEqual(master.length, 2, 'Total unique messages = 1 text + 1 Like');

  const audit = adapter.getAuditSnapshot();
  assert.strictEqual(audit.uniqueRowsSeen, 3, '3 unique candidate rows (1 separator + 1 text + 1 Like) despite 12 snapshots');
  assert.strictEqual(audit.uniqueSeparators, 1, '1 unique weekday separator');
  assert.strictEqual(audit.uniqueUnrecognized, 0);
  assert.strictEqual(audit.sightings.rowSightings, 36, '12 snapshots * 3 rows = 36 row sightings');
  assert.strictEqual(audit.sightings.separatorSightings, 12, '12 separator sightings');
  assert.strictEqual(audit.resolvedWeekdays.length, 1, 'resolvedWeekdays must be deduplicated');
  assert.strictEqual(audit.resolvedWeekdays[0].raw, 'Mon 3:28 PM');
  assert.strictEqual(audit.resolvedWeekdays[0].sightings, 12);

  // Also test ScanSession._finalize marks this healthy
  const session = new ScanSession(() => { }, { adapter, container: {}, doc: { querySelector: () => null } });
  const finalized = session._finalize(master, { overlapMergesCount: 11, noOverlapEventsCount: 0, myNameOverride: 'Mihan', isWhatsApp: false });
  assert.strictEqual(finalized.integrity.audit.healthy, true, 'Healthy must be true when only Like messages & weekday separators exist');
});

await test('3 distinct Like rows across overlapping snapshots preserve all 3 👍 messages and stay healthy', () => {
  const adapter = new MessengerAdapter();
  adapter.resetSessionDates();
  adapter.getChatName = () => 'Sudipta Roy';
  adapter.getUserAccountName = () => 'Mihan';

  const pane = createMockPane([
    `<div role="row" data-rect="12,40,120,44"><div role="img" aria-label="Like, thumbs up" data-rect="16,44,36,36"><svg viewBox="0 0 36 36"><title id="js_a">Thumbs up sign</title><path d="M 1 2"></path></svg></div></div>`,
    `<div role="row" data-rect="420,96,120,44"><div role="img" aria-label="Like, thumbs up" data-rect="500,100,36,36"><svg viewBox="0 0 36 36"><title id="js_b">Thumbs up sign</title><path d="M 1 2"></path></svg></div></div>`,
    `<div role="row" data-rect="12,152,180,36"><div data-scope="message_content"><div dir="auto">Ok done</div></div></div>`,
    `<div role="row" data-rect="12,196,120,44"><div role="img" aria-label="Like, thumbs up" data-rect="16,200,36,36"><svg viewBox="0 0 36 36"><title id="js_c">Thumbs up sign</title><path d="M 1 2"></path></svg></div></div>`
  ], 'Sudipta Roy');

  const master = [];
  for (let snap = 0; snap < 5; snap++) {
    mergeSnapshot(master, adapter.extractMessages(pane.doc));
  }
  const likes = master.filter(m => m.type === 'like');
  assert.strictEqual(likes.length, 3, 'All 3 distinct Like messages must be preserved');
  assert.strictEqual(adapter.getAuditSnapshot().uniqueUnrecognized, 0);
});

await test('Pruned DOM skeleton (<800 chars, strips class/style/SVG d=), unique unrecognized warning & buildDebugReport(false) privacy', async () => {
  const { buildPrunedDomSkeleton: buildSkelFn } = await import('../content/selectors.js');
  const { buildDebugReport: buildReportFn, renderCompleteDashboard: renderDashFn } = await import('../sidepanel/sidepanel.js');

  const longClasses = 'x1n2onr6 x1ja2u2z x9f619 x78zum5 xdt5ytf x2lah0s x193iq5w '.repeat(15);
  const longPath = 'M 10 20 C 30 40 50 60 70 80 L 90 100 '.repeat(30);
  const adapter = new MessengerAdapter();
  adapter.resetSessionDates();
  adapter.getChatName = () => 'Sudipta Roy';
  adapter.getUserAccountName = () => 'Mihan';

  const pane = createMockPane([
    `<div role="row" data-rect="12,20,220,36"><div data-scope="message_content"><div dir="auto">Before secret context</div></div></div>`,
    `<div role="row" class="${longClasses}" style="background-color:red; padding:12px" data-rect="12,68,260,80"><div class="${longClasses}" data-testid="mystery-widget" role="group" aria-label="Mystery Interactive Poll"><div class="${longClasses}"><span class="inner-lbl">Secret Poll Text Inside Row</span></div><svg><title>Custom Widget</title><path d="${longPath}"></path></svg></div></div>`,
    `<div role="row" data-rect="420,160,220,36"><div data-scope="message_content"><div dir="auto">After secret context</div></div></div>`
  ], 'Sudipta Roy');

  // Verify buildPrunedDomSkeleton directly as well
  const weirderEl = pane.doc.querySelectorAll('[role="row"]')[1];
  const skelRedacted = buildSkelFn(weirderEl, { maxChars: 800, includeSampleText: false });
  assert.ok(skelRedacted.length <= 800, 'Pruned skeleton must fit <= 800 chars');
  assert.ok(!skelRedacted.includes('x1n2onr6'), 'Skeleton must strip class attributes');
  assert.ok(!skelRedacted.includes('background-color'), 'Skeleton must strip style attributes');
  assert.ok(!skelRedacted.includes('M 10 20 C 30'), 'Skeleton must strip SVG path d= data');
  assert.ok(!skelRedacted.includes('Secret Poll Text Inside Row'), 'Redacted skeleton must replace text with [text]');
  assert.ok(skelRedacted.includes('[text]') && skelRedacted.includes('aria-label="Mystery Interactive Poll"'));

  const master = [];
  for (let snap = 0; snap < 5; snap++) {
    mergeSnapshot(master, adapter.extractMessages(pane.doc));
  }

  const session = new ScanSession(() => { }, { adapter, container: {}, doc: { querySelector: () => null } });
  const finalized = session._finalize(master, { overlapMergesCount: 4, noOverlapEventsCount: 0, myNameOverride: 'Mihan', isWhatsApp: false });
  const audit = finalized.integrity.audit;

  assert.strictEqual(audit.healthy, false, 'Truly unrecognized row must set healthy=false');
  assert.strictEqual(audit.uniqueUnrecognized, 1, '5 sightings of 1 unique unrecognized row -> uniqueUnrecognized=1');
  assert.strictEqual(audit.unrecognizedCount, 1);
  assert.strictEqual(audit.sightings.unrecognizedSightings, 5);
  assert.strictEqual(audit.unrecognizedSamples.length, 1);
  assert.strictEqual(audit.unrecognizedSamples[0].sightings, 5);
  assert.ok(audit.unrecognizedSamples[0].skeleton.length <= 800);

  const env = createSidepanelTestEnv();
  env.installGlobals();
  try {
    const stats = {
      ...finalized.stats,
      chatName: 'Sudipta Roy',
      platform: 'Messenger',
      integrity: finalized.integrity
    };
    setPanelTestState({ messages: finalized.messages, stats, platform: 'Messenger', scanPhase: 'done' });
    renderDashFn(stats);

    const incompleteReasonText = env.el('cc-incomplete-reason').textContent;
    assert.ok(incompleteReasonText.includes('1 unrecognized row(s)'), 'Banner shows unique unrecognized count');
    assert.ok(incompleteReasonText.includes('Mystery Interactive Poll'), 'Banner includes descriptive sample label/context');

    // Privacy check: includeSampleText=false must omit chat text
    const redactedReport = buildReportFn(false);
    assert.strictEqual(redactedReport.counts.uniqueUnrecognized, 1);
    assert.strictEqual(redactedReport.counts.sightings.unrecognizedSightings, 5);
    const rSample = redactedReport.unrecognizedSamples[0];
    assert.strictEqual(rSample.sightings, 5);
    assert.ok(rSample.skeleton.length <= 800);
    assert.ok(!('text' in rSample) && !('textPreview' in rSample) && !('prevMessageText' in rSample) && !('nextMessageText' in rSample),
      'buildDebugReport(false) must omit message text fields');
    const serializedRedacted = JSON.stringify(redactedReport);
    assert.ok(!serializedRedacted.includes('Secret Poll Text Inside Row'), 'buildDebugReport(false) must not leak row text');
    assert.ok(!serializedRedacted.includes('Before secret context') && !serializedRedacted.includes('After secret context'),
      'buildDebugReport(false) must not leak neighbor context');

    // When includeSampleText=true, sample text and neighbors are present
    const fullReport = buildReportFn(true);
    const fSample = fullReport.unrecognizedSamples[0];
    assert.ok(fSample.textPreview.includes('Secret Poll Text Inside Row'));
    assert.strictEqual(fSample.prevMessageText, 'Before secret context');
    assert.strictEqual(fSample.nextMessageText, 'After secret context');
  } finally {
    env.restoreGlobals();
  }
});

console.log('\n=== PART 11: Smart Verification, WeakMap Cache & Phase UI ===');

function createVirtualizedSmartVerifyEnv(allItems, opts = {}) {
  const {
    clientHeight = 500,
    rowHeight = 100,
    chatName = 'Sudipta Roy',
    pass2ExtraItems = [],
    overrideWindow = null
  } = opts;

  const builtAll = allItems.map(html => parseHtmlElement(html));
  const builtExtra = pass2ExtraItems.map(item => ({
    index: item.index,
    el: parseHtmlElement(item.html)
  }));

  const pane = createMockPane([], chatName);
  const vContainer = pane.container;
  vContainer.clientHeight = clientHeight;
  vContainer.scrollHeight = Math.max(clientHeight, builtAll.length * rowHeight);
  vContainer.scrollTop = 0;

  let pass2Active = false;
  const syncWindow = () => {
    const top = vContainer.scrollTop;
    const startIdx = Math.max(0, Math.floor(top / rowHeight));
    const endIdx = Math.min(builtAll.length, Math.ceil((top + clientHeight) / rowHeight) + 1);
    let win = overrideWindow
      ? overrideWindow({ top, startIdx, endIdx, builtAll, builtExtra, pass2Active })
      : builtAll.slice(startIdx, endIdx);
    if (!overrideWindow && pass2Active && builtExtra.length > 0) {
      const injected = [...win];
      for (const ex of builtExtra) {
        if (ex.index >= startIdx && ex.index <= endIdx) {
          injected.splice(Math.max(0, Math.min(injected.length, ex.index - startIdx)), 0, ex.el);
        }
      }
      win = injected;
    }
    pane.main._children = win;
    pane.main.childNodes = win;
  };
  syncWindow();

  const listeners = new Map();
  vContainer.addEventListener = (ev, cb) => {
    if (!listeners.has(ev)) listeners.set(ev, []);
    listeners.get(ev).push(cb);
  };
  vContainer.dispatchEvent = (ev) => {
    if (ev?.type === 'scroll') syncWindow();
    for (const cb of listeners.get(ev?.type) || []) cb(ev);
  };

  const adapter = new MessengerAdapter();
  adapter.isCenteredOutsideBubble = (el) => {
    const t = (el?.textContent || '').trim();
    return /^\w{3}\s+\d{1,2},\s+\d{4}/.test(t) || /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{1,2}:\d{2}/.test(t);
  };
  adapter.findMessageContainer = () => vContainer;
  adapter.hasReachedTop = (c) => ({ reached: c.scrollTop <= 2, reason: 'scrollTop_zero_idle' });
  adapter.hasReachedBottom = (c) => ({ reached: c.scrollTop + c.clientHeight >= c.scrollHeight - 4 });

  return {
    vDoc: pane.doc,
    vContainer,
    adapter,
    setPass2Active: (val) => { pass2Active = Boolean(val); syncWindow(); },
    builtAll
  };
}

function buildCleanMessengerHtmlList(count = 16) {
  const list = ['<div role="row" data-rect="0,10,760,24"><span>Oct 22, 2026, 2:00 PM</span></div>'];
  for (let i = 0; i < count; i++) {
    const isMe = i % 2 === 1;
    const min = String(i + 1).padStart(2, '0');
    if (isMe) {
      list.push(`
        <div role="row" data-rect="0,${40 + i * 100},760,48">
          <div role="gridcell" data-testid="message-container" data-rect="480,${44 + i * 100},250,40">
            <span class="sr-only">You sent</span>
            <div data-scope="message_content" data-rect="520,${46 + i * 100},190,34" style="background-color: rgb(120, 60, 240);">
              <div dir="auto">My clean msg ${i + 1} (${min})</div>
            </div>
          </div>
        </div>
      `);
    } else {
      list.push(`
        <div role="row" data-rect="0,${40 + i * 100},760,48">
          <div data-rect="12,${50 + i * 100},28,28"><img alt="Sudipta Roy" width="28" height="28" src="avatar.jpg" data-rect="12,${50 + i * 100},28,28" /></div>
          <div data-scope="message_content" data-rect="52,${44 + i * 100},220,36"><div dir="auto">Sudipta msg ${i + 1} (${min})</div></div>
        </div>
      `);
    }
  }
  return list;
}

await test('Part 11.1: shouldRunSmartVerification covers all 6 triggers and clean skip', async () => {
  const clean = shouldRunSmartVerification({
    noOverlapEventsCount: 0,
    gapEventsCount: 0,
    uniqueUnrecognized: 0,
    orphanRepliesCount: 0,
    directionLowConfidence: false,
    dateOrderViolationsCount: 0,
    stepErrorsCount: 0
  });
  assert.strictEqual(clean.needed, false);
  assert.deepEqual(clean.reasons, []);

  assert.strictEqual(shouldRunSmartVerification({ gapEventsCount: 1 }).needed, true);
  assert.strictEqual(shouldRunSmartVerification({ noOverlapEventsCount: 1 }).needed, true);
  assert.strictEqual(shouldRunSmartVerification({ uniqueUnrecognized: 1 }).needed, true);
  assert.strictEqual(shouldRunSmartVerification({ orphanRepliesCount: 1 }).needed, true);
  assert.strictEqual(shouldRunSmartVerification({ directionLowConfidence: true }).needed, true);
  assert.strictEqual(shouldRunSmartVerification({ dateOrderViolationsCount: 1 }).needed, true);
  assert.strictEqual(shouldRunSmartVerification({ stepErrorsCount: 1 }).needed, true);

  assert.strictEqual(countReadingOrderDateViolations([
    { timestamp: '2026-10-22T15:00:00.000Z' },
    { timestamp: '2026-10-22T14:00:00.000Z' }
  ]), 1);
  assert.strictEqual(countReadingOrderDateViolations([
    { timestamp: '2026-10-22T14:00:00.000Z' },
    { timestamp: '2026-10-22T15:00:00.000Z' }
  ]), 0);
});

await test('Part 11.2: Clean Messenger scan skips Pass 2, uses WeakMap cache without double counting, marks Verification not needed', async () => {
  const htmlRows = buildCleanMessengerHtmlList(16);
  const { vDoc, vContainer, adapter } = createVirtualizedSmartVerifyEnv(htmlRows);
  const events = [];

  const prevMO = globalThis.MutationObserver;
  globalThis.MutationObserver = class { observe() { } disconnect() { } };
  let result;
  try {
    const session = new ScanSession((ev) => events.push(ev), { adapter, container: vContainer, doc: vDoc });
    session.beginningReached = true;
    session.state = 'ready';
    result = await session.startReading({ myNameOverride: 'Mihan' });
  } finally {
    globalThis.MutationObserver = prevMO;
  }

  assert.strictEqual(result.messages.length, 16);
  assert.strictEqual(result.integrity.audit.verificationRan, false);
  assert.strictEqual(result.integrity.audit.verificationSkipped, true);
  assert.strictEqual(result.integrity.audit.verificationStatus, 'Skipped');
  assert.strictEqual(result.integrity.audit.verificationLabel, 'Verification: not needed');
  assert.strictEqual(result.integrity.audit.pass2DurationMs, 0);
  assert.ok(result.integrity.audit.pass1DurationMs >= 0);
  assert.strictEqual(events.filter(e => e.phase === 'verifying').length, 0, 'No verifying events when skipped');

  // WeakMap parse cache assertions: classify called once per live row, repeat snapshots reuse cache
  const snapAudit = adapter.getAuditSnapshot();
  assert.strictEqual(snapAudit.classifyCallsCount, snapAudit.uniqueRowsSeen, 'Each unique DOM row classified once');
  assert.ok(snapAudit.rowParseCacheHits > 0, `Expected WeakMap parse cache hits > 0, got ${snapAudit.rowParseCacheHits}`);
  assert.ok(snapAudit.sightings.rowSightings > snapAudit.uniqueRowsSeen, 'Overlapping scroll produces multiple sightings');
  assert.strictEqual(snapAudit.messagesExported, 16, 'messagesExported must not double-count cached overlaps');
  assert.strictEqual(result.integrity.audit.uniqueRowsSeen, 17, '1 separator + 16 messages = 17 unique rows');
});

await test('Part 11.3: Smart Verification runs automatically on Pass 1 triggers and recovers missed messages without recounting counter', async () => {
  const htmlRows = buildCleanMessengerHtmlList(14);
  // Inject an UNRECOGNIZED row mid-chat so Smart Verification triggers by default (thoroughVerify false)
  htmlRows.splice(6, 0, ROW_FIXTURES.unrecognizedWeirdRow);

  const extraMissedHtml = `
    <div role="row" data-rect="0,610,760,48">
      <div role="gridcell" data-testid="message-container" data-rect="480,614,250,40">
        <span class="sr-only">You sent</span>
        <div data-scope="message_content" data-rect="520,616,190,34" style="background-color: rgb(120, 60, 240);">
          <div dir="auto">Recovered at half step</div>
        </div>
      </div>
    </div>
  `;

  const { vDoc, vContainer, adapter, setPass2Active } = createVirtualizedSmartVerifyEnv(htmlRows, {
    pass2ExtraItems: [{ index: 7, html: extraMissedHtml }]
  });
  const events = [];
  let switchedToVerify = false;

  const prevMO = globalThis.MutationObserver;
  globalThis.MutationObserver = class { observe() { } disconnect() { } };
  let result;
  try {
    const session = new ScanSession((ev) => {
      events.push(ev);
      if (ev.phase === 'verifying' && !switchedToVerify) {
        switchedToVerify = true;
        setPass2Active(true);
      }
    }, { adapter, container: vContainer, doc: vDoc });
    session.beginningReached = true;
    session.state = 'ready';
    result = await session.startReading({ myNameOverride: 'Mihan' });
  } finally {
    globalThis.MutationObserver = prevMO;
  }

  assert.strictEqual(result.integrity.audit.verificationRan, true, 'Smart Verification must run on unrecognized row');
  assert.strictEqual(result.integrity.audit.verificationSkipped, false);
  assert.ok(result.integrity.audit.verificationTriggerReasons.includes('unrecognized_rows'));
  assert.strictEqual(result.integrity.audit.verificationRecoveredCount, 1);
  assert.strictEqual(result.integrity.audit.verificationStatus, 'Recovered 1 message');

  const readingLastCount = events.filter(e => e.phase === 'reading').pop()?.count;
  const verifyEvents = events.filter(e => e.phase === 'verifying');
  assert.ok(verifyEvents.length > 0, 'Verifying phase emitted progress');
  assert.ok(verifyEvents.every(e => e.count === readingLastCount), 'Message counter must NOT increment during verification pass');
  assert.ok(result.messages.some(m => m.text.includes('Recovered at half step')), 'Recovered message merged into masterList');

  // Date-order violation trigger test
  const dateViolRows = buildCleanMessengerHtmlList(10);
  dateViolRows.splice(5, 0, '<div role="row" data-rect="0,480,760,24"><span>Oct 20, 2026, 9:00 AM</span></div>');
  const dEnv = createVirtualizedSmartVerifyEnv(dateViolRows);
  globalThis.MutationObserver = class { observe() { } disconnect() { } };
  try {
    const dSession = new ScanSession(() => { }, { adapter: dEnv.adapter, container: dEnv.vContainer, doc: dEnv.vDoc });
    dSession.beginningReached = true;
    dSession.state = 'ready';
    const dRes = await dSession.startReading({ myNameOverride: 'Mihan' });
    assert.strictEqual(dRes.integrity.audit.verificationRan, true, 'Date-order violation triggers Smart Verification');
    assert.ok(dRes.integrity.audit.verificationTriggerReasons.includes('date_order_violation'));
  } finally {
    globalThis.MutationObserver = prevMO;
  }
});

await test('Part 11.4: Thorough toggle runs Pass 2 on clean chat; WhatsApp remains unaffected; Verify now runs on demand', async () => {
  // 1) Thorough mode ON forces Pass 2 on clean chat
  const htmlRows = buildCleanMessengerHtmlList(12);
  const { vDoc, vContainer, adapter } = createVirtualizedSmartVerifyEnv(htmlRows);
  const prevMO = globalThis.MutationObserver;
  globalThis.MutationObserver = class { observe() { } disconnect() { } };
  let skippedRes;
  let thoroughRes;
  try {
    const s1 = new ScanSession(() => { }, { adapter, container: vContainer, doc: vDoc });
    s1.beginningReached = true;
    s1.state = 'ready';
    skippedRes = await s1.startReading({ myNameOverride: 'Mihan', thoroughVerify: false });
    assert.strictEqual(skippedRes.integrity.audit.verificationStatus, 'Skipped');

    const s2 = new ScanSession(() => { }, { adapter, container: vContainer, doc: vDoc });
    s2.beginningReached = true;
    s2.state = 'ready';
    thoroughRes = await s2.startReading({ myNameOverride: 'Mihan', thoroughVerify: true });
    assert.strictEqual(thoroughRes.integrity.audit.verificationRan, true);
    assert.strictEqual(thoroughRes.integrity.audit.verificationStatus, 'Ran');
    assert.ok(thoroughRes.integrity.audit.pass2DurationMs >= 0);

    // 2) On-demand Verify Now via sidepanel runVerifyNow + scanner runOnDemandVerification
    const env = createSidepanelTestEnv();
    env.installGlobals();
    try {
      await finalizeAndSaveScan(skippedRes);
      assert.strictEqual(env.el('cc-aud-verify-status').textContent, 'Skipped');
      assert.strictEqual(env.el('cc-verify-note').textContent, 'Verification: not needed');
      assert.strictEqual(env.el('int-verify-status').textContent, 'Skipped');

      const verifyRes = await runVerifyNow({
        tabId: 101,
        skipReadyCheck: true,
        sendMessage: async (_tabId, msg) => {
          assert.strictEqual(msg.type, 'VERIFY_NOW');
          const updated = await runOnDemandVerification(msg.payload, (ev) => updateScanProgress(ev), {
            adapter,
            container: vContainer,
            doc: vDoc
          });
          return { ok: true, payload: updated };
        }
      });
      assert.ok(verifyRes && verifyRes.integrity.audit.verificationRan === true);
      assert.strictEqual(env.el('cc-aud-verify-status').textContent, 'Ran');
      assert.strictEqual(env.el('int-verify-status').textContent, 'Ran');
      assert.ok(env.el('cc-aud-timings').textContent.includes('P2 '), `Expected P2 timing, got ${env.el('cc-aud-timings').textContent}`);
    } finally {
      env.restoreGlobals();
    }

    // 3) WhatsApp clean scan continues to skip Pass 2 by default (no regression)
    const waRows = [
      { id: 'w1', sender: 'Me', text: 'Hi', timestamp: new Date('2026-10-22T10:00:00Z'), isMe: true, type: 'text' },
      { id: 'w2', sender: 'Friend', text: 'Hey', timestamp: new Date('2026-10-22T10:01:00Z'), isMe: false, type: 'text' }
    ];
    const waContainer = {
      scrollTop: 0, scrollHeight: 1500, clientHeight: 500,
      addEventListener() { },
      dispatchEvent() { },
      querySelectorAll: () => []
    };
    const waAdapter = {
      name: 'WhatsApp',
      resetSessionDates() { },
      extractMessages: () => waRows.slice(),
      hasReachedBottom: (c) => ({ reached: c.scrollTop + c.clientHeight >= c.scrollHeight - 4 }),
      detectChatType: () => 'one-to-one',
      getChatName: () => 'Friend',
      detectMyProfileName: () => 'Me'
    };
    const waSession = new ScanSession(() => { }, { adapter: waAdapter, container: waContainer, doc: paneDocPlaceholder(waContainer) });
    waSession.beginningReached = true;
    waSession.state = 'ready';
    const waRes = await waSession.startReading({ myNameOverride: 'Me' });
    assert.strictEqual(waRes.integrity.audit.verificationRan, false);
    assert.strictEqual(waRes.messages.length, 2);
  } finally {
    globalThis.MutationObserver = prevMO;
  }
});

function paneDocPlaceholder(container) {
  return {
    title: 'WhatsApp',
    body: container,
    querySelector: () => container,
    querySelectorAll: () => []
  };
}

await test('Part 11.5: Sidepanel Stepper shows Reading messages then Verifying with own progress bar and fixed message counter', async () => {
  const env = createSidepanelTestEnv();
  env.installGlobals();
  try {
    setStepperPhase('reading');
    updateScanProgress({ phase: 'reading', count: 42, percent: 80 });
    assert.strictEqual(env.el('step-2-label').textContent, 'Reading messages');
    assert.strictEqual(env.el('scan-title').textContent, 'Reading messages');
    assert.ok(env.el('verify-progress-box').classList.contains('hidden'), 'Verify bar hidden during Pass 1');
    assert.strictEqual(env.el('scan-count').textContent, '42');
    assert.strictEqual(env.el('scan-count-label').textContent, 'Messages read: 42');
    assert.strictEqual(env.el('reading-bar').style.width, '80%');

    updateScanProgress({ phase: 'verifying', count: 999, percent: 65, verifyPercent: 65 });
    assert.strictEqual(env.el('step-2-label').textContent, 'Verifying');
    assert.strictEqual(env.el('scan-title').textContent, 'Verifying');
    assert.ok(!env.el('verify-progress-box').classList.contains('hidden'), 'Verify bar visible during Pass 2');
    assert.strictEqual(env.el('verifying-bar').style.width, '65%');
    assert.strictEqual(env.el('verifying-progress').getAttribute('aria-valuenow'), '65');
    // Crucial: counter remains at 42 from Pass 1, never overwritten by 999
    assert.strictEqual(env.el('scan-count').textContent, '42');
    assert.strictEqual(env.el('scan-count-label').textContent, 'Messages read: 42');
  } finally {
    env.restoreGlobals();
  }
});

function readZipEntriesFromBuffer(buf) {
  let eocdOffset = -1;
  const minOffset = Math.max(0, buf.length - 65558);
  for (let i = buf.length - 22; i >= minOffset; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  assert.ok(eocdOffset >= 0, 'ZIP End of Central Directory not found');
  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  const entries = new Map();
  let pos = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    assert.strictEqual(buf.readUInt32LE(pos), 0x02014b50, 'Invalid Central Directory signature');
    const method = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const fileName = buf.subarray(pos + 46, pos + 46 + nameLen).toString('utf8');
    pos += 46 + nameLen + extraLen + commentLen;

    if (fileName.endsWith('/')) continue;
    assert.strictEqual(buf.readUInt32LE(localOffset), 0x04034b50, `Invalid local header for ${fileName}`);
    const lhNameLen = buf.readUInt16LE(localOffset + 26);
    const lhExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    const data = method === 0 ? raw : zlib.inflateRawSync(raw);
    entries.set(fileName, Buffer.from(data));
  }
  return entries;
}

console.log('\n=== PART 12: Version Management, Update Flow, Migration & Handshake ===');

await test('12.1 validateRepoVersions passes on repo and catches version mismatches / hard-coded strings', () => {
  const clean = validateRepoVersions();
  assert.strictEqual(clean.ok, true, `Expected clean repo check, got errors: ${clean.errors.join('; ')}`);
  assert.strictEqual(clean.version, APP_VERSION);
  assert.strictEqual(APP_VERSION_TAG, `v${APP_VERSION}`);
  assert.strictEqual(APP_DISPLAY_VERSION, `ChatFlow v${APP_VERSION}`);
  assert.ok(isValidChromeVersion(APP_VERSION));
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(RELEASE_DATE));

  const pkgMismatch = validateRepoVersions({
    fileOverrides: {
      'package.json': JSON.stringify({ name: 'chatflow', version: '2.4.0' }, null, 2)
    }
  });
  assert.strictEqual(pkgMismatch.ok, false);
  assert.ok(pkgMismatch.errors.some(e => e.includes('package.json')));

  const hardCoded = validateRepoVersions({
    fileOverrides: {
      'content/selectors.js': `export const BAD = '${APP_VERSION}';\n`
    }
  });
  assert.strictEqual(hardCoded.ok, false);
  assert.ok(hardCoded.errors.some(e => e.includes('content/selectors.js')));

  assert.strictEqual(bumpVersionString('2.5.0', 'patch'), '2.5.1');
  assert.strictEqual(bumpVersionString('2.5.0', 'minor'), '2.6.0');
  assert.strictEqual(bumpVersionString('2.5.0', 'major'), '3.0.0');
  assert.strictEqual(isValidChromeVersion('2.5.0-beta'), false);
});

await test('12.1b buildReleaseZip creates clean extension-only ZIP without dev/test directories', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatflow-zip-test-'));
  try {
    const outZip = path.join(tmpDir, `chatflow-v${APP_VERSION}.zip`);
    const result = buildReleaseZip({ outFile: outZip });
    assert.ok(fs.existsSync(outZip));
    assert.strictEqual(result.version, APP_VERSION);

    const zipEntries = readZipEntriesFromBuffer(fs.readFileSync(outZip));
    const names = Array.from(zipEntries.keys());
    assert.ok(names.includes('manifest.json'));
    assert.ok(names.includes('src/version.js'));
    assert.ok(names.includes('CHANGELOG.md'));
    assert.ok(names.includes('sidepanel/sidepanel.js'));
    assert.ok(names.includes('_locales/en/messages.json'));
    for (const forbidden of ['scratch/', 'node_modules/', 'fixtures/', 'scripts/', 'docs/', '.git/', 'RELEASING.md']) {
      assert.ok(!names.some(n => n.startsWith(forbidden) || n === forbidden), `Forbidden entry in zip: ${forbidden}`);
    }
    assert.ok(!names.some(n => n.endsWith('.zip') || n.endsWith('.map')));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

await test('12.2 handleInstalled + checkAndRenderWhatsNew show What\'s New once on update and sync version UI', async () => {
  const env = createSidepanelTestEnv();
  env.installGlobals();
  try {
    syncVersionLabels();
    assert.strictEqual(env.el('setting-ext-version').textContent, `ChatFlow v${APP_VERSION}`);
    assert.strictEqual(env.el('app-footer-version').textContent, `ChatFlow v${APP_VERSION}`);
    renderSettingsChangelog();
    assert.ok(Array.isArray(CHANGELOG_SUMMARY) && CHANGELOG_SUMMARY.length >= 1);
    assert.ok(env.el('settings-changelog-content').children.length >= 1);
    assert.ok(env.el('settings-changelog-content').children[0].children[0].textContent.includes(`v${APP_VERSION}`));

    // Fresh install must NOT display update What's New card
    await handleInstalled({ reason: 'install' });
    const shownOnInstall = await checkAndRenderWhatsNew();
    assert.strictEqual(shownOnInstall, false);
    assert.ok(env.el('whats-new-card').classList.contains('hidden'));

    // Extension update from 2.4.0 must set update notice and display What's New once
    await handleInstalled({ reason: 'update', previousVersion: '2.4.0' });
    assert.strictEqual(env.localStore.chatflow_update_notice.updatedFrom, '2.4.0');
    assert.strictEqual(env.localStore.chatflow_update_notice.updatedTo, APP_VERSION);
    assert.strictEqual(env.localStore.chatflow_update_notice.dismissed, false);

    const shownOnUpdate = await checkAndRenderWhatsNew();
    assert.strictEqual(shownOnUpdate, true);
    assert.ok(!env.el('whats-new-card').classList.contains('hidden'));
    assert.ok(env.el('whats-new-title').textContent.includes(APP_VERSION));
    assert.strictEqual(env.el('whats-new-list').children.length, Math.min(5, RELEASE_HIGHLIGHTS.length));

    await dismissWhatsNew();
    assert.ok(env.el('whats-new-card').classList.contains('hidden'));
    assert.strictEqual(env.localStore.chatflow_dismissed_whats_new_version, APP_VERSION);
    assert.strictEqual(env.localStore.chatflow_update_notice.dismissed, true);

    const shownAfterDismiss = await checkAndRenderWhatsNew();
    assert.strictEqual(shownAfterDismiss, false);
    assert.ok(env.el('whats-new-card').classList.contains('hidden'));
  } finally {
    env.restoreGlobals();
  }
});

await test('12.3 runVersionMigrations preserves valid user settings, enforces groupBySender=false, prunes obsolete keys, and never throws', async () => {
  const env = createSidepanelTestEnv();
  env.installGlobals();
  try {
    env.localStore.chatflow_my_name = 'S.I.MiHAN';
    env.localStore.chatflow_my_name_by_platform = { whatsapp: 'S.I.MiHAN', messenger: 'S.I.MiHAN' };
    env.localStore.chatflow_chat_prefs = { 'Sudipta Roy': { layout: 'clean' } };
    env.localStore.chatflow_theme = 'dark';
    env.localStore.chatflow_thorough_scan = true;
    env.localStore.chatflow_group_by_sender = true;
    for (const k of OBSOLETE_STORAGE_KEYS) env.localStore[k] = 'legacy';

    const res = await runVersionMigrations({ previousVersion: '2.4.0', currentVersion: APP_VERSION, reason: 'update' });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(env.localStore.chatflow_my_name, 'S.I.MiHAN');
    assert.deepStrictEqual(env.localStore.chatflow_my_name_by_platform, { whatsapp: 'S.I.MiHAN', messenger: 'S.I.MiHAN' });
    assert.deepStrictEqual(env.localStore.chatflow_chat_prefs, { 'Sudipta Roy': { layout: 'clean' } });
    assert.strictEqual(env.localStore.chatflow_theme, 'dark');
    assert.strictEqual(env.localStore.chatflow_thorough_scan, true);
    assert.strictEqual(env.localStore.chatflow_group_by_sender, false);
    assert.strictEqual(env.localStore.chatflow_schema_version, APP_VERSION);
    for (const k of OBSOLETE_STORAGE_KEYS) {
      assert.strictEqual(k in env.localStore, false, `Obsolete key should be deleted: ${k}`);
    }

    // Accidental blocked UI name is scrubbed safely
    env.localStore.chatflow_my_name = 'Controls and Settings';
    await runVersionMigrations({ previousVersion: APP_VERSION, currentVersion: APP_VERSION, reason: 'startup' });
    assert.strictEqual(env.localStore.chatflow_my_name, '');

    // Storage throwing must not reject runVersionMigrations
    globalThis.chrome.storage.local.get = () => { throw new Error('Corrupt storage'); };
    const safeRes = await runVersionMigrations({ previousVersion: '2.4.0', currentVersion: APP_VERSION, reason: 'update' });
    assert.strictEqual(typeof safeRes.ok, 'boolean');
  } finally {
    env.restoreGlobals();
  }
});

await test('12.4 verifyContentScriptVersion detects stale or legacy content script and reveals Reload Tab button', async () => {
  const env = createSidepanelTestEnv();
  env.installGlobals();
  try {
    const okRes = await verifyContentScriptVersion(101, {
      sendMessage: async () => ({ ok: true, version: APP_VERSION })
    });
    assert.strictEqual(okRes.ok, true);
    assert.strictEqual(okRes.versionMismatch, false);
    assert.strictEqual(okRes.contentVersion, APP_VERSION);

    const staleRes = await verifyContentScriptVersion(102, {
      sendMessage: async () => ({ ok: true, version: '2.4.0' })
    });
    assert.strictEqual(staleRes.ok, false);
    assert.strictEqual(staleRes.versionMismatch, true);
    assert.strictEqual(staleRes.contentVersion, '2.4.0');
    assert.ok(env.el('state-error').classList.contains('hidden') === false);
    assert.ok(env.el('error-message').textContent.includes('Reload this chat tab'));
    assert.ok(!env.el('btn-reload-tab').classList.contains('hidden'));

    const missingVerRes = await verifyContentScriptVersion(103, {
      sendMessage: async () => ({ ok: true })
    });
    assert.strictEqual(missingVerRes.ok, false);
    assert.strictEqual(missingVerRes.versionMismatch, true);
    assert.strictEqual(missingVerRes.contentVersion, 'unknown');
  } finally {
    env.restoreGlobals();
  }
});

await test('12.5 Version is stamped across .docx properties/footers, .txt, .pdf, debug report, diagnostics & error details', async () => {
  const env = createSidepanelTestEnv();
  env.installGlobals();
  try {
    assert.strictEqual(getExtensionVersion(), APP_VERSION);
    const messages = [
      { id: 'v1', sender: 'S.I.MiHAN', isMe: true, text: 'Version check ping', type: 'text', timestamp: '2026-11-14T10:00:00Z' },
      { id: 'v2', sender: 'Sudipta Roy', isMe: false, text: 'Version check pong', type: 'text', timestamp: '2026-11-14T10:01:00Z' }
    ];
    const stats = buildStats(messages, 'Sudipta Roy', 'messenger', 'S.I.MiHAN');
    stats.integrity = {
      platform: 'messenger',
      chatType: 'one-to-one',
      direction: { healthy: true, warning: null },
      audit: {
        healthy: true,
        uniqueRowsSeen: 2,
        messagesExported: 2,
        verificationRan: false,
        verificationStatus: 'not_needed'
      }
    };
    setPanelTestState({ messages, stats, platform: 'messenger', scanPhase: 'idle' });

    const debugReport = buildDebugReport();
    assert.strictEqual(debugReport.extension, 'ChatFlow');
    assert.strictEqual(debugReport.version, APP_VERSION);

    const errJson = JSON.parse(buildErrorDetailsText({ step: 'test', message: 'Boom' }));
    assert.strictEqual(errJson.version, APP_VERSION);

    renderDiagnosticsLog();
    assert.ok(env.el('diag-direction-log').textContent.includes(`ChatFlow v${APP_VERSION}`));

    const txtOut = buildTxtContent(messages, stats, { includeSummary: true });
    assert.ok(txtOut.includes(`CHATFLOW v${APP_VERSION} CHAT EXPORT`));
    assert.ok(txtOut.includes(`Exported with ChatFlow v${APP_VERSION}. Nothing leaves your device.`));

    const pdfOut = buildPdfHtml(messages, stats, { includeSummary: true });
    assert.ok(pdfOut.includes(`ChatFlow v${APP_VERSION}`));
    assert.ok(pdfOut.includes(`Exported with ChatFlow v${APP_VERSION}. Nothing leaves your device.`));

    if (docx) {
      const { doc } = await buildDocxDocument(messages, stats, { includeSummary: true }, () => {}, docx);
      const buf = await docx.Packer.toBuffer(doc);
      const entries = readZipEntriesFromBuffer(Buffer.from(buf));

      const coreXml = entries.get('docProps/core.xml')?.toString('utf8') || '';
      const customXml = entries.get('docProps/custom.xml')?.toString('utf8') || '';
      const appXml = entries.get('docProps/app.xml')?.toString('utf8') || '';
      const documentXml = entries.get('word/document.xml')?.toString('utf8') || '';
      const footerXml = Array.from(entries.entries())
        .filter(([k]) => /^word\/footer\d*\.xml$/.test(k))
        .map(([, v]) => v.toString('utf8'))
        .join('\n');

      assert.ok(coreXml.includes(`ChatFlow v${APP_VERSION}`), 'core.xml should mention extension version');
      assert.ok(customXml.includes('name="ChatFlowVersion"'), 'custom.xml should define ChatFlowVersion');
      assert.ok(customXml.includes(APP_VERSION), 'custom.xml should store current version');
      assert.ok(appXml.includes(`ChatFlow v${APP_VERSION}`), 'app.xml Application should reflect ChatFlow version');
      assert.ok(documentXml.includes(`Exported with ChatFlow v${APP_VERSION}`), 'summary footer must include version');
      assert.ok(footerXml.includes(`ChatFlow v${APP_VERSION}`), 'page footer must include version');
    }
  } finally {
    env.restoreGlobals();
  }
});

console.log('\n=============================================');
console.log(`TOTAL TESTS: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
if (failed > 0) process.exit(1);
