/**
 * exporter-txt.js
 * Generates a clean, grouped .txt transcript file from ChatFlow conversations.
 */

import {
  DEFAULT_EXPORT_OPTIONS,
  normalizeExportOptions,
  prepareMessagesForExport,
  groupMessagesForExport,
  formatExportDate,
  formatExportTime,
  formatMediaChip,
  formatReplyQuoteParts,
  resolveMyExportName
} from './transcript.js';
import { isValidConversationDate, cleanReactionsList } from '../content/selectors.js';
import { getExtensionVersion } from '../src/version.js';

/**
 * Render one grouped message block into clean .txt lines (shared by WhatsApp & Messenger).
 * @param {Object} block
 * @param {Object} [ctx={}]
 * @returns {string[]}
 */
export function renderMessageBlock(block, ctx = {}) {
  const {
    includeTimestamps = true,
    groupBySender = false,
    showReactions = true,
    showMediaLabels = true,
    hideQuotedReplies = false,
    timeFormat = 'auto',
    platform = 'WhatsApp',
    resolvedMyName = 'Me',
    chatName = '',
    isGroupChat = false
  } = ctx;

  const blockLines = [];
  if (block.isSystem) {
    const sysText = block.items[0]?.msg?.text || '';
    blockLines.push(`  [System] ${sysText}`);
    blockLines.push('');
    return blockLines;
  }

  const firstItem = block.items[0];
  const firstTime = includeTimestamps
    ? formatExportTime(firstItem.msg.timestamp, timeFormat, firstItem.msg.timestampApproximate, platform)
    : '';

  if (groupBySender) {
    blockLines.push(firstTime ? `${block.sender} (${firstTime}):` : `${block.sender}:`);
  }

  for (let i = 0; i < block.items.length; i++) {
    const { msg, showTime } = block.items[i];
    const isUnrecognized = msg.type === 'unrecognized';
    const isLike = msg.type === 'like';
    const isMedia = !isUnrecognized && !isLike && msg.type && msg.type !== 'text' && msg.type !== 'deleted';
    if (isMedia && !showMediaLabels) continue;

    let body = msg.type === 'deleted'
      ? 'This message was deleted'
      : (isLike ? '👍' : (isUnrecognized || isMedia ? formatMediaChip(msg) : (msg.text || '')));

    if (msg.isEdited) body += ' (edited)';

    const tStr = (includeTimestamps && (!groupBySender || (i > 0 && showTime)))
      ? `[${formatExportTime(msg.timestamp, timeFormat, msg.timestampApproximate, platform)}] `
      : '';

    const rxList = cleanReactionsList(Array.isArray(msg.reactions) ? msg.reactions : [], { myName: resolvedMyName });
    const rxStr = (showReactions && rxList.length > 0)
      ? ` [Reactions: ${rxList.join(' ')}]`
      : '';

    let quoteParts = null;
    if (!hideQuotedReplies && msg.replyTo && typeof msg.replyTo === 'object') {
      const parts = formatReplyQuoteParts(msg.replyTo, msg, {
        myName: resolvedMyName,
        chatName,
        isGroup: isGroupChat
      });
      if (parts && (parts.headerText || parts.bodyText)) {
        quoteParts = parts;
      }
    }

    if (quoteParts) {
      const quoteSummary = `${quoteParts.headerText}${quoteParts.bodyText ? `: "${quoteParts.bodyText}"` : ''}`;
      if (groupBySender) {
        blockLines.push(`  ${tStr}${quoteSummary}`);
        blockLines.push(`    ${body}${rxStr}`);
      } else {
        blockLines.push(`${tStr}${block.sender}: ${quoteSummary}`);
        blockLines.push(`  ${body}${rxStr}`);
      }
    } else if (groupBySender) {
      blockLines.push(`  ${tStr}${body}${rxStr}`);
    } else {
      blockLines.push(`${tStr}${block.sender}: ${body}${rxStr}`);
    }
  }

  blockLines.push('');
  return blockLines;
}

export function buildTxtContent(messages, stats = {}, options = DEFAULT_EXPORT_OPTIONS) {
  if (!stats || typeof stats !== 'object') stats = {};
  const opts = normalizeExportOptions(options, {
    chatName: (options && options.chatName) || stats.chatName || '',
    platform: (options && options.platform) || stats.platform || 'WhatsApp'
  });
  const {
    includeSummary,
    includeTimestamps,
    groupBySender,
    showReactions,
    showMediaLabels,
    hideQuotedReplies,
    dateFormat,
    timeFormat,
    chatName,
    platform
  } = opts;

  const prepared = prepareMessagesForExport(messages, opts);
  const { days, participants } = groupMessagesForExport(prepared, { groupBySender });
  const isGroupChat = participants.length > 2 || stats?.chatType === 'group';
  const resolvedMyName = resolveMyExportName({
    myNameSetting: opts.myName || '',
    detectedName: opts.detectedMyName || '',
    contactName: chatName
  });

  const lines = [];
  const extVersion = getExtensionVersion();

  if (includeSummary) {
    lines.push('========================================================');
    lines.push(`CHATFLOW v${extVersion} CHAT EXPORT: ${(platform || 'Chat').toUpperCase()} - ${chatName || stats.chatName || 'Conversation'}`);
    lines.push('========================================================');
    lines.push(`Platform: ${platform}`);
    lines.push(`Exported with: ChatFlow v${extVersion}`);
    lines.push(`Exported on: ${formatExportDate(new Date(), dateFormat)}`);
    lines.push(`Total messages: ${prepared.length.toLocaleString()}`);
    const unrecognizedCount = Math.max(
      prepared.filter(m => m.type === 'unrecognized').length,
      stats.integrity?.audit?.unrecognizedCount || 0
    );
    if (unrecognizedCount > 0) {
      lines.push(`Unrecognized rows: ${unrecognizedCount.toLocaleString()}`);
    }

    const validDates = prepared
      .map(m => (m.timestamp ? new Date(m.timestamp) : null))
      .filter(d => isValidConversationDate(d))
      .sort((a, b) => a - b);

    if (validDates.length > 0) {
      const startStr = formatExportDate(validDates[0], dateFormat);
      const endStr = formatExportDate(validDates[validDates.length - 1], dateFormat);
      const daysSpan = Math.max(1, Math.round((validDates[validDates.length - 1] - validDates[0]) / (1000 * 60 * 60 * 24)) + 1);
      lines.push(`Date range: ${startStr} - ${endStr} (${daysSpan} days)`);
    }

    if (stats.isPartial) {
      const oldest = stats.oldestTimestamp || validDates[0];
      lines.push(`Notice: Partial export: starts from ${formatExportDate(oldest, dateFormat)}`);
    }
    if (stats.integrity?.hasWarning && stats.integrity?.warningMessage) {
      lines.push(`Notice: ${stats.integrity.warningMessage}`);
    }

    lines.push('');
    lines.push(`PARTICIPANTS (${participants.length}):`);
    for (const p of participants) {
      lines.push(`  * ${p.name}: ${p.count.toLocaleString()} messages (${p.sharePct}%)`);
    }
    if (includeTimestamps && prepared.some(m => m.timestampApproximate)) {
      lines.push('');
      lines.push('  ~ Approximate time (Messenger shows exact times only at some points in the chat).');
    }
    lines.push('');
    lines.push('--------------------------------------------------------');
    lines.push('');
  } else {
    lines.push(`CHATFLOW v${extVersion} | ${(platform || 'Chat').toUpperCase()} - ${chatName || stats.chatName || 'Conversation'}`);
    lines.push('');
  }

  const txtCtx = {
    includeTimestamps,
    groupBySender,
    showReactions,
    showMediaLabels,
    hideQuotedReplies,
    timeFormat,
    platform,
    resolvedMyName,
    chatName,
    isGroupChat
  };

  for (const day of days) {
    lines.push(`=== ${day.dayLabel} ===`);
    lines.push('');

    for (const block of day.blocks) {
      lines.push(...renderMessageBlock(block, txtCtx));
    }
  }

  lines.push('--------------------------------------------------------');
  lines.push(`Exported with ChatFlow v${extVersion}. Nothing leaves your device.`);
  return lines.join('\n');
}

export function downloadTxt(content, chatName, platform = 'Chat') {
  const safePlatform = (platform || 'Chat').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  const safeName = (chatName || 'Conversation').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  const dateStr = new Date().toISOString().slice(0, 10);
  const filename = `${safePlatform} Chat - ${safeName} - ${dateStr}.txt`;

  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return filename;
}
