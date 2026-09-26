# Project progress

> Auto-maintained by dev-tracker skill. Do not edit the log section manually.

## Project info

- **Project:** Wispr Tell
- **Started:** 2026-09-26
- **Last updated:** 2026-09-27
- **Status:** Active

---

## Progress log

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
