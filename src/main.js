// Wispr Tell v0.5.0 — desktop voice typing application.
// Supports both Push-to-talk (hold-to-talk) and Hands-free toggle mode (Control+Windows+Spacebar).
// Powered by Groq Cloud STT (whisper-large-v3-turbo) and smart language model cleanup (gpt-oss-20b).
const { app, BrowserWindow, Tray, Menu, ipcMain, clipboard, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { uIOhook, UiohookKey } = require('uiohook-napi');
const { formatText, applyVoiceCommands, applyDictionary, buildMultipart } = require('./text-utils');

// ---------- debug logging ----------
let LOG_PATH = null;
function log(...args) {
  const line = new Date().toISOString() + ' ' + args.map(a => String(a)).join(' ');
  try { if (LOG_PATH) fs.appendFileSync(LOG_PATH, line + '\n'); } catch {}
  console.log('[wispr-tell]', ...args);
}

const PASTE_HELPER = path.join(__dirname, '..', 'bin', 'native', 'tell-paste.exe');

let pill = null;          // floating status pill window
let captureWin = null;    // hidden audio worklet window
let settingsWin = null;   // main dashboard & settings window
let welcomeWin = null;
let tray = null;
let recording = false;
let busy = false;         // transcribing / injecting
let isHandsFree = false;  // active hands-free toggle recording
let handsFreeCooldown = 0;
let targetHwnd = null;    // foreground window handle before hotkey down
const heldKeys = new Set();

// ---------- config ----------
const CONFIG_PATH = path.join(app.getPath('userData'), 'wispr-tell-config.json');
const DEFAULTS = {
  userName: 'Yeamin',
  micDeviceId: 'default',
  launchAtLogin: false,
  firstRun: true,
  groqKey: '',
  smartFix: true,
  shortcuts: {
    pushToTalk: ['Ctrl', 'Win'],
    handsFree: ['Ctrl', 'Win', 'Space'],
  },
  dictionary: [
    { from: 'whisper flow', to: 'Wispr Flow' },
    { from: 'wispr tell', to: 'Wispr Tell' },
  ],
};

let config = { ...DEFAULTS };
try {
  const loaded = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  config = {
    ...DEFAULTS,
    ...loaded,
    shortcuts: { ...DEFAULTS.shortcuts, ...(loaded.shortcuts || {}) },
  };
} catch {}

function saveConfig() {
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); } catch {}
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

function addHistoryItem(text, durationMs = 0) {
  if (!text || !text.trim()) return;
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  const item = {
    id: 'hist_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    text: text.trim(),
    timestamp: Date.now(),
    wordCount,
    durationMs: durationMs || 2500,
    starred: false,
  };
  history.unshift(item);
  if (history.length > 1000) history.pop();
  saveHistory();

  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('history-updated', { item, stats: getStats() });
  }
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

// ---------- Groq cloud engine ----------
const GROQ_STT_MODEL = 'whisper-large-v3-turbo';
const GROQ_POLISH_MODEL = 'openai/gpt-oss-20b';
const POLISH_SYSTEM = 'You are a dictation cleanup assistant. Fix spelling, grammar, and punctuation of the dictated text. Return ONLY the corrected text — no quotes, no explanations, no extra words. Keep the same language and meaning. If it is already fine, return it unchanged.';

function polishSystemPrompt() {
  const words = (config.dictionary || []).filter(e => e && e.to).map(e => String(e.to).trim()).filter(Boolean);
  if (!words.length) return POLISH_SYSTEM;
  return POLISH_SYSTEM + ' Always spell these words exactly as given: ' + words.join(', ') + '.';
}
const NEEDS_KEY = 'NEEDS_KEY';

function groqError(what, status, errMsg) {
  if (status === 401) return 'Groq key rejected — check the key in Settings.';
  if (status === 429) return 'Groq rate limit reached — please wait a moment.';
  if (status === 400) return 'Audio unreadable by Groq — speak a little longer.';
  if (status && status >= 500) return 'Groq server error — try again momentarily.';
  if (errMsg && /timeout/i.test(errMsg)) return 'Groq connection timed out — check internet connection.';
  if (errMsg && /(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH)/i.test(errMsg))
    return 'No internet connection — connect and try again.';
  return (what || 'Speech') + ' failed — please try again.';
}

const httpsAgent = new (require('https').Agent)({ keepAlive: true, maxSockets: 4 });
const httpAgent = new (require('http').Agent)({ keepAlive: true, maxSockets: 4 });

function httpRequest({ url, method = 'GET', headers = {}, body = null, timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? require('https') : require('http');
    const req = lib.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method, headers, timeout: timeoutMs,
      agent: u.protocol === 'https:' ? httpsAgent : httpAgent,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    if (body) req.write(body);
    req.end();
  });
}

async function groqPost(pathname, { body, contentType, timeoutMs = 30000 }) {
  const headers = {
    'Authorization': 'Bearer ' + config.groqKey,
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
  };
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await httpRequest({
        url: 'https://api.groq.com' + pathname, method: 'POST', headers, body, timeoutMs,
      });
    } catch (e) {
      lastErr = e;
      log('groq: attempt', attempt + 1, 'network error:', e.message);
      if (attempt < 2) await new Promise(r => setTimeout(r, 800));
    }
  }
  throw lastErr;
}

async function transcribeGroq(wavBuffer) {
  const mp = buildMultipart({ model: GROQ_STT_MODEL, response_format: 'json', language: 'en' },
    'file', 'audio.wav', wavBuffer, 'audio/wav');
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
  const body = JSON.stringify({
    model: GROQ_POLISH_MODEL,
    messages: [{ role: 'system', content: polishSystemPrompt() }, { role: 'user', content: text }],
    temperature: 0.1, max_tokens: 1024,
  });
  let r;
  try {
    r = await groqPost('/openai/v1/chat/completions', { body, contentType: 'application/json', timeoutMs: 30000 });
  } catch (e) { throw new Error(groqError('Cleanup', 0, e.message)); }
  if (r.status !== 200) throw new Error(groqError('Cleanup', r.status));
  let out = (JSON.parse(r.body).choices?.[0]?.message?.content || '').trim();
  if (/^["'][\s\S]*["']$/.test(out) && out.length >= 2) {
    out = out.slice(1, -1).trim();
  }
  return out || text;
}

async function transcribe(wavBuffer) {
  if (!config.groqKey) throw new Error(NEEDS_KEY);
  return transcribeGroq(wavBuffer);
}

async function smartPolish(text) {
  if (!config.smartFix || !text || text.length < 3) return text;
  if (!config.groqKey) return text;
  return polishGroq(text);
}

async function validateGroqKey(key) {
  const k = String(key || '').trim();
  if (!k) return { ok: false, error: 'Paste a key first.' };
  if (!k.startsWith('gsk_')) return { ok: false, error: 'Groq keys begin with gsk_' };
  try {
    const r = await httpRequest({
      url: 'https://api.groq.com/openai/v1/models', method: 'GET',
      headers: { 'Authorization': 'Bearer ' + k }, timeoutMs: 15000,
    });
    if (r.status === 200) return { ok: true };
    if (r.status === 401) return { ok: false, error: 'Key rejected by Groq.' };
    return { ok: false, error: 'Groq status code ' + r.status };
  } catch (e) {
    return { ok: false, error: groqError('Key test', 0, e.message) };
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

// ---------- pill window ----------
function repositionPill() {
  if (!pill || pill.isDestroyed()) return;
  try {
    const cursor = screen.getCursorScreenPoint();
    const currentDisplay = screen.getDisplayNearestPoint(cursor);
    const { x, y, width, height } = currentDisplay.workArea;
    const pillWidth = 480;
    const posX = Math.round(x + (width - pillWidth) / 2);
    const posY = Math.round(y + height - 170);
    pill.setPosition(posX, posY);
  } catch (err) {
    log('repositionPill error:', err.message);
  }
}

function createPill() {
  pill = new BrowserWindow({
    width: 480, height: 100, frame: false, transparent: true,
    alwaysOnTop: true, skipTaskbar: true, resizable: false,
    focusable: false, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  pill.loadFile(path.join(__dirname, 'renderer', 'pill.html'));
  repositionPill();
}

function setPill(state, label, transcript) {
  if (!pill) return;
  if (state === 'hidden') { pill.hide(); return; }
  repositionPill();
  pill.webContents.send('pill-state', { state, label, transcript });
  if (!pill.isVisible()) pill.showInactive();
}

// ---------- main dashboard & settings window ----------
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (settingsWin.isMinimized()) settingsWin.restore();
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 1140,
    height: 760,
    minWidth: 960,
    minHeight: 640,
    title: 'Wispr Tell',
    backgroundColor: '#fbfaf8',
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#fbfaf8', symbolColor: '#2b2a27', height: 38 },
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'));

  settingsWin.once('ready-to-show', () => {
    settingsWin.center();
    settingsWin.show();
  });
}

function showWelcome() {
  welcomeWin = new BrowserWindow({
    width: 520, height: 560, resizable: false, minimizable: false, maximizable: false,
    title: 'Welcome to Wispr Tell', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
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
  const { keyboard, Key } = require('@nut-tree-fork/nut-js');
  keyboard.config.autoDelayMs = 5;
  await keyboard.pressKey(Key.LeftControl, Key.V);
  await keyboard.releaseKey(Key.LeftControl, Key.V);
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
      const m = out.match(/TARGET\s+(0x[0-9a-fA-F]+|[0-9a-fA-F]+)/);
      resolve(m ? m[1] : null);
    });
    p.on('error', () => { clearTimeout(to); resolve(null); });
  });
}

async function injectText(text) {
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
  await new Promise(r => setTimeout(r, 60));

  try {
    await pasteViaHelper();
    log('inject: native helper OK');
  } catch (e) {
    log('inject: helper failed (' + e.message + '), nut-js fallback');
    await pasteViaNut();
  }

  setTimeout(() => {
    try {
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
    } catch (restoreErr) {
      log('warning: clipboard restore failed:', restoreErr.message);
    }
  }, 600);
}

// ---------- hold-to-talk & hands-free flow ----------
async function onHotkeyDown(handsFreeMode = false) {
  if (recording || busy || !captureWin) return;
  recording = true;
  isHandsFree = handsFreeMode;
  targetHwnd = await detectTargetWindow();
  log('hotkey down, target=' + targetHwnd + ', handsFree=' + handsFreeMode);

  if (handsFreeMode) {
    const hfShortcut = (config.shortcuts?.handsFree || ['Ctrl', 'Win', 'Space']).join('+');
    setPill('listening', 'Listening (Hands-free)…', 'Press ' + hfShortcut + ' to finish');
  } else {
    setPill('listening', 'Listening…', 'release to type');
  }

  captureWin.webContents.send('capture-start');
}

async function onHotkeyUp() {
  if (!recording) return;
  recording = false;
  isHandsFree = false;
  busy = true;
  setPill('working', 'Typing…');

  try {
    const wavBuffer = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('capture timeout')), 20000);
      ipcMain.once('capture-data', (_e, buf) => { clearTimeout(to); resolve(Buffer.from(buf)); });
      captureWin.webContents.send('capture-stop');
    });

    log('capture: got', wavBuffer.length, 'bytes');
    if (wavBuffer.length < 5000) {
      log('capture: too short, ignoring');
      setPill('hidden');
      return;
    }

    const t0 = Date.now();
    setPill('working', 'Transcribing…');
    const raw = await transcribe(wavBuffer);
    const durationMs = Date.now() - t0;
    log('transcribe took', durationMs, 'ms');

    const cmd = applyVoiceCommands(formatText(raw));
    if (cmd.scratch) { await scratchLast(); return; }
    if (cmd.action === 'undo') { await undoLast(); return; }
    if (cmd.action === 'delete-word') { await deleteWord(); return; }

    setPill('working', 'Polishing…');
    let clean = cmd.command ? cmd.text : await smartPolish(cmd.text);
    clean = applyDictionary(clean, config.dictionary);
    log('final: "' + clean.slice(0, 80) + '"');

    if (clean) {
      await injectText(clean);
      lastInject = { text: clean, time: Date.now() };
      addHistoryItem(clean, durationMs);
      setPill('done', null, clean);
    } else {
      setPill('hidden');
    }
  } catch (e) {
    log('ERROR:', e.message);
    if (e.message === NEEDS_KEY) {
      setPill('error', 'Add your Groq key in Settings — click the tray icon');
      openSettings();
    } else {
      setPill('error', 'Oops — ' + String(e.message).slice(0, 60));
    }
  } finally {
    busy = false;
  }
}

// ---------- app lifecycle ----------
app.whenReady().then(() => {
  LOG_PATH = path.join(app.getPath('userData'), 'wispr-tell-debug.log');
  log('=== Wispr Tell v0.5.0 starting ===');
  for (const [name, p] of [['paste-helper', PASTE_HELPER]])
    log('self-check', name, fs.existsSync(p) ? 'OK' : 'MISSING: ' + p);
  log('self-check groq-key', config.groqKey ? 'configured' : 'NOT SET');

  createPill();
  createCaptureWin();

  // config IPC
  ipcMain.handle('get-config', () => ({ ...config }));
  ipcMain.handle('set-config', (_e, patch) => {
    config = { ...config, ...patch };
    if (patch.shortcuts) {
      config.shortcuts = { ...config.shortcuts, ...patch.shortcuts };
    }
    saveConfig();
    if (patch.launchAtLogin !== undefined && process.platform === 'win32') {
      app.setLoginItemSettings({ openAtLogin: !!patch.launchAtLogin });
    }
    return { ...config };
  });

  // history IPC
  ipcMain.handle('get-history', () => history);
  ipcMain.handle('get-stats', () => getStats());
  ipcMain.handle('delete-history', (_e, id) => {
    history = history.filter(h => h.id !== id);
    saveHistory();
    return { history, stats: getStats() };
  });
  ipcMain.handle('clear-history', () => {
    history = [];
    saveHistory();
    return { history: [], stats: getStats() };
  });
  ipcMain.handle('copy-text', (_e, text) => {
    clipboard.writeText(String(text || ''));
    return true;
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

  // Tray menu
  const trayIcon = path.join(__dirname, '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'tray.png');
  tray = new Tray(trayIcon);
  tray.setToolTip('Wispr Tell — Voice Typing');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Wispr Tell', click: openSettings },
    { type: 'separator' },
    { label: 'Push to talk: ' + (config.shortcuts?.pushToTalk || ['Ctrl', 'Win']).join('+'), enabled: false },
    { label: 'Hands-free: ' + (config.shortcuts?.handsFree || ['Ctrl', 'Win', 'Space']).join('+'), enabled: false },
    { type: 'separator' },
    { label: 'Settings', click: () => { openSettings(); if (settingsWin) settingsWin.webContents.send('nav-to', 'settings'); } },
    { label: 'Dictionary ("My words")', click: () => { openSettings(); if (settingsWin) settingsWin.webContents.send('nav-to', 'dictionary'); } },
    {
      label: 'Test Groq key', click: async () => {
        setPill('working', 'Testing key…');
        const r = await validateGroqKey(config.groqKey);
        if (r.ok) { log('key test: OK'); setPill('done', null, 'Groq key works ✓'); }
        else { log('key test FAILED:', r.error); setPill('error', r.error); }
      },
    },
    { label: 'Open debug log', click: () => { if (LOG_PATH) shell.openPath(LOG_PATH); } },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]));
  tray.on('click', openSettings);

  // Global keyboard shortcuts hook
  uIOhook.on('keydown', e => {
    heldKeys.add(e.keycode);
    const now = Date.now();

    const handsFreeCombo = config.shortcuts?.handsFree || ['Ctrl', 'Win', 'Space'];
    const pttCombo = config.shortcuts?.pushToTalk || ['Ctrl', 'Win'];

    // 1. Hands-free toggle mode check (Control + Windows + Spacebar)
    if (isComboHeld(handsFreeCombo)) {
      if (now - handsFreeCooldown < 500) return;
      handsFreeCooldown = now;

      if (recording && isHandsFree) {
        log('hands-free toggle: ending recording');
        onHotkeyUp();
      } else if (!recording && !busy) {
        log('hands-free toggle: starting recording');
        onHotkeyDown(true);
      }
      return;
    }

    // 2. Push-to-talk hold mode check (Control + Windows)
    if (!isHandsFree && !recording && !busy && isComboHeld(pttCombo)) {
      onHotkeyDown(false);
    }
  });

  uIOhook.on('keyup', e => {
    heldKeys.delete(e.keycode);
    if (recording && !isHandsFree) {
      const pttCombo = config.shortcuts?.pushToTalk || ['Ctrl', 'Win'];
      if (!isComboHeld(pttCombo)) {
        onHotkeyUp();
      }
    }
  });

  uIOhook.start();

  if (process.platform === 'win32') {
    app.setLoginItemSettings({ openAtLogin: !!config.launchAtLogin });
  }

  if (config.firstRun) {
    openSettings();
  }
});

app.on('window-all-closed', e => e.preventDefault());
app.on('before-quit', () => { try { uIOhook.stop(); } catch {} });
