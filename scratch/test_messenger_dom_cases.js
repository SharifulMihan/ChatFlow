/**
 * test_messenger_dom_cases.js
 */

import { parseStrictDate } from './test_strict_date_parser.js';
import { isReplyLabel, extractReplySender } from './test_reply_detection.js';

function mockParseMessenger(elements, chatName = 'Nadira Fairuxa', userAccount = 'Me') {
  const messages = [];
  let activeDate = null;
  let firstValidDate = null;
  let pendingReply = null;

  for (const el of elements) {
    const text = (el.text || '').trim();

    // 1. Intro block check
    if (/end-to-end encryption|secured by end-to-end/i.test(text)) {
      continue;
    }

    // 2. Strict Date Separator check
    const sepDate = parseStrictDate(text, 'MDY', activeDate);
    if (sepDate && el.isStandalone) {
      activeDate = sepDate;
      if (!firstValidDate) firstValidDate = sepDate;
      continue;
    }

    // 3. Reply Label check
    if (isReplyLabel(text)) {
      pendingReply = {
        sender: extractReplySender(text),
        text: null
      };
      continue;
    }

    // 4. Quoted Preview check (directly following a reply label or explicitly marked as quote)
    if (pendingReply && (pendingReply.text === null || el.isQuote)) {
      pendingReply.text = (pendingReply.text ? pendingReply.text + '\n' : '') + text;
      continue;
    }

    // 5. Normal message row
    const isMe = el.align === 'right';
    const sender = isMe ? userAccount : chatName;

    let replyTo = null;
    if (pendingReply && pendingReply.text) {
      replyTo = {
        sender: pendingReply.sender,
        text: pendingReply.text
      };
      pendingReply = null; // consumed
    }

    const msg = {
      sender,
      isMe,
      text,
      timestamp: activeDate ? activeDate.toISOString() : null,
      replyTo,
      reactions: []
    };

    messages.push(msg);
  }

  // Back-propagate first valid date to leading messages
  if (firstValidDate) {
    for (const m of messages) {
      if (!m.timestamp) m.timestamp = firstValidDate.toISOString();
      else break;
    }
  }

  return { messages, firstValidDate };
}

// Simulate the exact DOM items from Screenshot 1:
const domItems = [
  { text: 'Messages and calls are secured with end-to-end encryption. Only people in this chat can read, listen to, or share them. Learn more', isStandalone: true },
  { text: '12/16/25, 12:47 AM', isStandalone: true },
  { text: 'Tumi B2 er Student form submit korba kobe', align: 'right' },
  { text: 'Unfortunately amr kase B2 er 2 ta form ase', align: 'right' },
  { text: 'Ami Wednesday amder B1 er gula shob submit kore dibo', align: 'right' },
  { text: '12/16/25, 4:58 AM', isStandalone: true },
  { text: 'Nadira Fairuxa replied to you', isStandalone: false },
  { text: 'Unfortunately amr kase B2 er 2 ta form ase', isQuote: true },
  { text: 'Please return the two forms on Wednesday, I told you to check ejonnei', align: 'left' },
  { text: 'Nadira Fairuxa replied to you', isStandalone: false },
  { text: 'Tumi B2 er Student form submit korba kobe', isQuote: true },
  { text: "I'm supposed to submit b2's forms to her", align: 'left' }
];

const { messages } = mockParseMessenger(domItems);

console.log('Resulting Messages count:', messages.length);
messages.forEach((m, idx) => {
  const replyStr = m.replyTo ? ` [REPLY to ${m.replyTo.sender}: "${m.replyTo.text}"]` : '';
  console.log(`Msg ${idx + 1}: [${m.sender}] [${m.timestamp}]: "${m.text}"${replyStr}`);
});

console.assert(messages.length === 5, `Expected exactly 5 messages, got ${messages.length}`);
console.assert(messages[0].text === 'Tumi B2 er Student form submit korba kobe');
console.assert(messages[0].sender === 'Me');
console.assert(messages[1].text === 'Unfortunately amr kase B2 er 2 ta form ase');
console.assert(messages[2].text === 'Ami Wednesday amder B1 er gula shob submit kore dibo');
console.assert(messages[3].text === 'Please return the two forms on Wednesday, I told you to check ejonnei');
console.assert(messages[3].sender === 'Nadira Fairuxa');
console.assert(messages[3].replyTo !== null && messages[3].replyTo.text === 'Unfortunately amr kase B2 er 2 ta form ase');
console.assert(messages[4].text === "I'm supposed to submit b2's forms to her");
console.assert(messages[4].sender === 'Nadira Fairuxa');
console.assert(messages[4].replyTo !== null && messages[4].replyTo.text === 'Tumi B2 er Student form submit korba kobe');

// Participant check: exactly 2 participants!
const participants = new Set(messages.map(m => m.sender));
console.assert(participants.size === 2, `Expected 2 participants, got ${participants.size}`);

console.log('All simulation checks passed successfully!');
