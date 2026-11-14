/**
 * scratch/test_final_pipeline.js
 * End-to-end integration and unit verification for ChatFlow v2.2.2.
 */

import {
  parseDateSeparatorText,
  isValidConversationDate,
  isReplyLabel,
  extractReplySender,
  cleanMessageText
} from '../content/selectors.js';
import { mergeSnapshot } from '../content/scanner.js';
import { buildStats } from '../lib/transcript.js';
import { buildTxtContent } from '../lib/exporter-txt.js';

console.log('========================================================');
console.log('CHATFLOW v2.2.2 FINAL VERIFICATION SUITE');
console.log('========================================================\n');

let totalTests = 0;
let passedTests = 0;

function assert(cond, desc) {
  totalTests++;
  if (cond) {
    passedTests++;
    console.log(`  ✓ ${desc}`);
  } else {
    console.error(`  ✗ FAIL: ${desc}`);
    throw new Error(`Test failed: ${desc}`);
  }
}

// ── 1. Strict Date Separator Parsing ─────────────────────────────────────────
console.log('1. Strict Date Separator Parsing & Validation');

const base = new Date(2026, 4, 11, 10, 0);

// Screenshot 1 & 2 dates
const d1 = parseDateSeparatorText('12/16/25, 12:47 AM', 'MDY', null, base);
assert(d1 !== null && d1.getFullYear() === 2025 && d1.getMonth() === 11 && d1.getDate() === 16, 'Parsed 12/16/25, 12:47 AM accurately');

const d2 = parseDateSeparatorText('12/16/25, 4:58 AM', 'MDY', d1, base);
assert(d2 !== null && d2.getFullYear() === 2025 && d2.getHours() === 4 && d2.getMinutes() === 58, 'Parsed 12/16/25, 4:58 AM accurately');

const d3 = parseDateSeparatorText('Sunday, October 11, 2026', 'MDY', d2, base);
assert(d3 !== null && d3.getFullYear() === 2026 && d3.getMonth() === 9 && d3.getDate() === 11, 'Parsed Sunday, October 11, 2026');

// Rejection of numbers and message text that caused "Jan 50" & 648,964 days
const badDates = [
  '250',
  '300',
  '350',
  '500',
  '500-01',
  'B2',
  'Tumi B2 er Student form submit korba kobe',
  'Unfortunately amr kase B2 er 2 ta form ase',
  '1 or 0',
  '2 ta form',
  'Jan 50',
  '01/01/1950',
  '01/01/2000'
];

for (const b of badDates) {
  const res = parseDateSeparatorText(b, 'MDY', null, base);
  assert(res === null, `Strictly rejected message/invalid date text: "${b}"`);
}

// Year sanity validation
assert(isValidConversationDate(new Date('2025-12-16T00:47:00Z')) === true, '2025 date is valid');
assert(isValidConversationDate(new Date('2000-01-01T00:00:00Z')) === false, 'Epoch 2000-01-01 is rejected');
assert(isValidConversationDate(new Date('1950-01-01T00:00:00Z')) === false, 'Year 1950 is rejected');
assert(isValidConversationDate(new Date('0500-01-01T00:00:00Z')) === false, 'Year 500 is rejected');

// ── 2. Reply Label & Quoted Preview Detection ────────────────────────────────
console.log('\n2. Reply Detection & Quote Handling');

assert(isReplyLabel('Nadira Fairuxa replied to you') === true, 'Detected "Nadira Fairuxa replied to you"');
assert(isReplyLabel('You replied to Nadira Fairuxa') === true, 'Detected "You replied to Nadira Fairuxa"');
assert(isReplyLabel('Nadira Fairuxa replied to themselves') === true, 'Detected self reply label');
assert(isReplyLabel('নাবিলা উত্তর দিয়েছেন') === true, 'Detected Bengali reply label');
assert(isReplyLabel('Tumi B2 er Student form submit korba kobe') === false, 'Real message text is not reply label');

assert(extractReplySender('Nadira Fairuxa replied to you') === 'Me', 'Extracted quoted sender from reply label (Me)');
assert(extractReplySender('You replied to Nadira Fairuxa') === 'Nadira Fairuxa', 'Extracted quoted sender from reply label (Nadira Fairuxa)');

// Message text cleaning
const cleanRes1 = cleanMessageText('You replied to Nadira Fairuxa: Total count of 1 minus total count of zero');
assert(cleanRes1.text === 'Total count of 1 minus total count of zero', 'Cleaned reply prefix from message text');

const cleanRes2 = cleanMessageText('Nadira Fairuxa replied to you');
assert(cleanRes2.isOnlyAccessibility === true, 'Pure reply label flagged as accessibility-only');

// ── 3. Snapshot Overlap Merging & Repeated Identical Messages ────────────────
console.log('\n3. Snapshot Overlap Merging');

const snap1 = [
  { sender: 'Me', type: 'text', text: 'Ok', isMe: true },
  { sender: 'Me', type: 'text', text: 'Ok', isMe: true },
  { sender: 'Me', type: 'text', text: 'Cc', isMe: true }
];

const snap2 = [
  { sender: 'Me', type: 'text', text: 'Ok', isMe: true },
  { sender: 'Me', type: 'text', text: 'Cc', isMe: true },
  { sender: 'Nadira Fairuxa', type: 'text', text: 'Wait ektu vabi', isMe: false }
];

const masterList = [...snap1];
const res = mergeSnapshot(masterList, snap2);

assert(res.overlap === 2, `Detected 2 overlapping messages merged (got ${res.overlap})`);
assert(masterList.length === 4, `Merged count is 4 (got ${masterList.length})`);
assert(masterList[0].text === 'Ok' && masterList[1].text === 'Ok' && masterList[2].text === 'Cc' && masterList[3].text === 'Wait ektu vabi',
  'Preserved repeated identical consecutive messages without dropping');

// ── 4. End-to-End Simulation of Screenshot Conversation ──────────────────────
console.log('\n4. Simulation of Screenshot Messages & Stats');

const simulatedMessages = [
  {
    sender: 'Me',
    isMe: true,
    text: 'Tumi B2 er Student form submit korba kobe',
    timestamp: new Date('2025-12-16T00:47:00Z'),
    type: 'text'
  },
  {
    sender: 'Me',
    isMe: true,
    text: 'Unfortunately amr kase B2 er 2 ta form ase',
    timestamp: new Date('2025-12-16T00:47:00Z'),
    type: 'text'
  },
  {
    sender: 'Me',
    isMe: true,
    text: 'Ami Wednesday amder B1 er gula shob submit kore dibo',
    timestamp: new Date('2025-12-16T00:47:00Z'),
    type: 'text'
  },
  {
    sender: 'Nadira Fairuxa',
    isMe: false,
    text: 'Please return the two forms on Wednesday, I told you to check ejonnei',
    timestamp: new Date('2025-12-16T04:58:00Z'),
    type: 'text',
    replyTo: { sender: 'Me', text: 'Unfortunately amr kase B2 er 2 ta form ase' }
  },
  {
    sender: 'Nadira Fairuxa',
    isMe: false,
    text: "I'm supposed to submit b2's forms to her",
    timestamp: new Date('2025-12-16T04:58:00Z'),
    type: 'text',
    reactions: ['👍'],
    replyTo: { sender: 'Me', text: 'Tumi B2 er Student form submit korba kobe' }
  }
];

const builtStats = buildStats(simulatedMessages, 'Nadira Fairuxa', 'Messenger');
assert(builtStats.totalMessages === 5, 'Total messages = 5');
assert(Object.keys(builtStats.senderCounts).length === 2, 'Exactly 2 participants in 1-to-1 chat');
assert(builtStats.senderCounts['Me'] === 3, 'Me message count = 3');
assert(builtStats.senderCounts['Nadira Fairuxa'] === 2, 'Nadira message count = 2');

const startDate = new Date(builtStats.dateRange.start);
const endDate = new Date(builtStats.dateRange.end);
const spanDays = Math.max(1, Math.round((endDate - startDate) / (1000 * 60 * 60 * 24)));
assert(spanDays === 1, `Date range span is 1 day (was 648,964 days before bugfix)`);

// ── 5. Exporter Output Checks ────────────────────────────────────────────────
console.log('\n5. Exporter Outputs (.txt format)');

builtStats.integrity = {
  totalCaptured: 5,
  overlapMerges: 4,
  noOverlapEvents: 0,
  rejectedSeparatorsCount: 0,
  hasWarning: false
};

const txtOutput = buildTxtContent(simulatedMessages, builtStats, { includeTimestamps: true, platform: 'Messenger' });
assert(txtOutput.includes('CHATFLOW CONVERSATION EXPORT: MESSENGER - Nadira Fairuxa'), 'Header includes proper title');
assert(txtOutput.includes('Overlap Verifications: 4 seamless merges'), 'Integrity summary displayed in header');
assert(txtOutput.includes('(↪ replying to Me: "Unfortunately amr kase B2 er 2 ta form ase")'), 'Reply formatted with ↪ indicator');
assert(txtOutput.includes('[12/16/25') || txtOutput.includes('[Tuesday, December 16, 2025]'), 'Formatted date headers correctly');
assert(!txtOutput.includes('2000'), 'Zero references to year 2000');
assert(!txtOutput.includes('replied to you'), 'Zero reply labels exported as messages');

console.log('\n========================================================');
console.log(`ALL ${passedTests} OF ${totalTests} TESTS PASSED CLEANLY! (100%)`);
console.log('========================================================');
