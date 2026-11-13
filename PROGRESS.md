# ChatFlow Build Progress (`PROGRESS.md`)

## Done (100% Complete — v2.4.0)
- **Step 0 (Backup)**: Backed up project to `..\chatflow-backup-before-argon`.
- **Step 1 (Audit)**: Completed full audit in `AUDIT.md` (manifest check, syntax check of all 30 JS files, unit tests passed).
- **Step 2 (Repair)**:
  - Restored backwards-compatible `startScan` in `content/scanner.js` and `START_SCAN` in `content/content-script.js`.
  - Cleaned up temporary scratch fragments (`scratch/assemble_scanner.js`, `scratch/splice_html.js`, `scratch/scanner_*.txt`, `scratch/html_*.txt`).
  - Verified all 142 DOM IDs queried in `sidepanel/sidepanel.js` exist in `sidepanel/index.html` (`0` missing).
- **Step 3.1 (Part 1 — Separate My Messages from Contact's)**:
  - Multi-signal direction voting engine (`content/direction.js`) with container class, geometry, outgoing ticks, 2-cluster bubble background color, and `data-pre-plain-text` name signals; ignores reply-quote labels.
  - Self-check at end of Phase 2 and live every 200 messages (`evaluateConfidence`, `quickDirectionCheck`, `resolveDirection`).
  - "Confirm who is who" modal (`#direction-backdrop`) with 2 columns of 3 sample bubbles, "Left side is me" / "Right side is me" / "Swap sides" buttons applying in memory without rescanning.
  - "Swap sides" in Participants tab and Settings + per-chat persistence in `chrome.storage.local` (names/flags only, zero message text).
  - Redesigned Participants tab with avatar, name, `"You"` badge on my row, count, share %, fixed colors (`#2DB87A` / `#1B5E3F` for me, `#3B82F6` / `#1D4ED8` for contact), and direction check status line.
- **Step 3.2 (Part 2 & Part 6 — Two-Phase Scan Engine & Manual Start)**:
  - Phase 1 (`LOAD_HISTORY`) scrolls up to load history without showing or incrementing a message counter; shows live oldest loaded date, elapsed time, and 10s stall hint + highlighted "Stop loading" button.
  - Passive `"Ready to scan"` state (`#view-ready`) with `MutationObserver` watching for manual scroll-up (`startWatching`), green check ("Full history loaded") or amber dot ("Partial history") badge, "Start scan" / "Load more history" / "Cancel" buttons, floating tip (`#ready-tip`) with "Don't show again", and optional auto-start setting (`#setting-auto-start`, default OFF, only when `beginningReached === true`).
  - Phase 2 (`START_READING`) scrolls downward once from the top, starting the counter at `0` and increasing monotonically with `0-100%` progress bar, current date, speed (`msgs/s`) & ETA.
- **Step 3.3 (Part 3 — Stepper, Completion Card & Localization)**:
  - 3-step horizontal stepper (`1. Load history -> 2. Read messages -> 3. Prepare export`).
  - Completion card (`#complete-card`) with total messages, date range, 2-row participant summary, split bar, and clickable 4-item Scan Health checklist (Direction, Date, Completeness, Duplicate).
  - Updated all 11 locale files (`_locales/{en,bn,es,pt_BR,fr,de,hi,ar,id,tr,ru}/messages.json`).
- **Step 3.4 (Part 4 — `.docx` Fixed Colors & Separation)**:
  - Pinned `isMe=true` to `#1B5E3F` (soft green bubble shading `#E8F5EE`, right-indented) and contact to `#1D4ED8` (soft gray bubble shading `#F3F4F6`, left-aligned) in `lib/transcript.js` and `lib/exporter-docx.js`.
- **Step 3.5 (Unit Tests)**:
  - `node scratch/test_all.js`: **39 / 39 passed**
  - `node scratch/test_part1_to_4.js`: **14 / 14 passed**
  - `node scratch/test_direction.js`: **26 / 26 passed** (including Bug 1 & Bug 2 regression tests)
- **Step 4 (Bug Report Fixes — `comboUsed.join` & `"Stop loading"` Cancellation)**:
  - **Bug 1 (`(dir.comboUsed || []).join is not a function`)**:
    - Fixed `resolveDirection()` in `content/direction.js` so `comboUsed` is **always** an array of strings (and added `toList()` + `formatDirectionDiagnostics()`).
    - Wrapped direction self-checks, scan health report, and diagnostics logging in `try / catch` in `content/scanner.js` and `sidepanel/sidepanel.js` so diagnostic errors are non-fatal, log to Settings > Diagnostics, and add an amber `"Some checks could not run"` note instead of aborting the scan.
    - Hardened `.join()`, `.map()`, and `.forEach()` calls across `sidepanel/sidepanel.js`, `content/scanner.js`, `lib/exporter-docx.js`, `lib/exporter-txt.js`, and `lib/exporter-pdf.js` with `toList()` / `Array.isArray()`.
  - **Bug 2 (`"Stop loading"` hangs on `"Stopping..."`)**:
    - Added per-phase `AbortController` (`resetPhaseSignal()`) and `abortableSleep(ms, signal, ctrl)` in `content/scanner.js`, and wired `waitForMutations`, `waitForDomQuiet`, `WhatsAppAdapter.scrollToLoadOlder`, and `MessengerAdapter.scrollToLoadOlder` to abort immediately on `ctrl.signal`.
    - Updated `ScanSession.stopLoading()` and `content/content-script.js` (`STOP_LOADING`) to abort Phase 1 immediately, transition to passive `"Ready to scan"` (`_enterReady()`), and reply with `{ ok: true, status: "phase1_stopped", state: "ready", ... }`.
    - Updated `sidepanel/sidepanel.js` to transition to Ready on `STOP_LOADING` reply or `SCAN_PROGRESS` (`phase === 'ready'`), added a 2-second watchdog (`STOP_WATCHDOG_MS = 2000`) that forces the Ready screen and retries `STOP_LOADING` up to 3 times if no ack arrives, and added a `"Reload tab"` button (`#btn-reload-tab`) when connection to the chat page is lost.
- **Step 5 (Messenger Scan Completeness, Classification, Audit & Export Fixes — Parts 1–7)**:
  - Broadened Messenger row enumeration (`enumerateCandidateRows`) and added mandatory `classifyRow()` returning `message | separator | system | reply-label | ui-noise | UNRECOGNIZED`; captured trimmed `outerHTML` (<=2,000 chars) and emitted `[Unrecognized message]` whenever an `UNRECOGNIZED` row has visible content.
  - Fixed reply quote vs bubble isolation (video/image thumbnails in quotes stay in `replyTo`), avatar/forwarded/`"Reactions:"`/duration chip filtering, hover timestamp exclusion, per-snapshot `localDateCursor = null`, weekday resolution relative to scan date (`baseSessionDate`), and non-decreasing chronological validation (`dateOrderViolations`, never re-sorting).
  - Implemented `40%` Pass 1 step with half-step gap backtracking + `30%` half-offset Pass 2 verification (`reconcileVerificationPass`), Coverage Audit panel & `Settings > Diagnostics` UI, amber `"Scan may be incomplete"` card state, and `"Copy debug report"` JSON export (`Include sample text` OFF by default).
  - Fixed 5-minute sender grouping in `lib/transcript.js`, unique TOC month headings and gray-italic `[Unrecognized message]` rendering + summary count across `.docx`, `.txt`, and PDF exports.
  - Added Messenger HTML/DOM fixtures (`fixtures/messenger_samples.js`) and regression suite (`scratch/test_messenger_bugreport.js`).

## In Progress
- None (all tasks completed).

## Next
- Ready for manual verification in Chrome (`chrome://extensions` -> Reload ChatFlow).
