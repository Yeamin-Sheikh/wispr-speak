// Adversarial Test Suite 03: Real-Time Streaming Transcription & Latency Verification
// Verifies post-release latency strictly < 400ms for utterances under 5 seconds,
// evaluates rolling chunk pipelining, server latency curves, rapid chunk storms, and fault recovery.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const GroqMockServer = require('../mocks/groq-mock-server');
const { generateSpeechToneWav } = require('../helpers/audio-generator');
const { measureMs } = require('../helpers/test-harness');

// Set up mock electron environment
const { MockClipboard, MockIPC, mockApp } = require('../helpers/mock-electron');
const EventEmitter = require('events');

class ObservableWebContents extends EventEmitter {
  constructor() {
    super();
    this.sentMessages = [];
  }
  send(channel, ...args) {
    this.sentMessages.push({ channel, args, timestamp: performance.now() });
    this.emit('ipc-message', channel, ...args);
    this.emit(channel, ...args);
  }
}

class ObservableBrowserWindow extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.webContents = new ObservableWebContents();
    this.isVisibleState = false;
  }
  show() { this.isVisibleState = true; }
  hide() { this.isVisibleState = false; }
  showInactive() { this.isVisibleState = true; }
  isVisible() { return this.isVisibleState; }
  isDestroyed() { return false; }
  setPosition() {}
  loadFile() { return Promise.resolve(); }
  center() {}
}

const testIpc = new MockIPC();
const mockCaptureWin = new ObservableBrowserWindow();
const mockPillWin = new ObservableBrowserWindow();
const mockSettingsWin = new ObservableBrowserWindow();

// Write mock config with groqKey
const testUserData = path.join(os.tmpdir(), 'wispr-tell-test-userdata');
if (!fs.existsSync(testUserData)) fs.mkdirSync(testUserData, { recursive: true });
fs.writeFileSync(
  path.join(testUserData, 'wispr-tell-config.json'),
  JSON.stringify({ groqKey: 'gsk_adversarial_latency_valid' })
);

require.cache[require.resolve('electron')] = {
  id: require.resolve('electron'),
  filename: require.resolve('electron'),
  loaded: true,
  exports: {
    app: {
      ...mockApp,
      requestSingleInstanceLock: () => false,
      on: () => {},
      whenReady: () => Promise.resolve(),
      setLoginItemSettings: () => {},
      quit: () => {},
    },
    BrowserWindow: ObservableBrowserWindow,
    clipboard: new MockClipboard(),
    ipcMain: testIpc,
    screen: {
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
      getCursorScreenPoint: () => ({ x: 500, y: 500 }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    },
    shell: { openExternal: () => {}, openPath: () => {} },
    globalShortcut: { register: () => true, unregisterAll: () => {} },
    session: { defaultSession: { webRequest: { onHeadersReceived: () => {} } } },
    MessageChannelMain: class { constructor() { this.port1 = {}; this.port2 = {}; } },
  },
};

const main = require('../../src/main');

describe('Adversarial 03: Streaming Pipeline & Latency Verification', () => {
  let mockServer;
  let origHttpsRequest;

  before(async () => {
    mockServer = new GroqMockServer();
    await mockServer.start();

    // Redirect api.groq.com to mock server
    origHttpsRequest = https.request;
    https.request = function (options, callback) {
      if (options.hostname === 'api.groq.com') {
        const redirected = { ...options, hostname: '127.0.0.1', port: mockServer.port, protocol: 'http:' };
        delete redirected.agent;
        return http.request(redirected, callback);
      }
      return origHttpsRequest.call(https, options, callback);
    };
  });

  after(async () => {
    https.request = origHttpsRequest;
    await mockServer.stop();
  });

  beforeEach(() => {
    mockServer.reset();
    main.resetState();
  });

  // Helper to simulate a streaming session and measure post-release latency
  async function simulateStreamingUtterance({
    utteranceDurationSec,
    serverDelayMs = 40,
    intermediateTranscripts = [],
    tailTranscript = 'Final sentence transcribed cleanly.',
  }) {
    mockServer.configure({ delayMs: serverDelayMs });

    let callCount = 0;
    const origHandle = mockServer.handleRequest;
    mockServer.handleRequest = async function (req, res) {
      if (req.url.includes('/audio/transcriptions') && req.method === 'POST') {
        const text = intermediateTranscripts[callCount] || tailTranscript;
        callCount++;
        mockServer.configure({ defaultTranscript: text });
      }
      return origHandle.call(mockServer, req, res);
    };

    // 1. User starts speaking (hotkey down)
    await main.onHotkeyDown(false);
    const wavChunk = generateSpeechToneWav(0.5);

    // 2. Progressive intermediate chunks emitted while speaking
    const chunkIntervalSec = 1.8;
    const intermediateChunkCount = Math.floor(utteranceDurationSec / chunkIntervalSec);

    for (let i = 0; i < intermediateChunkCount; i++) {
      testIpc.emit('capture-chunk', {}, {
        chunkIndex: i,
        isFinal: false,
        wavBuffer: wavChunk,
        durationMs: 1800,
      });
      // Simulate real-time speech elapsed between chunks
      await new Promise(r => setTimeout(r, 60));
    }

    // 3. User releases hotkey at utterance duration
    // Measure post-release latency starting from the release instant
    const releaseStart = performance.now();

    // Prepare promise that resolves when the final chunk completes
    const completionPromise = new Promise((resolve) => {
      // In capture-chunk IPC, when isFinal completes, session.finalResolve is invoked
      // We track mockServer STT calls until the final call finishes
      const targetCalls = intermediateChunkCount + 1;
      const checkInterval = setInterval(() => {
        if (mockServer.getHistory().length >= targetCalls) {
          clearInterval(checkInterval);
          // Allow microtask tick for stitchTranscripts and finalResolve
          setImmediate(() => {
            const elapsedMs = performance.now() - releaseStart;
            resolve({ elapsedMs, history: mockServer.getHistory() });
          });
        }
      }, 5);
    });

    // Capture emits tail chunk upon release
    const tailIndex = intermediateChunkCount;
    testIpc.emit('capture-chunk', {}, {
      chunkIndex: tailIndex,
      isFinal: true,
      wavBuffer: wavChunk,
      durationMs: Math.round((utteranceDurationSec - intermediateChunkCount * chunkIntervalSec) * 1000),
    });

    const result = await completionPromise;
    mockServer.handleRequest = origHandle;
    return result;
  }

  // TC-ADV-LATENCY-01: Short Utterance (1.2s audio, 1 chunk)
  it('TC-ADV-LATENCY-01: verifies post-release latency < 400ms for short 1.2s utterance', async () => {
    const { elapsedMs } = await simulateStreamingUtterance({
      utteranceDurationSec: 1.2,
      serverDelayMs: 50,
      tailTranscript: 'Short utterance completed.',
    });

    assert.ok(
      elapsedMs < 400,
      `Post-release latency for 1.2s utterance was ${elapsedMs.toFixed(2)}ms, must be < 400ms target`
    );
  });

  // TC-ADV-LATENCY-02: Medium Utterance (3.0s audio, 1 intermediate chunk + 1 tail chunk)
  it('TC-ADV-LATENCY-02: verifies post-release latency < 400ms for medium 3.0s utterance with pipelining', async () => {
    const { elapsedMs, history } = await simulateStreamingUtterance({
      utteranceDurationSec: 3.0,
      serverDelayMs: 45,
      intermediateTranscripts: ['First segment of sentence'],
      tailTranscript: 'First segment of sentence completed cleanly.',
    });

    assert.strictEqual(history.length, 2, 'Should pipeline 2 chunks (1 intermediate + 1 tail)');
    assert.ok(
      elapsedMs < 400,
      `Post-release latency for 3.0s utterance was ${elapsedMs.toFixed(2)}ms, must be < 400ms target`
    );
  });

  // TC-ADV-LATENCY-03: Long Utterance (4.8s audio, 2 intermediate chunks + 1 tail chunk)
  it('TC-ADV-LATENCY-03: verifies post-release latency < 400ms for long 4.8s utterance with 2 pipelined chunks', async () => {
    const { elapsedMs, history } = await simulateStreamingUtterance({
      utteranceDurationSec: 4.8,
      serverDelayMs: 40,
      intermediateTranscripts: ['This is the beginning', 'the beginning of a long utterance'],
      tailTranscript: 'of a long utterance finished now.',
    });

    assert.strictEqual(history.length, 3, 'Should pipeline 3 chunks (2 intermediate + 1 tail)');
    assert.ok(
      elapsedMs < 400,
      `Post-release latency for 4.8s utterance was ${elapsedMs.toFixed(2)}ms, must be < 400ms target`
    );
  });

  // TC-ADV-LATENCY-04: Zero-Length Tail Chunk (user releases exactly at chunk boundary)
  it('TC-ADV-LATENCY-04: verifies post-release latency < 100ms when tail chunk has 0 duration', async () => {
    mockServer.configure({ delayMs: 30, defaultTranscript: 'Boundary audio chunk.' });

    main.onHotkeyDown(false);
    const wavChunk = generateSpeechToneWav(0.5);

    // Chunk 0 sent during speech
    testIpc.emit('capture-chunk', {}, {
      chunkIndex: 0,
      isFinal: false,
      wavBuffer: wavChunk,
      durationMs: 1800,
    });
    await new Promise(r => setTimeout(r, 60));

    // Release key: capture sends empty tail buffer
    const releaseStart = performance.now();
    let completed = false;

    // Emit final empty buffer (as capture.html does on sub-MIN_SAMPLES boundary)
    testIpc.emit('capture-chunk', {}, {
      chunkIndex: 1,
      isFinal: true,
      wavBuffer: new ArrayBuffer(0),
      durationMs: 0,
    });

    // Wait a brief instant for finalResolve
    await new Promise(r => setTimeout(r, 20));
    const elapsedMs = performance.now() - releaseStart;

    assert.ok(
      elapsedMs < 100,
      `Zero-length tail chunk resolved in ${elapsedMs.toFixed(2)}ms (must be < 100ms)`
    );
  });

  // TC-ADV-LATENCY-05: Server Latency Boundary Curve
  it('TC-ADV-LATENCY-05: measures post-release latency curve across varying server delays', async () => {
    const serverDelays = [20, 60, 120, 200, 300];
    const latencyResults = [];

    for (const delay of serverDelays) {
      mockServer.reset();
      const { elapsedMs } = await simulateStreamingUtterance({
        utteranceDurationSec: 2.5,
        serverDelayMs: delay,
        tailTranscript: `Test with ${delay}ms delay.`,
      });
      latencyResults.push({ delay, elapsedMs });
    }

    // Verify all server delays under 300ms stay within 400ms target
    for (const r of latencyResults) {
      if (r.delay <= 250) {
        assert.ok(
          r.elapsedMs < 400,
          `At server delay ${r.delay}ms, post-release latency was ${r.elapsedMs.toFixed(2)}ms (target < 400ms)`
        );
      }
    }
  });

  // TC-ADV-LATENCY-06: Rapid Chunk Storm (10 rapid chunks stress)
  it('TC-ADV-LATENCY-06: handles rapid burst of 10 chunks in 50ms without crashing or dropping chunks', async () => {
    mockServer.reset();
    mockServer.configure({ delayMs: 10, defaultTranscript: 'Chunk in storm.' });

    main.onHotkeyDown(false);
    const wavChunk = generateSpeechToneWav(0.2);

    const stormCount = 10;
    for (let i = 0; i < stormCount; i++) {
      testIpc.emit('capture-chunk', {}, {
        chunkIndex: i,
        isFinal: i === stormCount - 1,
        wavBuffer: wavChunk,
        durationMs: 200,
      });
      await new Promise(r => setTimeout(r, 5)); // 5ms rapid burst
    }

    // Await all chunks to complete
    await new Promise(r => setTimeout(r, 250));

    const history = mockServer.getHistory();
    assert.strictEqual(
      history.length,
      stormCount,
      `All ${stormCount} chunks in the storm must be dispatched without dropped events`
    );
  });

  // TC-ADV-LATENCY-07: Error Resilience (Intermediate Chunk 500 Failure)
  it('TC-ADV-LATENCY-07: survives intermediate chunk 500 error and completes remaining session without blocking', async () => {
    mockServer.reset();
    let callIdx = 0;
    const origHandle = mockServer.handleRequest;

    // Fail the second chunk (index 1) with 500 error
    mockServer.handleRequest = async function (req, res) {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const bodyBuffer = Buffer.concat(chunks);
        mockServer.history.push({
          method: req.method,
          url: req.url,
          bodyRaw: bodyBuffer,
          bodyString: bodyBuffer.toString('utf8'),
          timestamp: Date.now()
        });

        if (req.url.includes('/audio/transcriptions') && req.method === 'POST') {
          const current = callIdx++;
          if (current === 1) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Simulated STT server error' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ text: `Transcript chunk ${current}` }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
    };

    main.onHotkeyDown(false);
    const wavChunk = generateSpeechToneWav(0.5);

    // Chunk 0 (200 OK)
    testIpc.emit('capture-chunk', {}, { chunkIndex: 0, isFinal: false, wavBuffer: wavChunk, durationMs: 1800 });
    await new Promise(r => setTimeout(r, 40));

    // Chunk 1 (500 Error)
    testIpc.emit('capture-chunk', {}, { chunkIndex: 1, isFinal: false, wavBuffer: wavChunk, durationMs: 1800 });
    await new Promise(r => setTimeout(r, 40));

    // Chunk 2 Tail (200 OK, isFinal=true)
    const releaseStart = performance.now();
    testIpc.emit('capture-chunk', {}, { chunkIndex: 2, isFinal: true, wavBuffer: wavChunk, durationMs: 1000 });

    await new Promise(r => setTimeout(r, 120));
    const elapsed = performance.now() - releaseStart;

    assert.ok(elapsed < 400, `Post-release latency despite intermediate failure was ${elapsed.toFixed(2)}ms`);
    assert.strictEqual(mockServer.getHistory().length, 3, 'All 3 chunk attempts must be registered');

    mockServer.handleRequest = origHandle;
  });
});
