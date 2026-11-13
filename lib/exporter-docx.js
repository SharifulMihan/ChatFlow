/**
 * exporter-docx.js
 * Generates a clean, global-ready .docx conversation document for ChatFlow.
 * Supports Chat Bubbles, Compact, and Plain layouts, chunked rendering for 50,000+ messages,
 * per-script fonts & w:lang, w:noProof (zero squiggles), RTL (w:bidi), real Word styles,
 * and automatic Compact fallback above 20,000 messages.
 */

import {
  prepareMessagesForExport,
  groupMessagesForExport,
  formatExportDate,
  formatExportTime,
  formatMediaChip
} from './transcript.js';
import {
  isValidConversationDate,
  detectScriptAndLang,
  isRtlText
} from '../content/selectors.js';

const CHUNK_SIZE = 400;
const COMPACT_THRESHOLD = 20000;

function yieldToEventLoop() {
  return new Promise(r => setTimeout(r, 0));
}

function getFontForScript(script) {
  switch (script) {
    case 'bengali':    return 'Nirmala UI';
    case 'devanagari': return 'Nirmala UI';
    case 'arabic':     return 'Noto Sans Arabic';
    case 'hebrew':     return 'Segoe UI';
    case 'japanese':   return 'Yu Gothic UI';
    case 'korean':     return 'Malgun Gothic';
    case 'cjk':        return 'Microsoft YaHei';
    case 'thai':       return 'Leelawadee UI';
    default:           return 'Segoe UI';
  }
}

function buildTextRuns(TextRun, text, baseProps = {}, colorMode = 'color') {
  if (!text) return [];
  const lines = String(text).split('\n');
  const runs = [];
  const urlRx = /(https?:\/\/[^\s]+)/g;

  lines.forEach((line, lineIdx) => {
    if (lineIdx > 0) {
      runs.push(new TextRun({ break: 1, noProof: true }));
    }
    const parts = line.split(urlRx);
    for (const part of parts) {
      if (!part) continue;
      const isUrl = /^https?:\/\/[^\s]+$/i.test(part);
      const { script, lang } = detectScriptAndLang(part);
      const font = baseProps.font || getFontForScript(script);
      runs.push(new TextRun({
        ...baseProps,
        text: part,
        font,
        noProof: true,
        language: { value: lang },
        ...(isUrl ? {
          color: colorMode === 'bw' ? '111827' : '2563EB',
          underline: { type: 'single' }
        } : {})
      }));
    }
  });
  return runs;
}

/**
 * Build and return a Blob (browser) or Buffer (Node) for the .docx document.
 */
export async function buildDocxDocument(messages, stats, options = {}, onProgress = () => {}, docxLibOverride = null) {
  const docxLib = docxLibOverride || (typeof window !== 'undefined' ? window.docx : globalThis.docx);
  if (!docxLib) throw new Error('docx library not available.');

  const {
    Document, Packer, Paragraph, TextRun, HeadingLevel,
    AlignmentType, BorderStyle, Table, TableRow, TableCell,
    WidthType, ShadingType, Header, Footer, PageNumber,
    NumberOfPages, TableOfContents, PageBreak
  } = docxLib;

  const {
    layout = 'bubbles',          // 'bubbles' | 'compact' | 'plain'
    dateFormat = 'auto',
    timeFormat = 'auto',
    includeSummary = true,
    includeTimestamps = true,
    groupBySender = true,
    showReactions = true,
    showMediaLabels = true,
    showSystemMessages = true,
    hideQuotedReplies = false,
    pageSize = 'A4',             // 'A4' | 'Letter'
    fontSize = 'M',              // 'S' | 'M' | 'L'
    colorMode = 'color',         // 'color' | 'bw'
    chatName = stats.chatName || 'Conversation',
    platform = stats.platform || 'WhatsApp'
  } = options;

  const prepared = prepareMessagesForExport(messages, options);
  const total = prepared.length;

  let effectiveLayout = layout;
  let fallbackToCompact = false;
  if (total > COMPACT_THRESHOLD && layout === 'bubbles') {
    effectiveLayout = 'compact';
    fallbackToCompact = true;
  }

  onProgress({ percent: 2, processed: 0, total, fallbackToCompact });

  const { days, participants } = groupMessagesForExport(prepared, {
    groupBySender,
    colorMode
  });

  const isBW = colorMode === 'bw';
  const isMessenger = (platform || '').toLowerCase().includes('messenger');
  const COLOR_BRAND = isBW ? '111827' : (isMessenger ? '2563EB' : '1B7A50');
  const COLOR_MY_BUBBLE = isBW ? 'E5E7EB' : (isMessenger ? 'EFF6FF' : 'E8F5EE');
  const COLOR_OTHER_BUBBLE = 'F3F4F6';
  const COLOR_MUTED = '6B7280';
  const COLOR_TEXT = '111827';
  const COLOR_BORDER = 'E5E7EB';

  // Font sizes in half-points
  const sizeScale = fontSize === 'S' ? -2 : (fontSize === 'L' ? 2 : 0);
  const SZ_BODY = 21 + sizeScale;   // 10.5pt default
  const SZ_NAME = 20 + sizeScale;   // 10pt
  const SZ_TIME = 17 + sizeScale;   // 8.5pt
  const SZ_QUOTE = 18 + sizeScale;  // 9pt
  const SZ_SYSTEM = 18 + sizeScale; // 9pt

  const colorBySender = new Map(participants.map(p => [p.name, p.colorHex]));

  const validDates = prepared
    .map(m => (m.timestamp ? new Date(m.timestamp) : null))
    .filter(d => isValidConversationDate(d))
    .sort((a, b) => a - b);

  const startDateObj = validDates[0] || null;
  const endDateObj = validDates[validDates.length - 1] || null;
  const durationDays = (startDateObj && endDateObj)
    ? Math.max(1, Math.round((endDateObj - startDateObj) / (1000 * 60 * 60 * 24)) + 1)
    : 0;
  const spansOver3Months = (startDateObj && endDateObj)
    ? ((endDateObj - startDateObj) > 90 * 24 * 60 * 60 * 1000)
    : false;

  const docChildren = [];

  // ── A) Cover / Summary Page (Page 1) ────────────────────────────────────────
  if (includeSummary) {
    docChildren.push(new Paragraph({
      children: [
        new TextRun({ text: '💬 ', size: 28, font: 'Segoe UI Emoji', noProof: true }),
        new TextRun({ text: 'ChatFlow', bold: true, size: 28, color: COLOR_BRAND, font: 'Segoe UI', noProof: true }),
        new TextRun({ text: '  ·  Chat export', size: 22, color: COLOR_MUTED, font: 'Segoe UI', noProof: true })
      ],
      alignment: AlignmentType.CENTER,
      spacing: { before: 240, after: 180 }
    }));

    docChildren.push(new Paragraph({
      style: 'Title',
      children: buildTextRuns(TextRun, chatName, { bold: true, size: 48, color: COLOR_TEXT }, colorMode),
      alignment: AlignmentType.CENTER,
      spacing: { before: 60, after: 60 }
    }));

    docChildren.push(new Paragraph({
      children: [new TextRun({
        text: platform.toUpperCase(),
        bold: true,
        size: 18,
        color: COLOR_BRAND,
        font: 'Segoe UI',
        noProof: true
      })],
      alignment: AlignmentType.CENTER,
      spacing: { after: 320 }
    }));

    // 2-column info table with light row dividers
    const dateRangeText = (startDateObj && endDateObj)
      ? `${formatExportDate(startDateObj, 'medium')} – ${formatExportDate(endDateObj, 'medium')}`
      : 'N/A';

    const infoRows = [
      ['Platform', platform],
      ['Exported on', formatExportDate(new Date(), 'medium')],
      ['Date range', dateRangeText],
      ['Total messages', total.toLocaleString()],
      ['Duration', durationDays ? `${durationDays.toLocaleString()} day${durationDays === 1 ? '' : 's'}` : 'N/A'],
      ['Participants', String(participants.length)]
    ];

    const lightDivider = { style: BorderStyle.SINGLE, size: 4, color: COLOR_BORDER };
    const noBorder = { style: BorderStyle.NONE, size: 0, color: 'auto' };

    docChildren.push(new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: {
        top: lightDivider, bottom: lightDivider,
        left: noBorder, right: noBorder,
        insideHorizontal: lightDivider, insideVertical: noBorder
      },
      rows: infoRows.map(([k, v]) => new TableRow({
        children: [
          new TableCell({
            width: { size: 35, type: WidthType.PERCENTAGE },
            margins: { top: 80, bottom: 80, left: 100, right: 100 },
            children: [new Paragraph({
              children: [new TextRun({ text: k, bold: true, size: 20, color: COLOR_MUTED, font: 'Segoe UI', noProof: true })]
            })]
          }),
          new TableCell({
            width: { size: 65, type: WidthType.PERCENTAGE },
            margins: { top: 80, bottom: 80, left: 100, right: 100 },
            children: [new Paragraph({
              children: buildTextRuns(TextRun, v, { size: 20, color: COLOR_TEXT }, colorMode)
            })]
          })
        ]
      }))
    }));

    // Participants Table
    if (participants.length > 0) {
      docChildren.push(new Paragraph({
        children: [new TextRun({ text: 'Participants', bold: true, size: 24, color: COLOR_TEXT, font: 'Segoe UI', noProof: true })],
        spacing: { before: 320, after: 120 }
      }));

      const pHeaderCells = ['Name', 'Messages', 'Share (%)', 'First message', 'Last message'].map(h =>
        new TableCell({
          shading: { fill: 'F9FAFB', type: ShadingType.CLEAR },
          margins: { top: 80, bottom: 80, left: 80, right: 80 },
          children: [new Paragraph({
            children: [new TextRun({ text: h, bold: true, size: 18, color: COLOR_MUTED, font: 'Segoe UI', noProof: true })]
          })]
        })
      );

      const pRows = participants.map(p => {
        const barBlocks = Math.max(1, Math.round(p.sharePct / 10));
        const barStr = '█'.repeat(barBlocks);
        return new TableRow({
          children: [
            new TableCell({
              margins: { top: 70, bottom: 70, left: 80, right: 80 },
              children: [new Paragraph({
                children: buildTextRuns(TextRun, p.name, { bold: true, size: 19, color: p.colorHex }, colorMode)
              })]
            }),
            new TableCell({
              margins: { top: 70, bottom: 70, left: 80, right: 80 },
              children: [new Paragraph({
                children: [new TextRun({ text: p.count.toLocaleString(), size: 19, color: COLOR_TEXT, font: 'Segoe UI', noProof: true })]
              })]
            }),
            new TableCell({
              margins: { top: 70, bottom: 70, left: 80, right: 80 },
              children: [new Paragraph({
                children: [
                  new TextRun({ text: `${barStr} `, size: 14, color: p.colorHex, font: 'Segoe UI', noProof: true }),
                  new TextRun({ text: `${p.sharePct}%`, size: 18, color: COLOR_TEXT, font: 'Segoe UI', noProof: true })
                ]
              })]
            }),
            new TableCell({
              margins: { top: 70, bottom: 70, left: 80, right: 80 },
              children: [new Paragraph({
                children: [new TextRun({
                  text: p.firstTimestamp ? formatExportDate(p.firstTimestamp, dateFormat) : '-',
                  size: 18, color: COLOR_MUTED, font: 'Segoe UI', noProof: true
                })]
              })]
            }),
            new TableCell({
              margins: { top: 70, bottom: 70, left: 80, right: 80 },
              children: [new Paragraph({
                children: [new TextRun({
                  text: p.lastTimestamp ? formatExportDate(p.lastTimestamp, dateFormat) : '-',
                  size: 18, color: COLOR_MUTED, font: 'Segoe UI', noProof: true
                })]
              })]
            })
          ]
        });
      });

      docChildren.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: {
          top: lightDivider, bottom: lightDivider,
          left: noBorder, right: noBorder,
          insideHorizontal: lightDivider, insideVertical: noBorder
        },
        rows: [new TableRow({ tableHeader: true, children: pHeaderCells }), ...pRows]
      }));
    }

    // Relevant notices only
    if (stats.isPartial) {
      const oldest = stats.oldestTimestamp || startDateObj;
      docChildren.push(new Paragraph({
        children: [new TextRun({
          text: `Partial export: starts from ${formatExportDate(oldest, dateFormat)}`,
          italics: true, size: 19, color: 'B45309', font: 'Segoe UI', noProof: true
        })],
        alignment: AlignmentType.CENTER,
        spacing: { before: 220, after: 60 }
      }));
    }
    if (stats.integrity?.hasWarning && stats.integrity?.warningMessage) {
      docChildren.push(new Paragraph({
        children: [new TextRun({
          text: stats.integrity.warningMessage,
          italics: true, size: 19, color: 'B45309', font: 'Segoe UI', noProof: true
        })],
        alignment: AlignmentType.CENTER,
        spacing: { before: 80, after: 60 }
      }));
    }
    if (fallbackToCompact) {
      docChildren.push(new Paragraph({
        children: [new TextRun({
          text: `Note: Switched to Compact layout for performance (${total.toLocaleString()} messages).`,
          italics: true, size: 18, color: COLOR_MUTED, font: 'Segoe UI', noProof: true
        })],
        alignment: AlignmentType.CENTER,
        spacing: { before: 80, after: 60 }
      }));
    }

    docChildren.push(new Paragraph({
      children: [new TextRun({
        text: 'Exported locally with ChatFlow. Nothing leaves your device.',
        italics: true, size: 17, color: COLOR_MUTED, font: 'Segoe UI', noProof: true
      })],
      alignment: AlignmentType.CENTER,
      spacing: { before: 360, after: 120 }
    }));

    // Optional TOC for chats > 3 months
    if (spansOver3Months && TableOfContents) {
      docChildren.push(new Paragraph({
        children: [new PageBreak()]
      }));
      docChildren.push(new Paragraph({
        children: [new TextRun({ text: 'Contents', bold: true, size: 28, color: COLOR_TEXT, font: 'Segoe UI', noProof: true })],
        spacing: { before: 80, after: 160 }
      }));
      docChildren.push(new TableOfContents('Table of Contents', {
        hyperlink: true,
        headingStyleRange: '1-1'
      }));
    }

    docChildren.push(new Paragraph({
      children: [new PageBreak()]
    }));
  }

  // ── B) Transcript ───────────────────────────────────────────────────────────
  let lastMonthLabel = null;
  let processed = 0;

  const noBorder = { style: BorderStyle.NONE, size: 0, color: 'auto' };
  const quoteBorder = (hex) => ({
    left: { style: BorderStyle.SINGLE, size: 24, color: hex || COLOR_MUTED, space: 8 },
    top: noBorder, bottom: noBorder, right: noBorder
  });

  const renderMessageParagraphs = (item, block, isFirstInBlock) => {
    const { msg, showTime } = item;
    const paras = [];
    const isMedia = msg.type && msg.type !== 'text' && msg.type !== 'deleted';
    if (isMedia && !showMediaLabels) return paras;

    const bodyText = msg.type === 'deleted'
      ? 'This message was deleted'
      : (isMedia ? formatMediaChip(msg) : (msg.text || ''));

    const rtl = isRtlText(bodyText);

    // Reply quote block
    if (!hideQuotedReplies && msg.replyTo && typeof msg.replyTo === 'object') {
      const rSender = msg.replyTo.sender || '';
      const rRaw = (msg.replyTo.text || '').replace(/\s+/g, ' ').trim();
      const rShort = rRaw.length > 140 ? `${rRaw.slice(0, 137)}...` : rRaw;
      if (rShort || rSender) {
        const qColor = colorBySender.get(rSender) || COLOR_MUTED;
        const qLabel = rSender ? `${rSender}: ${rShort}` : rShort;
        paras.push(new Paragraph({
          style: 'ChatQuote',
          border: quoteBorder(isBW ? '6B7280' : qColor),
          indent: { left: 120 },
          bidirectional: isRtlText(qLabel),
          spacing: { before: 40, after: 40, line: 276 },
          children: buildTextRuns(TextRun, qLabel, {
            italics: true, size: SZ_QUOTE, color: COLOR_MUTED
          }, colorMode)
        }));
      }
    }

    // Message line
    const msgRuns = [];
    if (includeTimestamps && !isFirstInBlock && showTime && msg.timestamp) {
      const tStr = formatExportTime(msg.timestamp, timeFormat, msg.timestampApproximate, platform);
      if (tStr) {
        msgRuns.push(new TextRun({
          text: `${tStr}  `,
          size: SZ_TIME,
          color: COLOR_MUTED,
          font: 'Segoe UI',
          noProof: true
        }));
      }
    }

    if (msg.type === 'deleted' || isMedia) {
      msgRuns.push(...buildTextRuns(TextRun, bodyText, {
        italics: true,
        size: SZ_BODY,
        color: COLOR_MUTED
      }, colorMode));
    } else {
      msgRuns.push(...buildTextRuns(TextRun, bodyText, {
        size: SZ_BODY,
        color: COLOR_TEXT
      }, colorMode));
    }

    if (msg.isEdited) {
      msgRuns.push(new TextRun({
        text: ' (edited)',
        italics: true,
        size: SZ_TIME,
        color: COLOR_MUTED,
        font: 'Segoe UI',
        noProof: true
      }));
    }

    paras.push(new Paragraph({
      style: 'ChatMessage',
      bidirectional: rtl,
      spacing: { before: 20, after: 40, line: 276 },
      indent: (effectiveLayout !== 'bubbles' && groupBySender && !isFirstInBlock) ? { left: 160 } : undefined,
      children: msgRuns
    }));

    const rxList = Array.isArray(msg.reactions) ? msg.reactions : [];
    if (showReactions && rxList.length > 0) {
      paras.push(new Paragraph({
        spacing: { before: 0, after: 40 },
        children: buildTextRuns(TextRun, `Reactions: ${rxList.join(' ')}`, {
          size: SZ_TIME,
          color: COLOR_MUTED
        }, colorMode)
      }));
    }

    return paras;
  };

  for (const day of days) {
    // Month heading for TOC when chat > 3 months
    if (spansOver3Months && day.monthLabel !== lastMonthLabel && day.monthLabel !== 'Unknown') {
      lastMonthLabel = day.monthLabel;
      docChildren.push(new Paragraph({
        heading: HeadingLevel.HEADING_1,
        keepNext: true,
        spacing: { before: 200, after: 80 },
        children: [new TextRun({
          text: day.monthLabel,
          bold: true,
          size: 26,
          color: COLOR_BRAND,
          font: 'Segoe UI',
          noProof: true
        })]
      }));
    }

    // Date divider (pill style, keepNext so never orphaned)
    docChildren.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      keepNext: true,
      shading: { fill: 'F3F4F6', type: ShadingType.CLEAR },
      spacing: { before: 220, after: 140 },
      children: buildTextRuns(TextRun, `  ${day.dayLabel}  `, {
        bold: true,
        size: 18,
        color: '4B5563'
      }, colorMode)
    }));

    for (let bIdx = 0; bIdx < day.blocks.length; bIdx++) {
      const block = day.blocks[bIdx];

      if (block.isSystem) {
        const sysText = block.items[0]?.msg?.text || '';
        docChildren.push(new Paragraph({
          style: 'ChatSystem',
          alignment: AlignmentType.CENTER,
          bidirectional: isRtlText(sysText),
          spacing: { before: 100, after: 100 },
          children: buildTextRuns(TextRun, sysText, {
            italics: true,
            size: SZ_SYSTEM,
            color: COLOR_MUTED
          }, colorMode)
        }));
        processed += block.items.length;
        continue;
      }

      const firstTime = includeTimestamps && block.firstTimestamp
        ? formatExportTime(block.firstTimestamp, timeFormat, block.items[0]?.msg?.timestampApproximate, platform)
        : '';

      const buildHeaderPara = (spacing) => new Paragraph({
        style: 'ChatName',
        keepNext: true,
        spacing,
        children: [
          ...buildTextRuns(TextRun, block.sender, {
            bold: true,
            size: SZ_NAME,
            color: block.colorHex
          }, colorMode),
          ...(firstTime ? [new TextRun({
            text: `  ${firstTime}`,
            size: SZ_TIME,
            color: COLOR_MUTED,
            font: 'Segoe UI',
            noProof: true
          })] : [])
        ]
      });

      const blockParas = [buildHeaderPara({ before: 20, after: 40 })];
      block.items.forEach((item, idx) => {
        blockParas.push(...renderMessageParagraphs(item, block, idx === 0));
      });

      if (effectiveLayout === 'bubbles') {
        const bubbleFill = block.isMe ? COLOR_MY_BUBBLE : COLOR_OTHER_BUBBLE;
        const spacerCell = new TableCell({
          width: { size: 30, type: WidthType.PERCENTAGE },
          borders: { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder },
          children: [new Paragraph({ children: [] })]
        });
        const contentCell = new TableCell({
          width: { size: 70, type: WidthType.PERCENTAGE },
          shading: { fill: bubbleFill, type: ShadingType.CLEAR },
          borders: {
            top: { style: BorderStyle.SINGLE, size: 4, color: bubbleFill },
            bottom: { style: BorderStyle.SINGLE, size: 4, color: bubbleFill },
            left: { style: BorderStyle.SINGLE, size: 4, color: bubbleFill },
            right: { style: BorderStyle.SINGLE, size: 4, color: bubbleFill }
          },
          margins: { top: 100, bottom: 100, left: 160, right: 160 },
          children: blockParas
        });

        docChildren.push(new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          borders: {
            top: noBorder, bottom: noBorder, left: noBorder, right: noBorder,
            insideHorizontal: noBorder, insideVertical: noBorder
          },
          rows: [new TableRow({
            cantSplit: block.items.length <= 6,
            children: block.isMe ? [spacerCell, contentCell] : [contentCell, spacerCell]
          })]
        }));

        docChildren.push(new Paragraph({
          spacing: { before: 0, after: 100 },
          children: []
        }));
      } else {
        blockParas[0] = buildHeaderPara({ before: 160, after: 40 });
        docChildren.push(...blockParas);
      }

      processed += block.items.length;
      if (processed % CHUNK_SIZE < block.items.length) {
        onProgress({
          percent: Math.min(85, Math.round((processed / Math.max(1, total)) * 85)),
          processed,
          total,
          fallbackToCompact
        });
        await yieldToEventLoop();
      }
    }
  }

  onProgress({ percent: 90, processed: total, total, fallbackToCompact });

  // Page size: A4 (11906 x 16838) or Letter (12240 x 15840), 2cm margins (1134 twips)
  const pageDims = pageSize === 'Letter'
    ? { width: 12240, height: 15840 }
    : { width: 11906, height: 16838 };

  const exportDateShort = formatExportDate(new Date(), dateFormat);

  const doc = new Document({
    title: `${platform} Chat - ${chatName}`,
    creator: 'ChatFlow',
    description: `Local chat export of ${chatName} from ${platform}`,
    styles: {
      default: {
        document: {
          run: {
            font: 'Segoe UI',
            size: SZ_BODY,
            color: COLOR_TEXT,
            noProof: true
          }
        }
      },
      paragraphStyles: [
        {
          id: 'ChatName',
          name: 'ChatName',
          basedOn: 'Normal',
          run: { font: 'Segoe UI', size: SZ_NAME, bold: true, noProof: true }
        },
        {
          id: 'ChatTime',
          name: 'ChatTime',
          basedOn: 'Normal',
          run: { font: 'Segoe UI', size: SZ_TIME, color: COLOR_MUTED, noProof: true }
        },
        {
          id: 'ChatMessage',
          name: 'ChatMessage',
          basedOn: 'Normal',
          run: { font: 'Segoe UI', size: SZ_BODY, color: COLOR_TEXT, noProof: true }
        },
        {
          id: 'ChatQuote',
          name: 'ChatQuote',
          basedOn: 'Normal',
          run: { font: 'Segoe UI', size: SZ_QUOTE, italics: true, color: COLOR_MUTED, noProof: true }
        },
        {
          id: 'ChatSystem',
          name: 'ChatSystem',
          basedOn: 'Normal',
          run: { font: 'Segoe UI', size: SZ_SYSTEM, italics: true, color: COLOR_MUTED, noProof: true }
        }
      ]
    },
    sections: [{
      properties: {
        page: {
          size: pageDims,
          margin: { top: 1134, right: 1134, bottom: 1134, left: 1134 }
        }
      },
      headers: {
        default: new Header({
          children: [new Paragraph({
            alignment: AlignmentType.RIGHT,
            children: buildTextRuns(TextRun, `ChatFlow  |  ${chatName}`, {
              size: 16, color: COLOR_MUTED
            }, colorMode)
          })]
        })
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({ text: 'Page ', size: 16, color: COLOR_MUTED, font: 'Segoe UI', noProof: true }),
              new TextRun({ children: [PageNumber.CURRENT], size: 16, color: COLOR_MUTED, font: 'Segoe UI', noProof: true }),
              new TextRun({ text: ' of ', size: 16, color: COLOR_MUTED, font: 'Segoe UI', noProof: true }),
              new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: COLOR_MUTED, font: 'Segoe UI', noProof: true }),
              new TextRun({ text: `   ·   ${exportDateShort}`, size: 16, color: COLOR_MUTED, font: 'Segoe UI', noProof: true })
            ]
          })]
        })
      },
      children: docChildren
    }]
  });

  onProgress({ percent: 96, processed: total, total, fallbackToCompact });
  return { doc, Packer, total, fallbackToCompact };
}

/**
 * Generate and download Word (.docx) document in browser.
 */
export async function exportDocx(messages, stats, options = {}, onProgress = () => {}) {
  const { doc, Packer } = await buildDocxDocument(messages, stats, options, onProgress);
  const blob = await Packer.toBlob(doc);
  onProgress({ percent: 100 });

  const safePlatform = (options.platform || stats.platform || 'Chat').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  const safeName = (options.chatName || stats.chatName || 'Conversation').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  const dateStr = new Date().toISOString().slice(0, 10);
  const filename = `${safePlatform} Chat - ${safeName} - ${dateStr}.docx`;

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 10000);

  return filename;
}
