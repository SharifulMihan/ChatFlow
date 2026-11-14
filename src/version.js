// AUTO-GENERATED from manifest.json and CHANGELOG.md by scripts/version-manager.js
// Do not edit version numbers here by hand; update manifest.json or run npm run version:sync.

export const APP_VERSION = "2.5.0";
export const APP_VERSION_TAG = "v2.5.0";
export const APP_DISPLAY_VERSION = "ChatFlow v2.5.0";
export const RELEASE_DATE = "2026-11-14";
export const RELEASE_HIGHLIGHTS = Object.freeze([
  "Smart & faster Messenger scanning: Skips the full second verification pass on clean scans (Verification: not needed), with a Verify now button and Thorough scan toggle in Settings.",
  "Single-block replies & icon-only messages: Merged split Messenger reply rows into one clean quote + reply block across .docx/.txt/.pdf, and captured thumbs-up Likes (👍), stickers, and GIFs.",
  "Reliable completion & privacy: Fixed the \"options is not defined\" completion error, kept \"Group messages by sender\" OFF by default, and pruned debug reports so chat text stays redacted by default.",
  "Safer updates & version checks: Added post-update What's New highlights, settings migration, and automatic content-script reload prompts after an extension update."
]);
export const CHANGELOG_SUMMARY = Object.freeze([
  {
    "version": "2.5.0",
    "date": "2026-11-14",
    "title": "",
    "highlights": [
      "Smart & faster Messenger scanning: Skips the full second verification pass on clean scans (Verification: not needed), with a Verify now button and Thorough scan toggle in Settings.",
      "Single-block replies & icon-only messages: Merged split Messenger reply rows into one clean quote + reply block across .docx/.txt/.pdf, and captured thumbs-up Likes (👍), stickers, and GIFs.",
      "Reliable completion & privacy: Fixed the \"options is not defined\" completion error, kept \"Group messages by sender\" OFF by default, and pruned debug reports so chat text stays redacted by default.",
      "Safer updates & version checks: Added post-update What's New highlights, settings migration, and automatic content-script reload prompts after an extension update."
    ],
    "sections": [
      {
        "heading": "Added",
        "items": [
          "Smart Verification & On-Demand Verify: Pass 2 now runs automatically only when Pass 1 flags a scroll gap, unique unrecognized row, orphan reply, low direction confidence, date-order violation, or step error; added Thorough scan (always verify) toggle (default OFF) and completion-card Verify now button.",
          "Phase-Clear Scanning UI: Stepper and progress card clearly show \"Reading messages\" during Pass 1 and switch to \"Verifying\" with an independent progress bar (#verify-progress-box) when verification runs, without recounting the message counter.",
          "Icon-Only Messenger Messages: Added recognition for thumbs-up Likes (type: 'like', rendered as 👍), stickers, GIFs, and emoji-only <img> rows (extractIconOnlyInfo(), isEmojiImage()).",
          "Unique Audit Counters & Pruned DOM Skeletons: Added WeakMap row identity tracking (uniqueRowsSeen, uniqueUnrecognized, etc. separate from sightings) and buildPrunedDomSkeleton() (<=800 chars, privacy-redacted unless \"Include sample text\" is checked).",
          "Release & Version Management: Added single-source-of-truth versioning (manifest.json -> src/version.js), npm run version:check, release:patch|minor|major, build:zip, RELEASING.md, post-update What's New card (#whats-new-card), Settings changelog viewer, versioned settings migrations, and content-script/sidepanel version handshake.",
          "Static & Export Consistency: Added ESLint (no-undef, no-unused-vars) checks and shared renderMessageBlock() helpers across .docx and .txt."
        ]
      },
      {
        "heading": "Changed",
        "items": [
          "Messenger Pass 1 Efficiency: Increased downward scroll step from 40% to 60% of viewport height with 300 ms DOM quiet settle and per-element WeakMap row parse caching (rowParseCache) so live DOM rows are classified once across overlapping snapshots.",
          "Messenger Split-Row Reply Grouping: Merged 1-row, 2-row, and 3-row [reply-label] + [quote] + [reply] Messenger sequences into ONE block matching WhatsApp, with ↪ Replying to <Name> (8.5pt bold #6B7280), 9pt italic quote truncated to 140 chars with …, and 3pt colored left border.",
          "Default Export Option: Forced \"Group messages by sender\" OFF by default on startup, rescan, and right after each export.",
          "Display Name & Reaction Formatting: Expanded UI_NAME_BLOCKLIST_EXACT / validatePersonName() to block \"Controls and settings\" and UI labels, added \"Your name in this export\" inputs synced per platform, and stripped \"reaction with\" / \"see who\" / duration strings from reaction chips.",
          "Version Visibility: Surfaced ChatFlow v2.5.0 in Settings, footer, Diagnostics, debug JSON, error details, .docx core/custom properties (ChatFlowVersion) and summary/page footers, .txt header/footer, and .pdf cover footer."
        ]
      },
      {
        "heading": "Fixed",
        "items": [
          "Completion Crash (\"options is not defined\"): Added DEFAULT_EXPORT_OPTIONS and normalizeExportOptions() across lib/transcript.js and all exporters, plus isolated try/catch blocks around post-scan sub-steps so partial check errors never hide scan results.",
          "\"Stop loading\" & Direction Errors: Added per-phase AbortController, immediate STOP_LOADING ack, 2-second watchdog, \"Reload tab\" recovery button, and array-normalized comboUsed in content/direction.js.",
          "Messenger Completeness & Chronology: Fixed localDateCursor reset per snapshot, hover-tooltip exclusion, weekday resolution relative to scan date, non-decreasing chronological date checks, and partial avatar/participant name filtering."
        ]
      }
    ]
  },
  {
    "version": "2.4.0",
    "date": "",
    "title": "Multi-Signal Direction Engine, Two-Phase Manual-Start Scan & Scan Health Checklist",
    "highlights": [
      "Independent Direction Signals: Combines container classes/attributes (message-out/message-in), bubble horizontal geometry relative to the scroll pane (geometryVote), outgoing delivery tick icons (OUTGOING_TICK_SELECTORS / isTickLabel), 2-cluster bubble background color (buildColorModel / colorVote), and data-pre-plain-text sender name (nameVote) while ignoring reply-quote labels.",
      "Self-Check & Automatic Fallback Combos: Live every 200 messages during Phase 2 and at the end of scanning, checks if one side in a 50+ message 1-to-1 chat has 0 or >98% of messages. Automatically tries alternative signal combinations (no-class, geometry+ticks, geometry, ticks, color) and records per-signal agreement in integrity.direction.",
      "\"Confirm Who Is Who\" Dialog & \"Swap Sides\": Interactive 2-column dialog (#direction-backdrop) with 3 sample bubbles per side, \"Left side is me\" / \"Right side is me\" / \"Swap sides\" actions that update all messages in memory without rescanning and persist per-chat preferences (myName, meSide, swapped) in chrome.storage.local (zero message text).",
      "Fixed Participant Colors & \"You\" Badge: Pinned #2DB87A (.docx #1B5E3F, soft green bubble #E8F5EE) to isMe=true and #3B82F6 (.docx #1D4ED8, soft gray bubble #F3F4F6) to the contact across Overview, Participants tab, Export preview, and .docx."
    ],
    "sections": [
      {
        "heading": "1. Multi-Signal Direction Separation & Self-Check (`content/direction.js`)",
        "items": [
          "Independent Direction Signals: Combines container classes/attributes (message-out/message-in), bubble horizontal geometry relative to the scroll pane (geometryVote), outgoing delivery tick icons (OUTGOING_TICK_SELECTORS / isTickLabel), 2-cluster bubble background color (buildColorModel / colorVote), and data-pre-plain-text sender name (nameVote) while ignoring reply-quote labels.",
          "Self-Check & Automatic Fallback Combos: Live every 200 messages during Phase 2 and at the end of scanning, checks if one side in a 50+ message 1-to-1 chat has 0 or >98% of messages. Automatically tries alternative signal combinations (no-class, geometry+ticks, geometry, ticks, color) and records per-signal agreement in integrity.direction.",
          "\"Confirm Who Is Who\" Dialog & \"Swap Sides\": Interactive 2-column dialog (#direction-backdrop) with 3 sample bubbles per side, \"Left side is me\" / \"Right side is me\" / \"Swap sides\" actions that update all messages in memory without rescanning and persist per-chat preferences (myName, meSide, swapped) in chrome.storage.local (zero message text).",
          "Fixed Participant Colors & \"You\" Badge: Pinned #2DB87A (.docx #1B5E3F, soft green bubble #E8F5EE) to isMe=true and #3B82F6 (.docx #1D4ED8, soft gray bubble #F3F4F6) to the contact across Overview, Participants tab, Export preview, and .docx."
        ]
      },
      {
        "heading": "2. Two-Phase Scan State Machine & Manual \"Ready to Scan\" (`content/scanner.js`, `sidepanel/sidepanel.js`)",
        "items": [
          "Phase 1 (\"Loading chat history\"): Scrolls upward to load history without showing or incrementing a message counter. Shows live oldest loaded date, elapsed time, and 10s stall prompt + highlighted \"Stop loading\" button.",
          "Passive \"Ready to scan\" State: Stops after Phase 1 with a green check (\"Full history loaded\") or amber dot (\"Partial history\") badge, passive MutationObserver updating oldest date live if the user scrolls up manually, \"Start scan\" / \"Load more history\" / \"Cancel\" buttons, dismissible floating tip (#ready-tip) with \"Don't show again\", and an optional \"Start reading automatically when the full history is loaded\" toggle in Settings (default OFF).",
          "Phase 2 (\"Reading messages\"): Scrolls downward once from the top, starting the message counter at 0 and increasing monotonically (0–100%) with speed (msgs/s) and ETA."
        ]
      },
      {
        "heading": "3. Stepper & Completion Scan Health Checklist (`sidepanel/index.html`, `sidepanel/css/components.css`)",
        "items": [
          "3-Step Horizontal Stepper: Shows 1. Load history -> 2. Read messages -> 3. Prepare export.",
          "Completion Summary & Scan Health Card: Displays total messages, date range, 2-row participant summary with split bar, and 4 expandable Scan Health checks (Direction check, Date check, Completeness check, Duplicate check)."
        ]
      }
    ]
  },
  {
    "version": "2.3.0",
    "date": "",
    "title": "Participant/Reply/Timestamp Fixes, Clean Conversation Redesign & Global Launch Readiness",
    "highlights": [
      "Strict Sender Priority & sanitizeSenderName(): Parses data-pre-plain-text up to the LAST colon, strips trailing colons (\"You::\" -> \"You\", \"Raj::\" -> \"Raj\") and invisible/RTL control characters, rejects time/date strings (\"1:22 AM\", \"17:45\", \"11/5/2026\", \"Yesterday\"), and maps localized \"You\" (\"আপনি\", \"Tú\", \"Vous\", \"Du\", \"Você\", \"أنت\", etc.) to the user's display name.",
      "No Timestamp-as-Sender Fallback: Removed the [data-testid=\"msg-meta\"] span fallback that previously read message times as participant names on media/sticker/voice bubbles.",
      "One-to-One vs Group Detection & Sanity Check: detectChatType() distinguishes 1-to-1 vs group chats from the header. runParticipantSanityCheck() enforces exactly 2 participants in 1-to-1 chats, merges case/whitespace variants in groups, and surfaces warnings in the side panel and debug log.",
      "Strict Reply Body Isolation: Excludes the quoted-message container when extracting the reply body so body never duplicates replyTo.text."
    ],
    "sections": [
      {
        "heading": "1. Participant & Sender Fixes (WhatsApp & Scanner)",
        "items": [
          "Strict Sender Priority & sanitizeSenderName(): Parses data-pre-plain-text up to the LAST colon, strips trailing colons (\"You::\" -> \"You\", \"Raj::\" -> \"Raj\") and invisible/RTL control characters, rejects time/date strings (\"1:22 AM\", \"17:45\", \"11/5/2026\", \"Yesterday\"), and maps localized \"You\" (\"আপনি\", \"Tú\", \"Vous\", \"Du\", \"Você\", \"أنت\", etc.) to the user's display name.",
          "No Timestamp-as-Sender Fallback: Removed the [data-testid=\"msg-meta\"] span fallback that previously read message times as participant names on media/sticker/voice bubbles.",
          "One-to-One vs Group Detection & Sanity Check: detectChatType() distinguishes 1-to-1 vs group chats from the header. runParticipantSanityCheck() enforces exactly 2 participants in 1-to-1 chats, merges case/whitespace variants in groups, and surfaces warnings in the side panel and debug log."
        ]
      },
      {
        "heading": "2. Reply & Timestamp Fixes",
        "items": [
          "Strict Reply Body Isolation: Excludes the quoted-message container when extracting the reply body so body never duplicates replyTo.text.",
          "Exact WhatsApp Timestamps: Sets timestampApproximate = false for all WhatsApp messages and never displays ~ for WhatsApp; ~ is reserved strictly for Messenger separator-derived times."
        ]
      },
      {
        "heading": "3. Redesigned `.docx`, `.pdf`, and `.txt` Exports",
        "items": [
          "Cover / Summary Page: Centered header with ChatFlow branding, large chat title, clean 2-column info table, and Participants table with per-person color and share bars.",
          "Grouped Conversation Transcript: Centered date dividers (keepNext), 5-minute sender grouping, 2-column borderless Chat Bubbles layout (with Compact and Plain layouts + automatic Compact fallback >20,000 messages), 3pt colored quote borders, Unicode media chips, reactions, (edited), and clickable Table of Contents for >3 month chats.",
          "Typography, No Squiggles & RTL: w:noProof on all runs, per-script fonts and w:lang (bn-BD, ar-SA, etc.), w:bidi on RTL paragraphs, and real Word styles (ChatName, ChatTime, ChatMessage, ChatQuote, ChatSystem)."
        ]
      },
      {
        "heading": "4. Export Options, Live Preview & Global Launch",
        "items": [
          "Export Tab Controls: Layout, Date/Time formats, Page size (A4/Letter), Font size (S/M/L), Color/B&W, \"My name in exports\", \"Rename participants\", 7 toggle switches, live 5-block mini preview, and Print-to-PDF export.",
          "Global i18n & Privacy: Added chrome.i18n locales (en, bn, es, pt_BR, fr, de, hi, ar, id, tr, ru), Privacy notice, and \"Report a problem\" diagnostics copy (zero message content)."
        ]
      }
    ]
  },
  {
    "version": "2.2.2",
    "date": "",
    "title": "Strict Date Separator Validation, Reply Preview Deduplication & Overlap Merging",
    "highlights": [
      "Eliminated new Date(s) Fallback: Completely removed loose fallback to new Date(s), which converted arbitrary numbers inside messages (such as \"250\", \"300\", \"500\") into ancient years (e.g. year 249 or 1950 \"Jan 50\").",
      "Strict Standalone Separator Validation: Only elements outside message bubbles that have no avatar, reaction pills, or action buttons, and whose entire trimmed text strictly matches validated date patterns are treated as date separators.",
      "Century & Year Sanity Checks: Two-digit years 00–99 are strictly mapped to 2000–2099 (year < 100 ? year + 2000 : year).",
      "isValidConversationDate(d) Guard: Restricts valid conversation dates strictly to years 2008 through currentYear + 1. Rejects any date in the future (> 24 hours ahead) or past (< 2008)."
    ],
    "sections": [
      {
        "heading": "1. Strict Date Separator Detection & Range Parsing (No More \"Jan 50\" or 648,964 Days)",
        "items": [
          "Eliminated new Date(s) Fallback: Completely removed loose fallback to new Date(s), which converted arbitrary numbers inside messages (such as \"250\", \"300\", \"500\") into ancient years (e.g. year 249 or 1950 \"Jan 50\").",
          "Strict Standalone Separator Validation: Only elements outside message bubbles that have no avatar, reaction pills, or action buttons, and whose entire trimmed text strictly matches validated date patterns are treated as date separators.",
          "Century & Year Sanity Checks: Two-digit years 00–99 are strictly mapped to 2000–2099 (year < 100 ? year + 2000 : year).",
          "isValidConversationDate(d) Guard: Restricts valid conversation dates strictly to years 2008 through currentYear + 1. Rejects any date in the future (> 24 hours ahead) or past (< 2008).",
          "Non-Decreasing Chronological Sanity: Drops separator detections if a parsed timestamp moves backwards by more than 24 hours.",
          "Accurate Date Range & Metrics: Calculates date span directly from the earliest and latest valid timestamps (dEnd - dStart), accurately rendering single/multi-day chat spans instead of 648,964 days.",
          "Activity Table & Charts Filter: Excludes non-conversation years from monthly breakdown table, weekday bar charts, and SVG trendlines."
        ]
      },
      {
        "heading": "2. Reply Previews & Reply Labels Properly Detected (No More Duplicated Quote Lines)",
        "items": [
          "Standalone Reply Label Detection: isReplyLabel() accurately detects labels such as \"Nadira Fairuxa replied to you\", \"You replied to Nadira Fairuxa\", \"X replied to themselves\", and Bengali equivalents (\"X উত্তর দিয়েছেন\"). These labels are never emitted as message rows or participant senders.",
          "Quoted Reply Extraction: Captures the quoted preview into replyTo = { sender, text } and associates it with the subsequent reply message bubble.",
          "Nested Quote Isolation: Excludes the quoted preview container (extractText(..., quoteElement)) when reading the replying message bubble, preventing quoted text from duplicating or replacing the real message.",
          "Dedicated Reply Paragraph in .docx: Renders the quoted reply as a dedicated indented paragraph directly above the reply message (↪ replying to <Name>: \"<short quote>\") in muted italics, with no inline duplication.",
          "Formatted Quotes in .txt: Outputs replies cleanly with indicator (↪ replying to <Name>: \"<short quote>\")."
        ]
      },
      {
        "heading": "3. Snapshot Overlap Merging & Preservation of Identical Messages",
        "items": [
          "Order-Based Suffix/Prefix Alignment: In Phase 2 downward scan, aligns successive DOM viewport snapshots by searching for the longest matching suffix-prefix overlap based on authoritative DOM IDs or content fingerprints.",
          "Identical Consecutive Messages Preserved: Unlike hash-based deduplication, overlap merging safely preserves repeated identical consecutive messages (e.g. \"Ok\", \"Ok\", \"Cc\").",
          "Conservative Downward Steps: Uses DOWNWARD_STEP_RATIO = 0.48 (<= 50% viewport) combined with waitForDomQuiet (300ms quiet wait, up to 1500ms max) ensuring at least 50% overlap between successive DOM captures.",
          "Backtrack on Gap: Backtracks by half a step if no overlap is detected before re-reading."
        ]
      },
      {
        "heading": "4. Accurate Participant Stats in 1-to-1 Chats",
        "items": [
          "Exactly 2 People in 1-to-1 Chat: Filters out 'System' and 'Unknown', ensuring 1-to-1 conversations consistently show \"2 people\" and participant progress bars show only real senders."
        ]
      },
      {
        "heading": "5. Scan Integrity Metrics & Verification Tool",
        "items": [
          "Integrity Summary: Tracks totalCaptured, overlapMerges, noOverlapEvents (scroll gaps), and rejectedSeparatorsCount. Included in export metadata headers and displayed in the side panel Settings tab.",
          "DOM Verification Tool: Added a \"Verify Scan\" action in Settings that samples the active chat container to confirm visible messages are present in the transcript in correct relative order."
        ]
      },
      {
        "heading": "1. Robust Sender Detection (Fix for 100% Attribution to Contact)",
        "items": [
          "Bounding Box Geometry Comparison: Compares the message bubble's physical bounding rectangle against the chat scroll container (cRect.right - bRect.right vs bRect.left - cRect.left). Outgoing messages (aligned near the right margin with substantial left margin) are attributed to \"Me\" (isMe = true). Incoming messages (aligned near the left margin with substantial right margin) are attributed to the contact (\"Nadira Fairuxa\").",
          "Flex & CSS Alignment Fallback: Inspects computed justify-content: flex-end or align-items: flex-end as a secondary signal.",
          "Accessibility Signal Confirmation: Hidden screen reader attributes like aria-label=\"You sent\", aria-label=\"You replied to...\", or Bengali \"আপনি পাঠিয়েছেন\" provide explicit confirmation for isMe = true.",
          "Sender Imbalance Guardrail: Added #sender-warning-banner in the side panel overview tab; automatically alerts if >95% of messages are attributed to a single participant in a multi-party chat."
        ]
      },
      {
        "heading": "2. Complete Accessibility Prefix & Status Stripping",
        "items": [
          "Screen Reader Prefix Stripping: Strips prefixes such as \"You sent: \", \"<Name> sent: \", \"You replied to <Name>: \", \"Enter, Message sent: \", \"Forwarded: \", and Bengali equivalents (\"আপনি পাঠিয়েছেন: \", \"আপনি উত্তর দিয়েছেন: \") from message text.",
          "Pure Accessibility Line Dropping: Drops rows that consist solely of status announcements (\"You sent\", \"Seen by <Name> at HH:mm\", \"Delivered\", \"Enter, Message sent\"), preventing them from being recorded as real message lines."
        ]
      },
      {
        "heading": "3. Reaction Badges Handled Properly (No More \"😆 [~12:00 AM]: [image]\")",
        "items": [
          "Top-Level Row Filtering: Ignores nested rows and reaction pills during candidate message row selection.",
          "Reaction Badge Detection: Recognizes standalone emoji reaction badges via isReactionOnly() and attaches the emoji directly to the preceding message's reactions array (e.g. msg.reactions: [\"😆\"]).",
          "Sender Name Emoji Rejection: isEmojiOnlySender() requires sender names to contain at least one letter (\\p{L}), preventing reaction emojis (\"😆\", \"❤️\") from ever being assigned as a sender name.",
          "Image Type Detection Guard: Differentiates between actual photos/attachments and emoji images (static.xx.fbcdn.net/...emoji.php), preventing reaction emojis from generating [image] placeholders."
        ]
      },
      {
        "heading": "4. Chronological Date Separator Parser (No Epoch 2000-01-01)",
        "items": [
          "Universal Date Separator Parsing: Recognizes and parses Messenger separator strings:",
          "Full numeric dates: \"12/10/25, 2:19 PM\", \"14/12/2025, 9:36 PM\".",
          "Format auto-detection: detectDateFormat() inspects separator day/month values to automatically determine 'MDY' vs 'DMY'.",
          "Time-only separators: \"12:45 AM\", \"2:19 PM\" correctly inherit the last known calendar date.",
          "Weekday separators: \"Mon 10:32 AM\", \"Tuesday 4:15 PM\".",
          "Relative dates: \"Today at 10:32 AM\", \"Yesterday at 8:15 PM\".",
          "Zero Epoch Fallback: Removed all default fallback to 2000-01-01 or 12:00 AM. Undetermined dates are explicitly marked as \"Date unknown\" and approximate times are prefixed with ~ (e.g. ~2:19 PM).",
          "Phase 3 Forward Timestamp Propagation: Propagates firstKnownTimestamp with timestampApproximate = true to any leading messages preceding the first visible separator, and performs a stable sort preserving DOM sequence order."
        ]
      },
      {
        "heading": "5. Exporter Improvements (.docx & .txt)",
        "items": [
          "Word (.docx):",
          "Distinct styling for outgoing (\"Me\") vs incoming (\"Nadira Fairuxa\") with platform accent color (#2F80ED for Messenger, #2DB87A for WhatsApp).",
          "Outgoing messages indented with a clean vertical accent left border.",
          "Date headers grouped by real dates (\"Wednesday, December 10, 2025\"), never \"Saturday, January 1, 2000\".",
          "Reactions rendered inline (e.g. (😆)).",
          "Text (.txt):",
          "Outgoing messages prefixed with > Me, incoming with < Other.",
          "Approximate times rendered as [~h:mm A].",
          "Reactions rendered as (😆)."
        ]
      }
    ]
  },
  {
    "version": "2.2.0",
    "date": "",
    "title": "Two-Phase State Machine, Top Detection & Clean Group Chat Names",
    "highlights": [
      "Resolved Messenger Virtualization Hang: Fixed infinite loop bug where dynamically rendered Messenger messages generated volatile milliseconds timestamps, causing collectVisible() to continuously register new IDs and never trigger completion.",
      "Explicit Two-Phase Architecture:",
      "Phase 1 (\"up\"): Navigates to the conversation beginning with live status: *\"Step 1 of 2: Loading older messages...\"*.",
      "Phase 2 (\"down\"): Steps downward (~70% visible viewport) with 250–400ms delay for virtual DOM stabilization, capturing every message into a Map keyed by deterministic stable IDs. Live status: *\"Step 2 of 2: Reading messages...\"*."
    ],
    "sections": [
      {
        "heading": "1. Robust Two-Phase State Machine (Fix for Scan Getting Stuck at Top)",
        "items": [
          "Resolved Messenger Virtualization Hang: Fixed infinite loop bug where dynamically rendered Messenger messages generated volatile milliseconds timestamps, causing collectVisible() to continuously register new IDs and never trigger completion.",
          "Explicit Two-Phase Architecture:",
          "Phase 1 (\"up\"): Navigates to the conversation beginning with live status: *\"Step 1 of 2: Loading older messages...\"*.",
          "Phase 2 (\"down\"): Steps downward (~70% visible viewport) with 250–400ms delay for virtual DOM stabilization, capturing every message into a Map keyed by deterministic stable IDs. Live status: *\"Step 2 of 2: Reading messages...\"*.",
          "Phase 3 (\"finalize\"): De-duplicates, sorts chronologically from oldest to latest, and builds analytics.",
          "Multi-Factor \"Reached Top\" Detection:",
          "Treats the top as reached immediately when Conversation Intro Block is detected in the DOM (matches English and Bengali end-to-end encryption / group created text via INTRO_BLOCK_PATTERNS).",
          "Detects scrollTop <= 2 after verified idle wait.",
          "Detects static top element signature for 3 consecutive checks.",
          "Hard cap of 45 attempts and 25-second timeout ceiling guarantees progression to Phase 2.",
          "20-Second Watchdog: Displays stall prompt and pulses \"Scan from here\" if no progress occurs for 20 seconds."
        ]
      },
      {
        "heading": "2. Messenger Group Chat Name & Pinned Message Filter",
        "items": [
          "Visible Header Title Prioritized: MessengerAdapter.getChatName() reads the visible bold header title first (header h1, h2, span[role=\"heading\"], div[dir=\"auto\"]).",
          "Pinned Message Exclusion: Explicitly ignores pinned message banners ([aria-label*=\"pinned\" i], [data-testid*=\"pinned\" i], \"Pinned message\", \"পিন করা মেসেজ\"), preventing pinned message member handles (e.g. \"Safa ~072 (B1)\") from being mistaken for the chat name.",
          "Universal sanitizeChatName():",
          "Strips accessibility prefixes (\"Conversation titled \", \"Conversation with \", \"Conversation in \", \"Chat with \", \"Group chat \", Bengali equivalents).",
          "Only strips \"Conversation \" when followed by titled|with|in|about, preserving legitimate names like \"Conversation Notes\".",
          "Strips trailing status text (\"Active now\", \"Active 43m ago\", \"Typing...\", \"Muted\").",
          "Preserves legitimate special characters like \"~\", \"&\", emojis, and Bengali script (e.g. \"Section~B\" -> \"Section~B\").",
          "Unicode-Aware Avatar Initials: getInitials(name) extracts first letters of first two words (e.g. \"Section~B\" -> \"SB\", \"Raj Roy\" -> \"RR\", \"ফাহিম ভাই\" -> \"ফভ\"), never generating \"CT\" from accessibility text."
        ]
      },
      {
        "heading": "3. Top Bar Refresh Rescan",
        "items": [
          "Immediate Rescan on Refresh Click: Clicking #top-btn-refresh at the top left of the side panel clears cached scan data, resets UI state, re-detects the active tab and conversation, and immediately triggers a fresh scan."
        ]
      },
      {
        "heading": "4. Real-Time Chat Switch & Rename Observer",
        "items": [
          "Zero-Click Switch Detection: Single-page navigation in Messenger or WhatsApp automatically updates the chat header title and avatar initials with short debounce, without requiring manual refresh."
        ]
      },
      {
        "heading": "5. Diagnostics & Debugging Aids",
        "items": [
          "Selector Health Check: Added in Settings tab with a \"Run Check\" button verifying scrollContainer, chatHeader, and messageRows selectors in real-time.",
          "Debug Logging Toggle: Configurable setting logging phase transitions, scroll metrics, and top/bottom detection reasons."
        ]
      }
    ]
  },
  {
    "version": "2.1.0",
    "date": "",
    "title": "Automatic Platform Themes & \"Scan From Here\" Early Finalization",
    "highlights": [
      "Zero-Action Theme Switching: Side panel automatically adapts its entire accent theme to the active messenger:",
      "WhatsApp: Emerald Green primary #2DB87A, hover #27A56D, highlight card #1F6F4F.",
      "Messenger: Royal Blue primary #2F80ED, hover #2570D6, highlight card #1B4A8F.",
      "Neutral/Unsupported: Calm slate green #4E7D6B with neutral highlight card #2A3E37."
    ],
    "sections": [
      {
        "heading": "1. Automatic Platform Theme (Green for WhatsApp, Blue for Messenger)",
        "items": [
          "Zero-Action Theme Switching: Side panel automatically adapts its entire accent theme to the active messenger:",
          "WhatsApp: Emerald Green primary #2DB87A, hover #27A56D, highlight card #1F6F4F.",
          "Messenger: Royal Blue primary #2F80ED, hover #2570D6, highlight card #1B4A8F.",
          "Neutral/Unsupported: Calm slate green #4E7D6B with neutral highlight card #2A3E37.",
          "CSS Architecture: Implemented via data-platform=\"whatsapp|messenger|neutral\" on root without duplicate CSS. Backgrounds, rail, and card dark slates remain identical so only the accents change.",
          "Accented Components: Primary buttons, active rail navigation item, toggles, progress bars, weekday peak bar, participant distribution bars, platform badges, focus rings, and toasts all dynamically adopt the platform accent.",
          "Dynamic Logo & Toolbar Icon:",
          "The side panel SVG logo mark adopts the platform accent via var(--primary) and var(--primary-dark).",
          "The browser toolbar icon dynamically switches via chrome.action.setIcon (16, 32, 48, 128 px sets for green, blue, and neutral).",
          "Tab & URL Synchronization: Listens to chrome.tabs.onActivated and chrome.tabs.onUpdated in both the background service worker and side panel controller for instantaneous switching upon tab switch or navigation without page reloads.",
          "Motion & Accessibility: 200ms smooth transition between platform themes; strictly respects prefers-reduced-motion.",
          "Word Exporter Styling: .docx document headers and outgoing sender highlights dynamically use matching emerald or royal blue palette."
        ]
      },
      {
        "heading": "2. \"Scan From Here\" Early Finalization & Stall Detection",
        "items": [
          "\"Scan From Here\" Button: Added next to \"Cancel\" in the scanning state.",
          "Cancel = abort and discard scan data.",
          "\"Scan from here\" = stop waiting for older messages, retain all captured history, finish the current visible sweep down to the latest message, sort chronologically, and proceed directly to dashboard analytics and exports.",
          "Sub-Second Responsiveness: The scan controller evaluates ctrl.finalized and ctrl.cancelled flags at every await point (after each scroll, delay, mutation, and auto-click) for sub-second reaction.",
          "10-Second Stall Auto-Detection:",
          "If message count does not grow for ~10 seconds, displays an inline warning: *\"Old messages aren't loading. You can continue with the messages loaded so far.\"*",
          "Automatically pulses and highlights the \"Scan from here\" button as the recommended action.",
          "Strict Safety Rule & Localized Prompts:",
          "The extension remains strictly read-only except for the single permitted click on WhatsApp's phone-sync prompt.",
          "Localized prompt matching in English (*\"Click here to get older messages from your phone\"*) and Bengali (*\"আপনার ফোন থেকে পুরানো মেসেজ পেতে এখানে ক্লিক করুন\"* / *\"পুরোনো মেসেজ\"*), plus international variants.",
          "Throttled prompt auto-retrying: maximum 3 clicks per stall with 2.5-second cooldown delays.",
          "Messenger infinite scroll remains entirely click-free."
        ]
      }
    ]
  },
  {
    "version": "2.0.0",
    "date": "",
    "title": "Upgrade to ChatFlow (Multi-Platform WhatsApp & Messenger Support)",
    "highlights": [
      "Product Name: Transformed from WhatsAppAnalysis to ChatFlow.",
      "Tagline: *\"Chat to document\"*.",
      "Short Description: *\"Scan WhatsApp and Messenger chats and export them as Word or text files.\"*",
      "Export Filename Standard: <Platform> Chat - <ContactName> - <YYYY-MM-DD>.docx and <Platform> Chat - <ContactName> - <YYYY-MM-DD>.txt (with strict file system character sanitization)."
    ],
    "sections": [
      {
        "heading": "1. Rename & Rebranding",
        "items": [
          "Product Name: Transformed from WhatsAppAnalysis to ChatFlow.",
          "Tagline: *\"Chat to document\"*.",
          "Short Description: *\"Scan WhatsApp and Messenger chats and export them as Word or text files.\"*",
          "Export Filename Standard: <Platform> Chat - <ContactName> - <YYYY-MM-DD>.docx and <Platform> Chat - <ContactName> - <YYYY-MM-DD>.txt (with strict file system character sanitization).",
          "New Flat Logo: Redesigned flat solid green (#2DB87A) rounded icon with overlapping speech bubbles flowing into a folded document corner with transcript lines. Exported as logo.svg, logo-wordmark.svg, logo-monochrome.svg, and multi-resolution PNGs (16, 32, 48, 128 px)."
        ]
      },
      {
        "heading": "2. Platform Adapter Architecture",
        "items": [
          "Created content/adapters/base.js defining the BaseAdapter interface:",
          "detect(), getChatName(), getScrollContainer(), scrollToLoadOlder(), extractMessages(), healthCheck().",
          "Standardized the normalized message contract:",
          "Migrated WhatsApp Web DOM logic into content/adapters/whatsapp.js.",
          "Implemented content/adapters/messenger.js targeting www.messenger.com/* and www.facebook.com/messages/*:",
          "Stable semantic hooks relying on ARIA attributes (role=\"main\", role=\"grid\", role=\"row\"), tag hierarchy, and data attributes rather than obfuscated classes.",
          "Time separator parsing with chronological propagation (timestampApproximate: true).",
          "Contact name extraction ignoring presence status (*\"Active now\"*, *\"Active 5m ago\"*, etc.).",
          "Group chat author detection and fallback to \"Me\" / \"Contact\" / \"System\" / \"Unknown\".",
          "Implemented content/adapters/index.js factory selecting active adapter dynamically based on tab URL.",
          "Authored ADAPTERS.md with a template adapter and step-by-step instructions for adding Telegram, Instagram, and Discord."
        ]
      },
      {
        "heading": "3. WhatsApp Bug Fixes & Automation",
        "items": [
          "Phone-Sync Auto-Trigger: Scanner now auto-detects and triggers the *\"Click here to get older messages from your phone\"* banner, waits up to 6.5s per batch for phone sync delivery, and resets the stability counter to ensure full conversation capture to the true beginning.",
          "Presence Text Exclusion: Contact name parsing strictly filters out presence/status indicators (*\"last seen...\"*, *\"online\"*, *\"typing...\"*).",
          "No Blank Senders: System messages normalized to 'System'; empty sender strings sanitized."
        ]
      },
      {
        "heading": "4. Side Panel UI (Flat Dark Dashboard in Green Theme)",
        "items": [
          "Clean, human-made aesthetic matching the reference dashboard in a green palette:",
          "Page: #1B1D2A, Rail: #161824, Cards: #262839, Raised tiles: #2F3247, Active Nav: #34384F.",
          "Primary Green: #2DB87A (#27A56D hover), Deep Green Highlight Card: #1F6F4F, Gold Chart: #F2C94C.",
          "Top bar displays contact avatar with initials, clean chat title, and a dynamic Platform Badge (WhatsApp or Messenger).",
          "Dual launch buttons for unsupported tabs (*\"Open WhatsApp Web\"* and *\"Open Messenger\"*).",
          "Theme switcher in Settings (Dark mode default, optional Light mode persisted in chrome.storage.local).",
          "Understated privacy notice: *\"Nothing leaves your device. All transcripts and documents are processed locally.\"*",
          "Persistent bottom credit: *\"Made by S.I.Mihan\"*."
        ]
      },
      {
        "heading": "5. Document Exporters",
        "items": [
          "Word (.docx) and Text (.txt) exporters updated with ChatFlow branding, platform tags, date headings, bold senders, quoted replies, approximate timestamp markers (~), and footer page numbers (Page X of Y).",
          "Chunked generation engine supporting 50,000+ messages without freezing the side panel UI."
        ]
      }
    ]
  }
]);

/**
 * Resolve extension version at runtime via Chrome manifest when available,
 * falling back to the generated APP_VERSION constant in Node tests or contexts
 * without chrome.runtime.getManifest.
 * @returns {string}
 */
export function getExtensionVersion() {
  if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.getManifest === 'function') {
    const manifest = chrome.runtime.getManifest();
    if (manifest && typeof manifest.version === 'string' && manifest.version.trim()) {
      return manifest.version.trim();
    }
  }
  return APP_VERSION;
}
