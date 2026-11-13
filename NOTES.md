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


