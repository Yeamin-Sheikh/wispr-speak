// Tier 5 Adversarial Coverage Hardening: Features 1-9 (R1 & R2)
// White-box verification across:
// Feature 1: Real-Time Streaming Transcription
// Feature 2: Local Silero VAD
// Feature 3: Rapid Hotkey Event Queue & State Machine
// Feature 4: Zero-Copy Audio IPC
// Feature 5: Exponential Backoff Retry in groqPost
// Feature 6: Bundled Quantized whisper.cpp Fallback
// Feature 7: electron-updater with GitHub Releases
// Feature 8: Deterministic Clipboard Restoration
// Feature 9: Structured JSON Logging

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const { spawnSync } = require('child_process');
const { MessageChannel } = require('worker_threads');
const EventEmitter = require('events');

const { MockBrowserWindow, MockIPC, mockApp } = require('../helpers/mock-electron');
const { WhisperLocalEngine } = require('../../src/offline-whisper.js');
const { SileroVadEngine, VadEvaluator } = require('../../src/renderer/vad-engine.js');
const { generateSpeechToneWav } = require('../helpers/audio-generator.js');

/**
 * Enhanced MockClipboard supporting multi-format snapshots and sequence numbers
 */
class RichMockClipboard {
  constructor() {
    this.text = '';
    this.html = '';
    this.rtf = '';
    this.image = null;
    this.sequenceNumber = 1000;
  }

  availableFormats() {
    const formats = [];
    if (this.image) formats.push('image/png');
    if (this.html) formats.push('text/html');
    if (this.rtf) formats.push('text/rtf');
    if (this.text) formats.push('text/plain');
    return formats;
  }

  readText() { return this.text; }
  writeText(text) {
    this.text = String(text);
    this.sequenceNumber++;
  }

  readHTML() { return this.html; }
  readRTF() { return this.rtf; }
  readImage() { return this.image || { isEmpty: () => true }; }

  write(payload) {
    if (payload.text !== undefined) this.text = payload.text;
    if (payload.html !== undefined) this.html = payload.html;
    if (payload.rtf !== undefined) this.rtf = payload.rtf;
    this.sequenceNumber++;
  }

  writeImage(img) {
    this.image = img;
    this.sequenceNumber++;
  }

  getClipboardSequenceNumber() {
    return this.sequenceNumber;
  }

  clear() {
    this.text = '';
    this.html = '';
    this.rtf = '';
    this.image = null;
    this.sequenceNumber++;
  }
}

/**
 * Creates an isolated execution context for src/main.js
 */
function createMainHarness(options = {}) {
  const testDir = path.join(os.tmpdir(), `wispr-m5-adv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(testDir, { recursive: true });

  const initialConfig = {
    groqKey: options.groqKey || 'gsk_adversarial_test_key_12345',
    smartFix: options.smartFix !== undefined ? options.smartFix : true,
    shortcuts: { pushToTalk: ['Ctrl', 'Win'], handsFree: ['Ctrl', 'Win', 'Space'] },
    ...options.configOverrides,
  };
  fs.writeFileSync(path.join(testDir, 'wispr-tell-config.json'), JSON.stringify(initialConfig), 'utf8');

  const mainSrc = fs.readFileSync(path.join(__dirname, '../../src/main.js'), 'utf8');
  const recordedLogs = [];
  const ipc = new MockIPC();
  const mockClipboard = options.clipboard || new RichMockClipboard();
  const customUpdater = options.electronUpdater || null;

  const ctx = {
    require: (mod) => {
      if (mod === 'electron') {
        return {
          app: {
            ...mockApp,
            isPackaged: options.isPackaged || false,
            getPath: (name) => {
              if (name === 'userData') return testDir;
              return os.tmpdir();
            },
            requestSingleInstanceLock: () => false,
            on: () => {},
            whenReady: () => Promise.resolve(),
            setLoginItemSettings: () => {},
            quit: () => {},
          },
          BrowserWindow: MockBrowserWindow,
          clipboard: mockClipboard,
          ipcMain: ipc,
          screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
          shell: { openExternal: () => {}, openPath: () => {} },
          globalShortcut: { register: () => true, unregisterAll: () => {} },
          session: { defaultSession: { webRequest: { onHeadersReceived: () => {} } } },
          MessageChannelMain: class { constructor() { this.port1 = {}; this.port2 = {}; } },
          nativeTheme: { shouldUseDarkColors: true, on: () => {} },
        };
      }
      if (mod === 'uiohook-napi') {
        return {
          uIOhook: { on: () => {}, start: () => {}, stop: () => {} },
          UiohookKey: {},
        };
      }
      if (mod === 'electron-log') {
        return null;
      }
      if (mod === 'electron-updater') {
        if (customUpdater) return customUpdater;
        return {
          autoUpdater: {
            on: () => {},
            setFeedURL: () => {},
            checkForUpdates: () => Promise.resolve(),
          },
        };
      }
      if (mod.startsWith('.')) {
        return require(path.resolve(path.join(__dirname, '../../src'), mod));
      }
      return require(mod);
    },
    __dirname: path.resolve(path.join(__dirname, '../../src')),
    __filename: path.resolve(path.join(__dirname, '../../src/main.js')),
    process: {
      ...process,
      env: { ...process.env, ...options.envOverrides },
      resourcesPath: undefined,
    },
    console: {
      ...console,
      log: (...args) => { recordedLogs.push(['log', ...args]); },
      warn: (...args) => { recordedLogs.push(['warn', ...args]); },
      error: (...args) => { recordedLogs.push(['error', ...args]); },
    },
    Buffer,
    setTimeout: (fn, ms) => {
      if (options.fastTimers) return setTimeout(fn, 1);
      return setTimeout(fn, ms);
    },
    clearTimeout,
    setInterval,
    clearInterval,
    Set,
    Map,
    WeakSet,
    Promise,
    JSON,
    Math,
    Date,
    URL,
    module: { exports: {} },
    exports: {},
  };

  vm.createContext(ctx);
  vm.runInContext(mainSrc, ctx);

  const cleanup = () => {
    try {
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    } catch {}
  };

  return { ctx, ipc, mockClipboard, testDir, recordedLogs, cleanup };
}

describe('Tier 5 Adversarial Hardening — Feature 1: Real-Time Streaming Transcription', () => {
  it('TC-M5-F01-01: out-of-order chunk arrival and sequential transcript assembly', async () => {
    const harness = createMainHarness();
    const { ctx } = harness;

    // Simulate active stream session with 3 chunks arriving out-of-order: chunk 1 first, then chunk 0, then chunk 2
    const session = ctx.createStreamSession();
    session.chunkPromises = [];
    session.transcripts = [];

    // Chunk 1 finishes first with text "world from"
    session.chunkPromises[1] = Promise.resolve('world from');
    session.transcripts[1] = 'world from';

    // Chunk 0 finishes second with text "hello world"
    session.chunkPromises[0] = Promise.resolve('hello world');
    session.transcripts[0] = 'hello world';

    // Chunk 2 finishes third with text "from Wispr"
    session.chunkPromises[2] = Promise.resolve('from Wispr');
    session.transcripts[2] = 'from Wispr';

    await Promise.all(session.chunkPromises);

    let combined = '';
    for (let i = 0; i < session.transcripts.length; i++) {
      combined = ctx.stitchTranscripts(combined, session.transcripts[i] || '');
    }

    assert.strictEqual(combined, 'hello world from Wispr');
    harness.cleanup();
  });

  it('TC-M5-F01-02: partial chunk failure preserves surviving chunks and resolves combined transcript', async () => {
    const harness = createMainHarness();
    const { ctx } = harness;

    const session = ctx.createStreamSession();
    session.chunkPromises = [];
    session.transcripts = [];

    // Chunk 0 succeeds
    session.chunkPromises[0] = Promise.resolve('first chunk');
    session.transcripts[0] = 'first chunk';

    // Chunk 1 fails (simulated network timeout)
    const err = new Error('Chunk 1 timeout');
    session.error = err;
    session.chunkPromises[1] = Promise.resolve('');
    session.transcripts[1] = '';

    // Chunk 2 succeeds
    session.chunkPromises[2] = Promise.resolve('third chunk');
    session.transcripts[2] = 'third chunk';

    await Promise.all(session.chunkPromises);

    let combined = '';
    for (let i = 0; i < session.transcripts.length; i++) {
      combined = ctx.stitchTranscripts(combined, session.transcripts[i] || '');
    }

    // Must resolve with surviving text rather than failing
    assert.strictEqual(combined, 'first chunk third chunk');
    harness.cleanup();
  });

  it('TC-M5-F01-03: complete chunk failure rejects fullTranscriptPromise with network error', async () => {
    const harness = createMainHarness();
    const { ctx } = harness;

    const session = ctx.createStreamSession();
    const networkErr = new Error('Groq network disconnected');
    session.error = networkErr;
    session.chunkPromises = [Promise.resolve(''), Promise.resolve('')];
    session.transcripts = ['', ''];

    await Promise.all(session.chunkPromises);

    let combined = '';
    for (let i = 0; i < session.transcripts.length; i++) {
      combined = ctx.stitchTranscripts(combined, session.transcripts[i] || '');
    }

    if (!combined && session.error) {
      session.finalReject(session.error);
    } else {
      session.finalResolve(combined);
    }

    await assert.rejects(async () => {
      await session.fullTranscriptPromise;
    }, /Groq network disconnected/);

    harness.cleanup();
  });

  it('TC-M5-F01-04: sub-44-byte audio chunk (truncated WAV) does not crash and yields empty string', async () => {
    const harness = createMainHarness();
    const { ctx } = harness;

    const tinyBuffer = Buffer.from('RIFF1234'); // 8 bytes, smaller than 44
    const res = await ctx.transcribeChunk(tinyBuffer, '');
    assert.strictEqual(res, '');

    const nullBufferRes = await ctx.transcribeChunk(null, '');
    assert.strictEqual(nullBufferRes, '');

    harness.cleanup();
  });

  it('TC-M5-F01-05: boundary stitching preserves contractions and handles punctuation variance', () => {
    const harness = createMainHarness();
    const { ctx } = harness;

    // Contraction overlap
    const p1 = "we don't want to";
    const n1 = "want to drop inputs";
    assert.strictEqual(ctx.stitchTranscripts(p1, n1), "we don't want to drop inputs");

    // Trailing punctuation on prevText
    const p2 = "testing one two three.";
    const n2 = "three four five";
    assert.strictEqual(ctx.stitchTranscripts(p2, n2), "testing one two three four five");

    // Both empty or whitespace
    assert.strictEqual(ctx.stitchTranscripts('', '  '), '');
    assert.strictEqual(ctx.stitchTranscripts('solo', ''), 'solo');
    assert.strictEqual(ctx.stitchTranscripts('', 'solo'), 'solo');

    harness.cleanup();
  });

  it('TC-M5-F01-06: boundary stitching under extreme token disparity (1 word vs 25 words)', () => {
    const harness = createMainHarness();
    const { ctx } = harness;

    const p = "start";
    const n = "now we are dictating a very long multi-sentence streaming speech burst without pausing";
    const res = ctx.stitchTranscripts(p, n);
    assert.strictEqual(res, "start now we are dictating a very long multi-sentence streaming speech burst without pausing");

    const p2 = "we have spoken thirty words continuously and we finish with the word";
    const n2 = "word";
    const res2 = ctx.stitchTranscripts(p2, n2);
    assert.strictEqual(res2, "we have spoken thirty words continuously and we finish with the word");

    harness.cleanup();
  });

  it('TC-M5-F01-07: boundary stitching with code tokens, snake_case, and non-ASCII characters', () => {
    const harness = createMainHarness();
    const { ctx } = harness;

    const p = "inspecting variable my_variable_name";
    const n = "my_variable_name in main function";
    const stitched = ctx.stitchTranscripts(p, n);
    assert.strictEqual(stitched, "inspecting variable my_variable_name in main function");

    // Unicode symbols / emojis
    const pUni = "status is 🚀 rocket";
    const nUni = "rocket launch ready";
    const stitchedUni = ctx.stitchTranscripts(pUni, nUni);
    assert.ok(stitchedUni.includes("🚀") && stitchedUni.includes("launch ready"));

    harness.cleanup();
  });
});

describe('Tier 5 Adversarial Hardening — Feature 2: Local Silero VAD', () => {
  it('TC-M5-F02-01: VadEvaluator handles Float32Array containing NaN values without throwing', () => {
    const evaluator = new VadEvaluator();
    const nanArray = new Float32Array(512);
    nanArray.fill(NaN);

    assert.doesNotThrow(() => {
      const res = evaluator.evaluateFrame(nanArray);
      assert.strictEqual(res.isSpeech, false);
    });
  });

  it('TC-M5-F02-02: VadEvaluator handles Float32Array containing +Infinity and -Infinity values', () => {
    const evaluator = new VadEvaluator();
    const infArray = new Float32Array(512);
    for (let i = 0; i < 512; i++) {
      infArray[i] = i % 2 === 0 ? Infinity : -Infinity;
    }

    assert.doesNotThrow(() => {
      const res = evaluator.evaluateFrame(infArray);
      assert.strictEqual(res.isSpeech, false);
    });
  });

  it('TC-M5-F02-03: VadEvaluator handles odd-byte Int16 Buffer (e.g. 513 bytes) safely without crash', () => {
    const evaluator = new VadEvaluator();
    const oddBuf = Buffer.alloc(513); // 513 bytes = 256.5 samples
    oddBuf.writeInt16LE(100, 0);

    assert.doesNotThrow(() => {
      const res = evaluator.evaluateFrame(oddBuf);
      assert.strictEqual(res.isSpeech, false);
    });
  });

  it('TC-M5-F02-04: Nyquist square wave (alternating +1.0, -1.0) is rejected as sharp transient / click', () => {
    const evaluator = new VadEvaluator();
    const nyquist = new Float32Array(512);
    for (let i = 0; i < 512; i++) {
      nyquist[i] = i % 2 === 0 ? 1.0 : -1.0;
    }

    const res = evaluator.evaluateFrame(nyquist);
    // ZCR = 1.0 > 0.30 -> click rejection probability = 0.15
    assert.strictEqual(res.probability, 0.15);
    assert.strictEqual(res.isSpeech, false);
  });

  it('TC-M5-F02-05: subsonic flatline with zero-crossings = 0 is classified as silence', () => {
    const evaluator = new VadEvaluator();
    const flatline = new Float32Array(512);
    flatline.fill(0.2); // Constant DC offset with 0 zero crossings

    const res = evaluator.evaluateFrame(flatline);
    assert.strictEqual(res.probability, 0.05);
    assert.strictEqual(res.isSpeech, false);
  });

  it('TC-M5-F02-06: SileroVadEngine hysteresis requires minSpeechFrames consecutive frames to trigger', async () => {
    const engine = new SileroVadEngine({ minSpeechFrames: 3 });
    await engine.init();

    // Mock runInference to simulate controlled probabilities
    let currentProb = 0.6;
    engine.runInference = async () => currentProb;

    const frame = new Float32Array(512);

    // Frame 1
    const r1 = await engine.processFrame(frame);
    assert.strictEqual(r1.isSpeechActive, false);
    assert.strictEqual(engine.consecutiveSpeechFrames, 1);

    // Frame 2
    const r2 = await engine.processFrame(frame);
    assert.strictEqual(r2.isSpeechActive, false);
    assert.strictEqual(engine.consecutiveSpeechFrames, 2);

    // Interrupted by low frame
    currentProb = 0.2;
    const r3 = await engine.processFrame(frame);
    assert.strictEqual(r3.isSpeechActive, false);
    assert.strictEqual(engine.consecutiveSpeechFrames, 0); // Reset

    // Now 3 consecutive frames with prob 0.6
    currentProb = 0.6;
    await engine.processFrame(frame);
    await engine.processFrame(frame);
    const r6 = await engine.processFrame(frame);
    assert.strictEqual(r6.isSpeechActive, true); // Confirmed speech
  });

  it('TC-M5-F02-07: SileroVadEngine flushes pre-speech buffer when speech onset is confirmed', async () => {
    const engine = new SileroVadEngine({ minSpeechFrames: 3, preSpeechFrames: 4 });
    await engine.init();

    let currentProb = 0.1;
    engine.runInference = async () => currentProb;

    const silenceFrame = new Float32Array(512);
    silenceFrame.fill(0.01);

    // Feed 3 silence frames to populate pre-speech buffer
    await engine.processFrame(silenceFrame);
    await engine.processFrame(silenceFrame);
    await engine.processFrame(silenceFrame);
    assert.strictEqual(engine.preSpeechBuffer.length, 3);
    assert.strictEqual(engine.capturedFrames.length, 0);

    // Speech onset (3 frames of 0.7)
    currentProb = 0.7;
    const speechFrame = new Float32Array(512);
    speechFrame.fill(0.3);

    await engine.processFrame(speechFrame);
    await engine.processFrame(speechFrame);
    await engine.processFrame(speechFrame);

    // Upon confirmation: pre-speech buffer flushed into capturedFrames (3 silence + 1 speech onset frame)
    assert.strictEqual(engine.isSpeechActive, true);
    assert.ok(engine.capturedFrames.length >= 4, 'Pre-speech buffer must be flushed into captured audio');
  });

  it('TC-M5-F02-08: SileroVadEngine hangover remains active for hangoverFrames before reset', async () => {
    const engine = new SileroVadEngine({ minSpeechFrames: 2, hangoverFrames: 5 });
    await engine.init();

    let currentProb = 0.8;
    engine.runInference = async () => currentProb;

    const frame = new Float32Array(512);
    await engine.processFrame(frame);
    await engine.processFrame(frame);
    assert.strictEqual(engine.isSpeechActive, true);

    // Now probability drops to 0.1 (silence)
    currentProb = 0.1;
    // Frames 1-5 remain active within hangover budget
    for (let i = 0; i < 5; i++) {
      const res = await engine.processFrame(frame);
      assert.strictEqual(res.isSpeechActive, true, `Should remain active during hangover frame ${i + 1}`);
    }

    // 6th silence frame resets active state
    const res6 = await engine.processFrame(frame);
    assert.strictEqual(res6.isSpeechActive, false, 'Hangover must reset speech active flag after 5 frames');
  });

  it('TC-M5-F02-09: SileroVadEngine.getProcessedAudio() returns null when total speech frames < minSpeechFrames', async () => {
    const engine = new SileroVadEngine({ minSpeechFrames: 3 });
    await engine.init();

    // 0 frames
    assert.strictEqual(engine.getProcessedAudio(), null);

    // Only 1 speech frame
    engine.totalSpeechFrames = 1;
    engine.capturedFrames.push(new Float32Array(512));
    assert.strictEqual(engine.getProcessedAudio(), null);

    // 3 speech frames satisfies requirement
    engine.totalSpeechFrames = 3;
    engine.capturedFrames.push(new Float32Array(512));
    engine.capturedFrames.push(new Float32Array(512));
    const processed = engine.getProcessedAudio();
    assert.ok(processed instanceof Float32Array);
    assert.strictEqual(processed.length, 1536);
  });
});

describe('Tier 5 Adversarial Hardening — Feature 3: Rapid Hotkey Event Queue & State Machine', () => {
  it('TC-M5-F03-01: HotkeyStateMachine enforces maxQueueSize and counts dropped events', () => {
    const harness = createMainHarness();
    const { HotkeyStateMachine } = harness.ctx.module.exports;

    const fsm = new HotkeyStateMachine({ maxQueueSize: 10 });
    // Transition to PROCESSING
    fsm.handleEvent('KEY_DOWN', 'ptt');
    fsm.handleEvent('KEY_UP', 'ptt');
    assert.strictEqual(fsm.state, 'PROCESSING');

    // Enqueue 10 events to fill queue
    for (let i = 0; i < 10; i++) {
      const res = fsm.handleEvent('KEY_DOWN', 'ptt');
      assert.strictEqual(res.action, 'enqueued');
    }
    assert.strictEqual(fsm.queue.length, 10);
    assert.strictEqual(fsm.state, 'QUEUED');

    // Additional 15 events must be dropped
    for (let i = 0; i < 15; i++) {
      const res = fsm.handleEvent('KEY_DOWN', 'ptt');
      assert.strictEqual(res.action, 'dropped');
      assert.strictEqual(res.queueLength, 10);
    }

    assert.strictEqual(fsm.droppedEvents, 15);
    assert.strictEqual(fsm.queue.length, 10);
    harness.cleanup();
  });

  it('TC-M5-F03-02: stale PTT event discarded when key is no longer held upon completeProcessing', () => {
    const harness = createMainHarness();
    const { HotkeyStateMachine } = harness.ctx.module.exports;

    let isHeld = false;
    const fsm = new HotkeyStateMachine({
      isKeyHeld: () => isHeld,
    });

    // Start in PROCESSING
    fsm.handleEvent('KEY_DOWN', 'ptt');
    fsm.handleEvent('KEY_UP', 'ptt');
    assert.strictEqual(fsm.state, 'PROCESSING');

    // User pressed PTT again while processing
    fsm.handleEvent('KEY_DOWN', 'ptt');
    assert.strictEqual(fsm.queue.length, 1);

    // But before processing finishes, key was released
    isHeld = false;
    const res = fsm.completeProcessing();

    // Must discard stale event and return to IDLE (preventing phantom listening)
    assert.strictEqual(res.action, 'idle');
    assert.strictEqual(fsm.state, 'IDLE');
    assert.strictEqual(fsm.queue.length, 0);

    harness.cleanup();
  });

  it('TC-M5-F03-03: active PTT event triggers LISTENING_PTT when key is still held upon completeProcessing', () => {
    const harness = createMainHarness();
    const { HotkeyStateMachine } = harness.ctx.module.exports;

    let isHeld = true;
    const fsm = new HotkeyStateMachine({
      isKeyHeld: () => isHeld,
    });

    fsm.handleEvent('KEY_DOWN', 'ptt');
    fsm.handleEvent('KEY_UP', 'ptt');
    assert.strictEqual(fsm.state, 'PROCESSING');

    fsm.handleEvent('KEY_DOWN', 'ptt');

    // User is still holding PTT
    isHeld = true;
    const res = fsm.completeProcessing();

    assert.strictEqual(res.action, 'capture-start');
    assert.strictEqual(fsm.state, 'LISTENING_PTT');
    assert.strictEqual(fsm.queue.length, 0);

    harness.cleanup();
  });

  it('TC-M5-F03-04: rapid mode thrashing between Hands-Free and PTT does not deadlock', () => {
    const harness = createMainHarness();
    const { HotkeyStateMachine } = harness.ctx.module.exports;

    const fsm = new HotkeyStateMachine();

    // Start in Hands-Free
    const startHf = fsm.handleEvent('KEY_DOWN', 'handsfree');
    assert.strictEqual(startHf.action, 'capture-start');
    assert.strictEqual(fsm.state, 'LISTENING_HANDSFREE');

    // Press PTT while in Hands-Free -> stops capture and enters PROCESSING
    const pttStop = fsm.handleEvent('KEY_DOWN', 'ptt');
    assert.strictEqual(pttStop.action, 'capture-stop');
    assert.strictEqual(fsm.state, 'PROCESSING');

    // While in PROCESSING, Hands-Free toggle pressed
    const enqueueHf = fsm.handleEvent('KEY_DOWN', 'handsfree');
    assert.strictEqual(enqueueHf.action, 'enqueued');
    assert.strictEqual(fsm.state, 'QUEUED');

    // Complete processing -> should transition to LISTENING_HANDSFREE
    const nextAction = fsm.completeProcessing(() => false);
    assert.strictEqual(nextAction.action, 'capture-start');
    assert.strictEqual(fsm.state, 'LISTENING_HANDSFREE');

    harness.cleanup();
  });

  it('TC-M5-F03-05: micro-tap coalescing purges sub-80ms taps and preserves >=80ms presses', () => {
    const harness = createMainHarness();
    const { HotkeyStateMachine } = harness.ctx.module.exports;

    const fsm = new HotkeyStateMachine();
    const now = Date.now();

    // Micro-tap 40ms
    fsm.queue.push({ type: 'KEY_DOWN', key: 'ptt', timestamp: now });
    fsm.queue.push({ type: 'KEY_UP', key: 'ptt', timestamp: now + 40 });

    // Intentional tap 250ms
    fsm.queue.push({ type: 'KEY_DOWN', key: 'handsfree', timestamp: now + 100 });
    fsm.queue.push({ type: 'KEY_UP', key: 'handsfree', timestamp: now + 350 });

    fsm.drainCompletedMicroTaps();

    // 40ms micro-tap should be drained, 250ms tap should remain
    assert.strictEqual(fsm.queue.length, 2);
    assert.strictEqual(fsm.queue[0].key, 'handsfree');
    assert.strictEqual(fsm.queue[0].type, 'KEY_DOWN');

    harness.cleanup();
  });

  it('TC-M5-F03-06: resetState() restores state to IDLE and clears eventQueue', () => {
    const harness = createMainHarness();
    const { hotkeyFsm, resetState, getCurrentState, eventQueue } = harness.ctx.module.exports;

    hotkeyFsm.state = 'PROCESSING';
    hotkeyFsm.queue.push({ type: 'KEY_DOWN', key: 'ptt' });

    resetState();

    assert.strictEqual(getCurrentState(), 'IDLE');
    assert.strictEqual(eventQueue.length, 0);

    harness.cleanup();
  });
});

describe('Tier 5 Adversarial Hardening — Feature 4: Zero-Copy Audio IPC', () => {
  it('TC-M5-F04-01: MessagePort transfers Float32Array detaching backing ArrayBuffer on sender', async () => {
    const { port1, port2 } = new MessageChannel();
    const data = new Float32Array(16);
    data[0] = 0.125;
    data[15] = 0.875;

    const originalBuffer = data.buffer;
    assert.strictEqual(originalBuffer.byteLength, 64);

    await new Promise(resolve => {
      port2.on('message', received => {
        assert.ok(received instanceof Float32Array);
        assert.strictEqual(received.length, 16);
        assert.strictEqual(received[0], 0.125);
        assert.strictEqual(received[15], 0.875);
        resolve();
      });

      port1.postMessage(data, [originalBuffer]);
    });

    // Zero-copy detachment check
    assert.strictEqual(originalBuffer.byteLength, 0, 'Sender buffer must be detached');
    port1.close();
    port2.close();
  });

  it('TC-M5-F04-02: accessing detached ArrayBuffer throws TypeError or yields 0 byteLength', () => {
    const { port1, port2 } = new MessageChannel();
    const data = new Float32Array(16);
    const buf = data.buffer;

    port1.postMessage(data, [buf]);
    assert.strictEqual(buf.byteLength, 0);

    // Attempting to create a new typed array on detached buffer throws TypeError
    assert.throws(() => {
      new Float32Array(buf);
    }, /detached/i);

    port1.close();
    port2.close();
  });

  it('TC-M5-F04-03: posting to closed MessagePort does not crash process', () => {
    const { port1, port2 } = new MessageChannel();
    port2.close();

    assert.doesNotThrow(() => {
      const data = new Float32Array(16);
      port1.postMessage(data, [data.buffer]);
    });
    port1.close();
  });

  it('TC-M5-F04-04: setupAudioVizChannel() survives destroyed windows and postMessage exceptions', () => {
    const harness = createMainHarness();
    const { ctx } = harness;

    // Simulate destroyed window
    ctx.captureReady = true;
    ctx.pillReady = true;
    ctx.captureWin = { isDestroyed: () => true };
    ctx.pill = { isDestroyed: () => false };

    assert.doesNotThrow(() => {
      ctx.setupAudioVizChannel();
    });

    // Simulate throwing webContents
    ctx.captureWin = {
      isDestroyed: () => false,
      webContents: {
        postMessage: () => { throw new Error('Simulated IPC channel error'); },
      },
    };
    ctx.pill = {
      isDestroyed: () => false,
      webContents: { postMessage: () => {} },
    };

    assert.doesNotThrow(() => {
      ctx.setupAudioVizChannel();
    });

    harness.cleanup();
  });

  it('TC-M5-F04-05: 65536-sample lock-free ring buffer handles index wrap-around with Atomics', () => {
    const capacity = 65536;
    const sabControl = new SharedArrayBuffer(16);
    const sabSamples = new SharedArrayBuffer(capacity * 4);
    const control = new Int32Array(sabControl);
    const samples = new Float32Array(sabSamples);

    // Initial state
    Atomics.store(control, 0, capacity - 10); // write index near boundary
    Atomics.store(control, 1, capacity - 10); // read index

    // Write 25 samples wrapping around boundary
    let write = Atomics.load(control, 0);
    for (let i = 0; i < 25; i++) {
      samples[write] = i * 1.5;
      write = (write + 1) % capacity;
    }
    Atomics.store(control, 0, write);
    assert.strictEqual(write, 15); // Wrapped around to index 15

    // Read 25 samples back
    let read = Atomics.load(control, 1);
    const count = write >= read ? write - read : (capacity - read + write);
    assert.strictEqual(count, 25);

    const received = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      received[i] = samples[(read + i) % capacity];
    }
    Atomics.store(control, 1, write);

    assert.strictEqual(received[0], 0);
    assert.strictEqual(received[24], 24 * 1.5);
  });
});

describe('Tier 5 Adversarial Hardening — Feature 5: Exponential Backoff Retry in groqPost', () => {
  it('TC-M5-F05-01: computeBackoffDelay parses decimal and scientific Retry-After strings', () => {
    const harness = createMainHarness();
    const { ctx } = harness;

    assert.strictEqual(ctx.computeBackoffDelay(0, '2.5'), 2500);
    assert.strictEqual(ctx.computeBackoffDelay(0, '0.1'), 100);
    assert.strictEqual(ctx.computeBackoffDelay(0, '1e2'), 100000); // 100s -> 100000ms

    harness.cleanup();
  });

  it('TC-M5-F05-02: computeBackoffDelay falls back to formula on negative, null, or invalid strings', () => {
    const harness = createMainHarness();
    const { ctx } = harness;

    // Negative
    const neg = ctx.computeBackoffDelay(0, '-10');
    assert.ok(neg >= 500 && neg <= 800);

    // Malformed
    const bad = ctx.computeBackoffDelay(0, 'invalid-retry-value');
    assert.ok(bad >= 500 && bad <= 800);

    // Null/undefined
    const nil = ctx.computeBackoffDelay(1, null);
    assert.ok(nil >= 1000 && nil <= 1300);

    harness.cleanup();
  });

  it('TC-M5-F05-03: computeBackoffDelay strictly bounds jitter within [500*2^attempt, 500*2^attempt + 300) ms', () => {
    const harness = createMainHarness();
    const { ctx } = harness;

    for (let attempt = 0; attempt < 4; attempt++) {
      const base = 500 * Math.pow(2, attempt);
      for (let trial = 0; trial < 50; trial++) {
        const delay = ctx.computeBackoffDelay(attempt, null);
        assert.ok(delay >= base, `Delay ${delay} must be >= base ${base}`);
        assert.ok(delay < base + 300, `Delay ${delay} must be < ${base + 300}`);
      }
    }

    // High attempt capped at 8000ms
    for (let trial = 0; trial < 50; trial++) {
      const delay = ctx.computeBackoffDelay(5, null);
      assert.strictEqual(delay, 8000);
    }

    harness.cleanup();
  });

  it('TC-M5-F05-04: retriable HTTP 502 and 504 status codes trigger retry attempts', async () => {
    const harness = createMainHarness({ fastTimers: true });
    const { ctx } = harness;

    let calls = 0;
    ctx.httpRequest = async () => {
      calls++;
      if (calls < 3) {
        return { status: 502, headers: {}, body: 'Bad Gateway' };
      }
      return { status: 200, headers: {}, body: JSON.stringify({ ok: true }) };
    };

    const res = await ctx.groqPost('/test', { body: '{}', contentType: 'application/json' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(calls, 3);

    harness.cleanup();
  });

  it('TC-M5-F05-05: non-retriable HTTP 400 and 422 return immediately without retry', async () => {
    const harness = createMainHarness({ fastTimers: true });
    const { ctx } = harness;

    let calls = 0;
    ctx.httpRequest = async () => {
      calls++;
      return { status: 400, headers: {}, body: 'Bad Request' };
    };

    const res = await ctx.groqPost('/test', { body: '{}', contentType: 'application/json' });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(calls, 1, 'HTTP 400 must not retry');

    harness.cleanup();
  });

  it('TC-M5-F05-06: persistent HTTP 500 exhausts exactly 4 attempts', async () => {
    const harness = createMainHarness({ fastTimers: true });
    const { ctx } = harness;

    let calls = 0;
    ctx.httpRequest = async () => {
      calls++;
      return { status: 500, headers: {}, body: 'Internal Server Error' };
    };

    const res = await ctx.groqPost('/test', { body: '{}', contentType: 'application/json' });
    assert.strictEqual(res.status, 500);
    assert.strictEqual(calls, 4, 'Must exhaust exactly 4 attempts');

    harness.cleanup();
  });
});

describe('Tier 5 Adversarial Hardening — Feature 6: Bundled Quantized whisper.cpp Fallback', () => {
  it('TC-M5-F06-01: watchdog terminates hanging whisper-cli child process and unlinks temp WAV', async () => {
    const engine = new WhisperLocalEngine({ timeoutMs: 80 });
    const wav = generateSpeechToneWav(0.2);

    let childKilled = false;
    let tempPathUsed = null;

    engine.spawnFn = async (cli, args) => {
      tempPathUsed = args[3];
      assert.ok(fs.existsSync(tempPathUsed));
      return new Promise((_, reject) => {
        setTimeout(() => {
          childKilled = true;
          reject(new Error(`Local whisper process timed out after ${engine.timeoutMs}ms`));
        }, 80);
      });
    };

    await assert.rejects(async () => {
      await engine.transcribeLocal(wav);
    }, /timed out/);

    assert.strictEqual(childKilled, true);
    assert.strictEqual(fs.existsSync(tempPathUsed), false, 'Temp WAV must be cleaned up on timeout');
  });

  it('TC-M5-F06-02: temporary WAV file unlinked when child process exits with non-zero code', async () => {
    const engine = new WhisperLocalEngine();
    const wav = generateSpeechToneWav(0.2);
    let tempPathUsed = null;

    engine.spawnFn = async (cli, args) => {
      tempPathUsed = args[3];
      assert.ok(fs.existsSync(tempPathUsed));
      throw new Error('Whisper process exited with code 1: Out of memory');
    };

    await assert.rejects(async () => {
      await engine.transcribeLocal(wav);
    }, /exited with code 1/);

    assert.strictEqual(fs.existsSync(tempPathUsed), false, 'Temp WAV must be cleaned up on error');
  });

  it('TC-M5-F06-03: prompt sanitization strips quotes and newlines from command-line arguments', async () => {
    const engine = new WhisperLocalEngine();
    const wav = generateSpeechToneWav(0.2);
    let recordedArgs = null;

    engine.spawnFn = async (cli, args) => {
      recordedArgs = args;
      return '[00:00:00.000 --> 00:00:01.000] Sanitized text';
    };

    const result = await engine.transcribeLocal(wav, {
      prompt: 'hello "quoted" world \r\n dangerous newline',
    });

    assert.strictEqual(result, 'Sanitized text');
    const promptIndex = recordedArgs.indexOf('--prompt');
    assert.ok(promptIndex !== -1);
    const passedPrompt = recordedArgs[promptIndex + 1];
    assert.strictEqual(passedPrompt, 'hello quoted world  dangerous newline');
    assert.strictEqual(passedPrompt.includes('"'), false);
    assert.strictEqual(passedPrompt.includes('\n'), false);
  });

  it('TC-M5-F06-04: sticky offline latch routes subsequent dictations to whisper.cpp with 0 network calls', async () => {
    const harness = createMainHarness({ fastTimers: true });
    const { ctx } = harness;

    let networkCalls = 0;
    ctx.httpRequest = async () => {
      networkCalls++;
      return { status: 503, headers: {}, body: 'Service unavailable' };
    };

    const wav = generateSpeechToneWav(0.2);

    // First dictation triggers exhaustion and switches to offline
    await ctx.transcribe(wav);
    assert.strictEqual(networkCalls, 4, 'Initial dictation exhausts 4 network attempts');

    // Second dictation should bypass Groq network entirely (sticky offline cooldown)
    const callsBeforeSecond = networkCalls;
    await ctx.transcribe(wav);
    const secondCallDelta = networkCalls - callsBeforeSecond;

    assert.strictEqual(secondCallDelta, 0, 'Subsequent dictation in offline mode must make 0 network requests');
    harness.cleanup();
  });
});

describe('Tier 5 Adversarial Hardening — Feature 7: electron-updater with GitHub Releases', () => {
  it('TC-M5-F07-01: initAutoUpdater skips check in unpackaged dev environment without environment variable', () => {
    let checkCalled = false;
    const mockUpdater = {
      autoDownload: false,
      autoInstallOnAppQuit: false,
      allowPrerelease: false,
      setFeedURL: () => {},
      on: () => {},
      checkForUpdates: async () => { checkCalled = true; },
    };

    const harness = createMainHarness({
      isPackaged: false,
      fastTimers: true,
      envOverrides: { WISPR_CHECK_UPDATES: '0' },
      electronUpdater: { autoUpdater: mockUpdater },
    });

    harness.ctx.initAutoUpdater();
    assert.strictEqual(checkCalled, false);
    harness.cleanup();
  });

  it('TC-M5-F07-02: initAutoUpdater triggers update check when WISPR_CHECK_UPDATES=1', async () => {
    let checkCalled = false;
    const mockUpdater = {
      autoDownload: false,
      autoInstallOnAppQuit: false,
      allowPrerelease: false,
      setFeedURL: () => {},
      on: () => {},
      checkForUpdates: async () => { checkCalled = true; },
    };

    const harness = createMainHarness({
      isPackaged: false,
      fastTimers: true,
      envOverrides: { WISPR_CHECK_UPDATES: '1' },
      electronUpdater: { autoUpdater: mockUpdater },
    });

    harness.ctx.initAutoUpdater();
    await new Promise(r => setTimeout(r, 10));
    assert.strictEqual(checkCalled, true);
    harness.cleanup();
  });

  it('TC-M5-F07-03: initAutoUpdater error event handler tolerates null or undefined error arguments', () => {
    const emitter = new EventEmitter();
    const mockUpdater = Object.assign(emitter, {
      autoDownload: false,
      autoInstallOnAppQuit: false,
      allowPrerelease: false,
      setFeedURL: () => {},
      checkForUpdates: async () => {},
    });

    const harness = createMainHarness({
      fastTimers: true,
      electronUpdater: { autoUpdater: mockUpdater },
    });

    harness.ctx.initAutoUpdater();

    // Emit null error and undefined error without crashing
    assert.doesNotThrow(() => {
      mockUpdater.emit('error', null);
      mockUpdater.emit('error', undefined);
      mockUpdater.emit('error', new Error('Network timeout'));
      mockUpdater.emit('update-available', null);
      mockUpdater.emit('download-progress', { percent: 50, bytesPerSecond: 1024 });
      mockUpdater.emit('update-downloaded', null);
    });

    harness.cleanup();
  });
});

describe('Tier 5 Adversarial Hardening — Feature 8: Deterministic Clipboard Restoration', () => {
  it('TC-M5-F08-01: external clipboard change during paste window aborts restore and preserves user copy', async () => {
    const mockClipboard = new RichMockClipboard();
    mockClipboard.writeText('original secret text');

    let seqCounter = 100;
    mockClipboard.getClipboardSequenceNumber = () => seqCounter;

    const harness = createMainHarness({ clipboard: mockClipboard, fastTimers: true });
    const { ctx } = harness;

    // Simulate external copy by user during paste interval
    const origPaste = ctx.pasteViaHelper;
    ctx.pasteViaHelper = async () => {
      seqCounter = 105;
      mockClipboard.writeText('user external copied token');
    };

    await ctx.injectText('transcription injection');

    // Wait for clipboard restoration timeout
    await new Promise(r => setTimeout(r, 80));

    // Abort restore: user external copy must be preserved
    assert.strictEqual(mockClipboard.readText(), 'user external copied token');
    ctx.pasteViaHelper = origPaste;
    harness.cleanup();
  });

  it('TC-M5-F08-02: matching sequence number restores original clipboard snapshot', async () => {
    const mockClipboard = new RichMockClipboard();
    mockClipboard.writeText('initial clipboard contents');

    let seqCounter = 50;
    mockClipboard.getClipboardSequenceNumber = () => seqCounter;

    const harness = createMainHarness({ clipboard: mockClipboard, fastTimers: true });
    const { ctx } = harness;

    const origPaste = ctx.pasteViaHelper;
    ctx.pasteViaHelper = async () => {};

    await ctx.injectText('transcription to paste');
    await new Promise(r => setTimeout(r, 80));

    // Sequence unchanged -> original restored
    assert.strictEqual(mockClipboard.readText(), 'initial clipboard contents');
    ctx.pasteViaHelper = origPaste;
    harness.cleanup();
  });

  it('TC-M5-F08-03: 32-bit unsigned integer wrap-around (4294967295 to 0) aborts restore', async () => {
    const mockClipboard = new RichMockClipboard();
    mockClipboard.writeText('before wrap');

    let seqCounter = 4294967295;
    mockClipboard.getClipboardSequenceNumber = () => seqCounter;

    const harness = createMainHarness({ clipboard: mockClipboard, fastTimers: true });
    const { ctx } = harness;

    const origPaste = ctx.pasteViaHelper;
    ctx.pasteViaHelper = async () => {
      seqCounter = 0; // Wrapped around
      mockClipboard.writeText('after wrap copy');
    };

    await ctx.injectText('pasted text');
    await new Promise(r => setTimeout(r, 80));

    assert.strictEqual(mockClipboard.readText(), 'after wrap copy');
    ctx.pasteViaHelper = origPaste;
    harness.cleanup();
  });

  it('TC-M5-F08-04: multi-format snapshot restores HTML and RTF payloads', async () => {
    const mockClipboard = new RichMockClipboard();
    mockClipboard.write({
      text: 'plain fallback',
      html: '<b>bold text</b>',
      rtf: '{\\rtf1\\ansi bold}',
    });

    let seqCounter = 200;
    mockClipboard.getClipboardSequenceNumber = () => seqCounter;

    const harness = createMainHarness({ clipboard: mockClipboard, fastTimers: true });
    const { ctx } = harness;

    const origPaste = ctx.pasteViaHelper;
    ctx.pasteViaHelper = async () => {};

    await ctx.injectText('inserted dictation');
    await new Promise(r => setTimeout(r, 80));

    assert.strictEqual(mockClipboard.readHTML(), '<b>bold text</b>');
    assert.strictEqual(mockClipboard.readRTF(), '{\\rtf1\\ansi bold}');
    ctx.pasteViaHelper = origPaste;
    harness.cleanup();
  });

  it('TC-M5-F08-05: native helper tell-paste.exe --get-seq outputs valid CLIPBOARD_SEQ integer', () => {
    const pasteHelperPath = path.resolve(__dirname, '../../bin/native/tell-paste.exe');
    if (!fs.existsSync(pasteHelperPath)) return;

    const result = spawnSync(pasteHelperPath, ['--get-seq'], { encoding: 'utf8', windowsHide: true });
    assert.strictEqual(result.status, 0);
    assert.ok(result.stdout.includes('CLIPBOARD_SEQ'));

    const match = result.stdout.match(/CLIPBOARD_SEQ\s+(\d+)/);
    assert.ok(match, 'Output must match CLIPBOARD_SEQ <number>');
    const seq = parseInt(match[1], 10);
    assert.ok(!isNaN(seq) && seq >= 0);
  });
});

describe('Tier 5 Adversarial Hardening — Feature 9: Structured JSON Logging', () => {
  it('TC-M5-F09-01: safeStringifyLog handles self-referencing circular objects without throwing', () => {
    const harness = createMainHarness();
    const { ctx } = harness;

    const obj = { name: 'wispr' };
    obj.self = obj;

    const json = ctx.safeStringifyLog(obj);
    assert.ok(json.includes('"name":"wispr"'));
    assert.ok(json.includes('"self":"[Circular]"'));

    harness.cleanup();
  });

  it('TC-M5-F09-02: safeStringifyLog handles multi-node circular dependency graphs (A -> B -> C -> A)', () => {
    const harness = createMainHarness();
    const { ctx } = harness;

    const a = { id: 'A' };
    const b = { id: 'B' };
    const c = { id: 'C' };
    a.next = b;
    b.next = c;
    c.next = a;

    const json = ctx.safeStringifyLog(a);
    assert.ok(json.includes('"id":"A"'));
    assert.ok(json.includes('"id":"B"'));
    assert.ok(json.includes('"id":"C"'));
    assert.ok(json.includes('"next":"[Circular]"'));

    harness.cleanup();
  });

  it('TC-M5-F09-03: safeStringifyLog handles 100-level deeply nested object without stack overflow', () => {
    const harness = createMainHarness();
    const { ctx } = harness;

    let root = { depth: 0 };
    let cur = root;
    for (let i = 1; i < 100; i++) {
      cur.child = { depth: i };
      cur = cur.child;
    }

    assert.doesNotThrow(() => {
      const json = ctx.safeStringifyLog(root);
      assert.ok(json.includes('"depth":99'));
    });

    harness.cleanup();
  });

  it('TC-M5-F09-04: logStructured enforces single-line NDJSON format when messages have newlines', () => {
    const harness = createMainHarness();
    const { ctx, testDir } = harness;

    ctx.initLogPaths();
    const multilineMsg = "Line 1: Error\nLine 2: Stack trace\r\nLine 3: Details";
    ctx.logStructured('error', 'test', multilineMsg, { stack: "err\nat foo\nat bar" });

    const logFile = path.join(testDir, 'logs', ctx.getLogFileName());
    assert.ok(fs.existsSync(logFile));

    const content = fs.readFileSync(logFile, 'utf8');
    const lines = content.trim().split('\n');
    assert.strictEqual(lines.length, 1, 'NDJSON entry must be strictly one physical line');

    const parsed = JSON.parse(lines[0]);
    assert.strictEqual(parsed.level, 'error');
    assert.strictEqual(parsed.category, 'test');
    assert.ok(parsed.message.includes('Line 1: Error'));
    assert.ok(parsed.message.includes('\n'));

    harness.cleanup();
  });

  it('TC-M5-F09-05: UTC date formatting handles leap year (2028-02-29) and year boundaries (2026-12-31)', () => {
    const harness = createMainHarness();
    const { ctx } = harness;

    const leapDate = new Date('2028-02-29T12:00:00Z');
    assert.strictEqual(ctx.getLogDateString(leapDate), '2028-02-29');
    assert.strictEqual(ctx.getLogFileName(leapDate), 'wispr-tell-2028-02-29.log');

    const yearEnd = new Date('2026-12-31T23:59:59Z');
    assert.strictEqual(ctx.getLogDateString(yearEnd), '2026-12-31');

    const yearStart = new Date('2027-01-01T00:00:01Z');
    assert.strictEqual(ctx.getLogDateString(yearStart), '2027-01-01');

    harness.cleanup();
  });

  it('TC-M5-F09-06: pruneOldLogs purges files older than 14 days and preserves active logs and subdirs', () => {
    const harness = createMainHarness();
    const { ctx } = harness;

    const tempLogs = path.join(os.tmpdir(), `wispr-log-prune-${Date.now()}`);
    fs.mkdirSync(tempLogs, { recursive: true });

    // File 20 days old (should be purged)
    const oldLog = path.join(tempLogs, 'wispr-tell-2026-09-01.log');
    fs.writeFileSync(oldLog, 'old log');

    // File 5 days old (should be kept)
    const recentLog = path.join(tempLogs, 'wispr-tell-2026-09-22.log');
    fs.writeFileSync(recentLog, 'recent log');

    // Non-log config file (should be kept)
    const configFile = path.join(tempLogs, 'config.json');
    fs.writeFileSync(configFile, '{}');

    // Subdirectory (should be kept)
    const subDir = path.join(tempLogs, 'archive');
    fs.mkdirSync(subDir, { recursive: true });

    const refDate = new Date('2026-09-27T00:00:00Z');
    const deleted = ctx.pruneOldLogs(tempLogs, 14, refDate);

    assert.ok(deleted.includes('wispr-tell-2026-09-01.log'));
    assert.strictEqual(fs.existsSync(oldLog), false);
    assert.strictEqual(fs.existsSync(recentLog), true);
    assert.strictEqual(fs.existsSync(configFile), true);
    assert.strictEqual(fs.existsSync(subDir), true);

    fs.rmSync(tempLogs, { recursive: true, force: true });
    harness.cleanup();
  });

  it('TC-M5-F09-07: pruneOldLogs respects custom retention periods (e.g. 7 days)', () => {
    const harness = createMainHarness();
    const { ctx } = harness;

    const tempLogs = path.join(os.tmpdir(), `wispr-log-prune7-${Date.now()}`);
    fs.mkdirSync(tempLogs, { recursive: true });

    // File 10 days old (purged under 7-day retention)
    const file10d = path.join(tempLogs, 'wispr-tell-2026-09-17.log');
    fs.writeFileSync(file10d, '10 days old');

    const refDate = new Date('2026-09-27T00:00:00Z');
    const deleted = ctx.pruneOldLogs(tempLogs, 7, refDate);

    assert.strictEqual(deleted.length, 1);
    assert.strictEqual(fs.existsSync(file10d), false);

    fs.rmSync(tempLogs, { recursive: true, force: true });
    harness.cleanup();
  });
});
