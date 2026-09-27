// Adversarial Test Suite 02: Prompt Conditioning Across Multi-Chunk Transcripts
// Empirically verifies Whisper STT prompt conditioning across sequential chunks,
// 200-char truncation limits, failure fallback, and in-flight race conditions.
const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const https = require('https');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const GroqMockServer = require('../mocks/groq-mock-server');
const { generateSpeechToneWav } = require('../helpers/audio-generator');

// Set up mock electron environment
const { MockBrowserWindow, MockClipboard, MockIPC, mockApp } = require('../helpers/mock-electron');
const testIpc = new MockIPC();

// Write mock config with groqKey
const testUserData = path.join(os.tmpdir(), 'wispr-tell-test-userdata');
if (!fs.existsSync(testUserData)) fs.mkdirSync(testUserData, { recursive: true });
fs.writeFileSync(
  path.join(testUserData, 'wispr-tell-config.json'),
  JSON.stringify({ groqKey: 'gsk_adversarial_test_key_valid' })
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
    BrowserWindow: MockBrowserWindow,
    clipboard: new MockClipboard(),
    ipcMain: testIpc,
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    shell: { openExternal: () => {}, openPath: () => {} },
    globalShortcut: { register: () => true, unregisterAll: () => {} },
    session: { defaultSession: { webRequest: { onHeadersReceived: () => {} } } },
    MessageChannelMain: class { constructor() { this.port1 = {}; this.port2 = {}; } },
  },
};

const main = require('../../src/main');

describe('Adversarial 02: Streaming Prompt Conditioning', () => {
  let mockServer;
  let origHttpsRequest;

  before(async () => {
    mockServer = new GroqMockServer();
    await mockServer.start();

    // Route api.groq.com requests to local mock server
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
  });

  // Helper to extract multipart form field value
  function extractFormField(bodyString, fieldName) {
    const regex = new RegExp(`name="${fieldName}"\\r?\\n\\r?\\n([^\\r\\n]+)`);
    const match = bodyString.match(regex);
    return match ? match[1].trim() : null;
  }

  // TC-ADV-PROMPT-01: Chunk 0 default prompt conditioning
  it('TC-ADV-PROMPT-01: verifies chunk 0 uses default dictation prompt conditioning', async () => {
    mockServer.reset();
    mockServer.configure({ defaultTranscript: 'First chunk transcribed.' });

    main.onHotkeyDown(false); // Initializes streaming session
    const wav = generateSpeechToneWav(0.5);

    testIpc.emit('capture-chunk', {}, {
      chunkIndex: 0,
      isFinal: true,
      wavBuffer: wav,
      durationMs: 500,
    });

    // Await processing
    await new Promise(r => setTimeout(r, 120));

    const history = mockServer.getHistory();
    assert.strictEqual(history.length, 1, 'Should have received exactly 1 STT request');

    const prompt = extractFormField(history[0].bodyString, 'prompt');
    assert.strictEqual(
      prompt,
      'Clean, properly punctuated spoken English dictation.',
      'Chunk 0 must use default dictation prompt conditioning'
    );
  });

  // TC-ADV-PROMPT-02: Chunk 1 conditioned on Chunk 0 transcript
  it('TC-ADV-PROMPT-02: verifies chunk 1 conditions on preceding chunk transcript', async () => {
    mockServer.reset();
    mockServer.configure({ defaultTranscript: 'Architectural blueprint approved.' });

    main.onHotkeyDown(false);
    const wav = generateSpeechToneWav(0.5);

    // Send Chunk 0
    testIpc.emit('capture-chunk', {}, {
      chunkIndex: 0,
      isFinal: false,
      wavBuffer: wav,
      durationMs: 1800,
    });

    // Wait for Chunk 0 to resolve
    await new Promise(r => setTimeout(r, 120));

    // Send Chunk 1
    testIpc.emit('capture-chunk', {}, {
      chunkIndex: 1,
      isFinal: true,
      wavBuffer: wav,
      durationMs: 1800,
    });

    await new Promise(r => setTimeout(r, 120));

    const history = mockServer.getHistory();
    assert.strictEqual(history.length, 2, 'Should have received 2 STT requests');

    const promptChunk0 = extractFormField(history[0].bodyString, 'prompt');
    const promptChunk1 = extractFormField(history[1].bodyString, 'prompt');

    assert.strictEqual(promptChunk0, 'Clean, properly punctuated spoken English dictation.');
    assert.strictEqual(
      promptChunk1,
      'Architectural blueprint approved.',
      'Chunk 1 prompt must be conditioned on Chunk 0 transcript'
    );
  });

  // TC-ADV-PROMPT-03: Prompt truncation when prior context exceeds 200 chars
  it('TC-ADV-PROMPT-03: truncates prior context exceeding 200 characters to last 200 characters', async () => {
    mockServer.reset();
    // 250-character transcript for Chunk 0
    const longTranscript = 'A'.repeat(50) + 'B'.repeat(50) + 'C'.repeat(50) + 'D'.repeat(50) + 'E'.repeat(50);
    assert.strictEqual(longTranscript.length, 250);
    mockServer.configure({ defaultTranscript: longTranscript });

    main.onHotkeyDown(false);
    const wav = generateSpeechToneWav(0.5);

    testIpc.emit('capture-chunk', {}, {
      chunkIndex: 0,
      isFinal: false,
      wavBuffer: wav,
      durationMs: 1800,
    });
    await new Promise(r => setTimeout(r, 120));

    testIpc.emit('capture-chunk', {}, {
      chunkIndex: 1,
      isFinal: true,
      wavBuffer: wav,
      durationMs: 1800,
    });
    await new Promise(r => setTimeout(r, 120));

    const history = mockServer.getHistory();
    assert.strictEqual(history.length, 2);

    const promptChunk1 = extractFormField(history[1].bodyString, 'prompt');
    assert.strictEqual(promptChunk1.length, 200, 'Prompt must be sliced to exactly 200 characters');
    assert.strictEqual(promptChunk1, longTranscript.slice(-200), 'Prompt must preserve trailing 200 characters');
  });

  // TC-ADV-PROMPT-04: Graceful fallback when prior chunk fails
  it('TC-ADV-PROMPT-04: safely falls back to default prompt if preceding chunk failed with error', async () => {
    mockServer.reset();
    // Simulate STT error on first attempt, then succeed on subsequent attempts
    mockServer.configure({
      sttStatus: 500,
      failureCountBeforeSuccess: 1,
      currentFailures: 0,
      defaultTranscript: 'Recovered chunk text.',
    });

    main.onHotkeyDown(false);
    const wav = generateSpeechToneWav(0.5);

    // Send Chunk 0 (fails with 500)
    testIpc.emit('capture-chunk', {}, {
      chunkIndex: 0,
      isFinal: false,
      wavBuffer: wav,
      durationMs: 1800,
    });
    await new Promise(r => setTimeout(r, 120));

    // Send Chunk 1 (should fall back to default prompt)
    testIpc.emit('capture-chunk', {}, {
      chunkIndex: 1,
      isFinal: true,
      wavBuffer: wav,
      durationMs: 1800,
    });
    await new Promise(r => setTimeout(r, 120));

    const history = mockServer.getHistory();
    assert.strictEqual(history.length, 2);

    const promptChunk1 = extractFormField(history[1].bodyString, 'prompt');
    assert.strictEqual(
      promptChunk1,
      'Clean, properly punctuated spoken English dictation.',
      'Failed preceding chunk must cause Chunk 1 to fall back to default prompt safely'
    );
  });

  // TC-ADV-PROMPT-05: In-Flight Concurrency (Prompt Drift Under Heavy Latency)
  it('TC-ADV-PROMPT-05: handles in-flight chunk 0 race condition when chunk 1 arrives rapidly', async () => {
    mockServer.reset();
    // Add 100ms simulated network delay to STT server
    mockServer.configure({ delayMs: 80, defaultTranscript: 'Delayed transcript.' });

    main.onHotkeyDown(false);
    const wav = generateSpeechToneWav(0.5);

    // Emit Chunk 0 and immediately Chunk 1 without waiting for Chunk 0 to resolve
    testIpc.emit('capture-chunk', {}, {
      chunkIndex: 0,
      isFinal: false,
      wavBuffer: wav,
      durationMs: 1800,
    });

    testIpc.emit('capture-chunk', {}, {
      chunkIndex: 1,
      isFinal: true,
      wavBuffer: wav,
      durationMs: 1800,
    });

    // Wait for both in-flight requests to complete
    await new Promise(r => setTimeout(r, 300));

    const history = mockServer.getHistory();
    assert.strictEqual(history.length, 2);

    // Since Chunk 0 was in-flight when Chunk 1 arrived, Chunk 1 received default prompt
    // This documents the prompt conditioning tradeoff under rapid chunk arrival
    const promptChunk1 = extractFormField(history[1].bodyString, 'prompt');
    assert.strictEqual(promptChunk1, 'Clean, properly punctuated spoken English dictation.');
  });

  // TC-ADV-PROMPT-06: Cascading Multi-Chunk Prompt Progression
  it('TC-ADV-PROMPT-06: cascades prompt conditioning through 4 sequential chunks', async () => {
    mockServer.reset();
    let callIndex = 0;
    const chunkResponses = [
      'Alpha step confirmed.',
      'Beta step initiated.',
      'Gamma step verified.',
      'Delta step finished.',
    ];

    // Dynamically return sequential transcripts
    const origHandle = mockServer.handleRequest;
    mockServer.handleRequest = async function (req, res) {
      if (req.url.includes('/audio/transcriptions') && req.method === 'POST') {
        const text = chunkResponses[callIndex++] || 'Done.';
        mockServer.configure({ defaultTranscript: text });
      }
      return origHandle.call(mockServer, req, res);
    };

    main.onHotkeyDown(false);
    const wav = generateSpeechToneWav(0.5);

    for (let i = 0; i < 4; i++) {
      testIpc.emit('capture-chunk', {}, {
        chunkIndex: i,
        isFinal: i === 3,
        wavBuffer: wav,
        durationMs: 1800,
      });
      await new Promise(r => setTimeout(r, 120));
    }

    const history = mockServer.getHistory();
    assert.strictEqual(history.length, 4, 'Should execute 4 sequential chunk transcriptions');

    assert.strictEqual(extractFormField(history[0].bodyString, 'prompt'), 'Clean, properly punctuated spoken English dictation.');
    assert.strictEqual(extractFormField(history[1].bodyString, 'prompt'), chunkResponses[0]);
    assert.strictEqual(extractFormField(history[2].bodyString, 'prompt'), chunkResponses[1]);
    assert.strictEqual(extractFormField(history[3].bodyString, 'prompt'), chunkResponses[2]);

    // Restore handleRequest
    mockServer.handleRequest = origHandle;
  });
});
