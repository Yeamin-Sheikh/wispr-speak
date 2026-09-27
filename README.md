# Wispr Speak

Hold-to-talk and hands-free voice typing for Windows powered by Groq cloud speech-to-text and language model cleanup. Speak naturally, and Wispr Speak types directly into your cursor in any application.

Wispr Speak is completely free and open source. It requires no subscription, paid tier, or upgrade.

### How it works

1. Press or hold your shortcut. Default push-to-talk is `Ctrl + Win`. Default hands-free toggle is `Ctrl + Win + Space`.
2. The hidden audio capture window records 16 kHz mono WAV audio with browser echo cancellation and noise suppression.
3. The floating status pill pops up with a spring animation and real-time audio waveform.
4. On shortcut release or toggle stop, the WAV audio is sent to Groq running whisper-large-v3 with greedy decoding (temperature 0.0) and vocabulary conditioning.
5. Voice commands and spoken punctuation are evaluated.
6. The transcribed text is cleaned by openai/gpt-oss-20b on Groq with fallback to qwen/qwen3.8-27b.
7. Personal dictionary rules, multi-word substitutions, and exact casing preservation are applied.
8. The native Windows helper restores the target window, releases modifier keys, and injects the text via clipboard paste. Standard windows receive Ctrl+V, while terminal windows receive Ctrl+Shift+V. Previous clipboard contents are restored after 600ms.

### Key features

- High accuracy transcription: Uses Whisper Large v3 by default with greedy temperature 0.0 decoding to prevent hallucinations and misheard phrases, with an option for Large v3 Turbo in settings.
- Productive personal dictionary: Add single vocabulary words, brand names, or multi-word replacements with automatic case preservation, bulk paste import, search filtering, and 1-click popular tech presets. Dictionary terms condition both the Whisper speech model and the language model.
- Slim floating status pill: Minimalist 20px audio-reactive equalizer pill with proportionally scaled bars centered cleanly on screen.
- Re-paste latest dictation: Missed focus or was not in a text box? Press `Alt + Shift + Z` at any time to paste your latest dictation into any active cursor.
- Cancel on Escape: Press `Esc` at any time during listening or processing to cancel immediately without pasting.
- Smart punctuation: Full sentences receive standard punctuation, while singular words and button labels never get unwanted trailing periods.
- Selection polishing shortcut: Highlight any text in any application and press `Win + Alt + Q` to polish grammar, spelling, flow, and punctuation.
- Context-based auto-learning: Edit any sentence or copy corrected text after dictating, and Wispr Speak extracts substitutions and adds them to your personal dictionary automatically. You can also highlight text and press `Win + Alt + L` to learn immediately.
- Push-to-talk and hands-free modes: Hold to talk or press once to start and press again to inject. All shortcuts are customizable in settings.
- Four interface themes: Warm Light, Dark Obsidian, Slate Clean, and Cyber Teal, with Windows 11 caption button color synchronization.
- Data backup and migration: Export your settings, dictionary rules, and shortcut preferences as a clean JSON backup file, and import it on any Windows PC.
- History and productivity stats: Browse past dictations, search by keyword, view total words transcribed, words per minute, and daily streaks.

### Requirements

- Windows 10 or Windows 11 (64-bit)
- Node.js 18 or higher (for running from source)
- A free Groq API key from console.groq.com (free tier, no credit card required)

### Quick start from source

Clone the repository and install dependencies:

```bash
git clone https://github.com/Yeamin-Sheikh/wispr-tell.git
cd wispr-tell
npm install
npm start
```

On first launch, Wispr Tell opens the settings window. Paste your Groq API key (starts with `gsk_`) and click "Test key" to confirm the connection.

### Portable application

Pre-built portable packages do not require Node.js or development dependencies. Download the release archive, unzip it to any folder, and run `Wispr Tell.exe`.

### Configuration and settings

Open the tray icon menu and select Settings to adjust configuration:

- Color theme: Switch between Warm Light, Dark Obsidian, Slate Clean, and Cyber Teal.
- Keyboard shortcuts: Remap push-to-talk, hands-free toggle, or selection polishing key combinations.
- Groq API key: Required for speech-to-text and language model correction.
- Transcription model: Select between Whisper Large v3 (highest accuracy) and Whisper Large v3 Turbo (lowest latency).
- Microphone input: Select a specific microphone hardware device or use the system default.
- Smart corrections: Toggle automatic grammar and punctuation cleanup.
- Personal dictionary: Add custom words or replacements with search, bulk add, and 1-click developer presets.
- Start with Windows: Automatically launch the app in the tray on user login.

Configuration data is saved to `%APPDATA%\wispr-tell\wispr-tell-config.json`.

### Voice commands

Wispr Tell recognizes spoken commands during dictation:

- "new line": Inserts a single line break.
- "new paragraph": Inserts two line breaks.
- "scratch that": Reverts the last injected dictation using Ctrl+Z.
- "undo that": Sends Ctrl+Z to the target window.
- "delete word": Sends Ctrl+Backspace to delete the previous word.
- Spoken punctuation: Say "comma", "period", "full stop", "question mark", "exclamation mark", "colon", or "semicolon" to insert corresponding symbols.

### Project layout

```
wispr-tell/
├── src/
│   ├── main.js             # Electron main process, hotkey lifecycle, Groq client
│   ├── preload.js          # Context bridge for renderer IPC
│   ├── text-utils.js       # Voice commands, filler filters, dictionary, multipart encoder
│   ├── native/
│   │   └── win-paste.c     # Win32 C helper for terminal detection and focus restoration
│   └── renderer/
│       ├── capture.html    # Hidden window with AudioWorklet for 16 kHz audio capture
│       ├── pill.html       # Floating status overlay with canvas audio waveform
│       ├── settings.html   # Modern Flow dashboard and settings interface
│       └── welcome.html    # First-run introduction card
├── bin/
│   └── native/
│       └── tell-paste.exe  # Compiled native paste helper
├── assets/                 # Icons and tray graphics
├── scripts/
│   └── build-native.js     # Script to compile win-paste.c using gcc, clang, or cl
└── package.json
```

### Compiling the native helper

The native paste helper (`tell-paste.exe`) is pre-compiled in `bin/native/`. To recompile it from `src/native/win-paste.c`:

```bash
npm run build-native
```

This script searches PATH for GCC (MinGW), Clang, or MSVC (`cl.exe`). If no C compiler is installed, the application falls back to `@nut-tree-fork/nut-js` key simulation.

### Packaging a portable release

To package the application into a standalone Windows folder:

```bash
npm run pack
```

### License

This project is licensed under the MIT License. See [LICENSE](LICENSE) for details.

The Windows paste helper in `src/native/win-paste.c` is adapted from OpenWhispr's `windows-fast-paste.c` (MIT License, Copyright (c) 2024 OpenWhispr Team).
