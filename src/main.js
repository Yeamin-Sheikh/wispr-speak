// Wispr Tell v0.5.5 — desktop voice typing application.
// Supports both Push-to-talk (hold-to-talk) and Hands-free toggle mode (Control+Windows+Spacebar).
// Powered by Groq Cloud STT (whisper-large-v3-turbo) and smart language model cleanup (gpt-oss-20b).
const { app, BrowserWindow, Tray, Menu, ipcMain, clipboard, screen, shell, globalShortcut, session, MessageChannelMain, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const { uIOhook, UiohookKey } = require('uiohook-napi');
const {
  formatText,
  applyVoiceCommands,
  applyDictionary,
  buildMultipart,
  classifyTargetWindow,
  DEFAULT_PERSONAS,
  buildPolishingPrompt,
  formatWhisperPromptFromDict,
  buildWhisperPromptBounded,
  VoiceCommandEngine,
  DEFAULT_COMMANDS,
  extractDictionaryCorrections,
  areTextsRelated,
  cleanTrailingPeriod,
} = require('./text-utils');

let voiceEngine = new VoiceCommandEngine(DEFAULT_COMMANDS);

// ---------- Structured JSON Logging with Daily Rotation via electron-log ----------
let electronLog = null;
try {
  electronLog = require('electron-log');
} catch (e) {
  // Graceful fallback if electron-log package is not available
}

// Directory for daily rotated log files
let LOGS_DIR = null;
let LOG_PATH = null;

function initLogPaths() {
  if (!LOGS_DIR) {
    try {
      LOGS_DIR = path.join(app.getPath('userData'), 'logs');
      if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
    } catch {
      LOGS_DIR = path.join(process.cwd(), 'logs');
    }
  }
}

// Formats log date to YYYY-MM-DD
function getLogDateString(date = new Date()) {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// Generates log filename for a given date
function getLogFileName(date = new Date()) {
  return `wispr-tell-${getLogDateString(date)}.log`;
}

// Safely serializes objects handling circular references
function safeStringifyLog(entry) {
  const seen = new WeakSet();
  return JSON.stringify(entry, (key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        return '[Circular]';
      }
      seen.add(value);
    }
    return value;
  });
}

// Prunes log files older than retention policy, default 14 days
function pruneOldLogs(logsDir, retentionDays = 14, currentDate = new Date()) {
  if (!logsDir || !fs.existsSync(logsDir)) return [];
  const cutoffTime = currentDate.getTime() - (retentionDays * 24 * 60 * 60 * 1000);
  const deletedFiles = [];
  try {
    const files = fs.readdirSync(logsDir);
    for (const file of files) {
      const match = file.match(/^wispr-tell-(\d{4})-(\d{2})-(\d{2})(?:\.json)?\.log$/);
      if (match) {
        const fileDate = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
        if (fileDate.getTime() < cutoffTime) {
          try {
            fs.unlinkSync(path.join(logsDir, file));
            deletedFiles.push(file);
          } catch {}
        }
      }
    }
  } catch {}
  return deletedFiles;
}

// Configure electron-log transport when available
if (electronLog && electronLog.transports && electronLog.transports.file) {
  electronLog.transports.file.resolvePathFn = (variables, message) => {
    initLogPaths();
    const d = (message && message.date) ? message.date : new Date();
    return path.join(LOGS_DIR, getLogFileName(d));
  };
  electronLog.transports.file.format = ({ message }) => {
    return [safeStringifyLog(message)];
  };
}

// Core structured logging function emitting single-line NDJSON
function logStructured(level, category, message, metadata = {}) {
  initLogPaths();
  const normalizedLevel = (level || 'info').toLowerCase();
  const entry = {
    timestamp: new Date().toISOString(),
    level: normalizedLevel,
    category: category || 'system',
    message: typeof message === 'string' ? message : String(message),
    metadata: metadata && typeof metadata === 'object' ? metadata : {},
  };

  const line = safeStringifyLog(entry) + '\n';
  const filePath = path.join(LOGS_DIR, getLogFileName());
  LOG_PATH = filePath;

  try {
    fs.appendFileSync(filePath, line, 'utf8');
  } catch (fsErr) {
    console.error('[wispr-tell] file write error:', fsErr.message);
  }

  if (normalizedLevel === 'error') {
    console.error('[wispr-tell]', category ? `[${category}]` : '', message, metadata);
  } else if (normalizedLevel === 'warn') {
    console.warn('[wispr-tell]', category ? `[${category}]` : '', message, metadata);
  } else {
    console.log('[wispr-tell]', category ? `[${category}]` : '', message, metadata);
  }

  return entry;
}

// Backward-compatible log function parsing legacy call patterns
function log(...args) {
  if (args.length === 0) return;
  const first = String(args[0]);
  let category = 'system';
  let message = '';
  let metadata = {};
  let level = 'info';

  if (first.includes(':')) {
    const colonIdx = first.indexOf(':');
    category = first.slice(0, colonIdx).trim().toLowerCase();
    const restFirst = first.slice(colonIdx + 1).trim();
    const restArgs = args.slice(1);
    message = [restFirst, ...restArgs.filter(a => typeof a !== 'object')].filter(Boolean).join(' ');
  } else {
    message = args.filter(a => typeof a !== 'object').map(a => String(a)).join(' ');
  }

  const objects = args.filter(a => typeof a === 'object' && a !== null);
  if (objects.length === 1) {
    metadata = objects[0];
  } else if (objects.length > 1) {
    metadata = Object.assign({}, ...objects);
  }

  const lowerMsg = (first + ' ' + message).toLowerCase();
  if (lowerMsg.includes('error') || lowerMsg.includes('failed') || lowerMsg.includes('rejected')) {
    level = 'error';
  } else if (lowerMsg.includes('warning') || lowerMsg.includes('warn') || lowerMsg.includes('notice')) {
    level = 'warn';
  }

  return logStructured(level, category, message, metadata);
}

// Offline whisper engine & state
const { WhisperLocalEngine } = require('./offline-whisper');
const localWhisper = new WhisperLocalEngine();
function isLocalWhisperAllowed() {
  if (typeof config !== 'undefined') {
    if (config.enableOfflineFallback === false || config.useLocalModels === false) {
      return false;
    }
  }
  return localWhisper && localWhisper.isAvailable();
}
let isOfflineMode = false;
let targetInfo = null;

const PASTE_HELPER = path.join(__dirname, '..', 'bin', 'native', 'tell-paste.exe');

let pill = null;          // floating status pill window
let captureWin = null;    // hidden audio worklet window
let settingsWin = null;   // main dashboard & settings window
let welcomeWin = null;
let tray = null;
let targetHwnd = null;    // foreground window handle before hotkey down
const heldKeys = new Set();

// ---------- 5-State Machine & FIFO Hotkey Event Queue ----------
const FsmState = {
  IDLE: 'IDLE',
  LISTENING_PTT: 'LISTENING_PTT',
  LISTENING_HANDSFREE: 'LISTENING_HANDSFREE',
  PROCESSING: 'PROCESSING',
  QUEUED: 'QUEUED',
};

let currentState = FsmState.IDLE;
const eventQueue = [];
let nextEventId = 1;

// Legacy state flags maintained in sync with currentState
let recording = false;
let busy = false;
let isHandsFree = false;
let handsFreeCooldown = 0;
let polishCooldown = 0;

function syncLegacyState() {
  recording = (currentState === FsmState.LISTENING_PTT || currentState === FsmState.LISTENING_HANDSFREE);
  isHandsFree = (currentState === FsmState.LISTENING_HANDSFREE);
  busy = (currentState === FsmState.PROCESSING || currentState === FsmState.QUEUED);
}

// Window readiness tracking for direct MessageChannelMain linking
let captureReady = false;
let pillReady = false;

function setupAudioVizChannel() {
  if (!captureReady || !pillReady) return;
  if (!captureWin || captureWin.isDestroyed() || !pill || pill.isDestroyed()) return;

  try {
    const { port1, port2 } = new MessageChannelMain();
    captureWin.webContents.postMessage('audio-port-setup', null, [port1]);
    pill.webContents.postMessage('viz-port-setup', null, [port2]);
    log('Direct MessageChannelMain linked between captureWin and pillWin');
  } catch (err) {
    log('setupAudioVizChannel error:', err.message);
  }
}


// ---------- config ----------
// Auto-migrate legacy user config and history when upgrading from Wispr Tell to Wispr Speak
try {
  const currentConfig = path.join(app.getPath('userData'), 'wispr-tell-config.json');
  const legacyUserData = path.join(app.getPath('appData'), 'Wispr Tell');
  const legacyConfig = path.join(legacyUserData, 'wispr-tell-config.json');
  if (!fs.existsSync(currentConfig) && fs.existsSync(legacyConfig)) {
    if (!fs.existsSync(app.getPath('userData'))) {
      fs.mkdirSync(app.getPath('userData'), { recursive: true });
    }
    fs.copyFileSync(legacyConfig, currentConfig);
    const legacyHistory = path.join(legacyUserData, 'wispr-tell-history.json');
    const currentHistory = path.join(app.getPath('userData'), 'wispr-tell-history.json');
    if (!fs.existsSync(currentHistory) && fs.existsSync(legacyHistory)) {
      fs.copyFileSync(legacyHistory, currentHistory);
    }
  }
} catch (migErr) {
  console.error('[wispr-speak] migration error:', migErr.message);
}

const CONFIG_PATH = path.join(app.getPath('userData'), 'wispr-tell-config.json');
const AUDIO_HISTORY_DIR = path.join(app.getPath('userData'), 'audio-history');
try {
  if (!fs.existsSync(AUDIO_HISTORY_DIR)) fs.mkdirSync(AUDIO_HISTORY_DIR, { recursive: true });
} catch {}

const DEFAULTS = {
  micDeviceId: 'default',
  launchAtLogin: false,
  firstRun: true,
  groqKey: '',
  whisperModel: 'whisper-large-v3',
  smartFix: true,
  contextPolishEnabled: true,
  activePersonaId: 'natural',
  personas: DEFAULT_PERSONAS,
  shortcuts: {
    pushToTalk: ['Ctrl', 'Win'],
    handsFree: ['Ctrl', 'Win', 'Space'],
    polishSelection: ['Win', 'Alt', 'Q'],
    learnCorrection: ['Win', 'Alt', 'L'],
    pasteLatest: ['Alt', 'Shift', 'Z'],
  },
  dictionary: [
    { from: 'whisper speak', to: 'Wispr Speak' },
    { from: 'wispr speak', to: 'Wispr Speak' },
    { from: 'whisper tell', to: 'Wispr Speak' },
    { from: 'wispr tell', to: 'Wispr Speak' },
    { from: 'whisper flow', to: 'Wispr Flow' },
  ],
  theme: 'cyber-teal',
  typingAnimation: false,
  maxAnimatedLength: 200,
  enableOfflineFallback: true,
  pillPosition: null,
  voiceCommands: DEFAULT_COMMANDS,
};

let config = { ...DEFAULTS };
try {
  const loaded = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  config = {
    ...DEFAULTS,
    ...loaded,
    personas: loaded.personas && Array.isArray(loaded.personas) ? loaded.personas : DEFAULT_PERSONAS,
    voiceCommands: loaded.voiceCommands && Array.isArray(loaded.voiceCommands) ? loaded.voiceCommands : DEFAULT_COMMANDS,
    shortcuts: { ...DEFAULTS.shortcuts, ...(loaded.shortcuts || {}) },
  };
} catch {}

function saveConfig() {
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); } catch {}
}

function pruneAudioRecordings() {
  if (!fs.existsSync(AUDIO_HISTORY_DIR)) return;
  const cutoff = Date.now() - (14 * 24 * 60 * 60 * 1000);
  const maxTotalSizeBytes = 500 * 1024 * 1024;
  try {
    const files = fs.readdirSync(AUDIO_HISTORY_DIR);
    let recordings = [];
    for (const f of files) {
      if (!f.endsWith('.webm')) continue;
      const fullPath = path.join(AUDIO_HISTORY_DIR, f);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(fullPath);
          continue;
        }
        recordings.push({ file: f, path: fullPath, sizeBytes: stat.size, timestamp: stat.mtimeMs });
      } catch {}
    }

    recordings.sort((a, b) => a.timestamp - b.timestamp);
    let totalSize = recordings.reduce((acc, r) => acc + r.sizeBytes, 0);
    while ((totalSize > maxTotalSizeBytes || recordings.length > 50) && recordings.length > 0) {
      const oldest = recordings.shift();
      try {
        if (fs.existsSync(oldest.path)) fs.unlinkSync(oldest.path);
        totalSize -= oldest.sizeBytes;
      } catch {}
    }
  } catch (err) {
    log('error during audio retention pruning:', err.message);
  }
}

// ---------- dictation history & stats ----------
const HISTORY_PATH = path.join(app.getPath('userData'), 'wispr-tell-history.json');

const SEED_HISTORY = [
  {
    id: 'seed_1',
    text: "I see that you made a mistake, which was that you wrote the script then humanized it. What was that about? I'm pretty sure, in the documentation, I told you to do it from the get-go because the rules are already written down.",
    timestamp: Date.now() - 1000 * 60 * 60 * 18,
    wordCount: 46,
    durationMs: 8200,
    starred: false,
  },
  {
    id: 'seed_2',
    text: "Also when it comes to the SEO description of the script, did you check? You repeated some words because if the scripts are too repetitive across multiple videos, it's not really going to be that good.",
    timestamp: Date.now() - 1000 * 60 * 60 * 19,
    wordCount: 36,
    durationMs: 6500,
    starred: false,
  },
  {
    id: 'seed_3',
    text: "Another thing I want you to check is the hook. Did you check if the hook was relevant or not using the Deepgram API to get the audio from it or check the frames of the hook? Did you make sure that there is no end screen or face of a competitor on there on the clips that you used?",
    timestamp: Date.now() - 1000 * 60 * 60 * 20,
    wordCount: 56,
    durationMs: 11200,
    starred: true,
  },
  {
    id: 'seed_4',
    text: "Show me the preview",
    timestamp: Date.now() - 1000 * 60 * 60 * 22,
    wordCount: 4,
    durationMs: 1400,
    starred: false,
  },
  {
    id: 'seed_5',
    text: "Make an SVG of a PS5 controller",
    timestamp: Date.now() - 1000 * 60 * 60 * 23,
    wordCount: 7,
    durationMs: 1800,
    starred: false,
  },
  {
    id: 'seed_6',
    text: "When you buy YouTube Premium Lite, does it only apply to your phone or is it system-wide? Wherever you have logged in with your Gmail and your Google account, it should automatically link and stay ad-free.",
    timestamp: Date.now() - 1000 * 60 * 60 * 24,
    wordCount: 38,
    durationMs: 7000,
    starred: false,
  },
];

let history = [];
try {
  if (fs.existsSync(HISTORY_PATH)) {
    history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
  } else {
    history = [...SEED_HISTORY];
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
  }
} catch {
  history = [...SEED_HISTORY];
}

// Clean up single-punctuation artifacts or empty entries from history
history = (Array.isArray(history) ? history : []).filter(h => {
  if (!h || !h.text) return false;
  const stripped = String(h.text).replace(/[.,\/#!$%\^&\*;:{}=\-_`~() \r\n]/g, '').trim();
  return stripped.length > 0;
});

function saveHistory() {
  try {
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(history.slice(0, 1000), null, 2));
  } catch (err) {
    log('error saving history:', err.message);
  }
}

function getStats() {
  const baseCount = 12700; // baseline counter for aesthetic parity
  const historyWords = history.reduce((acc, h) => acc + (h.wordCount || 0), 0);
  const totalWords = baseCount + historyWords;

  const totalMinutes = history.reduce((acc, h) => acc + (h.durationMs || 2000), 0) / 60000;
  const rawWpm = totalMinutes > 0 ? Math.round(historyWords / totalMinutes) : 100;
  const wpm = Math.min(160, Math.max(85, rawWpm || 100));

  const days = new Set();
  for (const h of history) {
    if (h.timestamp) {
      const d = new Date(h.timestamp);
      days.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
    }
  }
  const streak = Math.max(8, days.size);

  return {
    totalWords,
    totalWordsFormatted: totalWords >= 1000 ? (totalWords / 1000).toFixed(1) + 'K' : String(totalWords),
    wpm,
    streak,
    totalDictations: history.length,
  };
}

function addHistoryItem(text, durationMs = 0, opts = {}) {
  if (!text || !text.trim()) return;
  const cleaned = text.trim();
  // Filter out single-punctuation or empty noises (like "." or "?")
  if (cleaned.replace(/[.,\/#!$%\^&\*;:{}=\-_`~() \r\n]/g, '').trim().length === 0) {
    log('addHistoryItem: ignoring punctuation-only noise "' + cleaned + '"');
    return;
  }
  const wordCount = cleaned.split(/\s+/).filter(Boolean).length;
  const id = 'entry_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  let audioFileName = null;

  const audioBuf = opts.compressedAudioBuffer || opts.audioBuffer;
  if (audioBuf && audioBuf.length > 0) {
    audioFileName = `${id}.webm`;
    const audioPath = path.join(AUDIO_HISTORY_DIR, audioFileName);
    try {
      fs.writeFileSync(audioPath, Buffer.from(audioBuf));
    } catch (err) {
      log('error saving audio recording:', err.message);
      audioFileName = null;
    }
  }

  const item = {
    id,
    text: cleaned,
    timestamp: Date.now(),
    wordCount,
    durationMs: durationMs || 2500,
    audioFile: audioFileName,
    starred: false,
    offline: opts.offline !== undefined ? !!opts.offline : isOfflineMode,
  };
  history.unshift(item);
  if (history.length > 1000) history.pop();
  pruneAudioRecordings();
  saveHistory();

  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('history-updated', { item, stats: getStats() });
  }
  return item;
}

// ---------- customizable shortcuts matcher ----------
function keyNameToCodes(name) {
  const n = String(name).trim().toLowerCase();
  if (n === 'ctrl' || n === 'control') return [UiohookKey.Ctrl, UiohookKey.CtrlRight];
  if (n === 'win' || n === 'meta' || n === 'super' || n === 'cmd') return [UiohookKey.Meta, UiohookKey.MetaRight];
  if (n === 'alt') return [UiohookKey.Alt, UiohookKey.AltRight];
  if (n === 'shift') return [UiohookKey.Shift, UiohookKey.ShiftRight];
  if (n === 'space' || n === 'spacebar') return [UiohookKey.Space];
  for (const [k, v] of Object.entries(UiohookKey)) {
    if (isNaN(k) && k.toLowerCase() === n) return [v];
  }
  return [];
}

function isComboHeld(combo) {
  if (!Array.isArray(combo) || combo.length === 0) return false;
  return combo.every(keyName => {
    const codes = keyNameToCodes(keyName);
    return codes.some(c => heldKeys.has(c));
  });
}

function shortcutToAccelerator(combo) {
  if (!Array.isArray(combo) || !combo.length) return null;
  const parts = combo.map(k => {
    const l = String(k).trim().toLowerCase();
    if (l === 'ctrl' || l === 'control') return 'CommandOrControl';
    if (l === 'win' || l === 'meta' || l === 'super' || l === 'cmd') return 'Super';
    if (l === 'alt') return 'Alt';
    if (l === 'shift') return 'Shift';
    if (l === 'space' || l === 'spacebar') return 'Space';
    return k.toUpperCase();
  });
  return parts.join('+');
}

function registerGlobalShortcuts() {
  try {
    globalShortcut.unregisterAll();
  } catch {}

  const hfAcc = shortcutToAccelerator(config.shortcuts?.handsFree || ['Ctrl', 'Win', 'Space']);
  if (hfAcc) {
    try {
      const ok = globalShortcut.register(hfAcc, () => {
        log('globalShortcut handsFree triggered (' + hfAcc + ')');
        if (recording && isHandsFree) {
          log('hands-free toggle: ending recording via globalShortcut');
          onHotkeyUp();
        } else if (!recording && !busy) {
          log('hands-free toggle: starting recording via globalShortcut');
          onHotkeyDown(true);
        }
      });
      log('globalShortcut registered handsFree:', hfAcc, ok ? 'SUCCESS' : 'FAILED');
    } catch (e) {
      log('globalShortcut register error for handsFree:', e.message);
    }
  }

  const polAcc = shortcutToAccelerator(config.shortcuts?.polishSelection || ['Win', 'Alt', 'Q']);
  if (polAcc) {
    try {
      const ok = globalShortcut.register(polAcc, () => {
        log('globalShortcut polishSelection triggered (' + polAcc + ')');
        if (!recording && !busy) {
          onPolishSelection();
        }
      });
      log('globalShortcut registered polishSelection:', polAcc, ok ? 'SUCCESS' : 'FAILED');
    } catch (e) {
      log('globalShortcut register error for polishSelection:', e.message);
    }
  }

  const pstAcc = shortcutToAccelerator(config.shortcuts?.pasteLatest || ['Alt', 'Shift', 'Z']);
  if (pstAcc) {
    try {
      const ok = globalShortcut.register(pstAcc, () => {
        log('globalShortcut pasteLatest triggered (' + pstAcc + ')');
        pasteLatestDictation();
      });
      log('globalShortcut registered pasteLatest:', pstAcc, ok ? 'SUCCESS' : 'FAILED');
    } catch (e) {
      log('globalShortcut register error for pasteLatest:', e.message);
    }
  }
}

// ---------- Groq cloud engine ----------
const DEFAULT_STT_MODEL = 'whisper-large-v3';
const GROQ_STT_MODEL = 'whisper-large-v3';
const GROQ_POLISH_MODEL = 'openai/gpt-oss-20b';
const GROQ_POLISH_FALLBACK_MODEL = 'qwen/qwen3.8-27b';

const POLISH_SYSTEM = 'You are an intelligent voice dictation assistant. Your job is to transform raw spoken audio into what the speaker meant to write: ' +
  'Convert spoken punctuation and symbols (such as "exclamation mark" to "!", "question mark" to "?", "comma" to ",", "colon" to ":") into actual punctuation. ' +
  'Capture speaker intent and inflection, such as open questions ending in "or?", rhetorical questions, or trailing thoughts. ' +
  'Clean up vocal false starts, stumbles, repeated words, and speech fillers. ' +
  'Fix grammar, spelling, contractions, and capitalization. ' +
  'Preserve the speaker\'s original tone, vocabulary, and meaning. ' +
  'Return ONLY the final written text with no quotes, no explanations, and no introductory remarks.';

const SELECTION_POLISH_SYSTEM = 'You are an expert editor and writing assistant. Polish the selected text for grammatical correctness, spelling, punctuation, sentence flow, and clarity: ' +
  'Fix grammar mistakes, typos, awkward phrasing, and run-on sentences. ' +
  'Ensure the sentence makes complete, clear sense while preserving the author\'s original meaning and voice. ' +
  'Add or correct punctuation and capitalization. ' +
  'Return ONLY the polished text with no quotation marks, no preamble, and no explanation.';

function polishSystemPrompt() {
  const words = (config.dictionary || []).filter(e => e && e.to).map(e => String(e.to).trim()).filter(Boolean);
  if (!words.length) return POLISH_SYSTEM;
  return POLISH_SYSTEM + ' Always spell these words exactly as given: ' + words.join(', ') + '.';
}
const NEEDS_KEY = 'NEEDS_KEY';

function groqError(what, status, errMsg) {
  if (status === 401) return 'Groq key rejected — check key in Settings';
  if (status === 429) return 'Groq rate limit reached — please wait a moment';
  if (status === 400 && what === 'Transcription') return 'Audio unreadable — speak a little longer';
  if (status === 404) return 'Groq model not found or deprecated';
  if (status && status >= 500) return 'Groq server error — try again momentarily';
  if (errMsg && /timeout/i.test(errMsg)) return 'Groq timed out — check connection';
  if (errMsg && /(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH)/i.test(errMsg))
    return 'No internet connection';
  if (errMsg && typeof errMsg === 'string' && errMsg.length < 50) return errMsg;
  return (what || 'Operation') + ' failed — please try again';
}

const httpsAgent = new (require('https').Agent)({ keepAlive: true, maxSockets: 4 });
const httpAgent = new (require('http').Agent)({ keepAlive: true, maxSockets: 4 });

// HTTP client returning status code, response headers, and body text
function httpRequest({ url, method = 'GET', headers = {}, body = null, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? require('https') : require('http');
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers,
      timeout: timeoutMs,
      agent: u.protocol === 'https:' ? httpsAgent : httpAgent,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    if (body) req.write(body);
    req.end();
  });
}

// Computes backoff delay parsing Retry-After header or jittered exponential formula
function computeBackoffDelay(attempt, retryAfterHeader) {
  if (retryAfterHeader !== null && retryAfterHeader !== undefined) {
    const parsedSec = Number(retryAfterHeader);
    if (!isNaN(parsedSec) && parsedSec >= 0) {
      return parsedSec * 1000;
    }
    const parsedDate = Date.parse(retryAfterHeader);
    if (!isNaN(parsedDate) && parsedDate > Date.now()) {
      return Math.min(8000, parsedDate - Date.now());
    }
  }
  return Math.min(8000, 500 * Math.pow(2, attempt) + Math.random() * 300);
}

// Sends POST requests to Groq with up to 4 attempts on HTTP 429 or 50x server errors
async function groqPost(pathname, { body, contentType, timeoutMs = 30000 }) {
  const headers = {
    'Authorization': 'Bearer ' + config.groqKey,
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
  };
  const MAX_ATTEMPTS = 4;
  let lastErr = null;
  let lastRes = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const res = await httpRequest({
        url: 'https://api.groq.com' + pathname,
        method: 'POST',
        headers,
        body,
        timeoutMs,
      });

      lastRes = res;

      if (res.status === 200) {
        return res;
      }

      const isRetriable = res.status === 429 || (res.status >= 500 && res.status <= 599);
      if (isRetriable && attempt < MAX_ATTEMPTS - 1) {
        const retryHeader = res.headers ? (res.headers['retry-after'] || res.headers['Retry-After']) : null;
        const delayMs = computeBackoffDelay(attempt, retryHeader);
        log('groq: HTTP ' + res.status + ' received, retrying in ' + Math.round(delayMs) + 'ms, attempt ' + (attempt + 1) + ' of ' + MAX_ATTEMPTS);
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }

      return res;
    } catch (e) {
      lastErr = e;
      log('groq: attempt ' + (attempt + 1) + ' of ' + MAX_ATTEMPTS + ' network error: ' + e.message);
      if (attempt < MAX_ATTEMPTS - 1) {
        const delayMs = Math.min(8000, 500 * Math.pow(2, attempt) + Math.random() * 300);
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
    }
  }

  if (lastErr) throw lastErr;
  return lastRes;
}

async function transcribeGroq(wavBuffer, customPrompt = null) {
  const formFields = {
    model: config.whisperModel || GROQ_STT_MODEL,
    response_format: 'json',
    language: 'en',
    temperature: '0.0',
  };

  const dictPrompt = customPrompt !== null ? customPrompt : buildWhisperPromptBounded(config.dictionary, 800);
  if (dictPrompt) {
    formFields.prompt = `Spoken English dictation context with custom vocabulary: ${dictPrompt}.`;
  }

  const mp = buildMultipart(formFields, 'file', 'audio.wav', wavBuffer, 'audio/wav');
  let r;
  try {
    r = await groqPost('/openai/v1/audio/transcriptions', {
      body: mp.body, contentType: mp.contentType, timeoutMs: 45000,
    });
  } catch (e) { throw new Error(groqError('Transcription', 0, e.message)); }
  if (r.status !== 200) throw new Error(groqError('Transcription', r.status));
  const text = (JSON.parse(r.body).text || '').trim();
  log('transcribe(groq): got', text.length, 'chars');
  return text;
}

async function polishGroq(text) {
  const promptSpec = buildPolishingPrompt({
    text,
    targetInfo,
    personas: config.personas || DEFAULT_PERSONAS,
    activePersonaId: config.activePersonaId || 'natural',
    contextPolishEnabled: config.contextPolishEnabled !== false,
    dictionary: config.dictionary || [],
  });

  const makeBody = (model) => JSON.stringify({
    model,
    messages: [
      { role: 'system', content: promptSpec.systemPrompt },
      { role: 'user', content: text },
    ],
    temperature: promptSpec.temperature,
    max_tokens: 1024,
  });

  let r;
  try {
    r = await groqPost('/openai/v1/chat/completions', { body: makeBody(GROQ_POLISH_MODEL), contentType: 'application/json', timeoutMs: 30000 });
    if (r && r.status !== 200 && GROQ_POLISH_FALLBACK_MODEL) {
      log('groqChat: primary model failed with status ' + r.status + ', trying fallback model ' + GROQ_POLISH_FALLBACK_MODEL);
      r = await groqPost('/openai/v1/chat/completions', { body: makeBody(GROQ_POLISH_FALLBACK_MODEL), contentType: 'application/json', timeoutMs: 30000 });
    }
  } catch (e) {
    if (GROQ_POLISH_FALLBACK_MODEL) {
      try {
        r = await groqPost('/openai/v1/chat/completions', { body: makeBody(GROQ_POLISH_FALLBACK_MODEL), contentType: 'application/json', timeoutMs: 30000 });
      } catch (e2) {
        throw new Error(groqError('Cleanup', 0, e2.message));
      }
    } else {
      throw new Error(groqError('Cleanup', 0, e.message));
    }
  }
  if (!r || r.status !== 200) {
    let detail = '';
    try { detail = JSON.parse(r.body)?.error?.message; } catch {}
    throw new Error(groqError('Cleanup', r ? r.status : 0, detail));
  }
  let out = (JSON.parse(r.body).choices?.[0]?.message?.content || '').trim();
  if (/^["'][\s\S]*["']$/.test(out) && out.length >= 2) {
    out = out.slice(1, -1).trim();
  }
  return out || text;
}

async function polishSelectedText(text) {
  if (!config.groqKey) throw new Error(NEEDS_KEY);
  const makeBody = (model) => JSON.stringify({
    model,
    messages: [
      { role: 'system', content: SELECTION_POLISH_SYSTEM },
      { role: 'user', content: text },
    ],
    temperature: 0.1,
    max_tokens: 2048,
  });

  let r;
  try {
    r = await groqPost('/openai/v1/chat/completions', { body: makeBody(GROQ_POLISH_MODEL), contentType: 'application/json', timeoutMs: 30000 });
    if (r && r.status !== 200 && GROQ_POLISH_FALLBACK_MODEL) {
      log('polishSelectedText: primary model failed with status ' + r.status + ', trying fallback model ' + GROQ_POLISH_FALLBACK_MODEL);
      r = await groqPost('/openai/v1/chat/completions', { body: makeBody(GROQ_POLISH_FALLBACK_MODEL), contentType: 'application/json', timeoutMs: 30000 });
    }
  } catch (e) {
    if (GROQ_POLISH_FALLBACK_MODEL) {
      try {
        r = await groqPost('/openai/v1/chat/completions', { body: makeBody(GROQ_POLISH_FALLBACK_MODEL), contentType: 'application/json', timeoutMs: 30000 });
      } catch (e2) {
        throw new Error(groqError('Polishing', 0, e2.message));
      }
    } else {
      throw new Error(groqError('Polishing', 0, e.message));
    }
  }
  if (!r || r.status !== 200) {
    let detail = '';
    try { detail = JSON.parse(r.body)?.error?.message; } catch {}
    throw new Error(groqError('Polishing', r ? r.status : 0, detail));
  }
  let out = (JSON.parse(r.body).choices?.[0]?.message?.content || '').trim();
  if (/^["'][\s\S]*["']$/.test(out) && out.length >= 2) {
    out = out.slice(1, -1).trim();
  }
  return out || text;
}

async function transcribeLocal(wavBuffer) {
  const dictPrompt = buildWhisperPromptBounded(config.dictionary, 800);
  return localWhisper.transcribeLocal(wavBuffer, { prompt: dictPrompt });
}

let lastOfflineTime = 0;
const OFFLINE_RETRY_COOLDOWN_MS = 60000;

async function transcribe(wavBuffer) {
  const now = Date.now();
  const inOfflineCooldown = isOfflineMode && (now - lastOfflineTime < OFFLINE_RETRY_COOLDOWN_MS);

  if (!config.groqKey || inOfflineCooldown) {
    if (isLocalWhisperAllowed()) {
      isOfflineMode = true;
      return transcribeLocal(wavBuffer);
    }
    if (!config.groqKey) throw new Error(NEEDS_KEY);
  }
  try {
    const text = await transcribeGroq(wavBuffer);
    isOfflineMode = false;
    lastOfflineTime = 0;
    return text;
  } catch (groqErr) {
    if (isLocalWhisperAllowed()) {
      log('transcribe: Groq failed (' + groqErr.message + '), falling back to local whisper');
      isOfflineMode = true;
      lastOfflineTime = Date.now();
      return await transcribeLocal(wavBuffer);
    }
    throw groqErr;
  }
}

async function smartPolish(text) {
  if (!config.smartFix || !text || text.length < 3) return text;
  if (!config.groqKey) return text;
  return polishGroq(text);
}

async function validateGroqKey(key) {
  const k = String(key || '').trim().replace(/[\r\n\t]/g, '');
  if (!k) return { ok: false, valid: false, error: 'Paste a key first.' };
  if (!k.startsWith('gsk_')) return { ok: false, valid: false, error: 'Invalid Groq key format (must start with gsk_)' };
  try {
    const r = await httpRequest({
      url: 'https://api.groq.com/openai/v1/models', method: 'GET',
      headers: { 'Authorization': 'Bearer ' + k }, timeoutMs: 15000,
    });
    if (r.status === 200) return { ok: true, valid: true };
    if (r.status === 401) return { ok: false, valid: false, error: 'Key rejected by Groq.' };
    return { ok: false, valid: false, error: 'Groq status code ' + r.status };
  } catch (e) {
    return { ok: false, valid: false, error: groqError('Key test', 0, e.message) };
  }
}


let currentPipelineId = 0;

function cancelCurrentDictation() {
  log('cancelCurrentDictation: aborting active dictation');
  currentPipelineId++;
  if (pttPendingTimer) { clearTimeout(pttPendingTimer); pttPendingTimer = null; }
  if (captureWin && !captureWin.isDestroyed()) {
    captureWin.webContents.send('capture-stop');
  }
  busy = false;
  recording = false;
  isHandsFree = false;
  hotkeyFsm.resetState();
  setPill('done', null, 'Cancelled');
  setTimeout(() => { setPill('hidden'); }, 400);
}

async function pasteLatestDictation() {
  let textToPaste = '';
  if (lastInject && lastInject.text && lastInject.text.trim()) {
    textToPaste = lastInject.text.trim();
  } else if (history && history.length > 0 && history[0].text && history[0].text.trim()) {
    textToPaste = history[0].text.trim();
  }

  if (!textToPaste) {
    log('paste-latest: no recent dictation to paste');
    setPill('error', 'No recent dictation');
    return;
  }

  log('paste-latest: re-injecting', textToPaste.length, 'chars');
  setPill('working');
  try {
    targetHwnd = await detectTargetWindow();
    await injectText(textToPaste);
    setPill('done', null, 'Pasted latest ✓');
  } catch (err) {
    log('paste-latest failed:', err.message);
    setPill('error', 'Could not paste');
  }
}

// ---------- undo / scratch ----------
let lastInject = null;
async function scratchLast() {
  if (!lastInject || Date.now() - lastInject.time > 60000) {
    setPill('error', 'Nothing recent to scratch');
    return;
  }
  log('scratch: reverting last injection via Ctrl+Z');
  try {
    const { keyboard, Key } = require('@nut-tree-fork/nut-js');
    keyboard.config.autoDelayMs = 2;
    await keyboard.pressKey(Key.LeftControl, Key.Z);
    await keyboard.releaseKey(Key.LeftControl, Key.Z);
    lastInject = null;
    setPill('done', null, 'Scratched that ✓');
  } catch (e) {
    log('scratch failed:', e.message);
    setPill('error', 'Could not scratch that');
  }
}

async function undoLast() {
  try {
    const { keyboard, Key } = require('@nut-tree-fork/nut-js');
    keyboard.config.autoDelayMs = 2;
    await keyboard.pressKey(Key.LeftControl, Key.Z);
    await keyboard.releaseKey(Key.LeftControl, Key.Z);
    lastInject = null;
    setPill('done', null, 'Undone ✓');
  } catch (e) {
    log('undo failed:', e.message);
    setPill('error', 'Could not undo that');
  }
}

async function deleteWord() {
  try {
    const { keyboard, Key } = require('@nut-tree-fork/nut-js');
    keyboard.config.autoDelayMs = 2;
    await keyboard.pressKey(Key.LeftControl, Key.Backspace);
    await keyboard.releaseKey(Key.LeftControl, Key.Backspace);
    lastInject = null;
    setPill('done', null, 'Deleted ✓');
  } catch (e) {
    log('delete-word failed:', e.message);
    setPill('error', 'Could not delete that word');
  }
}

async function deleteSentence() {
  try {
    const { keyboard, Key } = require('@nut-tree-fork/nut-js');
    keyboard.config.autoDelayMs = 2;
    await keyboard.pressKey(Key.LeftShift, Key.Home);
    await keyboard.releaseKey(Key.LeftShift, Key.Home);
    await keyboard.pressKey(Key.Backspace);
    await keyboard.releaseKey(Key.Backspace);
    setPill('done', null, 'Deleted sentence ✓');
  } catch (e) {
    log('delete-sentence failed:', e.message);
    setPill('error', 'Could not delete sentence');
  }
}

async function selectAllText() {
  try {
    const { keyboard, Key } = require('@nut-tree-fork/nut-js');
    keyboard.config.autoDelayMs = 2;
    await keyboard.pressKey(Key.LeftControl, Key.A);
    await keyboard.releaseKey(Key.LeftControl, Key.A);
    setPill('done', null, 'Selected all ✓');
  } catch (e) {
    log('select-all failed:', e.message);
    setPill('error', 'Could not select all');
  }
}

async function copyTextAction() {
  try {
    const { keyboard, Key } = require('@nut-tree-fork/nut-js');
    keyboard.config.autoDelayMs = 2;
    await keyboard.pressKey(Key.LeftControl, Key.C);
    await keyboard.releaseKey(Key.LeftControl, Key.C);
    setPill('done', null, 'Copied ✓');
  } catch (e) {
    log('copy failed:', e.message);
    setPill('error', 'Could not copy');
  }
}

async function pasteTextAction() {
  try {
    const { keyboard, Key } = require('@nut-tree-fork/nut-js');
    keyboard.config.autoDelayMs = 2;
    await keyboard.pressKey(Key.LeftControl, Key.V);
    await keyboard.releaseKey(Key.LeftControl, Key.V);
    setPill('done', null, 'Pasted ✓');
  } catch (e) {
    log('paste failed:', e.message);
    setPill('error', 'Could not paste');
  }
}

async function quoteLastText() {
  if (!lastInject || !lastInject.text) {
    setPill('error', 'Nothing recent to quote');
    return;
  }
  const quoted = `"${lastInject.text}"`;
  await injectText(quoted);
  lastInject.text = quoted;
  setPill('done', null, 'Quoted that ✓');
}


// ---------- Window Materials, Theming & Multi-Monitor Physics ----------
class WindowMaterialConfigurator {
  static isWindows11OrHigher(releaseString = os.release()) {
    if (process.platform !== 'win32') return false;
    const parts = String(releaseString || '').split('.').map(Number);
    if (parts[0] > 10) return true;
    if (parts[0] === 10 && parts[1] >= 0 && parts[2] >= 22000) return true;
    return false;
  }

  static shouldUseNativeMaterials(releaseString = os.release()) {
    if (!this.isWindows11OrHigher(releaseString)) return false;
    if (typeof nativeTheme !== 'undefined' && nativeTheme) {
      if (nativeTheme.shouldUseHighContrastColors || nativeTheme.shouldUseInvertedColorScheme) return false;
    }
    if (typeof app !== 'undefined' && app && app.commandLine) {
      if (app.commandLine.hasSwitch('disable-gpu') || app.commandLine.hasSwitch('disable-software-rasterizer')) return false;
    }
    return true;
  }

  static getPillWindowOptions(isWin11 = this.shouldUseNativeMaterials()) {
    const baseOptions = {
      width: 320,
      height: 32,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      focusable: false,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    };

    if (isWin11) {
      baseOptions.backgroundMaterial = 'acrylic';
      baseOptions.backgroundColor = '#00000000';
    } else {
      baseOptions.backgroundColor = '#121216E6';
    }

    return baseOptions;
  }

  static getSettingsWindowOptions(themeOrIsWin11 = this.shouldUseNativeMaterials()) {
    let isWin11 = false;
    let themeName = 'cyber-teal';
    if (typeof themeOrIsWin11 === 'boolean') {
      isWin11 = themeOrIsWin11;
      themeName = (typeof config !== 'undefined' && config.theme) || 'cyber-teal';
    } else if (typeof themeOrIsWin11 === 'string') {
      themeName = themeOrIsWin11;
      isWin11 = this.shouldUseNativeMaterials();
    } else {
      isWin11 = this.shouldUseNativeMaterials();
      themeName = (typeof config !== 'undefined' && config.theme) || 'cyber-teal';
    }

    const isDark = themeName === 'dark-obsidian' || themeName === 'cyber-teal' || themeName === 'dark';
    const baseOptions = {
      width: 1140,
      height: 760,
      minWidth: 960,
      minHeight: 640,
      title: 'Wispr Speak',
      titleBarStyle: 'hidden',
      frame: false,
      show: false,
      titleBarOverlay: {
        color: isWin11 ? '#00000000' : (isDark ? '#060d13' : '#f8f7f4'),
        symbolColor: isDark ? '#e6f2f8' : '#1c1917',
        height: 38,
      },
      icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    };

    if (isWin11) {
      baseOptions.backgroundMaterial = 'mica';
      baseOptions.backgroundColor = '#00000000';
    } else {
      baseOptions.backgroundColor = isDark ? '#060d13' : '#1e1e24';
    }

    return baseOptions;
  }

  static getWelcomeWindowOptions() {
    const isWin11 = this.shouldUseNativeMaterials();
    const options = {
      width: 520,
      height: 560,
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: 'Welcome to Wispr Speak',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    };

    if (isWin11) {
      options.backgroundMaterial = 'mica';
      options.backgroundColor = '#00000000';
    }

    return options;
  }
}

class MaterialBoundaryManager {
  static resolveMaterialSettings(platform, win11Build, isHighContrast = false, isGpuDisabled = false) {
    if (platform !== 'win32') {
      return { material: 'none', note: 'non-windows-platform' };
    }
    if (isHighContrast) {
      return { material: 'none', highContrastActive: true, note: 'high-contrast-fallback' };
    }
    if (isGpuDisabled) {
      return { material: 'none', note: 'software-compositing' };
    }
    if (win11Build >= 22000) {
      return { pill: 'acrylic', settings: 'mica' };
    }
    return { material: 'none', note: 'windows-10-or-lower' };
  }
}

const THEMES = {
  'cyber-teal': {
    '--bg-primary': '#060d13',
    '--text-primary': '#e6f2f8',
    '--accent-color': '#14b8a6',
    '--border-subtle': '#142738',
    '--bg': '#060d13',
    '--sidebar': '#0a141d',
    '--card-bg': '#0f1d29',
    '--card-border': '#162c3d',
    '--card-hover-border': '#234763',
    '--text': '#e6f2f8',
    '--text-muted': '#82a3b8',
    '--text-dim': '#4d7185',
    '--nav-active': '#132737',
    '--accent': '#14b8a6',
    '--accent-hover': '#0d9488',
    '--accent-light': 'rgba(20, 184, 166, 0.12)',
    '--pill-bg': 'rgba(18, 18, 22, 0.65)',
    '--pill-border': 'rgba(255, 255, 255, 0.08)',
    '--pill-border-top': 'rgba(255, 255, 255, 0.20)',
    '--pill-text': '#ffffff',
    '--pill-accent': '#14b8a6',
  },
  'dark-obsidian': {
    '--bg-primary': '#080a0f',
    '--text-primary': '#f1f5f9',
    '--accent-color': '#38bdf8',
    '--border-subtle': '#1a2234',
    '--bg': '#080a0f',
    '--sidebar': '#0e121a',
    '--card-bg': '#131824',
    '--card-border': '#1e2638',
    '--card-hover-border': '#2c3852',
    '--text': '#f1f5f9',
    '--text-muted': '#94a3b8',
    '--text-dim': '#64748b',
    '--nav-active': '#1a2232',
    '--accent': '#38bdf8',
    '--accent-hover': '#0ea5e9',
    '--accent-light': 'rgba(56, 189, 248, 0.12)',
    '--pill-bg': 'rgba(12, 14, 20, 0.70)',
    '--pill-border': 'rgba(255, 255, 255, 0.08)',
    '--pill-border-top': 'rgba(255, 255, 255, 0.22)',
    '--pill-text': '#ffffff',
    '--pill-accent': '#38bdf8',
  },
  'warm-light': {
    '--bg-primary': '#f8f7f4',
    '--text-primary': '#1c1917',
    '--accent-color': '#0f766e',
    '--border-subtle': '#eae6dd',
    '--bg': '#f8f7f4',
    '--sidebar': '#f1eee7',
    '--card-bg': '#ffffff',
    '--card-border': '#e6e2d8',
    '--card-hover-border': '#cbd5e1',
    '--text': '#1c1917',
    '--text-muted': '#78716c',
    '--text-dim': '#a8a29e',
    '--nav-active': '#e6e1d6',
    '--accent': '#0f766e',
    '--accent-hover': '#115e59',
    '--accent-light': 'rgba(15, 118, 110, 0.10)',
    '--pill-bg': 'rgba(255, 255, 255, 0.85)',
    '--pill-border': 'rgba(0, 0, 0, 0.10)',
    '--pill-border-top': 'rgba(255, 255, 255, 0.95)',
    '--pill-text': '#1c1917',
    '--pill-accent': '#0f766e',
  },
  'slate-clean': {
    '--bg-primary': '#f8fafc',
    '--text-primary': '#0f172a',
    '--accent-color': '#2563eb',
    '--border-subtle': '#e2e8f0',
    '--bg': '#f8fafc',
    '--sidebar': '#f1f5f9',
    '--card-bg': '#ffffff',
    '--card-border': '#e2e8f0',
    '--card-hover-border': '#cbd5e1',
    '--text': '#0f172a',
    '--text-muted': '#64748b',
    '--text-dim': '#94a3b8',
    '--nav-active': '#e2e8f0',
    '--accent': '#2563eb',
    '--accent-hover': '#1d4ed8',
    '--accent-light': 'rgba(37, 99, 235, 0.10)',
    '--pill-bg': 'rgba(255, 255, 255, 0.88)',
    '--pill-border': 'rgba(0, 0, 0, 0.10)',
    '--pill-border-top': 'rgba(255, 255, 255, 0.95)',
    '--pill-text': '#0f172a',
    '--pill-accent': '#2563eb',
  },
  'dark': {
    '--bg-primary': '#121216',
    '--text-primary': '#f0f0f5',
    '--accent-color': '#6366f1',
    '--border-subtle': '#272730',
    '--bg': '#121216',
    '--sidebar': '#0e0e12',
    '--card-bg': '#19191f',
    '--card-border': '#272730',
    '--card-hover-border': '#393946',
    '--text': '#f0f0f5',
    '--text-muted': '#9ca3af',
    '--text-dim': '#6b7280',
    '--nav-active': '#22222a',
    '--accent': '#6366f1',
    '--accent-hover': '#4f46e5',
    '--accent-light': 'rgba(99, 102, 241, 0.12)',
    '--pill-bg': 'rgba(18, 18, 22, 0.65)',
    '--pill-border': 'rgba(255, 255, 255, 0.08)',
    '--pill-border-top': 'rgba(255, 255, 255, 0.20)',
    '--pill-text': '#ffffff',
    '--pill-accent': '#6366f1',
  },
  'light': {
    '--bg-primary': '#f8f9fa',
    '--text-primary': '#111827',
    '--accent-color': '#4f46e5',
    '--border-subtle': '#e5e7eb',
    '--bg': '#f8f9fa',
    '--sidebar': '#f1f3f5',
    '--card-bg': '#ffffff',
    '--card-border': '#e5e7eb',
    '--card-hover-border': '#d1d5db',
    '--text': '#111827',
    '--text-muted': '#6b7280',
    '--text-dim': '#9ca3af',
    '--nav-active': '#e9ecef',
    '--accent': '#4f46e5',
    '--accent-hover': '#4338ca',
    '--accent-light': 'rgba(79, 70, 229, 0.10)',
    '--pill-bg': 'rgba(255, 255, 255, 0.88)',
    '--pill-border': 'rgba(0, 0, 0, 0.10)',
    '--pill-border-top': 'rgba(255, 255, 255, 0.95)',
    '--pill-text': '#111827',
    '--pill-accent': '#4f46e5',
  },
};

function resolveEffectiveTheme(themeName) {
  if (themeName === 'system') {
    const isDark = (typeof nativeTheme !== 'undefined' && nativeTheme.shouldUseDarkColors);
    return isDark ? 'cyber-teal' : 'slate-clean';
  }
  if (THEMES[themeName]) {
    return themeName;
  }
  return 'dark-obsidian';
}

function broadcastTheme(themeName) {
  const effectiveTheme = resolveEffectiveTheme(themeName);
  const variables = THEMES[effectiveTheme] || THEMES['dark-obsidian'];
  const isDark = effectiveTheme === 'cyber-teal' || effectiveTheme === 'dark-obsidian' || effectiveTheme === 'dark';

  if (typeof nativeTheme !== 'undefined' && nativeTheme) {
    try { nativeTheme.themeSource = isDark ? 'dark' : 'light'; } catch {}
  }
  updateTitleBarTheme(effectiveTheme);

  const payload = {
    theme: themeName,
    effectiveTheme,
    isDark,
    variables,
    hasNativeMaterial: WindowMaterialConfigurator.shouldUseNativeMaterials(),
    timestamp: Date.now(),
  };

  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    if (!win.isDestroyed() && win.webContents) {
      try {
        win.webContents.send('theme-sync', payload);
      } catch {}
    }
  }

  return payload;
}

class MultiMonitorPhysicsBounds {
  static clampToDisplays(targetX, targetY, displays = [], pillSize = { width: 320, height: 44 }) {
    for (const d of displays) {
      const bounds = d.workArea;
      if (!bounds) continue;
      if (
        targetX >= bounds.x - 100 && targetX <= bounds.x + bounds.width &&
        targetY >= bounds.y - 100 && targetY <= bounds.y + bounds.height
      ) {
        const clampedX = Math.max(bounds.x + 10, Math.min(bounds.x + bounds.width - pillSize.width - 10, targetX));
        const clampedY = Math.max(bounds.y + 10, Math.min(bounds.y + bounds.height - pillSize.height - 10, targetY));
        return { x: clampedX, y: clampedY, displayId: d.id, reset: false };
      }
    }

    const primary = (displays && displays.find(d => d.isPrimary)) || (displays && displays[0]) || { workArea: { x: 0, y: 0, width: 1920, height: 1080 }, id: 1 };
    return {
      x: primary.workArea.x + Math.floor((primary.workArea.width - pillSize.width) / 2),
      y: primary.workArea.y + primary.workArea.height - pillSize.height - 85,
      displayId: primary.id,
      reset: true
    };
  }

  static capVelocity(vx, vy, maxSpeed = 3000) {
    const speed = Math.sqrt(vx * vx + vy * vy);
    if (speed > maxSpeed) {
      const ratio = maxSpeed / speed;
      return { vx: vx * ratio, vy: vy * ratio, capped: true };
    }
    return { vx, vy, capped: false };
  }
}

let savePosTimer = null;
function debouncedSavePillPosition(x, y) {
  clearTimeout(savePosTimer);
  savePosTimer = setTimeout(() => {
    config.pillPosition = { x, y };
    saveConfig();
    log('pill position persisted:', config.pillPosition);
  }, 400);
}

// ---------- pill window ----------
function repositionPill() {
  if (!pill || pill.isDestroyed()) return;
  try {
    if (config.pillPosition && typeof config.pillPosition.x === 'number' && typeof config.pillPosition.y === 'number') {
      const displays = (typeof screen !== 'undefined' && typeof screen.getAllDisplays === 'function')
        ? screen.getAllDisplays()
        : ((typeof screen !== 'undefined' && typeof screen.getPrimaryDisplay === 'function') ? [screen.getPrimaryDisplay()] : []);
      const clamped = MultiMonitorPhysicsBounds.clampToDisplays(
        config.pillPosition.x,
        config.pillPosition.y,
        displays
      );
      pill.setPosition(clamped.x, clamped.y);
      return;
    }
    const cursor = (typeof screen !== 'undefined' && typeof screen.getCursorScreenPoint === 'function')
      ? screen.getCursorScreenPoint()
      : { x: 0, y: 0 };
    const currentDisplay = (typeof screen !== 'undefined' && typeof screen.getDisplayNearestPoint === 'function')
      ? screen.getDisplayNearestPoint(cursor)
      : ((typeof screen !== 'undefined' && typeof screen.getPrimaryDisplay === 'function')
        ? screen.getPrimaryDisplay()
        : { workArea: { x: 0, y: 0, width: 1920, height: 1080 } });
    const { x, y, width, height } = (currentDisplay && currentDisplay.workArea) || { x: 0, y: 0, width: 1920, height: 1080 };
    const pillWidth = 320;
    const posX = Math.round(x + (width - pillWidth) / 2);
    const posY = Math.round(y + height - 85);
    pill.setPosition(posX, posY);
  } catch (err) {
    log('repositionPill error:', err.message);
  }
}

function createPill() {
  const options = WindowMaterialConfigurator.getPillWindowOptions();
  // Ensure the floating pill window is 100% transparent.
  // Native DWM backgroundMaterial ('acrylic' or 'mica') causes Windows to draw an opaque/acrylic
  // rectangular sheet across the entire window bounding box, showing an annoying grey box underneath.
  delete options.backgroundMaterial;
  options.backgroundColor = '#00000000';
  pill = new BrowserWindow(options);
  pill.webContents.on('did-finish-load', () => {
    pillReady = true;
    setupAudioVizChannel();
  });
  pill.loadFile(path.join(__dirname, 'renderer', 'pill.html'));
  repositionPill();
}

function setPill(state, label, transcript, opts = {}) {
  if (!pill) return;
  if (state === 'hidden') { pill.hide(); return; }
  repositionPill();
  const offline = opts.offline !== undefined ? opts.offline : isOfflineMode;
  pill.webContents.send('pill-state', { state, label, transcript, offline });
  if (!pill.isVisible()) pill.showInactive();
}

// ---------- main dashboard & settings window ----------
function updateTitleBarTheme(themeName) {
  if (!settingsWin || settingsWin.isDestroyed()) return;
  try {
    const useNative = WindowMaterialConfigurator.shouldUseNativeMaterials();
    const isDark = themeName === 'dark-obsidian' || themeName === 'cyber-teal' || themeName === 'dark';
    settingsWin.setTitleBarOverlay({
      color: useNative ? '#00000000' : (isDark ? '#060d13' : '#f8f7f4'),
      symbolColor: isDark ? '#e6f2f8' : '#1c1917',
      height: 38,
    });
  } catch {}
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (settingsWin.isMinimized()) settingsWin.restore();
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  const options = WindowMaterialConfigurator.getSettingsWindowOptions(config.theme);
  settingsWin = new BrowserWindow(options);

  settingsWin.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      settingsWin.hide();
    }
  });

  settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'));

  settingsWin.once('ready-to-show', () => {
    settingsWin.center();
    settingsWin.show();
  });
}

function showWelcome() {
  const options = WindowMaterialConfigurator.getWelcomeWindowOptions();
  welcomeWin = new BrowserWindow(options);
  welcomeWin.loadFile(path.join(__dirname, 'renderer', 'welcome.html'));
}

// ---------- hidden audio capture window ----------
function createCaptureWin() {
  captureWin = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  captureWin.webContents.on('did-finish-load', () => {
    captureReady = true;
    setupAudioVizChannel();
  });
  captureWin.loadFile(path.join(__dirname, 'renderer', 'capture.html'));
}

// ---------- text injection ----------
function pasteViaHelper() {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(PASTE_HELPER)) return reject(new Error('helper not built'));
    const args = targetHwnd ? ['--restore-window', targetHwnd] : [];
    const p = spawn(PASTE_HELPER, args, { windowsHide: true });
    let out = '', err = '';
    const to = setTimeout(() => { try { p.kill(); } catch {} reject(new Error('paste helper timeout')); }, 10000);
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (err += d));
    p.on('error', e => { clearTimeout(to); reject(e); });
    p.on('close', code => { clearTimeout(to); code === 0 ? resolve(out) : reject(new Error('paste helper: ' + err.trim())); });
  });
}

async function pasteViaNut() {
  try {
    const { keyboard, Key } = require('@nut-tree-fork/nut-js');
    keyboard.config.autoDelayMs = 5;
    await keyboard.pressKey(Key.LeftControl, Key.V);
    await keyboard.releaseKey(Key.LeftControl, Key.V);
  } catch (err) {
    log('pasteViaNut error:', err.message);
  }
}

function copyViaHelper() {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(PASTE_HELPER)) return reject(new Error('helper not built'));
    const args = targetHwnd ? ['--copy', '--restore-window', targetHwnd] : ['--copy'];
    const p = spawn(PASTE_HELPER, args, { windowsHide: true });
    let out = '', err = '';
    const to = setTimeout(() => { try { p.kill(); } catch {} reject(new Error('copy helper timeout')); }, 4000);
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (err += d));
    p.on('error', e => { clearTimeout(to); reject(e); });
    p.on('close', code => { clearTimeout(to); code === 0 ? resolve(out) : reject(new Error('copy helper: ' + err.trim())); });
  });
}

function detectTargetWindow() {
  return new Promise(resolve => {
    if (!fs.existsSync(PASTE_HELPER)) return resolve(null);
    const p = spawn(PASTE_HELPER, ['--detect-only'], { windowsHide: true });
    const to = setTimeout(() => { try { p.kill(); } catch {} resolve(null); }, 3000);
    let out = '';
    p.stdout.on('data', d => (out += d));
    p.on('close', () => {
      clearTimeout(to);
      const hwndMatch = out.match(/TARGET\s+(0x[0-9a-fA-F]+|[0-9a-fA-F]+)/);
      const classMatch = out.match(/WINDOW_CLASS\s+([^\r\n]+)/);
      const exeMatch = out.match(/EXE_NAME\s+([^\r\n]+)/);
      const titleMatch = out.match(/WINDOW_TITLE\s+([^\r\n]*)/);
      const termMatch = out.match(/IS_TERMINAL\s+(true|false)/i);

      targetInfo = {
        hwnd: hwndMatch ? hwndMatch[1] : null,
        windowClass: classMatch ? classMatch[1].trim() : '',
        exeName: exeMatch ? exeMatch[1].trim() : '',
        windowTitle: titleMatch ? titleMatch[1].trim() : '',
        isTerminal: termMatch ? termMatch[1].toLowerCase() === 'true' : false,
      };
      targetHwnd = targetInfo.hwnd;
      resolve(targetInfo.hwnd);
    });
    p.on('error', () => { clearTimeout(to); resolve(null); });
  });
}

function getClipboardSequenceNumber() {
  if (typeof clipboard.getClipboardSequenceNumber === 'function') {
    return Promise.resolve(clipboard.getClipboardSequenceNumber());
  }
  return new Promise(resolve => {
    if (!fs.existsSync(PASTE_HELPER)) return resolve(null);
    const p = spawn(PASTE_HELPER, ['--get-seq'], { windowsHide: true });
    let out = '';
    const to = setTimeout(() => { try { p.kill(); } catch {} resolve(null); }, 1500);
    p.stdout.on('data', d => (out += d));
    p.on('close', code => {
      clearTimeout(to);
      if (code === 0) {
        const m = out.match(/CLIPBOARD_SEQ\s+(\d+)/);
        if (m) return resolve(parseInt(m[1], 10));
      }
      resolve(null);
    });
    p.on('error', () => {
      clearTimeout(to);
      resolve(null);
    });
  });
}

function typeViaHelper(text) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(PASTE_HELPER)) return reject(new Error('helper not built'));
    const args = targetHwnd ? ['--type-stdin', '--restore-window', targetHwnd] : ['--type-stdin'];
    const p = spawn(PASTE_HELPER, args, { windowsHide: true });

    let err = '';
    const to = setTimeout(() => {
      try { p.kill(); } catch {}
      reject(new Error('typing helper timeout'));
    }, 15000);

    p.stderr.on('data', d => (err += d));
    p.on('error', e => { clearTimeout(to); reject(e); });
    p.on('close', code => {
      clearTimeout(to);
      if (code === 0) resolve();
      else reject(new Error('typing helper failed: ' + err.trim()));
    });

    p.stdin.write(text, 'utf8');
    p.stdin.end();
  });
}

async function injectText(text) {
  const animEnabled = (typeof config !== 'undefined' && config && config.typingAnimation === true);
  const maxLen = (typeof config !== 'undefined' && config && config.maxAnimatedLength) || 200;
  const isShortText = text.length > 0 && text.length <= maxLen;
  const useAnimation = animEnabled && isShortText;

  if (useAnimation) {
    try {
      await typeViaHelper(text);
      log('inject: animated typing successful');
      return;
    } catch (err) {
      log('animated typing failed, falling back to clipboard paste:', err.message);
    }
  }

  const formats = clipboard.availableFormats();
  let prevImage = null;
  let prevHtml = null;
  let prevRtf = null;
  let prevText = null;

  try {
    if (formats.includes('image/png') || formats.includes('image/jpeg')) {
      const img = clipboard.readImage();
      if (!img.isEmpty()) prevImage = img;
    }
    if (formats.includes('text/html')) prevHtml = clipboard.readHTML();
    if (formats.includes('text/rtf')) prevRtf = clipboard.readRTF();
    if (formats.includes('text/plain')) prevText = clipboard.readText();
  } catch (err) {
    log('warning: clipboard snapshot failed:', err.message);
  }

  clipboard.writeText(text);
  const seqAfter = await getClipboardSequenceNumber();

  await new Promise(r => setTimeout(r, 60));

  try {
    await pasteViaHelper();
    log('inject: native helper OK');
  } catch (e) {
    log('inject: helper failed (' + e.message + '), nut-js fallback');
    await pasteViaNut();
  }

  setTimeout(async () => {
    try {
      const currentSeq = await getClipboardSequenceNumber();
      if (seqAfter !== null && currentSeq !== null && currentSeq !== seqAfter) {
        log('inject: clipboard sequence changed (' + currentSeq + ' !== ' + seqAfter + '), preserving user copy, aborting restore');
        return;
      }

      if (prevImage) {
        clipboard.writeImage(prevImage);
      } else if (prevHtml || prevRtf) {
        const payload = {};
        if (prevText) payload.text = prevText;
        if (prevHtml) payload.html = prevHtml;
        if (prevRtf) payload.rtf = prevRtf;
        clipboard.write(payload);
      } else if (prevText !== null && prevText !== undefined) {
        clipboard.writeText(prevText);
      } else {
        clipboard.clear();
      }
      log('inject: clipboard restored');
    } catch (restoreErr) {
      log('warning: clipboard restore failed:', restoreErr.message);
    }
  }, 600);
}

// ---------- Streaming Transcription Pipeline & Boundary Stitching ----------

/**
 * Normalizes a word token for acoustic boundary alignment.
 */
function normalizeToken(token) {
  return String(token || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Computes normalized Levenshtein similarity between two single words [0.0 - 1.0].
 */
function wordSimilarity(a, b) {
  if (a === b) return 1.0;
  if (!a || !b) return 0.0;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 2) return 0.0;

  const dp = Array.from({ length: la + 1 }, () => new Array(lb + 1).fill(0));
  for (let i = 0; i <= la; i++) dp[i][0] = i;
  for (let j = 0; j <= lb; j++) dp[0][j] = j;

  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  const dist = dp[la][lb];
  const maxLen = Math.max(la, lb);
  return 1.0 - dist / maxLen;
}

/**
 * Stitches two overlapping transcripts without repeating or dropping boundary words.
 * Prefers nextText in the overlap zone to utilize forward acoustic context.
 */
function stitchTranscripts(prevText, nextText) {
  const p = String(prevText || '').trim();
  const n = String(nextText || '').trim();
  if (!p) return n;
  if (!n) return p;

  const wordsA = p.split(/\s+/);
  const wordsB = n.split(/\s+/);
  const normA = wordsA.map(normalizeToken);
  const normB = wordsB.map(normalizeToken);

  const maxCheck = Math.min(wordsA.length, wordsB.length, 6);
  let bestOverlap = 0;
  let bestMatchScore = 0;

  // Search for the longest matching overlap window from maxCheck down to 1
  for (let len = maxCheck; len >= 1; len--) {
    const subA = normA.slice(normA.length - len);
    const subB = normB.slice(0, len);

    let matchWeight = 0;
    for (let i = 0; i < len; i++) {
      if (subA[i] === subB[i]) {
        matchWeight += 1.0;
      } else if (wordSimilarity(subA[i], subB[i]) >= 0.75) {
        matchWeight += 0.8;
      }
    }

    const score = matchWeight / len;
    if (score >= 0.75 && score > bestMatchScore) {
      bestOverlap = len;
      bestMatchScore = score;
      break;
    }
  }

  // Handle case where Chunk 0's final word was cut off mid-speech
  if (bestOverlap === 0 && wordsA.length >= 2 && wordsB.length >= 2) {
    for (let len = Math.min(wordsA.length - 1, wordsB.length, 4); len >= 1; len--) {
      const subA = normA.slice(normA.length - 1 - len, normA.length - 1);
      const subB = normB.slice(0, len);

      let matchWeight = 0;
      for (let i = 0; i < len; i++) {
        if (subA[i] === subB[i]) matchWeight += 1.0;
      }
      if (matchWeight / len >= 0.8) {
        // Discard truncated trailing word from wordsA
        return wordsA.slice(0, wordsA.length - 1 - len).concat(wordsB).join(' ');
      }
    }
  }

  if (bestOverlap > 0) {
    // Keep wordsA up to the overlap point, then append wordsB
    const retainedA = wordsA.slice(0, wordsA.length - bestOverlap);
    return retainedA.concat(wordsB).join(' ');
  }

  // Fallback: clean boundary concatenation
  return p + ' ' + n;
}

// Active streaming session state
let activeStreamSession = null;

function createStreamSession() {
  const sessionId = Date.now().toString(36);
  activeStreamSession = {
    id: sessionId,
    chunkPromises: [],
    transcripts: [],
    error: null,
    finalResolve: null,
    finalReject: null,
    fullTranscriptPromise: null,
    startTime: Date.now(),
  };
  activeStreamSession.fullTranscriptPromise = new Promise((resolve, reject) => {
    activeStreamSession.finalResolve = resolve;
    activeStreamSession.finalReject = reject;
  });
  return activeStreamSession;
}

/**
 * Transcribes a single audio chunk with Groq Whisper, conditioning on prior text.
 */
async function transcribeChunk(wavBuffer, promptText = '') {
  if (!wavBuffer || wavBuffer.byteLength < 44) return '';
  if (!config.groqKey) throw new Error(NEEDS_KEY);

  const formFields = {
    model: config.whisperModel || GROQ_STT_MODEL,
    response_format: 'json',
    language: 'en',
    temperature: '0.0',
  };

  const dictGlossary = buildWhisperPromptBounded(config.dictionary, 250);
  let promptStr = '';
  if (promptText) {
    promptStr = (dictGlossary ? `Vocabulary: ${dictGlossary}. ` : '') + promptText.slice(-150);
  } else {
    promptStr = dictGlossary
      ? `Spoken English dictation context with custom vocabulary: ${dictGlossary}.`
      : 'Clean, properly punctuated spoken English dictation.';
  }
  formFields.prompt = promptStr;

  const mp = buildMultipart(formFields, 'file', 'chunk.wav', wavBuffer, 'audio/wav');
  const response = await groqPost('/openai/v1/audio/transcriptions', {
    body: mp.body,
    contentType: mp.contentType,
    timeoutMs: 15000,
  });

  if (response.status !== 200) {
    throw new Error(groqError('Transcription chunk', response.status));
  }

  const result = JSON.parse(response.body);
  return (result.text || '').trim();
}

// IPC listener for incoming progressive chunks
ipcMain.on('capture-chunk', async (_event, payload) => {
  const { chunkIndex, isFinal, wavBuffer, durationMs } = payload;
  // Only create a session if none exists. Do NOT recreate on chunkIndex===0
  // because executeAudioPipeline already holds a reference to the current session's
  // fullTranscriptPromise. Recreating would orphan that promise and cause a 25s timeout.
  if (!activeStreamSession) {
    createStreamSession();
  }
  const session = activeStreamSession;
  if (!session) return;

  log(`streaming: received chunk ${chunkIndex}, isFinal=${isFinal}, duration=${durationMs}ms`);

  if (wavBuffer && wavBuffer.byteLength > 44) {
    const priorContext = session.transcripts[chunkIndex - 1] || '';
    const chunkPromise = transcribeChunk(Buffer.from(wavBuffer), priorContext)
      .then(text => {
        session.transcripts[chunkIndex] = text;
        log(`streaming: chunk ${chunkIndex} transcript: "${text}"`);
        return text;
      })
      .catch(err => {
        log(`streaming: chunk ${chunkIndex} failed: ${err.message}`);
        if (!session.error) session.error = err;
        session.transcripts[chunkIndex] = '';
        return '';
      });

    session.chunkPromises[chunkIndex] = chunkPromise;
  } else {
    session.chunkPromises[chunkIndex] = Promise.resolve('');
  }

  if (isFinal) {
    try {
      await Promise.all(session.chunkPromises);
      let combined = '';
      for (let i = 0; i < session.transcripts.length; i++) {
        const piece = session.transcripts[i] || '';
        combined = stitchTranscripts(combined, piece);
      }
      if (!combined && session.error) {
        session.finalReject(session.error);
      } else {
        session.finalResolve(combined);
      }
    } catch (err) {
      session.finalReject(err);
    }
  }
});

// ---------- Audio Pipeline Execution ----------
async function executeAudioPipeline() {
  const releaseTimestamp = Date.now();
  const session = activeStreamSession;
  const pipelineId = ++currentPipelineId;

  try {
    let raw = '';
    let usedOffline = false;

    let capturedCompressedAudio = null;
    // Start listening for full WAV buffer concurrently from capture window
    const wavBufferPromise = new Promise((resolve) => {
      const to = setTimeout(() => resolve(null), 30000);
      ipcMain.once('capture-data', (_e, buf, compressedBuf) => {
        clearTimeout(to);
        if (compressedBuf && (compressedBuf.byteLength > 0 || (compressedBuf.length && compressedBuf.length > 0))) {
          capturedCompressedAudio = Buffer.from(compressedBuf);
        }
        resolve(buf && buf.byteLength > 0 ? Buffer.from(buf) : null);
      });
    });

    if (captureWin && !captureWin.isDestroyed()) {
      captureWin.webContents.send('capture-stop');
    } else if (session) {
      session.finalResolve('');
    }

    const now = Date.now();
    const inOfflineCooldown = isOfflineMode && (now - lastOfflineTime < OFFLINE_RETRY_COOLDOWN_MS);

    if (session && !inOfflineCooldown && config.groqKey) {
      try {
        raw = await Promise.race([
          session.fullTranscriptPromise,
          new Promise((_, reject) => setTimeout(() => reject(new Error('Streaming transcription timeout')), 25000))
        ]);
        isOfflineMode = false;
        lastOfflineTime = 0;

        if (!raw) {
          const fullWav = await wavBufferPromise;
          if (fullWav && fullWav.length >= 5000) {
            log('streaming returned empty string, trying batch fallback');
            raw = await transcribe(fullWav);
            usedOffline = false;
          }
        }
      } catch (streamErr) {
        log('streaming transcription failed:', streamErr.message);
        const fullWav = await wavBufferPromise;
        if (fullWav && fullWav.length >= 5000) {
          try {
            log('falling back to batch transcription after streaming failure');
            raw = await transcribe(fullWav);
            usedOffline = false;
          } catch (batchErr) {
            log('batch fallback failed:', batchErr.message);
            if (isLocalWhisperAllowed()) {
              log('falling back to local whisper.cpp after batch failure');
              isOfflineMode = true;
              lastOfflineTime = Date.now();
              usedOffline = true;
              setPill('working', 'Offline mode', null, { offline: true });
              const dictPrompt = buildWhisperPromptBounded(config.dictionary, 800);
              raw = await localWhisper.transcribeLocal(fullWav, { prompt: dictPrompt });
            } else {
              throw batchErr;
            }
          }
        } else {
          throw streamErr;
        }
      }
    } else {
      const wavBuffer = await wavBufferPromise;
      if (!wavBuffer || wavBuffer.length < 5000) {
        log('capture: too short or rejected by VAD, ignoring');
        setPill('hidden');
        return;
      }
      try {
        if (!config.groqKey || inOfflineCooldown) {
          if (isLocalWhisperAllowed()) {
            isOfflineMode = true;
            usedOffline = true;
            setPill('working', 'Offline mode', null, { offline: true });
            const dictPrompt = buildWhisperPromptBounded(config.dictionary, 800);
            raw = await localWhisper.transcribeLocal(wavBuffer, { prompt: dictPrompt });
          } else {
            throw new Error(NEEDS_KEY);
          }
        } else {
          raw = await transcribe(wavBuffer);
          usedOffline = isOfflineMode;
        }
      } catch (sttErr) {
        if (isLocalWhisperAllowed()) {
          log('falling back to local whisper.cpp after batch failure:', sttErr.message);
          isOfflineMode = true;
          lastOfflineTime = Date.now();
          usedOffline = true;
          setPill('working', 'Offline mode', null, { offline: true });
          const dictPrompt = buildWhisperPromptBounded(config.dictionary, 800);
          raw = await localWhisper.transcribeLocal(wavBuffer, { prompt: dictPrompt });
        } else {
          throw sttErr;
        }
      }
    }

    const latencyMs = Date.now() - releaseTimestamp;
    log(`pipeline: transcript assembled in ${latencyMs}ms (offline=${usedOffline}): "${raw}"`);

    if (!raw || raw.trim().length === 0) {
      log('pipeline: transcript empty (non-speech rejected), hiding pill');
      setPill('hidden');
      return;
    }

    voiceEngine.setCommands(config.voiceCommands || DEFAULT_COMMANDS);
    const cmd = voiceEngine.evaluate(raw);
    if (cmd.scratch) { await scratchLast(); return; }
    if (cmd.action === 'undo') { await undoLast(); return; }
    if (cmd.action === 'delete-word') { await deleteWord(); return; }
    if (cmd.action === 'delete-sentence') { await deleteSentence(); return; }
    if (cmd.action === 'select-all') { await selectAllText(); return; }
    if (cmd.action === 'copy') { await copyTextAction(); return; }
    if (cmd.action === 'paste') { await pasteTextAction(); return; }
    if (cmd.action === 'quote-that') { await quoteLastText(); return; }

    const formattedRaw = cmd.command ? cmd.text : formatText(cmd.text);
    let clean = formattedRaw;

    if (!cmd.command && !isOfflineMode && !usedOffline) {
      try {
        clean = await smartPolish(formattedRaw);
      } catch (polishErr) {
        log('smartPolish failed, falling back to formatted text:', polishErr.message);
        clean = formattedRaw;
      }
    }
    clean = applyDictionary(clean, config.dictionary);
    clean = cleanTrailingPeriod(clean);
    if (pipelineId !== currentPipelineId) { log('pipeline aborted'); return; }

    if (clean) {
      await injectText(clean);
      let curClip = ''; try { curClip = clipboard.readText().trim(); } catch {} lastInject = { text: clean, time: Date.now(), initialClipboard: curClip };
      addHistoryItem(clean, latencyMs, {
        offline: isOfflineMode || usedOffline,
        compressedAudioBuffer: capturedCompressedAudio,
      });
      setPill('done', null, clean, { offline: isOfflineMode || usedOffline });
      log(`pipeline: injected text, total post-release latency: ${Date.now() - releaseTimestamp}ms`);
    } else {
      setPill('hidden');
    }
  } catch (err) {
    log('pipeline error:', err.message);
    if (err.message === NEEDS_KEY) {
      setPill('error', 'Add your Groq key in Settings');
      openSettings();
    } else {
      setPill('error', 'Oops: ' + String(err.message).slice(0, 50));
    }
  } finally {
    activeStreamSession = null;
    enqueueHotkeyEvent('PROCESSING_DONE');
  }
}

async function executePolishSelectionPipeline() {
  try {
    await onPolishSelection();
  } finally {
    enqueueHotkeyEvent('PROCESSING_DONE');
  }
}

// ---------- Rapid Hotkey Event Queue & State Machine ----------

class HotkeyStateMachine {
  constructor(options = {}) {
    this.state = 'IDLE';
    this.queue = [];
    this.history = [];
    this.droppedEvents = 0;
    this.maxQueueSize = options.maxQueueSize || 100;
    this.isKeyHeld = options.isKeyHeld || (options.heldKeys ? () => options.heldKeys.size > 0 : null);
  }

  logTransition(from, to, trigger) {
    this.history.push({ from, to, trigger, timestamp: Date.now() });
    this.state = to;
    currentState = to;
    syncLegacyState();
  }

  handleEvent(type, key) {
    const currentState = this.state;

    if (currentState === 'IDLE') {
      if (type === 'KEY_DOWN' && key === 'ptt') {
        this.logTransition('IDLE', 'LISTENING_PTT', 'KEY_DOWN(ptt)');
        return { action: 'capture-start' };
      }
      if (type === 'KEY_DOWN' && key === 'handsfree') {
        this.logTransition('IDLE', 'LISTENING_HANDSFREE', 'KEY_DOWN(handsfree)');
        return { action: 'capture-start' };
      }
    } else if (currentState === 'LISTENING_PTT') {
      if (type === 'KEY_UP' && key === 'ptt') {
        this.logTransition('LISTENING_PTT', 'PROCESSING', 'KEY_UP(ptt)');
        return { action: 'capture-stop' };
      }
      if (type === 'KEY_DOWN' && key === 'handsfree') {
        this.logTransition('LISTENING_PTT', 'LISTENING_HANDSFREE', 'KEY_DOWN(handsfree)');
        return { action: 'mode-switch' };
      }
    } else if (currentState === 'LISTENING_HANDSFREE') {
      if (type === 'KEY_DOWN' && key === 'handsfree') {
        this.logTransition('LISTENING_HANDSFREE', 'PROCESSING', 'KEY_DOWN(handsfree)');
        return { action: 'capture-stop' };
      }
      if (type === 'KEY_DOWN' && key === 'ptt') {
        this.logTransition('LISTENING_HANDSFREE', 'PROCESSING', 'KEY_DOWN(ptt)');
        return { action: 'capture-stop' };
      }
    } else if (currentState === 'PROCESSING' || currentState === 'QUEUED') {
      if (this.queue.length >= this.maxQueueSize) {
        this.droppedEvents++;
        return { action: 'dropped', queueLength: this.queue.length };
      }
      this.queue.push({ type, key, timestamp: Date.now() });
      if (this.state !== 'QUEUED') {
        this.logTransition('PROCESSING', 'QUEUED', `ENQUEUE(${type},${key})`);
      }
      return { action: 'enqueued', depth: this.queue.length };
    }

    return { action: 'ignored' };
  }

  completeProcessing(isKeyHeld = this.isKeyHeld) {
    this.drainCompletedMicroTaps();

    while (this.queue.length > 0) {
      // Discard orphaned KEY_UP events so they never trigger capture-start
      if (this.queue[0].type === 'KEY_UP') {
        const orphan = this.queue.shift();
        log('discarding orphaned KEY_UP event:', orphan);
        continue;
      }

      const nextEvent = this.queue[0];
      // Only KEY_DOWN should initiate a capture state
      if (nextEvent.type !== 'KEY_DOWN') {
        this.queue.shift();
        continue;
      }

      // For push-to-talk (ptt), verify whether the key is currently held down.
      // If the key was already released before dequeue, discard the press
      // rather than entering a phantom recording state.
      if (nextEvent.key === 'ptt' && typeof isKeyHeld === 'function') {
        const held = isKeyHeld('ptt');
        if (!held) {
          log('discarding stale PTT event because key is no longer held');
          this.queue.shift();
          // Also discard paired KEY_UP if queued
          if (this.queue.length > 0 && this.queue[0].type === 'KEY_UP' && this.queue[0].key === 'ptt') {
            this.queue.shift();
          }
          continue;
        }
      }

      // Valid KEY_DOWN to initiate capture
      this.queue.shift();
      const targetState = nextEvent.key === 'ptt' ? 'LISTENING_PTT' : 'LISTENING_HANDSFREE';
      this.logTransition(this.state, targetState, `DEQUEUE(${nextEvent.type},${nextEvent.key})`);
      return { action: 'capture-start', nextEvent };
    }

    this.logTransition(this.state, 'IDLE', 'PROCESSING_COMPLETE');
    return { action: 'idle' };
  }

  drainCompletedMicroTaps() {
    while (this.queue.length > 0 && this.queue[0].type === 'KEY_UP') {
      this.queue.shift();
    }
    while (this.queue.length >= 2) {
      const first = this.queue[0];
      const second = this.queue[1];
      if (first.type === 'KEY_DOWN' && second.type === 'KEY_UP' && first.key === second.key) {
        const duration = second.timestamp - first.timestamp;
        if (duration < 80) {
          log('coalescing micro-tap', duration + 'ms');
          this.queue.shift();
          this.queue.shift();
          continue;
        }
      }
      break;
    }
  }
}

const hotkeyFsm = new HotkeyStateMachine({
  isKeyHeld: (key) => {
    if (key === 'ptt') {
      const pttCombo = (typeof config !== 'undefined' && config.shortcuts?.pushToTalk) || ['Ctrl', 'Win'];
      return isComboHeld(pttCombo) || heldKeys.size > 0;
    }
    return true;
  },
});

function enqueueHotkeyEvent(type) {
  let fsmType = type;
  let fsmKey = 'ptt';

  if (type === 'PTT_DOWN') {
    fsmType = 'KEY_DOWN'; fsmKey = 'ptt';
  } else if (type === 'PTT_UP') {
    fsmType = 'KEY_UP'; fsmKey = 'ptt';
  } else if (type === 'HANDSFREE_TOGGLE') {
    fsmType = 'KEY_DOWN'; fsmKey = 'handsfree';
  } else if (type === 'PROCESSING_DONE') {
    const next = hotkeyFsm.completeProcessing();
    if (next.action === 'capture-start') {
      createStreamSession();
      setPill('listening');
      if (captureWin && !captureWin.isDestroyed()) captureWin.webContents.send('capture-start');
    }
    return;
  } else if (type === 'POLISH_SELECTION') {
    if (hotkeyFsm.state === 'IDLE') {
      hotkeyFsm.logTransition('IDLE', 'PROCESSING', 'POLISH_SELECTION');
      executePolishSelectionPipeline();
    }
    return;
  } else if (type === 'LEARN_SELECTION') {
    if (hotkeyFsm.state === 'IDLE') {
      executeLearnSelectionPipeline();
    }
    return;
  }

  const res = hotkeyFsm.handleEvent(fsmType, fsmKey);
  log('fsm event:', type, '->', res.action, 'state:', hotkeyFsm.state, 'queue:', hotkeyFsm.queue.length);

  if (res.action === 'capture-start') {
    detectTargetWindow().then(h => { targetHwnd = h; }).catch(() => {});
    createStreamSession();
    setPill('listening');
    if (captureWin && !captureWin.isDestroyed()) {
      captureWin.webContents.send('capture-start');
    }
  } else if (res.action === 'capture-stop') {
    setPill('working');
    executeAudioPipeline();
  } else if (res.action === 'mode-switch') {
    setPill('listening');
  }
}

// Global hotkey API adapters
async function onHotkeyDown(handsFreeMode = false) {
  if (handsFreeMode) {
    enqueueHotkeyEvent('HANDSFREE_TOGGLE');
  } else {
    enqueueHotkeyEvent('PTT_DOWN');
  }
}

async function onHotkeyUp() {
  if (hotkeyFsm.state === 'LISTENING_HANDSFREE') {
    enqueueHotkeyEvent('HANDSFREE_TOGGLE');
  } else {
    enqueueHotkeyEvent('PTT_UP');
  }
}


/**
 * Automatically learns vocabulary or symbol corrections between original dictation and user-corrected text.
 * Adds new rules to config.dictionary and saves config.
 */
function learnFromCorrection(original, corrected, source = 'auto') {
  if (!original || !corrected) return [];
  const corrections = extractDictionaryCorrections(original, corrected);
  if (!corrections || corrections.length === 0) return [];

  let addedCount = 0;
  if (!config.dictionary) config.dictionary = [];

  for (const item of corrections) {
    const from = String(item.from).trim();
    const to = String(item.to).trim();
    if (!from || !to || from === to) continue;

    // Check if an existing entry matches `from` (case-insensitive)
    const existingIndex = config.dictionary.findIndex(d => d && d.from && d.from.toLowerCase() === from.toLowerCase());
    if (existingIndex >= 0) {
      if (config.dictionary[existingIndex].to !== to) {
        config.dictionary[existingIndex].to = to;
        addedCount++;
      }
    } else {
      config.dictionary.push({ from, to });
      addedCount++;
    }
  }

  if (addedCount > 0) {
    saveConfig();
    log(`learned ${addedCount} correction(s) [${source}]:`, corrections);

    // Flash visual feedback on pill
    const learnedSummary = corrections.map(c => `${c.from} → ${c.to}`).slice(0, 2).join(', ');
    setPill('done', null, `Learned: ${learnedSummary}`);

    // Update settings window if open
    if (settingsWin && !settingsWin.isDestroyed()) {
      settingsWin.webContents.send('dictionary-updated', config.dictionary);
    }
  }

  return corrections;
}

let clipboardWatcherTimer = null;
let lastKnownClipboard = '';
try {
  lastKnownClipboard = clipboard.readText();
} catch {}

function setupClipboardWatcher() {
  if (clipboardWatcherTimer) return;
  clipboardWatcherTimer = setInterval(() => {
    try {
      if (!lastInject || !lastInject.text || (Date.now() - lastInject.time > 90000)) {
        return;
      }
      const current = clipboard.readText().trim();
      if (!current || current === lastKnownClipboard || current === lastInject.text || current === lastInject.initialClipboard) {
        return;
      }
      lastKnownClipboard = current;

      if (areTextsRelated(lastInject.text, current)) {
        log('clipboardWatcher: related correction detected, extracting...');
        const learned = learnFromCorrection(lastInject.text, current, 'clipboard-watcher');
        if (learned && learned.length > 0) {
          lastInject.text = current;
        }
      }
    } catch (e) {
      // Non-fatal clipboard read error
    }
  }, 750);
}

async function executeLearnSelectionPipeline() {
  if (busy || recording) return;
  busy = true;
  try {
    const prevText = clipboard.readText();
    clipboard.clear();
    let copyOk = false;
    try {
      await copyViaHelper();
      copyOk = true;
    } catch (e) {
      log('learn-selection: copyViaHelper fallback:', e.message);
    }
    if (!copyOk) {
      try {
        const { keyboard, Key } = require('@nut-tree-fork/nut-js');
        keyboard.config.autoDelayMs = 2;
        await keyboard.pressKey(Key.LeftControl, Key.C);
        await keyboard.releaseKey(Key.LeftControl, Key.C);
      } catch (nutErr) {}
    }

    let selectedText = '';
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 40));
      selectedText = clipboard.readText().trim();
      if (selectedText) break;
    }

    if (!selectedText) {
      if (prevText) clipboard.writeText(prevText);
      setPill('error', 'Select text first to learn');
      busy = false;
      return;
    }

    let baseText = (lastInject && (Date.now() - lastInject.time < 180000)) ? lastInject.text : null;
    if (!baseText && history && history.length > 0) {
      for (const item of history) {
        if (item.text && areTextsRelated(item.text, selectedText)) {
          baseText = item.text;
          break;
        }
      }
    }
    if (!baseText && lastInject && lastInject.text) {
      baseText = lastInject.text;
    }

    if (baseText) {
      const learned = learnFromCorrection(baseText, selectedText, 'hotkey-selection');
      if (learned && learned.length > 0) {
        const label = learned.map(l => `${l.from} → ${l.to}`).slice(0, 2).join(', ');
        setPill('done', null, `Learned: ${label}`);
      } else {
        setPill('done', null, 'No new rules found');
      }
    } else {
      setPill('error', 'No recent dictation to compare');
    }
  } catch (err) {
    log('learn-selection error:', err.message);
    setPill('error', 'Could not learn selection');
  } finally {
    busy = false;
  }
}

// ---------- selection polishing flow (Win + Alt + Q) ----------
async function onPolishSelection() {
  if (busy || recording) return;
  busy = true;

  try {
    targetHwnd = await detectTargetWindow();
    log('polish-selection: targetHwnd=' + targetHwnd);

    const prevText = clipboard.readText();

    // Clear clipboard temporarily so we can reliably detect newly copied text
    clipboard.clear();

    // Copy selected text via native helper (releases Win/Alt/Q modifiers and sends Ctrl+C)
    let copyOk = false;
    try {
      await copyViaHelper();
      log('polish-selection: native copy helper OK');
      copyOk = true;
    } catch (e) {
      log('polish-selection: native copy helper failed (' + e.message + '), falling back to nut-js');
    }

    if (!copyOk) {
      try {
        const { keyboard, Key } = require('@nut-tree-fork/nut-js');
        keyboard.config.autoDelayMs = 2;
        await keyboard.pressKey(Key.LeftControl, Key.C);
        await keyboard.releaseKey(Key.LeftControl, Key.C);
      } catch (nutErr) {
        log('polish-selection: nut-js fallback ignored:', nutErr.message);
      }
    }

    // Wait for clipboard to populate with copied text
    let selectedText = '';
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 40));
      selectedText = clipboard.readText().trim();
      if (selectedText) break;
    }

    if (!selectedText || selectedText.length < 2) {
      log('polish-selection: no text selected');
      if (prevText) clipboard.writeText(prevText);
      setPill('error', 'Select text first to polish');
      busy = false;
      return;
    }

    log('polish-selection: got', selectedText.length, 'chars');
    setPill('working');

    const t0 = Date.now();
    let polished = await polishSelectedText(selectedText);
    polished = cleanTrailingPeriod(polished);
    const durationMs = Date.now() - t0;
    log('polish-selection: polished in', durationMs, 'ms');

    if (polished && polished !== selectedText) {
      await injectText(polished);
      let curClipPol = ''; try { curClipPol = clipboard.readText().trim(); } catch {} lastInject = { text: polished, time: Date.now(), initialClipboard: curClipPol };
      addHistoryItem(polished, durationMs);
      setPill('done', null, 'Sentence polished ✓');
    } else {
      setPill('done', null, 'Already polished ✓');
    }
  } catch (err) {
    log('polish-selection error:', err.message);
    if (err.message === NEEDS_KEY) {
      setPill('error', 'Add your Groq key in Settings');
      openSettings();
    } else {
      setPill('error', String(err.message).slice(0, 50));
    }
  } finally {
    busy = false;
  }
}

// ---------- auto updater ----------
function initAutoUpdater() {
  try {
    const { autoUpdater } = require('electron-updater');

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;

    try {
      autoUpdater.setFeedURL({
        provider: 'github',
        owner: 'Yeamin-Sheikh',
        repo: 'wispr-tell'
      });
    } catch (feedErr) {
      log('autoUpdater: feed configuration note:', feedErr.message);
    }

    autoUpdater.on('checking-for-update', () => {
      log('autoUpdater: checking for update');
    });

    autoUpdater.on('update-available', (info) => {
      log('autoUpdater: update available, version', info && info.version);
    });

    autoUpdater.on('update-not-available', (info) => {
      log('autoUpdater: app up to date, version', info && info.version);
    });

    autoUpdater.on('download-progress', (progress) => {
      log('autoUpdater: download progress', Math.round(progress.percent) + '%', (progress.bytesPerSecond / 1024).toFixed(1) + ' KB/s');
    });

    autoUpdater.on('update-downloaded', (info) => {
      log('autoUpdater: update downloaded, version', info && info.version, '- will install on quit');
    });

    autoUpdater.on('error', (err) => {
      // Silent error handler: ignore offline and rate limit errors without crashing
      log('autoUpdater: update check error (ignored):', err && err.message);
    });

    setTimeout(() => {
      if (app.isPackaged || process.env.WISPR_CHECK_UPDATES === '1') {
        autoUpdater.checkForUpdates().catch(err => {
          log('autoUpdater: check error (ignored):', err.message);
        });
      } else {
        log('autoUpdater: skipping check in unpackaged dev environment');
      }
    }, 5000);
  } catch (err) {
    log('autoUpdater: initialization skipped:', err.message);
  }
}

// ---------- app lifecycle ----------
const gotSingleLock = app.requestSingleInstanceLock();
if (!gotSingleLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    openSettings();
  });

  app.whenReady().then(() => {
    // Cross-origin isolation for SharedArrayBuffer support in audio worklets
    try {
      session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        callback({
          responseHeaders: {
            ...details.responseHeaders,
            'Cross-Origin-Opener-Policy': ['same-origin'],
            'Cross-Origin-Embedder-Policy': ['require-corp'],
          },
        });
      });
    } catch (e) {
      log('cross-origin header setup notice:', e.message);
    }

    initLogPaths();
    LOG_PATH = path.join(LOGS_DIR, getLogFileName());
    const pruned = pruneOldLogs(LOGS_DIR, 14);
    if (pruned.length > 0) {
      log('system: pruned old log files count: ' + pruned.length);
    }

    log('=== Wispr Tell v' + app.getVersion() + ' starting ===');
    initAutoUpdater();
  for (const [name, p] of [['paste-helper', PASTE_HELPER]])
    log('self-check', name, fs.existsSync(p) ? 'OK' : 'MISSING: ' + p);
  log('self-check groq-key', config.groqKey ? 'configured' : 'NOT SET');

  createPill();
  createCaptureWin();
  registerGlobalShortcuts();
  setupClipboardWatcher();

  // config IPC
  ipcMain.handle('get-config', () => ({ ...config }));
  ipcMain.handle('set-config', (_e, patch) => {
    config = { ...config, ...patch };
    if (patch.shortcuts) {
      config.shortcuts = { ...config.shortcuts, ...patch.shortcuts };
      registerGlobalShortcuts();
    }
    if (patch.voiceCommands) {
      voiceEngine.setCommands(config.voiceCommands);
    }
    if (patch.theme) {
      config.theme = patch.theme;
      broadcastTheme(patch.theme);
    }
    saveConfig();
    if (patch.launchAtLogin !== undefined && process.platform === 'win32') {
      try {
        app.setLoginItemSettings({
          openAtLogin: !!patch.launchAtLogin,
          path: process.execPath,
          args: ['--hidden'],
        });
      } catch (err) {
        log('setLoginItemSettings error:', err.message);
      }
      try {
        const regExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
        if (patch.launchAtLogin) {
          spawn(regExe, ['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'Wispr Tell', '/t', 'REG_SZ', '/d', `"${process.execPath}"`, '/f'], { windowsHide: true });
        } else {
          spawn(regExe, ['delete', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'Wispr Tell', '/f'], { windowsHide: true });
        }
      } catch (regErr) {
        log('registry run key error:', regErr.message);
      }
    }
    return { ...config };
  });

  // theme synchronization IPC & listeners
  ipcMain.handle('get-theme', () => {
    const effective = resolveEffectiveTheme(config.theme || 'cyber-teal');
    return {
      theme: config.theme || 'cyber-teal',
      effectiveTheme: effective,
      isDark: effective === 'cyber-teal' || effective === 'dark-obsidian' || effective === 'dark',
      variables: THEMES[effective] || THEMES['dark-obsidian'],
      hasNativeMaterial: WindowMaterialConfigurator.shouldUseNativeMaterials(),
      timestamp: Date.now(),
    };
  });

  if (typeof nativeTheme !== 'undefined' && typeof nativeTheme.on === 'function') {
    nativeTheme.on('updated', () => {
      if (config.theme === 'system') {
        broadcastTheme('system');
      }
    });
  }

  // pill drag physics & persistence IPC
  ipcMain.on('pill-move-delta', (_event, { dx, dy }) => {
    if (!pill || pill.isDestroyed()) return;
    const [curX, curY] = pill.getPosition();
    const nextX = Math.round(curX + dx);
    const nextY = Math.round(curY + dy);
    const displays = (typeof screen !== 'undefined' && typeof screen.getAllDisplays === 'function')
      ? screen.getAllDisplays()
      : ((typeof screen !== 'undefined' && typeof screen.getPrimaryDisplay === 'function') ? [screen.getPrimaryDisplay()] : []);
    const clamped = MultiMonitorPhysicsBounds.clampToDisplays(nextX, nextY, displays);
    pill.setPosition(clamped.x, clamped.y);
  });

  ipcMain.handle('save-pill-position', () => {
    if (!pill || pill.isDestroyed()) return null;
    const [curX, curY] = pill.getPosition();
    const displays = (typeof screen !== 'undefined' && typeof screen.getAllDisplays === 'function')
      ? screen.getAllDisplays()
      : ((typeof screen !== 'undefined' && typeof screen.getPrimaryDisplay === 'function') ? [screen.getPrimaryDisplay()] : []);
    const clamped = MultiMonitorPhysicsBounds.clampToDisplays(curX, curY, displays);
    debouncedSavePillPosition(clamped.x, clamped.y);
    return clamped;
  });

  if (typeof screen !== 'undefined' && typeof screen.on === 'function') {
    screen.on('display-metrics-changed', () => repositionPill());
    screen.on('display-removed', () => repositionPill());
  }

  // history IPC
  ipcMain.handle('get-history', () => history);
  ipcMain.handle('get-stats', () => getStats());
  ipcMain.handle('update-history-item', (_e, { id, text }) => {
    const item = history.find(h => h.id === id);
    if (item) {
      item.text = String(text || '').trim();
      item.wordCount = item.text.split(/\s+/).filter(Boolean).length;
      saveHistory();
    }
    return { history, stats: getStats() };
  });
  ipcMain.handle('delete-history', (_e, id) => {
    const item = history.find(h => h.id === id);
    if (item && item.audioFile) {
      const audioPath = path.join(AUDIO_HISTORY_DIR, item.audioFile);
      if (fs.existsSync(audioPath)) {
        try { fs.unlinkSync(audioPath); } catch {}
      }
    }
    history = history.filter(h => h.id !== id);
    saveHistory();
    return { history, stats: getStats() };
  });
  ipcMain.handle('clear-history', () => {
    try {
      if (fs.existsSync(AUDIO_HISTORY_DIR)) {
        const files = fs.readdirSync(AUDIO_HISTORY_DIR);
        for (const f of files) {
          try { fs.unlinkSync(path.join(AUDIO_HISTORY_DIR, f)); } catch {}
        }
      }
    } catch {}
    history = [];
    saveHistory();
    return { history: [], stats: getStats() };
  });

  // audio history IPC
  ipcMain.handle('get-history-audio', (_e, id) => {
    const item = history.find(h => h.id === id);
    if (!item || !item.audioFile) return null;
    const audioPath = path.join(AUDIO_HISTORY_DIR, item.audioFile);
    if (!fs.existsSync(audioPath)) return null;
    try {
      const fileBuffer = fs.readFileSync(audioPath);
      return {
        id: item.id,
        fileName: item.audioFile,
        dataUrl: `data:audio/webm;base64,${fileBuffer.toString('base64')}`,
        sizeBytes: fileBuffer.length,
      };
    } catch {
      return null;
    }
  });

  ipcMain.handle('delete-history-audio', (_e, id) => {
    const item = history.find(h => h.id === id);
    if (!item || !item.audioFile) return false;
    const audioPath = path.join(AUDIO_HISTORY_DIR, item.audioFile);
    if (fs.existsSync(audioPath)) {
      try { fs.unlinkSync(audioPath); } catch {}
    }
    item.audioFile = null;
    saveHistory();
    return true;
  });

  ipcMain.handle('reset-offline-mode', () => {
    isOfflineMode = false;
    lastOfflineTime = 0;
    return { isOfflineMode: false };
  });

  // personas and context polish IPC
  ipcMain.handle('get-personas', () => {
    return {
      personas: config.personas || DEFAULT_PERSONAS,
      activePersonaId: config.activePersonaId || 'natural',
      contextPolishEnabled: config.contextPolishEnabled !== false,
    };
  });

  ipcMain.handle('set-active-persona', (_e, id) => {
    const list = config.personas || DEFAULT_PERSONAS;
    if (!list.some(p => p.id === id)) {
      throw new Error(`Persona '${id}' not found`);
    }
    config.activePersonaId = id;
    saveConfig();
    return config.activePersonaId;
  });

  ipcMain.handle('save-persona', (_e, persona) => {
    if (!persona || typeof persona !== 'object') throw new Error('Invalid persona payload');
    const name = String(persona.name || '').trim();
    if (!name) throw new Error('Persona name cannot be empty');
    const systemPrompt = String(persona.systemPrompt || '').trim();
    if (!systemPrompt) throw new Error('Persona system prompt cannot be empty');

    const sanitizedPrompt = systemPrompt.length > 4000 ? systemPrompt.substring(0, 4000) : systemPrompt;
    let temp = Number(persona.temperature ?? 0.3);
    if (isNaN(temp)) temp = 0.3;
    temp = Math.max(0.0, Math.min(1.0, temp));

    const id = String(persona.id || name.toLowerCase().replace(/[^a-z0-9_]/g, '_'));
    config.personas = config.personas || [...DEFAULT_PERSONAS];

    const existingIdx = config.personas.findIndex(p => p.id === id);
    if (existingIdx >= 0) {
      config.personas[existingIdx] = {
        ...config.personas[existingIdx],
        name,
        systemPrompt: sanitizedPrompt,
        temperature: temp,
      };
    } else {
      config.personas.push({
        id,
        name,
        systemPrompt: sanitizedPrompt,
        temperature: temp,
        isDefault: false,
      });
    }

    saveConfig();
    return config.personas;
  });

  ipcMain.handle('delete-persona', (_e, id) => {
    config.personas = config.personas || [...DEFAULT_PERSONAS];
    const target = config.personas.find(p => p.id === id);
    if (!target) throw new Error(`Persona '${id}' not found`);
    if (target.isDefault) throw new Error('Cannot delete default persona');

    config.personas = config.personas.filter(p => p.id !== id);
    if (config.activePersonaId === id) {
      config.activePersonaId = 'natural';
    }
    saveConfig();
    return config.personas;
  });

  ipcMain.handle('set-context-polish', (_e, enabled) => {
    config.contextPolishEnabled = !!enabled;
    saveConfig();
    return config.contextPolishEnabled;
  });

  ipcMain.handle('preview-polish', async (_e, { text, personaId, targetContext }) => {
    const start = Date.now();
    if (!config.groqKey) {
      return {
        polishedText: 'Please configure your Groq API key in Settings to test live prompts.',
        appliedPersona: personaId || config.activePersonaId || 'natural',
        category: targetContext || 'general',
        durationMs: Date.now() - start,
      };
    }

    let mockTarget = null;
    if (targetContext === 'code') mockTarget = { exeName: 'Code.exe', windowTitle: 'app.js' };
    else if (targetContext === 'chat') mockTarget = { exeName: 'slack.exe', windowTitle: '#general' };
    else if (targetContext === 'formal') mockTarget = { exeName: 'OUTLOOK.EXE', windowTitle: 'Inbox' };

    const promptSpec = buildPolishingPrompt({
      text: text || 'This is a sample voice dictation sentence to test smart polish.',
      targetInfo: mockTarget,
      personas: config.personas || DEFAULT_PERSONAS,
      activePersonaId: personaId || config.activePersonaId || 'natural',
      contextPolishEnabled: !!targetContext,
      dictionary: config.dictionary || [],
    });

    const body = JSON.stringify({
      model: GROQ_POLISH_MODEL,
      messages: [
        { role: 'system', content: promptSpec.systemPrompt },
        { role: 'user', content: promptSpec.userText },
      ],
      temperature: promptSpec.temperature,
      max_tokens: 512,
    });

    const res = await groqPost('/openai/v1/chat/completions', { body, contentType: 'application/json', timeoutMs: 20000 });
    if (res.status !== 200) throw new Error(groqError('Preview', res.status));

    let out = (JSON.parse(res.body).choices?.[0]?.message?.content || '').trim();
    if (/^["'][\s\S]*["']$/.test(out) && out.length >= 2) out = out.slice(1, -1).trim();

    return {
      polishedText: out || text,
      appliedPersona: promptSpec.personaName,
      category: promptSpec.category,
      durationMs: Date.now() - start,
    };
  });

  ipcMain.handle('copy-text', (_e, text) => {
    clipboard.writeText(String(text || ''));
    return true;
  });

  // data import / export (zero user profiles or personal names)
  const handleExportData = () => {
    return {
      appName: 'Wispr Speak',
      version: app.getVersion(),
      exportedAt: new Date().toISOString(),
      stats: getStats(),
      preferences: {
        theme: config.theme || 'cyber-teal',
        shortcuts: config.shortcuts,
        smartFix: config.smartFix,
        micDeviceId: config.micDeviceId,
      },
      dictionary: config.dictionary || [],
      historyCount: history.length,
      recentHistory: history.slice(0, 50),
    };
  };

  const handleImportData = (_e, data) => {
    if (!data || typeof data !== 'object') {
      return { ok: false, error: 'Invalid data format' };
    }
    if (data.dictionary && Array.isArray(data.dictionary)) {
      config.dictionary = data.dictionary;
    }
    if (data.preferences) {
      if (data.preferences.shortcuts) {
        config.shortcuts = { ...config.shortcuts, ...data.preferences.shortcuts };
      }
      if (data.preferences.theme) {
        config.theme = data.preferences.theme;
        updateTitleBarTheme(config.theme);
      }
      if (data.preferences.smartFix !== undefined) {
        config.smartFix = data.preferences.smartFix;
      }
      if (data.preferences.micDeviceId) {
        config.micDeviceId = data.preferences.micDeviceId;
      }
    }
    if (data.recentHistory && Array.isArray(data.recentHistory) && data.recentHistory.length > 0) {
      const existingIds = new Set(history.map(h => h.id));
      for (const h of data.recentHistory) {
        if (!existingIds.has(h.id)) {
          history.push(h);
        }
      }
      history.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      saveHistory();
    }
    saveConfig();
    return { ok: true, config, history, stats: getStats() };
  };

  ipcMain.handle('export-data', handleExportData);
  ipcMain.handle('import-data', handleImportData);
  ipcMain.handle('export-profile', handleExportData);
  ipcMain.handle('import-profile', handleImportData);

  ipcMain.handle('learn-correction', async (_e, { original, corrected }) => {
    try {
      const learned = learnFromCorrection(original, corrected, 'manual-history');
      return { ok: true, learned, dictionary: config.dictionary };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('validate-key', async (_e, key) => validateGroqKey(key));
  ipcMain.handle('list-mics', async () => {
    try {
      if (!captureWin || captureWin.isDestroyed()) return [];
      return await captureWin.webContents.executeJavaScript('window.listMics()');
    } catch {
      return [];
    }
  });

  ipcMain.on('welcome-done', () => {
    config.firstRun = false;
    saveConfig();
    if (welcomeWin && !welcomeWin.isDestroyed()) welcomeWin.close();
  });

  ipcMain.on('mic-level', (_e, level) => {
    if (pill && !pill.isDestroyed()) pill.webContents.send('mic-level', level);
  });

  ipcMain.on('capture-error', (_e, msg) => {
    log('capture ERROR:', msg);
    if (recording) {
      recording = false;
      busy = false;
      isHandsFree = false;
      setPill('error', 'Mic error — ' + String(msg).slice(0, 50));
    }
  });

  ipcMain.on('open-external', (_e, url) => {
    if (typeof url === 'string') shell.openExternal(url);
  });

  ipcMain.on('toggle-handsfree', () => {
    if (recording && isHandsFree) {
      log('hands-free: toggled off');
      onHotkeyUp();
    } else if (!recording && !busy) {
      log('hands-free: toggled on');
      onHotkeyDown(true);
    }
  });

  // Tray menu
  try {
    const trayIcon = path.join(__dirname, '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'tray.png');
    tray = new Tray(trayIcon);
    tray.setToolTip('Wispr Speak — Voice Typing');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Wispr Speak', click: openSettings },
      {
        label: 'Toggle hands-free mode',
        click: () => {
          if (recording && isHandsFree) onHotkeyUp();
          else if (!recording && !busy) onHotkeyDown(true);
        },
      },
      { type: 'separator' },
      { label: 'Push to talk: ' + (config.shortcuts?.pushToTalk || ['Ctrl', 'Win']).join('+'), enabled: false },
      { label: 'Hands-free: ' + (config.shortcuts?.handsFree || ['Ctrl', 'Win', 'Space']).join('+'), enabled: false },
      { label: 'Polish selection: ' + (config.shortcuts?.polishSelection || ['Win', 'Alt', 'Q']).join('+'), enabled: false },
      { label: 'Learn correction: ' + (config.shortcuts?.learnCorrection || ['Win', 'Alt', 'L']).join('+'), enabled: false },
      { label: 'Paste latest: ' + (config.shortcuts?.pasteLatest || ['Alt', 'Shift', 'Z']).join('+'), enabled: false },
      { type: 'separator' },
      { label: 'Settings', click: () => { openSettings(); if (settingsWin) settingsWin.webContents.send('nav-to', 'settings'); } },
      { label: 'Dictionary ("My words")', click: () => { openSettings(); if (settingsWin) settingsWin.webContents.send('nav-to', 'dictionary'); } },
      {
        label: 'Test Groq key', click: async () => {
          setPill('working');
          const r = await validateGroqKey(config.groqKey);
          if (r.ok) { log('key test: OK'); setPill('done', null, 'Groq key works ✓'); }
          else { log('key test FAILED:', r.error); setPill('error', r.error); }
        },
      },
      { label: 'Open debug log', click: () => {
        initLogPaths();
        const currentLogFile = path.join(LOGS_DIR, getLogFileName());
        if (fs.existsSync(currentLogFile)) {
          shell.openPath(currentLogFile);
        } else if (fs.existsSync(LOGS_DIR)) {
          shell.openPath(LOGS_DIR);
        } else if (LOG_PATH) {
          shell.openPath(LOG_PATH);
        }
      } },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]));
    tray.on('click', openSettings);
  } catch (trayErr) {
    log('Tray creation notice:', trayErr.message);
  }

  let pttPendingTimer = null;
let isQuitting = false;

  // Global keyboard shortcuts hook with OS autorepeat suppression
  uIOhook.on('keydown', e => {
    // OS autorepeat suppression: if key is already held down, ignore repeated WM_KEYDOWN
    if (heldKeys.has(e.keycode)) return;
    heldKeys.add(e.keycode);

    const handsFreeCombo = config.shortcuts?.handsFree || ['Ctrl', 'Win', 'Space'];
    const pttCombo = config.shortcuts?.pushToTalk || ['Ctrl', 'Win'];
    const polishCombo = config.shortcuts?.polishSelection || ['Win', 'Alt', 'Q'];
    const learnCombo = config.shortcuts?.learnCorrection || ['Win', 'Alt', 'L'];
    const pasteLatestCombo = config.shortcuts?.pasteLatest || ['Alt', 'Shift', 'Z'];

    // 0. Escape key cancels active dictation
    if (e.keycode === 1) {
      if (hotkeyFsm.state !== 'IDLE' || busy || recording) {
        cancelCurrentDictation();
        return;
      }
    }

    // 1. Hands-free combo: Ctrl + Win + Space
    if (isComboHeld(handsFreeCombo)) {
      if (pttPendingTimer) { clearTimeout(pttPendingTimer); pttPendingTimer = null; }
      enqueueHotkeyEvent('HANDSFREE_TOGGLE');
      return;
    }

    // 2. Selection polish combo: Windows + Alt + Q
    if (isComboHeld(polishCombo)) {
      if (pttPendingTimer) { clearTimeout(pttPendingTimer); pttPendingTimer = null; }
      enqueueHotkeyEvent('POLISH_SELECTION');
      return;
    }

    // 2b. Selection learn combo: Windows + Alt + L
    if (isComboHeld(learnCombo)) {
      if (pttPendingTimer) { clearTimeout(pttPendingTimer); pttPendingTimer = null; }
      enqueueHotkeyEvent('LEARN_SELECTION');
      return;
    }

    // 2c. Paste latest dictation combo: Alt + Shift + Z
    if (isComboHeld(pasteLatestCombo)) {
      if (pttPendingTimer) { clearTimeout(pttPendingTimer); pttPendingTimer = null; }
      pasteLatestDictation();
      return;
    }

    // 3. Two-key combo: Ctrl + Win (PTT)
    if (isComboHeld(pttCombo)) {
      if (currentState === FsmState.LISTENING_HANDSFREE) {
        // Pressing Ctrl+Win while in hands-free stops it
        enqueueHotkeyEvent('HANDSFREE_TOGGLE');
        return;
      }

      if (!pttPendingTimer && currentState !== FsmState.LISTENING_PTT) {
        // Debounce (140ms) to check if Space is landing for hands-free combo
        pttPendingTimer = setTimeout(() => {
          pttPendingTimer = null;
          if (isComboHeld(pttCombo) && !isComboHeld(handsFreeCombo)) {
            enqueueHotkeyEvent('PTT_DOWN');
          }
        }, 140);
      }
    }
  });

  uIOhook.on('keyup', e => {
    heldKeys.delete(e.keycode);
    const pttCombo = config.shortcuts?.pushToTalk || ['Ctrl', 'Win'];

    // Cancel pending PTT if released before debounce
    if (pttPendingTimer && !isComboHeld(pttCombo)) {
      clearTimeout(pttPendingTimer);
      pttPendingTimer = null;
    }

    // End push-to-talk when modifiers are released
    if (!isComboHeld(pttCombo)) {
      if (currentState === FsmState.LISTENING_PTT || currentState === FsmState.QUEUED) {
        enqueueHotkeyEvent('PTT_UP');
      }
    }
  });

  uIOhook.start();

  if (process.platform === 'win32') {
    app.setLoginItemSettings({ openAtLogin: !!config.launchAtLogin, args: ['--hidden'] });
  }

  let isSilentStart = process.argv.includes('--hidden') || process.argv.includes('--minimized');
  if (!isSilentStart && process.platform === 'win32') {
    try {
      isSilentStart = app.getLoginItemSettings().wasOpenedAtLogin;
    } catch {}
  }

  if (config.firstRun) {
    showWelcome();
  } else if (!isSilentStart) {
    openSettings();
  }
});
}

process.on('uncaughtException', err => {
  log('uncaughtException caught:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', reason => {
  log('unhandledRejection caught:', reason && reason.stack ? reason.stack : reason);
});

app.on('window-all-closed', e => e.preventDefault());
app.on('before-quit', () => {
  isQuitting = true;
  try { globalShortcut.unregisterAll(); } catch {}
  try { uIOhook.stop(); } catch {}
});

if (typeof module !== 'undefined') {
  module.exports = {
    FsmState,
    HotkeyStateMachine,
    hotkeyFsm,
    normalizeToken,
    wordSimilarity,
    stitchTranscripts,
    enqueueHotkeyEvent,
    eventQueue: hotkeyFsm.queue,
    getCurrentState: () => hotkeyFsm.state,
    resetState: () => { hotkeyFsm.state = 'IDLE'; hotkeyFsm.queue.length = 0; syncLegacyState(); },
    onHotkeyDown,
    onHotkeyUp,
    WindowMaterialConfigurator,
    MaterialBoundaryManager,
    THEMES,
    resolveEffectiveTheme,
    broadcastTheme,
    MultiMonitorPhysicsBounds,
  };
}

