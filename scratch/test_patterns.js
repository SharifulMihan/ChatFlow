/**
 * scratch/test_patterns.js
 */

const ACCESSIBILITY_PREFIX_REGEX = /^(?:you\s+sent|you\s+replied(?:\s+to\s+[^:\n]+)?(?:\s+to\s+yourself)?|[^:\n]+\s+sent|enter,\s*message\s*sent|forwarded|seen(?:\s+by\s+[^:\n]+)?|delivered|sent)\s*[:,\-]?\s*/i;
const BENGALI_PREFIX_REGEX = /^(?:আপনি\s+পাঠিয়েছেন|আপনি\s+উত্তর\s+দিয়েছেন|উত্তর\s+দিয়েছেন|দেখা\s+হয়েছে|পাঠানো\s+হয়েছে)\s*[:,\-]?\s*/i;

function cleanMessageText(raw) {
  if (!raw || typeof raw !== 'string') return { text: '', isOnlyAccessibility: true };
  let s = raw.replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E]/g, '').trim();
  if (!s) return { text: '', isOnlyAccessibility: true };

  // Check if string is SOLELY an accessibility label
  const isOnly = /^(?:you\s+sent|you\s+replied(?:\s+to\s+[^:\n]+)?(?:\s+to\s+yourself)?|[^:\n]+\s+sent|enter,\s*message\s*sent|forwarded|seen(?:\s+by\s+[^:\n]+)?|delivered|sent|active\s+now)$/i.test(s) ||
                 /^(?:আপনি\s+পাঠিয়েছেন|আপনি\s+উত্তর\s+দিয়েছেন|উত্তর\s+দিয়েছেন|দেখা\s+হয়েছে|পাঠানো\s+হয়েছে)$/i.test(s);
  if (isOnly) {
    return { text: '', isOnlyAccessibility: true };
  }

  // Strip prefix from actual message text
  s = s.replace(ACCESSIBILITY_PREFIX_REGEX, '');
  s = s.replace(BENGALI_PREFIX_REGEX, '');
  s = s.trim();

  return { text: s, isOnlyAccessibility: !s };
}

const isEmojiOnlySender = (name) => {
  if (!name || typeof name !== 'string') return true;
  const stripped = name.replace(/[\s\p{Emoji}\p{Symbol}\p{Punctuation}]/gu, '');
  return stripped.length === 0;
};

// Tests
console.log('Testing cleanMessageText:');
console.log('1.', cleanMessageText('You sent'));
console.log('2.', cleanMessageText('You replied to Nadira Fairuxa'));
console.log('3.', cleanMessageText('You sent: Hello Nadira'));
console.log('4.', cleanMessageText('Nadira Fairuxa sent: Are you there?'));
console.log('5.', cleanMessageText('Enter, Message sent: Ok cool'));
console.log('6.', cleanMessageText('Seen by Nadira at 2:30 PM'));

console.log('\nTesting isEmojiOnlySender:');
console.log('1. "😆" ->', isEmojiOnlySender('😆'));
console.log('2. "❤️" ->', isEmojiOnlySender('❤️'));
console.log('3. "Nadira Fairuxa" ->', isEmojiOnlySender('Nadira Fairuxa'));
console.log('4. "Me" ->', isEmojiOnlySender('Me'));
console.log('5. "Project 🚀" ->', isEmojiOnlySender('Project 🚀'));
console.log('6. "ফাহিম ভাই" ->', isEmojiOnlySender('ফাহিম ভাই'));
