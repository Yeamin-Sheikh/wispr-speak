// M1 Unit Coverage Test Suite
// Verifies Silero VAD engine, boundary stitching algorithm, and hotkey queue state machine.
const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

// Mock electron in require.cache for headless Node.js test environment
const EventEmitter = require('events');
const { MockBrowserWindow, MockClipboard, MockIPC, mockApp, mockNativeTheme } = require('./helpers/mock-electron');

class FastMockWebContents extends EventEmitter {
  send(channel, ...args) {
    this.emit('ipc-message', channel, ...args);
    if (channel === 'capture-stop') {
      setImmediate(() => {
        electronMock.ipcMain.emit('capture-chunk', {}, {
          chunkIndex: 0,
          isFinal: true,
          wavBuffer: Buffer.alloc(0),
          durationMs: 0,
        });
        electronMock.ipcMain.emit('capture-data', {}, Buffer.alloc(0));
      });
    }
  }
}

class FastMockBrowserWindow extends MockBrowserWindow {
  constructor(options = {}) {
    super(options);
    this.webContents = new FastMockWebContents();
  }
}

const electronMock = {
  app: {
    ...mockApp,
    requestSingleInstanceLock: () => false,
    on: () => {},
    whenReady: () => Promise.resolve(),
    setLoginItemSettings: () => {},
    quit: () => {},
  },
  BrowserWindow: FastMockBrowserWindow,
  clipboard: new MockClipboard(),
  ipcMain: new MockIPC(),
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
  shell: { openExternal: () => {}, openPath: () => {} },
  globalShortcut: { register: () => true, unregisterAll: () => {} },
  session: { defaultSession: { webRequest: { onHeadersReceived: () => {} } } },
  MessageChannelMain: class { constructor() { this.port1 = {}; this.port2 = {}; } },
};
require.cache[require.resolve('electron')] = {
  id: require.resolve('electron'),
  filename: require.resolve('electron'),
  loaded: true,
  exports: electronMock,
};

const { SileroVadEngine, VadEvaluator } = require('../src/renderer/vad-engine');
const {
  FsmState,
  HotkeyStateMachine,
  normalizeToken,
  wordSimilarity,
  stitchTranscripts,
  enqueueHotkeyEvent,
  eventQueue,
  getCurrentState,
  resetState,
} = require('../src/main');
const { generateSilenceWav, generateSpeechToneWav, generateKeyboardClickWav, generatePinkNoiseWav } = require('./helpers/audio-generator');

describe('M1 Feature 01: Boundary Stitching & Token Alignment', () => {
  it('normalizes tokens removing punctuation and lowercasing', () => {
    assert.strictEqual(normalizeToken('Deployment!'), 'deployment');
    assert.strictEqual(normalizeToken('"Hello,"'), 'hello');
    assert.strictEqual(normalizeToken('123-ABC'), '123abc');
    assert.strictEqual(normalizeToken(''), '');
  });

  it('computes Levenshtein word similarity accurately', () => {
    assert.strictEqual(wordSimilarity('deployment', 'deployment'), 1.0);
    assert.ok(wordSimilarity('deploy', 'deploys') >= 0.8);
    assert.ok(wordSimilarity('testing', 'toast') < 0.5);
    assert.strictEqual(wordSimilarity('', 'word'), 0.0);
  });

  it('stitches overlapping phrases preferring forward acoustic context', () => {
    const chunk0 = 'I wanted to check if the deploy';
    const chunk1 = 'if the deployment is ready for staging';
    const stitched = stitchTranscripts(chunk0, chunk1);
    assert.strictEqual(stitched, 'I wanted to check if the deployment is ready for staging');
  });

  it('removes truncated trailing fragment from chunk0', () => {
    const chunk0 = 'we need to test the deplo';
    const chunk1 = 'test the deployment today';
    const stitched = stitchTranscripts(chunk0, chunk1);
    assert.strictEqual(stitched, 'we need to test the deployment today');
  });

  it('joins non-overlapping phrases with a single clean space', () => {
    const chunk0 = 'first sentence finished.';
    const chunk1 = 'second sentence started.';
    const stitched = stitchTranscripts(chunk0, chunk1);
    assert.strictEqual(stitched, 'first sentence finished. second sentence started.');
  });

  it('handles empty inputs gracefully', () => {
    assert.strictEqual(stitchTranscripts('', 'hello world'), 'hello world');
    assert.strictEqual(stitchTranscripts('hello world', ''), 'hello world');
    assert.strictEqual(stitchTranscripts('', ''), '');
  });
});

describe('M1 Feature 02: Silero VAD Engine & Acoustic Transient Rejection', () => {
  it('confirms assets exist in assets/vad/', () => {
    const vadDir = path.resolve(__dirname, '../assets/vad');
    assert.ok(fs.existsSync(path.join(vadDir, 'silero_vad.onnx')), 'silero_vad.onnx must exist');
    assert.ok(fs.existsSync(path.join(vadDir, 'ort.min.js')), 'ort.min.js must exist');
    assert.ok(fs.existsSync(path.join(vadDir, 'ort-wasm-simd.wasm')), 'ort-wasm-simd.wasm must exist');
    assert.ok(fs.existsSync(path.join(vadDir, 'ort-wasm.wasm')), 'ort-wasm.wasm must exist');
  });

  it('evaluates speech tone and confirms speech active', async () => {
    const engine = new SileroVadEngine();
    await engine.init();
    const speech = generateSpeechToneWav(0.2, 250).subarray(44);
    // Convert 16-bit PCM to Float32Array
    const floats = new Float32Array(speech.length / 2);
    for (let i = 0; i < floats.length; i++) {
      floats[i] = speech.readInt16LE(i * 2) / 32768.0;
    }

    let detected = false;
    for (let o = 0; o + 512 <= floats.length; o += 512) {
      const res = await engine.processFrame(floats.subarray(o, o + 512));
      if (res.isSpeechActive) detected = true;
    }
    assert.strictEqual(detected, true, 'Speech must be detected as active');
    const audio = engine.getProcessedAudio();
    assert.ok(audio && audio.length > 0, 'Processed audio should not be null');
  });

  it('evaluates digital silence and rejects audio as null', async () => {
    const engine = new SileroVadEngine();
    await engine.init();
    const silence = generateSilenceWav(0.2).subarray(44);
    const floats = new Float32Array(silence.length / 2);

    for (let o = 0; o + 512 <= floats.length; o += 512) {
      const res = await engine.processFrame(floats.subarray(o, o + 512));
      assert.strictEqual(res.isSpeechActive, false);
    }
    assert.strictEqual(engine.getProcessedAudio(), null, 'Pure silence must return null');
  });

  it('rejects keyboard clicks with high crest factor / ZCR', async () => {
    const engine = new SileroVadEngine();
    await engine.init();
    const click = generateKeyboardClickWav(16000).subarray(44);
    const floats = new Float32Array(click.length / 2);
    for (let i = 0; i < floats.length; i++) floats[i] = click.readInt16LE(i * 2) / 32768.0;

    for (let o = 0; o + 512 <= floats.length; o += 512) {
      const res = await engine.processFrame(floats.subarray(o, o + 512));
      assert.strictEqual(res.isSpeechActive, false);
    }
    assert.strictEqual(engine.getProcessedAudio(), null, 'Clicks must return null');
  });

  it('preserves hangover frames during short pauses', async () => {
    const evaluator = new VadEvaluator({ hangoverFrames: 4 });
    const speech = generateSpeechToneWav(0.05, 300).subarray(44);
    const silence = generateSilenceWav(0.03).subarray(44);

    const rSpeech = evaluator.evaluateFrame(speech);
    assert.strictEqual(rSpeech.isSpeech, true);

    // 1-3 silence frames: should stay active due to hangover
    assert.strictEqual(evaluator.evaluateFrame(silence).isSpeech, true);
    assert.strictEqual(evaluator.evaluateFrame(silence).isSpeech, true);
    assert.strictEqual(evaluator.evaluateFrame(silence).isSpeech, true);
    // 4th silence frame: hangover expired
    assert.strictEqual(evaluator.evaluateFrame(silence).isSpeech, false);
  });
});

describe('M1 Feature 03: Rapid Hotkey Event Queue & 5-State Machine', () => {
  it('starts in IDLE state', () => {
    const fsm = new HotkeyStateMachine();
    assert.strictEqual(fsm.state, 'IDLE');
    assert.strictEqual(fsm.queue.length, 0);
  });

  it('transitions IDLE -> LISTENING_PTT on KEY_DOWN(ptt) and to PROCESSING on KEY_UP(ptt)', () => {
    const fsm = new HotkeyStateMachine();
    const r1 = fsm.handleEvent('KEY_DOWN', 'ptt');
    assert.strictEqual(fsm.state, 'LISTENING_PTT');
    assert.strictEqual(r1.action, 'capture-start');

    const r2 = fsm.handleEvent('KEY_UP', 'ptt');
    assert.strictEqual(fsm.state, 'PROCESSING');
    assert.strictEqual(r2.action, 'capture-stop');

    const r3 = fsm.completeProcessing();
    assert.strictEqual(fsm.state, 'IDLE');
    assert.strictEqual(r3.action, 'idle');
  });

  it('transitions to QUEUED when events arrive during PROCESSING', () => {
    const fsm = new HotkeyStateMachine();
    fsm.handleEvent('KEY_DOWN', 'ptt');
    fsm.handleEvent('KEY_UP', 'ptt'); // PROCESSING
    assert.strictEqual(fsm.state, 'PROCESSING');

    const q = fsm.handleEvent('KEY_DOWN', 'ptt');
    assert.strictEqual(fsm.state, 'QUEUED');
    assert.strictEqual(q.depth, 1);
    assert.strictEqual(fsm.queue.length, 1);
  });

  it('handles burst of 15 rapid events without dropping', () => {
    const fsm = new HotkeyStateMachine();
    fsm.handleEvent('KEY_DOWN', 'ptt');
    fsm.handleEvent('KEY_UP', 'ptt'); // PROCESSING

    for (let i = 0; i < 15; i++) {
      fsm.handleEvent('KEY_DOWN', 'ptt');
    }
    assert.strictEqual(fsm.state, 'QUEUED');
    assert.strictEqual(fsm.queue.length, 15);
    assert.strictEqual(fsm.droppedEvents, 0);
  });

  it('coalesces sub-80ms micro-taps on processing completion', () => {
    const fsm = new HotkeyStateMachine();
    fsm.handleEvent('KEY_DOWN', 'ptt');
    fsm.handleEvent('KEY_UP', 'ptt'); // PROCESSING

    const t = Date.now();
    fsm.queue.push({ type: 'KEY_DOWN', key: 'ptt', timestamp: t });
    fsm.queue.push({ type: 'KEY_UP', key: 'ptt', timestamp: t + 30 }); // 30ms micro-tap

    const res = fsm.completeProcessing();
    assert.strictEqual(fsm.state, 'IDLE');
    assert.strictEqual(fsm.queue.length, 0, 'Micro-tap should be coalesced away');
    assert.strictEqual(res.action, 'idle');
  });
});

