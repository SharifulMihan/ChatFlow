/**
 * adapters/index.js
 * Adapter factory for ChatFlow.
 * Selects the appropriate platform adapter based on the active tab URL.
 */

import { WhatsAppAdapter } from './whatsapp.js';
import { MessengerAdapter } from './messenger.js';

export { BaseAdapter } from './base.js';
export { WhatsAppAdapter } from './whatsapp.js';
export { MessengerAdapter } from './messenger.js';

const adapters = [
  new WhatsAppAdapter(),
  new MessengerAdapter()
];

/**
 * Get the platform adapter instance for the provided URL or window location.
 * @param {string} [url=window.location.href]
 * @returns {BaseAdapter|null}
 */
export function getAdapter(url = window.location.href) {
  for (const adapter of adapters) {
    if (adapter.detect(url)) {
      return adapter;
    }
  }
  return null;
}

/**
 * Return platform name ("WhatsApp" | "Messenger") or null.
 * @param {string} [url=window.location.href]
 * @returns {string|null}
 */
export function detectPlatform(url = window.location.href) {
  const adapter = getAdapter(url);
  return adapter ? adapter.name : null;
}
