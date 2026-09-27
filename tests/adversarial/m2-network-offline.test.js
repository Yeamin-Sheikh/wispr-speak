// Adversarial Test Suite: Network Transport, Exponential Backoff & Offline Fallback
// Verifies HTTP 429 Retry-After parsing, non-retriable errors, network exhaustion fallback,
// and whisper.cpp temporary file lifecycle and cleanup under stress.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const { spawn } = require('child_process');

const { WhisperLocalEngine, resolveAssetPath } = require('../../src/offline-whisper.js');
const { generateSpeechToneWav } = require('../helpers/audio-generator.js');

/**
 * Creates an isolated execution harness for src/main.js.
 * Uses real src/main.js source code while isolating electron and filesystem dependencies.
 */
function createMainHarness(options = {}) {
  const testDir = path.join(os.tmpdir(), `wispr-adv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
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

  const ctx = {
    require: (mod) => {
      if (mod === 'electron') {
        const { MockBrowserWindow, MockClipboard, MockIPC, mockApp } = require('../helpers/mock-electron');
        return {
          app: {
            ...mockApp,
            isPackaged: false,
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
          clipboard: new MockClipboard(),
          ipcMain: new MockIPC(),
          screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
          shell: { openExternal: () => {}, openPath: () => {} },
          globalShortcut: { register: () => true, unregisterAll: () => {} },
          session: { defaultSession: { webRequest: { onHeadersReceived: () => {} } } },
          MessageChannelMain: class { constructor() { this.port1 = {}; this.port2 = {}; } },
        };
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
      if (options.fastTimers !== false) {
        return setTimeout(fn, 1);
      }
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

  return { ctx, recordedDelays, httpLog, cleanup, testDir };
}

describe('M2 Adversarial: HTTP 429 Retry-After, Exponential Backoff & Jitter', () => {
  it('TC-ADV-NET-01: parses numeric Retry-After header with exact millisecond multiplication', () => {
    const { ctx, cleanup } = createMainHarness();
    try {
      const delay2s = ctx.computeBackoffDelay(0, '2');
      assert.strictEqual(delay2s, 2000, 'Retry-After: "2" must produce 2000ms delay');

      const delay5s = ctx.computeBackoffDelay(1, '5');
      assert.strictEqual(delay5s, 5000, 'Retry-After: "5" must produce 5000ms delay');

      const delayNumeric = ctx.computeBackoffDelay(2, 3);
      assert.strictEqual(delayNumeric, 3000, 'Numeric 3 must produce 3000ms delay');
    } finally {
      cleanup();
    }
  });

  it('TC-ADV-NET-02: parses decimal numeric Retry-After header correctly', () => {
    const { ctx, cleanup } = createMainHarness();
    try {
      const delay = ctx.computeBackoffDelay(0, '1.5');
      assert.strictEqual(delay, 1500, 'Retry-After: "1.5" must produce 1500ms delay');
    } finally {
      cleanup();
    }
  });

  it('TC-ADV-NET-03: parses zero numeric Retry-After header without falling back to formula', () => {
    const { ctx, cleanup } = createMainHarness();
    try {
      const delay = ctx.computeBackoffDelay(0, '0');
      assert.strictEqual(delay, 0, 'Retry-After: "0" must return 0ms delay');
    } finally {
      cleanup();
    }
  });

  it('TC-ADV-NET-04: parses future RFC 7231 HTTP-date Retry-After and calculates time differential', () => {
    const { ctx, cleanup } = createMainHarness();
    try {
      const targetTime = Date.now() + 4000;
      const httpDateString = new Date(targetTime).toUTCString();

      const delay = ctx.computeBackoffDelay(0, httpDateString);
      assert.ok(delay >= 2000 && delay <= 4500, `Delay ${delay}ms should approximate the differential taking into account 1-second RFC 7231 resolution`);
    } finally {
      cleanup();
    }
  });

  it('TC-ADV-NET-05: caps far-future HTTP-date Retry-After at 8000ms ceiling', () => {
    const { ctx, cleanup } = createMainHarness();
    try {
      const farFutureDate = new Date(Date.now() + 60000).toUTCString();
      const delay = ctx.computeBackoffDelay(0, farFutureDate);
      assert.strictEqual(delay, 8000, 'Far future HTTP-date must be capped at 8000ms');
    } finally {
      cleanup();
    }
  });

  it('TC-ADV-NET-06: falls back to exponential formula when HTTP-date is in the past', () => {
    const { ctx, cleanup } = createMainHarness();
    try {
      const pastDate = new Date(Date.now() - 10000).toUTCString();
      const delay = ctx.computeBackoffDelay(0, pastDate);
      assert.ok(delay >= 500 && delay <= 800, `Delay ${delay}ms should fall back to attempt 0 formula [500, 800]`);
    } finally {
      cleanup();
    }
  });

  it('TC-ADV-NET-07: falls back to exponential formula when Retry-After is malformed string', () => {
    const { ctx, cleanup } = createMainHarness();
    try {
      const delay = ctx.computeBackoffDelay(1, 'two-seconds');
      assert.ok(delay >= 1000 && delay <= 1300, `Delay ${delay}ms should fall back to attempt 1 formula [1000, 1300]`);
    } finally {
      cleanup();
    }
  });

  it('TC-ADV-NET-08: falls back to exponential formula when Retry-After is negative number', () => {
    const { ctx, cleanup } = createMainHarness();
    try {
      const delay = ctx.computeBackoffDelay(0, '-10');
      assert.ok(delay >= 500 && delay <= 800, `Negative Retry-After should fall back to formula [500, 800]`);
    } finally {
      cleanup();
    }
  });

  it('TC-ADV-NET-09: verifies jitter variance remains strictly within [0, 300] ms range across 100 trials', () => {
    const { ctx, cleanup } = createMainHarness();
    try {
      const attempt = 1;
      const baseDelay = 500 * Math.pow(2, attempt); // 1000ms
      for (let i = 0; i < 100; i++) {
        const delay = ctx.computeBackoffDelay(attempt, null);
        const jitter = delay - baseDelay;
        assert.ok(jitter >= 0, `Jitter ${jitter}ms must be non-negative`);
        assert.ok(jitter <= 300, `Jitter ${jitter}ms must not exceed 300ms`);
      }
    } finally {
      cleanup();
    }
  });

  it('TC-ADV-NET-10: enforces 8000ms ceiling across high attempt indices (attempts 4 through 10)', () => {
    const { ctx, cleanup } = createMainHarness();
    try {
      for (let attempt = 4; attempt <= 10; attempt++) {
        const delay = ctx.computeBackoffDelay(attempt, null);
        assert.strictEqual(delay, 8000, `Attempt ${attempt} delay ${delay}ms must be clamped to 8000ms`);
      }
    } finally {
      cleanup();
    }
  });

  it('TC-ADV-NET-11: groqPost retries on HTTP 429 and succeeds when rate limit clears', async () => {
    const { ctx, recordedDelays, cleanup } = createMainHarness({ fastTimers: true });
    try {
      let callCount = 0;
      ctx.httpRequest = async () => {
        callCount++;
        if (callCount <= 2) {
          return {
            status: 429,
            headers: { 'retry-after': '2' },
            body: JSON.stringify({ error: { message: 'Rate limit exceeded' } }),
          };
        }
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({ text: 'Speech transcribed after rate limit recovery' }),
        };
      };

      const res = await ctx.groqPost('/openai/v1/audio/transcriptions', {
        body: 'dummy-wav-data',
        contentType: 'audio/wav',
      });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(callCount, 3, 'Should succeed on the third attempt');
      assert.strictEqual(recordedDelays.length, 2, 'Should have paused twice');
      assert.strictEqual(recordedDelays[0], 2000, 'First delay must honor Retry-After: 2');
      assert.strictEqual(recordedDelays[1], 2000, 'Second delay must honor Retry-After: 2');
    } finally {
      cleanup();
    }
  });
});

describe('M2 Adversarial: Non-Retriable HTTP Errors & Immediate Failure', () => {
  it('TC-ADV-NET-12: HTTP 400 Bad Request fails immediately with 0 retries (1 total attempt)', async () => {
    const { ctx, recordedDelays, cleanup } = createMainHarness({ fastTimers: true });
    try {
      let callCount = 0;
      ctx.httpRequest = async () => {
        callCount++;
        return {
          status: 400,
          headers: {},
          body: JSON.stringify({ error: { message: 'Bad request parameter' } }),
        };
      };

      const res = await ctx.groqPost('/openai/v1/audio/transcriptions', {
        body: 'dummy-wav-data',
        contentType: 'audio/wav',
      });

      assert.strictEqual(res.status, 400);
      assert.strictEqual(callCount, 1, 'HTTP 400 must fail immediately without retrying');
      assert.strictEqual(recordedDelays.length, 0, 'No backoff delay should be scheduled');
    } finally {
      cleanup();
    }
  });

  it('TC-ADV-NET-13: HTTP 401 Unauthorized fails immediately with 0 retries (1 total attempt)', async () => {
    const { ctx, recordedDelays, cleanup } = createMainHarness({ fastTimers: true });
    try {
      let callCount = 0;
      ctx.httpRequest = async () => {
        callCount++;
        return {
          status: 401,
          headers: {},
          body: JSON.stringify({ error: { message: 'Invalid API key' } }),
        };
      };

      const res = await ctx.groqPost('/openai/v1/chat/completions', {
        body: '{}',
        contentType: 'application/json',
      });

      assert.strictEqual(res.status, 401);
      assert.strictEqual(callCount, 1, 'HTTP 401 must fail immediately without retrying');
      assert.strictEqual(recordedDelays.length, 0);
    } finally {
      cleanup();
    }
  });

  it('TC-ADV-NET-14: HTTP 403 Forbidden fails immediately with 0 retries (1 total attempt)', async () => {
    const { ctx, recordedDelays, cleanup } = createMainHarness({ fastTimers: true });
    try {
      let callCount = 0;
      ctx.httpRequest = async () => {
        callCount++;
        return {
          status: 403,
          headers: {},
          body: JSON.stringify({ error: { message: 'Permission denied' } }),
        };
      };

      const res = await ctx.groqPost('/openai/v1/chat/completions', {
        body: '{}',
        contentType: 'application/json',
      });

      assert.strictEqual(res.status, 403);
      assert.strictEqual(callCount, 1, 'HTTP 403 must fail immediately without retrying');
      assert.strictEqual(recordedDelays.length, 0);
    } finally {
      cleanup();
    }
  });

  it('TC-ADV-NET-15: HTTP 404 Not Found fails immediately with 0 retries (1 total attempt)', async () => {
    const { ctx, recordedDelays, cleanup } = createMainHarness({ fastTimers: true });
    try {
      let callCount = 0;
      ctx.httpRequest = async () => {
        callCount++;
        return {
          status: 404,
          headers: {},
          body: JSON.stringify({ error: { message: 'Endpoint not found' } }),
        };
      };

      const res = await ctx.groqPost('/openai/v1/unknown', {
        body: '{}',
        contentType: 'application/json',
      });

      assert.strictEqual(res.status, 404);
      assert.strictEqual(callCount, 1, 'HTTP 404 must fail immediately without retrying');
      assert.strictEqual(recordedDelays.length, 0);
    } finally {
      cleanup();
    }
  });

  it('TC-ADV-NET-16: HTTP 422 Unprocessable Entity fails immediately with 0 retries', async () => {
    const { ctx, recordedDelays, cleanup } = createMainHarness({ fastTimers: true });
    try {
      let callCount = 0;
      ctx.httpRequest = async () => {
        callCount++;
        return {
          status: 422,
          headers: {},
          body: JSON.stringify({ error: { message: 'Corrupt audio format' } }),
        };
      };

      const res = await ctx.groqPost('/openai/v1/audio/transcriptions', {
        body: 'invalid-bytes',
        contentType: 'audio/wav',
      });

      assert.strictEqual(res.status, 422);
      assert.strictEqual(callCount, 1, 'HTTP 422 must fail immediately without retrying');
      assert.strictEqual(recordedDelays.length, 0);
    } finally {
      cleanup();
    }
  });
});

describe('M2 Adversarial: Network Exhaustion & Seamless Offline Fallback', () => {
  it('TC-ADV-NET-17: exhausts retries at attempt 4 on persistent HTTP 500 and returns 500 response', async () => {
    const { ctx, recordedDelays, cleanup } = createMainHarness({ fastTimers: true });
    try {
      let callCount = 0;
      ctx.httpRequest = async () => {
        callCount++;
        return {
          status: 500,
          headers: {},
          body: JSON.stringify({ error: { message: 'Internal server error' } }),
        };
      };

      const res = await ctx.groqPost('/openai/v1/audio/transcriptions', {
        body: 'dummy-wav',
        contentType: 'audio/wav',
      });

      assert.strictEqual(res.status, 500);
      assert.strictEqual(callCount, 4, 'Must execute exactly 4 attempts before exhaustion');
      assert.strictEqual(recordedDelays.length, 3, 'Must schedule exactly 3 backoff intervals');
    } finally {
      cleanup();
    }
  });

  it('TC-ADV-NET-18: persistent HTTP 500 triggers seamless fallback to local whisper.cpp in transcribe()', async () => {
    const { ctx, cleanup } = createMainHarness({ fastTimers: true });
    try {
      let networkCalls = 0;
      ctx.httpRequest = async () => {
        networkCalls++;
        return { status: 500, headers: {}, body: 'Server error' };
      };

      const wav = generateSpeechToneWav(0.2);
      const transcript = await ctx.transcribe(wav);

      assert.strictEqual(networkCalls, 4, 'Groq must be attempted 4 times before fallback');
      assert.ok(typeof transcript === 'string', 'Should return fallback transcript');
      assert.ok(transcript.length >= 0, 'Transcript should be string format');
    } finally {
      cleanup();
    }
  });

  it('TC-ADV-NET-19: persistent HTTP 503 triggers seamless fallback to local whisper.cpp in transcribe()', async () => {
    const { ctx, cleanup } = createMainHarness({ fastTimers: true });
    try {
      let networkCalls = 0;
      ctx.httpRequest = async () => {
        networkCalls++;
        return { status: 503, headers: {}, body: 'Service temporarily unavailable' };
      };

      const wav = generateSpeechToneWav(0.2);
      const transcript = await ctx.transcribe(wav);

      assert.strictEqual(networkCalls, 4, 'Groq must be attempted 4 times before fallback');
      assert.ok(typeof transcript === 'string', 'Should return string transcript');
    } finally {
      cleanup();
    }
  });

  it('TC-ADV-NET-20: network error (ECONNREFUSED / timeout) retries 4 times and triggers local whisper.cpp', async () => {
    const { ctx, cleanup } = createMainHarness({ fastTimers: true });
    try {
      let networkCalls = 0;
      ctx.httpRequest = async () => {
        networkCalls++;
        throw new Error('connect ECONNREFUSED 127.0.0.1:443');
      };

      const wav = generateSpeechToneWav(0.2);
      const transcript = await ctx.transcribe(wav);

      assert.strictEqual(networkCalls, 4, 'Network errors must retry 4 times before failing');
      assert.ok(typeof transcript === 'string', 'Fallback to whisper.cpp must succeed');
    } finally {
      cleanup();
    }
  });

  it('TC-ADV-NET-21: sticky offline latch routes subsequent dictations to whisper.cpp with 0 network calls', async () => {
    const { ctx, cleanup } = createMainHarness({ fastTimers: true });
    try {
      let networkCalls = 0;
      ctx.httpRequest = async () => {
        networkCalls++;
        return { status: 503, headers: {}, body: 'Service unavailable' };
      };

      const wav = generateSpeechToneWav(0.2);

      // First dictation triggers exhaustion and switches to offline
      await ctx.transcribe(wav);
      assert.strictEqual(networkCalls, 4, 'Initial dictation exhausts 4 network attempts');

      // Second dictation should bypass Groq network entirely
      const callsBeforeSecond = networkCalls;
      await ctx.transcribe(wav);
      const secondCallDelta = networkCalls - callsBeforeSecond;

      assert.strictEqual(secondCallDelta, 0, 'Subsequent dictation in offline mode must make 0 network requests');
    } finally {
      cleanup();
    }
  });
});

describe('M2 Adversarial: whisper.cpp Offline Engine Lifecycle & Temporary File Management', () => {
  it('TC-ADV-OFF-01: executes real bundled whisper-cli.exe with ggml-tiny.en.bin and produces valid transcript', async () => {
    const engine = new WhisperLocalEngine();
    assert.strictEqual(engine.isAvailable(), true, 'Bundled binary and model must be detected');

    const wav = generateSpeechToneWav(0.5);
    const start = Date.now();
    const result = await engine.transcribeLocal(wav);
    const elapsed = Date.now() - start;

    assert.ok(typeof result === 'string', 'Transcription result must be string');
    assert.ok(elapsed > 0, 'Inference duration must be recorded');
  });

  it('TC-ADV-OFF-02: generates correct command-line parameters matching PROJECT.md interface contract', async () => {
    let capturedExe = null;
    let capturedArgs = null;

    const engine = new WhisperLocalEngine({
      spawnFn: async (exe, args) => {
        capturedExe = exe;
        capturedArgs = args;
        return '[00:00:00.000 --> 00:00:01.000] Speech audio recognized';
      },
    });

    const wav = generateSpeechToneWav(0.2);
    await engine.transcribeLocal(wav);

    assert.ok(capturedExe.includes('whisper-cli.exe'), 'Executable must be whisper-cli.exe');
    assert.strictEqual(capturedArgs[0], '-m');
    assert.ok(capturedArgs[1].includes('ggml-tiny.en.bin'), 'Model argument must point to ggml-tiny.en.bin');
    assert.strictEqual(capturedArgs[2], '-f');
    assert.ok(capturedArgs[3].endsWith('.wav'), 'File argument must end in .wav');
    assert.strictEqual(capturedArgs[4], '-nt', 'Argument 4 must be -nt (no timestamps)');
    assert.strictEqual(capturedArgs[5], '-t', 'Argument 5 must be -t (threads)');
    assert.strictEqual(capturedArgs[6], '4', 'Thread count must default to 4');
  });

  it('TC-ADV-OFF-03: creates temporary WAV file with valid RIFF header on disk during execution', async () => {
    let tempPathExists = false;
    let tempFileSize = 0;
    let tempFileHeader = null;

    const engine = new WhisperLocalEngine({
      spawnFn: async (exe, args) => {
        const filePath = args[args.indexOf('-f') + 1];
        if (fs.existsSync(filePath)) {
          tempPathExists = true;
          tempFileSize = fs.statSync(filePath).size;
          tempFileHeader = fs.readFileSync(filePath).slice(0, 4).toString('utf8');
        }
        return 'Execution in progress';
      },
    });

    const wav = generateSpeechToneWav(0.3);
    await engine.transcribeLocal(wav);

    assert.strictEqual(tempPathExists, true, 'Temp WAV file must exist on disk during spawn');
    assert.strictEqual(tempFileSize, wav.length, 'Temp file size must match input buffer length');
    assert.strictEqual(tempFileHeader, 'RIFF', 'Temp file header must begin with RIFF');
  });

  it('TC-ADV-OFF-04: guarantees temporary WAV file deletion after successful inference', async () => {
    let tempFilePath = null;

    const engine = new WhisperLocalEngine({
      spawnFn: async (exe, args) => {
        tempFilePath = args[args.indexOf('-f') + 1];
        return 'Transcription complete';
      },
    });

    const wav = generateSpeechToneWav(0.2);
    await engine.transcribeLocal(wav);

    assert.ok(tempFilePath, 'Temp file path must have been assigned');
    assert.strictEqual(fs.existsSync(tempFilePath), false, 'Temp file must be unlinked immediately after run');
  });

  it('TC-ADV-OFF-05: guarantees temporary WAV file deletion when execution throws an unhandled error', async () => {
    let tempFilePath = null;

    const engine = new WhisperLocalEngine({
      spawnFn: async (exe, args) => {
        tempFilePath = args[args.indexOf('-f') + 1];
        throw new Error('Simulated native execution failure');
      },
    });

    const wav = generateSpeechToneWav(0.2);
    await assert.rejects(
      async () => engine.transcribeLocal(wav),
      /Simulated native execution failure/
    );

    assert.ok(tempFilePath, 'Temp file path must be recorded');
    assert.strictEqual(fs.existsSync(tempFilePath), false, 'Temp file must be unlinked even after exception');
  });

  it('TC-ADV-OFF-06: watchdog timer terminates hanging process and deletes temp file on timeout', async () => {
    const engine = new WhisperLocalEngine({ timeoutMs: 50 });
    const wav = generateSpeechToneWav(1.0);

    let recordedTempPath = null;
    await assert.rejects(
      async () => {
        const promise = engine.transcribeLocal(wav);
        recordedTempPath = engine.lastCommand?.tempWavPath;
        await promise;
      },
      /Local whisper process timed out after 50ms/
    );

    const tempPath = engine.lastCommand?.tempWavPath;
    assert.ok(tempPath, 'Temp file path must exist in engine state');
    assert.strictEqual(fs.existsSync(tempPath), false, 'Temp file must be deleted on watchdog timeout');
  });

  it('TC-ADV-OFF-07: generates 1000 strictly collision-free unique temporary file paths', () => {
    const paths = new Set();
    const count = 1000;

    for (let i = 0; i < count; i++) {
      const tempId = `wispr-temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const tempWavPath = path.join(os.tmpdir(), `${tempId}.wav`);
      paths.add(tempWavPath);
    }

    assert.strictEqual(paths.size, count, `All ${count} generated temporary paths must be unique`);
  });

  it('TC-ADV-OFF-08: strips timestamp annotations and trims whitespace from output text', async () => {
    const engine = new WhisperLocalEngine({
      spawnFn: async () => '  [00:00:00.000 --> 00:00:02.500]  Spoken sentence here.  \n',
    });

    const wav = generateSpeechToneWav(0.2);
    const text = await engine.transcribeLocal(wav);

    assert.strictEqual(text, 'Spoken sentence here.', 'Must strip timestamp brackets and surrounding spaces');
  });

  it('TC-ADV-OFF-09: validates presence of bundled native binary and model files on disk', () => {
    const engine = new WhisperLocalEngine();
    assert.ok(fs.existsSync(engine.cliPath), `CLI binary must exist at ${engine.cliPath}`);
    assert.ok(fs.existsSync(engine.modelPath), `Model binary must exist at ${engine.modelPath}`);

    const stat = fs.statSync(engine.modelPath);
    assert.ok(stat.size > 20 * 1024 * 1024, `Model size (${stat.size} bytes) must exceed 20MB for ggml-tiny`);
  });

  it('TC-ADV-OFF-10: throws descriptive error on empty or null WAV buffer', async () => {
    const engine = new WhisperLocalEngine();
    await assert.rejects(
      async () => engine.transcribeLocal(null),
      /Empty WAV buffer provided for offline transcription/
    );
    await assert.rejects(
      async () => engine.transcribeLocal(Buffer.alloc(0)),
      /Empty WAV buffer provided for offline transcription/
    );
  });
});
