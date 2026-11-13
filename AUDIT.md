# ChatFlow Extension Audit Report (`AUDIT.md`)

Generated during Handoff Step 1 (Audit Only) before making any code modifications.
Backup created at: `..\chatflow-backup-before-argon`.

---

## 1. Project Integrity & Health Checks

### 1.1 `manifest.json` Validation
- **Valid JSON**: Yes (`manifest_version: 3`, `version: "2.3.0"`, `default_locale: "en"`).
- **Match Patterns**: Valid MV3 patterns (`https://web.whatsapp.com/*`, `https://www.messenger.com/*`, `https://www.facebook.com/messages/*`).
- **Referenced Files**: Every referenced script, HTML page, and icon file exists on disk:
  - `background/service-worker.js`
  - `sidepanel/index.html`
  - `content/content-script.js`, `content/scanner.js`, `content/direction.js`, `content/selectors.js`, `content/adapters/*` (`index.js`, `base.js`, `whatsapp.js`, `messenger.js`)
  - `icons/icon{16,32,48,128}.png`, `icons/{whatsapp,messenger,neutral}/icon{16,32,48,128}.png`

### 1.2 JavaScript Syntax Check (`node --check`)
- **Checked**: 32 `.js` files across `background/`, `content/`, `lib/`, `sidepanel/`, and `scratch/`.
- **Syntax Errors**: **0 files with syntax errors** (all 32 files pass `node --check`).

### 1.3 Search for Half-Finished Work & Mismatches
- **`TODO` / `FIXME` / `"not implemented"` markers**: Only the intentional abstract base class methods in `content/adapters/base.js` (`detect() not implemented`, `getChatName() not implemented`, etc.).
- **Interrupted Edit / Out-of-Sync Files Found**:
  1. **`sidepanel/index.html` vs `sidepanel/sidepanel.js`**:
     - `sidepanel/index.html` was updated to the new 3-step stepper (`#scan-stepper`, `#step-1`, `#step-2`, `#step-3`), 4 phase views (`#view-loading`, `#view-ready`, `#view-reading`, `#view-preparing`), `#complete-card`, `#direction-backdrop` ("Confirm who is who" modal), and new Settings controls (`#setting-auto-start`, `#btn-swap-settings`, `#btn-tips-reset`, `#diag-direction-log`).
     - However, `sidepanel/sidepanel.js` still calls `START_SCAN` (removed from `content/content-script.js` in favor of `LOAD_HISTORY` + `START_READING`) and references old DOM IDs (`#btn-scan-from-here`, `#scan-status`) that were replaced in `sidepanel/index.html`.
  2. **`sidepanel/index.html` vs `sidepanel/css/components.css`**:
     - New CSS classes used in `sidepanel/index.html` (`.stepper`, `.step`, `.scan-view`, `.indeterminate-track`, `.state-badge`, `.floating-tip`, `.complete-card`, `.health-list`, `.direction-status`, `.dir-dialog`, `.dir-columns`, `.you-badge`, `.sr-only`, `@media (prefers-reduced-motion: reduce)`) are not yet defined in `sidepanel/css/components.css`.
  3. **`_locales/*/messages.json`**:
     - Several new `data-i18n` keys added in `sidepanel/index.html` (`stepLoad`, `stepRead`, `stepPrepare`, `stallHint`, `btnStopLoading`, `btnStartScan`, `btnLoadMore`, `tipNever`, `liveDirectionNote`, `preparingLine`, `participantsTitle`, `btnConfirmWho`, `btnSwapSides`, `scanComplete`, `totalMessages`, `dateRange`, `scanHealth`, `btnRescan`, `confirmTitle`, `confirmDesc`, `leftSide`, `rightSide`, `btnLeftIsMe`, `btnRightIsMe`, `btnLater`, `autoStartLabel`, `autoStartNote`, `tipResetLabel`, `tipResetBtn`, `diagnosticsTitle`) need to be added to `_locales/*/messages.json`.
  4. **Scratch assembly artifacts**:
     - Temporary files from the interrupted turn (`scratch/assemble_scanner.js`, `scratch/splice_html.js`, `scratch/scanner_*.txt`, `scratch/html_*.txt`) are still in `scratch/` and should be cleaned up once repairs are complete.

### 1.4 Existing Unit Test Results
- `node scratch/test_all.js`: **39 / 39 passed** (0 failed)
- `node scratch/test_part1_to_4.js`: **14 / 14 passed** (0 failed)
- `node scratch/test_direction.js`: **23 / 23 passed** (0 failed)

---

## 2. Requirements Audit Table

*(Note: Part 6 overrides Part 2 where they conflict, specifically around stopping in the passive "Ready to scan" state after Phase 1 instead of auto-starting Phase 2).*

### Part 1: Separate My Messages from the Contact's (Items 1–8)

| Item | Requirement | Status | File & Function |
| :--- | :--- | :--- | :--- |
| **1.1** | Store `isMe` (boolean) and `senderRaw` on every message; compute display names only at the end from `isMe`. | **Done** | `content/adapters/whatsapp.js` (`parseMessageRow`, `extractMessages`), `content/adapters/messenger.js` (`extractMessages`), `content/direction.js` (`finalizeSenders`) |
| **1.2** | Multi-signal `isMe` detection (a: class/attr, b: geometry relative to pane, c: outgoing delivery ticks, d: 2-cluster bubble background color, e: `data-pre-plain-text` name, f: ignore reply-quote labels) combined by majority vote with confidence. | **Done** | `content/direction.js` (`geometryVote`, `nameVote`, `buildColorModel`, `colorVote`, `combineVotes`, `resolveDirection`), `content/adapters/whatsapp.js` (`collectDirectionVotes`, `findBubble`, `getBubbleColor`) |
| **1.3** | Self-check at end of Phase 2 and live every 200 messages: in 1-to-1 chat with 50+ messages, if one side has 0 or >98%, flag `LOW CONFIDENCE` and try alternative signal combinations automatically; log disagreements. | **Done** | `content/direction.js` (`evaluateConfidence`, `signalAgreement`, `resolveDirection`, `quickDirectionCheck`), `content/scanner.js` (`ScanSession.startReading`, `ScanSession._finalize`) |
| **1.4** | "Confirm who is who" dialog when confidence is low: two columns with 3 sample bubbles (text + time) per side, "Left side is me" / "Right side is me" + "Swap sides" buttons; applies in memory without rescanning. | **Partial** | Helpers & HTML Done in `content/direction.js` (`sampleSides`, `applySideChoice`) and `sidepanel/index.html` (`#direction-backdrop`); UI controller wiring & CSS missing in `sidepanel/sidepanel.js` and `sidepanel/css/components.css`. |
| **1.5** | "Swap sides" action in Settings and Participants tab + "My name in exports" (default: detected profile name, never "You" or time); remember choice per chat in `chrome.storage.local` (names/flags only, no message text). | **Partial** | Helpers Done in `content/direction.js` (`swapSides`, `pickMyName`, `finalizeSenders`) and buttons in `sidepanel/index.html` (`#btn-swap-participants`, `#btn-swap-settings`); event wiring & `chrome.storage.local` per-chat persistence missing in `sidepanel/sidepanel.js`. |
| **1.6** | One-to-one chat ends with exactly 2 participants (`isMe=true` and contact); `sanitizeSenderName` strips colons, rejects times, maps localized "You", and never overrides direction. | **Done** | `content/direction.js` (`finalizeSenders`, `pickMyName`), `content/selectors.js` (`sanitizeSenderName`, `isTimeOrDateString`, `isLocalizedYou`) |
| **1.7** | Participants tab redesign: 2 rows with avatar, name, "You" badge on my row, count, share %, flat colored progress bar, fixed color for me vs contact shared across overview/preview/docx, and tiny "Direction check passed" or amber warning with "Confirm who is who" button. | **Partial** | HTML markup in `sidepanel/index.html` (`#tab-participants`, `#direction-status`); `renderParticipantsTab` in `sidepanel/sidepanel.js` and `.you-badge`/`.direction-status` CSS in `sidepanel/css/components.css` need updating. |
| **1.8** | Group chats: keep real member names per bubble (sanitized, case/space-merged) and still mark my messages with `isMe=true` and map to my display name. | **Done** | `content/direction.js` (`finalizeSenders`) |

### Part 2: Two-Phase Scan Engine & Counter Rules (Items 1–5, with Part 6 Overrides)

| Item | Requirement | Status | File & Function |
| :--- | :--- | :--- | :--- |
| **2.1** | Phase 1 ("Loading chat history"): scroll UP to load history; do NOT show or increment a message counter; show title, live oldest loaded date, elapsed time, and indeterminate progress bar. | **Partial** | Engine Done in `content/scanner.js` (`ScanSession.loadHistory`) and HTML in `sidepanel/index.html` (`#view-loading`); controller wiring in `sidepanel/sidepanel.js` needs update from `START_SCAN` to `LOAD_HISTORY`. |
| **2.2** | Phase 1 stop conditions: encryption/intro banner, `scrollHeight` & top message unchanged for 3 checks, user clicks "Stop loading", or 10s stall prompt ("Older messages are taking a while..."). Transitions to "Ready to scan" (per Part 6 override). | **Partial** | Engine Done in `content/scanner.js` (`ScanSession.loadHistory`, `ScanSession.stopLoading`); stall timer & `#btn-stop-loading` wiring in `sidepanel/sidepanel.js` need update. |
| **2.3** | Phase 2 ("Reading messages"): scroll TOP to BOTTOM once; message counter starts at 0 at start of Phase 2 and only increases monotonically; show determinate progress bar (`0-100%`), `Messages read: X`, current date, and speed/ETA. | **Partial** | Engine Done in `content/scanner.js` (`ScanSession.startReading`) and HTML in `sidepanel/index.html` (`#view-reading`); UI update handler in `sidepanel/sidepanel.js` needs wiring. |
| **2.4** | Phase 3 ("Preparing your results"): deduplicate, run direction voting + self-check, compute stats; final message count on completion screen equals last Phase 2 counter and exported count. | **Done** | `content/scanner.js` (`ScanSession._finalize`, `ScanSession.startReading`) |
| **2.5** | Edge cases: partial history banner ("Partial export: starts from <date>"), cancel discards all state cleanly, chat switch or tab reload resets cleanly, long chats (>10k) yield every 50 rows. | **Partial** | Engine Done in `content/scanner.js` (`ScanSession.cancel`, `ScanSession.startReading`) and `content/content-script.js` (`notifyChatChange`, `discardSession`); `sidepanel/sidepanel.js` needs session state sync. |

### Part 6: Manual Start After History Loads & Floating Tip (Items 1–6)

| Item | Requirement | Status | File & Function |
| :--- | :--- | :--- | :--- |
| **6.1** | Never auto-start Phase 2 when Phase 1 ends; enter passive "Ready to scan" state (`MutationObserver` watches for manual scroll-up and updates `oldestDate` and `beginningReached` live without scrolling or counting). | **Done** | `content/scanner.js` (`ScanSession.loadHistory`, `ScanSession.startWatching`, `ScanSession.readySnapshot`), `content/content-script.js` (`handleLoadHistory`, `handleStartReading`) |
| **6.2** | "Ready to scan" card in side panel: green check badge ("Beginning of chat reached — ready to scan from <date>") or amber dot badge ("Loaded back to <date> — scroll up in the chat to load older messages, or start from here"), plus "Start scan" (primary), "Load more history" (secondary), and "Cancel" (text link). | **Partial** | HTML Done in `sidepanel/index.html` (`#view-ready`, `#ready-badge`, `#btn-start-scan`, `#btn-load-more`, `#btn-ready-cancel`); controller & CSS missing in `sidepanel/sidepanel.js` and `sidepanel/css/components.css`. |
| **6.3** | Floating tip bubble above "Start scan" button: platform-specific text (WhatsApp phone tip / Messenger scroll tip / full history tip), dismissible via `×` or `Esc`, "Don't show again" link saved in `chrome.storage.local` + reset in Settings; hides when clicking "Start scan". | **Partial** | HTML Done in `sidepanel/index.html` (`#ready-tip`, `#btn-tip-never`, `#btn-tip-close`, `#btn-tips-reset`); logic & CSS missing in `sidepanel/sidepanel.js` and `sidepanel/css/components.css`. |
| **6.4** | "Start scan" transition: stops passive observer, scrolls cleanly to top (`scrollTop = 0`), switches to Phase 2 ("Reading messages"), starts counter at `0`, progresses `0% -> 100%`. | **Partial** | Engine Done in `content/scanner.js` (`ScanSession.startReading`); `#btn-start-scan` click handler in `sidepanel/sidepanel.js` needs wiring. |
| **6.5** | Setting in Settings: "Start reading automatically when the full history is loaded" (default OFF); when ON and `beginningReached === true`, starts Phase 2 automatically; when partial/stalled, still stops in "Ready to scan". | **Partial** | Checkbox in `sidepanel/index.html` (`#setting-auto-start`); storage & auto-start logic missing in `sidepanel/sidepanel.js`. |
| **6.6** | State machine & safety: `Idle -> LoadingHistory -> ReadyToScan -> ReadingMessages -> PreparingResults -> Complete`; only one phase active at a time; "Start scan" disabled once clicked; chat switch in "Ready to scan" resets to Idle. | **Partial** | Backend state machine Done in `content/scanner.js` (`ScanSession`) and `content/content-script.js`; UI state machine in `sidepanel/sidepanel.js` needs wiring. |

### Part 3: Professional Scan UI, Stepper & Completion Screen (Items 1–7)

| Item | Requirement | Status | File & Function |
| :--- | :--- | :--- | :--- |
| **3.1** | 3-step horizontal stepper at top of scan view (`1. Load history -> 2. Read messages -> 3. Prepare report`) with completed green check, active accent pill, and upcoming muted circle. | **Partial** | HTML in `sidepanel/index.html` (`#scan-stepper`); CSS & state updates missing in `sidepanel/css/components.css` and `sidepanel/sidepanel.js`. |
| **3.2** | Phase-specific scanning card (Phase 1: no counter, oldest date + elapsed + indeterminate bar; Ready: state badge + Start scan / Load more / Cancel + floating tip; Phase 2: big tabular-nums counter + determinate bar + date + speed/ETA; Phase 3: compact spinner). | **Partial** | HTML in `sidepanel/index.html`; CSS & controller updates missing in `sidepanel/css/components.css` and `sidepanel/sidepanel.js`. |
| **3.3** | Completion screen with Scan Health checklist: total messages, date range, 2-row participant summary with "You" badge & fixed colors, and 4 health items (Direction check, Date check, Completeness check, Duplicate check) that expand a 1-sentence explanation on click, plus primary "Download .docx", secondary "Download .txt", and "Rescan". | **Partial** | HTML in `sidepanel/index.html` (`#complete-card`, `#health-list`); rendering & click handlers missing in `sidepanel/sidepanel.js` and `sidepanel/css/components.css`. |
| **3.4** | Calm, flat visual design: flat cards with `1px` border, `8px` radius, tabular-nums, max 2 type sizes per card, light/dark theme support, WhatsApp (`#25D366`) and Messenger (`#0084FF`) accents. | **Partial** | Tokens exist in `sidepanel/css/tokens.css`; new component styles needed in `sidepanel/css/components.css`. |
| **3.5** | Accessibility: `aria-live="polite"` on phase title, `role="progressbar"` with `aria-valuenow/min/max`, keyboard navigation (`Enter`/`Space`, `Esc` closes dialog/tip), `@media (prefers-reduced-motion: reduce)`. | **Partial** | ARIA attributes in `sidepanel/index.html`; focus management, `Esc` listener, and reduced-motion CSS needed in `sidepanel/sidepanel.js` and `sidepanel/css/components.css`. |
| **3.6** | Localization (`_locales/*`): all new strings in `_locales/en/messages.json` and localized across all 11 locale files (`en`, `bn`, `es`, `pt_BR`, `fr`, `de`, `hi`, `ar`, `id`, `tr`, `ru`). | **Partial** | Base locales exist; new v2.4 scan/direction keys need to be generated into `_locales/*/messages.json`. |
| **3.7** | Privacy & diagnostics: "Copy diagnostics" copies signal agreement, confidence, counts, and health check results with zero message text; Settings > Diagnostics shows direction signal agreement and tried combinations. | **Partial** | `handleReportProblem` exists in `sidepanel/sidepanel.js` and `#diag-direction-log` exists in `sidepanel/index.html`; needs direction signal agreement fields wired up. |

### Part 4: `.docx` Export Verification

| Item | Requirement | Status | File & Function |
| :--- | :--- | :--- | :--- |
| **4.1** | `.docx` shows both people with their own names and fixed colors (matching overview chart, participants tab, and export preview), with `isMe` messages visually separated (right-indented / green tint) and contact messages left-aligned / gray tint, and 2 participants on the summary page in 1-to-1 chats. | **Partial** | Layout & bubble separation Done in `lib/exporter-docx.js` (`exportDocx`) and `lib/transcript.js` (`groupMessagesForExport`); `computeParticipantStats` in `lib/transcript.js` currently assigns colors by message-count rank instead of pinning `PARTICIPANT_COLORS[0]` to `isMe=true` and `PARTICIPANT_COLORS[1]` to contact. |

