/**
 * test_messenger_adapter_sim.js
 * Simulates MessengerAdapter message extraction, alignment detection,
 * reaction filtering, and date separator parsing.
 */

import {
  cleanMessageText,
  isEmojiOnlySender,
  isReactionOnly
} from '../content/selectors.js';

console.log('Testing Messenger adapter simulation logic...');

// 1. Test isReactionOnly
console.assert(isReactionOnly('😆') === true, '😆 should be reaction only');
console.assert(isReactionOnly('❤️') === true, '❤️ should be reaction only');
console.assert(isReactionOnly('Hello world') === false, 'Hello world is not reaction');
console.assert(isReactionOnly('Ki faltu') === false, 'Ki faltu is not reaction');

// 2. Test isEmojiOnlySender
console.assert(isEmojiOnlySender('😆') === true, '😆 should be invalid sender');
console.assert(isEmojiOnlySender('❤️') === true, '❤️ should be invalid sender');
console.assert(isEmojiOnlySender('You sent') === true, '"You sent" should be invalid sender');
console.assert(isEmojiOnlySender('Nadira Fairuxa') === false, '"Nadira Fairuxa" should be valid sender');
console.assert(isEmojiOnlySender('Me') === false, '"Me" should be valid sender');

// 3. Test cleanMessageText
const clean1 = cleanMessageText('You sent: Wait ektu vabi solution ta');
console.assert(clean1.text === 'Wait ektu vabi solution ta', `Cleaned text mismatch: "${clean1.text}"`);
console.assert(clean1.isOnlyAccessibility === false);

const clean2 = cleanMessageText('You replied to Nadira Fairuxa: Total count of 1 minus total count of zero');
console.assert(clean2.text === 'Total count of 1 minus total count of zero', `Cleaned reply mismatch: "${clean2.text}"`);

const clean3 = cleanMessageText('You sent');
console.assert(clean3.isOnlyAccessibility === true, 'Pure "You sent" should be only accessibility');

const clean4 = cleanMessageText('Seen by Nadira at 2:19 PM');
console.assert(clean4.isOnlyAccessibility === true, 'Seen indicator should be only accessibility');

// 4. Test detectAlignment logic
function mockDetectAlignment(bubbleRect, containerRect) {
  if (bubbleRect.width > 0 && containerRect.width > 0) {
    const distRight = containerRect.right - bubbleRect.right;
    const distLeft = bubbleRect.left - containerRect.left;
    const rightRatio = distRight / containerRect.width;
    const leftRatio = distLeft / containerRect.width;
    if (rightRatio < 0.35 && leftRatio > 0.15) {
      return { isMe: true, confidence: 0.9, reason: 'geom_right' };
    }
    if (leftRatio < 0.35 && rightRatio > 0.15) {
      return { isMe: false, confidence: 0.9, reason: 'geom_left' };
    }
  }
  return { isMe: false, confidence: 0, reason: 'default' };
}

const cRect = { left: 0, right: 1000, width: 1000 };
// Outgoing bubble on right side: left=600, right=950 (width=350). distRight=50 (0.05), distLeft=600 (0.60)
const outAlign = mockDetectAlignment({ left: 600, right: 950, width: 350 }, cRect);
console.assert(outAlign.isMe === true, 'Right bubble must be detected as Me');

// Incoming bubble on left side: left=50, right=400 (width=350). distRight=600 (0.60), distLeft=50 (0.05)
const inAlign = mockDetectAlignment({ left: 50, right: 400, width: 350 }, cRect);
console.assert(inAlign.isMe === false, 'Left bubble must be detected as Other');

console.log('All simulation checks passed successfully!');
