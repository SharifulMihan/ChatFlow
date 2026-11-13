# ChatFlow Platform Adapter Architecture & Guide

ChatFlow uses an adapter-based architecture. Every messenger platform (WhatsApp Web, Facebook Messenger, Telegram, Discord, etc.) is isolated into a dedicated adapter in `content/adapters/`, while the scanning engine, de-duplication, chronological sorting, document generation (`.docx` / `.txt`), and UI dashboards are 100% shared and platform-independent.

---

## 1. The Normalized Message Contract

Every adapter must output messages matching this standardized JSON shape:

```typescript
interface NormalizedMessage {
  id: string;                         // Stable unique ID (data-id or hash of timestamp + sender + text snippet)
  timestamp: string | null;           // ISO 8601 string (e.g. "2026-05-11T15:20:00.000Z")
  timestampApproximate: boolean;      // true if inferred from a section separator header (e.g. Messenger headers)
  sender: string;                     // Contact name, "Me", "System", or "Unknown" (never blank)
  text: string;                       // Clean text body or bracketed non-text item
  type: "text" | "image" | "video" | "voice" | "sticker" | "file" | "call" | "system" | "deleted";
  replyTo?: string;                   // Optional text/author of quoted reply
  isOutgoing?: boolean;               // True if sent by the local user ("Me")
}
```

---

## 2. BaseAdapter Interface (`content/adapters/base.js`)

All adapters inherit from `BaseAdapter`:

```javascript
import { BaseAdapter } from './base.js';

export class MyPlatformAdapter extends BaseAdapter {
  constructor() {
    super('PlatformName');
  }

  detect(url = window.location.href): boolean;
  getChatName(doc = document): string;
  getScrollContainer(doc = document): HTMLElement | null;
  async scrollToLoadOlder(container, doc = document, onProgress = () => {}): Promise<{ newMessagesFound: boolean, atTop: boolean }>;
  extractMessages(doc = document): Array<NormalizedMessage>;
  healthCheck(doc = document): { ok: boolean, results: Array<{ name: string, found: boolean, selector: string }> };
}
```

---

## 3. Template Adapter Starter (`content/adapters/template.js`)

```javascript
import { BaseAdapter } from './base.js';

export class TemplateAdapter extends BaseAdapter {
  constructor() {
    super('NewPlatform');

    this.selectors = {
      scrollContainer: '[data-testid="message-list"], .scroll-container',
      messageRow: '[role="row"], .message-item',
      messageText: '.message-text, [dir="auto"]',
      chatHeader: 'header h1, header [role="heading"]'
    };
  }

  detect(url = window.location.href) {
    return url.startsWith('https://web.newplatform.com');
  }

  isValidContactName(name) {
    if (!name || typeof name !== 'string') return false;
    const s = name.trim();
    if (!s || s.length < 2) return false;
    // Exclude presence text
    return !/\b(online|active now|last seen|typing)\b/i.test(s);
  }

  getChatName(doc = document) {
    const el = doc.querySelector(this.selectors.chatHeader);
    const val = (el?.innerText || el?.textContent || '').trim();
    return this.isValidContactName(val) ? val : 'Unknown Chat';
  }

  getScrollContainer(doc = document) {
    const el = doc.querySelector(this.selectors.scrollContainer);
    if (el) return el;

    // Fallback: search scrollable container
    const divs = doc.querySelectorAll('div');
    for (const d of divs) {
      if (d.scrollHeight > d.clientHeight && d.clientHeight > 200) {
        return d;
      }
    }
    return null;
  }

  async scrollToLoadOlder(container, doc = document, onProgress = () => {}) {
    container.scrollTop = 0;
    container.dispatchEvent(new Event('scroll', { bubbles: true }));
    await new Promise(r => setTimeout(r, 450));
    return { newMessagesFound: true, atTop: container.scrollTop === 0 };
  }

  extractMessages(doc = document) {
    const rows = doc.querySelectorAll(this.selectors.messageRow);
    const messages = [];

    for (const row of rows) {
      const isOutgoing = row.classList.contains('outgoing') || !!row.querySelector('.is-me');
      const textNode = row.querySelector(this.selectors.messageText);
      const text = (textNode?.innerText || row.textContent || '').trim();
      if (!text) continue;

      messages.push({
        id: row.getAttribute('data-id') || 'msg_' + Math.random().toString(36).slice(2),
        timestamp: new Date().toISOString(),
        timestampApproximate: true,
        sender: isOutgoing ? 'Me' : this.getChatName(doc),
        text,
        type: 'text',
        isOutgoing
      });
    }

    return messages;
  }

  healthCheck(doc = document) {
    const results = [
      { name: 'scrollContainer', found: !!this.getScrollContainer(doc), selector: this.selectors.scrollContainer },
      { name: 'chatHeader', found: this.getChatName(doc) !== 'Unknown Chat', selector: this.selectors.chatHeader }
    ];
    return { ok: results.every(r => r.found), results };
  }
}
```

---

## 4. How to Add a New Messenger Platform

### Step 1: Add Host Permissions & Content Scripts in `manifest.json`
```json
"host_permissions": [
  "https://web.whatsapp.com/*",
  "https://www.messenger.com/*",
  "https://www.facebook.com/messages/*",
  "https://web.telegram.org/*"
],
"content_scripts": [
  {
    "matches": [
      "https://web.whatsapp.com/*",
      "https://www.messenger.com/*",
      "https://www.facebook.com/messages/*",
      "https://web.telegram.org/*"
    ],
    "js": ["content/content-script.js"],
    "run_at": "document_idle"
  }
]
```

### Step 2: Implement the Platform Adapter
Create `content/adapters/telegram.js` (or `instagram.js` / `discord.js`) inheriting from `BaseAdapter`. Implement:
- Contact name extraction without presence strings (*"online"*, *"last seen recently"*, etc.).
- Virtualized scroll container detection.
- Timestamp and message body normalization.

### Step 3: Register in `content/adapters/index.js`
```javascript
import { TelegramAdapter } from './telegram.js';

const adapters = [
  new WhatsAppAdapter(),
  new MessengerAdapter(),
  new TelegramAdapter()
];
```

### Step 4: Register Launch Button & Badge in `sidepanel/`
- Add launch button in `sidepanel/index.html` under `#state-not-supported`.
- Add badge color mapping in `sidepanel/css/components.css`.
- Add URL matcher in `sidepanel/sidepanel.js` inside `getPlatformFromUrl()`.

---

## 5. Guide for Upcoming Platforms

| Platform | Primary URLs | Stable Selectors / Strategy | Key Notes |
| :--- | :--- | :--- | :--- |
| **Telegram Web (K / Z / A)** | `https://web.telegram.org/a/*`, `https://web.telegram.org/k/*` | `.bubbles-inner`, `.Message`, `.bubble-content`, `.peer-title` | Handles both WebK and WebA builds. Fast virtualized list. |
| **Instagram Direct** | `https://www.instagram.com/direct/*` | `div[role="main"]`, `div[role="list"]`, `div[dir="auto"]` | Very similar to Facebook Messenger DOM architecture. |
| **Discord Web** | `https://discord.com/channels/*` | `ol[data-list-id="chat-messages"]`, `li[id^="chat-messages-"]` | Markdown formatted text, embed attachments, reaction pills. |
