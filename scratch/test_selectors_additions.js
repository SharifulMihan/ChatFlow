/**
 * scratch/test_selectors_additions.js
 */

const ACCESSIBILITY_PREFIX_REGEX = /^(?:you\s+sent|you\s+replied(?:\s+to\s+[^:\n]+)?(?:\s+to\s+yourself)?|[^:\n]+\s+sent|enter,\s*message\s*sent|forwarded|seen(?:\s+by\s+[^:\n]+)?|delivered|sent)\s*[:,\-]?\s*/i;
const BENGALI_PREFIX_REGEX = /^(?:আপনি\s+পাঠিয়েছেন|আপনি\s+উত্তর\s+দিয়েছেন|উত্তর\s+দিয়েছেন|দেখা\s+হয়েছে|পাঠানো\s+হয়েছে)\s*[:,\-]?\s*/i;

export function isPureAccessibilityLabel(str) {
  if (!str || typeof str !== 'string') return true;
  const s = str.replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E]/g, '').trim();
  if (!s) return true;

  return /^(?:you\s+sent|you\s+replied(?:\s+to\s+[^:\n]+)?(?:\s+to\s+yourself)?|[^:\n]+\s+sent|enter,\s*message\s*sent|forwarded|seen(?:\s+by\s+[^:\n]+)?|delivered|sent|active\s+now)$/i.test(s) ||
         /^(?:আপনি\s+পাঠিয়েছেন|আপনি\s+উত্তর\s+দিয়েছেন|উত্তর\s+দিয়েছেন|দেখা\s+হয়েছে|পাঠানো\s+হয়েছে)$/i.test(s);
}

export function cleanMessageText(raw) {
  if (!raw || typeof raw !== 'string') return { text: '', isOnlyAccessibility: true };
  let s = raw.replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E]/g, '').trim();
  if (!s) return { text: '', isOnlyAccessibility: true };

  if (isPureAccessibilityLabel(s)) {
    return { text: '', isOnlyAccessibility: true };
  }

  // Strip prefix from message
  s = s.replace(ACCESSIBILITY_PREFIX_REGEX, '');
  s = s.replace(BENGALI_PREFIX_REGEX, '');
  s = s.trim();

  return { text: s, isOnlyAccessibility: !s };
}

export function isEmojiOnlySender(name) {
  if (!name || typeof name !== 'string') return true;
  const s = name.trim();
  // Real sender name MUST have at least one letter (\p{L})
  if (!/\p{L}/u.test(s)) return true;
  // Cannot be a system accessibility word
  if (/^(?:you\s+sent|you\s+replied|seen|delivered|sent|active\s+now|unknown)$/i.test(s)) return true;
  return false;
}

export function isReactionOnly(rawText, el) {
  if (!rawText && !el) return true;
  const s = (rawText || '').trim();
  if (s && !/\p{L}/u.test(s)) {
    // Only emojis, symbols, numbers (e.g. "😆", "❤️ 2")
    return true;
  }
  if (el && typeof el.getAttribute === 'function') {
    const aria = el.getAttribute('aria-label') || '';
    if (/reaction|reacted/i.test(aria)) return true;
    const testid = el.getAttribute('data-testid') || '';
    if (/reaction/i.test(testid)) return true;
  }
  return false;
}
