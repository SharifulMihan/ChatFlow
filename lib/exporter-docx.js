/**
 * exporter-docx.js
 * Generates a clean, global-ready .docx conversation document for ChatFlow.
 * Supports Chat Bubbles, Compact, and Plain layouts, chunked rendering for 50,000+ messages,
 * per-script fonts & w:lang, w:noProof (zero squiggles), RTL (w:bidi), real Word styles,
 * and automatic Compact fallback above 20,000 messages.
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
import {
  isValidConversationDate,
  detectScriptAndLang,
  isRtlText,
  cleanReactionsList
} from '../content/selectors.js';
import { getExtensionVersion } from '../src/version.js';

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

function getQuoteFillHex(effectiveLayout, isBW) {
  if (effectiveLayout !== 'bubbles') return 'F3F4F6';
  if (isBW) return 'F0F0F0';
  return 'E5E7EB';
}

function renderMessageParagraphs(item, block, isFirstInBlock, ctx) {
  const {
    docxLib,
    effectiveLayout = 'bubbles',
    isBW = false,
    colorMode = 'color',
    isGroupChat = false,
    resolvedMyName = 'Me',
    chatName = '',
    colorBySender = new Map(),
    includeTimestamps = true,
    groupBySender = false,
    timeFormat = 'auto',
    platform = 'WhatsApp',
    showReactions = true,
    showMediaLabels = true,
    hideQuotedReplies = false,
    SZ_BODY = 21,
    SZ_TIME = 17,
    SZ_QUOTE = 18,
    COLOR_MUTED = '6B7280',
    COLOR_TEXT = '111827'
  } = ctx;
  const { Paragraph, TextRun, ShadingType, BorderStyle } = docxLib;

  const quoteBoxBorder = (accentHex, fillHex) => ({
    left: { style: BorderStyle.SINGLE, size: 24, color: accentHex || COLOR_MUTED, space: 4 },
    top: { style: BorderStyle.SINGLE, size: 2, color: fillHex, space: 4 },
    bottom: { style: BorderStyle.SINGLE, size: 2, color: fillHex, space: 4 },
    right: { style: BorderStyle.SINGLE, size: 2, color: fillHex, space: 4 }
  });

  const { msg, showTime } = item;
  const paras = [];
  const isUnrecognized = msg.type === 'unrecognized';
  const isLike = msg.type === 'like';
  const isMedia = !isUnrecognized && !isLike && msg.type && msg.type !== 'text' && msg.type !== 'deleted';
  if (isMedia && !showMediaLabels) return paras;

  const bodyText = msg.type === 'deleted'
    ? 'This message was deleted'
    : (isLike ? (msg.text || '👍') : (isUnrecognized || isMedia ? formatMediaChip(msg) : (msg.text || '')));

  const rtl = isRtlText(bodyText);
  let hasQuoteBlock = false;

  // Reply quote block (distinct shaded box inside bubble before the reply body)
  if (!hideQuotedReplies && msg.replyTo && typeof msg.replyTo === 'object') {
    const parts = formatReplyQuoteParts(msg.replyTo, msg, {
      myName: resolvedMyName,
      chatName,
      isGroup: isGroupChat,
      colorMode,
      colorBySender
    });
    if (parts && (parts.headerText || parts.bodyText)) {
      hasQuoteBlock = true;
      const quoteFillHex = getQuoteFillHex(effectiveLayout, isBW);
      const qColor = isBW ? COLOR_MUTED : (parts.borderColorHex || COLOR_MUTED);
      const quoteRuns = buildTextRuns(TextRun, parts.headerText, {
        bold: true,
        italics: false,
        size: SZ_TIME, // 8.5pt
        color: COLOR_MUTED
      }, colorMode);

      if (parts.bodyText) {
        quoteRuns.push(new TextRun({ text: '', break: 1, size: SZ_QUOTE, font: 'Segoe UI', noProof: true }));
        quoteRuns.push(...buildTextRuns(TextRun, parts.bodyText, {
          italics: true,
          size: SZ_QUOTE, // 9pt
          color: COLOR_MUTED
        }, colorMode));
      }

      const qRtl = isRtlText(parts.bodyText || parts.headerText);
      paras.push(new Paragraph({
        style: 'ChatQuote',
        shading: { type: ShadingType.CLEAR, color: 'auto', fill: quoteFillHex },
        border: quoteBoxBorder(qColor, quoteFillHex),
        indent: { left: 80, right: 80 },
        bidirectional: qRtl,
        spacing: { before: 40, after: 80, line: 260 },
        children: quoteRuns
      }));
    }
  }

  // Message line (4pt space above when preceded by a quote block)
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

  if (isLike) {
    msgRuns.push(...buildTextRuns(TextRun, bodyText, {
      size: SZ_BODY,
      color: COLOR_TEXT
    }, colorMode));
    if (showMediaLabels) {
      msgRuns.push(new TextRun({
        text: ' Like',
        italics: true,
        size: SZ_TIME,
        color: COLOR_MUTED,
        font: 'Segoe UI',
        noProof: true
      }));
    }
  } else if (msg.type === 'deleted' || isUnrecognized || isMedia) {
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
    spacing: { before: hasQuoteBlock ? 80 : 20, after: 40, line: 276 },
    indent: (effectiveLayout !== 'bubbles' && groupBySender && !isFirstInBlock) ? { left: 160 } : undefined,
    children: msgRuns
  }));

  const rxList = cleanReactionsList(Array.isArray(msg.reactions) ? msg.reactions : [], { myName: resolvedMyName });
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
}

/**
 * Render one grouped message block (shared between WhatsApp and Messenger .docx exports).
 * @param {Object} block
 * @param {Object} [ctx={}]
 * @returns {Array}
 */
export function renderMessageBlock(block, ctx = {}) {
  const docxLib = ctx.docxLib || (typeof window !== 'undefined' ? window.docx : globalThis.docx);
  if (!docxLib) throw new Error('docx library not available.');
  const {
    Paragraph, TextRun, AlignmentType, BorderStyle, Table, TableRow, TableCell,
    WidthType, ShadingType
  } = docxLib;

  const {
    effectiveLayout = 'bubbles',
    colorMode = 'color',
    includeTimestamps = true,
    timeFormat = 'auto',
    platform = 'WhatsApp',
    SZ_NAME = 20,
    SZ_TIME = 17,
    SZ_SYSTEM = 18,
    COLOR_MY_BUBBLE = colorMode === 'bw' ? 'E5E7EB' : 'EFF6FF',
    COLOR_OTHER_BUBBLE = 'F3F4F6',
    COLOR_MUTED = '6B7280'
  } = ctx;

  if (block.isSystem) {
    const sysText = block.items[0]?.msg?.text || '';
    return [new Paragraph({
      style: 'ChatSystem',
      alignment: AlignmentType.CENTER,
      bidirectional: isRtlText(sysText),
      spacing: { before: 100, after: 100 },
      children: buildTextRuns(TextRun, sysText, {
        italics: true,
        size: SZ_SYSTEM,
        color: COLOR_MUTED
      }, colorMode)
    })];
  }

  const fullCtx = { ...ctx, docxLib };
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
    blockParas.push(...renderMessageParagraphs(item, block, idx === 0, fullCtx));
  });

  if (effectiveLayout === 'bubbles') {
    const noBorder = { style: BorderStyle.NONE, size: 0, color: 'auto' };
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

    return [
      new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: {
          top: noBorder, bottom: noBorder, left: noBorder, right: noBorder,
          insideHorizontal: noBorder, insideVertical: noBorder
        },
        rows: [new TableRow({
          cantSplit: block.items.length <= 6,
          children: block.isMe ? [spacerCell, contentCell] : [contentCell, spacerCell]
        })]
      }),
      new Paragraph({
        spacing: { before: 0, after: 100 },
        children: []
      })
    ];
  }

  blockParas[0] = buildHeaderPara({ before: 160, after: 40 });
  return blockParas;
}

/**
 * Build and return a Blob (browser) or Buffer (Node) for the .docx document.
 */
export async function buildDocxDocument(messages, stats = {}, options = DEFAULT_EXPORT_OPTIONS, onProgress = () => {}, docxLibOverride = null) {
  const docxLib = docxLibOverride || (typeof window !== 'undefined' ? window.docx : globalThis.docx);
  if (!docxLib) throw new Error('docx library not available.');
  if (!stats || typeof stats !== 'object') stats = {};

  const {
    Document, Packer, Paragraph, TextRun, HeadingLevel,
    AlignmentType, BorderStyle, Table, TableRow, TableCell,
    WidthType, ShadingType, Header, Footer, PageNumber,
    TableOfContents, PageBreak
  } = docxLib;

  const opts = normalizeExportOptions(options, {
    chatName: (options && options.chatName) || stats.chatName || 'Conversation',
    platform: (options && options.platform) || stats.platform || 'WhatsApp'
  });
  const {
    layout,
    dateFormat,
    timeFormat,
    includeSummary,
    includeTimestamps,
    groupBySender,
    showReactions,
    showMediaLabels,
    hideQuotedReplies,
    pageSize,
    fontSize,
    colorMode,
    chatName,
    platform
  } = opts;

  const prepared = prepareMessagesForExport(messages, opts);
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
  const isGroupChat = participants.length > 2 || stats?.chatType === 'group';
  const resolvedMyName = resolveMyExportName({
    myNameSetting: opts.myName || '',
    detectedName: opts.detectedMyName || '',
    contactName: chatName
  });

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
  const extVersion = getExtensionVersion();

  // ── A) Cover / Summary Page (Page 1) ────────────────────────────────────────
  if (includeSummary) {
    docChildren.push(new Paragraph({
      children: [
        new TextRun({ text: '💬 ', size: 28, font: 'Segoe UI Emoji', noProof: true }),
        new TextRun({ text: `ChatFlow v${extVersion}`, bold: true, size: 28, color: COLOR_BRAND, font: 'Segoe UI', noProof: true }),
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

    const unrecognizedCount = Math.max(
      prepared.filter(m => m.type === 'unrecognized').length,
      stats.integrity?.audit?.unrecognizedCount || 0
    );

    const infoRows = [
      ['Platform', platform],
      ['Exported on', formatExportDate(new Date(), 'medium')],
      ['Date range', dateRangeText],
      ['Total messages', total.toLocaleString()],
      ['Duration', durationDays ? `${durationDays.toLocaleString()} day${durationDays === 1 ? '' : 's'}` : 'N/A'],
      ['Participants', String(participants.length)],
      ...(unrecognizedCount > 0 ? [['Unrecognized rows', unrecognizedCount.toLocaleString()]] : [])
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
    if (includeTimestamps && prepared.some(m => m.timestampApproximate)) {
      docChildren.push(new Paragraph({
        children: [new TextRun({
          text: '~ Approximate time (Messenger shows exact times only at some points in the chat).',
          italics: true, size: 17, color: COLOR_MUTED, font: 'Segoe UI', noProof: true
        })],
        alignment: AlignmentType.CENTER,
        spacing: { before: 80, after: 60 }
      }));
    }

    docChildren.push(new Paragraph({
      children: [new TextRun({
        text: `Exported with ChatFlow v${extVersion}. Nothing leaves your device.`,
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
  const seenMonthLabels = new Set();
  let processed = 0;

  const blockCtx = {
    docxLib,
    effectiveLayout,
    isBW,
    colorMode,
    isGroupChat,
    resolvedMyName,
    chatName,
    colorBySender,
    includeTimestamps,
    groupBySender,
    timeFormat,
    platform,
    showReactions,
    showMediaLabels,
    hideQuotedReplies,
    SZ_BODY,
    SZ_NAME,
    SZ_TIME,
    SZ_QUOTE,
    SZ_SYSTEM,
    COLOR_MY_BUBBLE,
    COLOR_OTHER_BUBBLE,
    COLOR_MUTED,
    COLOR_TEXT
  };

  for (const day of days) {
    // Month heading for TOC when chat > 3 months (emit each month once, in reading order)
    if (spansOver3Months && day.monthLabel !== lastMonthLabel && day.monthLabel !== 'Unknown' && !seenMonthLabels.has(day.monthLabel)) {
      lastMonthLabel = day.monthLabel;
      seenMonthLabels.add(day.monthLabel);
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
      docChildren.push(...renderMessageBlock(block, blockCtx));

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
    creator: `ChatFlow v${extVersion}`,
    lastModifiedBy: `ChatFlow v${extVersion}`,
    description: `Local chat export of ${chatName} from ${platform} (Exported with ChatFlow v${extVersion})`,
    customProperties: [
      { name: 'ChatFlowVersion', value: extVersion }
    ],
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
          run: { font: 'Segoe UI', size: SZ_QUOTE, color: COLOR_MUTED, noProof: true }
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
              new TextRun({ text: `   ·   ChatFlow v${extVersion}   ·   ${exportDateShort}`, size: 16, color: COLOR_MUTED, font: 'Segoe UI', noProof: true })
            ]
          })]
        })
      },
      children: docChildren
    }]
  });

  if (docxLib.StringContainer && Array.isArray(doc?.AppProperties?.root)) {
    doc.AppProperties.root.push(new docxLib.StringContainer('Application', `ChatFlow v${extVersion}`));
  }

  onProgress({ percent: 96, processed: total, total, fallbackToCompact });
  return { doc, Packer, total, fallbackToCompact };
}

/**
 * Generate and download Word (.docx) document in browser.
 */
export async function exportDocx(messages, stats = {}, options = DEFAULT_EXPORT_OPTIONS, onProgress = () => {}) {
  const safeStats = stats && typeof stats === 'object' ? stats : {};
  const opts = normalizeExportOptions(options, {
    chatName: (options && options.chatName) || safeStats.chatName || 'Conversation',
    platform: (options && options.platform) || safeStats.platform || 'Chat'
  });
  const { doc, Packer } = await buildDocxDocument(messages, safeStats, opts, onProgress);
  const blob = await Packer.toBlob(doc);
  onProgress({ percent: 100 });

  const safePlatform = (opts.platform || safeStats.platform || 'Chat').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  const safeName = (opts.chatName || safeStats.chatName || 'Conversation').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
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
