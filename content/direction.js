/**
 * direction.js
 * Pure (DOM-free) logic that decides which messages are MINE vs the CONTACT's.
 *
 * Principle: DIRECTION decides the split. Names are cosmetic and are derived
 * from isMe at the very end (finalizeSenders). Names may only act as ONE vote.
 *
 * Each message carries raw votes in `m.dirVotes`:
 *   { class: bool|null, geometry: bool|null, ticks: bool|null,
 *     name: bool|null, colorRgb: [r,g,b]|null, adapter: bool|null }
 * true = "mine", false = "contact's", null = "no opinion".
 */

import { sanitizeSenderName, isLocalizedYou, isBlockedUiName, validatePersonName } from './selectors.js';

/**
 * Safely coerce any diagnostic or collection value into an Array.
 * Returns [] for null/undefined/numbers/booleans, Array.from(value) for a Set/iterable,
 * [value] for a non-empty string, and Object.keys(value) for a plain object.
 * @param {*} value
 * @returns {Array}
 */
export function toList(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.slice();
  if (typeof value === 'string') return value.length > 0 ? [value] : [];
  if (typeof value === 'number' || typeof value === 'boolean') return [];
  if (typeof value[Symbol.iterator] === 'function') {
    try { return Array.from(value); } catch (_) { return []; }
  }
  if (typeof value === 'object') {
    try { return Object.keys(value); } catch (_) { return []; }
  }
  return [];
}

/**
 * Format direction & integrity diagnostics into a human-readable multiline string.
 * Safe against non-array comboUsed / tried / log fields.
 * @param {Object} integrityOrDir
 * @returns {string}
 */
export function formatDirectionDiagnostics(integrityOrDir) {
  if (!integrityOrDir || typeof integrityOrDir !== 'object') {
    return 'No scan yet.';
  }
  const hasWrapper = 'direction' in integrityOrDir || 'chatType' in integrityOrDir || 'detectedMyName' in integrityOrDir;
  const integrity = hasWrapper ? integrityOrDir : { direction: integrityOrDir };
  const dir = (integrity.direction && typeof integrity.direction === 'object') ? integrity.direction : {};

  const comboArr = toList(dir.comboUsed).map(String).filter(Boolean);
  const comboStr = comboArr.length > 0 ? comboArr.join(' + ') : (typeof dir.comboId === 'string' && dir.comboId ? dir.comboId : 'default');

  const meCount = dir.meCount ?? dir.counts?.me ?? 0;
  const themCount = dir.themCount ?? dir.counts?.contact ?? 0;

  const triedList = toList(dir.triedDetails || dir.tried);
  const triedStr = triedList.map(t => {
    if (t && typeof t === 'object' && !Array.isArray(t)) {
      const cName = toList(t.combo || t.id).join('+') || String(t.id || 'combo');
      if ('meCount' in t || 'themCount' in t) {
        return `${cName}(me=${t.meCount ?? 0},them=${t.themCount ?? 0},low=${!!t.low})`;
      }
      return cName;
    }
    return String(t);
  }).filter(Boolean).join(' | ') || 'none';

  const lines = [
    `Chat type: ${integrity.chatType || 'one-to-one'}`,
    `Detected myName: ${integrity.detectedMyName || 'Me'}`,
    `Direction combo: ${comboStr}`,
    `Confidence: ${dir.lowConfidence ? 'LOW' : 'HIGH'} (reason: ${dir.reason || 'ok'})`,
    `Counts: me=${meCount}, contact=${themCount}`,
    `Signal agreement vs final: ${JSON.stringify(dir.agreement || {})}`,
    `Tried combos: ${triedStr}`
  ];

  const logEntries = toList(dir.log).map(String).filter(Boolean);
  if (logEntries.length > 0) {
    lines.push(`Notes: ${logEntries.join('; ')}`);
  }
  if (integrity.diagnosticsError) {
    lines.push(`Diagnostics warning: ${integrity.diagnosticsError}`);
  }
  return lines.join('\n');
}

export const SIGNAL_WEIGHTS = {
  class: 1.0,
  geometry: 1.0,
  name: 1.0,
  adapter: 1.0,
  ticks: 0.8,
  color: 0.6
};

export const SIGNAL_COMBOS = [
  { id: 'all', signals: ['class', 'geometry', 'ticks', 'color', 'name', 'adapter'] },
  { id: 'no-class', signals: ['geometry', 'ticks', 'color', 'name', 'adapter'] },
  { id: 'geometry+ticks', signals: ['geometry', 'ticks'] },
  { id: 'ticks+color', signals: ['ticks', 'color'] },
  { id: 'geometry', signals: ['geometry'] },
  { id: 'name', signals: ['name'] },
  { id: 'ticks', signals: ['ticks'] },
  { id: 'color', signals: ['color'] },
  { id: 'class', signals: ['class'] }
];

// ─── Individual signal helpers ───────────────────────────────────────────────

/**
 * Geometry vote from bubble/pane rects. Right half = me, left half = contact.
 * Returns null when the bubble spans (almost) the whole pane (no information).
 */
export function geometryVote(bubbleRect, paneRect) {
  if (!bubbleRect || !paneRect || !paneRect.width || !bubbleRect.width) return null;
  if (bubbleRect.width > paneRect.width * 0.92) return null;
  const paneCenter = paneRect.left + paneRect.width / 2;
  const bubbleCenter = bubbleRect.left + bubbleRect.width / 2;
  const margin = paneRect.width * 0.04;
  if (bubbleCenter > paneCenter + margin) return true;
  if (bubbleCenter < paneCenter - margin) return false;
  // Ambiguous centre: compare the gap to each edge
  const gapLeft = bubbleRect.left - paneRect.left;
  const gapRight = paneRect.right - bubbleRect.right;
  if (Math.abs(gapLeft - gapRight) < paneRect.width * 0.05) return null;
  return gapLeft > gapRight;
}

/**
 * Name vote. Only a vote - never overrides the combined direction.
 * - localized "You" / my profile name => mine
 * - the chat name (the contact) => contact's
 * - any other name => no opinion
 */
export function nameVote(senderRaw, ctx = {}) {
  const clean = sanitizeSenderName(senderRaw);
  if (!clean) return null;
  if (isLocalizedYou(clean)) return true;
  const eq = (a, b) => a && b && a.trim().toLowerCase() === b.trim().toLowerCase();
  if (ctx.myName && eq(clean, ctx.myName)) return true;
  if (ctx.chatName && eq(clean, ctx.chatName)) return false;
  return null;
}

// ─── Colour clustering ───────────────────────────────────────────────────────

const colorDist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * Cluster bubble colours of the first `limit` rows into two groups (2-means),
 * and decide which cluster is "mine" using the non-colour votes as hints.
 * @returns {{centers:number[][], meIndex:number}|null}
 */
export function buildColorModel(messages, limit = 50) {
  const samples = [];
  for (const m of messages) {
    const c = m.dirVotes?.colorRgb;
    if (c && m.type !== 'system') samples.push({ c, v: m.dirVotes });
    if (samples.length >= limit) break;
  }
  if (samples.length < 6) return null;

  // Seed: farthest pair
  let a = samples[0].c, b = samples[0].c, best = -1;
  for (const s of samples) {
    const d = colorDist(s.c, samples[0].c);
    if (d > best) { best = d; b = s.c; }
  }
  best = -1;
  for (const s of samples) {
    const d = colorDist(s.c, b);
    if (d > best) { best = d; a = s.c; }
  }
  if (colorDist(a, b) < 12) return null; // single colour: no information

  let centers = [a.slice(), b.slice()];
  for (let iter = 0; iter < 8; iter++) {
    const sums = [[0, 0, 0, 0], [0, 0, 0, 0]];
    for (const s of samples) {
      const k = colorDist(s.c, centers[0]) <= colorDist(s.c, centers[1]) ? 0 : 1;
      sums[k][0] += s.c[0]; sums[k][1] += s.c[1]; sums[k][2] += s.c[2]; sums[k][3]++;
    }
    centers = centers.map((c, k) => sums[k][3]
      ? [sums[k][0] / sums[k][3], sums[k][1] / sums[k][3], sums[k][2] / sums[k][3]]
      : c);
  }

  // Which cluster is mine? Majority of non-colour votes
  const score = [0, 0];
  for (const s of samples) {
    const k = colorDist(s.c, centers[0]) <= colorDist(s.c, centers[1]) ? 0 : 1;
    for (const sig of ['class', 'geometry', 'ticks', 'name', 'adapter']) {
      const v = s.v[sig];
      if (v === true) score[k] += SIGNAL_WEIGHTS[sig];
      else if (v === false) score[k] -= SIGNAL_WEIGHTS[sig];
    }
  }
  if (score[0] === score[1]) {
    // No hint tells which cluster is mine: the split is right but its orientation is unverified
    return { centers, meIndex: 1, uncertain: true };
  }
  return { centers, meIndex: score[0] > score[1] ? 0 : 1, uncertain: false };
}

export function colorVote(rgb, model) {
  if (!rgb || !model) return null;
  const k = colorDist(rgb, model.centers[0]) <= colorDist(rgb, model.centers[1]) ? 0 : 1;
  return k === model.meIndex;
}

// ─── Combining votes ─────────────────────────────────────────────────────────

/**
 * Weighted majority vote over the allowed signals.
 * @returns {{isMe:boolean, confidence:number, used:string[]}}
 */
export function combineVotes(votes, allowed = SIGNAL_COMBOS[0].signals) {
  let score = 0, total = 0;
  const used = [];
  for (const sig of allowed) {
    const v = votes?.[sig];
    if (v === true || v === false) {
      const w = SIGNAL_WEIGHTS[sig] || 1;
      score += v ? w : -w;
      total += w;
      used.push(sig);
    }
  }
  if (total === 0) return { isMe: false, confidence: 0, used };
  if (score === 0) {
    const tie = votes.class ?? votes.geometry ?? false;
    return { isMe: !!tie, confidence: 0, used };
  }
  return { isMe: score > 0, confidence: Math.abs(score) / total, used };
}

function decideAll(messages, allowed, colorModel) {
  for (const m of messages) {
    if (!m.dirVotes) continue;
    m.dirVotes.color = allowed.includes('color') ? colorVote(m.dirVotes.colorRgb, colorModel) : null;
  }
  const decisions = new Array(messages.length);
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.type === 'system') { decisions[i] = null; continue; }
    if (!m.dirVotes) {
      decisions[i] = { isMe: !!m.isMe, confidence: 0.5, used: ['legacy'] };
      continue;
    }
    decisions[i] = combineVotes(m.dirVotes, allowed);
  }
  return decisions;
}

/**
 * Evaluate split quality.
 * One-to-one + 50 or more messages: one side with 0 messages, or >98% on one side => LOW.
 */
export function evaluateConfidence(messages, chatType = 'one-to-one') {
  let me = 0, contact = 0;
  for (const m of messages) {
    if (m.type === 'system') continue;
    if (m.isMe) me++; else contact++;
  }
  const total = me + contact;
  const maxShare = total ? Math.max(me, contact) / total : 0;
  let low = false;
  let reason = null;
  if (chatType === 'one-to-one' && total >= 50) {
    if (me === 0 || contact === 0) { low = true; reason = 'one_side_empty'; }
    else if (maxShare > 0.98) { low = true; reason = 'one_side_dominates'; }
  }
  return { low, reason, me, contact, total, maxShare };
}

/** How often each signal agrees with the final decision (for diagnostics). */
export function signalAgreement(messages) {
  const out = {};
  for (const sig of Object.keys(SIGNAL_WEIGHTS)) out[sig] = { present: 0, agree: 0 };
  for (const m of messages) {
    if (m.type === 'system' || !m.dirVotes) continue;
    for (const sig of Object.keys(SIGNAL_WEIGHTS)) {
      const v = m.dirVotes[sig];
      if (v === true || v === false) {
        out[sig].present++;
        if (v === !!m.isMe) out[sig].agree++;
      }
    }
  }
  return out;
}

function applyDecisions(messages, decisions) {
  messages.forEach((m, i) => {
    const d = decisions[i];
    if (!d) return;
    m.isMe = d.isMe;
    m.isOutgoing = d.isMe;
    m.dirConfidence = Math.round(d.confidence * 100) / 100;
  });
}

/**
 * Resolve direction for every message.
 * Tries the full vote; if the result is LOW CONFIDENCE, tries alternative signal combinations.
 * @returns {{lowConfidence:boolean, reason:string|null, comboUsed:string, tried:string[],
 *            counts:{me:number,contact:number}, agreement:Object, log:string[]}}
 */
export function resolveDirection(messages, ctx = {}) {
  const chatType = ctx.chatType || 'one-to-one';
  const log = [];

  // Messengers/legacy adapters provide only a final isMe: use it as the 'adapter' vote
  for (const m of messages) {
    if (!m.dirVotes) m.dirVotes = { adapter: typeof m.isMe === 'boolean' ? m.isMe : null };
  }

  const colorModel = buildColorModel(messages, 50);
  const tried = [];
  const triedDetails = [];
  let chosen = null;
  let firstResult = null;

  for (const combo of SIGNAL_COMBOS) {
    const present = messages.some(m => combo.signals.some(s => m.dirVotes?.[s] === true || m.dirVotes?.[s] === false)
      || (combo.signals.includes('color') && colorModel && m.dirVotes?.colorRgb));
    if (!present) continue;
    tried.push(String(combo.id));
    const decisions = decideAll(messages, combo.signals, colorModel);
    applyDecisions(messages, decisions);
    const ev = evaluateConfidence(messages, chatType);
    triedDetails.push({
      id: String(combo.id),
      combo: toList(combo.signals).map(String),
      meCount: ev.me,
      themCount: ev.contact,
      low: ev.low
    });
    if (!firstResult) firstResult = { combo, ev };
    if (!ev.low) { chosen = { combo, ev }; break; }
    log.push(`combo "${combo.id}" rejected: ${ev.reason} (me=${ev.me}, contact=${ev.contact})`);
  }

  let lowConfidence = false;
  let reason = null;
  if (!chosen) {
    // Nothing worked: restore the first (full) combination and flag low confidence
    const combo = firstResult?.combo || SIGNAL_COMBOS[0];
    applyDecisions(messages, decideAll(messages, combo.signals, colorModel));
    chosen = { combo, ev: evaluateConfidence(messages, chatType) };
    lowConfidence = chosen.ev.low;
    reason = chosen.ev.reason;
  }

  const agreement = signalAgreement(messages);
  for (const [sig, a] of Object.entries(agreement)) {
    if (a.present && a.agree / a.present < 0.9) {
      log.push(`signal "${sig}" disagrees with final decision on ${a.present - a.agree}/${a.present} rows`);
    }
  }

  // If only colour gave an opinion, the two groups are right but WHICH is me is unverified
  const hasNonColorOpinion = messages.some(m => ['class', 'geometry', 'ticks', 'name', 'adapter']
    .some(s => m.dirVotes?.[s] === true || m.dirVotes?.[s] === false));
  if (!lowConfidence && !hasNonColorOpinion && messages.some(m => m.type !== 'system')) {
    lowConfidence = true;
    reason = 'orientation_unverified';
    log.push('only bubble colour was available: cannot tell which side is you');
  }

  // Remember which side each message sits on (for the Confirm dialog) and drop heavy raw data
  for (const m of messages) {
    if (m.dirVotes) {
      m.side = computeSide(m, ctx);
      delete m.dirVotes.colorRgb;
    }
  }

  const comboSignals = toList(chosen?.combo?.signals || chosen?.combo?.id).map(String);
  return {
    lowConfidence,
    reason,
    comboId: String(chosen?.combo?.id || 'all'),
    comboUsed: comboSignals.length > 0 ? comboSignals : [String(chosen?.combo?.id || 'all')],
    tried,
    triedDetails,
    meCount: chosen.ev.me,
    themCount: chosen.ev.contact,
    counts: { me: chosen.ev.me, contact: chosen.ev.contact },
    agreement,
    log
  };
}

/** Cheap live check (used every ~200 messages during Phase 2). Does not mutate messages. */
export function quickDirectionCheck(messages, chatType = 'one-to-one') {
  let me = 0, contact = 0;
  for (const m of messages) {
    if (m.type === 'system') continue;
    const v = m.dirVotes ? combineVotes(m.dirVotes, SIGNAL_COMBOS[0].signals) : { isMe: !!m.isMe };
    if (v.isMe) me++; else contact++;
  }
  const total = me + contact;
  const low = chatType === 'one-to-one' && total >= 50 &&
    (me === 0 || contact === 0 || Math.max(me, contact) / total > 0.98);
  return { low, me, contact, total };
}

// ─── Sides, swap, names ──────────────────────────────────────────────────────

/** Visual side of a message ('left' | 'right') used by the Confirm dialog. */
export function computeSide(m, _ctx = {}) {
  const v = m.dirVotes || {};
  if (v.geometry === true) return 'right';
  if (v.geometry === false) return 'left';
  if (v.ticks === true) return 'right';
  if (v.name === true) return 'right';
  if (v.name === false) return 'left';
  if (v.class === true) return 'right';
  if (v.class === false) return 'left';
  return m.isMe ? 'right' : 'left';
}

/** Flip direction of every message in memory (no rescan). */
export function swapSides(messages) {
  for (const m of messages) {
    if (m.type === 'system') continue;
    m.isMe = !m.isMe;
    m.isOutgoing = m.isMe;
    if (m.side) m.side = m.side === 'left' ? 'right' : 'left';
  }
  return messages;
}

/** Apply the answer of the Confirm dialog: everything on `side` is me. */
export function applySideChoice(messages, meSide) {
  for (const m of messages) {
    if (m.type === 'system') continue;
    m.isMe = (m.side || (m.isMe ? 'right' : 'left')) === meSide;
    m.isOutgoing = m.isMe;
  }
  return messages;
}

/** Up to `n` sample bubbles per side for the Confirm dialog (text + time only). */
export function sampleSides(messages, n = 3) {
  const out = { left: [], right: [] };
  for (const m of messages) {
    if (m.type === 'system') continue;
    const side = m.side || (m.isMe ? 'right' : 'left');
    if (out[side].length < n && (m.text || '').trim()) {
      out[side].push({ text: String(m.text).slice(0, 80), timestamp: m.timestamp || null });
    }
  }
  return out;
}

/** Best display name for me: user override > validated page profile > validated outgoing name > "Me". */
export function pickMyName(messages, ctx = {}) {
  if (ctx.myNameOverride && typeof ctx.myNameOverride === 'string') {
    const trimmed = ctx.myNameOverride.trim();
    if (trimmed && !isBlockedUiName(trimmed)) return trimmed;
  }
  const contactName = ctx.chatName || '';
  const profile = validatePersonName(ctx.profileName, { contactName });
  if (profile) return profile;
  const counts = {};
  for (const m of messages) {
    if (m.type === 'system' || !m.isMe) continue;
    const c = validatePersonName(m.senderRaw, { contactName });
    if (c) {
      counts[c] = (counts[c] || 0) + 1;
    }
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0];
  return top || 'Me';
}

/**
 * Final step: compute display names ONLY from isMe.
 * One-to-one => exactly two participants (me, contact).
 * Group => me by isMe; others keep their sanitized names (case/space variants merged).
 */
export function finalizeSenders(messages, ctx = {}) {
  const chatType = ctx.chatType || 'one-to-one';
  const myName = pickMyName(messages, ctx);
  const rawChat = ctx.chatName && !/^(?:WhatsApp chat|Messenger chat|Unknown Chat|Chat)$/i.test(ctx.chatName)
    ? ctx.chatName : null;

  let contactName = rawChat;
  if (!contactName) {
    const counts = {};
    for (const m of messages) {
      if (m.type === 'system' || m.isMe) continue;
      const c = sanitizeSenderName(m.senderRaw || m.sender, { myName });
      if (c && c !== myName) counts[c] = (counts[c] || 0) + 1;
    }
    contactName = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'Contact';
  }

  const canon = new Map();
  let changed = 0;
  for (const m of messages) {
    if (m.type === 'system') { m.sender = 'System'; continue; }
    if (m.senderRaw === undefined) m.senderRaw = m.sender;
    let name;
    if (m.isMe) {
      name = myName;
    } else if (chatType === 'one-to-one') {
      name = contactName;
    } else {
      const c = sanitizeSenderName(m.senderRaw, { myName });
      name = c && c !== myName ? c : 'Contact';
      const key = name.toLowerCase().replace(/\s+/g, ' ');
      if (!canon.has(key)) canon.set(key, name);
      name = canon.get(key);
    }
    if (m.sender !== name) { m.sender = name; changed++; }
    if (m.fingerprint) m.fingerprint.sender = name;

    if (m.replyTo && typeof m.replyTo === 'object') {
      const rSender = (m.replyTo.sender || '').trim();
      const quotesMe = Boolean(
        m.replyTo.senderIsMe === true ||
        isLocalizedYou(rSender) ||
        /^(?:me|you|yourself)$/i.test(rSender) ||
        isBlockedUiName(rSender) ||
        (chatType === 'one-to-one' && !m.isMe && (!rSender || rSender === 'Me'))
      );
      if (quotesMe) {
        m.replyTo = { ...m.replyTo, sender: myName, senderIsMe: true };
      } else if (chatType === 'one-to-one' && m.isMe && (!rSender || /^(?:contact|them)$/i.test(rSender))) {
        m.replyTo = { ...m.replyTo, sender: contactName };
      }
    }
  }

  const counts = {};
  for (const m of messages) {
    if (m.type === 'system') continue;
    counts[m.sender] = (counts[m.sender] || 0) + 1;
  }
  return { myName, contactName, changed, participants: Object.keys(counts), counts };
}

/** Warnings shown in the panel (kept compatible with the previous sanity check). */
export function participantWarnings(messages, chatType, finalCounts) {
  const warnings = [];
  const names = Object.keys(finalCounts);
  if (chatType === 'one-to-one' && names.length !== 2 && messages.length >= 2) {
    warnings.push(`One-to-one chat ended with ${names.length} participant(s).`);
  }
  if (messages.length >= 100) {
    for (const [n, c] of Object.entries(finalCounts)) {
      if (c < 3) warnings.push(`Participant "${n}" has only ${c} message(s) in a ${messages.length}-message chat.`);
    }
  }
  return warnings;
}
