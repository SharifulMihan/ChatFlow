/**
 * transcript.js
 * Formats extracted messages into clean transcripts, grouped conversation blocks,
 * participant statistics, and localized date/time strings.
 */

import {
  isValidConversationDate,
  isLocalizedYou,
  cleanReactionsList,
  isBlockedUiName,
  validatePersonName,
  resolveMyExportName,
  isDurationChipText,
  looksLikeDateOrTimeSeparator,
  truncateQuoteText
} from '../content/selectors.js';

export {
  isBlockedUiName,
  validatePersonName,
  resolveMyExportName,
  cleanReactionsList,
  truncateQuoteText
};

export const DEFAULT_EXPORT_OPTIONS = Object.freeze({
  layout: 'bubbles',
  dateFormat: 'auto',
  timeFormat: 'auto',
  includeSummary: true,
  includeTimestamps: true,
  groupBySender: false,
  groupWindowMs: 5 * 60 * 1000,
  showReactions: true,
  showMediaLabels: true,
  showSystemMessages: true,
  hideQuotedReplies: false,
  pageSize: 'A4',
  fontSize: 'M',
  colorMode: 'color',
  myName: '',
  detectedMyName: '',
  chatName: '',
  platform: 'WhatsApp',
  dateRangeStart: null,
  dateRangeEnd: null,
  renameMap: {}
});

export function normalizeExportOptions(options = {}, overrides = {}) {
  const safeOpts = options && typeof options === 'object' ? options : {};
  const safeOverrides = overrides && typeof overrides === 'object' ? overrides : {};
  const merged = {
    ...DEFAULT_EXPORT_OPTIONS,
    ...safeOpts,
    ...safeOverrides
  };
  merged.groupBySender = merged.groupBySender === true;
  if (!merged.renameMap || typeof merged.renameMap !== 'object') {
    merged.renameMap = {};
  }
  return merged;
}

export const PARTICIPANT_COLORS = [
  '1B5E3F', // Emerald
  '1D4ED8', // Royal Blue
  '9333EA', // Purple
  'C2410C', // Terracotta
  '0F766E', // Teal
  'BE123C', // Crimson
  '4338CA', // Indigo
  '854D0E'  // Amber Brown
];

export const PARTICIPANT_BG_TINTS = [
  'E8F5EE',
  'EFF6FF',
  'F5F3FF',
  'FFF7ED',
  'F0FDFA',
  'FFF1F2',
  'EEF2FF',
  'FEFCE8'
];

// ─── Formatting ──────────────────────────────────────────────────────────────

/**
 * Format a Date or ISO string as "YYYY-MM-DD HH:mm".
 * @param {Date|string|null} dateInput
 * @param {boolean} [approximate=false]
 * @returns {string}
 */
export function formatTimestamp(dateInput, approximate = false) {
  if (!dateInput) return 'unknown time';
  const date = (dateInput instanceof Date) ? dateInput : new Date(dateInput);
  if (isNaN(date.getTime()) || !isValidConversationDate(date)) return 'unknown time';

  const pad = n => String(n).padStart(2, '0');
  const str = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
              `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return approximate ? `~${str}` : str;
}

/**
 * Format a date according to user's chosen dateFormat ('auto' | 'DMY' | 'MDY' | 'YMD' | 'full').
 */
export function formatExportDate(dateInput, dateFormat = 'auto') {
  if (!dateInput) return 'Date unknown';
  const d = (dateInput instanceof Date) ? dateInput : new Date(dateInput);
  if (isNaN(d.getTime()) || !isValidConversationDate(d)) return 'Date unknown';

  const pad = n => String(n).padStart(2, '0');
  if (dateFormat === 'DMY') return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  if (dateFormat === 'MDY') return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`;
  if (dateFormat === 'YMD') return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (dateFormat === 'full') {
    return new Intl.DateTimeFormat(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(d);
  }
  if (dateFormat === 'medium') {
    return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).format(d);
  }
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(d);
}

/**
 * Format a time according to user's chosen timeFormat ('auto' | '12h' | '24h').
 * Never adds '~' for WhatsApp.
 */
export function formatExportTime(dateInput, timeFormat = 'auto', approximate = false, platform = 'WhatsApp') {
  if (!dateInput) return '';
  const d = (dateInput instanceof Date) ? dateInput : new Date(dateInput);
  if (isNaN(d.getTime()) || !isValidConversationDate(d)) return '';

  const opts = { hour: '2-digit', minute: '2-digit' };
  if (timeFormat === '12h') opts.hour12 = true;
  else if (timeFormat === '24h') opts.hour12 = false;

  const formatted = new Intl.DateTimeFormat(undefined, opts).format(d);
  const isWhatsApp = (platform || '').toLowerCase().includes('whatsapp');
  return (approximate && !isWhatsApp) ? `~${formatted}` : formatted;
}

/**
 * Format a media/non-text message as a clean chip label with Unicode symbol.
 */
export function formatMediaChip(msg) {
  const type = msg?.type || 'text';
  const raw = (msg?.text || '').trim();
  const desc = (msg?.mediaDescription || '').trim();
  switch (type) {
    case 'like': return '👍 Like';
    case 'image': return '📷 Photo';
    case 'video': {
      const dur = msg?.duration || (raw.match(/\((\d+:\d{2})\)/)?.[1]) || (isDurationChipText(raw) ? raw : '');
      return dur ? `🎬 Video (${dur})` : '🎬 Video';
    }
    case 'voice': {
      const dur = msg?.duration || (raw.match(/\((\d+:\d{2})\)/)?.[1]) || '';
      return dur ? `🎤 Voice message (${dur})` : '🎤 Voice message';
    }
    case 'sticker': {
      if (desc && !/^\[?sticker\]?$/i.test(desc)) return `🏷️ Sticker — ${desc}`;
      return '🏷️ Sticker';
    }
    case 'gif': {
      if (desc && !/^\[?gif\]?$/i.test(desc)) return `🎞️ GIF — ${desc}`;
      return '🎞️ GIF';
    }
    case 'link': return raw ? `🔗 ${raw}` : '🔗 Link';
    case 'file': {
      const m = raw.match(/\[document:\s*(.+?)\]/i);
      return m ? `📄 Document: ${m[1]}` : (raw && !/^document$/i.test(raw) ? `📄 Document: ${raw}` : '📄 Document');
    }
    case 'location': return '📍 Location';
    case 'contact':  return '👤 Contact';
    case 'poll':     return '📊 Poll';
    case 'call': {
      return raw.toLowerCase().includes('missed') ? '📞 Call (missed)' : '📞 Call';
    }
    case 'deleted': return 'This message was deleted';
    case 'other': {
      const label = desc || raw.replace(/^\[|\]$/g, '').trim();
      return label ? `📎 ${label}` : '📎 Attachment';
    }
    case 'unrecognized': {
      const cleaned = raw.replace(/^\[Unrecognized message\]\s*/i, '').trim();
      return cleaned ? `[Unrecognized message] ${cleaned}` : '[Unrecognized message]';
    }
    default: return raw;
  }
}

/**
 * Return a normalized media chip label if a quoted reply references media, else null.
 * @param {Object|string|null} replyTo
 * @returns {string|null}
 */
export function detectQuotedMediaType(replyTo) {
  if (!replyTo || typeof replyTo !== 'object') return null;
  const rawType = String(replyTo.mediaType || replyTo.type || '').trim().toLowerCase();
  const rawText = String(replyTo.text || '').replace(/\s+/g, ' ').trim().toLowerCase();

  if (rawType === 'like' || /^👍\uFE0F?$/.test(rawText) || /^\[?like\]?$/i.test(rawText)) {
    return '👍 Like';
  }
  if (rawType === 'video' || /^\[?(?:🎬\s*)?video(?:\s*\(\d{1,2}:\d{2}\))?\]?$/i.test(rawText)) {
    return '🎬 Video';
  }
  if (rawType === 'image' || rawType === 'photo' || /^\[?(?:📷\s*)?(?:photo|image)\]?$/i.test(rawText)) {
    return '📷 Photo';
  }
  if (rawType === 'voice' || rawType === 'audio' || /^\[?(?:🎤\s*)?(?:voice\s+message|voice|audio)(?:\s*\(\d{1,2}:\d{2}\))?\]?$/i.test(rawText)) {
    return '🎤 Voice message';
  }
  if (rawType === 'gif' || /^\[?(?:🎞️\s*)?gif\]?$/i.test(rawText)) {
    return '🎞️ GIF';
  }
  if (rawType === 'sticker' || /^\[?(?:🏷️\s*)?sticker\]?$/i.test(rawText)) {
    return '🏷️ Sticker';
  }
  if (rawType === 'link' || /^\[?(?:🔗\s*)?link\]?$/i.test(rawText)) {
    return '🔗 Link';
  }
  if (rawType === 'file' || rawType === 'document' || /^\[?(?:📄\s*)?(?:attachment|file|document)\]?$/i.test(rawText)) {
    return '📄 Document';
  }
  return null;
}

function cleanQuotedBodyText(rawText, quotedSender = '') {
  if (!rawText || typeof rawText !== 'string') return '';
  let s = rawText.replace(/[\u200B-\u200D\uFEFF\u200E\u200F]/g, '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  s = s.replace(/^(?:[^\n:]{1,40}:\s*)?original\s+message:\s*/i, '').trim();
  if (quotedSender) {
    const esc = quotedSender.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp(`^${esc}\\s*:\\s*`, 'i'), '').trim();
  }
  // Remove stray colon-only prefix like "Sudipta:" if left at start of quote
  s = s.replace(/^[A-Za-z\u00C0-\u024F\u0980-\u09FF][A-Za-z\u00C0-\u024F\u0980-\u09FF\s]{0,30}:\s*$/i, '').trim();
  return s;
}

/**
 * Format structured quote block parts for a reply message across .docx, .pdf, and .txt.
 * - Never outputs "Replying to you" (uses myName instead).
 * - Never leaves stray colon-only labels ("Sudipta:") or "Original message:".
 * - Truncates text quotes to 140 chars with "…".
 * - Renders quoted media as "↪ Replying to <Name> · 🎬 Video" (etc.) with no body text.
 *
 * @param {Object|string|null} replyTo
 * @param {Object|null} [msg=null]
 * @param {Object} [options={}]
 * @returns {{ headerText: string, bodyText: string, quotedSender: string, isQuotedMe: boolean, mediaChip: string|null, borderColorHex: string }|null}
 */
export function formatReplyQuoteParts(replyTo, msg = null, options = {}) {
  if (!replyTo) return null;
  if (
    replyTo &&
    typeof replyTo === 'object' &&
    'replyTo' in replyTo &&
    (!msg || (!('id' in msg) && !('direction' in msg) && !('isMe' in msg)))
  ) {
    options = msg || {};
    msg = replyTo;
    replyTo = msg.replyTo;
    if (!replyTo) return null;
  }
  const safeOpts = options && typeof options === 'object' ? options : {};
  const obj = typeof replyTo === 'object' ? replyTo : { text: String(replyTo) };
  const contactName = safeOpts.chatName || safeOpts.contactName || '';
  const myName = resolveMyExportName({
    myNameSetting: safeOpts.myName,
    detectedName: safeOpts.detectedMyName,
    contactName
  });
  const isGroup = Boolean(safeOpts.isGroup);
  const isBW = safeOpts.colorMode === 'bw' || safeOpts.colorScheme === 'bw';

  const rawSender = String(obj.sender || '').replace(/[:\s]+$/g, '').replace(/\s+/g, ' ').trim();
  const isMeFlag = Boolean(
    obj.senderIsMe === true ||
    isLocalizedYou(rawSender) ||
    /^(?:you|me|yourself)$/i.test(rawSender) ||
    isBlockedUiName(rawSender) ||
    (rawSender && rawSender.toLowerCase() === myName.toLowerCase()) ||
    (!isGroup && msg && !(msg.isMe || msg.isOutgoing) && !rawSender)
  );

  let quotedSender = '';
  if (isMeFlag) {
    quotedSender = myName;
  } else if (rawSender) {
    quotedSender = rawSender.replace(/\s*:\s*original\s+message$/i, '').trim();
  } else if (!isGroup && msg) {
    quotedSender = (msg.isMe || msg.isOutgoing) ? (contactName || 'Contact') : myName;
  } else {
    quotedSender = 'Contact';
  }

  const isQuotedMe = isMeFlag || quotedSender.toLowerCase() === myName.toLowerCase();
  const rawCleaned = cleanQuotedBodyText(obj.text || '', quotedSender);
  const mediaChip = detectQuotedMediaType({ ...obj, text: rawCleaned || obj.text || '' });

  let headerText = `↪ Replying to ${quotedSender}`;
  let bodyText = '';

  const isPlaceholderOnly = !rawCleaned ||
    /^\[?(?:(?:🎬|📷|🎤|🎞️|🏷️|📄|▶|\u25B6)\s*)?(?:video|photo|image|voice(?:\s+message)?|audio|gif|sticker|attachment|file|document)?(?:\s*\(?\d{1,2}:\d{2}(?::\d{2})?\)?)?\]?$/i.test(rawCleaned);

  if (mediaChip && isPlaceholderOnly) {
    headerText = `↪ Replying to ${quotedSender} · ${mediaChip}`;
    bodyText = '';
  } else {
    bodyText = truncateQuoteText(rawCleaned, 140);
  }

  if (!bodyText && !mediaChip && !quotedSender) return null;

  let borderColorHex = isBW ? '6B7280' : (isQuotedMe ? PARTICIPANT_COLORS[0] : PARTICIPANT_COLORS[1]);
  if (!isBW && safeOpts.colorBySender && typeof safeOpts.colorBySender.get === 'function') {
    const exact = safeOpts.colorBySender.get(quotedSender);
    if (exact) {
      borderColorHex = exact;
    } else {
      const qLow = quotedSender.toLowerCase();
      for (const [pName, hex] of safeOpts.colorBySender.entries()) {
        if (pName.toLowerCase() === qLow || pName.toLowerCase().startsWith(`${qLow} `)) {
          borderColorHex = hex;
          break;
        }
      }
    }
  }

  return {
    headerText,
    bodyText,
    header: headerText,
    body: bodyText,
    quotedSender,
    isQuotedMe,
    mediaChip,
    borderColorHex
  };
}

/**
 * Apply date range filter, myName override, participant renames, and system-message toggle.
 */
export function prepareMessagesForExport(messages, options = DEFAULT_EXPORT_OPTIONS) {
  const {
    dateRangeStart,
    dateRangeEnd,
    myName,
    detectedMyName,
    chatName,
    renameMap,
    showSystemMessages
  } = normalizeExportOptions(options);

  let filtered = Array.isArray(messages) ? messages : [];

  if (dateRangeStart) {
    const sTime = new Date(dateRangeStart).getTime();
    filtered = filtered.filter(m => {
      const t = m.timestamp ? new Date(m.timestamp).getTime() : 0;
      return t >= sTime;
    });
  }
  if (dateRangeEnd) {
    const eTime = new Date(dateRangeEnd).getTime();
    filtered = filtered.filter(m => {
      const t = m.timestamp ? new Date(m.timestamp).getTime() : 0;
      return t <= eTime;
    });
  }

  if (!showSystemMessages) {
    filtered = filtered.filter(m => m.type !== 'system');
  }

  const resolvedMyName = resolveMyExportName({
    myNameSetting: myName,
    detectedName: detectedMyName,
    contactName: chatName
  });
  const hasExplicitMyName = Boolean(myName && !isBlockedUiName(myName) && myName.trim());
  const hasRenames = renameMap && Object.keys(renameMap).length > 0;

  return filtered
    .filter(m => {
      if (!m) return false;
      // Drop pure leaked date/separator junk if it had no media/quote and wasn't unrecognized
      if ((!m.type || m.type === 'text') && !m.replyTo) {
        const txt = (m.text || '').trim();
        if (!txt) return false;
        if (looksLikeDateOrTimeSeparator(txt)) return false;
      }
      return true;
    })
    .map(m => {
      let sender = (m.sender || '').trim() || m.sender;
      const isOut = !!(m.isMe || m.isOutgoing);
      if (m.type !== 'system' && m.type !== 'unrecognized') {
        if (isOut) {
          if (hasExplicitMyName || !sender || sender === 'Me' || isLocalizedYou(sender) || isBlockedUiName(sender)) {
            sender = resolvedMyName;
          }
        } else if (isBlockedUiName(sender)) {
          sender = chatName || 'Contact';
        }
        if (hasRenames && renameMap[sender]) {
          sender = renameMap[sender];
        }
      }

      let replyTo = m.replyTo;
      if (replyTo && typeof replyTo === 'object') {
        let rSender = (replyTo.sender || '').replace(/[:\s]+$/g, '').trim();
        const rIsMe = Boolean(
          replyTo.senderIsMe === true ||
          isLocalizedYou(rSender) ||
          /^(?:you|me|yourself)$/i.test(rSender) ||
          isBlockedUiName(rSender)
        );
        if (rIsMe) {
          rSender = resolvedMyName;
        } else if (rSender && hasRenames && renameMap[rSender]) {
          rSender = renameMap[rSender];
        }
        const cleanedRText = cleanQuotedBodyText(replyTo.text || '', rSender);
        const rawQuoteText = (cleanedRText || replyTo.text || '').trim();
        const rawMedia = (replyTo.mediaType || (replyTo.type && replyTo.type !== 'text' ? replyTo.type : '') || '').toLowerCase();
        const MEDIA_ALIAS = { photo: 'image', audio: 'voice', document: 'file', attachment: 'file' };
        let normMedia = MEDIA_ALIAS[rawMedia] || (rawMedia && rawMedia !== 'text' ? rawMedia : null);
        if (!normMedia && /^\[?(?:🎬|📷|🎤|🎞️|🏷️|📄|🔗)?\s*(?:photo|image|video|voice(?:\s*message)?|audio|sticker|gif|file|attachment|document|link)\]?$/i.test(rawQuoteText)) {
          if (/video/i.test(rawQuoteText)) normMedia = 'video';
          else if (/photo|image/i.test(rawQuoteText)) normMedia = 'image';
          else if (/voice|audio/i.test(rawQuoteText)) normMedia = 'voice';
          else if (/sticker/i.test(rawQuoteText)) normMedia = 'sticker';
          else if (/gif/i.test(rawQuoteText)) normMedia = 'gif';
          else if (/link/i.test(rawQuoteText)) normMedia = 'link';
          else normMedia = 'file';
        }
        const isPureMediaPlaceholder = Boolean(normMedia) && (
          !rawQuoteText ||
          /^\[?(?:🎬|📷|🎤|🎞️|🏷️|📄|🔗)?\s*(?:photo|image|video|voice(?:\s*message)?|audio|sticker|gif|file|attachment|document|link)\]?$/i.test(rawQuoteText)
        );
        replyTo = {
          sender: rSender || 'Unknown',
          text: isPureMediaPlaceholder ? '' : truncateQuoteText(rawQuoteText, 140),
          type: normMedia || 'text',
          mediaType: normMedia,
          senderIsMe: rIsMe
        };
      }

      const cleanReactions = Array.isArray(m.reactions)
        ? cleanReactionsList(m.reactions, { myName: resolvedMyName })
        : [];

      return { ...m, sender, replyTo, reactions: cleanReactions };
    });
}

/**
 * Compute detailed participant stats & assign fixed colors.
 */
export function computeParticipantStats(messages, colorMode = 'color') {
  const map = new Map();
  let nonSystemTotal = 0;

  for (const m of messages) {
    if (m.type === 'system') continue;
    const name = (m.sender || '').trim() || (m.isMe ? 'Me' : 'Contact');
    nonSystemTotal++;

    const ts = m.timestamp ? new Date(m.timestamp) : null;
    const validTs = ts && isValidConversationDate(ts) ? ts : null;

    if (!map.has(name)) {
      map.set(name, {
        name,
        count: 0,
        isMe: !!(m.isMe || m.isOutgoing),
        firstTimestamp: validTs,
        lastTimestamp: validTs
      });
    }
    const entry = map.get(name);
    if (m.isMe || m.isOutgoing) entry.isMe = true;
    entry.count++;
    if (validTs) {
      if (!entry.firstTimestamp || validTs < entry.firstTimestamp) entry.firstTimestamp = validTs;
      if (!entry.lastTimestamp || validTs > entry.lastTimestamp) entry.lastTimestamp = validTs;
    }
  }

  const list = Array.from(map.values()).sort((a, b) => b.count - a.count);
  let otherColorIdx = 1;
  return list.map((p) => {
    const cIdx = p.isMe ? 0 : (otherColorIdx++ % PARTICIPANT_COLORS.length || 1);
    return {
      ...p,
      sharePct: nonSystemTotal > 0 ? Math.round((p.count / nonSystemTotal) * 1000) / 10 : 0,
      colorHex: colorMode === 'bw' ? '374151' : PARTICIPANT_COLORS[cIdx],
      tintHex: colorMode === 'bw' ? 'F3F4F6' : PARTICIPANT_BG_TINTS[cIdx]
    };
  });
}

/**
 * Group messages by day and consecutive sender blocks (within 5 minutes).
 */
export function groupMessagesForExport(messages, options = DEFAULT_EXPORT_OPTIONS) {
  const {
    groupBySender,
    groupWindowMs,
    colorMode
  } = normalizeExportOptions(options);

  const participants = computeParticipantStats(messages, colorMode);
  const colorBySender = new Map(participants.map(p => [p.name, p.colorHex]));

  const days = [];
  let currentDay = null;
  let currentBlock = null;

  for (const msg of messages) {
    const d = msg.timestamp ? new Date(msg.timestamp) : null;
    const valid = d && isValidConversationDate(d);
    const dayKey = valid ? `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` : 'unknown';
    const dayLabel = valid
      ? new Intl.DateTimeFormat(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(d)
      : 'Date unknown';
    const monthLabel = valid
      ? new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(d)
      : 'Unknown';

    if (!currentDay || currentDay.dayKey !== dayKey) {
      currentDay = { dayKey, dayLabel, monthLabel, blocks: [] };
      days.push(currentDay);
      currentBlock = null;
    }

    if (msg.type === 'system') {
      currentDay.blocks.push({
        isSystem: true,
        sender: 'System',
        items: [{ msg, showTime: false }]
      });
      currentBlock = null;
      continue;
    }

    if (msg.type === 'unrecognized') {
      currentDay.blocks.push({
        isSystem: false,
        isUnrecognized: true,
        sender: msg.sender || 'Unrecognized',
        isMe: !!(msg.isMe || msg.isOutgoing),
        colorHex: colorBySender.get(msg.sender) || '6B7280',
        firstTimestamp: msg.timestamp,
        lastTimeMs: valid ? d.getTime() : null,
        items: [{ msg, showTime: true }]
      });
      currentBlock = null;
      continue;
    }

    const msgTimeMs = valid ? d.getTime() : null;
    const senderNorm = String(msg.sender || '').trim();
    const blockSenderNorm = currentBlock ? String(currentBlock.sender || '').trim() : '';
    const timeDiffOk = currentBlock
      ? ((currentBlock.lastTimeMs !== null && msgTimeMs !== null)
          ? Math.abs(msgTimeMs - currentBlock.lastTimeMs) <= groupWindowMs
          : (currentBlock.lastTimeMs === null && msgTimeMs === null))
      : false;
    const canGroup = groupBySender &&
      currentBlock &&
      !currentBlock.isSystem &&
      !currentBlock.isUnrecognized &&
      blockSenderNorm === senderNorm &&
      timeDiffOk;

    if (canGroup) {
      const gapFromPrev = (currentBlock.lastTimeMs !== null && msgTimeMs !== null)
        ? Math.abs(msgTimeMs - currentBlock.lastTimeMs)
        : 0;
      currentBlock.items.push({
        msg,
        showTime: gapFromPrev > groupWindowMs
      });
      if (msgTimeMs !== null) currentBlock.lastTimeMs = msgTimeMs;
    } else {
      currentBlock = {
        isSystem: false,
        sender: senderNorm || msg.sender,
        isMe: !!(msg.isMe || msg.isOutgoing),
        colorHex: colorBySender.get(senderNorm || msg.sender) || '1F2937',
        firstTimestamp: msg.timestamp,
        lastTimeMs: msgTimeMs,
        items: [{ msg, showTime: true }]
      };
      currentDay.blocks.push(currentBlock);
    }
  }

  return { days, participants };
}

/**
 * Build clean transcript text from messages.
 */
export function buildTranscript(messages, dateRange = {}, options = DEFAULT_EXPORT_OPTIONS) {
  const safeRange = dateRange && typeof dateRange === 'object' ? dateRange : {};
  const opts = normalizeExportOptions(options);
  let filtered = Array.isArray(messages) ? messages : [];

  if (safeRange.start) {
    const sTime = new Date(safeRange.start).getTime();
    filtered = filtered.filter(m => {
      const t = m.timestamp ? new Date(m.timestamp).getTime() : 0;
      return t >= sTime;
    });
  }
  if (safeRange.end) {
    const eTime = new Date(safeRange.end).getTime();
    filtered = filtered.filter(m => {
      const t = m.timestamp ? new Date(m.timestamp).getTime() : 0;
      return t <= eTime;
    });
  }

  return filtered.map(m => {
    const timeStr = formatTimestamp(m.timestamp, m.timestampApproximate);
    let replyStr = '';
    if (m.replyTo) {
      const parts = formatReplyQuoteParts(m.replyTo, m, {
        myName: opts.myName,
        detectedMyName: opts.detectedMyName,
        chatName: opts.chatName
      });
      if (parts) {
        replyStr = parts.bodyText
          ? ` (${parts.headerText}: "${parts.bodyText}")`
          : ` (${parts.headerText})`;
      }
    }
    return `[${timeStr}] ${m.sender}${replyStr}: ${m.text}`;
  }).join('\n');
}

// ─── Statistics ──────────────────────────────────────────────────────────────

/**
 * Build summary statistics from normalized messages.
 */
export function buildStats(messages, chatName, platform = 'WhatsApp') {
  if (!messages || !messages.length) {
    return {
      chatName: chatName || 'Conversation',
      platform,
      totalMessages: 0,
      dateRange: { start: null, end: null },
      senderCounts: {},
      typeCounts: {}
    };
  }

  const validDates = messages
    .filter(m => m.timestamp)
    .map(m => (m.timestamp instanceof Date ? m.timestamp : new Date(m.timestamp)))
    .filter(d => isValidConversationDate(d))
    .sort((a, b) => a - b);

  const senderCounts = {};
  const typeCounts = {};

  for (const m of messages) {
    if (m.type === 'system') continue;
    let sender = (m.sender || '').trim();
    if (!sender) {
      sender = m.isMe ? 'Me' : 'Contact';
    }
    senderCounts[sender] = (senderCounts[sender] || 0) + 1;
    typeCounts[m.type || 'text'] = (typeCounts[m.type || 'text'] || 0) + 1;
  }

  return {
    chatName: chatName || 'Conversation',
    platform,
    totalMessages: messages.length,
    dateRange: {
      start: validDates[0] ? validDates[0].toISOString() : null,
      end: validDates[validDates.length - 1] ? validDates[validDates.length - 1].toISOString() : null
    },
    senderCounts,
    typeCounts
  };
}
