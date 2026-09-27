// Adversarial Test Suite: M3 History Pruning, Offline Watchdog, Recovery Cooldown, Onboarding & Whisper Prompt Injection
// Verifies:
// 1. Onboarding API key sanitization (whitespace, newlines, invalid prefixes sk_ vs gsk_)
// 2. Whisper dictionary prompt injection (200+ jargon words, quotes, newlines, unicode symbols, 800-char boundary)
// 3. Audio history retention pruning (100 files, >600MB, >14 days old, 50-file limit, 500MB size cap)
// 4. Offline whisper process watchdog (50ms timeout kill, process lock release, no Windows EBUSY on unlink)
// 5. Offline recovery cooldown (network drop triggers offline latch, 60s cooldown expires, cloud re-attempted)

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');

const { WhisperLocalEngine } = require('../../src/offline-whisper.js');
const { buildWhisperPromptBounded, formatWhisperPromptFromDict } = require('../../src/text-utils.js');
const { generateSpeechToneWav } = require('../helpers/audio-generator.js');

/**
 * Creates an isolated execution harness for src/main.js.
 * Provides custom userData directory, simulated time control, and file stat overrides.
 */
function createMainHarness(options = {}) {
  const testDir = path.join(os.tmpdir(), `wispr-adv-m3-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(testDir, { recursive: true });

  const initialConfig = {
    groqKey: options.groqKey || 'gsk_adversarial_test_key_12345',
    smartFix: options.smartFix !== undefined ? options.smartFix : true,
    ...options.configOverrides,
  };
  fs.writeFileSync(path.join(testDir, 'wispr-tell-config.json'), JSON.stringify(initialConfig), 'utf8');

  const mainSrc = fs.readFileSync(path.join(__dirname, '../../src/main.js'), 'utf8');
  const recordedDelays = [];
  const httpLog = [];

  let simulatedNow = null;
  const statOverrides = options.statOverrides || new Map();

  // Custom fs proxy allowing simulated file size and timestamp overrides without allocating large disk space
  const customFs = {
    ...fs,
    statSync: (filePath, opts) => {
      const baseName = path.basename(filePath);
      if (statOverrides.has(baseName)) {
        const override = statOverrides.get(baseName);
        return {
          size: override.size !== undefined ? override.size : fs.statSync(filePath, opts).size,
          mtimeMs: override.mtimeMs !== undefined ? override.mtimeMs : fs.statSync(filePath, opts).mtimeMs,
          isFile: () => true,
          isDirectory: () => false,
        };
      }
      return fs.statSync(filePath, opts);
    },
  };

  class MockDate extends Date {
    static now() {
      if (simulatedNow !== null) return simulatedNow;
      return Date.now();
    }
  }

  const { MockBrowserWindow, MockClipboard, MockIPC, mockApp } = require('../helpers/mock-electron');

  class ExtendedMockBrowserWindow extends MockBrowserWindow {
    loadFile() {}
    loadURL() {}
    setPosition() {}
    isDestroyed() { return false; }
    showInactive() {}
  }

  const mockIpc = new MockIPC();
  const enableLock = options.singleInstanceLock === true;
  const activeTimers = new Set();
  const activeIntervals = new Set();

  const ctx = {
    require: (mod) => {
      if (mod === 'electron') {
        return {
          app: {
            ...mockApp,
            isPackaged: false,
            getPath: (name) => {
              if (name === 'userData') return testDir;
              return os.tmpdir();
            },
            requestSingleInstanceLock: () => enableLock,
            on: () => {},
            whenReady: () => Promise.resolve(),
            setLoginItemSettings: () => {},
            quit: () => {},
          },
          BrowserWindow: ExtendedMockBrowserWindow,
          clipboard: new MockClipboard(),
          ipcMain: mockIpc,
          screen: {
            getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
            getCursorScreenPoint: () => ({ x: 0, y: 0 }),
            getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
          },
          shell: { openExternal: () => {}, openPath: () => {} },
          globalShortcut: { register: () => true, unregisterAll: () => {} },
          session: { defaultSession: { webRequest: { onHeadersReceived: () => {} } } },
          MessageChannelMain: class { constructor() { this.port1 = {}; this.port2 = {}; } },
        };
      }
      if (mod === 'fs') {
        return customFs;
      }
      if (mod === 'uiohook-napi') {
        const EventEmitter = require('events');
        const mockHook = new EventEmitter();
        mockHook.start = () => {};
        mockHook.stop = () => {};
        return { uIOhook: mockHook, UiohookKey: {} };
      }
      if (mod.startsWith('.')) {
        return require(path.resolve(path.join(__dirname, '../../src'), mod));
      }
      return require(mod);
    },
    __dirname: path.resolve(path.join(__dirname, '../../src')),
    __filename: path.resolve(path.join(__dirname, '../../src/main.js')),
    process,
    console,
    Buffer,
    setTimeout: (fn, ms) => {
      recordedDelays.push(ms);
      const effectiveMs = options.fastTimers !== false ? 1 : ms;
      let timerId;
      timerId = setTimeout(() => {
        activeTimers.delete(timerId);
        try { fn(); } catch {}
      }, effectiveMs);
      activeTimers.add(timerId);
      return timerId;
    },
    clearTimeout: (id) => {
      activeTimers.delete(id);
      clearTimeout(id);
    },
    setInterval: (fn, ms) => {
      const id = setInterval(fn, ms);
      activeIntervals.add(id);
      return id;
    },
    clearInterval: (id) => {
      activeIntervals.delete(id);
      clearInterval(id);
    },
    Set,
    Map,
    WeakSet,
    Promise,
    JSON,
    Math,
    Date: MockDate,
    URL,
    module: { exports: {} },
    exports: {},
  };

  vm.createContext(ctx);
  vm.runInContext(mainSrc, ctx);

  const cleanup = () => {
    for (const t of activeTimers) clearTimeout(t);
    activeTimers.clear();
    for (const i of activeIntervals) clearInterval(i);
    activeIntervals.clear();
    try {
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    } catch {}
  };

  return {
    ctx,
    recordedDelays,
    httpLog,
    cleanup,
    testDir,
    ipc: mockIpc,
    audioHistoryDir: path.join(testDir, 'audio-history'),
    statOverrides,
    setSimulatedNow: (ts) => { simulatedNow = ts; },
    getOfflineMode: () => vm.runInContext('isOfflineMode', ctx),
    getLastOfflineTime: () => vm.runInContext('lastOfflineTime', ctx),
    setOfflineMode: (val) => vm.runInContext(`isOfflineMode = ${Boolean(val)}`, ctx),
    setLastOfflineTime: (val) => vm.runInContext(`lastOfflineTime = ${Number(val)}`, ctx),
  };
}

describe('M3 Adversarial: Onboarding Key Sanitization & Format Rejection', () => {
  it('TC-ADV-M3-KEY-01: strips leading and trailing whitespace and preserves valid gsk_ prefix', async () => {
    const { ctx, cleanup } = createMainHarness();
    try {
      let capturedAuthHeader = null;
      ctx.httpRequest = async (opts) => {
        capturedAuthHeader = opts.headers?.Authorization;
        return { status: 200, headers: {}, body: JSON.stringify({ data: [] }) };
      };

      const dirtyKey = '   \t  gsk_valid_production_key_abcdef12345   \t  ';
      const result = await ctx.validateGroqKey(dirtyKey);

      assert.strictEqual(result.ok, true, 'Validation must succeed for trimmed key');
      assert.strictEqual(result.valid, true, 'Result valid flag must be true');
      assert.strictEqual(
        capturedAuthHeader,
        'Bearer gsk_valid_production_key_abcdef12345',
        'Authorization header must transmit strictly sanitized key'
      );
    } finally {
      cleanup();
    }
  });

  it('TC-ADV-M3-KEY-02: strips multiple newlines and carriage returns from pasted keys', async () => {
    const { ctx, cleanup } = createMainHarness();
    try {
      let capturedAuthHeader = null;
      ctx.httpRequest = async (opts) => {
        capturedAuthHeader = opts.headers?.Authorization;
        return { status: 200, headers: {}, body: JSON.stringify({ data: [] }) };
      };

      const dirtyKey = '\r\n\r\n\ngsk_multiline_paste_key_98765\r\n\n\r\n';
      const result = await ctx.validateGroqKey(dirtyKey);

      assert.strictEqual(result.ok, true);
      assert.strictEqual(
        capturedAuthHeader,
        'Bearer gsk_multiline_paste_key_98765',
        'Newlines must be completely excised prior to transport'
      );
    } finally {
      cleanup();
    }
  });

  it('TC-ADV-M3-KEY-03: strips internal newlines and tabs embedded within key body', async () => {
    const { ctx, cleanup } = createMainHarness();
    try {
      let capturedAuthHeader = null;
      ctx.httpRequest = async (opts) => {
        capturedAuthHeader = opts.headers?.Authorization;
        return { status: 200, headers: {}, body: JSON.stringify({ data: [] }) };
      };

      const dirtyKey = 'gsk_part1\r\n\tpart2\npart3';
      const result = await ctx.validateGroqKey(dirtyKey);

      assert.strictEqual(result.ok, true);
      assert.strictEqual(
        capturedAuthHeader,
        'Bearer gsk_part1part2part3',
        'Embedded linebreaks and tabs must be removed'
      );
    } finally {
      cleanup();
    }
  });

  it('TC-ADV-M3-KEY-04: rejects OpenAI sk_ prefix without initiating network request', async () => {
    const { ctx, cleanup } = createMainHarness();
    try {
      let networkCalls = 0;
      ctx.httpRequest = async () => {
        networkCalls++;
        return { status: 200, headers: {}, body: '{}' };
      };

      const openAiKey = 'sk_proj_1234567890abcdefghijklmnopqrstuvwxyz';
      const result = await ctx.validateGroqKey(openAiKey);

      assert.strictEqual(result.ok, false, 'sk_ prefix must be rejected');
      assert.strictEqual(result.valid, false);
      assert.ok(result.error.includes('must start with gsk_'), 'Error must specify required gsk_ prefix');
      assert.strictEqual(networkCalls, 0, 'Invalid prefix must abort before network attempt');
    } finally {
      cleanup();
    }
  });

  it('TC-ADV-M3-KEY-05: rejects invalid prefixes and malformed keys without network calls', async () => {
    const { ctx, cleanup } = createMainHarness();
    try {
      let networkCalls = 0;
      ctx.httpRequest = async () => {
        networkCalls++;
        return { status: 200, headers: {}, body: '{}' };
      };

      const invalidSamples = [
        'Bearer gsk_already_has_bearer',
        'GSK_UPPERCASE_PREFIX',
        'gsk-hyphen-instead-of-underscore',
        'sk-ant-anthropic-key',
        'random_token_string_without_prefix',
        '12345gsk_suffix',
      ];

      for (const sample of invalidSamples) {
        const res = await ctx.validateGroqKey(sample);
        assert.strictEqual(res.ok, false, `Sample "${sample}" must fail validation`);
        assert.strictEqual(res.valid, false);
      }

      assert.strictEqual(networkCalls, 0, 'Zero network calls must be executed for invalid prefix formats');
    } finally {
      cleanup();
    }
  });

  it('TC-ADV-M3-KEY-06: rejects empty strings, whitespace-only, null, and undefined values', async () => {
    const { ctx, cleanup } = createMainHarness();
    try {
      let networkCalls = 0;
      ctx.httpRequest = async () => {
        networkCalls++;
        return { status: 200, headers: {}, body: '{}' };
      };

      const blanks = ['', '   ', '\t\t', '\r\n\r\n', null, undefined];
      for (const blank of blanks) {
        const res = await ctx.validateGroqKey(blank);
        assert.strictEqual(res.ok, false);
        assert.strictEqual(res.valid, false);
        assert.ok(res.error.includes('Paste a key first'));
      }

      assert.strictEqual(networkCalls, 0, 'No network requests for empty inputs');
    } finally {
      cleanup();
    }
  });

  it('TC-ADV-M3-KEY-07: handles Groq HTTP 401 rejected key gracefully', async () => {
    const { ctx, cleanup } = createMainHarness();
    try {
      ctx.httpRequest = async () => ({
        status: 401,
        headers: {},
        body: JSON.stringify({ error: { message: 'Invalid API Key' } }),
      });

      const res = await ctx.validateGroqKey('gsk_invalid_or_revoked_key');
      assert.strictEqual(res.ok, false);
      assert.strictEqual(res.valid, false);
      assert.strictEqual(res.error, 'Key rejected by Groq.');
    } finally {
      cleanup();
    }
  });
});

describe('M3 Adversarial: Whisper Dictionary Prompt Injection & 800-Character Bounding', () => {
  it('TC-ADV-M3-DICT-01: bounds prompt containing 200+ jargon words to <= 800 characters', () => {
    // Generate 250 distinct technical jargon dictionary items
    const dictionary = [];
    const technicalJargon = [
      'Kubernetes', 'WebAssembly', 'CRDT', 'PostgreSQL', 'GraphQL', 'TensorFlow', 'PyTorch',
      'CUDA', 'ZeroCopy', 'AudioWorklet', 'WasmEdge', 'IPCBridge', 'RingBuffer', 'SharedArrayBuffer',
      'SIMD', 'Raycast', 'OpenAI', 'DockerCompose', 'OAuth2', 'WebSocket', 'Prometheus', 'Grafana',
      'Microservice', 'NextJS', 'TailwindCSS', 'Electron', 'Chromium', 'V8Engine', 'EventLoop',
    ];

    for (let i = 0; i < 250; i++) {
      const term = `${technicalJargon[i % technicalJargon.length]}_v${i}`;
      dictionary.push({ from: term.toLowerCase(), to: term });
    }

    const boundedPrompt = buildWhisperPromptBounded(dictionary, 800);

    assert.ok(boundedPrompt.length > 0, 'Prompt must contain terms');
    assert.ok(
      boundedPrompt.length <= 800,
      `Prompt character length (${boundedPrompt.length}) must strictly be <= 800`
    );

    // Verify comma-space separation
    const parsedTerms = boundedPrompt.split(', ');
    assert.ok(parsedTerms.length > 20, 'Must include multiple comma-separated terms');

    // Verify first term matches dictionary start
    assert.strictEqual(parsedTerms[0], 'Kubernetes_v0');

    // Verify that every term in prompt is a complete intact word (not sliced mid-word)
    for (const term of parsedTerms) {
      assert.ok(
        dictionary.some(d => d.to === term),
        `Term "${term}" must exist intact in original dictionary without truncation`
      );
    }
  });

  it('TC-ADV-M3-DICT-02: strips double quotes from dictionary terms to prevent argument injection', () => {
    const maliciousDict = [
      { from: 'test1', to: 'NormalTerm' },
      { from: 'test2', to: 'TermWith"Quotes"' },
      { from: 'test3', to: '"FullyQuotedTerm"' },
      { from: 'test4', to: 'Inject"; rm -rf /; echo "' },
      { from: 'test5', to: 'Robert"); DROP TABLE Students;--' },
    ];

    const boundedPrompt = buildWhisperPromptBounded(maliciousDict, 800);

    assert.strictEqual(
      boundedPrompt.includes('"'),
      false,
      'Double quotes must be completely stripped from prompt'
    );
    assert.ok(boundedPrompt.includes('TermWithQuotes'));
    assert.ok(boundedPrompt.includes('FullyQuotedTerm'));
    assert.ok(boundedPrompt.includes('Inject; rm -rf /; echo'));
    assert.ok(boundedPrompt.includes('Robert); DROP TABLE Students;--'));
  });

  it('TC-ADV-M3-DICT-03: strips carriage returns and newlines from dictionary terms', () => {
    const newlineDict = [
      { from: 'n1', to: 'Line1\nLine2' },
      { from: 'n2', to: 'Carriage\r\nReturn' },
      { from: 'n3', to: '\r\nLeadingTrailing\r\n' },
    ];

    const boundedPrompt = buildWhisperPromptBounded(newlineDict, 800);

    assert.strictEqual(boundedPrompt.includes('\n'), false, 'Prompt must contain 0 newlines');
    assert.strictEqual(boundedPrompt.includes('\r'), false, 'Prompt must contain 0 carriage returns');
    assert.ok(boundedPrompt.includes('Line1Line2'));
    assert.ok(boundedPrompt.includes('CarriageReturn'));
    assert.ok(boundedPrompt.includes('LeadingTrailing'));
  });

  it('TC-ADV-M3-DICT-04: preserves unicode symbols, emojis, and non-ASCII jargon terms without corruption', () => {
    const unicodeDict = [
      { from: 'rocket', to: '🚀RocketApp' },
      { from: 'nihongo', to: '日本語モデル' },
      { from: 'cafe', to: 'CaféAuLait' },
      { from: 'uber', to: 'Übermensch' },
      { from: 'math', to: 'λ-calculus' },
      { from: 'complexity', to: 'O(N²)' },
      { from: 'cyrillic', to: 'Спутник' },
    ];

    const boundedPrompt = buildWhisperPromptBounded(unicodeDict, 800);

    assert.ok(boundedPrompt.includes('🚀RocketApp'));
    assert.ok(boundedPrompt.includes('日本語モデル'));
    assert.ok(boundedPrompt.includes('CaféAuLait'));
    assert.ok(boundedPrompt.includes('Übermensch'));
    assert.ok(boundedPrompt.includes('λ-calculus'));
    assert.ok(boundedPrompt.includes('O(N²)'));
    assert.ok(boundedPrompt.includes('Спутник'));
    assert.ok(boundedPrompt.length <= 800);
  });

  it('TC-ADV-M3-DICT-05: handles extreme single terms exceeding character ceiling safely', () => {
    const giantTerm = 'A'.repeat(900);
    const dict = [
      { from: 'giant', to: giantTerm },
      { from: 'normal', to: 'NormalAfterGiant' },
    ];

    // Single term exceeds 800 characters
    const boundedPrompt = buildWhisperPromptBounded(dict, 800);
    assert.strictEqual(
      boundedPrompt.length <= 800,
      true,
      'Prompt must never exceed 800 chars even with 900-char term'
    );
    assert.strictEqual(boundedPrompt, '', 'Term exceeding limit must be omitted');
  });

  it('TC-ADV-M3-DICT-06: handles empty, null, and non-array dictionary inputs gracefully', () => {
    assert.strictEqual(buildWhisperPromptBounded([]), '');
    assert.strictEqual(buildWhisperPromptBounded(null), '');
    assert.strictEqual(buildWhisperPromptBounded(undefined), '');
    assert.strictEqual(buildWhisperPromptBounded('not an array'), '');
    assert.strictEqual(buildWhisperPromptBounded([null, undefined, 42, {}]), '');
  });

  it('TC-ADV-M3-DICT-07: formats fallback unique terms via formatWhisperPromptFromDict', () => {
    const dict = [
      { from: 'whisper flow', to: 'Wispr Flow' },
      { from: 'wispr flow', to: 'Wispr Flow' }, // Duplicate
      { from: 'graphql', to: 'GraphQL' },
      { from: 'cuda', to: 'CUDA' },
    ];

    const prompt = formatWhisperPromptFromDict(dict);
    assert.strictEqual(prompt, 'Wispr Flow, GraphQL, CUDA', 'Duplicates must be deduped');
  });
});

describe('M3 Adversarial: Audio History Retention Pruning Stress', () => {
  it('TC-ADV-M3-HIST-01: enforces 14-day cutoff, 500MB size cap, and 50-file limit across 100 recordings totaling >600MB', () => {
    const { ctx, cleanup, audioHistoryDir, statOverrides } = createMainHarness();
    try {
      if (!fs.existsSync(audioHistoryDir)) fs.mkdirSync(audioHistoryDir, { recursive: true });

      const now = Date.now();
      const oneDayMs = 24 * 60 * 60 * 1000;

      // Simulate 100 audio recording files
      // 35 files older than 14 days (15 to 50 days old)
      // 65 files within the last 14 days (1 to 13 days old)
      // Each file simulates 6.5 MB -> 100 files = 650 MB (>600 MB)
      const simulatedFileSize = 6.5 * 1024 * 1024; // 6,815,744 bytes

      for (let i = 0; i < 100; i++) {
        const fileName = `rec_${String(i).padStart(3, '0')}.webm`;
        const filePath = path.join(audioHistoryDir, fileName);

        // Create genuine small physical file on disk
        fs.writeFileSync(filePath, Buffer.from(`webm-dummy-data-${i}`));

        let ageDays;
        if (i < 35) {
          // Older than 14 days
          ageDays = 15 + i;
        } else {
          // Within 14 days: spread from 13 days down to 0.1 days
          ageDays = 13 - ((i - 35) / 65) * 12.9;
        }

        const mtimeMs = now - (ageDays * oneDayMs);

        // Register simulated stat override for size and timestamp
        statOverrides.set(fileName, {
          size: simulatedFileSize,
          mtimeMs,
        });
      }

      // Verify initial setup: 100 physical files exist
      const initialFiles = fs.readdirSync(audioHistoryDir).filter(f => f.endsWith('.webm'));
      assert.strictEqual(initialFiles.length, 100, 'Initial setup must have 100 webm files');

      const initialTotalSimulatedSize = initialFiles.length * simulatedFileSize;
      assert.ok(
        initialTotalSimulatedSize > 600 * 1024 * 1024,
        'Initial simulated size must exceed 600MB'
      );

      // Execute pruning engine in main.js
      ctx.pruneAudioRecordings();

      // Read remaining files
      const remainingFiles = fs.readdirSync(audioHistoryDir).filter(f => f.endsWith('.webm'));

      // Check 1: 50-file limit
      assert.ok(
        remainingFiles.length <= 50,
        `Remaining file count (${remainingFiles.length}) must strictly be <= 50`
      );

      // Check 2: 14-day retention limit
      const fourteenDaysAgo = now - (14 * oneDayMs);
      for (const file of remainingFiles) {
        const override = statOverrides.get(file);
        assert.ok(override, `Override for ${file} must exist`);
        assert.ok(
          override.mtimeMs >= fourteenDaysAgo,
          `File ${file} with timestamp ${override.mtimeMs} is older than 14-day cutoff (${fourteenDaysAgo})`
        );
      }

      // Check 3: 500MB size cap
      let totalRemainingSize = 0;
      for (const file of remainingFiles) {
        totalRemainingSize += statOverrides.get(file).size;
      }
      const maxAllowedBytes = 500 * 1024 * 1024;
      assert.ok(
        totalRemainingSize <= maxAllowedBytes,
        `Total remaining size (${totalRemainingSize} bytes) must not exceed 500MB (${maxAllowedBytes} bytes)`
      );

      // Check 4: Age ordering (verify that pruned files were strictly the oldest files)
      // The remaining files must be the latest files among the initial set
      for (const file of remainingFiles) {
        const index = parseInt(file.replace('rec_', '').replace('.webm', ''), 10);
        assert.ok(index >= 35, `File rec_${index} from the older >14d pool was unexpectedly kept`);
      }
    } finally {
      cleanup();
    }
  });

  it('TC-ADV-M3-HIST-02: prunes down to 500MB ceiling when file count <= 50 but size exceeds 500MB', () => {
    const { ctx, cleanup, audioHistoryDir, statOverrides } = createMainHarness();
    try {
      if (!fs.existsSync(audioHistoryDir)) fs.mkdirSync(audioHistoryDir, { recursive: true });

      const now = Date.now();
      const oneDayMs = 24 * 60 * 60 * 1000;

      // 40 files (under the 50-file limit), each simulated at 15MB = 600MB (>500MB cap)
      // All files are recent (between 1 and 5 days old)
      const perFileSize = 15 * 1024 * 1024; // 15 MB
      for (let i = 0; i < 40; i++) {
        const fileName = `large_${String(i).padStart(2, '0')}.webm`;
        const filePath = path.join(audioHistoryDir, fileName);
        fs.writeFileSync(filePath, Buffer.from(`dummy-${i}`));

        // 5 days ago to 1 day ago
        const mtimeMs = now - (5 * oneDayMs) + (i * 0.1 * oneDayMs);
        statOverrides.set(fileName, {
          size: perFileSize,
          mtimeMs,
        });
      }

      ctx.pruneAudioRecordings();

      const remaining = fs.readdirSync(audioHistoryDir).filter(f => f.endsWith('.webm'));
      let remainingBytes = 0;
      for (const f of remaining) {
        remainingBytes += statOverrides.get(f).size;
      }

      const maxBytes = 500 * 1024 * 1024;
      assert.ok(
        remainingBytes <= maxBytes,
        `Size (${remainingBytes} bytes) must be <= 500MB (${maxBytes} bytes)`
      );
      // At 15MB each, 500MB / 15MB = 33.3 files -> exactly 33 files should remain
      assert.strictEqual(remaining.length, 33);
    } finally {
      cleanup();
    }
  });

  it('TC-ADV-M3-HIST-03: preserves non-.webm files in audio-history directory during pruning', () => {
    const { ctx, cleanup, audioHistoryDir, statOverrides } = createMainHarness();
    try {
      if (!fs.existsSync(audioHistoryDir)) fs.mkdirSync(audioHistoryDir, { recursive: true });

      // Create auxiliary files
      const auxFiles = ['metadata.json', 'readme.txt', 'notes.doc', '.gitkeep'];
      for (const aux of auxFiles) {
        fs.writeFileSync(path.join(audioHistoryDir, aux), 'auxiliary content');
      }

      // Create 60 small webm files to trigger pruning
      for (let i = 0; i < 60; i++) {
        const f = `test_${i}.webm`;
        fs.writeFileSync(path.join(audioHistoryDir, f), 'audio');
        statOverrides.set(f, { size: 1000, mtimeMs: Date.now() - (i * 1000) });
      }

      ctx.pruneAudioRecordings();

      // Verify all auxiliary files are untouched
      for (const aux of auxFiles) {
        assert.strictEqual(
          fs.existsSync(path.join(audioHistoryDir, aux)),
          true,
          `Auxiliary file ${aux} must be preserved`
        );
      }

      const remainingWebm = fs.readdirSync(audioHistoryDir).filter(f => f.endsWith('.webm'));
      assert.strictEqual(remainingWebm.length, 50, 'Webm files must be pruned to 50');
    } finally {
      cleanup();
    }
  });
});

describe('M3 Adversarial: Offline Whisper Process Watchdog & Windows EBUSY Elimination', () => {
  it('TC-ADV-M3-OFF-01: watchdog terminates hanging process at 50ms without Windows EBUSY on unlink', async () => {
    const engine = new WhisperLocalEngine({ timeoutMs: 50 });
    const wav = generateSpeechToneWav(0.8);

    let recordedTempPath = null;
    let thrownError = null;

    try {
      const promise = engine.transcribeLocal(wav);
      recordedTempPath = engine.lastCommand?.tempWavPath;
      await promise;
    } catch (err) {
      thrownError = err;
    }

    assert.ok(thrownError, 'Process execution must throw/reject on 50ms watchdog timeout');
    assert.match(
      thrownError.message,
      /Local whisper process timed out after 50ms/,
      'Error message must state timeout duration'
    );

    // Critical assertion: verify no EBUSY error leaked
    assert.strictEqual(
      thrownError.message.includes('EBUSY'),
      false,
      'Windows EBUSY file lock error must NOT be thrown'
    );

    // Verify temp file has been completely unlinked from disk
    const tempPath = engine.lastCommand?.tempWavPath;
    assert.ok(tempPath, 'Temp file path must be recorded');
    assert.strictEqual(
      fs.existsSync(tempPath),
      false,
      'Temporary WAV file must be deleted cleanly following process termination'
    );
  });

  it('TC-ADV-M3-OFF-02: executes 5 consecutive 50ms timeout terminations without process or file lock leakage', async () => {
    const engine = new WhisperLocalEngine({ timeoutMs: 50 });
    const wav = generateSpeechToneWav(0.5);

    for (let cycle = 1; cycle <= 5; cycle++) {
      let cycleError = null;
      try {
        await engine.transcribeLocal(wav);
      } catch (err) {
        cycleError = err;
      }

      assert.ok(cycleError, `Cycle ${cycle} must reject on timeout`);
      assert.match(cycleError.message, /Local whisper process timed out after 50ms/);
      assert.strictEqual(
        cycleError.message.includes('EBUSY'),
        false,
        `Cycle ${cycle} must not encounter EBUSY`
      );

      const tempPath = engine.lastCommand?.tempWavPath;
      assert.strictEqual(
        fs.existsSync(tempPath),
        false,
        `Cycle ${cycle} temp WAV must be deleted`
      );
    }
  });

  it('TC-ADV-M3-OFF-03: passes sanitized prompt to whisper-cli args without quote injection', async () => {
    let capturedArgs = null;
    const engine = new WhisperLocalEngine({
      spawnFn: async (_exe, args) => {
        capturedArgs = args;
        return 'Mock transcript';
      },
    });

    const wav = generateSpeechToneWav(0.2);
    const injectionPrompt = 'Jargon"Term", Another\r\nTerm, Normal';
    await engine.transcribeLocal(wav, { prompt: injectionPrompt });

    assert.ok(capturedArgs.includes('--prompt'), '--prompt flag must be passed');
    const promptIndex = capturedArgs.indexOf('--prompt') + 1;
    const actualPrompt = capturedArgs[promptIndex];

    assert.strictEqual(actualPrompt.includes('"'), false, 'Quotes must be stripped from --prompt arg');
    assert.strictEqual(actualPrompt.includes('\n'), false, 'Newlines must be stripped from --prompt arg');
    assert.strictEqual(actualPrompt, 'JargonTerm, AnotherTerm, Normal');
  });
});

describe('M3 Adversarial: Offline Recovery Cooldown & Cloud Re-attempt', () => {
  it('TC-ADV-M3-REC-01: switches to offline mode on network drop, respects 60s cooldown, and recovers after 60s', async () => {
    const { ctx, cleanup, setSimulatedNow, getOfflineMode, getLastOfflineTime } = createMainHarness({ fastTimers: true });
    try {
      let httpCalls = 0;
      let shouldFailNetwork = false;

      ctx.httpRequest = async (opts) => {
        httpCalls++;
        if (shouldFailNetwork) {
          return { status: 503, headers: {}, body: 'Service Unavailable' };
        }
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({ text: 'Cloud transcription succeeded' }),
        };
      };

      const wav = generateSpeechToneWav(0.2);

      // Phase 1: Initial state is online
      setSimulatedNow(1000000);
      assert.strictEqual(getOfflineMode(), false, 'Initially isOfflineMode must be false');
      assert.strictEqual(getLastOfflineTime(), 0, 'Initially lastOfflineTime must be 0');

      const initialTranscript = await ctx.transcribe(wav);
      assert.strictEqual(initialTranscript, 'Cloud transcription succeeded');
      assert.strictEqual(httpCalls, 1, 'Initial transcription uses cloud');
      assert.strictEqual(getOfflineMode(), false);

      // Phase 2: Simulate network drop
      shouldFailNetwork = true;
      const dropCallsBefore = httpCalls;

      const offlineTranscript = await ctx.transcribe(wav);
      assert.ok(typeof offlineTranscript === 'string', 'Fallback to local whisper succeeds');
      assert.strictEqual(getOfflineMode(), true, 'Network failure must set isOfflineMode to true');
      assert.strictEqual(getLastOfflineTime(), 1000000, 'lastOfflineTime must record timestamp of failure');

      // Phase 3: Dictation during 60s cooldown (advance time by 15s to T+15s)
      setSimulatedNow(1015000);
      const callsBeforeCooldown = httpCalls;

      const cooldownTranscript = await ctx.transcribe(wav);
      assert.ok(typeof cooldownTranscript === 'string');
      const callsDuringCooldown = httpCalls - callsBeforeCooldown;
      assert.strictEqual(
        callsDuringCooldown,
        0,
        'During 60s cooldown, zero network calls must be attempted'
      );
      assert.strictEqual(getOfflineMode(), true, 'isOfflineMode remains true during cooldown');

      // Phase 4: Advance time past 60s cooldown from last offline dictation (advance to 1080000) and restore network
      setSimulatedNow(1080000);
      shouldFailNetwork = false; // Internet restored
      const callsBeforeRecovery = httpCalls;

      const recoveredTranscript = await ctx.transcribe(wav);
      const recoveryCallDelta = httpCalls - callsBeforeRecovery;

      assert.ok(
        recoveryCallDelta > 0,
        'After 60s cooldown expires, cloud transcription must be re-attempted'
      );
      assert.strictEqual(
        recoveredTranscript,
        'Cloud transcription succeeded',
        'Returned text must be from restored cloud service'
      );
      assert.strictEqual(
        getOfflineMode(),
        false,
        'isOfflineMode must reset to false upon successful cloud recovery'
      );
      assert.strictEqual(
        getLastOfflineTime(),
        0,
        'lastOfflineTime must reset to 0 upon successful cloud recovery'
      );
    } finally {
      cleanup();
    }
  });

  it('TC-ADV-M3-REC-02: renews 60s cooldown if cloud re-attempt fails when cooldown expires', async () => {
    const { ctx, cleanup, setSimulatedNow, getOfflineMode, getLastOfflineTime } = createMainHarness({ fastTimers: true });
    try {
      let httpCalls = 0;
      ctx.httpRequest = async () => {
        httpCalls++;
        return { status: 503, headers: {}, body: 'Server Error' };
      };

      const wav = generateSpeechToneWav(0.2);

      // Trigger initial network failure at T=1000000
      setSimulatedNow(1000000);
      await ctx.transcribe(wav);
      assert.strictEqual(getOfflineMode(), true);
      assert.strictEqual(getLastOfflineTime(), 1000000);

      // Advance time past 60s to T=1070000
      setSimulatedNow(1070000);
      const callsBeforeProbe = httpCalls;

      // Re-attempt transcription: cloud is still failing
      await ctx.transcribe(wav);

      // Cloud was probed
      assert.ok(httpCalls > callsBeforeProbe, 'Cloud probe must occur after 60s');
      assert.strictEqual(getOfflineMode(), true, 'isOfflineMode must remain true');
      assert.strictEqual(
        getLastOfflineTime(),
        1070000,
        'lastOfflineTime must be updated to new failure timestamp to reset 60s cooldown'
      );

      // Immediate subsequent call at T=1075000 (5s after new failure) must make 0 calls
      setSimulatedNow(1075000);
      const callsBeforeSecondCooldown = httpCalls;
      await ctx.transcribe(wav);
      assert.strictEqual(
        httpCalls - callsBeforeSecondCooldown,
        0,
        'New 60s cooldown must protect from further network calls'
      );
    } finally {
      cleanup();
    }
  });

  it('TC-ADV-M3-REC-03: reset-offline-mode IPC handler immediately clears offline latch without waiting 60s', async () => {
    const { ctx, cleanup, setSimulatedNow, getOfflineMode, getLastOfflineTime, setOfflineMode, setLastOfflineTime, ipc } = createMainHarness({
      fastTimers: true,
      singleInstanceLock: true,
    });
    try {
      // Drain microtask queue to allow app.whenReady() handler registration
      await new Promise(r => setImmediate(r));

      let httpCalls = 0;
      ctx.httpRequest = async () => {
        httpCalls++;
        return { status: 200, headers: {}, body: JSON.stringify({ text: 'Cloud recovered via reset' }) };
      };

      const wav = generateSpeechToneWav(0.2);

      // Force offline latch
      setSimulatedNow(1000000);
      setOfflineMode(true);
      setLastOfflineTime(1000000);
      assert.strictEqual(getOfflineMode(), true);

      // Only 5 seconds have passed (cooldown still active for 55 more seconds)
      setSimulatedNow(1005000);

      // Invoke IPC handler directly via mock
      const res = await ipc.invoke('reset-offline-mode');
      assert.strictEqual(res.isOfflineMode, false);
      assert.strictEqual(getOfflineMode(), false);
      assert.strictEqual(getLastOfflineTime(), 0);

      const transcript = await ctx.transcribe(wav);
      assert.strictEqual(transcript, 'Cloud recovered via reset');
      assert.strictEqual(httpCalls, 1, 'Immediate cloud attempt occurred after reset');
      assert.strictEqual(getOfflineMode(), false);
    } finally {
      cleanup();
    }
  });

  it('TC-ADV-M3-REC-04: offline cooldown timer does not slide forward when user dictates during cooldown period', async () => {
    const { ctx, cleanup, setSimulatedNow, getOfflineMode, getLastOfflineTime, setOfflineMode, setLastOfflineTime } = createMainHarness({ fastTimers: true });
    try {
      const wav = generateSpeechToneWav(0.2);

      // Initial offline at T = 1000000
      setSimulatedNow(1000000);
      setOfflineMode(true);
      setLastOfflineTime(1000000);

      // User dictates at T = 1020000 (20s into cooldown)
      setSimulatedNow(1020000);
      await ctx.transcribe(wav);
      assert.strictEqual(getLastOfflineTime(), 1000000, 'lastOfflineTime must not slide forward during cooldown dictation');

      // User dictates at T = 1040000 (40s into cooldown)
      setSimulatedNow(1040000);
      await ctx.transcribe(wav);
      assert.strictEqual(getLastOfflineTime(), 1000000, 'lastOfflineTime must remain at 1000000');

      // Advance to T = 1061000 (61s into cooldown, cooldown expired)
      setSimulatedNow(1061000);
      let cloudCalled = false;
      ctx.httpRequest = async () => {
        cloudCalled = true;
        return { status: 200, headers: {}, body: JSON.stringify({ text: 'Cloud recovered' }) };
      };

      const result = await ctx.transcribe(wav);
      assert.strictEqual(cloudCalled, true, 'Cloud probe must execute after 60s from original failure');
      assert.strictEqual(result, 'Cloud recovered');
      assert.strictEqual(getOfflineMode(), false);
      assert.strictEqual(getLastOfflineTime(), 0);
    } finally {
      cleanup();
    }
  });
});
