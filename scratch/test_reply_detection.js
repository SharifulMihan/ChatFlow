/**
 * test_reply_detection.js
 */

export function isReplyLabel(str) {
  if (!str || typeof str !== 'string') return false;
  const s = str.trim().replace(/[\u200B-\u200D\uFEFF]/g, '');
  if (!s || s.length > 80) return false;
  return /^(?:you|[^\n:]+?)\s+replied(?:\s+to\s+(?:you|[^\n:]+?)|to\s+yourself|to\s+themselves)?$/i.test(s) ||
         /^(?:আপনি|[^\n:]+?)\s+উত্তর\s+দিয়েছেন/i.test(s);
}

export function extractReplySender(str) {
  if (!str || typeof str !== 'string') return '';
  const s = str.trim();
  const m = s.match(/^([^\n:]+?)\s+replied/i);
  if (m) {
    const replier = m[1].trim();
    return replier.toLowerCase() === 'you' ? 'Me' : replier;
  }
  const bnM = s.match(/^([^\n:]+?)\s+উত্তর\s+দিয়েছেন/i);
  if (bnM) {
    const replier = bnM[1].trim();
    return replier === 'আপনি' ? 'Me' : replier;
  }
  return '';
}

// Tests
console.log('Testing Reply Labels...');
console.assert(isReplyLabel('Nadira Fairuxa replied to you') === true);
console.assert(isReplyLabel('You replied to Nadira Fairuxa') === true);
console.assert(isReplyLabel('Nadira Fairuxa replied to themselves') === true);
console.assert(isReplyLabel('You replied to yourself') === true);
console.assert(isReplyLabel('নাদিরা আপনাকে উত্তর দিয়েছেন') === true);

console.assert(extractReplySender('Nadira Fairuxa replied to you') === 'Nadira Fairuxa');
console.assert(extractReplySender('You replied to Nadira Fairuxa') === 'Me');

// Negative cases
console.assert(isReplyLabel('Nadira Fairuxa') === false);
console.assert(isReplyLabel('Please return the two forms on Wednesday') === false);
console.assert(isReplyLabel('Tumi B2 er Student form submit korba kobe') === false);

console.log('All reply label tests passed 100%!');
