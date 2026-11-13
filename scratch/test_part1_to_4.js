import assert from 'assert';
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { execSync } from 'child_process';

import {
  sanitizeSenderName,
  isTimeOrDateString,
  detectScriptAndLang,
  isRtlText
} from '../content/selectors.js';
import { WhatsAppAdapter } from '../content/adapters/whatsapp.js';
import { runParticipantSanityCheck } from '../content/scanner.js';
import {
  groupMessagesForExport,
  formatExportTime,
  formatMediaChip
} from '../lib/transcript.js';
import { buildTxtContent } from '../lib/exporter-txt.js';
import { buildDocxDocument } from '../lib/exporter-docx.js';
import { buildPdfHtml } from '../lib/exporter-pdf.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}: ${err.message}`);
    failed++;
  }
}

console.log('=== 1. sanitizeSenderName & Time Rejection ===');
test('strips colons and whitespace: "You::" -> "You"', () => {
  assert.strictEqual(sanitizeSenderName('You::'), 'You');
});
test('strips colons and whitespace: "Raj::" -> "Raj"', () => {
  assert.strictEqual(sanitizeSenderName('Raj::'), 'Raj');
});
test('maps localized You to myName', () => {
  assert.strictEqual(sanitizeSenderName('You::', { myName: 'S.I.MiHAN' }), 'S.I.MiHAN');
  assert.strictEqual(sanitizeSenderName('আপনি:', { myName: 'S.I.MiHAN' }), 'S.I.MiHAN');
  assert.strictEqual(sanitizeSenderName('Tú', { myName: 'S.I.MiHAN' }), 'S.I.MiHAN');
  assert.strictEqual(sanitizeSenderName('Vous', { myName: 'S.I.MiHAN' }), 'S.I.MiHAN');
  assert.strictEqual(sanitizeSenderName('أنت', { myName: 'S.I.MiHAN' }), 'S.I.MiHAN');
});
test('rejects time/date strings as sender names', () => {
  for (const bad of ['1:22 AM', '5:43 PM', '17:45', '11/5/2026', 'Yesterday', 'Today', '~1:22 AM']) {
    assert.strictEqual(isTimeOrDateString(bad), true, `Expected time/date: ${bad}`);
    assert.strictEqual(sanitizeSenderName(bad), null, `Expected null for: ${bad}`);
  }
});
test('strips invisible/RTL control characters', () => {
  assert.strictEqual(sanitizeSenderName('\u200FRaj\u200E::'), 'Raj');
});

console.log('\n=== 2. WhatsApp parsePrePlainText ===');
const wa = new WhatsAppAdapter();
test('parses standard pre-plain-text', () => {
  const res = wa.parsePrePlainText('[1:22 AM, 11/5/2026] S.I.MiHAN: ');
  assert.strictEqual(res.sender, 'S.I.MiHAN');
  assert.ok(res.timestamp instanceof Date && !isNaN(res.timestamp.getTime()));
  assert.strictEqual(res.timestamp.getHours(), 1);
  assert.strictEqual(res.timestamp.getMinutes(), 22);
});
test('parses sender name containing colons up to LAST colon', () => {
  const res = wa.parsePrePlainText('[5:43 PM, 11/5/2026] Name: With: Colon: ');
  assert.strictEqual(res.sender, 'Name: With: Colon');
  assert.strictEqual(res.timestamp.getHours(), 17);
});
test('parses "You::" in pre-plain-text cleanly', () => {
  const res = wa.parsePrePlainText('[10:17 PM, 11/5/2026] You:: ');
  assert.strictEqual(res.sender, 'You');
});

console.log('\n=== 3. One-to-One Participant Enforcement (12 -> 2) ===');
test('enforces exactly 2 participants in 1-to-1 chat', () => {
  const messy = [
    { sender: 'Raj', isMe: false, type: 'text', text: 'hi', timestamp: '2026-01-11T01:22:00Z' },
    { sender: 'S.I.MiHAN', isMe: true, type: 'text', text: 'hello', timestamp: '2026-01-11T01:23:00Z' },
    { sender: 'You::', isMe: true, type: 'text', text: 'how are you', timestamp: '2026-01-11T05:43:00Z' },
    { sender: 'Raj::', isMe: false, type: 'text', text: 'good', timestamp: '2026-01-11T09:48:00Z' },
    { sender: '1:22 AM', isMe: false, type: 'image', text: '[image]', timestamp: '2026-01-11T10:17:00Z' },
    { sender: '5:43 PM', isMe: true, type: 'voice', text: '[voice message]', timestamp: '2026-01-11T17:43:00Z' },
    { sender: '9:48 PM', isMe: false, type: 'sticker', text: '[sticker]', timestamp: '2026-01-11T21:48:00Z' },
    { sender: '10:17 PM', isMe: true, type: 'text', text: 'ok', timestamp: '2026-01-11T22:17:00Z' },
    { sender: '7:20 PM', isMe: false, type: 'text', text: 'see ya', timestamp: '2026-01-11T19:20:00Z' },
    { sender: '2:00 AM', isMe: true, type: 'text', text: 'bye', timestamp: '2026-01-12T02:00:00Z' },
    { sender: '5:02 PM', isMe: false, type: 'text', text: 'yo', timestamp: '2026-01-12T17:02:00Z' },
    { sender: 'Me', isMe: true, type: 'text', text: 'hey', timestamp: '2026-01-12T17:05:00Z' }
  ];
  const res = runParticipantSanityCheck(messy, {
    platform: 'WhatsApp',
    chatType: 'one-to-one',
    chatName: 'Raj',
    myName: 'S.I.MiHAN'
  });
  assert.deepStrictEqual(res.participants.sort(), ['Raj', 'S.I.MiHAN']);
  assert.ok(res.warnings.length >= 2, 'Expected sanity check warnings for time senders & >2 senders');
});

console.log('\n=== 4. Reply Body vs Quote Separation & No "~" on WhatsApp ===');
test('reply body does not duplicate quoted text', () => {
  // Minimal DOM Element mock
  function makeEl({ tag = 'div', attrs = {}, classes = [], text = '', children = [] }) {
    const el = {
      tagName: tag.toUpperCase(),
      nodeType: 1,
      classList: { contains: c => classes.includes(c) },
      getAttribute: k => attrs[k] || null,
      innerText: text,
      textContent: text,
      children,
      contains: target => target === el || children.some(c => c.contains(target)),
      querySelector: sel => el.querySelectorAll(sel)[0] || null,
      querySelectorAll: sel => {
        const out = [];
        const parts = sel.split(',').map(s => s.trim());
        const match = (node) => parts.some(p => {
          if (p === '[data-testid="quoted-message"]') return node.getAttribute('data-testid') === 'quoted-message';
          if (p === 'span.selectable-text' || p === '[data-testid="msg-container"] span.selectable-text') return node.tagName === 'SPAN' && node.classList.contains('selectable-text');
          if (p === '.copyable-text') return node.classList.contains('copyable-text');
          if (p === 'span[dir="auto"]') return node.tagName === 'SPAN' && node.getAttribute('dir') === 'auto';
          if (p === '[data-pre-plain-text]') return !!node.getAttribute('data-pre-plain-text');
          return false;
        });
        const walk = (n) => {
          for (const ch of n.children || []) {
            if (match(ch)) out.push(ch);
            walk(ch);
          }
        };
        walk(el);
        return out;
      },
      closest: () => null
    };
    return el;
  }

  const qSenderNode = makeEl({ tag: 'span', attrs: { dir: 'auto' }, text: 'Raj' });
  const qTextNode = makeEl({ tag: 'span', classes: ['selectable-text'], text: 'Math assignment korbi?' });
  const quoteEl = makeEl({
    attrs: { 'data-testid': 'quoted-message' },
    text: 'Raj\nMath assignment korbi?',
    children: [qSenderNode, qTextNode]
  });
  const replyBodyNode = makeEl({ tag: 'span', classes: ['selectable-text'], text: 'Hae korbo, rat 10tay' });
  const rowEl = makeEl({
    attrs: { 'data-id': 'true_123_abc', 'data-pre-plain-text': '[1:22 AM, 11/5/2026] S.I.MiHAN: ' },
    classes: ['message-out'],
    text: 'Raj\nMath assignment korbi?\nHae korbo, rat 10tay',
    children: [quoteEl, replyBodyNode]
  });

  // Bypass instanceof Element check by temporarily defining global.Element if needed
  const prevElement = global.Element;
  global.Element = Object;
  const parsed = wa.parseMessageRow(rowEl, { chatType: 'one-to-one', chatName: 'Raj', myName: 'S.I.MiHAN' });
  global.Element = prevElement;

  assert.strictEqual(parsed.sender, 'S.I.MiHAN');
  assert.strictEqual(parsed.text, 'Hae korbo, rat 10tay');
  assert.strictEqual(parsed.replyTo.sender, 'Raj');
  assert.strictEqual(parsed.replyTo.text, 'Math assignment korbi?');
  assert.strictEqual(parsed.timestampApproximate, false);
});

test('never shows "~" for WhatsApp, only for Messenger approximate timestamps', () => {
  assert.strictEqual(formatExportTime('2026-01-11T01:22:00Z', '12h', true, 'WhatsApp').includes('~'), false);
  assert.strictEqual(formatExportTime('2026-01-11T01:22:00Z', '12h', false, 'WhatsApp').includes('~'), false);
  assert.strictEqual(formatExportTime('2026-01-11T01:22:00Z', '12h', true, 'Messenger').startsWith('~'), true);
});

console.log('\n=== 5. Message Grouping & Multi-Script Detection ===');
test('groups consecutive messages from same sender within 5 minutes', () => {
  const msgs = [
    { sender: 'Raj', isMe: false, type: 'text', text: 'Hey', timestamp: '2026-01-11T10:00:00Z' },
    { sender: 'Raj', isMe: false, type: 'text', text: 'Math assignment korbi?', timestamp: '2026-01-11T10:02:00Z' },
    { sender: 'Raj', isMe: false, type: 'text', text: 'Ping me', timestamp: '2026-01-11T10:12:00Z' } // >5 min gap
  ];
  const { days } = groupMessagesForExport(msgs, { groupBySender: true });
  assert.strictEqual(days[0].blocks.length, 2);
  assert.strictEqual(days[0].blocks[0].items.length, 2);
  assert.strictEqual(days[0].blocks[1].items.length, 1);
});

test('detects Bengali, Arabic RTL, and media chips', () => {
  assert.strictEqual(detectScriptAndLang('কেমন আছো?').lang, 'bn-BD');
  assert.strictEqual(detectScriptAndLang('مرحبا كيف حالك').rtl, true);
  assert.strictEqual(isRtlText('مرحبا'), true);
  assert.strictEqual(formatMediaChip({ type: 'image' }), '📷 Photo');
  assert.strictEqual(formatMediaChip({ type: 'voice', text: '[voice message (0:14)]' }), '🎤 Voice message (0:14)');
  assert.strictEqual(formatMediaChip({ type: 'file', text: '[document: notes.pdf]' }), '📄 Document: notes.pdf');
});

console.log('\n=== 6. Generate Sample .docx & Verify XML ===');
await (async () => {
  // Load UMD docx.min.js into a sandboxed context
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
  const docxLib = ctx.docx || ctx.window.docx;
  assert.ok(docxLib && docxLib.Document, 'Loaded docx.min.js');

  const sampleMessages = [
    { id: '1', sender: 'System', type: 'system', text: 'Messages and calls are end-to-end encrypted.', timestamp: '2026-01-11T01:20:00.000Z', timestampApproximate: false },
    { id: '2', sender: 'Raj', isMe: false, type: 'text', text: 'Hey! Math assignment korbi?', timestamp: '2026-01-11T01:22:00.000Z', timestampApproximate: false },
    { id: '3', sender: 'Raj', isMe: false, type: 'text', text: 'আজকে রাতে জমা দিতে হবে।', timestamp: '2026-01-11T01:23:00.000Z', timestampApproximate: false },
    { id: '4', sender: 'S.I.MiHAN', isMe: true, type: 'text', text: 'হ্যাঁ করবো! Checking https://example.com right now.', replyTo: { sender: 'Raj', text: 'Math assignment korbi?', type: 'text' }, isEdited: true, reactions: ['😂 Raj'], timestamp: '2026-01-11T01:24:00.000Z', timestampApproximate: false },
    { id: '5', sender: 'S.I.MiHAN', isMe: true, type: 'voice', text: '[voice message (0:14)]', timestamp: '2026-01-11T01:25:00.000Z', timestampApproximate: false },
    { id: '6', sender: 'Raj', isMe: false, type: 'image', text: '[image]', timestamp: '2026-06-15T14:30:00.000Z', timestampApproximate: false },
    { id: '7', sender: 'Raj', isMe: false, type: 'text', text: 'مرحبا صديقي', timestamp: '2026-06-15T14:32:00.000Z', timestampApproximate: false },
    { id: '8', sender: 'S.I.MiHAN', isMe: true, type: 'deleted', text: 'This message was deleted', timestamp: '2026-11-05T17:43:00.000Z', timestampApproximate: false }
  ];

  const sampleStats = {
    chatName: 'Raj',
    platform: 'WhatsApp',
    totalMessages: sampleMessages.length,
    isPartial: false
  };

  const { doc, Packer } = await buildDocxDocument(sampleMessages, sampleStats, {
    layout: 'bubbles',
    includeSummary: true,
    includeTimestamps: true,
    groupBySender: true,
    showReactions: true,
    showMediaLabels: true,
    showSystemMessages: true,
    pageSize: 'A4'
  }, () => {}, docxLib);

  const buf = await Packer.toBuffer(doc);
  const outPath = path.resolve('scratch/sample_export_raj.docx');
  fs.writeFileSync(outPath, buf);
  assert.ok(fs.existsSync(outPath) && buf.length > 5000, 'Sample .docx generated');

  // Extract document.xml using PowerShell Expand-Archive on a .zip copy
  const zipPath = path.resolve('scratch/sample_export_raj.zip');
  const unzipDir = path.resolve('scratch/sample_docx_xml');
  fs.copyFileSync(outPath, zipPath);
  if (fs.existsSync(unzipDir)) fs.rmSync(unzipDir, { recursive: true, force: true });
  execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${unzipDir}' -Force"`);

  const docXml = fs.readFileSync(path.join(unzipDir, 'word/document.xml'), 'utf8');
  assert.ok(docXml.includes('w:noProof'), 'document.xml contains w:noProof');
  assert.ok(docXml.includes('w:bidi'), 'document.xml contains w:bidi for Arabic RTL');
  assert.ok(docXml.includes('bn-BD'), 'document.xml contains bn-BD language tag');
  assert.ok(docXml.includes('ar-SA'), 'document.xml contains ar-SA language tag');
  assert.ok(docXml.includes('ChatName'), 'document.xml uses custom ChatName style');
  assert.ok(!docXml.includes('~01:'), 'WhatsApp .docx must never contain ~ before time');
  assert.ok(!docXml.includes('[image]'), 'Media must use clean chip, not raw [image]');
  assert.ok(docXml.includes('S.I.MiHAN') && docXml.includes('Raj'), 'document.xml includes both participants');
  assert.ok(docXml.includes('1B5E3F') && docXml.includes('1D4ED8'), 'document.xml includes fixed colors for me (1B5E3F) and contact (1D4ED8)');
  assert.ok(docXml.includes('E8F5EE') && docXml.includes('F3F4F6'), 'document.xml visually separates my bubbles (E8F5EE) from contact bubbles (F3F4F6)');

  // Verify fixed color assignment even when contact has more messages than me
  const { participants } = groupMessagesForExport(sampleMessages, { groupBySender: true });
  const meStat = participants.find(p => p.isMe);
  const contactStat = participants.find(p => !p.isMe);
  assert.strictEqual(meStat.name, 'S.I.MiHAN');
  assert.strictEqual(meStat.colorHex, '1B5E3F');
  assert.strictEqual(contactStat.name, 'Raj');
  assert.strictEqual(contactStat.colorHex, '1D4ED8');

  // Also test .txt and PDF HTML
  const txtOut = buildTxtContent(sampleMessages, sampleStats, { platform: 'WhatsApp' });
  assert.ok(!txtOut.includes('~'), 'WhatsApp .txt must never contain ~');
  assert.ok(txtOut.includes('📷 Photo'), 'WhatsApp .txt uses clean media chip');

  const pdfHtml = buildPdfHtml(sampleMessages, sampleStats, { platform: 'WhatsApp' });
  assert.ok(pdfHtml.includes('dir="rtl"'), 'PDF HTML marks RTL text');
  assert.ok(pdfHtml.includes('ChatFlow'), 'PDF HTML includes ChatFlow cover');

  console.log(`  ✓ Sample .docx generated & XML verified (${outPath}, ${buf.length} bytes)`);
  passed++;
})();

console.log(`\n=============================================`);
console.log(`TOTAL TESTS: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
if (failed > 0) process.exit(1);
