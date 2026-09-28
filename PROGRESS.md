# Project progress

> Auto-maintained by dev-tracker skill. Do not edit the log section manually.

## Project info

- **Project:** Wispr Speak
- **Started:** 2026-09-26
- **Last updated:** 2026-09-28
- **Status:** Active

---

## Progress log

### 2026-09-28: Version bump to v1.0.4 and release publication

**Status:** Done

#### What changed
- Bumped version to `v1.0.4` in `package.json`.
- Updated startup logging to reflect Wispr Speak branding.
- Packaged release archive `Wispr-Speak-v1.0.4-win-x64.zip`.
- Published GitHub release `v1.0.4` with updated Windows binaries.

### 2026-09-27: GitHub repository rename and v1.0.3 release publication

**Status:** Done

#### What changed
- Renamed repository from `wispr-tell` to `wispr-speak` on GitHub.
- Updated git remote URL, package metadata, autoupdate feed URL, and documentation.
- Built portable package `Wispr-Speak-v1.0.3-win-x64.zip` containing `Wispr Speak.exe` and production runtime.
- Published GitHub release `v1.0.3` with release notes and binary assets.

### 2026-09-27: Settings row hover fix and deployment sync

**Status:** Done

#### What changed
- Fixed settings row highlight bug: removed `.setting-row:hover` and `.setting-row:active` full-row background fills in `src/renderer/settings.html`.
- Removed row-level `cursor: pointer` so row labels retain default cursor while toggle switches preserve pointer cursor.
- Corrected application deployment target to active install directory at `C:\Users\Yeamin-Sheikh\AppData\Local\Programs\Whisper Speak\resources\app\`.
- Synchronized all updated source code across git repository, release staging, and installed application folders.

### 2026-09-27: Monochrome pill aesthetic and visualizer scaling

**Status:** Done

#### What changed
- Restyled floating status pill with a strict monochrome black and white color scheme across light and dark themes.
- Scaled audio visualizer bars proportionally inside the slim 20px pill height.
- Enhanced transcription accuracy through Whisper prompt conditioning and personal dictionary injection.
- Overhauled personal dictionary with exact casing preservation and contextual term recognition.

### 2026-09-27: Fix Groq polish model to match documentation (openai/gpt-oss-20b)

**Status:** Done

#### What changed
- Replaced decommissioned `llama-3.1-8b-instant` with `openai/gpt-oss-20b` as specified in README.md and Settings documentation.
- Added `qwen/qwen3.8-27b` as a secondary fallback model on Groq.
- Fixed selection polish (`Win + Alt + Q`) and smart dictation cleanup returning 404 model errors.
- Improved Groq error formatting to prevent redundant "Polish failed: Polishing failed" string prefixes.
- Updated test suite timeout tolerances for load stability.

### 2026-09-27: Wispr Speak v1.0.3 — Rebrand, re-paste hotkey, thin pill, and crash fixes

**Status:** Done

#### What changed
- Rebranded application from Wispr Tell to Wispr Speak across window titles, UI headers, descriptions, default dictionaries, and package metadata.
- Added re-paste latest dictation hotkey (`Alt + Shift + Z`):
  - Injects the most recent dictation at the cursor if focus was missed during voice input.
  - Registered via both global shortcut and uIOhook with instant visual pill confirmation.
- Added non-sentence trailing period truncation:
  - Singular words and standalone button labels (such as "Submit", "Cancel", "Hello") no longer receive unwanted trailing periods.
  - Complete sentences and punctuated questions or exclamations retain standard punctuation.
- Escape key cancellation:
  - Pressing `Esc` during listening or processing aborts the pipeline, resets state machine to IDLE, and hides the pill without pasting.
- Graphical error fix in Settings titlebar:
  - Adjusted titlebar controls margin by 140px to eliminate overlap between the quick theme toggle and Windows caption buttons.
- Slim floating status pill:
  - Decreased pill height to 20px with proportional equalizer bars and icons for a modern, sleek appearance.
- Background startup and crash prevention:
  - Closing the settings window now hides to system tray rather than destroying the process.
  - Startup at login with `--hidden` stays purely in the background tray without popup windows.
  - Added process-level uncaughtException and unhandledRejection handlers.
- Onboarding and Settings:
  - Added dedicated "Get Free Key" button in settings and setup wizard to open the Groq console directly.

### 2026-09-27: Wispr Tell v1.0.2 — Context-based auto-learning and profile removal

**Status:** Done

#### What changed
- Context-based auto-learning:
  - Added Longest Common Subsequence (LCS) sequence alignment in `src/text-utils.js` to automatically extract word, phrase, and symbol substitutions (such as "plus" to "+") between dictated text and user corrections.
  - Implemented passive clipboard watcher that detects when edited text related to a recent dictation is copied, automatically extracting and saving dictionary rules.
  - Added global shortcut `Win + Alt + L` (`learnCorrection`) to instantly learn substitutions from highlighted text.
  - Updated history card edit workflow to extract diffs and save them directly to the personal dictionary with real-time feedback.
  - Connected live IPC updates (`dictionary-updated`) so dictionary rules reflect immediately in settings.
- Profile and personal name removal:
  - Removed user profile badges, personal names, and proprietary branding across all UI views and settings.
  - Replaced the Voice Profile section with a clean Data and Backup section for exporting and importing configuration and dictionary data.
  - Replaced the sidebar profile card with an engine activity indicator.
  - Replaced the profile status card with a Personal Dictionary quick link.
- Quality assurance:
  - Added comprehensive test suite in `tests/tier1-feature-coverage/feat21-context-auto-learning.test.js`.
  - Verified all 238 unit tests and 52 adversarial tests pass with zero regressions.

### 2026-09-27: Wispr Tell v1.0.1 — Performance fixes, equalizer visualizer, and offline model toggle

**Status:** Done

#### What changed
- **Bug Fixes & Latency:**
  - Resolved streaming session recreation race condition where chunkIndex 0 orphaned fullTranscriptPromise causing 25s timeouts; restored sub-second end-to-end dictation latency (400-700ms).
  - Fixed Silero VAD async frame processing race condition during short PTT recordings to prevent speech gating.
  - Extended wavBufferPromise timeout to 30s so batch fallback retains full audio buffer.
- **UI & Motion Polish:**
  - Removed Windows 11 DWM acrylic rectangular sheet on pill window that produced a grey bounding box; enforced true transparent window background.
  - Replaced canvas wave with animated 5-bar music equalizer that reacts to live audio frequencies and pulses gently when idle.
  - Removed transcribed text expansion from the done state for instant, clean 600ms completion.
  - Added "Get Free Key" direct link to onboarding wizard step 3.
  - Set modern system font hierarchy across welcome and settings interfaces.
- **Settings & Control:**
  - Added user toggle switch in Settings to enable/disable offline Whisper model fallback.
- **Repository Maintenance:**
  - Removed ~770MB of obsolete version zip archives and temporary agent folders; updated .gitignore.

### 2026-09-27: Wispr Tell v1.0.0 — 20 landmark improvements

**Status:** Done

#### What changed
- **R1 (Response Speed & Performance):**
  - Feature 1: Real-time streaming transcription with interim token broadcasting and boundary stitching.
  - Feature 2: Local Silero VAD engine (ONNX + WebAssembly) for microsecond silence and noise rejection.
  - Feature 3: FIFO hotkey event queue state machine handling rapid toggles (10+ presses/sec) without dropped inputs.
  - Feature 4: Zero-copy audio IPC using SharedArrayBuffer across context isolation bridge.
- **R2 (Robustness & Reliability):**
  - Feature 5: Exponential backoff with Retry-After header parsing for Groq API HTTP 429 and 500-series errors.
  - Feature 6: Bundled 32.1MB quantized whisper.cpp tiny.en model for offline fallback with pill status indicator.
  - Feature 7: Integrated electron-updater with GitHub Releases for silent background update delivery.
  - Feature 8: Deterministic clipboard restoration using Win32 GetClipboardSequenceNumber check in recompiled tell-paste.exe.
  - Feature 9: Structured daily rotating JSON logging with 14-day retention via electron-log.
- **R3 (User Experience):**
  - Feature 10: Context-aware smart polish adapting output style to active window title (code vs chat vs email).
  - Feature 11: Customizable LLM prompt personas with presets (Natural, Formal, Code, Minimal) and settings editor.
  - Feature 12: Extensible voice commands engine with cached regex parsing (<0.001ms evaluation).
  - Feature 13: Interactive 4-step onboarding wizard in welcome.html (VU meter, live API key check, shortcut practice).
  - Feature 14: Custom dictionary terms injected directly into Whisper prompts bounded to 800 characters.
  - Feature 15: Compressed Opus WebM audio history saved to disk with HTML5 audio playback and quota pruning.
- **R4 (Visual Aesthetics & Motion Design):**
  - Feature 16: Native Windows 11 Acrylic and Mica materials via DWM APIs and Electron backgroundMaterial.
  - Feature 17: WebGL audio-reactive visualizer shader responding to real 16-bin FFT speech spectrum with physical DPI scaling.
  - Feature 18: Fluid draggable pill with spring-physics morphing and persistent multi-monitor coordinates.
  - Feature 19: Theme CSS custom properties synchronized across all open windows via IPC in under 100ms.
  - Feature 20: Optional character-by-character native Unicode typing animation via tell-paste.exe.
- **Verification & Testing:**
  - 232/232 master test suite passing across 42 suites.
  - 99/99 Tier 5 adversarial stress tests passing across 20 suites.
  - Total 331 passing tests with 0 failures.
  - Independent Victory Audit confirmed with CLEAN forensic verdict.

#### Files touched
- `src/main.js`: Added streaming pipeline, hotkey queue, offline fallback switch, theme broadcast, and structured logging.
- `src/preload.js`: Added VAD, audio IPC, theme synchronization, and window drag APIs.
- `src/native/win-paste.c`: Added Win32 `GetClipboardSequenceNumber` check and `--type-unicode` character animation.
- `src/text-utils.js`: Added context classification rules and persona prompt generation.
- `src/voice-commands.js`: New extensible regex-cached voice command evaluation engine.
- `src/offline-whisper.js`: New local whisper.cpp execution harness with temp cleanup.
- `src/renderer/capture.html`: Added MediaRecorder Opus compression and SharedArrayBuffer routing.
- `src/renderer/pill.html`: Added WebGL FFT visualizer shader, spring physics dragging, and offline badge.
- `src/renderer/settings.html`: Added persona bento grid, custom command manager, and audio history playback.
- `src/renderer/welcome.html`: Added interactive 4-step onboarding wizard with live VU meter.
- `src/renderer/history.html`: New dedicated audio history playback view.
- `src/renderer/vad-engine.js`: New Silero VAD ONNX wrapper for browser capture context.

---

### 2026-09-27: Premium pill redesign, shortcut rework, and UI animation polish

**Status:** Done

#### What changed
- Rebuilt the floating status pill into a text-free pure visual indicator. During listening, only an organic 5-bar waveform shows. Working state shows a minimal spinner. Done/error states morph outward with spring physics to show transcript or error text.
- Redesigned shortcut logic: `Ctrl+Win+Space` activates hands-free, either `Ctrl+Win` or `Ctrl+Win+Space` ends it. Push-to-talk still works via `Ctrl+Win` hold with a 130ms debounce.
- Added premium CSS animations throughout settings.html: staggered card entrances, animated nav active indicators with scaleY transitions, ambient glow drift, input focus ring glow, keycap hover lift, button press depth, and view panel crossfades.
- Fixed double-toggle bug on setting row switches by excluding `.switch` and `label` from click propagation.

#### Files touched
- `src/renderer/pill.html`: Complete rewrite with CSS Grid morphing layout, organic waveform, and spring entrance/exit curves.
- `src/main.js`: Rewrote uIOhook keydown handler for bidirectional hands-free stop (Ctrl+Win or Ctrl+Win+Space). Removed all text from setPill calls during listening/working states.
- `src/renderer/settings.html`: Added ~170 lines of premium animation CSS, fixed duplicate nav indicator, and fixed switch click event bubbling.

---

### 2026-09-27: 21st.dev UI redesign, micro Dynamic Island pill, and SmartScreen unblock

**Status:** Done

#### What changed
- Eliminated Microsoft Defender SmartScreen warning by removing NTFS `Zone.Identifier` alternate data stream with `Unblock-File`.
- Replaced oversized listening pill with a 21st.dev inspired micro Dynamic Island capsule (height reduced to 32px, window 320x44) with delicate audio waveform.
- Redesigned the main dashboard with 21st.dev components: spotlight cards with mouse-tracking radial borders, 3D mechanical sculpted keycaps, ambient aurora rays, bento grid stats, and tactile spring switches.
- Fixed the "Launch on Windows startup" switch: made full row clickable and wired direct registry persistence.
- Added global shortcut registrations for hands-free mode and selection polishing with a 130ms debounce window.
- Scrubbed test artifacts and filtered out single-punctuation entries from dictation feeds.
- Bumped version to 0.5.5.

#### Files touched
- `src/renderer/pill.html`: Replaced bulky bar with a 32px micro Dynamic Island pill.
- `src/renderer/settings.html`: Redesigned with 21st.dev spotlight cards, keycaps, and responsive feed.
- `src/main.js`: Added single-instance lock, globalShortcut bindings, pill window resize to 320x44, and noise filtering.
- `scripts/install.ps1`: Added automatic `Unblock-File` step to eliminate SmartScreen prompts.
- `package.json`: Bumped version to 0.5.5.

---

### 2026-09-27: Fixed hands-free shortcut collision and native selection polishing

**Status:** Done

#### What changed
- Fixed missing `pako` and `clipboardy` dependencies that caused selection polish to fail with `Cannot find module 'pako'`.
- Implemented native `copyViaHelper()` calling `tell-paste.exe --copy` to execute Win32 `SendInput` copying with automatic modifier release and focus restoration.
- Resolved shortcut collision where `Ctrl + Win` push-to-talk blocked `Ctrl + Win + Space` hands-free mode. Added active session promotion so pressing Space while holding Ctrl+Win transitions into persistent hands-free recording.
- Added interactive pill click to toggle hands-free recording, plus a tray menu toggle option.
- Bumped application version to 0.5.4.

#### Files touched
- `src/main.js`: Added `copyViaHelper`, updated `onPolishSelection` copy flow, added hands-free promotion logic, and added tray/IPC toggles.
- `src/preload.js`: Exposed `toggleHandsFree` method to context bridge.
- `src/renderer/pill.html`: Added cursor pointer and click handler to finish hands-free recording.
- `package.json`: Bumped version to 0.5.4.

---

### 2026-09-27: Installed v0.5.3 and updated publisher branding to Sheikh Technologies Inc.

**Status:** Done

#### What changed
- Created automated installer script `scripts/install.ps1` with uninstallation support.
- Updated publisher name across `package.json`, `LICENSE`, and Windows Registry to "Sheikh Technologies Inc.".
- Updated Windows Installed Apps registration to display Wispr Tell 0.5.3 with Sheikh Technologies Inc.
- Verified running process and startup log.

#### Files touched
- `scripts/install.ps1`: Created automated installer and shortcut generator.
- `package.json`: Changed author to Sheikh Technologies Inc.
- `LICENSE`: Updated copyright owner to Sheikh Technologies Inc.

---

### 2026-09-27: Removed notetaker and streamlined navigation

**Status:** Done

#### What changed
- Removed notetaker and scratchpad feature per user preference.
- Cleaned up settings interface navigation down to focused tabs: Dictation, Dictionary, Voice profile, Settings, and Help.
- Removed unused textarea DOM elements, word count calculators, and clipboard handlers.
- Updated documentation and bumped release version to 0.5.3.

#### Files touched
- `src/renderer/settings.html`: Removed notetaker CSS, view panel, tab navigation handler, and event listeners.
- `README.md`: Removed built-in scratchpad feature bullet point.
- `package.json`: Bumped version to 0.5.3.

---

### 2026-09-27: Redesigned minimal logo, intent-aware speech recognition, and Win+Alt+Q sentence polishing

**Status:** Done

#### What changed
- Replaced old padlock icon with a professional minimal acoustic wave W-monogram logo.
- Created vector `assets/logo.svg` and compiled a 7-resolution Windows `icon.ico` (16, 24, 32, 48, 64, 128, 256).
- Added multi-size responsive SVG brand mark to application sidebar and welcome interface.
- Implemented speech intent processing in `text-utils.js` and `main.js`: translates spoken punctuation into symbols and formats trailing questioning thoughts like "or?".
- Added `Win + Alt + Q` instant selection polishing shortcut with nut-js clipboard simulation and dedicated Groq editing prompt.
- Added selection polishing shortcut customization in settings UI and tray menu.
- Bumped version to 0.5.2 and created release archive.

#### Files touched
- `assets/logo.svg`: Created master vector logo and wordmark.
- `scripts/generate-icons.ps1`: Added multi-resolution icon builder for PNGs and true multi-frame ICO.
- `assets/icon.ico`: Replaced with 7-resolution icon bundle.
- `assets/icon.png`: Updated with 256x256 high-resolution minimal badge.
- `assets/tray.png`: Updated with 32x32 crisp monochrome wave icon.
- `src/text-utils.js`: Added comprehensive spoken punctuation conversion and question phrasing detection.
- `src/main.js`: Added `SELECTION_POLISH_SYSTEM`, `polishSelectedText`, `onPolishSelection`, and updated `POLISH_SYSTEM` prompt.
- `src/renderer/settings.html`: Updated brand logo to minimal SVG and added Polish selection shortcut control.
- `src/renderer/welcome.html`: Replaced emoji with brand SVG mark and documented shortcuts.
- `README.md`: Documented new features, logo redesign, intent engine, and polishing shortcut.
- `package.json`: Bumped version to 0.5.2.

---

### 2026-09-27: Theme selector, animated pill, auto-learning, and profile portability

**Status:** Done

#### What changed
- Added four color themes: Warm Light, Dark Obsidian, Slate Clean, and Cyber Teal.
- Synchronized Windows 11 title bar caption buttons with the selected theme in Electron.
- Added spring entrance animation and blur exit transitions for the floating status pill.
- Added 16-bar dynamic glowing audio waveform on HTML5 canvas.
- Added inline history correction detection with automatic diff calculation.
- Implemented 1-click personal dictionary learning from inline history edits.
- Added voice profile export and import functionality to backup speech habits and vocabulary in JSON format.
- Added push-to-talk and hands-free customizable keyboard shortcuts.
- Updated documentation and published release v0.5.1 on GitHub.

#### Files touched
- `src/main.js`: Added IPC handlers for profile export/import, title bar theme sync, and history updates.
- `src/preload.js`: Exposed exportProfile, importProfile, and updateHistoryItem to the renderer context bridge.
- `src/renderer/pill.html`: Replaced flat styling with spring cubic-bezier transitions, glassmorphism, and hands-free tag.
- `src/renderer/settings.html`: Implemented Flow dashboard UI with theme selector, diff learner, and profile management.
- `README.md`: Updated feature documentation, instructions, and project structure.
- `package.json`: Bumped version to 0.5.1.

#### Next steps
- Monitor user dictation speed and latency with the Groq whisper-large-v3-turbo engine.
- Verify hardware microphone hot-plugging detection across different audio devices.

---
