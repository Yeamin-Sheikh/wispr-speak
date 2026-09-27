// Challenger 2 Adversarial Stress Suite: Feature 15 and Defect 3 Verification
// Verifies:
// 1. capture.html initializes MediaRecorder with audio/webm;codecs=opus and delivers WebM chunks
// 2. addHistoryItem stores compressed audio buffer, rejects raw WAV when compressed audio absent
// 3. executeAudioPipeline() probes cloud transcription when cooldown expired without sliding lastOfflineTime

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const { generateSpeechToneWav } = require('../helpers/audio-generator.js');

async function createMainPipelineHarness(options = {}) {
  const testDir = path.join(os.tmpdir(), `wispr-chal2-stress-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(testDir, { recursive: true });

  const initialConfig = {
    groqKey: options.groqKey || 'gsk_valid_stress_key_12345',
    smartFix: false,
    dictionary: [],
    voiceCommands: [],
    ...options.configOverrides,
  };
  fs.writeFileSync(path.join(testDir, 'wispr-tell-config.json'), JSON.stringify(initialConfig), 'utf8');

  const mainSrc = fs.readFileSync(path.join(__dirname, '../../src/main.js'), 'utf8');
  let simulatedNow = null;

  class MockDate extends Date {
    static now() {
      if (simulatedNow !== null) return simulatedNow;
      return Date.now();
    }
  }

  const { MockBrowserWindow, MockClipboard, MockIPC, mockApp } = require('../helpers/mock-electron');

  class ExtendedMockBrowserWindow extends MockBrowserWindow {
    constructor(opts) {
      super(opts);
      this.webContents.isDestroyed = () => false;
    }
    loadFile() {}
    loadURL() {}
    setPosition() {}
    isDestroyed() { return false; }
    showInactive() {}
  }

  const mockIpc = new MockIPC();
  const activeTimers = new Set();
  const activeIntervals = new Set();
  const networkCalls = [];

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
            requestSingleInstanceLock: () => true,
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
        return fs;
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
      const timerId = setTimeout(() => {
        activeTimers.delete(timerId);
        try { fn(); } catch {}
      }, 1);
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

  // Drain microtasks for app.whenReady()
  await new Promise(r => setImmediate(r));

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
    cleanup,
    testDir,
    ipc: mockIpc,
    audioHistoryDir: path.join(testDir, 'audio-history'),
    networkCalls,
    setSimulatedNow: (ts) => { simulatedNow = ts; },
    getOfflineMode: () => vm.runInContext('isOfflineMode', ctx),
    setOfflineMode: (val) => vm.runInContext(`isOfflineMode = ${Boolean(val)}`, ctx),
    getLastOfflineTime: () => vm.runInContext('lastOfflineTime', ctx),
    setLastOfflineTime: (val) => vm.runInContext(`lastOfflineTime = ${Number(val)}`, ctx),
    setActiveStreamSession: (sess) => vm.runInContext('activeStreamSession', ctx, sess ? { ...sess } : null),
    executePipeline: () => vm.runInContext('executeAudioPipeline()', ctx),
    addHistoryItem: (text, dur, opts) => vm.runInContext('addHistoryItem', ctx)(text, dur, opts),
  };
}

describe('Challenger 2 Suite 1: capture.html MediaRecorder & Opus Implementation', () => {
  it('TC-CHAL-CAP-01: verifies capture.html initializes MediaRecorder with audio/webm;codecs=opus', () => {
    const capturePath = path.resolve(__dirname, '../../src/renderer/capture.html');
    const content = fs.readFileSync(capturePath, 'utf8');

    // 1. Checks mimeType detection for audio/webm;codecs=opus
    assert.match(
      content,
      /MediaRecorder\.isTypeSupported\(['"]audio\/webm;codecs=opus['"]\)/,
      'capture.html must probe for audio/webm;codecs=opus support'
    );

    // 2. Instantiates MediaRecorder with mimeType
    assert.match(
      content,
      /new\s+MediaRecorder\(stream,\s*\{\s*mimeType\s*\}\)/,
      'capture.html must construct MediaRecorder with selected mimeType'
    );

    // 3. Collects chunk on dataavailable
    assert.match(
      content,
      /mediaRecorder\.ondataavailable\s*=\s*e\s*=>\s*\{[\s\S]*?mediaRecorderChunks\.push\(e\.data\);?[\s\S]*?\}/,
      'capture.html must push chunks from ondataavailable'
    );

    // 4. Starts with 100ms timeslices
    assert.match(
      content,
      /mediaRecorder\.start\(100\)/,
      'capture.html must start MediaRecorder with 100ms chunk frequency'
    );

    // 5. Converts accumulated chunks to Blob and ArrayBuffer in stop()
    assert.match(
      content,
      /new\s+Blob\(mediaRecorderChunks,\s*\{\s*type:\s*['"]audio\/webm['"]\s*\}\)/,
      'capture.html must wrap chunks in audio/webm Blob'
    );
    assert.match(
      content,
      /await\s+blob\.arrayBuffer\(\)/,
      'capture.html must convert Blob to ArrayBuffer'
    );

    // 6. Transmits compressed buffer via sendCaptureData
    assert.match(
      content,
      /window\.wisprtell\.sendCaptureData\(fullWav,\s*compressedAudioBuffer\)/,
      'capture.html must deliver compressedAudioBuffer alongside fullWav to main'
    );
  });

  it('TC-CHAL-CAP-02: verifies preload.js bridges compressedBuf through sendCaptureData', () => {
    const preloadPath = path.resolve(__dirname, '../../src/preload.js');
    const content = fs.readFileSync(preloadPath, 'utf8');

    assert.match(
      content,
      /sendCaptureData:\s*\(buf,\s*compressedBuf\)\s*=>\s*ipcRenderer\.send\(['"]capture-data['"],\s*buf,\s*compressedBuf\)/,
      'preload.js must forward both buf and compressedBuf to IPC'
    );
  });
});

describe('Challenger 2 Suite 2: Feature 15 Compressed Audio Storage Integrity', () => {
  it('TC-CHAL-HIST-01: saves authentic WebM buffer to disk and does not create file when compressed buffer missing', async () => {
    const harness = await createMainPipelineHarness();
    try {
      const mockWebm = Buffer.from([0x1A, 0x45, 0xDF, 0xA3, 0x01, 0x02, 0x03, 0x04]);

      // Dictation with genuine compressed audio
      const itemWithAudio = harness.addHistoryItem('Dictation with authentic compressed opus', 1500, {
        offline: false,
        compressedAudioBuffer: mockWebm,
      });

      assert.ok(itemWithAudio);
      assert.ok(itemWithAudio.audioFile.endsWith('.webm'));
      const filePath = path.join(harness.audioHistoryDir, itemWithAudio.audioFile);
      assert.strictEqual(fs.existsSync(filePath), true, 'File must exist on disk');
      const savedBytes = fs.readFileSync(filePath);
      assert.deepStrictEqual(savedBytes, mockWebm, 'Saved bytes must match compressed WebM data');

      // Dictation WITHOUT compressed audio (e.g. MediaRecorder unavailable or VAD rejected)
      const itemWithoutAudio = harness.addHistoryItem('Dictation with no compressed audio available', 1200, {
        offline: false,
        compressedAudioBuffer: null,
      });

      assert.ok(itemWithoutAudio);
      assert.strictEqual(
        itemWithoutAudio.audioFile,
        null,
        'audioFile must be null when compressed buffer is absent'
      );
    } finally {
      harness.cleanup();
    }
  });

  it('TC-CHAL-HIST-02: get-history-audio returns base64 dataUrl for WebM file and null for missing file', async () => {
    const harness = await createMainPipelineHarness();
    try {
      const mockWebm = Buffer.from('RIFF-NOT-THIS-IS-WEBM-OPUS');
      const item = harness.addHistoryItem('Entry for audio playback query', 2000, {
        compressedAudioBuffer: mockWebm,
      });

      // Invoke IPC handle
      const result = await harness.ipc.invoke('get-history-audio', item.id);
      assert.ok(result);
      assert.strictEqual(result.id, item.id);
      assert.strictEqual(result.fileName, item.audioFile);
      assert.strictEqual(result.sizeBytes, mockWebm.length);
      assert.ok(result.dataUrl.startsWith('data:audio/webm;base64,'));
      const decodedBase64 = Buffer.from(result.dataUrl.replace('data:audio/webm;base64,', ''), 'base64');
      assert.deepStrictEqual(decodedBase64, mockWebm);

      // Non-existent id returns null
      const nonExistent = await harness.ipc.invoke('get-history-audio', 'non_existent_id');
      assert.strictEqual(nonExistent, null);
    } finally {
      harness.cleanup();
    }
  });
});

describe('Challenger 2 Suite 3: Defect 3 executeAudioPipeline Offline Cooldown Probing & Timer Pinning', () => {
  it('TC-CHAL-PIPE-01: executeAudioPipeline() respects cooldown, does NOT slide lastOfflineTime on offline dictation, and recovers when cooldown expires', async () => {
    const harness = await createMainPipelineHarness();
    try {
      let cloudCalls = 0;

      // Mock httpRequest for Groq
      harness.ctx.httpRequest = async () => {
        cloudCalls++;
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({ text: 'Cloud pipeline recovered' }),
        };
      };

      // Mock local whisper to return immediately
      harness.ctx.localWhisper = {
        isAvailable: () => true,
        transcribeLocal: async () => 'Local whisper offline transcript',
      };

      // Mock text injection helper
      harness.ctx.injectText = async () => {};

      const testWav = generateSpeechToneWav(0.5);
      const testWebm = Buffer.from([0x1A, 0x45, 0xDF, 0xA3]);

      // Phase 1: Set initial offline state at T = 1,000,000
      harness.setSimulatedNow(1000000);
      harness.setOfflineMode(true);
      harness.setLastOfflineTime(1000000);
      assert.strictEqual(harness.getOfflineMode(), true);
      assert.strictEqual(harness.getLastOfflineTime(), 1000000);

      // Phase 2: First dictation during cooldown at T = 1,015,000 (15 seconds into cooldown)
      harness.setSimulatedNow(1015000);
      const callsBefore1 = cloudCalls;

      const pipelinePromise1 = harness.executePipeline();
      // Emit capture-data event concurrently
      harness.ipc.emit('capture-data', {}, testWav, testWebm);
      await pipelinePromise1;

      // Assertions for dictation 1
      assert.strictEqual(
        cloudCalls - callsBefore1,
        0,
        'Zero cloud calls must be attempted during active cooldown'
      );
      assert.strictEqual(
        harness.getLastOfflineTime(),
        1000000,
        'CRUCIAL: lastOfflineTime must NOT slide forward on offline dictation at T+15s'
      );
      assert.strictEqual(harness.getOfflineMode(), true);

      // Phase 3: Second dictation during cooldown at T = 1,040,000 (40 seconds into cooldown)
      harness.setSimulatedNow(1040000);
      const callsBefore2 = cloudCalls;

      const pipelinePromise2 = harness.executePipeline();
      harness.ipc.emit('capture-data', {}, testWav, testWebm);
      await pipelinePromise2;

      // Assertions for dictation 2
      assert.strictEqual(
        cloudCalls - callsBefore2,
        0,
        'Zero cloud calls must be attempted at T+40s'
      );
      assert.strictEqual(
        harness.getLastOfflineTime(),
        1000000,
        'CRUCIAL: lastOfflineTime must NOT slide forward on offline dictation at T+40s'
      );
      assert.strictEqual(harness.getOfflineMode(), true);

      // Phase 4: Third dictation after cooldown expiration at T = 1,061,000 (61s after initial failure)
      // Cooldown has expired (1,061,000 - 1,000,000 = 61,000 >= 60,000)
      harness.setSimulatedNow(1061000);
      const callsBefore3 = cloudCalls;

      const pipelinePromise3 = harness.executePipeline();
      harness.ipc.emit('capture-data', {}, testWav, testWebm);
      await pipelinePromise3;

      // Assertions for dictation 3 (cooldown expired, cloud restored)
      assert.ok(
        cloudCalls - callsBefore3 > 0,
        'Cloud transcription MUST be probed in executeAudioPipeline() after 60s cooldown expires'
      );
      assert.strictEqual(
        harness.getOfflineMode(),
        false,
        'isOfflineMode must reset to false upon successful cloud recovery'
      );
      assert.strictEqual(
        harness.getLastOfflineTime(),
        0,
        'lastOfflineTime must reset to 0 upon successful cloud recovery'
      );
    } finally {
      harness.cleanup();
    }
  });

  it('TC-CHAL-PIPE-02: executeAudioPipeline() with active streaming session latches offline mode and sets lastOfflineTime on streaming failure', async () => {
    const harness = await createMainPipelineHarness();
    try {
      harness.ctx.localWhisper = {
        isAvailable: () => true,
        transcribeLocal: async () => 'Local whisper fallback after streaming failure',
      };
      harness.ctx.injectText = async () => {};

      const testWav = generateSpeechToneWav(0.5);

      // Initial state is online at T = 2,000,000
      harness.setSimulatedNow(2000000);
      assert.strictEqual(harness.getOfflineMode(), false);
      assert.strictEqual(harness.getLastOfflineTime(), 0);

      // Simulate an active streaming session whose fullTranscriptPromise rejects
      vm.runInContext(`
        activeStreamSession = {
          fullTranscriptPromise: Promise.reject(new Error('Streaming network failure')),
        };
      `, harness.ctx);

      const pipelinePromise = harness.executePipeline();
      harness.ipc.emit('capture-data', {}, testWav, null);
      await pipelinePromise;

      // Streaming failure occurred
      assert.strictEqual(harness.getOfflineMode(), true, 'Must enter offline mode upon streaming failure');
      assert.strictEqual(
        harness.getLastOfflineTime(),
        2000000,
        'lastOfflineTime must be recorded as 2000000'
      );

      // Subsequent dictation at T = 2,015,000 (15s into cooldown)
      harness.setSimulatedNow(2015000);
      vm.runInContext(`
        activeStreamSession = {
          fullTranscriptPromise: Promise.resolve('Should not be called during cooldown'),
        };
      `, harness.ctx);

      const pipelinePromise2 = harness.executePipeline();
      harness.ipc.emit('capture-data', {}, testWav, null);
      await pipelinePromise2;

      // In cooldown, streaming session was ignored, offline mode maintained, lastOfflineTime pinned
      assert.strictEqual(harness.getOfflineMode(), true);
      assert.strictEqual(
        harness.getLastOfflineTime(),
        2000000,
        'lastOfflineTime must not slide forward during cooldown dictation'
      );
    } finally {
      harness.cleanup();
    }
  });
});
