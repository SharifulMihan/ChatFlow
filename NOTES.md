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


