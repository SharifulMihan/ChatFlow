# ChatFlow Implementation Notes (`NOTES.md`)

## Architectural & Design Decisions

1. **Backwards-Compatible Scan Protocol (`START_SCAN` alongside `LOAD_HISTORY` / `START_READING`)**:
   - The new scan experience (Part 2 + Part 6) separates Phase 1 (`LOAD_HISTORY` -> stops in passive `"Ready to scan"` state) from Phase 2 (`START_READING` -> downward reading pass starting counter at 0).
   - To ensure legacy callers or automated tests calling `startScan(onProgress)` in `content/scanner.js` or `START_SCAN` in `content/content-script.js` never break, we preserve a backwards-compatible `startScan` wrapper in `content/scanner.js` and `START_SCAN` handler in `content/content-script.js` while the side panel UI uses the new `LOAD_HISTORY` -> `Ready to scan` -> `START_READING` state machine.

2. **Fixed Participant Color Assignment Across UI & `.docx`**:
   - My messages (`isMe === true`) always use the primary fixed color (`#1B5E3F` in `.docx` / `#2DB87A` in UI, soft green tint `#E8F5EE` in `.docx` bubbles).
   - The contact in a 1-to-1 chat always uses the secondary fixed color (`#1D4ED8` in `.docx` / `#3B82F6` in UI, soft slate/blue tint `#F3F4F6` in `.docx` bubbles), regardless of who sent more messages.
   - In group chats, `isMe` still receives `#1B5E3F` and other participants receive deterministic colors from `PARTICIPANT_COLORS` starting at index 1.

3. **Per-Chat Direction & Name Persistence (`chrome.storage.local`)**:
   - Stored under key `chatflow_chat_prefs` keyed by `${platform}::${chatName}`.
   - Stores only `{ myName, meSide, swapped, updatedAt }` — never any message text or conversation content.
   - Applied automatically when finishing a scan or when the user clicks "Swap sides" or "Left side is me" / "Right side is me" in the "Confirm who is who" dialog.

4. **Bug 1 Fix (`(dir.comboUsed || []).join is not a function`) & Non-Fatal Diagnostics**:
   - `resolveDirection()` in `content/direction.js` previously returned `comboUsed: chosen.combo.id` (a string like `"all"`), while `sidepanel/sidepanel.js` called `(dir.comboUsed || []).join(' + ')` and `dir.tried.map(t => t.combo.join('+'))`.
   - Fixed `resolveDirection()` so `comboUsed` is always an `Array<string>` of signal names (while preserving `comboId` and `triedDetails`), added `toList(value)` and `formatDirectionDiagnostics(integrityOrDir)` in `content/direction.js`, and wrapped all post-scan self-checks and health/diagnostic rendering in `try / catch` so diagnostic issues never replace scan results with `"Scan Notice"`.

5. **Bug 2 Fix (`"Stop loading"` Cancellation, Immediate Ack & 2s Watchdog)**:
   - Phase 1 could previously block up to 6.5s inside `WhatsAppAdapter.scrollToLoadOlder()` plus 1.2s in `waitForMutations()`, and `updateScanProgress()` in `sidepanel/sidepanel.js` ignored `phase === 'ready'` events while `currentScanPhase === 'loading'`.
   - Added one `AbortController` per scan phase (`ScanController.resetPhaseSignal()`), replaced plain sleeps with `abortableSleep(ms, signal, ctrl)`, and wired `waitForMutations`, `waitForDomQuiet`, and adapter `scrollToLoadOlder` loops to resolve immediately on `signal` abort.
   - Clicking `"Stop loading"` now receives an immediate `{ ok: true, status: 'phase1_stopped', state: 'ready', ... }` acknowledgement, transitions to `"Ready to scan"` within ~50–300 ms, and is guarded by a 2-second watchdog in `sidepanel/sidepanel.js` that forces `"Ready to scan"` and retries `STOP_LOADING` up to 3 times if no ack arrives.

6. **Messenger Scan Root Cause & DOM Comparison (Bug Report Fixes)**:
   - **Why Contact Messages Were Missed (`MISSED_CONTACT_ROW_HTML` vs `EXPORTED_OUTGOING_ROW_HTML`)**:
     - Messenger renders many incoming contact text messages and image rows inside a flat `[role="row"] > div` structure containing a left avatar `<img>`, a hidden `"Sudipta sent"` span, and a `div[dir="auto"]` bubble **without** `[data-testid="message-container"]` or `[role="gridcell"]`, whereas outgoing rows frequently wrap the bubble in `[role="gridcell"][data-testid="message-container"]` + `[data-scope="message_content"]`.
     - Single-selector extraction + `isReactionOnly` / accessibility checks either missed rows lacking `[data-scope="message_content"]`, stripped lines matching accessible labels, or let reply thumbnails inside `[role="blockquote"]` hijack `detectMessageType()` (turning the reply `"Sei"` into a phantom `"Video"` message).
   - **Why Junk & Wrong Dates Were Exported**:
     - `MessengerAdapter` stored `activeDateSeparator` across snapshots on `this`. When Snapshot 1 ended in `Sep 4` and Snapshot 2 overlapped rows above `Jun 10`, those rows inherited `Sep 4`, putting `"September 2026"` before `"June 2026"` and duplicating month headings in the TOC. Fixed by initializing `localDateCursor = null` fresh on every `extractMessages()` snapshot and tracking `seenMonthLabels` in `exporter-docx.js`.
     - Weekday separators (`"Thu 5:12 PM"`) previously walked backward from the previous separator (`Oct 23`), resolving to `Oct 22` instead of `Nov 12` relative to the scan date (`Fri Nov 13, 2026`). Fixed in `parseDateSeparatorText()` by resolving weekday separators relative to `baseDate` (`<= baseSessionDate`) while still enforcing `>= lastDate`.
     - Hover timestamps (`role="tooltip"` like `"Jun 10, 2026, 1:32 AM"`), avatar labels (`"Sudipta"`), forwarded prefixes (`"Sudipta forwarded an image"`), and video durations (`"0:19"`, `"???""`) are now classified/filtered strictly by `classifyRow()`, `isCenteredOutsideBubble()`, `isDurationChipText()`, and `extractValidReactions()`.
   - **Never Drop Silently (`classifyRow()` & `UNRECOGNIZED`)**:
     - `enumerateCandidateRows()` queries `[role="row"]`, `[role="gridcell"]`, children of `[aria-label*="Messages in"]`, `[role="region"]`, `[role="grid"]`, `[role="main"]` message panes, and content-bearing direct children.
     - Every candidate goes through `classifyRow()`, returning `message | separator | system | reply-label | ui-noise | UNRECOGNIZED`.
     - `UNRECOGNIZED` rows are logged with index, `scrollTop`, tag/role/aria-label, trimmed text preview, and `outerHTML` (<=2,000 chars), and rows containing visible text/media are emitted as `[Unrecognized message]` (rendered in gray italics in exports).
   - **Ambiguity Resolutions**:
     - *Pass 2 Verification*: Runs automatically for non-WhatsApp (Messenger virtualized DOMs) at `30%` step starting at a half-step offset (`20%` of viewport), and can be opted into via `verifyPass: true`; WhatsApp stays single-pass by default so working WhatsApp scans are unchanged.
     - *Backwards Date Separators*: Never re-sort `masterList`. Backwards separators (>60s earlier than running date) are logged in `integrity.audit.dateOrderViolations` and ignored (clamped to `runningDate`).
     - *5-Minute Sender Grouping*: Uses `Math.abs(msgTimeMs - lastTimeMs) <= 5 min` and trimmed sender equality in `groupMessagesForExport()` so sub-second/approximate timestamp differences never split consecutive bubbles.

7. **Export Display Fixes & Reaction Cleanup (Step 6)**:
   - **Problem 1 (Distinct Reply Quote Block Across `.docx`, `.txt`, `.pdf`)**:
     - Added shared `formatReplyQuoteParts()` and `truncateQuoteText()` in `lib/transcript.js` so all exporters and preview stay consistent.
     - Quote block renders inside the bubble above the reply body (`4pt` spacing before reply body, `10.5pt` `#111827`) with: `↪ Replying to <Name>` header (`8.5pt` bold non-italic `#6B7280`; uses resolved my export name instead of `"Replying to you"`), italic `9pt` `#6B7280` quote body truncated to `140` chars with `"…"`, `3pt` (`w:sz="24"`) left border in the quoted sender's color, `4pt` internal padding (`space: 4` borders + `80` twips indent), and darker shaded bubble overlay (`#DBEAFE` / `#D5EBE0` / `#E5E7EB` / `#D1D5DB`).
     - Quoted media shows a chip on the header (`↪ Replying to <Name> · 🎬 Video` / `📷 Photo` / `🎤 Voice message`) without duplicating body placeholders; stripped stray `"Sudipta:"` and `"Original message:"` prefixes; removed forced `italics: true` from `ChatQuote` style so quote headers render bold non-italic while quote body text stays italic; preserves `w:bidi` for RTL text and works in `bubbles`/`compact` and `color`/`bw`.
     - Fixed `findReplyQuoteInfo()` in `content/adapters/messenger.js` to walk up single-child wrapper `div`s around `replyHeaderEl` in Fallback 1 and avoid swallowing the actual reply bubble into `quoteSet`.
   - **Problem 2 (Prevent `"Controls and Settings"` & UI Labels as My Name)**:
     - Added `UI_NAME_BLOCKLIST_EXACT`, `UI_NAME_BLOCKLIST_SUBSTRINGS`, `isBlockedUiName()`, `validatePersonName()`, and `resolveMyExportName()` in `content/selectors.js` covering English and localized variants (`"Controls and settings"`, `"Settings"`, `"Menu"`, `"Profile"`, `"Your profile"`, `"Account"`, `"Chats"`, `"Messenger"`, `"Facebook"`, `"Notifications"`, `"Marketplace"`, `"More"`, `"Search"`, `"Close"`, `"Back"`, `"Info"`, `"Call"`, `"Video chat"`, Bengali/Spanish/Hindi/Arabic/Indonesian/Turkish/Vietnamese).
     - `MessengerAdapter.detectMyProfileName()` ignores interactive UI buttons/controls (`[role="button"]`, `button`, account menus) and validates via `validatePersonName()` (2–60 chars, non-date, contains letters, `!= contactName`).
     - Source priority for `"me"`: Setting (`"My name in exports"` / `"Your name in this export"` stored per-platform under `chatflow_my_name_by_platform`) -> Validated page detection -> `"Me"`. Purges any previously saved blocked UI strings on load and syncs across Ready, Scan Ready, Export Options, and Settings inputs.
   - **Reactions Cleanup**:
     - Added `parseStructuredReactions()`, `formatReactionChip()`, and `cleanReactionsList()` in `content/selectors.js` to strip `"reaction with"`, `"see who"`, `"reacted to this"`, `"reacted with"`, durations (`"0:19"`), `"???"`, and duplicates, rendering clean chips (`"😂 Sudipta Roy"`, `"😂 2"`, or `"😂"`).
   - **Ambiguity Resolutions (Safest Options)**:
     - *140-char quote truncation*: Slices `Array.from(text)` to `139` code points + `'…'` so total display length never exceeds `140` characters and Unicode surrogate pairs (emoji/Bengali) are never split.
     - *Single vs multi-reactor reaction formatting*: Unknown single reactor renders `'😂'`; multiple count without names renders `'😂 2'`; known single reactor renders `'😂 Sudipta Roy'`.
     - *Per-platform name storage*: Stored in `chrome.storage.local` under `chatflow_my_name_by_platform` keyed by platform (`Messenger`, `WhatsApp`) alongside legacy `chatflow_my_name` so typing your name once on Messenger auto-fills future Messenger exports without forcing `"Controls and Settings"`.

8. **Completion Pipeline Resilience, ESLint Audit & `"Group messages by sender"` Default OFF (Step 7)**:
   - **Root Cause of `"Scan Notice: options is not defined"`**:
     - Adding `formatReplyQuoteParts(m.replyTo, m, { myName: options.myName, chatName: options.chatName })` inside `buildTranscript(messages, dateRange = {})` in `lib/transcript.js` referenced `options` without declaring a parameter. Whenever the scanned chat contained a reply, `background/service-worker.js` `handleScanComplete()` threw `ReferenceError: options is not defined`, causing `finalizeAndSaveScan()` in `sidepanel/sidepanel.js` to replace the results view with `"Scan Notice"`.
   - **Shared Normalized Export Options (`DEFAULT_EXPORT_OPTIONS` & `normalizeExportOptions()`)**:
     - Exported `DEFAULT_EXPORT_OPTIONS` (with `groupBySender: false`) and `normalizeExportOptions(options, overrides)` in `lib/transcript.js`, and adopted them across `buildTranscript`, `prepareMessagesForExport`, `groupMessagesForExport`, `lib/exporter-docx.js`, `lib/exporter-txt.js`, `lib/exporter-pdf.js`, `background/service-worker.js`, and `sidepanel/sidepanel.js`. Missing, `{}` or `undefined` options and `null` stats no longer throw.
   - **Additional Bugs Found by ESLint (`no-undef` / `no-unused-vars`)**:
     - `sidepanel/sidepanel.js` `buildDebugReport()` referenced undeclared `unrecognizedSamples` instead of `unrecognizedSamples: unrecSamples`.
     - `content/selectors.js` `validatePersonName()` referenced undeclared `isNoiseMetaLine`.
   - **Sub-Step Failure Isolation & Global Error Recovery**:
     - Each completion/dashboard sub-step (`service_worker_save`, `preferences_and_direction`, `summary_card`, banners, `export_controls`, `export_preview`, charts, `integrity_metrics`, `participants_tab`, `diagnostics_log`) runs inside its own `try/catch`. If a sub-step fails, scan results still appear (`COMPLETE`) with an amber `#checks-warning-banner` (`"Some checks could not run"` + `"Copy error details"`), full step/message/stack logged in `Settings > Diagnostics`. Only empty/unusable scans (0 messages) trigger `#state-error` (`"Scan Notice"` + `"Copy error details"`).
     - `window` `error` and `unhandledrejection` handlers in `sidepanel/sidepanel.js` and `content/content-script.js` (`RUNTIME_ERROR`) record errors to Diagnostics and ensure the UI never remains stuck in loading/reading/preparing.
   - **Ambiguity Resolutions (Safest Options)**:
     - *`buildTranscript` signature compatibility*: Kept `(messages, dateRange = {}, options = DEFAULT_EXPORT_OPTIONS)` so existing 1-arg and 2-arg callers stay backwards-compatible while also accepting explicit options.
     - *Temporary `"Group messages by sender"` toggle*: Turning `"Group messages by sender"` ON updates the live preview (`renderExportPreview()`) and applies ONLY to the immediately triggered export (`.docx`, PDF, or `.txt`), then `resetGroupBySenderToggle({ refreshPreview: true })` resets it back to `false` right after the export completes (`try/finally`), and `migrateGroupBySenderSetting()` overwrites any legacy stored `true` with `false` on startup and every new scan/rescan.

9. **Messenger Split-Row Reply Grouping & Shared Exporter Architecture (Step 8)**:
   - **Why Messenger Previously Emitted Two Blocks for One Reply**:
     - Messenger frequently renders a reply as separate DOM rows (`[reply label + quote preview]` followed by `[reply bubble]`, or 3 separate rows `[label]`, `[quote]`, `[reply]`). `findReplyQuoteInfo()` previously required `>= 2` leaves inside one row to identify a quote container, and `extractMessages()` lacked a 3-row unstyled quote lookahead and opposite-side peek, turning the quote row into its own standalone message while leaving the reply bubble unquoted.
   - **Single Normalized `replyTo` Pipeline & Shared `renderMessageBlock`**:
     - `parseReplyLabel()` in `content/selectors.js` extracts `{ isReply, replierName, replierIsMe, quotedSender, senderIsMe, isSelfReply, unparsed }` across supported locales (with NFC normalization for Bengali).
     - `MessengerAdapter` attaches `pendingReply` only to the FIRST matching-side reply bubble (absorbs `standalone_quote_preview` and unstyled 3-row quotes, peeks up to 3 messages across opposite-side interruptions, flushes true orphans as `"(reply content not captured)"` with `incomplete: true`, and preserves full 1-to-1 `chatName` via `isParticipantOrAvatarNameOnly()`).
     - Both `WhatsAppAdapter.extractQuote()` and `MessengerAdapter` output normalized `{ sender, text, type, mediaType, senderIsMe }` objects refined identically by `prepareMessagesForExport()` and rendered by ONE shared `renderMessageBlock(block, ctx)` in `lib/exporter-docx.js` and `lib/exporter-txt.js`.

10. **Icon-Only Messenger Messages, Unique Audit Counters & Pruned DOM Skeletons (Step 9)**:
   - **Why Thumbs-Up Like Messages Were Flagged `unrecognizedCount = 36` & Lost**:
     - Messenger renders thumbs-up Likes as icon-only `[role="row"]` bubbles (`<div role="img" aria-label="Like, thumbs up"><svg><title>Thumbs up sign</title><path d="..."/></svg></div>`) with no visible text nodes. `enumerateCandidateRows()` skipped icon-only rows lacking text/`<img>`/`<video>`, and `classifyRow()` classified remaining `<svg>`/`role="img"` rows without text as `UNRECOGNIZED` while emitting repeat snapshots as new sightings.
     - Fixed by enumerating `svg, canvas, [role="img"], [title]`, excluding SVG `<title>` nodes from plain message text (`getNodeTextExcludingSvg()`), adding `extractIconOnlyInfo()` (`like`, `sticker`, `gif`, emoji-only `<img>`, and labeled `[data-scope="message_content"]` `other` bubbles), and exempting `isEmojiImage()` from `isAvatarImage()` so `<=48px` square emoji `<img>` rows are not filtered as contact avatars.
     - `type: 'like'` renders `"👍"` across `.docx`, `.txt`, `.pdf`, and preview regardless of `showMediaLabels` (appending muted italic `"Like"` when `showMediaLabels` is ON).
   - **Unique Item Counting vs Sightings Across Overlapping Snapshots**:
     - `MessengerAdapter` now keys DOM row elements via a `WeakMap` (`rowElementIds`) plus structural/neighbor signatures (`getRowUniqueKey()`) so a row seen across 12 overlapping scroll snapshots increments `sightings` (`rowSightings`, `separatorSightings`, `unrecognizedSightings`, etc.) while counting `uniqueRowsSeen`, `uniqueSeparators`, `uniqueSystemRows`, `uniqueReplyLabels`, `uniqueNoiseRows`, `uniqueUnrecognized`, `resolvedWeekdays`, and `rejectedSeparators` only once per unique DOM item.
     - Kept `domId` strictly `null` unless a real `data-id`/`data-message-id`/row `id` exists so consecutive identical Likes remain distinct in `mergeSnapshot()` across overlapping snapshots.
   - **Pruned DOM Skeletons & Debug Report Redaction**:
     - Replaced truncated 2,000-char `outerHTML` with `buildPrunedDomSkeleton(el, { maxChars: 800, includeSampleText })`, which removes `class`, `style`, and SVG `<path d="...">` coordinates, collapses unattributed single-child wrapper elements, keeps structural tags/`role`/`aria-label`/`title`/`alt`/`data-*` names/`<svg><title>`, and replaces text nodes with `[text]` unless `includeSampleText === true`.
     - `buildDebugReport(false)` omits `text`, `textPreview`, `prevMessageText`, and `nextMessageText` completely and ships redacted skeletons.

11. **Smart Verification, `WeakMap` Parse Cache & Isolated Verifying Phase UI (Step 10)**:
   - **Smart Pass 2 Decision & Ambiguity Resolutions (Safest Options)**:
     - Any Pass 1 `gapEvents` entry (`gapEvents.length > 0`, even when half-step backtracking subsequently recovered overlap) as well as unrecovered gaps (`noOverlapEventsCount > 0`), unique `UNRECOGNIZED` rows, orphan replies, post-Pass-1 `resolveDirection()` `lowConfidence` warnings (covering chats under 200 messages too), out-of-order timestamps (`countReadingOrderDateViolations()`), or Pass 1 step errors triggers Smart Verification automatically.
     - WhatsApp keeps its existing single-pass behavior (`verificationRan === false` by default) unless `verifyPass: true` or `thoroughVerify: true` (`"Thorough scan (always verify)"`, persisted under `chatflow_thorough_scan`, default OFF) is enabled.
   - **Per-Element `WeakMap` Parse Cache (`content/adapters/messenger.js`)**:
     - `rowParseCache` caches `{ stamp, cls, contentSig, dateFloorMs, pendingSig, parsedMsg, parsedPendingSig }` keyed by live DOM row element. The structural/text/media stamp detects in-place DOM mutations, while `resetVerificationPassState()` clears sweep cursors and `rowParseCache` right before Pass 2 without erasing Pass 1 audit totals (`auditStats`, `auditUnique`, `rowElementIds`).
     - Overlapping rows still increment `sightings` counters while calling `classifyRow()` once (`classifyCallsCount === uniqueRowsSeen`) and tracking unique `exportedMessages` in `auditUnique.exportedMessages` (`Set`) so `uniqueRowsSeen` and `messagesExported` never double-count.
   - **Verifying Phase Isolation**:
     - `_runVerificationPass` freezes `fixedReadCount = masterList.length` before reconciliation and emits `phase: 'verifying'` progress events so `#verify-progress-box` / `#verifying-bar` (0–100%), `#step-2 .step-label`, and `#scan-title` switch to `"Verifying"` without modifying `#scan-count` or `#scan-count-label`.

12. **Single-Source Versioning, Update Flow & Content-Script Handshake (Step 11 — v2.5.0)**:
   - **Single Source of Truth (`manifest.json` -> `scripts/version-manager.js` -> `src/version.js`)**:
     - `manifest.json` `"version"` (`"2.5.0"`, matched by `"version_name"`) is the only manually edited version string; `npm run version:sync` / `release:*` regenerates `src/version.js` (with `APP_VERSION`, `RELEASE_HIGHLIGHTS`, and structured `CHANGELOG_SUMMARY` parsed from `CHANGELOG.md`) and syncs `package.json` + `README.md`.
     - `npm run version:check` fails if `package.json`, `src/version.js`, `README.md`, or `CHANGELOG.md` diverge from `manifest.json`, or if runtime files (`background/`, `content/`, `lib/` excluding `vendor`, `sidepanel/`) contain hard-coded version strings (requiring historical migration steps to use named IDs like `'normalize-settings-and-prune-legacy'` and reading current version from `src/version.js` / `chrome.runtime.getManifest().version`).
   - **`.docx` & Export Metadata (`lib/exporter-docx.js`, `lib/exporter-txt.js`, `lib/exporter-pdf.js`)**:
     - `buildDocxDocument` sets `creator`, `lastModifiedBy`, `description`, `customProperties: [{ name: 'ChatFlowVersion', value: extVersion }]`, and `doc.AppProperties.root` (`new docxLib.StringContainer('Application', 'ChatFlow v' + extVersion)`). Note `buildDocxDocument(messages, stats, options, onProgress, docxLibOverride)` is `async` and returns `{ doc, Packer, total, fallbackToCompact }`.
   - **Post-Update Card, Migrations & Tab Version Handshake**:
     - `handleInstalled({ reason: 'update', previousVersion })` runs `runVersionMigrations()` (idempotent, never throws, preserves names/preferences, clears `isBlockedUiName` values, enforces `chatflow_group_by_sender = false`, removes `OBSOLETE_STORAGE_KEYS`) and records `chatflow_update_notice` only on extension update (never fresh install), so `#whats-new-card` renders once until dismissed.
     - `verifyContentScriptVersion()` checks `PING.version === getExtensionVersion()` before history load, scan, reading, and verification; `setState(AppState.ERROR)` keeps `data.versionMismatch` message (`getVersionMismatchMessage()`) intact while revealing `#btn-reload-tab`.



