/**
 * selectors.js
 * Centralized selectors, localized patterns, and name sanitizers for ChatFlow.
 */

// ─── Accessibility & Chat Name Cleaning ───────────────────────────────────────

export const ACCESSIBILITY_CHAT_PREFIXES = [
  // English
  'conversation titled',
  'conversation with',
  'conversation in',
  'conversation about',
  'chat with',
  'group chat',
  // Bengali
  'এর সাথে কথোপকথন',
  'শিরোনামযুক্ত কথোপকথন',
  // Spanish / Portuguese / French / German
  'conversación con',
  'conversación titulada',
  'conversa com',
  'conversa com o título',
  'conversation avec',
  'conversation intitulée',
  'unterhaltung mit',
  'unterhaltung mit dem titel'
];

export const STATUS_TRAILING_PATTERNS = [
  /\bactive\s+(now|\d+\w*\s+ago)\b/i,
  /\bactive\s+yesterday\b/i,
  /\bactive\s+today\b/i,
  /\btyping\b\.*/i,
  /\bmuted\b/i,
  /\blast seen\b.*/i,
  /\bonline\b/i
];

/**
 * Universal chat name sanitizer.
 * Strips accessibility prefixes, trailing status text, and quotes without losing
 * valid special characters (e.g. "~", "&", Bengali characters, emojis).
 * @param {string} raw
 * @param {string} [fallback='Chat']
 * @returns {string}
 */
export function sanitizeChatName(raw, fallback = 'Chat') {
  if (!raw || typeof raw !== 'string') return fallback;

  // 1. Strip invisible / RTL control characters
  let s = raw.replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E]/g, '');

  // 2. Collapse internal whitespace
  s = s.replace(/\s+/g, ' ').trim();
  if (!s) return fallback;

  // 3. Strip known accessibility prefixes at the start only
  // Matches "Conversation titled ", "Conversation with ", "Conversation in ", "Conversation about ", "Chat with ", "Group chat "
  s = s.replace(/^(?:conversation\s+(?:titled|with|in|about)|chat\s+with|group\s+chat|conversa(?:ción)?\s+(?:con|titulada?)|unterhaltung\s+mit(?:\s+dem\s+titel)?)\s+/i, '');

  // Bengali prefix & suffix
  s = s.replace(/^(?:শিরোনামযুক্ত কথোপকথন|গ্রুপ চ্যাট)\s+/i, '');
  s = s.replace(/\s*[-_]?\s*(?:এর সাথে কথোপকথন|এর সাথে চ্যাট|শিরোনামযুক্ত কথোপকথন)$/i, '');

  // 4. Strip trailing status text (e.g. "Raj Roy Active 43m ago" -> "Raj Roy")
  s = s.replace(/\s+(?:active\s+(?:now|\d+\w*\s+ago|yesterday|today)|typing\.*|muted|online|last seen\b.*)$/i, '');

  // 5. Remove surrounding quotes
  s = s.replace(/^["'“”«»]+|["'“”«»]+$/g, '').trim();

  return s || fallback;
}

/**
 * Unicode-aware avatar initials generator.
 * Never returns "CT" from "Conversation Titled".
 * @param {string} name
 * @returns {string}
 */
export function getInitials(name) {
  if (!name || typeof name !== 'string') return 'CF';
  const clean = sanitizeChatName(name);
  if (!clean) return 'CF';

  const words = clean.trim().split(/[\s~_-]+/).filter(Boolean);
  if (words.length >= 2) {
    const c1 = Array.from(words[0])[0] || '';
    const c2 = Array.from(words[1])[0] || '';
    return (c1 + c2).toUpperCase();
  }

  const chars = Array.from(words[0] || '');
  if (chars.length >= 2) return (chars[0] + chars[1]).toUpperCase();
  if (chars.length === 1) return chars[0].toUpperCase();
  return 'CF';
}

// ─── Conversation Intro Block Patterns (Reliable Top Detection) ───────────────

export const INTRO_BLOCK_PATTERNS = [
  // English
  /messages and calls are secured by end-to-end encryption/i,
  /messages and calls are end-to-end encrypted/i,
  /end-to-end encrypted/i,
  /you're connected on messenger/i,
  /say hi to your new messenger friend/i,
  /created this group/i,
  /named the group/i,
  // Bengali
  /মেসেজ এবং কলগুলি এন্ড-টু-এন্ড এনক্রিপশন/i,
  /এন্ড-টু-এন্ড এনক্রিপ্ট করা/i,
  /গ্রুপ তৈরি করেছেন/i,
  /গ্রুপের নাম পরিবর্তন করেছেন/i,
  // WhatsApp
  /messages and calls are end-to-end encrypted\. no one outside of this chat/i
];

// ─── WhatsApp Older Messages Prompt Patterns ──────────────────────────────────

// ─── Accessibility Message Stripping & Reaction Filtering ───────────────────

export const ACCESSIBILITY_PREFIX_REGEX = /^(?:you\s+sent|sent\s+by\s+you|you:|[^:\n]+\s+sent|enter,\s*message\s*sent|forwarded|seen(?:\s+by\s+[^:\n]+(?:\s+at\s+[^:\n]+)?)?|delivered|sent)\s*[:,\-]?\s*/i;
export const BENGALI_PREFIX_REGEX = /^(?:আপনি\s+পাঠিয়েছেন|আপনি\s+উত্তর\s+দিয়েছেন|উত্তর\s+দিয়েছেন|দেখা\s+হয়েছে|পাঠানো\s+হয়েছে)\s*[:,\-]?\s*/i;

/**
 * Check if a string is a reply announcement label (e.g. "Nadira Fairuxa replied to you").
 * These are purely UI/accessibility headers and must NEVER be emitted as messages.
 * @param {string} str
 * @returns {boolean}
 */
export function isReplyLabel(str) {
  if (!str || typeof str !== 'string') return false;
  const s = str.trim().replace(/[\u200B-\u200D\uFEFF]/g, '');
  if (!s || s.length > 80) return false;
  return /^(?:you|[^\n:]+?)\s+replied(?:\s+to\s+(?:you|[^\n:]+?)|to\s+yourself|to\s+themselves)?$/i.test(s) ||
         /^(?:আপনি|[^\n:]+?)\s+উত্তর\s+দিয়েছেন/i.test(s);
}

/**
 * Extract replier's name from a reply label string.
 * @param {string} str
 * @returns {string}
 */
export function extractReplySender(str) {
  if (!str || typeof str !== 'string') return '';
  const s = str.trim().replace(/[\u200B-\u200D\uFEFF]/g, '');
  // Match "X replied to Y" or "You replied to Y" or "X replied to you"
  const mTo = s.match(/(?:replied\s+to|উত্তর\s+দিয়েছেন(?:\s+কাউকে)?)\s+(you|yourself|themselves|আপনাকে|[^\n:]+)/i);
  if (mTo) {
    const target = mTo[1].trim();
    if (/^(?:you|আপনাকে)$/i.test(target)) return 'Me';
    if (/^(?:yourself|themselves)$/i.test(target)) {
      const mAuthor = s.match(/^([^\n:]+?)\s+replied/i);
      return mAuthor ? (mAuthor[1].toLowerCase() === 'you' ? 'Me' : mAuthor[1].trim()) : '';
    }
    return target;
  }
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

/**
 * Check if a text snippet is purely an accessibility label, reply label, or UI indicator.
 * @param {string} str
 * @returns {boolean}
 */
export function isPureAccessibilityLabel(str) {
  if (!str || typeof str !== 'string') return true;
  const s = str.replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E]/g, '').trim();
  if (!s) return true;

  if (isReplyLabel(s)) return true;

  return /^(?:you\s+sent|sent\s+by\s+you|you:|[^:\n]+\s+sent|enter,\s*message\s*sent|forwarded|seen(?:\s+by\s+.*)?|delivered|sent|active\s+now)$/i.test(s) ||
         /^(?:আপনি\s+পাঠিয়েছেন|আপনি\s+উত্তর\s+দিয়েছেন|উত্তর\s+দিয়েছেন|দেখা\s+হয়েছে|পাঠানো\s+হয়েছে)$/i.test(s);
}

/**
 * Clean message text by stripping hidden accessibility and screen-reader prefixes.
 * @param {string} raw
 * @returns {{ text: string, isOnlyAccessibility: boolean }}
 */
export function cleanMessageText(raw) {
  if (!raw || typeof raw !== 'string') return { text: '', isOnlyAccessibility: true };
  let s = raw.replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E]/g, '').trim();
  if (!s) return { text: '', isOnlyAccessibility: true };

  if (isPureAccessibilityLabel(s)) {
    return { text: '', isOnlyAccessibility: true };
  }

  // Strip reply prefixes if someone replied in text
  s = s.replace(/^(?:you|[^\n:]+?)\s+replied(?:\s+to\s+[^\n:]+?)?\s*[:\-]\s*/i, '');
  s = s.replace(/^(?:আপনি|[^\n:]+?)\s+উত্তর\s+দিয়েছেন(?:\s+আপনাকে)?\s*[:\-]\s*/i, '');

  // Strip standard accessibility prefixes
  s = s.replace(ACCESSIBILITY_PREFIX_REGEX, '');
  s = s.replace(BENGALI_PREFIX_REGEX, '');
  s = s.trim();

  return { text: s, isOnlyAccessibility: !s };
}

/**
 * Check if a sender name is invalid (e.g. only emoji, reaction badge, symbol, or system word).
 * @param {string} name
 * @returns {boolean}
 */
export function isEmojiOnlySender(name) {
  if (!name || typeof name !== 'string') return true;
  const s = name.trim();
  // Real sender name MUST have at least one letter (\p{L}) in any alphabet
  if (!/\p{L}/u.test(s)) return true;
  // Cannot be a system accessibility phrase
  if (/^(?:you\s+sent|you\s+replied|seen|delivered|sent|active\s+now|unknown)$/i.test(s)) return true;
  return false;
}

/**
 * Check if an element or text represents an emoji reaction badge rather than a message.
 * @param {string} rawText
 * @param {Element} [el=null]
 * @returns {boolean}
 */
export function isReactionOnly(rawText, el = null) {
  const s = (rawText || '').trim();
  if (s && !/\p{L}/u.test(s)) {
    return true;
  }
  if (el && typeof el.getAttribute === 'function') {
    const aria = el.getAttribute('aria-label') || '';
    if (/reaction|reacted/i.test(aria)) return true;
    const testid = el.getAttribute('data-testid') || '';
    if (/reaction/i.test(testid)) return true;
    const cl = el.getAttribute('class') || '';
    if (/reaction/i.test(cl)) return true;
  }
  return false;
}

// ─── Chronological Date Separator Parser ──────────────────────────────────────

const MONTHS_MAP = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
};

const BENGALI_MONTHS = {
  'জানুয়ারি': 0, 'ফেব্রুয়ারি': 1, 'মার্চ': 2, 'এপ্রিল': 3,
  'মে': 4, 'জুন': 5, 'জুলাই': 6, 'আগস্ট': 7,
  'সেপ্টেম্বর': 8, 'অক্টোবর': 9, 'নভেম্বর': 10, 'ডিসেম্বর': 11
};

/**
 * Validate that a Date is within the realistic lifetime of modern messaging platforms (2008 - now).
 * Strictly rejects impossible years (e.g. 500, 250, 1950) and future dates.
 * @param {Date} d
 * @param {Date} [now=new Date()]
 * @returns {boolean}
 */
export function isValidConversationDate(d, now = new Date()) {
  if (!d || !(d instanceof Date) || isNaN(d.getTime())) return false;
  const year = d.getFullYear();
  const currentYear = now.getFullYear();
  if (year < 2008 || year > currentYear + 1) return false;
  if (d.getTime() > now.getTime() + 24 * 60 * 60 * 1000) return false;
  return true;
}

/**
 * Scan all date separator strings to deduce format (M/D/YY vs D/M/YY).
 * @param {string[]} separatorStrings
 * @returns {'MDY'|'DMY'}
 */
export function detectDateFormat(separatorStrings) {
  let hasMonthSecond = false; // e.g. 12/14/25 -> second > 12 -> MDY
  let hasDayFirst = false;    // e.g. 14/12/25 -> first > 12 -> DMY

  for (const s of separatorStrings) {
    const m = s.match(/(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/);
    if (m) {
      const p1 = parseInt(m[1], 10);
      const p2 = parseInt(m[2], 10);
      if (p1 > 12 && p2 <= 12) hasDayFirst = true;
      if (p2 > 12 && p1 <= 12) hasMonthSecond = true;
    }
  }

  if (hasMonthSecond && !hasDayFirst) return 'MDY';
  if (hasDayFirst && !hasMonthSecond) return 'DMY';

  // Fallback to browser locale preference
  try {
    const sample = new Intl.DateTimeFormat().format(new Date(2025, 11, 25)); // Dec 25
    if (sample.startsWith('12')) return 'MDY';
    if (sample.startsWith('25')) return 'DMY';
  } catch (_) {}

  return 'MDY';
}

/**
 * Strictly parse Messenger & WhatsApp date/time separators.
 * Strict rules:
 * - Standalone centered element matching explicit date/time patterns only.
 * - Never runs over message text, replies, or captions.
 * - 2-digit years 00-99 mean 2000-2099.
 * - Validates year >= 2008 and not in future.
 * - Rejects non-decreasing chronological jumps (> 24h backwards).
 * - ZERO fallback to new Date(s).
 * @param {string} str
 * @param {'MDY'|'DMY'} [format='MDY']
 * @param {Date|null} [lastDate=null]
 * @param {Date} [baseDate=new Date()]
 * @returns {Date|null}
 */
export function parseDateSeparatorText(str, format = 'MDY', lastDate = null, baseDate = new Date()) {
  if (!str || typeof str !== 'string') return null;
  const s = str.trim().replace(/[\u200B-\u200D\uFEFF]/g, '');
  if (!s || s.length > 60) return null;

  function parseTimeParts(hStr, mStr, meridiem) {
    let hours = parseInt(hStr, 10);
    const minutes = parseInt(mStr, 10);
    const m = (meridiem || '').toLowerCase();
    if (m === 'pm' && hours < 12) hours += 12;
    if (m === 'am' && hours === 12) hours = 0;
    return { hours, minutes };
  }

  // Helper to validate and check chronological non-decreasing sanity
  function validateDate(d) {
    if (!isValidConversationDate(d)) return null;
    if (lastDate && d.getTime() < lastDate.getTime() - 24 * 60 * 60 * 1000) {
      return null;
    }
    return d;
  }

  // 1. Full Numeric Date + Time (e.g. "12/16/25, 12:47 AM" or "12/10/2025, 2:19 PM")
  const numDateTime = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})(?:[,\s]+at)?[,\s]+(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]m)?$/i);
  if (numDateTime) {
    const p1 = parseInt(numDateTime[1], 10);
    const p2 = parseInt(numDateTime[2], 10);
    let year = parseInt(numDateTime[3], 10);
    if (year < 100) year += 2000;

    let month = 0, day = 1;
    if (p1 > 12) {
      day = p1; month = p2 - 1;
    } else if (p2 > 12) {
      month = p1 - 1; day = p2;
    } else if (format === 'DMY') {
      day = p1; month = p2 - 1;
    } else {
      month = p1 - 1; day = p2;
    }

    if (day < 1 || day > 31 || month < 0 || month > 11) return null;

    const { hours, minutes } = parseTimeParts(numDateTime[4], numDateTime[5], numDateTime[6]);
    const d = new Date(year, month, day, hours, minutes);
    return validateDate(d);
  }

  // 2. Full Numeric Date Only (e.g. "12/16/25" or "12/16/2025")
  const numDateOnly = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/);
  if (numDateOnly) {
    const p1 = parseInt(numDateOnly[1], 10);
    const p2 = parseInt(numDateOnly[2], 10);
    let year = parseInt(numDateOnly[3], 10);
    if (year < 100) year += 2000;

    let month = 0, day = 1;
    if (p1 > 12) {
      day = p1; month = p2 - 1;
    } else if (p2 > 12) {
      month = p1 - 1; day = p2;
    } else if (format === 'DMY') {
      day = p1; month = p2 - 1;
    } else {
      month = p1 - 1; day = p2;
    }

    if (day < 1 || day > 31 || month < 0 || month > 11) return null;

    const d = new Date(year, month, day, 12, 0);
    return validateDate(d);
  }

  // 3. Text Month Date + Optional Time (e.g. "May 11, 2026, 9:14 PM", "Sunday, October 11, 2026", "11 May 2026, 9:14 PM")
  const textMonth1 = s.match(/^(?:(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*[,\s]+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*,?\s*(\d{2,4}))?(?:[,\s]+at|[,\s]+)*(?:(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]m)?)?$/i);
  if (textMonth1) {
    const month = MONTHS_MAP[textMonth1[1].slice(0, 3).toLowerCase()];
    const day = parseInt(textMonth1[2], 10);
    if (day < 1 || day > 31) return null;
    let year = textMonth1[3] ? parseInt(textMonth1[3], 10) : (lastDate ? lastDate.getFullYear() : baseDate.getFullYear());
    if (year < 100) year += 2000;
    let hours = 12, minutes = 0;
    if (textMonth1[4] && textMonth1[5]) {
      const tp = parseTimeParts(textMonth1[4], textMonth1[5], textMonth1[6]);
      hours = tp.hours; minutes = tp.minutes;
    }
    const d = new Date(year, month, day, hours, minutes);
    return validateDate(d);
  }

  const textMonth2 = s.match(/^(?:(?:sun|mon|tue|wed|thu|fri|sat)[a-z]*[,\s]+)?(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*(?:\s*,?\s*(\d{2,4}))?(?:[,\s]+at|[,\s]+)*(?:(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]m)?)?$/i);
  if (textMonth2) {
    const day = parseInt(textMonth2[1], 10);
    if (day < 1 || day > 31) return null;
    const month = MONTHS_MAP[textMonth2[2].slice(0, 3).toLowerCase()];
    let year = textMonth2[3] ? parseInt(textMonth2[3], 10) : (lastDate ? lastDate.getFullYear() : baseDate.getFullYear());
    if (year < 100) year += 2000;
    let hours = 12, minutes = 0;
    if (textMonth2[4] && textMonth2[5]) {
      const tp = parseTimeParts(textMonth2[4], textMonth2[5], textMonth2[6]);
      hours = tp.hours; minutes = tp.minutes;
    }
    const d = new Date(year, month, day, hours, minutes);
    return validateDate(d);
  }

  // 4. Relative Today / Yesterday
  if (/^today/i.test(s)) {
    const m = s.match(/^today(?:[,\s]+at)?[,\s]+(\d{1,2}):(\d{2})\s*([ap]m)?$/i);
    const ref = baseDate ? new Date(baseDate) : new Date();
    let hours = 12, minutes = 0;
    if (m) {
      const tp = parseTimeParts(m[1], m[2], m[3]);
      hours = tp.hours; minutes = tp.minutes;
    }
    const d = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), hours, minutes);
    return validateDate(d);
  }

  if (/^yesterday/i.test(s)) {
    const m = s.match(/^yesterday(?:[,\s]+at)?[,\s]+(\d{1,2}):(\d{2})\s*([ap]m)?$/i);
    const ref = baseDate ? new Date(baseDate) : new Date();
    const y = new Date(ref.getTime() - 24 * 60 * 60 * 1000);
    let hours = 12, minutes = 0;
    if (m) {
      const tp = parseTimeParts(m[1], m[2], m[3]);
      hours = tp.hours; minutes = tp.minutes;
    }
    const d = new Date(y.getFullYear(), y.getMonth(), y.getDate(), hours, minutes);
    return validateDate(d);
  }

  // 5. Weekday + Time: e.g. "Mon 10:32 AM", "Tuesday 4:15 PM"
  const weekdayMatch = s.match(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*(?:[,\s]+at)?[,\s]+(\d{1,2}):(\d{2})\s*([ap]m)?$/i);
  if (weekdayMatch) {
    const weekdayMap = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const targetDay = weekdayMap[weekdayMatch[1].slice(0, 3).toLowerCase()];
    const tp = parseTimeParts(weekdayMatch[2], weekdayMatch[3], weekdayMatch[4]);
    const ref = lastDate ? new Date(lastDate) : (baseDate ? new Date(baseDate) : new Date());

    let diff = (ref.getDay() - targetDay + 7) % 7;
    if (diff === 0 && !lastDate) diff = 7;
    const targetDate = new Date(ref.getTime() - diff * 24 * 60 * 60 * 1000);
    const d = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), tp.hours, tp.minutes);
    return validateDate(d);
  }

  // 6. Time-Only Separator (e.g. "12:45 AM" or "14:30")
  const timeOnly12 = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]m)$/i);
  if (timeOnly12) {
    const tp = parseTimeParts(timeOnly12[1], timeOnly12[2], timeOnly12[3]);
    const ref = lastDate ? new Date(lastDate) : (baseDate ? new Date(baseDate) : new Date());
    const d = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), tp.hours, tp.minutes);
    return validateDate(d);
  }

  const timeOnly24 = s.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (timeOnly24) {
    const hours = parseInt(timeOnly24[1], 10);
    const minutes = parseInt(timeOnly24[2], 10);
    const ref = lastDate ? new Date(lastDate) : (baseDate ? new Date(baseDate) : new Date());
    const d = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), hours, minutes);
    return validateDate(d);
  }

  // 7. Bengali Date/Time
  const bnMatch = s.match(/^(\d{1,2})\s+(জানুয়ারি|ফেব্রুয়ারি|মার্চ|এপ্রিল|মে|জুন|জুলাই|আগস্ট|সেপ্টেম্বর|অক্টোবর|নভেম্বর|ডিসেম্বর)(?:\s+(\d{2,4}))?(?:,\s*(\d{1,2}):(\d{2})\s*(পূর্বাহ্ন|অপরাহ্ন)?)?$/);
  if (bnMatch) {
    const day = parseInt(bnMatch[1], 10);
    const month = BENGALI_MONTHS[bnMatch[2]];
    let year = bnMatch[3] ? parseInt(bnMatch[3], 10) : (lastDate ? lastDate.getFullYear() : baseDate.getFullYear());
    if (year < 100) year += 2000;
    let hours = 12, minutes = 0;
    if (bnMatch[4] && bnMatch[5]) {
      const tp = parseTimeParts(bnMatch[4], bnMatch[5], bnMatch[6] === 'অপরাহ্ন' ? 'pm' : (bnMatch[6] === 'পূর্বাহ্ন' ? 'am' : ''));
      hours = tp.hours; minutes = tp.minutes;
    }
    const d = new Date(year, month, day, hours, minutes);
    return validateDate(d);
  }

  // STRICT REJECTION: never fallback to new Date(s)!
  return null;
}

export const OLDER_MESSAGES_PATTERNS = {
  en: /(older messages|get older messages|load older|see older|from your phone|messages from your phone)/i,
  bn: /(পুরোনো মেসেজ|পুরানো মেসেজ|ফোন থেকে পুরোনো|ফোন থেকে পুরানো|মেসেজ পেতে এখানে ক্লিক করুন)/i,
  es: /(mensajes anteriores|mensajes más antiguos|desde tu teléfono)/i,
  pt: /(mensagens anteriores|mensagens mais antigas|do seu celular|do seu telefone)/i,
  hi: /(पुराने संदेश|फ़ोन से पुराने)/i,
  combined: /(older messages|get older messages|load older|see older|from your phone|messages from your phone|পুরোনো মেসেজ|পুরানো মেসেজ|ফোন থেকে পুরোনো|ফোন থেকে পুরানো|মেসেজ পেতে এখানে ক্লিক করুন|mensajes anteriores|mensajes más antiguos|mensagens anteriores|mensagens mais antigas|पुराने संदेश)/i
};

export const OLDER_MESSAGES_SELECTORS = [
  '[data-testid="btn-load-more-messages"]',
  '[data-testid="load-older-messages"]',
  '[data-testid*="older-messages"]',
  '[data-testid*="load-more"]',
  'button[class*="load-more"]',
  'div[class*="load-more"]'
];

// ─── Localized "You" & System Message Config (Multi-Language) ─────────────────

export const LOCALIZED_YOU_NAMES = new Set([
  'you', 'me',
  'আপনি', 'আমি',          // Bengali
  'tú', 'tu', 'usted',     // Spanish
  'vous', 'toi',           // French
  'du', 'sie',             // German
  'você', 'voce',          // Portuguese
  'أنت', 'انت', 'أنتِ',    // Arabic
  'आप', 'तुम',             // Hindi
  'anda', 'kamu',          // Indonesian
  'sen', 'siz',            // Turkish
  'вы', 'ты',              // Russian
  'あなた',                // Japanese
  '你', '您',              // Chinese
  '당신',                  // Korean
  'คุณ'                    // Thai
]);

export const LOCALIZED_DELETED_PATTERNS = [
  /this message was deleted/i,
  /you deleted this message/i,
  /এই মেসেজটি মুছে ফেলা হয়েছে/i,
  /আপনি এই মেসেজটি মুছে ফেলেছেন/i,
  /este mensaje fue eliminado/i,
  /eliminaste este mensaje/i,
  /esta mensagem foi apagada/i,
  /ce message a été supprimé/i,
  /diese nachricht wurde gelöscht/i,
  /تم حذف هذه الرسالة/i,
  /यह संदेश हटा दिया गया/i,
  /pesan ini telah dihapus/i,
  /bu mesaj silindi/i,
  /данное сообщение удалено/i
];

export const LOCALIZED_SYSTEM_PATTERNS = [
  ...INTRO_BLOCK_PATTERNS,
  /changed the subject/i,
  /changed this group's icon/i,
  /added\s+.+/i,
  /left$/i,
  /removed\s+.+/i,
  /joined using this group's invite link/i,
  /missed\s+(?:voice|video)\s+call/i,
  /মিসড\s+(?:ভয়েস|ভিডিও)\s+কল/i
];

/**
 * Check if a string looks like a time or date ("1:22 AM", "17:45", "11/5/2026", "Yesterday").
 * Used to prevent timestamps from ever being accepted as sender names.
 * @param {string} raw
 * @returns {boolean}
 */
export function isTimeOrDateString(raw) {
  if (!raw || typeof raw !== 'string') return false;
  const s = raw.replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E]/g, '').trim();
  if (!s) return false;

  // Time: "1:22 AM", "17:45", "~1:22 AM", "1:22:30 PM"
  if (/^~?\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]\.?m\.?)?$/i.test(s)) return true;
  // Numeric date: "11/5/2026", "2026-11-05", "11.05.26"
  if (/^\d{1,4}[/\-.]\d{1,2}[/\-.]\d{1,4}$/.test(s)) return true;
  // Date + time: "11/5/2026, 1:22 AM"
  if (/^\d{1,4}[/\-.]\d{1,2}[/\-.]\d{1,4}[,\s]+\d{1,2}:\d{2}/.test(s)) return true;
  // Relative day keywords (English & localized)
  if (/^(?:today|yesterday|tomorrow|আজ|গতকাল|ayer|hoy|ontem|hoje|hier|aujourd'hui|gestern|heute|اليوم|أمس|आज|कल|hari ini|kemarin|bugün|dün|сегодня|вчера)(?:\s+at\s+.*)?$/i.test(s)) {
    return true;
  }
  // Weekday names alone
  if (/^(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)$/i.test(s)) {
    return true;
  }
  return false;
}

/**
 * Check if a name is a localized form of "You".
 * @param {string} name
 * @returns {boolean}
 */
export function isLocalizedYou(name) {
  if (!name || typeof name !== 'string') return false;
  const norm = name.replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E]/g, '').trim().toLowerCase();
  return LOCALIZED_YOU_NAMES.has(norm);
}

/**
 * Sanitize a raw sender name.
 * - Strips invisible/RTL control characters.
 * - Trims and removes leading/trailing colons and spaces ("You::" -> "You", "Raj::" -> "Raj").
 * - Rejects time/date strings ("1:22 AM", "17:45", "11/5/2026", "Yesterday") -> returns null.
 * - Rejects empty/non-letter-only/system-accessibility strings -> returns null.
 * - Maps localized "You" to options.myName if provided.
 * @param {string} raw
 * @param {{ myName?: string }} [options={}]
 * @returns {string|null}
 */
export function sanitizeSenderName(raw, options = {}) {
  if (!raw || typeof raw !== 'string') return null;

  // 1. Remove invisible / RTL control characters
  let s = raw.replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '');

  // 2. Collapse whitespace and strip leading/trailing colons and spaces
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^[:\s]+|[:\s]+$/g, '').trim();
  if (!s) return null;

  // 3. Reject anything that looks like a time or date
  if (isTimeOrDateString(s)) return null;

  // 4. Reject pure accessibility/punctuation/emoji-only strings
  if (isEmojiOnlySender(s)) return null;

  // 5. Map localized "You" to user's display name if provided
  if (options.myName && isLocalizedYou(s)) {
    return options.myName;
  }

  return s;
}

/**
 * Detect whether text contains RTL script characters (Arabic, Hebrew, Persian, Urdu, etc.).
 * @param {string} text
 * @returns {boolean}
 */
export function isRtlText(text) {
  if (!text || typeof text !== 'string') return false;
  return /[\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(text);
}

/**
 * Detect primary script & BCP-47 / Word language tag for a text run.
 * @param {string} text
 * @returns {{ script: string, lang: string, rtl: boolean }}
 */
export function detectScriptAndLang(text) {
  if (!text || typeof text !== 'string') return { script: 'latin', lang: 'en-US', rtl: false };
  if (/[\u0980-\u09FF]/.test(text)) return { script: 'bengali', lang: 'bn-BD', rtl: false };
  if (/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/.test(text)) return { script: 'arabic', lang: 'ar-SA', rtl: true };
  if (/[\u0590-\u05FF]/.test(text)) return { script: 'hebrew', lang: 'he-IL', rtl: true };
  if (/[\u0900-\u097F]/.test(text)) return { script: 'devanagari', lang: 'hi-IN', rtl: false };
  if (/[\u3040-\u30FF]/.test(text)) return { script: 'japanese', lang: 'ja-JP', rtl: false };
  if (/[\uAC00-\uD7AF]/.test(text)) return { script: 'korean', lang: 'ko-KR', rtl: false };
  if (/[\u4E00-\u9FFF]/.test(text)) return { script: 'cjk', lang: 'zh-CN', rtl: false };
  if (/[\u0E00-\u0E7F]/.test(text)) return { script: 'thai', lang: 'th-TH', rtl: false };
  if (/[\u0400-\u04FF]/.test(text)) return { script: 'cyrillic', lang: 'ru-RU', rtl: false };
  return { script: 'latin', lang: 'en-US', rtl: false };
}

// ─── Delivery-status (tick) signals: only OUTGOING messages show these ────────

export const OUTGOING_TICK_SELECTORS =
  '[data-icon="msg-check"], [data-icon="msg-dblcheck"], [data-icon="msg-time"], ' +
  '[data-icon="msg-check-light"], [data-icon="msg-dblcheck-light"], [data-icon="msg-dblcheck-ack"], ' +
  '[data-testid="msg-check"], [data-testid="msg-dblcheck"], [data-testid="msg-time"]';

export const LOCALIZED_TICK_LABELS = [
  /^(?:sent|delivered|read|pending)$/i,
  /^(?:পাঠানো হয়েছে|ডেলিভার হয়েছে|পড়া হয়েছে)$/i,
  /^(?:enviado|entregado|leído|pendiente)$/i,
  /^(?:enviada|entregue|lida|pendente)$/i,
  /^(?:envoyé|distribué|lu|en attente)$/i,
  /^(?:gesendet|zugestellt|gelesen)$/i,
  /^(?:تم الإرسال|تم التسليم|تمت القراءة)$/i,
  /^(?:भेजा गया|डिलीवर हुआ|पढ़ा गया)$/i,
  /^(?:terkirim|dikirim|dibaca|diterima)$/i,
  /^(?:gönderildi|iletildi|okundu)$/i,
  /^(?:отправлено|доставлено|прочитано)$/i
];

export function isTickLabel(label) {
  if (!label || typeof label !== 'string') return false;
  const s = label.replace(/[\u200B-\u200D\uFEFF\u200E\u200F]/g, '').trim();
  return LOCALIZED_TICK_LABELS.some(rx => rx.test(s));
}

export { WhatsAppAdapter } from './adapters/whatsapp.js';
