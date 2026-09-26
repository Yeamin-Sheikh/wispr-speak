// Wispr Tell v0.4.0 — cloud engine (Groq). Hold Ctrl+Win to talk, release to inject.
// Fast by design: audio goes to Groq's cloud chips (whisper-large-v3-turbo),
// cleanup by a big AI (openai/gpt-oss-20b). No local models, no warm-up, no waiting.
// v0.4.0 adds: personal dictionary ("My words"), more voice commands
// (punctuation, undo that, delete word), and keep-alive connections for speed.
const { app, BrowserWindow, Tray, Menu, ipcMain, clipboard, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { uIOhook, UiohookKey } = require('uiohook-napi');
const { formatText, applyVoiceCommands, applyDictionary, buildMultipart } = require('./text-utils');

// ---------- debug log (user can open it from the tray menu) ----------
let LOG_PATH = null;
function log(...args) {
  const line = new Date().toISOString() + ' ' + args.map(a => String(a)).join(' ');
  try { if (LOG_PATH) fs.appendFileSync(LOG_PATH, line + '\n'); } catch {}
  console.log('[wispr-tell]', ...args);
}

const PASTE_HELPER = path.join(__dirname, '..', 'bin', 'native', 'tell-paste.exe');

let pill = null;      // status pill window
let captureWin = null; // hidden window that owns the mic (renderer)
let settingsWin = null;
let welcomeWin = null;
let tray = null;
let recording = false;
let busy = false;     // transcribing/injecting
let targetHwnd = null; // window the user was in when they pressed the hotkey
const heldKeys = new Set(); // currently held keys, for the Ctrl+Win combo

// ---------- config ----------
const CONFIG_PATH = path.join(app.getPath('userData'), 'wispr-tell-config.json');
const DEFAULTS = {
  micDeviceId: 'default', launchAtLogin: false, firstRun: true, groqKey: '', smartFix: true,
  dictionary: [{ from: 'whisper flow', to: 'Wispr Flow' }], // "My words" — fixes misheard words
};
let config = { ...DEFAULTS };
try { config = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) }; } catch {}
function saveConfig() {
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)); } catch {}
}

// ---------- Groq cloud engine ----------
const GROQ_STT_MODEL = 'whisper-large-v3-turbo';
const GROQ_POLISH_MODEL = 'openai/gpt-oss-20b';
const POLISH_SYSTEM = 'You are a dictation cleanup assistant. Fix spelling, grammar, and punctuation of the dictated text. Return ONLY the corrected text — no quotes, no explanations, no extra words. Keep the same language and meaning. If it is already fine, return it unchanged.';
// The user's personal dictionary becomes a hard rule for the polish AI.
function polishSystemPrompt() {
  const words = (config.dictionary || []).filter(e => e && e.to).map(e => String(e.to).trim()).filter(Boolean);
  if (!words.length) return POLISH_SYSTEM;
  return POLISH_SYSTEM + ' Always spell these words exactly as given: ' + words.join(', ') + '.';
}
const NEEDS_KEY = 'NEEDS_KEY';

// Human-readable errors — never raw codes or stack traces on the pill.
function groqError(what, status, errMsg) {
  if (status === 401) return 'Groq key rejected — check the key in Settings (tray icon).';
  if (status === 429) return 'Groq is busy right now — wait a few seconds and try again.';
  if (status === 400) return 'Groq could not process that audio — try speaking a little longer.';
  if (status && status >= 500) return 'Groq had a hiccup — try again in a moment.';
  if (errMsg && /timeout/i.test(errMsg)) return 'Groq took too long — check your internet and try again.';
  if (errMsg && /(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH)/i.test(errMsg))
    return 'No internet connection — connect and try again.';
  return (what || 'Speech') + ' failed — try again.';
}

// POST with retries on network failures/timeouts only (never on 4xx/5xx).
async function groqPost(pathname, { body, contentType, timeoutMs = 30000 }) {
  const headers = {
    'Authorization': 'Bearer ' + config.groqKey,
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
  };
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await httpRequest({
        url: 'https://api.groq.com' + pathname, method: 'POST', headers, body, timeoutMs,
      });
      return r;
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
  if (!config.groqKey) return text; // no key: still inject the raw words
  return polishGroq(text);
}

// Validate a key against the live API (used by Settings "Test key" + tray).
async function validateGroqKey(key) {
  const k = String(key || '').trim();
  if (!k) return { ok: false, error: 'Paste a key first.' };
  if (!k.startsWith('gsk_')) return { ok: false, error: 'That does not look like a Groq key (starts with gsk_).' };
  try {
    const r = await httpRequest({
      url: 'https://api.groq.com/openai/v1/models', method: 'GET',
      headers: { 'Authorization': 'Bearer ' + k }, timeoutMs: 15000,
    });
    if (r.status === 200) return { ok: true };
    if (r.status === 401) return { ok: false, error: 'Key rejected by Groq — check it and try again.' };
    return { ok: false, error: 'Groq answered ' + r.status + ' — try again in a moment.' };
  } catch (e) {
    return { ok: false, error: groqError('Key test', 0, e.message) };
  }
}

// ---------- voice-command scratch (reverts last injection) ----------
let lastInject = null; // { text, time } — for "scratch that"
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

// "undo that" — Ctrl+Z in the target app (undoes the last injection or edit).
async function undoLast() {
  try {
    const { keyboard, Key } = require('@nut-tree-fork/nut-js');
    keyboard.config.autoDelayMs = 2;
    await keyboard.pressKey(Key.LeftControl, Key.Z);
    await keyboard.releaseKey(Key.LeftControl, Key.Z);
    lastInject = null;
    setPill('done', null, 'Undone ✓');
  } catch (e) { log('undo failed:', e.message); setPill('error', 'Could not undo that'); }
}

// "delete word" — Ctrl+Backspace in the target app (deletes the word before the cursor).
async function deleteWord() {
  try {
    const { keyboard, Key } = require('@nut-tree-fork/nut-js');
    keyboard.config.autoDelayMs = 2;
    await keyboard.pressKey(Key.LeftControl, Key.Backspace);
    await keyboard.releaseKey(Key.LeftControl, Key.Backspace);
    lastInject = null; // text changed under us — don't let "scratch that" over-delete
    setPill('done', null, 'Deleted ✓');
  } catch (e) { log('delete-word failed:', e.message); setPill('error', 'Could not delete that word'); }
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

// ---------- settings + welcome ----------
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 520, height: 720, resizable: false, minimizable: false, maximizable: false,
    title: 'Wispr Tell Settings', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
}
function showWelcome() {
  welcomeWin = new BrowserWindow({
    width: 520, height: 560, resizable: false, minimizable: false, maximizable: false,
    title: 'Welcome to Wispr Tell', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  welcomeWin.loadFile(path.join(__dirname, 'renderer', 'welcome.html'));
}

// ---------- hidden mic window ----------
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

// ---------- HTTP helper (no deps) ----------
// Keep-alive agents: reuse the TLS connection to Groq across dictations,
// skipping a fresh handshake every time (saves ~0.2-0.5s per request).
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

// ---------- text injection ----------
// Primary: tiny native helper (SendInput, terminal-aware, focus restore).
// Fallback: nut-js key simulation if the helper isn't built yet.
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
    log('warning: failed to snapshot prior clipboard:', err.message);
  }

  clipboard.writeText(text);
  await new Promise(r => setTimeout(r, 60));
  try { await pasteViaHelper(); log('inject: native helper OK'); }
  catch (e) { log('inject: helper failed (' + e.message + '), nut-js fallback'); await pasteViaNut(); }

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
      log('warning: failed to restore clipboard:', restoreErr.message);
    }
  }, 600);
}

// ---------- hold-to-talk flow ----------
async function onHotkeyDown() {
  if (recording || busy || !captureWin) return;
  recording = true;
  targetHwnd = await detectTargetWindow(); // remember where the cursor was
  log('hotkey down, target=' + targetHwnd);
  setPill('listening', 'Listening…');
  captureWin.webContents.send('capture-start');
}
async function onHotkeyUp() {
  if (!recording) return;
  recording = false;
  busy = true;
  setPill('working', 'Typing…');
  try {
    const wavBuffer = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('capture timeout')), 15000);
      ipcMain.once('capture-data', (_e, buf) => { clearTimeout(to); resolve(Buffer.from(buf)); });
      captureWin.webContents.send('capture-stop');
    });
    log('capture: got', wavBuffer.length, 'bytes');
    if (wavBuffer.length < 5000) { log('capture: too short, ignoring'); setPill('hidden'); return; }
    const t0 = Date.now();
    setPill('working', 'Transcribing…');
    const raw = await transcribe(wavBuffer);
    log('transcribe took', Date.now() - t0, 'ms');
    const cmd = applyVoiceCommands(formatText(raw));
    if (cmd.scratch) { await scratchLast(); return; }
    if (cmd.action === 'undo') { await undoLast(); return; }
    if (cmd.action === 'delete-word') { await deleteWord(); return; }
    setPill('working', 'Polishing…');
    let clean = cmd.command ? cmd.text : await smartPolish(cmd.text);
    clean = applyDictionary(clean, config.dictionary); // "My words" get the final say
    log('final: "' + clean.slice(0, 80) + '"');
    if (clean) {
      await injectText(clean);
      lastInject = { text: clean, time: Date.now() };
      setPill('done', null, clean); // pill shows what was typed, then fades
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
  log('=== Wispr Tell v0.4.0 starting ===');
  for (const [name, p] of [['paste-helper', PASTE_HELPER]])
    log('self-check', name, fs.existsSync(p) ? 'OK' : 'MISSING: ' + p);
  log('self-check groq-key', config.groqKey ? 'configured' : 'NOT SET');
  createPill();
  createCaptureWin();

  // config IPC
  ipcMain.handle('get-config', () => ({ ...config }));
  ipcMain.handle('set-config', (_e, patch) => {
    config = { ...config, ...patch };
    saveConfig();
    if (patch.launchAtLogin !== undefined && process.platform === 'win32') {
      app.setLoginItemSettings({ openAtLogin: !!patch.launchAtLogin });
    }
    return { ...config };
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
    config.firstRun = false; saveConfig();
    if (welcomeWin && !welcomeWin.isDestroyed()) welcomeWin.close();
  });
  ipcMain.on('mic-level', (_e, level) => {
    if (pill && !pill.isDestroyed()) pill.webContents.send('mic-level', level);
  });
  ipcMain.on('capture-error', (_e, msg) => {
    log('capture ERROR:', msg);
    if (recording) { recording = false; busy = false; setPill('error', 'Mic blocked — ' + String(msg).slice(0, 50)); }
  });
  ipcMain.on('open-external', (_e, url) => {
    if (typeof url === 'string' && /^https:\/\/console\.groq\.com\//.test(url)) shell.openExternal(url);
  });

  const trayIcon = path.join(__dirname, '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'tray.png');
  tray = new Tray(trayIcon);
  tray.setToolTip(config.groqKey
    ? 'Wispr Tell — hold Ctrl+Win to voice type'
    : 'Wispr Tell — add your Groq key in Settings');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Wispr Tell — hold Ctrl+Win to talk', enabled: false },
    { type: 'separator' },
    { label: 'Settings', click: openSettings },
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

  uIOhook.on('keydown', e => {
    heldKeys.add(e.keycode);
    const ctrl = heldKeys.has(UiohookKey.Ctrl) || heldKeys.has(UiohookKey.CtrlRight);
    const win = heldKeys.has(UiohookKey.Meta) || heldKeys.has(UiohookKey.MetaRight);
    if (ctrl && win) onHotkeyDown(); // hold Ctrl+Win together to talk
  });
  uIOhook.on('keyup', e => {
    heldKeys.delete(e.keycode);
    if (recording) onHotkeyUp(); // releasing either key ends dictation
  });
  uIOhook.start();

  if (process.platform === 'win32') {
    app.setLoginItemSettings({ openAtLogin: !!config.launchAtLogin });
  }
  if (config.firstRun) {
    if (config.groqKey) showWelcome();
    else openSettings(); // key first — nothing works without it
  }
});

app.on('window-all-closed', e => e.preventDefault());
app.on('before-quit', () => { try { uIOhook.stop(); } catch {} });
