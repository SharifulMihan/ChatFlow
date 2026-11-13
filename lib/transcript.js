/**
 * transcript.js
 * Formats extracted messages into clean transcripts, grouped conversation blocks,
 * participant statistics, and localized date/time strings.
 */

import {
  isValidConversationDate,
  isLocalizedYou,
  extractValidReactions,
  isDurationChipText,
  looksLikeDateOrTimeSeparator
} from '../content/selectors.js';

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
  switch (type) {
    case 'image': return '📷 Photo';
    case 'video': {
      const dur = msg?.duration || (raw.match(/\((\d+:\d{2})\)/)?.[1]) || (isDurationChipText(raw) ? raw : '');
      return dur ? `🎬 Video (${dur})` : '🎬 Video';
    }
    case 'voice': {
      const dur = msg?.duration || (raw.match(/\((\d+:\d{2})\)/)?.[1]) || '';
      return dur ? `🎤 Voice message (${dur})` : '🎤 Voice message';
    }
    case 'sticker': return '🏷️ Sticker';
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
    case 'unrecognized': {
      const cleaned = raw.replace(/^\[Unrecognized message\]\s*/i, '').trim();
      return cleaned ? `[Unrecognized message] ${cleaned}` : '[Unrecognized message]';
    }
    default: return raw;
  }
}

/**
 * Apply date range filter, myName override, participant renames, and system-message toggle.
 */
export function prepareMessagesForExport(messages, options = {}) {
  const {
    dateRangeStart = null,
    dateRangeEnd = null,
    myName = '',
    renameMap = {},
    showSystemMessages = true
  } = options;

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

  const trimmedMyName = (myName || '').trim();
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
        if (trimmedMyName && isOut) {
          sender = trimmedMyName;
        }
        if (hasRenames && renameMap[sender]) {
          sender = renameMap[sender];
        }
      }

      let replyTo = m.replyTo;
      if (replyTo && typeof replyTo === 'object') {
        let rSender = replyTo.sender || '';
        if (trimmedMyName && isLocalizedYou(rSender)) {
          rSender = trimmedMyName;
        }
        if (hasRenames && renameMap[rSender]) {
          rSender = renameMap[rSender];
        }
        replyTo = { ...replyTo, sender: rSender };
      }

      const cleanReactions = Array.isArray(m.reactions)
        ? extractValidReactions(m.reactions)
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
export function groupMessagesForExport(messages, options = {}) {
  const {
    groupBySender = true,
    groupWindowMs = 5 * 60 * 1000,
    colorMode = 'color'
  } = options;

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
export function buildTranscript(messages, dateRange = {}) {
  let filtered = messages;

  if (dateRange.start) {
    const sTime = dateRange.start.getTime();
    filtered = filtered.filter(m => {
      const t = m.timestamp ? new Date(m.timestamp).getTime() : 0;
      return t >= sTime;
    });
  }
  if (dateRange.end) {
    const eTime = dateRange.end.getTime();
    filtered = filtered.filter(m => {
      const t = m.timestamp ? new Date(m.timestamp).getTime() : 0;
      return t <= eTime;
    });
  }

  return filtered.map(m => {
    const timeStr = formatTimestamp(m.timestamp, m.timestampApproximate);
    let replyStr = '';
    if (m.replyTo) {
      const rSender = typeof m.replyTo === 'object' ? (m.replyTo.sender || '') : '';
      const rText = typeof m.replyTo === 'object' ? (m.replyTo.text || '') : m.replyTo;
      if (rText && rText.trim()) {
        const rShort = rText.length > 80 ? (rText.slice(0, 77) + '...') : rText;
        replyStr = rSender
          ? ` (↪ replying to ${rSender}: "${rShort.replace(/\n/g, ' ')}")`
          : ` (↪ replying: "${rShort.replace(/\n/g, ' ')}")`;
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
