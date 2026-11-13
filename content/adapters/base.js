/**
 * base.js
 * BaseAdapter interface for all platform messenger adapters in ChatFlow.
 * Every messenger (WhatsApp, Messenger, Telegram, Discord, etc.) must implement this interface.
 */

export class BaseAdapter {
  /**
   * @param {string} name - Platform display name ("WhatsApp", "Messenger", etc.)
   */
  constructor(name) {
    if (!name) throw new Error('Adapter must have a name');
    this.name = name;
  }

  /**
   * Detect whether the current page belongs to this platform.
   * @param {string} [url=window.location.href]
   * @returns {boolean}
   */
  detect(url = window.location.href) {
    throw new Error(`${this.name}: detect() not implemented`);
  }

  /**
   * Extract the contact or group name, strictly excluding presence text
   * like "last seen today at...", "Active now", "Active 5m ago", "typing...", etc.
   * @param {Document|Element} [doc=document]
   * @returns {string} Clean contact or group title
   */
  getChatName(doc = (typeof document !== 'undefined' ? document : null)) {
    throw new Error(`${this.name}: getChatName() not implemented`);
  }

  /**
   * Locate the virtualized scrollable container that holds messages.
   * @param {Document|Element} [doc=(typeof document !== 'undefined' ? document : null)]
   * @returns {HTMLElement|null}
   */
  getScrollContainer(doc = (typeof document !== 'undefined' ? document : null)) {
    throw new Error(`${this.name}: getScrollContainer() not implemented`);
  }

  /**
   * Determine whether the conversation beginning / top has been reached.
   * @param {HTMLElement} container
   * @param {Document|Element} [doc=(typeof document !== 'undefined' ? document : null)]
   * @param {Object} [tracker=null]
   * @returns {{ reached: boolean, reason?: string }}
   */
  hasReachedTop(container, doc = (typeof document !== 'undefined' ? document : null), tracker = null) {
    if (!container) return { reached: true, reason: 'no_container' };
    return { reached: container.scrollTop <= 2, reason: 'scrollTop_zero' };
  }

  /**
   * Determine whether the conversation bottom has been reached.
   * @param {HTMLElement} container
   * @param {Document|Element} [doc=(typeof document !== 'undefined' ? document : null)]
   * @returns {{ reached: boolean, reason?: string }}
   */
  hasReachedBottom(container, doc = (typeof document !== 'undefined' ? document : null)) {
    if (!container) return { reached: true, reason: 'no_container' };
    const atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 6;
    return { reached: atBottom, reason: atBottom ? 'scroll_at_bottom' : 'not_at_bottom' };
  }

  /**
   * Scroll up to trigger loading of older messages.
   * Must handle platform-specific load triggers (e.g. clicking "get older messages from phone" on WhatsApp).
   * @param {HTMLElement} container - scroll container returned by getScrollContainer()
   * @param {Document|Element} [doc=(typeof document !== 'undefined' ? document : null)]
   * @param {function} [onProgress] - optional callback for phone-sync status
   * @param {Object} [ctrl=null] - scan controller for checking cancellation/finalization
   * @returns {Promise<{ newMessagesFound: boolean, atTop: boolean }>}
   */
  async scrollToLoadOlder(container, doc = (typeof document !== 'undefined' ? document : null), onProgress = () => {}, ctrl = null) {
    throw new Error(`${this.name}: scrollToLoadOlder() not implemented`);
  }

  /**
   * Extract and normalize currently rendered messages in the DOM.
   * @param {Document|Element} [doc=(typeof document !== 'undefined' ? document : null)]
   * @returns {Array<Object>}
   */
  extractMessages(doc = (typeof document !== 'undefined' ? document : null)) {
    throw new Error(`${this.name}: extractMessages() not implemented`);
  }

  /**
   * Verify that essential DOM selectors are resolving.
   * @param {Document|Element} [doc=(typeof document !== 'undefined' ? document : null)]
   * @returns {{ ok: boolean, results: Array<{ name: string, found: boolean, selector: string }> }}
   */
  healthCheck(doc = (typeof document !== 'undefined' ? document : null)) {
    throw new Error(`${this.name}: healthCheck() not implemented`);
  }
}
