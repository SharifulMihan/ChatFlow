/**
 * exporter-txt.js
 * Generates a clean, grouped .txt transcript file from ChatFlow conversations.
 */

import {
  prepareMessagesForExport,
  groupMessagesForExport,
  formatExportDate,
  formatExportTime,
  formatMediaChip
} from './transcript.js';
import { isValidConversationDate } from '../content/selectors.js';

export function buildTxtContent(messages, stats, options = {}) {
  const {
    includeSummary = true,
    includeTimestamps = true,
    groupBySender = true,
    showReactions = true,
    showMediaLabels = true,
    showSystemMessages = true,
    hideQuotedReplies = false,
    dateFormat = 'auto',
    timeFormat = 'auto',
    platform = stats.platform || 'WhatsApp'
  } = options;

  const prepared = prepareMessagesForExport(messages, options);
  const { days, participants } = groupMessagesForExport(prepared, { groupBySender });

  const lines = [];

  if (includeSummary) {
    lines.push('========================================================');
    lines.push(`CHATFLOW CHAT EXPORT: ${(platform || 'Chat').toUpperCase()} - ${stats.chatName}`);
    lines.push('========================================================');
    lines.push(`Platform: ${platform}`);
    lines.push(`Exported on: ${formatExportDate(new Date(), dateFormat)}`);
    lines.push(`Total messages: ${prepared.length.toLocaleString()}`);

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
    lines.push('');
    lines.push('--------------------------------------------------------');
    lines.push('');
  }

  for (const day of days) {
    lines.push(`=== ${day.dayLabel} ===`);
    lines.push('');

    for (const block of day.blocks) {
      if (block.isSystem) {
        const sysText = block.items[0]?.msg?.text || '';
        lines.push(`  [System] ${sysText}`);
        lines.push('');
        continue;
      }

      const firstItem = block.items[0];
      const firstTime = includeTimestamps
        ? formatExportTime(firstItem.msg.timestamp, timeFormat, firstItem.msg.timestampApproximate, platform)
        : '';

      if (groupBySender) {
        lines.push(firstTime ? `${block.sender} (${firstTime}):` : `${block.sender}:`);
      }

      for (let i = 0; i < block.items.length; i++) {
        const { msg, showTime } = block.items[i];
        const isMedia = msg.type && msg.type !== 'text' && msg.type !== 'deleted';
        if (isMedia && !showMediaLabels) continue;

        let body = msg.type === 'deleted'
          ? 'This message was deleted'
          : (isMedia ? formatMediaChip(msg) : (msg.text || ''));

        if (msg.isEdited) body += ' (edited)';

        const tStr = (includeTimestamps && (!groupBySender || (i > 0 && showTime)))
          ? `[${formatExportTime(msg.timestamp, timeFormat, msg.timestampApproximate, platform)}] `
          : '';

        if (!hideQuotedReplies && msg.replyTo && typeof msg.replyTo === 'object') {
          const rSender = msg.replyTo.sender || '';
          const rText = (msg.replyTo.text || '').replace(/\s+/g, ' ').trim();
          const rShort = rText.length > 140 ? `${rText.slice(0, 137)}...` : rText;
          if (rShort || rSender) {
            const qPrefix = rSender ? `${rSender}: ` : '';
            lines.push(`  > ${qPrefix}${rShort}`);
          }
        }

        const rxList = Array.isArray(msg.reactions) ? msg.reactions : [];
        const rxStr = (showReactions && rxList.length > 0)
          ? ` [Reactions: ${rxList.join(' ')}]`
          : '';

        if (groupBySender) {
          lines.push(`  ${tStr}${body}${rxStr}`);
        } else {
          lines.push(`${tStr}${block.sender}: ${body}${rxStr}`);
        }
      }

      lines.push('');
    }
  }

  lines.push('--------------------------------------------------------');
  lines.push('Exported locally with ChatFlow. Nothing leaves your device.');
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
