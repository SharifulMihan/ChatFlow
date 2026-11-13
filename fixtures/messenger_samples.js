/**
 * fixtures/messenger_samples.js
 * HTML & DOM fixtures modeling real Facebook Messenger rows (1-to-1 chat "Sudipta Roy")
 * for unit testing classifyRow(), sender/direction attribution, date resolution,
 * reply/quote isolation, reactions/duration filtering, overlap merge, and virtualized scrolling.
 *
 * Includes BOTH structural patterns:
 *  1) MISSED_CONTACT_ROW_HTML: incoming contact row using flat role="row" > div layout without
 *     data-testid="message-container" / role="gridcell", with left avatar, hidden "Sudipta sent"
 *     accessibility span, hover tooltip date, and emoji reaction pill.
 *  2) EXPORTED_OUTGOING_ROW_HTML: outgoing "You sent" row using classic presentation/gridcell
 *     wrapper and right-aligned purple bubble geometry.
 *  Plus 12 additional row fixtures covering every message/noise type in the bug report.
 */

// ─── Minimal Standards-Compatible HTML -> DOM Tree Builder for Node Tests ────

const VOID_TAGS = new Set(['img', 'br', 'hr', 'input', 'meta', 'link', 'source']);

function parseRectAttr(val) {
  if (!val) return null;
  const parts = val.split(',').map(Number);
  if (parts.length < 4 || parts.some(Number.isNaN)) return null;
  const [left, top, width, height] = parts;
  return { left, top, width, height, right: left + width, bottom: top + height };
}

function parseAttributes(attrStr) {
  const attrs = Object.create(null);
  const re = /([a-zA-Z0-9_:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(attrStr)) !== null) {
    const key = m[1].toLowerCase();
    const val = m[2] ?? m[3] ?? m[4] ?? '';
    attrs[key] = val;
  }
  return attrs;
}

function decodeEntities(str) {
  return str
    .replace(/&nbsp;/g, '\u00A0')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}

function matchesSimpleSelector(el, simple) {
  if (!el || el.nodeType !== 1) return false;
  let rest = simple.trim();
  if (!rest) return false;

  // Extract attribute conditions [...]
  const attrChecks = [];
  rest = rest.replace(/\[([^\]]+)\]/g, (_, inner) => {
    const m = inner.match(/^([a-zA-Z0-9_:-]+)\s*(?:([*^$|~]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+))(?:\s+(i))?)?$/);
    if (m) {
      attrChecks.push({
        attr: m[1].toLowerCase(),
        op: m[2] || null,
        val: m[3] ?? m[4] ?? m[5] ?? '',
        ci: Boolean(m[6])
      });
    }
    return '';
  });

  // Extract classes .foo
  const classChecks = [];
  rest = rest.replace(/\.([a-zA-Z0-9_-]+)/g, (_, cls) => {
    classChecks.push(cls);
    return '';
  });

  // Remaining tag name if any
  const tagCheck = rest.trim().toLowerCase();
  if (tagCheck && tagCheck !== '*' && el.tagName.toLowerCase() !== tagCheck) {
    return false;
  }

  for (const cls of classChecks) {
    if (!el.classList.contains(cls)) return false;
  }

  for (const chk of attrChecks) {
    if (!(chk.attr in el._attrs)) return false;
    if (!chk.op) continue;
    const rawActual = el._attrs[chk.attr];
    const a = chk.ci ? rawActual.toLowerCase() : rawActual;
    const v = chk.ci ? chk.val.toLowerCase() : chk.val;
    if (chk.op === '=' && a !== v) return false;
    if (chk.op === '*=' && !a.includes(v)) return false;
    if (chk.op === '^=' && !a.startsWith(v)) return false;
    if (chk.op === '$=' && !a.endsWith(v)) return false;
  }

  return true;
}

function splitSelectorTokens(selectorPart) {
  const tokens = [];
  let cur = '';
  let bracketDepth = 0;
  let quoteChar = '';
  const s = selectorPart.trim();
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoteChar) {
      cur += ch;
      if (ch === quoteChar) quoteChar = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quoteChar = ch;
      cur += ch;
      continue;
    }
    if (ch === '[') { bracketDepth++; cur += ch; continue; }
    if (ch === ']') { if (bracketDepth > 0) bracketDepth--; cur += ch; continue; }
    if (bracketDepth === 0 && ch === '>') {
      if (cur.trim()) tokens.push(cur.trim());
      tokens.push('>');
      cur = '';
      continue;
    }
    if (bracketDepth === 0 && /\s/.test(ch)) {
      if (cur.trim()) tokens.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) tokens.push(cur.trim());
  return tokens;
}

function matchesSelectorPart(el, selectorPart) {
  // Supports descendant (' ') and direct child ('>') combinators cleanly right-to-left
  const tokens = splitSelectorTokens(selectorPart);
  if (tokens.length === 0) return false;
  const targetToken = tokens[tokens.length - 1];
  if (!matchesSimpleSelector(el, targetToken)) return false;
  if (tokens.length === 1) return true;

  let cur = el;
  for (let i = tokens.length - 2; i >= 0; i--) {
    const tok = tokens[i];
    if (tok === '>') {
      const parentSel = tokens[--i];
      cur = cur.parentElement;
      if (!cur || !matchesSimpleSelector(cur, parentSel)) return false;
    } else {
      let anc = cur.parentElement;
      let matched = false;
      while (anc) {
        if (matchesSimpleSelector(anc, tok)) {
          cur = anc;
          matched = true;
          break;
        }
        anc = anc.parentElement;
      }
      if (!matched) return false;
    }
  }
  return true;
}

function matchesSelector(el, selector) {
  return selector.split(',').some(part => matchesSelectorPart(el, part));
}

export class MockElement {
  constructor(tag, attrs = {}, rawOuter = '') {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this._attrs = attrs;
    this._children = [];
    this.childNodes = [];
    this.parentElement = null;
    this.className = attrs.class || '';
    this._rawOuter = rawOuter;
    this.classList = {
      contains: (c) => this.className.split(/\s+/).filter(Boolean).includes(c),
      add: (c) => {
        const s = new Set(this.className.split(/\s+/).filter(Boolean));
        s.add(c);
        this.className = Array.from(s).join(' ');
      }
    };
    this.style = {};
    this._rect = parseRectAttr(attrs['data-rect']) || { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
  }

  get children() {
    return this._children;
  }

  getAttribute(name) {
    const k = String(name).toLowerCase();
    return k in this._attrs ? this._attrs[k] : null;
  }

  setAttribute(name, value) {
    const k = String(name).toLowerCase();
    this._attrs[k] = String(value);
    if (k === 'class') this.className = String(value);
    if (k === 'data-rect') {
      this._rect = parseRectAttr(String(value)) || this._rect;
    }
  }

  getBoundingClientRect() {
    return { ...this._rect };
  }

  get textContent() {
    return this.childNodes.map(c => (c.nodeType === 3 ? c.textContent : c.textContent)).join('');
  }

  get innerText() {
    const parts = [];
    const walk = (node) => {
      if (node.nodeType === 3) {
        if (node.textContent) parts.push(node.textContent);
        return;
      }
      if (node._attrs?.['aria-hidden'] === 'true' && !node.childNodes.length) return;
      const blockTags = new Set(['DIV', 'P', 'H1', 'H2', 'H3', 'H4', 'LI', 'TR']);
      if (blockTags.has(node.tagName) && parts.length > 0 && !parts[parts.length - 1].endsWith('\n')) {
        parts.push('\n');
      }
      for (const ch of node.childNodes) walk(ch);
      if (blockTags.has(node.tagName) && parts.length > 0 && !parts[parts.length - 1].endsWith('\n')) {
        parts.push('\n');
      }
    };
    walk(this);
    return parts.join('').replace(/\n{2,}/g, '\n').trim();
  }

  get outerHTML() {
    if (this._rawOuter) return this._rawOuter;
    const tag = this.tagName.toLowerCase();
    const attrStr = Object.entries(this._attrs).map(([k, v]) => `${k}="${v}"`).join(' ');
    const open = attrStr ? `<${tag} ${attrStr}>` : `<${tag}>`;
    if (VOID_TAGS.has(tag)) return open;
    const inner = this.childNodes.map(c => (c.nodeType === 3 ? c.textContent : c.outerHTML)).join('');
    return `${open}${inner}</${tag}>`;
  }

  appendChild(node) {
    if (node.nodeType === 1) {
      node.parentElement = this;
      this._children.push(node);
    }
    this.childNodes.push(node);
    return node;
  }

  closest(selector) {
    let cur = this;
    while (cur) {
      if (matchesSelector(cur, selector)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  querySelectorAll(selector) {
    const out = [];
    const visit = (node) => {
      for (const ch of node._children) {
        if (matchesSelector(ch, selector)) out.push(ch);
        visit(ch);
      }
    };
    visit(this);
    return out;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  contains(other) {
    let cur = other;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  compareDocumentPosition(other) {
    if (this === other) return 0;
    if (this.contains(other)) return 16 | 4;
    if (other.contains(this)) return 8 | 2;
    let root = this;
    while (root.parentElement) root = root.parentElement;
    const order = [];
    const dfs = (n) => {
      order.push(n);
      for (const c of n._children) dfs(c);
    };
    dfs(root);
    const iA = order.indexOf(this);
    const iB = order.indexOf(other);
    if (iA !== -1 && iB !== -1) return iA < iB ? 4 : 2;
    return 0;
  }
}

export function parseHtmlElement(html) {
  const root = new MockElement('div', {});
  const stack = [root];
  const tokenRe = /<(\/?)([a-zA-Z0-9_-]+)([^>]*?)(\/?)>|([^<]+)/g;
  let m;
  while ((m = tokenRe.exec(html)) !== null) {
    const [, isClose, tagRaw, attrStr, selfClose, text] = m;
    const parent = stack[stack.length - 1];
    if (text !== undefined) {
      const clean = decodeEntities(text);
      if (clean.trim() || clean.includes('\u00A0')) {
        parent.appendChild({ nodeType: 3, textContent: clean });
      }
      continue;
    }
    const tag = tagRaw.toLowerCase();
    if (isClose) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const el = new MockElement(tag, parseAttributes(attrStr || ''));
    parent.appendChild(el);
    if (!selfClose && !VOID_TAGS.has(tag)) {
      stack.push(el);
    }
  }
  return root._children[0] || root;
}

export function createMockPane(rowsHtml, chatName = 'Sudipta Roy') {
  const paneHtml = `
    <div role="main" aria-label="Conversation with ${chatName}" data-rect="0,0,760,640">
      <div role="grid" aria-label="Messages in conversation with ${chatName}" data-rect="0,0,760,640">
        ${rowsHtml.join('\n')}
      </div>
    </div>
  `;
  const main = parseHtmlElement(paneHtml);
  const container = main.querySelector('[role="grid"]');
  container.scrollTop = 0;
  container.scrollHeight = Math.max(640, rowsHtml.length * 120);
  container.clientHeight = 640;
  container.dispatchEvent = () => true;
  const doc = {
    body: main,
    querySelector: (sel) => (matchesSelector(main, sel) ? main : main.querySelector(sel)),
    querySelectorAll: (sel) => main.querySelectorAll(sel)
  };
  return { doc, main, container };
}

// ─── Supplied / Captured Structural HTML Samples ──────────────────────────────

/**
 * Sample 1: Missed incoming contact row ("Cp boss esob ki bole" style).
 * Structural differences vs Sample 2:
 *  - No data-testid="message-container" wrapper
 *  - Nested plain role="row" > div (not role="gridcell")
 *  - Left avatar <img alt="Sudipta Roy"> + hidden "Sudipta sent" span inside parent scope
 *  - Sibling emoji reaction chip with duration/count adjacent in same row
 */
export const MISSED_CONTACT_ROW_HTML = `
<div role="row" class="x78zum5 xdt5ytf" data-rect="0,120,760,52">
  <div class="contact-avatar-col" data-rect="12,138,32,32">
    <img alt="Sudipta Roy" width="28" height="28" src="https://scontent.xx.fbcdn.net/avatar.jpg" data-rect="14,140,28,28" />
  </div>
  <div class="msg-col-inner" data-rect="52,124,250,44">
    <span class="sr-only">Sudipta sent</span>
    <div dir="auto" class="bubble-incoming" data-rect="52,126,220,34" style="background-color: rgb(48, 48, 48);">Cp boss esob ki bole</div>
    <div role="button" aria-label="Sudipta Roy reacted with 😂" data-rect="230,152,32,18">
      <span>😂</span><span>1</span>
    </div>
  </div>
</div>
`;

/**
 * Sample 2: Exported outgoing row ("Dhaka gesos?" / "Ek marar shathe arek mara").
 * Uses explicit data-testid="message-container" + data-scope="message_content"
 * and right-aligned purple bubble geometry.
 */
export const EXPORTED_OUTGOING_ROW_HTML = `
<div role="row" data-rect="0,240,760,48">
  <div role="gridcell" data-testid="message-container" data-rect="480,244,250,40">
    <span class="sr-only">You sent</span>
    <div data-scope="message_content" data-rect="520,246,190,34" style="background-color: rgb(120, 60, 240);">
      <div dir="auto">Dhaka gesos?</div>
    </div>
  </div>
</div>
`;

// ─── Full Mock Row Fixture Dictionary (Part 7.1) ─────────────────────────────

export const ROW_FIXTURES = {
  missedContactText: MISSED_CONTACT_ROW_HTML,
  exportedMyText: EXPORTED_OUTGOING_ROW_HTML,
  contactText: `
    <div role="row" data-rect="0,300,760,44">
      <div data-rect="12,310,28,28"><img alt="Sudipta Roy" width="28" height="28" src="avatar.jpg" data-rect="12,310,28,28" /></div>
      <div data-scope="message_content" data-rect="52,304,90,32"><div dir="auto">Ho</div></div>
    </div>
  `,
  myText: `
    <div role="row" data-rect="0,350,760,44">
      <div data-scope="message_content" data-rect="530,354,190,32"><div dir="auto">27 tarik preli</div></div>
    </div>
  `,
  contactPhoto: `
    <div role="row" data-rect="0,180,760,260">
      <div data-rect="12,400,28,28"><img alt="Sudipta Roy" width="28" height="28" src="avatar.jpg" data-rect="12,400,28,28" /></div>
      <div data-rect="52,184,320,240">
        <a href="/messenger_media/?photo_id=991" aria-label="Open photo" data-rect="52,184,320,240">
          <img alt="Sketch drawing of student" width="320" height="240" src="sketch.jpg" data-rect="52,184,320,240" />
        </a>
        <div role="button" aria-label="Sudipta Roy reacted with ❤️">❤️ 1</div>
      </div>
    </div>
  `,
  myVideo: `
    <div role="row" data-rect="0,420,760,260">
      <div data-rect="480,424,240,250">
        <div aria-label="Play video" data-rect="480,424,240,250">
          <video poster="thumb.jpg" src="clip.mp4" data-rect="480,424,240,250"></video>
          <span data-rect="670,645,35,16">0:05</span>
        </div>
        <div role="button" aria-label="Sudipta Roy reacted with 😂">😂</div>
      </div>
    </div>
  `,
  replyWithTextQuote: `
    <div role="row" data-rect="0,80,760,80">
      <div data-testid="message-container" data-rect="470,84,250,72">
        <div data-rect="470,84,250,18">You replied to Sudipta</div>
        <div role="blockquote" data-rect="470,104,250,24">
          <div dir="auto">Valoi toh math er sathe toh cp er connection acei</div>
        </div>
        <div data-scope="message_content" data-rect="510,130,210,24">
          <div dir="auto">Ek marar shathe arek mara</div>
        </div>
      </div>
    </div>
  `,
  replyWithVideoThumbQuote: `
    <div role="row" data-rect="0,690,760,120">
      <div data-rect="12,775,28,28"><img alt="Sudipta Roy" width="28" height="28" src="avatar.jpg" data-rect="12,775,28,28" /></div>
      <div data-rect="52,692,160,115">
        <div data-rect="52,692,150,16">Sudipta replied to you</div>
        <div role="blockquote" data-rect="52,710,90,70">
          <video src="quoted_thumb.mp4" data-rect="52,710,90,70"></video>
          <div role="button" aria-label="Play video"></div>
        </div>
        <div data-scope="message_content" data-rect="52,784,80,26">
          <div dir="auto">Sei</div>
        </div>
      </div>
    </div>
  `,
  reactionWithInvalidDuration: `
    <div role="row" data-rect="0,20,760,40">
      <div data-rect="52,22,200,32">
        <div data-scope="message_content" data-rect="52,22,180,30"><div dir="auto">Nice shot!</div></div>
        <div role="button" aria-label="Sudipta Roy reacted with ❤️">❤️</div>
        <div role="button" aria-label="Video duration">0:19</div>
        <div role="button" aria-label="Unknown">???</div>
      </div>
    </div>
  `,
  forwardedImage: `
    <div role="row" data-rect="0,20,760,220">
      <div data-rect="12,200,28,28"><img alt="Sudipta Roy" width="28" height="28" src="avatar.jpg" data-rect="12,200,28,28" /></div>
      <div data-rect="52,22,260,210">
        <div dir="auto">Sudipta forwarded an image</div>
        <a href="/messenger_media/?photo_id=22" aria-label="Open photo" data-rect="52,44,260,180">
          <img alt="Forwarded meme" width="260" height="180" src="fwd.jpg" data-rect="52,44,260,180" />
        </a>
      </div>
    </div>
  `,
  hoverTimestamp: `
    <div role="row" data-rect="0,10,760,24">
      <div role="tooltip" data-rect="300,10,160,20">Jun 10, 2026, 1:32 AM</div>
    </div>
  `,
  dateSepOct22: `
    <div role="row" data-rect="0,10,760,24">
      <h4 dir="auto" data-scope="date_break" data-rect="300,10,160,20">Oct 22, 2026, 2:22 PM</h4>
    </div>
  `,
  dateSepWeekdayThu: `
    <div role="row" data-rect="0,10,760,24">
      <h4 dir="auto" data-scope="date_break" data-rect="330,10,100,20">Thu 5:12 PM</h4>
    </div>
  `,
  avatarLabelOnly: `
    <div role="row" data-rect="0,10,760,20">
      <div dir="auto" data-rect="52,10,80,18">Sudipta</div>
    </div>
  `,
  callRow: `
    <div role="row" data-rect="0,50,760,44">
      <div data-rect="52,52,200,36" aria-label="Missed audio call">
        <div dir="auto">Missed audio call</div>
      </div>
    </div>
  `,
  contactLinkPost: `
    <div role="row" data-rect="0,100,760,70">
      <div data-rect="12,130,28,28"><img alt="Sudipta Roy" width="28" height="28" src="avatar.jpg" data-rect="12,130,28,28" /></div>
      <div data-scope="message_content" data-rect="52,104,290,60">
        <a href="https://codeforces.com/blog/entry/12345" data-rect="52,104,290,56">Check this CP tutorial post</a>
      </div>
    </div>
  `,
  unrecognizedWeirdRow: `
    <div role="row" data-rect="0,900,760,60">
      <canvas data-widget="mystery-card" width="200" height="40"></canvas>
      <span>Custom Interactive Poll Card #42</span>
    </div>
  `
};
