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
  /messages and calls are secured (?:by|with) end-to-end encryption/i,
  /messages and calls are end-to-end encrypted/i,
  /end-to-end encrypt(?:ed|ion)/i,
  /only people in this chat can read, listen to, or share/i,
  /learn more about (?:end-to-end )?encryption/i,
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

/**
 * Strip leading contact/profile header lines from a conversation intro block row
 * so only the clean system notice remains (e.g. "Messages and calls are secured with end-to-end encryption.").
 * @param {string} raw
 * @returns {string}
 */
export function extractCleanIntroSystemText(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const cleanLines = raw
    .replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .split(/\r?\n+/)
    .map(l => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  if (cleanLines.length === 0) return '';

  const startIdx = cleanLines.findIndex(line => INTRO_BLOCK_PATTERNS.some(rx => rx.test(line)));
  let sliced = startIdx >= 0 ? cleanLines.slice(startIdx).join(' ') : cleanLines.join(' ');

  // Inline concatenation like "Iqbal Mahmood Durjoy Messages and calls are secured..."
  const inlineMatch = sliced.match(/(messages and calls are (?:secured|end-to-end)|you're connected on messenger|say hi to your new messenger friend|only people in this chat can read|মেসেজ এবং কলগুলি|এন্ড-টু-এন্ড এনক্রিপ্ট)/i);
  if (inlineMatch && inlineMatch.index > 0) {
    sliced = sliced.slice(inlineMatch.index).trim();
  }

  // Strip trailing CTA link text ("Learn more", "আরও জানুন")
  sliced = sliced.replace(/\s*(?:learn\s+more|আরও\s+জানুন)\.?\s*$/i, '').trim();

  return sliced.replace(/\s+/g, ' ').trim();
}

/**
 * Normalize and truncate quoted reply text to at most maxChars total characters ending with "…".
 * @param {string} text
 * @param {number} [maxChars=140]
 * @returns {string}
 */
export function truncateQuoteText(text, maxChars = 140) {
  if (!text || typeof text !== 'string') return '';
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  const chars = Array.from(cleaned);
  if (chars.length <= maxChars) return cleaned;
  const cut = Math.max(1, maxChars - 1);
  return `${chars.slice(0, cut).join('').trimEnd()}…`;
}

// ─── WhatsApp Older Messages Prompt Patterns ──────────────────────────────────

// ─── Accessibility Message Stripping & Reaction Filtering ───────────────────

export const ACCESSIBILITY_PREFIX_REGEX = /^(?:you\s+sent|sent\s+by\s+you|you:|[^:\n]+\s+sent|enter,\s*message\s*sent|forwarded|seen(?:\s+by\s+[^:\n]+(?:\s+at\s+[^:\n]+)?)?|delivered|sent)\s*[:,\-]?\s*/i;
export const BENGALI_PREFIX_REGEX = /^(?:আপনি\s+পাঠিয়েছেন|আপনি\s+উত্তর\s+দিয়েছেন|উত্তর\s+দিয়েছেন|দেখা\s+হয়েছে|পাঠানো\s+হয়েছে)\s*[:,\-]?\s*/i;

const REPLY_LABEL_TRIGGER_RX = /(?:replied|respondiste|respondi[oó]|r[ée]pondu|geantwortet|respondeu|উত্তর\s*দিয়েছেন|জবাব\s*দিয়েছেন)/i;

function normalizeReplyLabelText(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/[\u00A0\u202F\u2007\u2009]/g, ' ')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse a Messenger/chat reply announcement label into structured attribution data.
 * Never guesses quoted sender when unparseable (sets quotedSender='Unknown', unparsed=true).
 * @param {string} str
 * @param {{ chatName?: string, myName?: string }} [_options={}]
 * @returns {{ isReply: boolean, replierName: string, replierIsMe: boolean|null, quotedSender: string, senderIsMe: boolean, isSelfReply: boolean, unparsed: boolean, rawLabel: string }}
 */
export function parseReplyLabel(str, options = {}) {
  const empty = {
    isReply: false,
    replierName: '',
    replierIsMe: null,
    quotedSender: '',
    senderIsMe: false,
    isSelfReply: false,
    unparsed: false,
    rawLabel: ''
  };
  const s = normalizeReplyLabelText(str);
  if (!s || s.length > 90) return empty;
  if (/[?!]/.test(s)) return empty;
  if (!REPLY_LABEL_TRIGGER_RX.test(s)) return empty;

  const rawMyName = options && typeof options.myName === 'string' ? options.myName.trim() : '';
  const meLabel = (rawMyName && !isBlockedUiName(rawMyName)) ? rawMyName : 'Me';
  const mk = (replierName, replierIsMe, quotedSender, senderIsMe, isSelfReply = false, unparsed = false) => ({
    isReply: true,
    replierName: (replierIsMe && replierName === 'Me') ? meLabel : replierName,
    replierIsMe,
    quotedSender: (senderIsMe && quotedSender === 'Me') ? meLabel : quotedSender,
    senderIsMe,
    isSelfReply,
    unparsed,
    rawLabel: s
  });

  // ── English ──
  if (/^you\s+replied\s+to\s+yourself$/i.test(s)) {
    return mk('Me', true, 'Me', true, true, false);
  }
  let m = s.match(/^you\s+replied\s+to\s+([^\n:]{1,45})$/i);
  if (m) {
    const target = m[1].trim();
    if (/^(?:you|yourself|me)$/i.test(target)) return mk('Me', true, 'Me', true, true, false);
    return mk('Me', true, target, false, false, false);
  }
  m = s.match(/^([^\n:]{1,45}?)\s+replied\s+to\s+you$/i);
  if (m) {
    const replier = m[1].trim();
    if (isLocalizedYou(replier)) return mk('Me', true, 'Me', true, true, false);
    return mk(replier, false, 'Me', true, false, false);
  }
  m = s.match(/^([^\n:]{1,45}?)\s+replied\s+to\s+(?:themselves|himself|herself|self)$/i);
  if (m) {
    const replier = m[1].trim();
    if (isLocalizedYou(replier)) return mk('Me', true, 'Me', true, true, false);
    return mk(replier, false, replier, false, true, false);
  }
  m = s.match(/^([^\n:]{1,45}?)\s+replied\s+to\s+([^\n:]{1,45})$/i);
  if (m) {
    const replier = m[1].trim();
    const target = m[2].trim();
    const rIsMe = isLocalizedYou(replier);
    const tIsMe = isLocalizedYou(target);
    const isSelf = rIsMe ? tIsMe : replier.toLowerCase() === target.toLowerCase();
    return mk(rIsMe ? 'Me' : replier, rIsMe, tIsMe ? 'Me' : target, tIsMe, isSelf, false);
  }

  // ── Bengali (NFC normalized) ──
  if (/^আপনি\s+নিজেকে\s+(?:উত্তর|জবাব)\s+দিয়েছেন$/.test(s)) {
    return mk('Me', true, 'Me', true, true, false);
  }
  m = s.match(/^আপনি\s+([^\n:]{1,45}?)(?:\s*-?\s*কে)\s+(?:উত্তর|জবাব)\s+দিয়েছেন$/);
  if (m) {
    const target = m[1].trim();
    return mk('Me', true, target, false, false, false);
  }
  m = s.match(/^([^\n:]{1,45}?)\s+আপনাকে\s+(?:উত্তর|জবাব)\s+দিয়েছেন$/);
  if (m) {
    const replier = m[1].trim();
    return mk(replier, false, 'Me', true, false, false);
  }
  m = s.match(/^([^\n:]{1,45}?)\s+নিজেকে\s+(?:উত্তর|জবাব)\s+দিয়েছেন$/);
  if (m) {
    const replier = m[1].trim();
    return mk(replier, false, replier, false, true, false);
  }
  m = s.match(/^([^\n:]{1,45}?)\s+([^\n:]{1,45}?)(?:\s*-?\s*কে)\s+(?:উত্তর|জবাব)\s+দিয়েছেন$/);
  if (m) {
    const replier = m[1].trim();
    const target = m[2].trim();
    return mk(replier, replier === 'আপনি', target, target === 'আপনাকে', replier === target, false);
  }

  // ── Spanish ──
  if (/^respondiste\s+a\s+ti\s+mismo$/i.test(s)) {
    return mk('Me', true, 'Me', true, true, false);
  }
  m = s.match(/^respondiste\s+a\s+([^\n:]{1,45})$/i);
  if (m) return mk('Me', true, m[1].trim(), false, false, false);
  m = s.match(/^([^\n:]{1,45}?)\s+te\s+respondi[oó]$/i);
  if (m) return mk(m[1].trim(), false, 'Me', true, false, false);
  m = s.match(/^([^\n:]{1,45}?)\s+se\s+respondi[oó]\s+a\s+s[ií]\s+mismo$/i);
  if (m) return mk(m[1].trim(), false, m[1].trim(), false, true, false);
  m = s.match(/^([^\n:]{1,45}?)\s+respondi[oó]\s+a\s+([^\n:]{1,45})$/i);
  if (m) return mk(m[1].trim(), false, m[2].trim(), false, m[1].trim().toLowerCase() === m[2].trim().toLowerCase(), false);

  // ── French ──
  m = s.match(/^(?:vous\s+avez\s+r[ée]pondu|tu\s+as\s+r[ée]pondu)\s+[àa]\s+([^\n:]{1,45})$/i);
  if (m) {
    const target = m[1].trim();
    const isSelf = /^(?:vous-m[êe]me|toi-m[êe]me)$/i.test(target);
    return mk('Me', true, isSelf ? 'Me' : target, isSelf, isSelf, false);
  }
  m = s.match(/^([^\n:]{1,45}?)\s+(?:vous|t')\s*a\s+r[ée]pondu$/i);
  if (m) return mk(m[1].trim(), false, 'Me', true, false, false);
  m = s.match(/^([^\n:]{1,45}?)\s+a\s+r[ée]pondu\s+[àa]\s+([^\n:]{1,45})$/i);
  if (m) return mk(m[1].trim(), false, m[2].trim(), false, m[1].trim().toLowerCase() === m[2].trim().toLowerCase(), false);

  // ── German ──
  m = s.match(/^du\s+hast\s+([^\n:]{1,45}?)\s+geantwortet$/i);
  if (m) {
    const target = m[1].trim();
    const isSelf = /^dir\s+selbst$/i.test(target);
    return mk('Me', true, isSelf ? 'Me' : target, isSelf, isSelf, false);
  }
  m = s.match(/^([^\n:]{1,45}?)\s+hat\s+dir\s+geantwortet$/i);
  if (m) return mk(m[1].trim(), false, 'Me', true, false, false);
  m = s.match(/^([^\n:]{1,45}?)\s+hat\s+([^\n:]{1,45}?)\s+geantwortet$/i);
  if (m) return mk(m[1].trim(), false, m[2].trim(), false, m[1].trim().toLowerCase() === m[2].trim().toLowerCase(), false);

  // ── Portuguese ──
  m = s.match(/^voc[êe]\s+respondeu\s+(?:a|para)\s+([^\n:]{1,45})$/i);
  if (m) {
    const target = m[1].trim();
    const isSelf = /^si\s+mesmo$/i.test(target);
    return mk('Me', true, isSelf ? 'Me' : target, isSelf, isSelf, false);
  }
  m = s.match(/^([^\n:]{1,45}?)\s+respondeu\s+(?:a|para)\s+voc[êe]$/i);
  if (m) return mk(m[1].trim(), false, 'Me', true, false, false);
  m = s.match(/^([^\n:]{1,45}?)\s+respondeu\s+(?:a|para)\s+([^\n:]{1,45})$/i);
  if (m) return mk(m[1].trim(), false, m[2].trim(), false, m[1].trim().toLowerCase() === m[2].trim().toLowerCase(), false);

  // ── Generic short/unparsed fallback without guessing quoted sender ──
  if (/^you\s+replied(?:\s+to)?$/i.test(s) || /^আপনি\s+(?:উত্তর|জবাব)\s+দিয়েছেন$/.test(s)) {
    return mk('Me', true, 'Unknown', false, false, true);
  }
  m = s.match(/^([^\n:]{2,35}?)\s+(?:replied(?:\s+to)?|(?:উত্তর|জবাব)\s+দিয়েছেন)$/);
  if (m && m[1].trim().split(/\s+/).length <= 4) {
    const replier = m[1].trim();
    const rIsMe = isLocalizedYou(replier);
    return mk(rIsMe ? 'Me' : replier, rIsMe ? true : false, 'Unknown', false, false, true);
  }

  return empty;
}

/**
 * Check if a string is a reply announcement label (e.g. "Nadira Fairuxa replied to you").
 * These are purely UI/accessibility headers and must NEVER be emitted as messages.
 * @param {string} str
 * @returns {boolean}
 */
export function isReplyLabel(str) {
  return parseReplyLabel(str).isReply;
}

/**
 * Extract quoted sender's name from a reply label string ("You replied to X" -> X, "X replied to you" -> "Me").
 * @param {string} str
 * @returns {string}
 */
export function extractReplySender(str) {
  const parsed = parseReplyLabel(str);
  return parsed.isReply ? parsed.quotedSender : '';
}

/**
 * Check if a text snippet is purely an accessibility label, reply label, or UI indicator.
 * @param {string} str
 * @returns {boolean}
 */
export function isPureAccessibilityLabel(str) {
  if (!str || typeof str !== 'string') return true;
  const s = str.replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/[\u00A0\u202F\u2007\u2009]/g, ' ')
    .trim();
  if (!s) return true;

  if (isReplyLabel(s)) return true;

  return /^(?:you\s+sent|sent\s+by\s+you|you:|[^:\n]+\s+sent|enter,\s*message\s*sent|forwarded(?:\s+an?\s+(?:image|photo|video|message|file|attachment))?|[^:\n]+\s+forwarded(?:\s+an?\s+(?:image|photo|video|message|file|attachment))?|seen(?:\s+by\s+.*)?|delivered|sent|active\s+now)$/i.test(s) ||
    /^(?:আপনি\s+পাঠিয়েছেন|আপনি\s+উত্তর\s+দিয়েছেন|উত্তর\s+দিয়েছেন|দেখা\s+হয়েছে|পাঠানো\s+হয়েছে)$/i.test(s);
}

/**
 * Clean message text by stripping hidden accessibility and screen-reader prefixes.
 * @param {string} raw
 * @returns {{ text: string, isOnlyAccessibility: boolean }}
 */
export function cleanMessageText(raw) {
  if (!raw || typeof raw !== 'string') return { text: '', isOnlyAccessibility: true };
  let s = raw.replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/[\u00A0\u202F\u2007\u2009]/g, ' ')
    .trim();
  if (!s) return { text: '', isOnlyAccessibility: true };

  if (isPureAccessibilityLabel(s)) {
    return { text: '', isOnlyAccessibility: true };
  }

  // Strip reply prefixes if someone replied in text
  s = s.replace(/^(?:you|[^\n:]+?)\s+replied(?:\s+to\s+[^\n:]+?)?\s*[:\-]\s*/i, '');
  s = s.replace(/^(?:আপনি|[^\n:]+?)\s+উত্তর\s+দিয়েছেন(?:\s+আপনাকে)?\s*[:\-]\s*/i, '');

  // Strip quoted original-message accessibility prefix when embedded inline
  s = s.replace(/^(?:[^\n:]{1,60}:\s*)?original\s+message:\s*/i, '');

  // Strip standard accessibility prefixes
  s = s.replace(ACCESSIBILITY_PREFIX_REGEX, '');
  s = s.replace(BENGALI_PREFIX_REGEX, '');
  s = s.trim();

  return { text: s, isOnlyAccessibility: !s };
}

/**
 * Check if a string is a duration chip like "0:05", "0:19", "1:02:30".
 * @param {string} str
 * @returns {boolean}
 */
export function isDurationChipText(str) {
  if (!str || typeof str !== 'string') return false;
  const s = str.replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u00A0\u202F]/g, ' ').trim();
  return /^\d{1,2}:\d{2}(?::\d{2})?$/.test(s);
}

/**
 * Check if a string contains at least one real emoji glyph.
 * @param {string} str
 * @returns {boolean}
 */
export function containsEmojiGlyph(str) {
  if (!str || typeof str !== 'string') return false;
  return /\p{Extended_Pictographic}|\p{Emoji_Presentation}/u.test(str);
}

const REACTION_EMOJI_RE = /(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:\uFE0F|\u200D(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}))*/gu;

function stripReactionAccessibilityNoise(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u00A0\u202F]/g, ' ')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, ' ')
    .replace(/\?{2,}/g, ' ')
    .replace(/\bsee\s+who(?:\s+reacted(?:\s+to\s+this)?)?\b/gi, ' ')
    .replace(/\bclick\s+to\s+see(?:\s+who(?:\s+reacted)?)?\b/gi, ' ')
    .replace(/\breacted\s+to\s+this\b/gi, ' ')
    .replace(/\breacted\s+with\b/gi, ' ')
    .replace(/\b\d*\s*reactions?\s+with\b/gi, ' ')
    .replace(/^(?:reactions?:?\s*)/i, ' ')
    .replace(/[;|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Format one structured reaction entry as "😂 Sudipta Roy", "😂 2", or "😂".
 * @param {{ emoji: string, reactors?: string[], count?: number }} entry
 * @returns {string}
 */
export function formatReactionChip(entry) {
  if (!entry || !entry.emoji) return '';
  const emoji = String(entry.emoji).trim();
  const reactors = Array.isArray(entry.reactors) ? entry.reactors.filter(Boolean) : [];
  const count = Number(entry.count) || 1;
  if (reactors.length === 1 && count <= 1) {
    return `${emoji} ${reactors[0]}`;
  }
  if (reactors.length > 1 && count <= reactors.length) {
    return `${emoji} ${reactors.join(', ')}`;
  }
  if (count > 1) {
    return `${emoji} ${count}`;
  }
  if (reactors.length === 1) {
    return `${emoji} ${reactors[0]}`;
  }
  return emoji;
}

/**
 * Parse raw reaction DOM / strings / arrays into structured deduplicated entries:
 * [{ emoji, reactor, reactors, count }]
 * Strips "reaction with", "see who", "reacted to this", durations ("0:19"), and duplicates.
 * @param {Element|string[]|null} [el=null]
 * @param {string} [rawText='']
 * @param {{ myName?: string }} [options={}]
 * @returns {Array<{ emoji: string, reactor: string, reactors: string[], count: number }>}
 */
export function parseStructuredReactions(el = null, rawText = '', options = {}) {
  const byEmoji = new Map();

  const record = (emoji, reactor = '', count = 1) => {
    const cleanEmoji = (emoji || '').trim();
    if (!cleanEmoji || !containsEmojiGlyph(cleanEmoji)) return;
    if (isDurationChipText(cleanEmoji) || /\?{2,}/.test(cleanEmoji)) return;

    let cleanReactor = stripReactionAccessibilityNoise(reactor || '');
    if (/^(?:you|me|yourself)$/i.test(cleanReactor)) {
      cleanReactor = options.myName && !isBlockedUiName(options.myName) ? options.myName : '';
    } else if (cleanReactor) {
      const validated = validatePersonName(cleanReactor);
      cleanReactor = validated || '';
    }

    const numCount = Math.max(1, parseInt(count, 10) || 1);
    if (!byEmoji.has(cleanEmoji)) {
      byEmoji.set(cleanEmoji, {
        emoji: cleanEmoji,
        reactors: new Set(),
        count: numCount
      });
    }
    const bucket = byEmoji.get(cleanEmoji);
    if (cleanReactor) bucket.reactors.add(cleanReactor);
    if (numCount > bucket.count) bucket.count = numCount;
  };

  const parseString = (input) => {
    if (!input || typeof input !== 'string') return;
    const normalized = input
      .replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u00A0\u202F]/g, ' ')
      .trim();
    if (!normalized || isDurationChipText(normalized) || /\?{2,}/.test(normalized)) return;

    const clauses = normalized.split(/[;\n]+/).map(c => c.trim()).filter(Boolean);
    for (const clause of clauses) {
      if (!containsEmojiGlyph(clause)) continue;
      if (/^\s*see\s+who\b/i.test(clause)) continue;

      const countWithRx = new RegExp(`(\\d+)\\s+reactions?\\s+with\\s+(${REACTION_EMOJI_RE.source})`, 'giu');
      let m;
      let matchedStructured = false;
      while ((m = countWithRx.exec(clause)) !== null) {
        record(m[2], '', parseInt(m[1], 10) || 1);
        matchedStructured = true;
      }

      const cleanedForName = clause
        .replace(/\b\d*\s*reactions?\s+with\s+(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:\uFE0F|\u200D(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}))*/giu, '')
        .replace(/\bsee\s+who(?:\s+reacted(?:\s+to\s+this)?)?\b/gi, '')
        .replace(/\breacted\s+to\s+this\b/gi, '')
        .trim();

      const whoReactedRx = new RegExp(`^([^\\d,;]+?)\\s+reacted(?:\\s+with)?\\s+(${REACTION_EMOJI_RE.source})`, 'iu');
      const wm = cleanedForName.match(whoReactedRx);
      if (wm) {
        record(wm[2], wm[1], 1);
        matchedStructured = true;
      }

      const cleaned = stripReactionAccessibilityNoise(clause);
      if (cleaned && containsEmojiGlyph(cleaned)) {
        const emCountRx = new RegExp(`(${REACTION_EMOJI_RE.source})\\s*(\\d+)\\b`, 'gu');
        let cm;
        while ((cm = emCountRx.exec(cleaned)) !== null) {
          record(cm[1], '', parseInt(cm[2], 10) || 1);
          matchedStructured = true;
        }

        if (!matchedStructured) {
          const emNameRx = new RegExp(`^(${REACTION_EMOJI_RE.source})\\s+([^\\d]+)$`, 'u');
          const enm = cleaned.match(emNameRx);
          if (enm && !containsEmojiGlyph(enm[2])) {
            record(enm[1], enm[2], 1);
            matchedStructured = true;
          }

          const nameEmRx = new RegExp(`^([^\\d]+?)\\s+(${REACTION_EMOJI_RE.source})$`, 'u');
          const nem = cleaned.match(nameEmRx);
          if (nem && !containsEmojiGlyph(nem[1])) {
            record(nem[2], nem[1], 1);
            matchedStructured = true;
          }
        }

        if (!matchedStructured) {
          const emojiMatches = cleaned.match(REACTION_EMOJI_RE) || [];
          for (const em of emojiMatches) {
            record(em, '', 1);
          }
        }
      }
    }
  };

  if (Array.isArray(el)) {
    for (const item of el) {
      if (typeof item === 'string') {
        parseString(item);
      } else if (item && typeof item === 'object' && item.emoji) {
        const reactor = item.reactor || (Array.isArray(item.reactors) ? item.reactors[0] : '') || '';
        record(item.emoji, reactor, item.count || 1);
      }
    }
  } else if (typeof el === 'string') {
    parseString(el);
  } else if (el && typeof el.querySelectorAll === 'function') {
    const imgs = el.querySelectorAll('img[alt]');
    const elAria = (el.getAttribute?.('aria-label') || '').trim();
    if (elAria) parseString(elAria);

    const ariaNodes = el.querySelectorAll('[aria-label]');
    for (const node of ariaNodes) {
      const a = (node.getAttribute('aria-label') || '').trim();
      if (a) parseString(a);
    }

    for (const img of imgs) {
      const alt = (img.getAttribute('alt') || '').trim();
      const parentAria = (img.parentElement?.getAttribute?.('aria-label') || elAria || '').trim();
      if (containsEmojiGlyph(alt)) {
        if (parentAria) parseString(parentAria);
        record(alt, '', 1);
      }
    }
  }

  if (rawText) {
    parseString(rawText);
  }

  return Array.from(byEmoji.values()).map(b => {
    const reactors = Array.from(b.reactors);
    const count = Math.max(b.count, reactors.length || 1);
    return {
      emoji: b.emoji,
      reactor: reactors[0] || '',
      reactors,
      who: reactors,
      count
    };
  });
}

/**
 * Normalize an existing reactions array/string into clean formatted strings.
 * @param {string[]|string} reactions
 * @param {{ myName?: string }} [options={}]
 * @returns {string[]}
 */
export function cleanReactionsList(reactions, options = {}) {
  if (!reactions) return [];
  const input = Array.isArray(reactions) ? reactions : [String(reactions)];
  const structured = parseStructuredReactions(input, '', options);
  return structured.map(formatReactionChip).filter(Boolean);
}

/**
 * Extract only real emoji reactions (with optional reactor name or count) from raw reaction text/DOM.
 * Formats cleanly as "😂 Sudipta Roy", "😂 2", or "😂".
 * Never allows durations ("0:19"), "???", "reaction with", "see who", or duplicates.
 * @param {Element|string[]|null} [el=null]
 * @param {string} [rawText='']
 * @param {{ myName?: string }} [options={}]
 * @returns {string[]}
 */
export function extractValidReactions(el = null, rawText = '', options = {}) {
  const structured = parseStructuredReactions(el, rawText, options);
  return structured.map(formatReactionChip).filter(Boolean);
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
 * NEVER matches empty media containers, video durations ("0:19"), or "???".
 * @param {string} rawText
 * @param {Element} [el=null]
 * @returns {boolean}
 */
export function isReactionOnly(rawText, el = null) {
  const s = (rawText || '').replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u00A0\u202F]/g, ' ').trim();

  // If element contains non-emoji media (video, audio, or content image), it is NEVER a reaction-only badge
  if (el && typeof el.querySelector === 'function') {
    if (el.querySelector('video, audio')) return false;
    const imgs = el.querySelectorAll ? Array.from(el.querySelectorAll('img')) : [];
    const hasContentImg = imgs.some(img => {
      const alt = (img.getAttribute('alt') || '').trim();
      const src = (img.getAttribute('src') || '').trim();
      const w = parseInt(img.getAttribute('width') || img.width || 0, 10);
      const h = parseInt(img.getAttribute('height') || img.height || 0, 10);
      if (src.includes('emoji.php') || (containsEmojiGlyph(alt) && w <= 24 && h <= 24)) return false;
      if (w > 48 || h > 48 || /photo|image|attachment|open photo/i.test(alt)) return true;
      return false;
    });
    if (hasContentImg) return false;
  }

  // Video duration chips like "0:19" or "0:05" or "???" are NEVER reactions
  if (isDurationChipText(s) || /^\?+$/.test(s)) {
    return false;
  }

  if (s && containsEmojiGlyph(s)) {
    const withoutEmojiAndNums = s.replace(/(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|\uFE0F|\u200D|\s|\d)+/gu, '');
    if (withoutEmojiAndNums.length === 0 && s.length <= 24) {
      return true;
    }
  }

  if (el && typeof el.getAttribute === 'function') {
    const aria = el.getAttribute('aria-label') || '';
    if (/reaction|reacted/i.test(aria) && (containsEmojiGlyph(aria) || (el.querySelector && el.querySelector('img[alt]')))) return true;
    const testid = el.getAttribute('data-testid') || '';
    if (/reaction/i.test(testid) && !el.querySelector?.('div[dir="auto"]')) return true;
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
  } catch (_) { }

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
export function normalizeDateString(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/[\u00A0\u202F\u2007\u2009]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pure syntactic check: returns true if the ENTIRE string matches a date/time
 * separator or hover timestamp pattern (independent of chronological lastDate).
 * Prevents rejected/backwards separators and hover timestamps from EVER being
 * emitted as chat messages.
 * @param {string} str
 * @param {'MDY'|'DMY'} [format='MDY']
 * @param {Date} [baseDate=new Date()]
 * @returns {boolean}
 */
export function looksLikeDateOrTimeSeparator(str, format = 'MDY', baseDate = new Date()) {
  const s = normalizeDateString(str);
  if (!s || s.length > 60) return false;
  // Pass allowFuture=true / no lastDate / synthetic base so syntax is checked independently of chronology
  return parseDateSeparatorText(s, format, null, baseDate, { skipRecencyCheck: true }) !== null;
}

/**
 * Strictly parse Messenger & WhatsApp date/time separators.
 * Strict rules:
 * - Standalone centered element matching explicit date/time patterns only.
 * - Never runs over message text, replies, or captions.
 * - 2-digit years 00-99 mean 2000-2099.
 * - Validates year >= 2008 and not in future.
 * - Rejects non-decreasing chronological jumps (backwards dates).
 * - ZERO fallback to new Date(s).
 * @param {string} str
 * @param {'MDY'|'DMY'} [format='MDY']
 * @param {Date|null} [lastDate=null]
 * @param {Date} [baseDate=new Date()]
 * @param {{ skipRecencyCheck?: boolean }} [opts={}]
 * @returns {Date|null}
 */
export function parseDateSeparatorText(str, format = 'MDY', lastDate = null, baseDate = new Date(), opts = {}) {
  if (!str || typeof str !== 'string') return null;
  const s = normalizeDateString(str);
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
    if (!opts.skipRecencyCheck && !isValidConversationDate(d, baseDate)) return null;
    if (opts.skipRecencyCheck && (!d || !(d instanceof Date) || isNaN(d.getTime()) || d.getFullYear() < 2008)) return null;
    if (lastDate && d.getTime() < lastDate.getTime()) {
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

  // 3. Text Month Date + Optional Time (e.g. "Oct 22, 2026, 2:22 PM", "May 11, 2026, 9:14 PM", "11 May 2026, 9:14 PM")
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
    if (!m && !/^today$/i.test(s)) return null;
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
    if (!m && !/^yesterday$/i.test(s)) return null;
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

  // 5. Weekday (+ optional Time): e.g. "Thu 5:12 PM", "Mon 10:32 AM", "Mon", "Monday"
  // Always resolves relative to baseDate (scan date): most recent such weekday on or before baseDate,
  // and must be >= lastDate (non-decreasing).
  const weekdayMatch = s.match(/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*(?:(?:[,\s]+at|[,\s]+)(\d{1,2}):(\d{2})\s*([ap]m)?)?$/i);
  if (weekdayMatch) {
    const weekdayMap = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const token = weekdayMatch[1].toLowerCase();
    // Avoid matching arbitrary words if abbreviated beyond 3 letters unless full weekday name
    if (!/^(?:mon|monday|tue|tues|tuesday|wed|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday|sun|sunday)$/.test(token)) {
      return null;
    }
    const targetDay = weekdayMap[token.slice(0, 3)];
    const tp = (weekdayMatch[2] && weekdayMatch[3])
      ? parseTimeParts(weekdayMatch[2], weekdayMatch[3], weekdayMatch[4])
      : { hours: 12, minutes: 0 };
    const scanRef = baseDate ? new Date(baseDate) : new Date();

    let diff = (scanRef.getDay() - targetDay + 7) % 7;
    let targetDate = new Date(scanRef.getFullYear(), scanRef.getMonth(), scanRef.getDate() - diff, tp.hours, tp.minutes);
    // If today is targetDay but resolved time is strictly after scanRef time, step back 7 days
    if (diff === 0 && !opts.skipRecencyCheck && targetDate.getTime() > scanRef.getTime() + 60 * 1000) {
      targetDate = new Date(scanRef.getFullYear(), scanRef.getMonth(), scanRef.getDate() - 7, tp.hours, tp.minutes);
    }
    return validateDate(targetDate);
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
  const s = normalizeDateString(raw);
  if (!s) return false;

  // Time: "1:22 AM", "17:45", "~1:22 AM", "1:22:30 PM"
  if (/^~?\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]\.?m\.?)?$/i.test(s)) return true;
  // Numeric date: "11/5/2026", "2026-11-05", "11.05.26"
  if (/^\d{1,4}[/\-.]\d{1,2}[/\-.]\d{1,4}$/.test(s)) return true;
  // Date + time: "11/5/2026, 1:22 AM"
  if (/^\d{1,4}[/\-.]\d{1,2}[/\-.]\d{1,4}[,\s]+\d{1,2}:\d{2}/.test(s)) return true;
  // Full month date/time or weekday separator: "Jun 10, 2026, 1:32 AM", "Thu 5:12 PM"
  if (looksLikeDateOrTimeSeparator(s)) return true;
  // Relative day keywords (English & localized)
  if (/^(?:today|yesterday|tomorrow|আজ|গতকাল|ayer|hoy|ontem|hoje|hier|aujourd'hui|gestern|heute|اليوم|أمس|आज|कल|hari ini|kemarin|bugün|dün|сегодня|вчера)(?:\s+(?:at\s+)?.*)?$/i.test(s)) {
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

// ─── UI Name Blocklist & Person Name Validation ─────────────────────────────

export const UI_NAME_BLOCKLIST_EXACT = new Set([
  // English Messenger / Facebook / WhatsApp interface labels
  'controls and settings',
  'account controls and settings',
  'settings',
  'settings and privacy',
  'menu',
  'main menu',
  'profile',
  'your profile',
  'my profile',
  'account',
  'your account',
  'accounts',
  'chats',
  'chat',
  'messenger',
  'facebook',
  'whatsapp',
  'notifications',
  'notification',
  'marketplace',
  'more',
  'more options',
  'search',
  'close',
  'back',
  'info',
  'information',
  'conversation information',
  'chat info',
  'call',
  'voice call',
  'audio call',
  'video call',
  'video chat',
  'people',
  'requests',
  'message requests',
  'archive',
  'archived chats',
  'communities',
  'help',
  'log out',
  'logout',
  'switch account',
  'preferences',
  'privacy',
  'security',
  'theme',
  'dark mode',
  'new message',
  'compose',
  'mute',
  'unmute',
  'pin',
  'unpin',
  'delete',
  'report',
  'block',
  'active now',
  'online',
  'offline',
  // Bengali
  'সেটিংস',
  'নিয়ন্ত্রণ ও সেটিংস',
  'প্রোফাইল',
  'আপনার প্রোফাইল',
  'অ্যাকাউন্ট',
  'চ্যাট',
  'মেসেঞ্জার',
  'ফেসবুক',
  'মেনু',
  'বিজ্ঞপ্তি',
  'মার্কেটপ্লেস',
  'আরও',
  'অনুসন্ধান',
  'বন্ধ করুন',
  'ফিরে যান',
  'তথ্য',
  'কল',
  'ভিডিও চ্যাট',
  'ভয়েস কল',
  'ভিডিও কল',
  // Spanish
  'controles y configuración',
  'controles y configuracion',
  'configuración',
  'configuracion',
  'menú',
  'perfil',
  'tu perfil',
  'cuenta',
  'notificaciones',
  'buscar',
  'cerrar',
  'atrás',
  'atras',
  'información',
  'informacion',
  'llamada',
  'videochat',
  // French
  'contrôles et paramètres',
  'controles et parametres',
  'paramètres',
  'parametres',
  'profil',
  'votre profil',
  'compte',
  'notifications',
  'rechercher',
  'fermer',
  'retour',
  'infos',
  'appel',
  'discussion vidéo',
  'discussion video',
  // German
  'steuerungen und einstellungen',
  'einstellungen',
  'menü',
  'profil',
  'dein profil',
  'konto',
  'benachrichtigungen',
  'suchen',
  'schließen',
  'zurück',
  'anruf',
  // Portuguese
  'controles e configurações',
  'controles e configuracoes',
  'configurações',
  'configuracoes',
  'seu perfil',
  'conta',
  'notificações',
  'notificacoes',
  'pesquisar',
  'fechar',
  'voltar',
  'informações',
  'informacoes',
  'chamada',
  'conversa de vídeo',
  'conversa de video',
  // Hindi / Arabic / Indonesian / Turkish / Vietnamese
  'सेटिंग्स',
  'प्रोफ़ाइल',
  'खाता',
  'الإعدادات',
  'الملف الشخصي',
  'الحساب',
  'pengaturan',
  'profil',
  'akun',
  'ayarlar',
  'hesap',
  'cài đặt',
  'hồ sơ',
  'tài khoản'
]);

export const UI_NAME_BLOCKLIST_SUBSTRINGS = [
  'controls and settings',
  'account controls',
  'settings and privacy',
  'settings & privacy',
  'your profile',
  'conversation info',
  'conversation information',
  'chat info',
  'video chat',
  'audio call',
  'voice call',
  'video call',
  'account menu',
  'main menu',
  'navigation',
  'notifications',
  'marketplace',
  'archived chats',
  'message requests',
  'switch account',
  'log out'
];

const UI_NAME_BLOCKLIST_RX = /\b(?:controls\s+and\s+settings|account\s+controls|settings\s*(?:and|&)\s*privacy|your\s+profile|video\s+chat|conversation\s+info(?:rmation)?|click\s+to\s+see|see\s+who\s+reacted)\b/i;

/**
 * Return true if a candidate string is a Messenger/WhatsApp UI label rather than a person name.
 * Matches case-insensitively and by substring for label-like strings.
 * @param {string} raw
 * @returns {boolean}
 */
export function isBlockedUiName(raw) {
  if (!raw || typeof raw !== 'string') return false;
  const s = raw
    .replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[:\s\-·|]+|[:\s\-·|]+$/g, '')
    .trim()
    .toLowerCase();
  if (!s) return false;
  if (UI_NAME_BLOCKLIST_EXACT.has(s)) return true;
  if (UI_NAME_BLOCKLIST_RX.test(s)) return true;
  for (const sub of UI_NAME_BLOCKLIST_SUBSTRINGS) {
    if (s.includes(sub)) return true;
  }
  const parts = s.split(/\s*[·|:\-]\s*/).map(p => p.trim()).filter(Boolean);
  if (parts.length > 1 && parts.every(p => UI_NAME_BLOCKLIST_EXACT.has(p))) {
    return true;
  }
  return false;
}

/**
 * Validate a candidate detected person name.
 * Accepts only if: not in blocklist, 2-60 chars, not time/date, not only symbols,
 * not generic placeholder ("me"/"you"/"unknown"), and not identical to contactName.
 * @param {string} raw
 * @param {{ contactName?: string }} [options={}]
 * @returns {string|null}
 */
export function validatePersonName(raw, options = {}) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '');
  s = s.replace(/\s+/g, ' ').replace(/^[:\s]+|[:\s]+$/g, '').trim();
  if (!s) return null;
  if (s.length < 2 || s.length > 60) return null;
  if (isBlockedUiName(s)) return null;
  if (/^(?:me|you|yourself|unknown|user|sender|contact|participant|null|undefined)$/i.test(s)) return null;
  if (isLocalizedYou(s)) return null;
  if (isTimeOrDateString(s)) return null;
  if (isEmojiOnlySender(s)) return null;
  const contactName = typeof options === 'string' ? options : (options?.contactName || '');
  if (contactName && typeof contactName === 'string') {
    const cNorm = contactName.replace(/\s+/g, ' ').trim().toLowerCase();
    if (cNorm && s.toLowerCase() === cNorm) return null;
  }
  return s;
}

/**
 * Resolve final display name for "me" following strict source priority:
 * 1. Explicit user setting ("My name in exports") if non-empty & not a blocked UI string.
 * 2. Validated detected name from the page (not blocklist, 2-60 chars, != contactName, etc.).
 * 3. Fallback: "Me".
 * @param {{ myNameSetting?: string, settingName?: string, myName?: string, detectedName?: string, contactName?: string }} [params={}]
 * @returns {string}
 */
export function resolveMyExportName(params = {}) {
  const { detectedName = '', contactName = '' } = params || {};
  const rawSetting = params?.myNameSetting ?? params?.settingName ?? params?.myName ?? '';
  if (typeof rawSetting === 'string') {
    const trimmed = rawSetting
      .replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (trimmed && !isBlockedUiName(trimmed)) {
      return trimmed.slice(0, 60);
    }
  }
  const validDetected = validatePersonName(detectedName, { contactName });
  if (validDetected) return validDetected;
  return 'Me';
}

const GENERIC_PLACEHOLDER_NAMES = new Set([
  'me', 'you', 'contact', 'messenger chat', 'whatsapp chat',
  'unknown chat', 'chat', 'unknown', 'system', 'conversation'
]);

/**
 * Return true when a candidate text/label is purely a participant's or contact's name
 * (exact match or contiguous word subset such as "Iqbal Mahmood" for "Iqbal Mahmood Durjoy").
 * Used to filter standalone avatar/sender labels and prevent "[Unrecognized message] <Name>".
 * @param {string} raw
 * @param {{ chatName?: string, myName?: string, detectedMyName?: string, knownSenders?: string[] }} [options={}]
 * @returns {boolean}
 */
export function isParticipantOrAvatarNameOnly(raw, options = {}) {
  if (!raw || typeof raw !== 'string') return false;
  const s = raw
    .replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[:\s]+|[:\s]+$/g, '')
    .trim();
  if (!s || s.length < 2 || s.length > 70) return false;
  if (isBlockedUiName(s)) return false;

  const rawLower = s.toLowerCase();
  const rawTokens = rawLower.split(/\s+/).filter(Boolean);
  if (rawTokens.length === 0 || rawTokens.every(t => t.length < 2)) return false;

  const opts = options && typeof options === 'object' ? options : {};
  const candidates = [
    opts.chatName,
    opts.myName,
    opts.detectedMyName,
    ...(Array.isArray(opts.knownSenders) ? opts.knownSenders : [])
  ];

  for (const cand of candidates) {
    if (!cand || typeof cand !== 'string') continue;
    const cleanCand = sanitizeChatName(cand, '').replace(/\s+/g, ' ').trim();
    if (!cleanCand || cleanCand.length < 2) continue;
    const candLower = cleanCand.toLowerCase();
    if (GENERIC_PLACEHOLDER_NAMES.has(candLower)) continue;

    if (rawLower === candLower) return true;

    const candTokens = candLower.split(/\s+/).filter(Boolean);
    if (rawTokens.length <= candTokens.length) {
      for (let start = 0; start <= candTokens.length - rawTokens.length; start++) {
        let allMatch = true;
        for (let j = 0; j < rawTokens.length; j++) {
          if (candTokens[start + j] !== rawTokens[j]) {
            allMatch = false;
            break;
          }
        }
        if (allMatch) return true;
      }
    }
  }

  return false;
}

/**
 * Sanitize a raw sender name.
 * - Strips invisible/RTL control characters.
 * - Trims and removes leading/trailing colons and spaces ("You::" -> "You", "Raj::" -> "Raj").
 * - Rejects time/date strings ("1:22 AM", "17:45", "11/5/2026", "Yesterday") -> returns null.
 * - Rejects UI button/menu strings ("Controls and Settings", "Settings", "Menu", etc.) -> returns null.
 * - Rejects empty/non-letter-only/system-accessibility strings -> returns null.
 * - Maps localized "You" to options.myName (when valid) if provided.
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
  if (!s || s.length < 2 || s.length > 60) return null;

  // 3. Reject UI interface strings ("Controls and Settings", "Settings", etc.)
  if (isBlockedUiName(s)) return null;

  // 4. Reject anything that looks like a time or date
  if (isTimeOrDateString(s)) return null;

  // 5. Reject pure accessibility/punctuation/emoji-only strings
  if (isEmojiOnlySender(s)) return null;

  // 6. Map localized "You" to user's display name if provided and safe
  if (options.myName && !isBlockedUiName(options.myName) && isLocalizedYou(s)) {
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

// ─── Messenger Icon-Only Patterns & Pruned DOM Skeletons ──────────────────────

export const LIKE_LABEL_PATTERNS = [
  /\b(?:like|thumbs?\s*up(?:\s*sign)?)\b/i,
  /লাইক|থাম্বস\s*আপ/,
  /\b(?:me\s+gusta|pulgar\s+arriba)\b/i,
  /\b(?:j['’]aime|pouce\s+lev[ée])\b/i,
  /\b(?:gef[äa]llt\s+mir|daumen\s+hoch)\b/i,
  /\b(?:curtir|polegar\s+para\s+cima)\b/i,
  /पसंद|थंब्स\s*अप/,
  /إعجاب|أعجبني/,
  /\b(?:suka|jempol\s+ke\s+atas)\b/i,
  /\b(?:beğen|başparmak\s+yukarı)\b/i,
  /\b(?:нравится|палец\s+вверх)\b/i
];

const REACTION_ACTION_OR_SUMMARY_RE = /\b(?:react(?:ed|ions?)?|see\s+who(?:\s+reacted)?|reacted\s+with|click\s+to\s+see)\b/i;
const TOOLBAR_ACTION_ARIA_RE = /^(?:more|reply|react|remove|forward|unsend|more\s+options|react\s+to\s+message|remove\s+reaction|open\s+more)$/i;
const GENERIC_SKIP_ROLES = new Set(['row', 'gridcell', 'presentation', 'none']);

/**
 * Return true if an accessibility label, SVG title, or image alt represents
 * Messenger's standalone Like / thumbs-up button message.
 * @param {string} str
 * @returns {boolean}
 */
export function isLikeLabel(str) {
  if (!str || typeof str !== 'string') return false;
  const s = str
    .replace(/[\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s || s.length > 70) return false;
  if (REACTION_ACTION_OR_SUMMARY_RE.test(s)) return false;
  if (/^👍\uFE0F?$/.test(s)) return true;
  return LIKE_LABEL_PATTERNS.some(rx => rx.test(s));
}

/**
 * Collect unique semantic accessibility labels from a row and its descendants
 * (`role`, `aria-label`, `title`, `alt`, `<svg><title>`), excluding hover toolbar buttons.
 * @param {Element} row
 * @returns {string[]}
 */
export function extractRowAccessibilityLabels(row) {
  if (!row || (typeof Element !== 'undefined' && !(row instanceof Element))) return [];
  const labels = [];
  const seen = new Set();
  const addLabel = (entry) => {
    if (entry && !seen.has(entry)) {
      seen.add(entry);
      labels.push(entry);
    }
  };

  const elements = [row, ...(row.querySelectorAll ? Array.from(row.querySelectorAll('*')) : [])];
  for (const el of elements) {
    const role = (el.getAttribute?.('role') || '').trim();
    const aria = (el.getAttribute?.('aria-label') || '').replace(/\s+/g, ' ').trim();
    const title = (el.getAttribute?.('title') || '').replace(/\s+/g, ' ').trim();
    const alt = (el.getAttribute?.('alt') || '').replace(/\s+/g, ' ').trim();

    if (role === 'button' && TOOLBAR_ACTION_ARIA_RE.test(aria)) continue;
    if (aria && TOOLBAR_ACTION_ARIA_RE.test(aria)) continue;

    if (role && !GENERIC_SKIP_ROLES.has(role.toLowerCase())) {
      addLabel(`role="${role}"`);
    }
    if (aria) {
      addLabel(`aria-label="${aria.slice(0, 80)}"`);
    }
    if (title) {
      addLabel(`title="${title.slice(0, 80)}"`);
    }
    if (alt) {
      addLabel(`alt="${alt.slice(0, 80)}"`);
    }

    if ((el.tagName || '').toLowerCase() === 'title' && el.closest?.('svg')) {
      const svgTitle = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (svgTitle) addLabel(`svg.title="${svgTitle.slice(0, 80)}"`);
    }
  }

  return labels;
}

/**
 * Build a compact, pruned DOM skeleton string (<= maxChars, default 800) for debug reports.
 * Strips noisy classes, inline styles, SVG path coordinates, and long URLs while preserving
 * tag names, semantic attributes (role, aria-label, title, alt, data-* names), and <svg><title>.
 * Collapses single-child unattributed wrapper divs/spans and enforces includeSampleText privacy.
 * Compatible with both browser DOM Elements and test MockElements.
 * @param {Element} el
 * @param {{ maxChars?: number, includeSampleText?: boolean }} [options={}]
 * @returns {string}
 */
export function buildPrunedDomSkeleton(el, options = {}) {
  if (!el || (typeof Element !== 'undefined' && !(el instanceof Element))) return '';
  const maxChars = Number.isFinite(options?.maxChars) && options.maxChars > 0 ? options.maxChars : 800;
  const includeSampleText = Boolean(options?.includeSampleText);

  const escAttr = (v) => String(v).replace(/"/g, "'").replace(/\s+/g, ' ').trim();
  const SVG_SHAPE_TAGS = new Set(['path', 'circle', 'rect', 'polygon', 'polyline', 'line', 'ellipse', 'use']);

  const collectKeptAttrs = (node) => {
    const attrs = [];
    const priorityNames = ['role', 'aria-label', 'title', 'alt'];
    for (const name of priorityNames) {
      const val = node.getAttribute?.(name);
      if (val !== null && val !== undefined && String(val).trim() !== '') {
        attrs.push(`${name}="${escAttr(String(val).slice(0, 80))}"`);
      }
    }
    const rawAttrs = node.attributes
      ? Array.from(node.attributes)
      : (node._attrs && typeof node._attrs === 'object'
        ? Object.entries(node._attrs).map(([name, value]) => ({ name, value }))
        : []);
    let dataCount = 0;
    for (const a of rawAttrs) {
      if (!a || !a.name || !a.name.startsWith('data-')) continue;
      if (a.name === 'data-rect') continue;
      if (dataCount >= 3) break;
      const val = String(a.value || '').trim();
      if ((a.name === 'data-scope' || a.name === 'data-testid') && val && val.length <= 30) {
        attrs.push(`${a.name}="${escAttr(val)}"`);
      } else {
        attrs.push(a.name);
      }
      dataCount++;
    }
    return attrs;
  };

  const serialize = (node, depth = 0, insideSvg = false, parentTag = '') => {
    if (!node || depth > 25) return '';
    if (node.nodeType === 3) {
      const rawVal = (node.nodeValue !== undefined && node.nodeValue !== null)
        ? node.nodeValue
        : (node.textContent || '');
      const txt = String(rawVal).replace(/\s+/g, ' ').trim();
      if (!txt) return '';
      if (insideSvg && parentTag === 'title') {
        return txt.slice(0, 60);
      }
      if (!includeSampleText) return '[text]';
      return txt.length > 40 ? `${txt.slice(0, 39)}…` : txt;
    }
    if (node.nodeType !== 1) return '';

    const tag = (node.tagName || 'div').toLowerCase();
    if (tag === 'script' || tag === 'style') return '';

    const nowSvg = insideSvg || tag === 'svg';
    const attrs = collectKeptAttrs(node);

    if (nowSvg && SVG_SHAPE_TAGS.has(tag)) {
      const attrStr = attrs.length ? ` ${attrs.join(' ')}` : '';
      return `<${tag}${attrStr}/>`;
    }

    const childNodes = Array.from(node.childNodes || []);
    const childParts = [];
    let svgShapeCount = 0;
    let svgEllipsisAdded = false;
    let directNonEmptyText = false;
    let elementChildrenOut = 0;

    for (const ch of childNodes) {
      if (ch.nodeType === 3) {
        const out = serialize(ch, depth + 1, nowSvg, tag);
        if (out) {
          directNonEmptyText = true;
          childParts.push(out);
        }
        continue;
      }
      if (ch.nodeType === 1) {
        const chTag = (ch.tagName || '').toLowerCase();
        if (nowSvg && SVG_SHAPE_TAGS.has(chTag)) {
          svgShapeCount++;
          if (svgShapeCount > 1) {
            if (!svgEllipsisAdded) {
              childParts.push('...');
              svgEllipsisAdded = true;
            }
            continue;
          }
        }
        const out = serialize(ch, depth + 1, nowSvg, tag);
        if (out) {
          elementChildrenOut++;
          childParts.push(out);
        }
      }
    }

    if ((tag === 'div' || tag === 'span') && attrs.length === 0 && !directNonEmptyText) {
      if (childParts.length === 0) return '';
      if (elementChildrenOut === 1 && childParts.length === 1) {
        return childParts[0];
      }
    }

    const attrStr = attrs.length ? ` ${attrs.join(' ')}` : '';
    const inner = childParts.join('');
    if (!inner) {
      return `<${tag}${attrStr}/>`;
    }
    return `<${tag}${attrStr}>${inner}</${tag}>`;
  };

  const skeleton = serialize(el, 0, false, '') || `<${(el.tagName || 'div').toLowerCase()}/>`;
  if (skeleton.length <= maxChars) return skeleton;

  // Ensure semantic labels remain visible even if truncated
  const labels = extractRowAccessibilityLabels(el);
  const prelim = skeleton.slice(0, maxChars - 1);
  const missingLabels = labels.filter(l => !prelim.includes(l));
  if (missingLabels.length > 0) {
    const suffix = ` … [labels: ${missingLabels.join('; ')}]`;
    if (suffix.length < maxChars - 20) {
      const keep = Math.max(0, maxChars - suffix.length);
      return `${skeleton.slice(0, keep)}${suffix}`.slice(0, maxChars);
    }
  }
  return `${skeleton.slice(0, Math.max(1, maxChars - 1))}…`;
}

export { WhatsAppAdapter } from './adapters/whatsapp.js';
