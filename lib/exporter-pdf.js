/**
 * exporter-pdf.js
 * Generates a print-ready HTML document matching the ChatFlow .docx layout
 * and triggers browser Save-as-PDF (100% local, full Unicode/RTL/Emoji support).
 */

import {
  prepareMessagesForExport,
  groupMessagesForExport,
  formatExportDate,
  formatExportTime,
  formatMediaChip
} from './transcript.js';
import { isValidConversationDate, isRtlText } from '../content/selectors.js';

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function linkify(str) {
  return esc(str).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>').replace(/\n/g, '<br>');
}

export function buildPdfHtml(messages, stats, options = {}) {
  const {
    layout = 'bubbles',
    dateFormat = 'auto',
    timeFormat = 'auto',
    includeSummary = true,
    includeTimestamps = true,
    groupBySender = true,
    showReactions = true,
    showMediaLabels = true,
    showSystemMessages = true,
    hideQuotedReplies = false,
    pageSize = 'A4',
    fontSize = 'M',
    colorMode = 'color',
    chatName = stats.chatName || 'Conversation',
    platform = stats.platform || 'WhatsApp'
  } = options;

  const prepared = prepareMessagesForExport(messages, options);
  const { days, participants } = groupMessagesForExport(prepared, { groupBySender, colorMode });
  const colorBySender = new Map(participants.map(p => [p.name, p.colorHex]));

  const isBW = colorMode === 'bw';
  const isMessenger = (platform || '').toLowerCase().includes('messenger');
  const brandHex = isBW ? '#111827' : (isMessenger ? '#2563EB' : '#1B7A50');
  const myBubbleBg = isBW ? '#E5E7EB' : (isMessenger ? '#EFF6FF' : '#E8F5EE');
  const baseFontPx = fontSize === 'S' ? '12.5px' : (fontSize === 'L' ? '15px' : '13.5px');

  const validDates = prepared
    .map(m => (m.timestamp ? new Date(m.timestamp) : null))
    .filter(d => isValidConversationDate(d))
    .sort((a, b) => a - b);

  const startDateObj = validDates[0] || null;
  const endDateObj = validDates[validDates.length - 1] || null;
  const durationDays = (startDateObj && endDateObj)
    ? Math.max(1, Math.round((endDateObj - startDateObj) / (1000 * 60 * 60 * 24)) + 1)
    : 0;

  let summaryHtml = '';
  if (includeSummary) {
    const dateRangeText = (startDateObj && endDateObj)
      ? `${formatExportDate(startDateObj, 'medium')} – ${formatExportDate(endDateObj, 'medium')}`
      : 'N/A';

    const participantRows = participants.map(p => `
      <tr>
        <td style="font-weight:600;color:#${p.colorHex}">${esc(p.name)}</td>
        <td>${p.count.toLocaleString()}</td>
        <td>
          <span class="bar-wrap"><span class="bar-fill" style="width:${Math.max(4, p.sharePct)}%;background:#${p.colorHex}"></span></span>
          ${p.sharePct}%
        </td>
        <td class="muted">${p.firstTimestamp ? esc(formatExportDate(p.firstTimestamp, dateFormat)) : '-'}</td>
        <td class="muted">${p.lastTimestamp ? esc(formatExportDate(p.lastTimestamp, dateFormat)) : '-'}</td>
      </tr>
    `).join('');

    summaryHtml = `
      <section class="cover-page">
        <div class="brand-line"><span style="color:${brandHex};font-weight:700;">💬 ChatFlow</span> <span class="muted">· Chat export</span></div>
        <h1 class="chat-title">${esc(chatName)}</h1>
        <div class="platform-pill" style="color:${brandHex}">${esc(platform.toUpperCase())}</div>

        <table class="info-table">
          <tr><th>Platform</th><td>${esc(platform)}</td></tr>
          <tr><th>Exported on</th><td>${esc(formatExportDate(new Date(), 'medium'))}</td></tr>
          <tr><th>Date range</th><td>${esc(dateRangeText)}</td></tr>
          <tr><th>Total messages</th><td>${prepared.length.toLocaleString()}</td></tr>
          <tr><th>Duration</th><td>${durationDays ? `${durationDays.toLocaleString()} day${durationDays === 1 ? '' : 's'}` : 'N/A'}</td></tr>
          <tr><th>Participants</th><td>${participants.length}</td></tr>
        </table>

        ${participants.length ? `
          <h2 class="section-sub">Participants</h2>
          <table class="part-table">
            <thead><tr><th>Name</th><th>Messages</th><th>Share (%)</th><th>First message</th><th>Last message</th></tr></thead>
            <tbody>${participantRows}</tbody>
          </table>
        ` : ''}

        ${stats.isPartial ? `<p class="notice">Partial export: starts from ${esc(formatExportDate(stats.oldestTimestamp || startDateObj, dateFormat))}</p>` : ''}
        ${stats.integrity?.hasWarning && stats.integrity?.warningMessage ? `<p class="notice">${esc(stats.integrity.warningMessage)}</p>` : ''}

        <p class="cover-footer">Exported locally with ChatFlow. Nothing leaves your device.</p>
      </section>
    `;
  }

  let bodyHtml = '';
  for (const day of days) {
    bodyHtml += `<div class="date-divider"><span>${esc(day.dayLabel)}</span></div>`;

    for (const block of day.blocks) {
      if (block.isSystem) {
        const sysText = block.items[0]?.msg?.text || '';
        const rtlAttr = isRtlText(sysText) ? ' dir="rtl"' : '';
        bodyHtml += `<div class="sys-msg"${rtlAttr}>${esc(sysText)}</div>`;
        continue;
      }

      const firstTime = includeTimestamps && block.firstTimestamp
        ? formatExportTime(block.firstTimestamp, timeFormat, block.items[0]?.msg?.timestampApproximate, platform)
        : '';

      let itemsHtml = '';
      block.items.forEach((item, idx) => {
        const { msg, showTime } = item;
        const isMedia = msg.type && msg.type !== 'text' && msg.type !== 'deleted';
        if (isMedia && !showMediaLabels) return;

        const text = msg.type === 'deleted'
          ? 'This message was deleted'
          : (isMedia ? formatMediaChip(msg) : (msg.text || ''));
        const rtlAttr = isRtlText(text) ? ' dir="rtl"' : '';

        if (!hideQuotedReplies && msg.replyTo && typeof msg.replyTo === 'object') {
          const rSender = msg.replyTo.sender || '';
          const rRaw = (msg.replyTo.text || '').replace(/\s+/g, ' ').trim();
          const rShort = rRaw.length > 140 ? `${rRaw.slice(0, 137)}...` : rRaw;
          if (rShort || rSender) {
            const qHex = isBW ? '6B7280' : (colorBySender.get(rSender) || '6B7280');
            const qLabel = rSender ? `${rSender}: ${rShort}` : rShort;
            itemsHtml += `<div class="quote-box" style="border-inline-start:3px solid #${qHex}">${esc(qLabel)}</div>`;
          }
        }

        const timePrefix = (includeTimestamps && idx > 0 && showTime && msg.timestamp)
          ? `<span class="msg-time">${esc(formatExportTime(msg.timestamp, timeFormat, msg.timestampApproximate, platform))}</span> `
          : '';
        const editedSpan = msg.isEdited ? ' <span class="muted">(edited)</span>' : '';
        const msgClass = (msg.type === 'deleted' || isMedia) ? 'msg-line muted italic' : 'msg-line';

        itemsHtml += `<div class="${msgClass}"${rtlAttr}>${timePrefix}${linkify(text)}${editedSpan}</div>`;

        const rxList = Array.isArray(msg.reactions) ? msg.reactions : [];
        if (showReactions && rxList.length > 0) {
          itemsHtml += `<div class="reactions-line">Reactions: ${esc(rxList.join(' '))}</div>`;
        }
      });

      const bubbleClass = layout === 'bubbles'
        ? (block.isMe ? 'bubble-row me' : 'bubble-row other')
        : 'compact-block';
      const bubbleStyle = layout === 'bubbles'
        ? `style="background:${block.isMe ? myBubbleBg : '#F3F4F6'}"`
        : '';

      bodyHtml += `
        <div class="${bubbleClass}">
          <div class="bubble-card" ${bubbleStyle}>
            <div class="block-header">
              <span class="sender-name" style="color:#${block.colorHex}">${esc(block.sender)}</span>
              ${firstTime ? `<span class="msg-time">${esc(firstTime)}</span>` : ''}
            </div>
            ${itemsHtml}
          </div>
        </div>
      `;
    }
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${esc(platform)} Chat - ${esc(chatName)}</title>
<style>
  @page { size: ${pageSize}; margin: 2cm; }
  * { box-sizing: border-box; }
  body {
    font-family: "Segoe UI", "Nirmala UI", "Noto Sans Arabic", "Noto Sans CJK SC", system-ui, sans-serif;
    font-size: ${baseFontPx};
    line-height: 1.45;
    color: #111827;
    margin: 0;
    padding: 0;
  }
  .muted { color: #6B7280; }
  .italic { font-style: italic; }
  .cover-page { page-break-after: always; text-align: center; padding-top: 24px; }
  .brand-line { font-size: 14px; margin-bottom: 12px; }
  .chat-title { font-size: 28px; margin: 0 0 6px; }
  .platform-pill { font-size: 11px; font-weight: 700; letter-spacing: 0.08em; margin-bottom: 24px; }
  .info-table, .part-table { width: 100%; border-collapse: collapse; text-align: left; margin: 12px 0 22px; font-size: 12.5px; }
  .info-table th, .info-table td, .part-table th, .part-table td {
    padding: 7px 10px;
    border-bottom: 1px solid #E5E7EB;
  }
  .info-table th { width: 35%; color: #6B7280; font-weight: 600; }
  .part-table th { background: #F9FAFB; color: #6B7280; font-size: 11.5px; }
  .section-sub { text-align: left; font-size: 14px; margin: 18px 0 6px; }
  .bar-wrap { display: inline-block; width: 46px; height: 6px; background: #E5E7EB; border-radius: 3px; vertical-align: middle; margin-right: 6px; overflow: hidden; }
  .bar-fill { display: block; height: 100%; }
  .notice { color: #B45309; font-style: italic; font-size: 12px; margin: 10px 0; }
  .cover-footer { color: #6B7280; font-style: italic; font-size: 11px; margin-top: 28px; }
  .date-divider { text-align: center; margin: 18px 0 10px; page-break-after: avoid; }
  .date-divider span { background: #F3F4F6; color: #4B5563; font-size: 11.5px; font-weight: 600; padding: 3px 12px; border-radius: 999px; }
  .bubble-row { display: flex; margin-bottom: 8px; page-break-inside: avoid; }
  .bubble-row.me { justify-content: flex-end; }
  .bubble-row.other { justify-content: flex-start; }
  .bubble-row .bubble-card { max-width: 72%; padding: 8px 12px; border-radius: 10px; }
  .compact-block { margin-bottom: 10px; page-break-inside: avoid; }
  .block-header { margin-bottom: 3px; }
  .sender-name { font-weight: 700; font-size: 12.5px; margin-right: 6px; }
  .msg-time { color: #6B7280; font-size: 11px; }
  .msg-line { margin: 2px 0; word-wrap: break-word; }
  .quote-box { padding-inline-start: 8px; color: #6B7280; font-style: italic; font-size: 12px; margin: 3px 0 4px; }
  .reactions-line { color: #6B7280; font-size: 11px; margin-top: 2px; }
  .sys-msg { text-align: center; color: #6B7280; font-style: italic; font-size: 11.5px; margin: 10px 0; }
</style>
</head>
<body>
  ${summaryHtml}
  <main>${bodyHtml}</main>
  <script>window.addEventListener('load', () => { setTimeout(() => window.print(), 250); });</script>
</body>
</html>`;
}

export function exportPdf(messages, stats, options = {}) {
  const html = buildPdfHtml(messages, stats, options);
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const win = window.open(url, '_blank');
  if (!win) {
    throw new Error('Popup blocked. Please allow popups to open PDF print preview.');
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return true;
}

