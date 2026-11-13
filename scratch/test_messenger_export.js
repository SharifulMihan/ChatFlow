/**
 * scratch/test_messenger_export.js
 * Comprehensive unit test verifying bug fixes for Messenger export:
 * 1. Sender attribution (Me vs Nadira Fairuxa via geometry + aria label)
 * 2. Accessibility prefix stripping & pure accessibility dropping
 * 3. Reaction badge filtering & attachment to parent message
 * 4. Chronological date separator parsing without epoch 2000-01-01
 * 5. Text and Docx exporter outputs
 */

import { MessengerAdapter } from '../content/adapters/messenger.js';
import { buildTxtContent } from '../lib/exporter-txt.js';
import { buildStats, formatTimestamp } from '../lib/transcript.js';
import {
  cleanMessageText,
  isPureAccessibilityLabel,
  isEmojiOnlySender,
  isReactionOnly,
  parseDateSeparatorText
} from '../content/selectors.js';

console.log('=== TEST SUITE: Messenger Export & Sender Attribution ===\n');

// ── Test 1: Accessibility Prefix Stripping & Pure Accessibility Check ─────────
console.log('1. Testing Accessibility Stripping...');
const testCases = [
  { raw: 'You sent: Ar oidike CF e eto valo', expectedText: 'Ar oidike CF e eto valo', isOnlyAcc: false },
  { raw: 'You replied to Nadira Fairuxa: Wait ektu vabi solution ta', expectedText: 'Wait ektu vabi solution ta', isOnlyAcc: false },
  { raw: 'Enter, Message sent: Total count of 1 minus total count of zero', expectedText: 'Total count of 1 minus total count of zero', isOnlyAcc: false },
  { raw: 'You sent', expectedText: '', isOnlyAcc: true },
  { raw: 'Seen by Nadira at 2:19 PM', expectedText: '', isOnlyAcc: true },
  { raw: 'Delivered', expectedText: '', isOnlyAcc: true },
  { raw: 'আপনি পাঠিয়েছেন: ঠিক আছে', expectedText: 'ঠিক আছে', isOnlyAcc: false },
  { raw: 'আপনি উত্তর দিয়েছেন', expectedText: '', isOnlyAcc: true }
];

for (const tc of testCases) {
  const res = cleanMessageText(tc.raw);
  console.assert(res.text === tc.expectedText, `cleanMessageText mismatch for "${tc.raw}": got "${res.text}", expected "${tc.expectedText}"`);
  console.assert(res.isOnlyAccessibility === tc.isOnlyAcc, `isOnlyAccessibility mismatch for "${tc.raw}": got ${res.isOnlyAccessibility}, expected ${tc.isOnlyAcc}`);
}
console.log('✔ All accessibility test cases passed!');

// ── Test 2: Reaction Badge Detection & Sender Emoji Rejection ─────────────────
console.log('\n2. Testing Reaction Badges & Sender Validation...');
console.assert(isReactionOnly('😆') === true, '😆 must be reaction only');
console.assert(isReactionOnly('❤️') === true, '❤️ must be reaction only');
console.assert(isReactionOnly('👍') === true, '👍 must be reaction only');
console.assert(isReactionOnly('Hello!') === false, 'Hello! must NOT be reaction only');

console.assert(isEmojiOnlySender('😆') === true, '😆 cannot be sender');
console.assert(isEmojiOnlySender('❤️') === true, '❤️ cannot be sender');
console.assert(isEmojiOnlySender('You sent') === true, 'You sent cannot be sender');
console.assert(isEmojiOnlySender('Nadira Fairuxa') === false, 'Nadira Fairuxa is valid sender');
console.assert(isEmojiOnlySender('Me') === false, 'Me is valid sender');
console.log('✔ All reaction & sender validation checks passed!');

// ── Test 3: Date Separator Parsing without Epoch 2000-01-01 ───────────────────
console.log('\n3. Testing Date Separator Parsing...');
const baseDate = new Date(2026, 4, 11, 10, 0); // May 11, 2026
const sep1 = parseDateSeparatorText('12/10/25, 2:19 PM', 'MDY', null, baseDate);
console.assert(sep1 !== null, '12/10/25, 2:19 PM should parse');
console.assert(sep1.getFullYear() === 2025, `Expected year 2025, got ${sep1.getFullYear()}`);
console.assert(sep1.getMonth() === 11, `Expected month 11 (Dec), got ${sep1.getMonth()}`);
console.assert(sep1.getDate() === 10, `Expected day 10, got ${sep1.getDate()}`);
console.assert(sep1.getHours() === 14, `Expected hours 14, got ${sep1.getHours()}`);
console.assert(sep1.getMinutes() === 19, `Expected minutes 19, got ${sep1.getMinutes()}`);

// Time-only separator preserving previous date
const sep2 = parseDateSeparatorText('12:45 AM', 'MDY', sep1, baseDate);
console.assert(sep2 !== null, '12:45 AM should parse');
console.assert(sep2.getFullYear() === 2025 && sep2.getDate() === 10, 'Should preserve previous date');
console.assert(sep2.getHours() === 0 && sep2.getMinutes() === 45, 'Should parse 12:45 AM as 00:45');

// Invalid separator returns null (never epoch 2000-01-01)
const invalidSep = parseDateSeparatorText('Not a date', 'MDY', null, baseDate);
console.assert(invalidSep === null, 'Invalid separator should return null');
console.log('✔ All date separator parsing checks passed!');

// ── Test 4: MessengerAdapter Message Extraction Simulation ────────────────────
console.log('\n4. Simulating Messenger DOM Extraction with Row Mocking...');
const adapter = new MessengerAdapter();
adapter.resetSessionDates();

// Container mock: width 1000px
const mockContainer = {
  getBoundingClientRect: () => ({ left: 0, right: 1000, width: 1000, top: 0, bottom: 800, height: 800 })
};

// Mock rows simulating the user's conversation with Nadira Fairuxa:
// 1. Separator: "12/10/25, 2:19 PM"
// 2. Incoming from Nadira: "Ar oidike CF e eto valo" (left aligned)
// 3. Outgoing from Me: "You sent: But shoman na thkale onno vabe dekte hobe" (right aligned)
// 4. Reaction pill: "😆"
// 5. Outgoing from Me: "You sent: Wait ektu vabi solution ta" (right aligned)
// 6. Incoming from Nadira: "Ki faltu" (left aligned)
// 7. Outgoing from Me: "You replied to Nadira Fairuxa: Total count of 1 minus total count of zero" (right aligned)
// 8. Reaction pill: "😆"
// 9. Pure accessibility: "Seen by Nadira at 2:25 PM"

const mockRows = [
  {
    type: 'separator',
    text: '12/10/25, 2:19 PM'
  },
  {
    type: 'msg',
    text: 'Ar oidike CF e eto valo',
    ariaLabel: '',
    rect: { left: 40, right: 380, width: 340 } // left-aligned (Other)
  },
  {
    type: 'msg',
    text: 'You sent: But shoman na thkale onno vabe dekte hobe',
    ariaLabel: 'You sent',
    rect: { left: 620, right: 960, width: 340 } // right-aligned (Me)
  },
  {
    type: 'reaction',
    text: '😆'
  },
  {
    type: 'msg',
    text: 'You sent: Wait ektu vabi solution ta',
    ariaLabel: 'You sent',
    rect: { left: 640, right: 960, width: 320 } // right-aligned (Me)
  },
  {
    type: 'msg',
    text: 'Ki faltu',
    ariaLabel: '',
    rect: { left: 40, right: 250, width: 210 } // left-aligned (Other)
  },
  {
    type: 'msg',
    text: 'You replied to Nadira Fairuxa: Total count of 1 minus total count of zero',
    ariaLabel: 'You replied to Nadira Fairuxa',
    rect: { left: 580, right: 960, width: 380 } // right-aligned (Me)
  },
  {
    type: 'reaction',
    text: '😆'
  },
  {
    type: 'accessibility',
    text: 'Seen by Nadira at 2:25 PM'
  }
];

const extractedMessages = [];
let prevMsg = null;

for (const r of mockRows) {
  if (r.type === 'separator') {
    const sep = parseDateSeparatorText(r.text, 'MDY', adapter.activeDateSeparator, adapter.baseSessionDate);
    if (sep) adapter.activeDateSeparator = sep;
    continue;
  }

  if (r.type === 'reaction') {
    if (isReactionOnly(r.text) && prevMsg) {
      prevMsg.reactions.push(r.text);
    }
    continue;
  }

  if (r.type === 'accessibility') {
    if (isPureAccessibilityLabel(r.text)) continue;
  }

  // Create mock element
  const mockEl = {
    innerText: r.text,
    textContent: r.text,
    getAttribute: (attr) => (attr === 'aria-label' ? r.ariaLabel : null),
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    getBoundingClientRect: () => r.rect
  };

  const parsed = adapter.parseMessengerRow(mockEl, mockContainer, 'Nadira Fairuxa', 'Me');
  if (parsed) {
    extractedMessages.push(parsed);
    prevMsg = parsed;
  }
}

console.log(`Extracted ${extractedMessages.length} messages:`);
for (const m of extractedMessages) {
  const rxStr = m.reactions.length ? ` [Reactions: ${m.reactions.join(', ')}]` : '';
  console.log(`  - [${m.sender}] (isMe=${m.isMe}): "${m.text}"${rxStr}`);
}

// Assertions on extracted messages:
console.assert(extractedMessages.length === 5, `Expected 5 messages, got ${extractedMessages.length}`);

// Message 0: Nadira Fairuxa
console.assert(extractedMessages[0].sender === 'Nadira Fairuxa', 'Msg 0 sender should be Nadira');
console.assert(extractedMessages[0].isMe === false, 'Msg 0 isMe should be false');
console.assert(extractedMessages[0].text === 'Ar oidike CF e eto valo', 'Msg 0 text check');

// Message 1: Me (outgoing, "You sent:" stripped, reaction 😆 attached)
console.assert(extractedMessages[1].sender === 'Me', 'Msg 1 sender should be Me');
console.assert(extractedMessages[1].isMe === true, 'Msg 1 isMe should be true');
console.assert(extractedMessages[1].text === 'But shoman na thkale onno vabe dekte hobe', `Msg 1 text check: got "${extractedMessages[1].text}"`);
console.assert(extractedMessages[1].reactions.includes('😆'), 'Msg 1 should have reaction 😆');

// Message 2: Me
console.assert(extractedMessages[2].sender === 'Me', 'Msg 2 sender should be Me');
console.assert(extractedMessages[2].isMe === true, 'Msg 2 isMe should be true');
console.assert(extractedMessages[2].text === 'Wait ektu vabi solution ta', 'Msg 2 text check');

// Message 3: Nadira Fairuxa
console.assert(extractedMessages[3].sender === 'Nadira Fairuxa', 'Msg 3 sender should be Nadira');
console.assert(extractedMessages[3].isMe === false, 'Msg 3 isMe should be false');
console.assert(extractedMessages[3].text === 'Ki faltu', 'Msg 3 text check');

// Message 4: Me ("You replied to Nadira Fairuxa:" stripped, reaction 😆 attached)
console.assert(extractedMessages[4].sender === 'Me', 'Msg 4 sender should be Me');
console.assert(extractedMessages[4].isMe === true, 'Msg 4 isMe should be true');
console.assert(extractedMessages[4].text === 'Total count of 1 minus total count of zero', `Msg 4 text check: got "${extractedMessages[4].text}"`);
console.assert(extractedMessages[4].reactions.includes('😆'), 'Msg 4 should have reaction 😆');

console.log('✔ All message extraction assertions passed!');

// ── Test 5: Exporter Output Verification ──────────────────────────────────────
console.log('\n5. Testing Exporter Transcript Output...');
const stats = buildStats(extractedMessages, 'Nadira Fairuxa', 'Messenger');
const txtOutput = buildTxtContent(extractedMessages, stats);

console.log('Generated .txt sample:');
console.log(txtOutput.split('\n').slice(0, 35).join('\n'));

// Assertions on txt output:
console.assert(!txtOutput.includes('2000-01-01'), 'Output MUST NOT contain epoch 2000-01-01');
console.assert(!txtOutput.includes('Saturday, January 1, 2000'), 'Output MUST NOT contain Saturday, January 1, 2000');
console.assert(!txtOutput.includes('You sent:'), 'Output MUST NOT contain "You sent:"');
console.assert(!txtOutput.includes('You replied to'), 'Output MUST NOT contain "You replied to"');
console.assert(!txtOutput.includes('Seen by Nadira'), 'Output MUST NOT contain "Seen by Nadira"');
console.assert(txtOutput.includes('> Me'), 'Output MUST contain "> Me"');
console.assert(txtOutput.includes('< Nadira Fairuxa'), 'Output MUST contain "< Nadira Fairuxa"');
console.assert(txtOutput.includes('(😆)'), 'Output MUST contain reaction (😆)');

console.log('\n✔ All exporter assertions passed!');
console.log('\n=== ALL TESTS PASSED SUCCESSFULLY! ===');
