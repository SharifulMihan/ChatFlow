/**
 * scratch/test_all.js
 * Verification suite for ChatFlow scanner state machine, name sanitizer, and top detection.
 */

import { sanitizeChatName, getInitials, INTRO_BLOCK_PATTERNS } from '../content/selectors.js';
import { MessengerAdapter } from '../content/adapters/messenger.js';
import { WhatsAppAdapter } from '../content/adapters/whatsapp.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${message}`);
    failed++;
  }
}

console.log('=== TEST 1: sanitizeChatName Requirements ===');
const sanitizeCases = [
  { input: 'Conversation titled Section~B', expected: 'Section~B' },
  { input: 'Conversation with Raj Roy', expected: 'Raj Roy' },
  { input: 'Section B Pola', expected: 'Section B Pola' },
  { input: 'Conversation titled ফাহিম ভাই', expected: 'ফাহিম ভাই' },
  { input: 'Raj Roy Active 43m ago', expected: 'Raj Roy' },
  { input: 'Conversation Notes', expected: 'Conversation Notes' }, // Edge case: real name starting with Conversation
  { input: '   ', expected: 'Fallback', fallback: 'Fallback' },
  { input: 'Group chat Team Alpha', expected: 'Team Alpha' },
  { input: 'Chat with Bob', expected: 'Bob' },
  { input: 'Conversation in Dhaka Devs', expected: 'Dhaka Devs' },
  { input: 'Conversation about Vacation', expected: 'Vacation' },
  { input: 'Alex & Bob', expected: 'Alex & Bob' },
  { input: 'Project 🚀 Spark', expected: 'Project 🚀 Spark' },
  { input: 'Raj Roy Active now', expected: 'Raj Roy' },
  { input: 'Raj Roy typing...', expected: 'Raj Roy' },
  { input: 'Safa ~072 (B1)', expected: 'Safa ~072 (B1)' }
];

for (const { input, expected, fallback } of sanitizeCases) {
  const result = sanitizeChatName(input, fallback || 'Fallback');
  assert(result === expected, `"${input}" -> "${result}" (expected "${expected}")`);
}

console.log('\n=== TEST 2: getInitials Requirements (Never "CT") ===');
const initialCases = [
  { input: 'Conversation titled Section~B', expected: 'SB' },
  { input: 'Section~B', expected: 'SB' },
  { input: 'Conversation with Raj Roy', expected: 'RR' },
  { input: 'Raj Roy', expected: 'RR' },
  { input: 'Section B Pola', expected: 'SB' },
  { input: 'Conversation titled ফাহিম ভাই', expected: 'ফভ' },
  { input: 'Conversation Notes', expected: 'CN' },
  { input: 'Single', expected: 'SI' }
];

for (const { input, expected } of initialCases) {
  const result = getInitials(input);
  assert(result === expected, `initials("${input}") -> "${result}" (expected "${expected}")`);
  assert(result !== 'CT', `initials("${input}") must NEVER be "CT"`);
}

console.log('\n=== TEST 3: MessengerAdapter Top Detection ===');
const msgr = new MessengerAdapter();

// Mock mock container for intro block
const mockContainerIntroEn = {
  scrollTop: 0,
  clientHeight: 600,
  scrollHeight: 1200,
  innerText: 'Raj Roy\nMessages and calls are secured by end-to-end encryption. Learn more',
  querySelector: () => null
};

const resIntroEn = msgr.hasReachedTop(mockContainerIntroEn);
assert(resIntroEn.reached === true, `Intro block English detected: ${resIntroEn.reason}`);

const mockContainerIntroBn = {
  scrollTop: 0,
  clientHeight: 600,
  scrollHeight: 1200,
  innerText: 'ফাহিম ভাই\nমেসেজ এবং কলগুলি এন্ড-টু-এন্ড এনক্রিপশন দ্বারা সুরক্ষিত।',
  querySelector: () => null
};
const resIntroBn = msgr.hasReachedTop(mockContainerIntroBn);
assert(resIntroBn.reached === true, `Intro block Bengali detected: ${resIntroBn.reason}`);

// Mock scrollTop <= 2 idle check
const mockContainerScrollTop = {
  scrollTop: 0,
  clientHeight: 600,
  scrollHeight: 1200,
  innerText: 'Regular message content here',
  querySelector: () => null
};
const trackerIdle = { attempts: 5, scrollTopZeroChecks: 2, topStableCount: 0 };
const resScrollIdle = msgr.hasReachedTop(mockContainerScrollTop, null, trackerIdle);
assert(resScrollIdle.reached === true, `scrollTop <= 2 idle detected: ${resScrollIdle.reason}`);

// Mock static first message
const mockRow = { innerText: 'First Message Text Here', offsetTop: 20 };
const mockContainerStatic = {
  scrollTop: 10,
  clientHeight: 600,
  scrollHeight: 1200,
  innerText: 'First Message Text Here\nOther text',
  querySelector: (sel) => mockRow
};
const trackerStatic = {
  attempts: 6,
  scrollTopZeroChecks: 0,
  lastTopSig: 'First Message Text Here@20',
  topStableCount: 2
};
const resStatic = msgr.hasReachedTop(mockContainerStatic, null, trackerStatic);
assert(resStatic.reached === true, `Static top element detected: ${resStatic.reason}`);

// Mock hard cap
const trackerCap = { attempts: 40, scrollTopZeroChecks: 0, topStableCount: 0 };
const resCap = msgr.hasReachedTop(mockContainerScrollTop, null, trackerCap);
assert(resCap.reached === true, `Phase 1 hard cap detected: ${resCap.reason}`);

console.log('\n=== TEST 4: Pinned Banner Filtering ===');
const mockHeaderEl = {
  innerText: 'Pinned message\nSafa ~072 (B1): please check',
  closest: () => ({ isPinned: true })
};
assert(msgr.isPinnedBannerElement(mockHeaderEl) === true, 'Pinned banner element correctly identified and rejected');

console.log('\n=== TEST 5: WhatsAppAdapter Top Detection ===');
const wa = new WhatsAppAdapter();
const mockWaContainerIntro = {
  scrollTop: 0,
  clientHeight: 600,
  scrollHeight: 1200,
  innerText: 'Messages and calls are end-to-end encrypted. No one outside of this chat can read or listen to them.',
  querySelector: () => null
};
const resWaTop = wa.hasReachedTop(mockWaContainerIntro);
assert(resWaTop.reached === true, `WhatsApp encryption notice detected: ${resWaTop.reason}`);

console.log('\n=============================================');
console.log(`TOTAL TESTS: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
if (failed > 0) {
  process.exit(1);
} else {
  console.log('ALL VERIFICATIONS PASSED CLEANLY!');
}
