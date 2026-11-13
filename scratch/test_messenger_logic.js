/**
 * scratch/test_messenger_logic.js
 */

import {
  cleanMessageText,
  isPureAccessibilityLabel,
  isEmojiOnlySender,
  isReactionOnly,
  detectDateFormat,
  parseDateSeparatorText
} from '../content/selectors.js';

// Test 1: Alignment Rect Calculation
function testDetectAlignment(bubbleRect, containerRect) {
  const cWidth = containerRect.width;
  const rightGap = containerRect.right - bubbleRect.right;
  const leftGap = bubbleRect.left - containerRect.left;

  if (rightGap < cWidth * 0.38 && leftGap > cWidth * 0.22) {
    return 'right'; // ME
  }
  if (leftGap < cWidth * 0.38 && rightGap > cWidth * 0.22) {
    return 'left'; // OTHER
  }
  return rightGap < leftGap ? 'right' : 'left';
}

console.log('=== TEST 1: Alignment Calculation ===');
// Container: left=100, right=900, width=800
const contRect = { left: 100, right: 900, width: 800 };

// Bubble on right (outgoing/me): left=550, right=880, width=330
const myBubble = { left: 550, right: 880, width: 330 };
console.log('Right bubble alignment:', testDetectAlignment(myBubble, contRect)); // Expect 'right'

// Bubble on left (incoming/other): left=120, right=450, width=330
const otherBubble = { left: 120, right: 450, width: 330 };
console.log('Left bubble alignment:', testDetectAlignment(otherBubble, contRect)); // Expect 'left'

console.log('\n=== TEST 2: Prefix Cleaning ===');
const sampleTexts = [
  'You sent: Ar oidike CF e eto valo',
  'You sent',
  'You replied to Nadira Fairuxa',
  'Nadira Fairuxa sent: But shoman na thkale onno vabe dekte hobe',
  'Enter, Message sent: Total count of 1 minus total count of zero',
  'Seen by Nadira at 2:19 PM'
];

for (const t of sampleTexts) {
  const res = cleanMessageText(t);
  console.log(`"${t}" -> cleaned: "${res.text}", isOnlyAccessibility: ${res.isOnlyAccessibility}`);
}

console.log('\n=== TEST 3: Emoji Senders Rejected ===');
const senders = ['😆', '❤️', 'Nadira Fairuxa', 'Me', 'S.I. Mihan', 'You sent'];
for (const s of senders) {
  console.log(`Sender "${s}" isEmojiOnly/Invalid:`, isEmojiOnlySender(s));
}
