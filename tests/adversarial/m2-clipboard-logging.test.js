// Adversarial Stress Tests: Clipboard Sequence Restoration & Structured Logging
// Tests Feature 8 (Deterministic Clipboard Sequence Restoration) and Feature 9 (Structured JSON Logging)
// Covers:
// 1. Clipboard sequence race conditions: external sequence changes during paste window abort restore safely
// 2. tell-paste.exe --get-seq outputs valid 32-bit unsigned integers
// 3. Logging circular reference serialization: no crashes and valid NDJSON output
// 4. Log retention pruning: mock historical files and verify files >14 days are purged

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, spawn } = require('child_process');
const vm = require('vm');

const { MockClipboard } = require('../helpers/mock-electron');

// Helper to extract function source code directly from src/main.js
const mainSource = fs.readFileSync(path.resolve(__dirname, '../../src/main.js'), 'utf8');

function extractFunction(name) {
  const regex = new RegExp('function\\s+' + name + '\\s*\\(');
  const match = regex.exec(mainSource);
  if (!match) throw new Error('Function not found in src/main.js: ' + name);
  const start = match.index;
  const paramStart = mainSource.indexOf('(', start);
  let pOpen = 0;
  let p = paramStart;
  while (p < mainSource.length) {
    if (mainSource[p] === '(') pOpen++;
    else if (mainSource[p] === ')') {
      pOpen--;
      if (pOpen === 0) break;
    }
    p++;
  }
  let bodyStart = mainSource.indexOf('{', p);
  let open = 0;
  let i = bodyStart;
  while (i < mainSource.length) {
    if (mainSource[i] === '{') open++;
    else if (mainSource[i] === '}') {
      open--;
      if (open === 0) {
        return mainSource.slice(start, i + 1);
      }
    }
    i++;
  }
  throw new Error('Unterminated function in src/main.js: ' + name);
}

// Instantiate sandboxed execution context for main.js functions
function createMainLoggingContext(customLogDir) {
  const context = {
    fs,
    path,
    console,
    WeakSet,
    Date,
    JSON,
    parseInt,
    String,
    Object,
    Array,
    setTimeout,
    clearTimeout,
    LOGS_DIR: customLogDir,
    LOG_PATH: null,
    initLogPaths: () => {},
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('getLogDateString'), context);
  vm.runInContext(extractFunction('getLogFileName'), context);
  vm.runInContext(extractFunction('safeStringifyLog'), context);
  vm.runInContext(extractFunction('pruneOldLogs'), context);
  vm.runInContext(extractFunction('logStructured'), context);
  vm.runInContext(extractFunction('log'), context);
  return context;
}

function createClipboardContext(clipboardInstance, pasteHelperPath, customPasteFn = null) {
  const capturedLogs = [];
  const context = {
    fs,
    path,
    spawn,
    console,
    setTimeout,
    clearTimeout,
    Promise,
    parseInt,
    clipboard: clipboardInstance,
    PASTE_HELPER: pasteHelperPath,
    pasteViaHelper: customPasteFn || (async () => {}),
    pasteViaNut: async () => {},
    log: (...args) => capturedLogs.push(args.join(' ')),
    capturedLogs,
  };
  vm.createContext(context);
  vm.runInContext(extractFunction('getClipboardSequenceNumber'), context);
  vm.runInContext('async ' + extractFunction('injectText'), context);
  return context;
}

const PASTE_HELPER_PATH = path.resolve(__dirname, '../../bin/native/tell-paste.exe');

// ============================================================================
// SUITE 1: Clipboard Sequence Race Conditions & Anti-Clobber Stress
// ============================================================================
describe('Adversarial M2: Clipboard Sequence Race Conditions', () => {

  it('TC-ADV-CLIP-01: aborts restoration when external process changes clipboard sequence during 600ms paste window', async () => {
    const mockClip = new MockClipboard();
    mockClip.availableFormats = () => ['text/plain'];
    mockClip.writeText('Secret password that was originally on clipboard');

    const ctx = createClipboardContext(mockClip, PASTE_HELPER_PATH);

    // Initial sequence before injection
    const seqInitial = mockClip.getClipboardSequenceNumber();

    // Trigger text injection
    await ctx.injectText('Dictated speech text to paste');

    // Clipboard immediately holds dictated text
    assert.strictEqual(mockClip.readText(), 'Dictated speech text to paste');

    // Simulate external user copying a sensitive token 100ms into the paste window
    await new Promise(r => setTimeout(r, 100));
    mockClip.writeText('External process newly copied token');
    const seqExternal = mockClip.getClipboardSequenceNumber();

    assert.ok(seqExternal > seqInitial);

    // Wait for the 600ms restore timer to fire (wait 700ms total from start)
    await new Promise(r => setTimeout(r, 650));

    // The clipboard MUST still hold the external process data, NOT the original secret password
    assert.strictEqual(mockClip.readText(), 'External process newly copied token');

    // Verify logs confirm sequence mismatch detected and restore aborted
    const mismatchLog = ctx.capturedLogs.find(l => l.includes('clipboard sequence changed') && l.includes('aborting restore'));
    assert.ok(mismatchLog, 'Must log abort due to sequence mismatch');
  });

  it('TC-ADV-CLIP-02: restores original clipboard content when sequence is unchanged', async () => {
    const mockClip = new MockClipboard();
    mockClip.availableFormats = () => ['text/plain'];
    mockClip.writeText('Original clipboard content to preserve');

    const ctx = createClipboardContext(mockClip, PASTE_HELPER_PATH);

    await ctx.injectText('Dictated message');
    assert.strictEqual(mockClip.readText(), 'Dictated message');

    // No external clipboard updates occur
    await new Promise(r => setTimeout(r, 750));

    // Original text must be faithfully restored
    assert.strictEqual(mockClip.readText(), 'Original clipboard content to preserve');
    const restoredLog = ctx.capturedLogs.find(l => l.includes('inject: clipboard restored'));
    assert.ok(restoredLog, 'Must log inject: clipboard restored');
  });

  it('TC-ADV-CLIP-03: survives multiple rapid external clipboard modifications during paste window', async () => {
    const mockClip = new MockClipboard();
    mockClip.availableFormats = () => ['text/plain'];
    mockClip.writeText('Initial user clipboard data');

    const ctx = createClipboardContext(mockClip, PASTE_HELPER_PATH);
    await ctx.injectText('Dictated speech burst');

    // Rapid burst of 10 external copy operations during the paste window
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 20));
      mockClip.writeText(`External copy burst #${i}`);
    }

    await new Promise(r => setTimeout(r, 650));

    // Must preserve the last external copy burst without clobbering
    assert.strictEqual(mockClip.readText(), 'External copy burst #9');
    const mismatchLog = ctx.capturedLogs.find(l => l.includes('clipboard sequence changed') && l.includes('aborting restore'));
    assert.ok(mismatchLog, 'Must safely abort restoration after external copy burst');
  });

  it('TC-ADV-CLIP-04: preserves rich multi-format clipboard and aborts when external plain text copied', async () => {
    const mockClip = new MockClipboard();
    let wrotePayload = null;
    mockClip.availableFormats = () => ['text/html', 'text/rtf', 'text/plain'];
    mockClip.readHTML = () => '<b>Formatted HTML</b>';
    mockClip.readRTF = () => '{\\rtf1 Formatted RTF}';
    mockClip.text = 'Formatted Text';
    mockClip.write = (payload) => { wrotePayload = payload; mockClip.sequenceNumber++; };

    const ctx = createClipboardContext(mockClip, PASTE_HELPER_PATH);
    await ctx.injectText('Plain dictated text');

    // External modification during window
    await new Promise(r => setTimeout(r, 100));
    mockClip.writeText('External simple note');

    await new Promise(r => setTimeout(r, 650));

    // Must preserve external note and not write back rich payload
    assert.strictEqual(mockClip.readText(), 'External simple note');
    assert.strictEqual(wrotePayload, null, 'Must NOT write back old rich payload');
  });

  it('TC-ADV-CLIP-05: handles initially empty clipboard without clobbering external copy', async () => {
    const mockClip = new MockClipboard();
    mockClip.clear();
    mockClip.availableFormats = () => [];

    const ctx = createClipboardContext(mockClip, PASTE_HELPER_PATH);
    await ctx.injectText('Dictated into empty clipboard');

    await new Promise(r => setTimeout(r, 100));
    mockClip.writeText('User copied something while clipboard was originally empty');

    await new Promise(r => setTimeout(r, 650));

    assert.strictEqual(mockClip.readText(), 'User copied something while clipboard was originally empty');
  });

  it('TC-ADV-CLIP-06: handles 32-bit unsigned integer wrap-around boundary condition', async () => {
    const mockClip = new MockClipboard();
    mockClip.availableFormats = () => ['text/plain'];
    mockClip.writeText('Text at integer boundary');

    // Simulate sequence number at 0xFFFFFFFF (4294967295)
    mockClip.sequenceNumber = 4294967295;

    const ctx = createClipboardContext(mockClip, PASTE_HELPER_PATH);
    await ctx.injectText('Dictation before sequence overflow');

    // External copy wraps 32-bit unsigned int to 0
    await new Promise(r => setTimeout(r, 100));
    mockClip.sequenceNumber = 0;
    mockClip.text = 'Wrapped external copy';

    await new Promise(r => setTimeout(r, 650));

    // Inequality (0 !== 4294967295) must detect mismatch and abort
    assert.strictEqual(mockClip.readText(), 'Wrapped external copy');
    const mismatchLog = ctx.capturedLogs.find(l => l.includes('clipboard sequence changed'));
    assert.ok(mismatchLog, 'Sequence wrap must trigger sequence mismatch detection');
  });

  it('TC-ADV-CLIP-07: handles sequence retrieval failure gracefully without throwing', async () => {
    const mockClip = new MockClipboard();
    mockClip.availableFormats = () => ['text/plain'];
    mockClip.writeText('Initial text');

    // Context pointing to non-existent helper path
    const ctx = createClipboardContext(mockClip, 'Z:\\non-existent\\fake-paste.exe');
    // Remove native clipboard function to force helper path
    delete mockClip.getClipboardSequenceNumber;

    // Must execute without unhandled rejection
    await assert.doesNotReject(async () => {
      await ctx.injectText('Dictation text');
    });

    await new Promise(r => setTimeout(r, 700));
  });
});

// ============================================================================
// SUITE 2: Native Executable (tell-paste.exe --get-seq) Validation
// ============================================================================
describe('Adversarial M2: tell-paste.exe --get-seq Validation', () => {

  it('TC-ADV-NAT-01: executes tell-paste.exe --get-seq and validates stdout format', () => {
    assert.ok(fs.existsSync(PASTE_HELPER_PATH), `Binary must exist at ${PASTE_HELPER_PATH}`);

    const res = spawnSync(PASTE_HELPER_PATH, ['--get-seq'], { encoding: 'utf8' });
    assert.strictEqual(res.status, 0, `Process exited with code ${res.status}, stderr: ${res.stderr}`);

    const stdout = res.stdout.trim();
    assert.match(stdout, /^CLIPBOARD_SEQ\s+\d+$/, 'Output must match CLIPBOARD_SEQ <integer>');
    assert.strictEqual(res.stderr, '', 'Stderr must be empty on successful sequence query');
  });

  it('TC-ADV-NAT-02: verifies returned sequence is a valid 32-bit unsigned integer', () => {
    const res = spawnSync(PASTE_HELPER_PATH, ['--get-seq'], { encoding: 'utf8' });
    assert.strictEqual(res.status, 0);

    const match = res.stdout.trim().match(/^CLIPBOARD_SEQ\s+(\d+)$/);
    assert.ok(match, 'Must match CLIPBOARD_SEQ pattern');

    const seqNumber = Number(match[1]);
    assert.ok(Number.isSafeInteger(seqNumber), 'Sequence must be a safe integer');
    assert.ok(seqNumber >= 0, 'Sequence must be non-negative');
    assert.ok(seqNumber <= 0xFFFFFFFF, 'Sequence must fit within 32-bit unsigned integer (<= 4294967295)');
    assert.strictEqual(seqNumber >>> 0, seqNumber, 'Sequence must strictly match 32-bit unsigned bitwise conversion');
  });

  it('TC-ADV-NAT-03: verifies sequence number increments when Windows clipboard is modified', () => {
    // 1. Read initial sequence
    const res1 = spawnSync(PASTE_HELPER_PATH, ['--get-seq'], { encoding: 'utf8' });
    assert.strictEqual(res1.status, 0);
    const seq1 = parseInt(res1.stdout.match(/CLIPBOARD_SEQ\s+(\d+)/)[1], 10);

    // 2. Modify Windows clipboard via powershell Set-Clipboard
    const testPayload = `WisprTell_Adversarial_SeqTest_${Date.now()}_${Math.random()}`;
    const psRes = spawnSync('powershell.exe', ['-NoProfile', '-Command', `Set-Clipboard -Value "${testPayload}"`]);
    assert.strictEqual(psRes.status, 0, 'PowerShell Set-Clipboard must succeed');

    // 3. Read updated sequence
    const res2 = spawnSync(PASTE_HELPER_PATH, ['--get-seq'], { encoding: 'utf8' });
    assert.strictEqual(res2.status, 0);
    const seq2 = parseInt(res2.stdout.match(/CLIPBOARD_SEQ\s+(\d+)/)[1], 10);

    // 4. Assert sequence incremented (or wrapped)
    assert.ok(seq2 > seq1 || (seq1 === 0xFFFFFFFF && seq2 === 0), `Sequence must increment after clipboard write: seq1=${seq1}, seq2=${seq2}`);
  });

  it('TC-ADV-NAT-04: handles high-frequency burst execution of 20 rapid calls without failure', () => {
    const sequences = [];
    const startTime = Date.now();

    for (let i = 0; i < 20; i++) {
      const res = spawnSync(PASTE_HELPER_PATH, ['--get-seq'], { encoding: 'utf8' });
      assert.strictEqual(res.status, 0, `Burst call ${i} failed`);
      const match = res.stdout.trim().match(/^CLIPBOARD_SEQ\s+(\d+)$/);
      assert.ok(match, `Burst call ${i} gave invalid output: ${res.stdout}`);
      const val = parseInt(match[1], 10);
      assert.ok(val >= 0 && val <= 0xFFFFFFFF);
      sequences.push(val);
    }

    const elapsed = Date.now() - startTime;
    assert.strictEqual(sequences.length, 20);
    // Ensure all returned integers are valid
    sequences.forEach(seq => assert.ok(Number.isInteger(seq)));
  });

  it('TC-ADV-NAT-05: verifies tell-paste.exe --capabilities includes clipboard-seq-v1', () => {
    const res = spawnSync(PASTE_HELPER_PATH, ['--capabilities'], { encoding: 'utf8' });
    assert.strictEqual(res.status, 0);
    assert.ok(res.stdout.includes('clipboard-seq-v1'), 'Capabilities output must contain clipboard-seq-v1');
  });

  it('TC-ADV-NAT-06: handles unrecognized flags gracefully without crashing or hanging', () => {
    const res = spawnSync(PASTE_HELPER_PATH, ['--unrecognized-adversarial-flag-12345'], { encoding: 'utf8', timeout: 3000 });
    // Should exit in finite time without hanging
    assert.ok(res.status !== null, 'Process must terminate within timeout');
  });
});

// ============================================================================
// SUITE 3: Structured Logging Circular Reference Serialization & NDJSON
// ============================================================================
describe('Adversarial M2: Logging Circular Reference Serialization & NDJSON', () => {
  let tempLogDir;
  let ctx;

  before(() => {
    tempLogDir = path.join(os.tmpdir(), `wispr-log-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    fs.mkdirSync(tempLogDir, { recursive: true });
    ctx = createMainLoggingContext(tempLogDir);
  });

  after(() => {
    try {
      if (fs.existsSync(tempLogDir)) {
        fs.rmSync(tempLogDir, { recursive: true, force: true });
      }
    } catch {}
  });

  it('TC-ADV-LOG-01: serializes self-referencing circular object without throwing', () => {
    const selfRef = { name: 'self-referencing' };
    selfRef.cycle = selfRef;

    let serialized;
    assert.doesNotThrow(() => {
      serialized = ctx.safeStringifyLog(selfRef);
    });

    assert.ok(typeof serialized === 'string');
    assert.ok(serialized.includes('[Circular]'));

    // Result must be valid parseable JSON
    const parsed = JSON.parse(serialized);
    assert.strictEqual(parsed.name, 'self-referencing');
    assert.strictEqual(parsed.cycle, '[Circular]');
  });

  it('TC-ADV-LOG-02: serializes multi-node circular dependency graph without throwing', () => {
    const nodeA = { id: 'A' };
    const nodeB = { id: 'B' };
    const nodeC = { id: 'C' };
    nodeA.next = nodeB;
    nodeB.next = nodeC;
    nodeC.next = nodeA; // Loop back to A

    let serialized;
    assert.doesNotThrow(() => {
      serialized = ctx.safeStringifyLog(nodeA);
    });

    const parsed = JSON.parse(serialized);
    assert.strictEqual(parsed.id, 'A');
    assert.strictEqual(parsed.next.id, 'B');
    assert.strictEqual(parsed.next.next.id, 'C');
    assert.strictEqual(parsed.next.next.next, '[Circular]');
  });

  it('TC-ADV-LOG-03: serializes circular array structures without throwing', () => {
    const arr = [1, 'element'];
    arr.push(arr);

    let serialized;
    assert.doesNotThrow(() => {
      serialized = ctx.safeStringifyLog(arr);
    });

    const parsed = JSON.parse(serialized);
    assert.strictEqual(parsed[0], 1);
    assert.strictEqual(parsed[1], 'element');
    assert.strictEqual(parsed[2], '[Circular]');
  });

  it('TC-ADV-LOG-04: logStructured writes valid single-line NDJSON to disk with circular metadata', () => {
    const circularMeta = {
      task: 'transcription',
      subtasks: [],
    };
    circularMeta.subtasks.push(circularMeta);

    const entry = ctx.logStructured('info', 'pipeline', 'Speech pipeline finished', circularMeta);

    assert.strictEqual(entry.level, 'info');
    assert.strictEqual(entry.category, 'pipeline');
    assert.strictEqual(entry.message, 'Speech pipeline finished');

    const logFile = path.join(tempLogDir, ctx.getLogFileName());
    assert.ok(fs.existsSync(logFile), 'Log file must be created on disk');

    const content = fs.readFileSync(logFile, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    const lastLine = lines[lines.length - 1];

    // Verify valid single-line JSON
    const parsedLine = JSON.parse(lastLine);
    assert.strictEqual(parsedLine.message, 'Speech pipeline finished');
    assert.strictEqual(parsedLine.metadata.task, 'transcription');
    assert.strictEqual(parsedLine.metadata.subtasks[0], '[Circular]');
  });

  it('TC-ADV-LOG-05: backward-compatible log(...) parses prefixes and handles circular args', () => {
    const circularDetails = { error: 'Network timeout' };
    circularDetails.ref = circularDetails;

    ctx.log('groq: Connection failed after retry', circularDetails);

    const logFile = path.join(tempLogDir, ctx.getLogFileName());
    const content = fs.readFileSync(logFile, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    const lastLine = lines[lines.length - 1];

    const parsed = JSON.parse(lastLine);
    assert.strictEqual(parsed.category, 'groq');
    assert.strictEqual(parsed.level, 'error'); // Inferred from 'failed'
    assert.strictEqual(parsed.metadata.error, 'Network timeout');
    assert.strictEqual(parsed.metadata.ref, '[Circular]');
  });

  it('TC-ADV-LOG-06: strictly enforces single-line NDJSON format with multiline strings and errors', () => {
    const multilineMessage = "Line 1: An exception occurred\r\nLine 2: Stack trace here\nLine 3: End of error";
    const multilineMetadata = {
      stack: "Error: something broke\n    at foo.js:10:5\n    at bar.js:20:9",
      notes: "First note\r\nSecond note",
    };

    const initialLineCount = fs.existsSync(path.join(tempLogDir, ctx.getLogFileName()))
      ? fs.readFileSync(path.join(tempLogDir, ctx.getLogFileName()), 'utf8').trim().split('\n').filter(Boolean).length
      : 0;

    ctx.logStructured('error', 'unhandled', multilineMessage, multilineMetadata);

    const content = fs.readFileSync(path.join(tempLogDir, ctx.getLogFileName()), 'utf8');
    const allLines = content.trim().split('\n').filter(Boolean);

    // Exactly ONE line must have been added despite multiline inputs
    assert.strictEqual(allLines.length, initialLineCount + 1, 'Multiline inputs must NOT break NDJSON single-line invariant');

    // The line itself must parse cleanly
    const lastLine = allLines[allLines.length - 1];
    const parsed = JSON.parse(lastLine);
    assert.strictEqual(parsed.message, multilineMessage);
    assert.strictEqual(parsed.metadata.stack, multilineMetadata.stack);
  });

  it('TC-ADV-LOG-07: serializes 50-level deeply nested object without stack overflow', () => {
    let deepObj = { level: 50 };
    for (let i = 49; i >= 1; i--) {
      deepObj = { level: i, child: deepObj };
    }

    let serialized;
    assert.doesNotThrow(() => {
      serialized = ctx.safeStringifyLog(deepObj);
    });

    const parsed = JSON.parse(serialized);
    assert.strictEqual(parsed.level, 1);
    assert.strictEqual(parsed.child.level, 2);
  });

  it('TC-ADV-LOG-08: serializes complex exotic types (null, NaN, Infinity, Date, RegExp) safely', () => {
    const exotic = {
      n: null,
      nan: NaN,
      inf: Infinity,
      d: new Date('2026-09-27T00:00:00Z'),
      r: /test-regex/gi,
      fn: () => 'ignored',
    };

    let serialized;
    assert.doesNotThrow(() => {
      serialized = ctx.safeStringifyLog(exotic);
    });

    const parsed = JSON.parse(serialized);
    assert.strictEqual(parsed.n, null);
    assert.strictEqual(parsed.nan, null);
    assert.strictEqual(parsed.inf, null);
    assert.strictEqual(parsed.d, '2026-09-27T00:00:00.000Z');
  });
});

// ============================================================================
// SUITE 4: Log Retention Pruning
// ============================================================================
describe('Adversarial M2: Log Retention Pruning', () => {
  let pruneTestDir;
  let ctx;

  before(() => {
    pruneTestDir = path.join(os.tmpdir(), `wispr-prune-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    fs.mkdirSync(pruneTestDir, { recursive: true });
    ctx = createMainLoggingContext(pruneTestDir);
  });

  after(() => {
    try {
      if (fs.existsSync(pruneTestDir)) {
        fs.rmSync(pruneTestDir, { recursive: true, force: true });
      }
    } catch {}
  });

  it('TC-ADV-PRUNE-01: purges files older than 14 days and preserves files within 14 days', () => {
    const currentDate = new Date('2026-09-27T00:00:00Z');

    // Create test files
    const fileDates = [
      { name: 'wispr-tell-2026-09-02.log', shouldDelete: true, desc: '25 days ago' },
      { name: 'wispr-tell-2026-09-07.log', shouldDelete: true, desc: '20 days ago' },
      { name: 'wispr-tell-2026-09-12.log', shouldDelete: true, desc: '15 days ago' },
      { name: 'wispr-tell-2026-09-13.log', shouldDelete: false, desc: '14 days ago (boundary cutoff)' },
      { name: 'wispr-tell-2026-09-14.log', shouldDelete: false, desc: '13 days ago' },
      { name: 'wispr-tell-2026-09-20.log', shouldDelete: false, desc: '7 days ago' },
      { name: 'wispr-tell-2026-09-26.log', shouldDelete: false, desc: '1 day ago' },
      { name: 'wispr-tell-2026-09-27.log', shouldDelete: false, desc: 'today' },
      { name: 'wispr-tell-2026-09-28.log', shouldDelete: false, desc: 'tomorrow / future' },
    ];

    for (const f of fileDates) {
      fs.writeFileSync(path.join(pruneTestDir, f.name), `{"date":"${f.name}"}\n`, 'utf8');
    }

    // Run pruning with 14-day retention policy
    const deleted = ctx.pruneOldLogs(pruneTestDir, 14, currentDate);

    // Verify returned deleted array
    assert.strictEqual(deleted.length, 3, 'Must delete exactly 3 files older than 14 days');
    assert.ok(deleted.includes('wispr-tell-2026-09-02.log'));
    assert.ok(deleted.includes('wispr-tell-2026-09-07.log'));
    assert.ok(deleted.includes('wispr-tell-2026-09-12.log'));

    // Verify files on disk
    for (const f of fileDates) {
      const exists = fs.existsSync(path.join(pruneTestDir, f.name));
      if (f.shouldDelete) {
        assert.strictEqual(exists, false, `File ${f.name} (${f.desc}) should have been purged`);
      } else {
        assert.strictEqual(exists, true, `File ${f.name} (${f.desc}) should have been preserved`);
      }
    }
  });

  it('TC-ADV-PRUNE-02: preserves non-log files, config files, and subdirectories', () => {
    const preserveItems = [
      'wispr-tell.config.json',
      'settings.json',
      'backup-2026-08-01.zip',
      'random-log-file.txt',
      'wispr-tell-old.bak',
    ];

    for (const item of preserveItems) {
      fs.writeFileSync(path.join(pruneTestDir, item), 'preserve-me', 'utf8');
    }

    const subDirPath = path.join(pruneTestDir, 'old-session-2026-08-01');
    fs.mkdirSync(subDirPath, { recursive: true });

    const deleted = ctx.pruneOldLogs(pruneTestDir, 14, new Date('2026-09-27T00:00:00Z'));

    for (const item of preserveItems) {
      assert.strictEqual(fs.existsSync(path.join(pruneTestDir, item)), true, `Item ${item} must not be deleted`);
    }
    assert.strictEqual(fs.existsSync(subDirPath), true, 'Subdirectory must not be deleted');
  });

  it('TC-ADV-PRUNE-03: correctly prunes wispr-tell-YYYY-MM-DD.json.log alternate naming pattern', () => {
    const oldJsonLog = 'wispr-tell-2026-09-01.json.log';
    const recentJsonLog = 'wispr-tell-2026-09-25.json.log';

    fs.writeFileSync(path.join(pruneTestDir, oldJsonLog), '{"test":true}\n');
    fs.writeFileSync(path.join(pruneTestDir, recentJsonLog), '{"test":true}\n');

    const deleted = ctx.pruneOldLogs(pruneTestDir, 14, new Date('2026-09-27T00:00:00Z'));

    assert.ok(deleted.includes(oldJsonLog), 'Old json.log must be pruned');
    assert.strictEqual(fs.existsSync(path.join(pruneTestDir, oldJsonLog)), false);
    assert.strictEqual(fs.existsSync(path.join(pruneTestDir, recentJsonLog)), true);
  });

  it('TC-ADV-PRUNE-04: ignores malformed or corrupt date strings in log filenames without error', () => {
    const corruptFiles = [
      'wispr-tell-9999-99-99.log',
      'wispr-tell-0000-00-00.log',
      'wispr-tell-invalid-date.log',
    ];

    for (const file of corruptFiles) {
      fs.writeFileSync(path.join(pruneTestDir, file), 'corrupt date\n');
    }

    assert.doesNotThrow(() => {
      ctx.pruneOldLogs(pruneTestDir, 14, new Date('2026-09-27T00:00:00Z'));
    });
  });

  it('TC-ADV-PRUNE-05: handles non-existent or empty directories gracefully', () => {
    const nonExistent = path.join(os.tmpdir(), 'non-existent-dir-' + Date.now());
    const res = ctx.pruneOldLogs(nonExistent, 14);
    assert.strictEqual(Array.isArray(res), true);
    assert.strictEqual(res.length, 0);

    const emptyDir = path.join(os.tmpdir(), 'empty-dir-' + Date.now());
    fs.mkdirSync(emptyDir, { recursive: true });
    try {
      const resEmpty = ctx.pruneOldLogs(emptyDir, 14);
      assert.strictEqual(Array.isArray(resEmpty), true);
      assert.strictEqual(resEmpty.length, 0);
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it('TC-ADV-PRUNE-06: respects custom retention period days parameter', () => {
    const customPruneDir = path.join(os.tmpdir(), `wispr-custom-retention-${Date.now()}`);
    fs.mkdirSync(customPruneDir, { recursive: true });

    try {
      const files = [
        { name: 'wispr-tell-2026-09-20.log', daysAgo: 7 },
        { name: 'wispr-tell-2026-09-24.log', daysAgo: 3 },
        { name: 'wispr-tell-2026-09-26.log', daysAgo: 1 },
      ];

      for (const f of files) {
        fs.writeFileSync(path.join(customPruneDir, f.name), 'log\n');
      }

      // Retention period = 2 days: only 2026-09-26 is within 2 days
      const deleted = ctx.pruneOldLogs(customPruneDir, 2, new Date('2026-09-27T00:00:00Z'));

      assert.strictEqual(deleted.length, 2);
      assert.ok(deleted.includes('wispr-tell-2026-09-20.log'));
      assert.ok(deleted.includes('wispr-tell-2026-09-24.log'));
      assert.strictEqual(fs.existsSync(path.join(customPruneDir, 'wispr-tell-2026-09-26.log')), true);
    } finally {
      fs.rmSync(customPruneDir, { recursive: true, force: true });
    }
  });
});
