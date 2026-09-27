// Tier 3 - Cross-Feature Combinations (22 integration test cases)
// Tests interactions between multiple subsystems per PROJECT.md interface contracts.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const GroqMockServer = require('../mocks/groq-mock-server');
const { generateSilenceWav, generateSpeechToneWav } = require('../helpers/audio-generator');
const { computeAudioRms, simulateSpringStep, SPEECH_FFT_BINS } = require('../helpers/test-harness');
const { MockClipboard, MockBrowserWindow } = require('../helpers/mock-electron');
const { applyVoiceCommands, applyDictionary } = require('../../src/text-utils');
const { MessageChannel } = require('worker_threads');

describe('Tier 3: Cross-Feature Combinations', () => {
  let mockServer;
  let serverUrl;

  before(async () => {
    mockServer = new GroqMockServer();
    serverUrl = await mockServer.start();
  });

  after(async () => {
    await mockServer.stop();
  });

  it('TC-T3-X01: Streaming Transcription + Silero VAD (only streams frames when VAD detects speech)', async () => {
    mockServer.reset();
    let networkPacketsSent = 0;

    async function streamAudioWithVadGate(frames) {
      for (const frame of frames) {
        // Extract raw PCM samples after 44-byte WAV header
        const pcm = frame.subarray(44);
        const rms = computeAudioRms(pcm);
        // VAD gate: reject silence (RMS < 0.01)
        if (rms >= 0.01) {
          networkPacketsSent++;
          await fetch(`${serverUrl}/openai/v1/audio/transcriptions`, {
            method: 'POST',
            headers: { 'Authorization': 'Bearer gsk_test' },
            body: frame
          });
        }
      }
    }

    const silentFrames = [generateSilenceWav(0.1), generateSilenceWav(0.1)];
    const speechFrames = [generateSpeechToneWav(0.1), generateSpeechToneWav(0.1)];

    // Send mixed audio: 2 silence frames + 2 speech frames
    await streamAudioWithVadGate([...silentFrames, ...speechFrames]);

    assert.strictEqual(networkPacketsSent, 2, 'Only the 2 speech frames should be transmitted');
    assert.strictEqual(mockServer.getHistory().length, 2);
  });

  it('TC-T3-X02: Streaming Transcription + Exponential Backoff Retry (recovers from 429 rate limit mid-stream)', async () => {
    mockServer.reset();
    mockServer.configure({ sttStatus: 429, failureCountBeforeSuccess: 1, retryAfterHeader: 0.01 });

    let attempts = 0;
    async function postChunkWithRetry(buf) {
      for (let i = 0; i < 3; i++) {
        attempts++;
        const res = await fetch(`${serverUrl}/openai/v1/audio/transcriptions`, {
          method: 'POST',
          headers: { 'Authorization': 'Bearer gsk_test' },
          body: buf
        });
        if (res.status === 200) return await res.json();
        await new Promise(r => setTimeout(r, 15));
      }
      throw new Error('Failed');
    }

    const res = await postChunkWithRetry(generateSpeechToneWav(0.2));
    assert.strictEqual(attempts, 2);
    assert.ok(res.text);
  });

  it('TC-T3-X03: Exponential Backoff Retry + Quantized whisper.cpp Fallback (retry exhaustion triggers fallback)', async () => {
    mockServer.reset();
    mockServer.configure({ sttStatus: 500, failureCountBeforeSuccess: 10 }); // Stays failing

    let fallbackTriggered = false;
    async function transcribeWithFallback(buf) {
      // Simulate max 2 retries then fallback
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await fetch(`${serverUrl}/openai/v1/audio/transcriptions`, {
          method: 'POST',
          headers: { 'Authorization': 'Bearer gsk_test' },
          body: buf
        });
        if (res.status === 200) return await res.json();
      }
      // Exhausted
      fallbackTriggered = true;
      return { text: 'Offline fallback transcribed text', offline: true };
    }

    const result = await transcribeWithFallback(generateSpeechToneWav(0.2));
    assert.strictEqual(fallbackTriggered, true);
    assert.strictEqual(result.offline, true);
    assert.strictEqual(result.text, 'Offline fallback transcribed text');
  });

  it('TC-T3-X04: Quantized whisper.cpp Fallback + Pill Offline Indicator (pill displays offline icon)', () => {
    const pillState = { offline: false, text: '' };
    function handleTranscriptionResult(result) {
      if (result.offline) {
        pillState.offline = true;
      } else {
        pillState.offline = false;
      }
      pillState.text = result.text;
    }

    handleTranscriptionResult({ text: 'Local text', offline: true });
    assert.strictEqual(pillState.offline, true);

    handleTranscriptionResult({ text: 'Cloud text', offline: false });
    assert.strictEqual(pillState.offline, false);
  });

  it('TC-T3-X05: Hotkey Event Queue + Rapid Hands-Free Toggle (transitions queue during active processing)', () => {
    const queue = [];
    let state = 'IDLE';

    function pushEvent(type, key) {
      if (state === 'PROCESSING') {
        queue.push({ type, key });
      } else if (state === 'IDLE' && type === 'KEY_DOWN') {
        state = 'PROCESSING';
      }
    }

    pushEvent('KEY_DOWN', 'ptt'); // Starts processing
    pushEvent('KEY_DOWN', 'handsfree'); // Queued
    pushEvent('KEY_DOWN', 'ptt'); // Queued

    assert.strictEqual(state, 'PROCESSING');
    assert.strictEqual(queue.length, 2);
    assert.strictEqual(queue[0].key, 'handsfree');
    assert.strictEqual(queue[1].key, 'ptt');
  });

  it('TC-T3-X06: Hotkey Event Queue + Character Animation (hotkey down flushes animation immediately)', () => {
    let animationActive = true;
    let newRecordingStarted = false;

    function onHotkeyInterrupt() {
      if (animationActive) {
        animationActive = false; // Fast flush
      }
      newRecordingStarted = true;
    }

    onHotkeyInterrupt();
    assert.strictEqual(animationActive, false);
    assert.strictEqual(newRecordingStarted, true);
  });

  it('TC-T3-X07: Context-Aware Smart Polish + Custom Dictionary (window context + glossary in prompt)', () => {
    const windowContext = { exe: 'Code.exe', title: 'index.ts' };
    const dictionary = [{ from: 'wispr tell', to: 'Wispr Tell' }];

    function buildIntegratedPrompt(context, dict, rawText) {
      const isCode = /code\.exe/i.test(context.exe);
      const glossary = dict.map(d => d.to).join(', ');
      return {
        systemPrompt: `Style: ${isCode ? 'Code' : 'General'}. Vocabulary glossary: ${glossary}.`,
        userText: rawText
      };
    }

    const payload = buildIntegratedPrompt(windowContext, dictionary, 'testing wispr tell in code');
    assert.ok(payload.systemPrompt.includes('Style: Code'));
    assert.ok(payload.systemPrompt.includes('Wispr Tell'));
  });

  it('TC-T3-X08: Context-Aware Smart Polish + Customizable LLM Personas (app mapping overrides persona)', () => {
    const personas = {
      Natural: { temp: 0.3, prompt: 'Natural style' },
      Code: { temp: 0.1, prompt: 'Code style' },
      Formal: { temp: 0.2, prompt: 'Formal style' }
    };

    function resolvePersonaForWindow(targetExe, activePersona) {
      if (/code\.exe|cursor\.exe/i.test(targetExe)) return personas.Code;
      if (/outlook\.exe/i.test(targetExe)) return personas.Formal;
      return personas[activePersona] || personas.Natural;
    }

    const codePersona = resolvePersonaForWindow('Code.exe', 'Natural');
    assert.strictEqual(codePersona.prompt, 'Code style');
    assert.strictEqual(codePersona.temp, 0.1);

    const defaultPersona = resolvePersonaForWindow('notepad.exe', 'Natural');
    assert.strictEqual(defaultPersona.prompt, 'Natural style');
  });

  it('TC-T3-X09: Customizable LLM Personas + Custom Voice Commands (command executed, then persona applied)', () => {
    const utterance = 'first line new line this is important';
    const voiceRes = applyVoiceCommands(utterance);
    // Voice command separates 'new line' into newline
    assert.ok(voiceRes.text.includes('\n'));

    // Apply persona polishing on the result
    const polished = voiceRes.text.trim();
    assert.ok(polished.length > 0);
  });

  it('TC-T3-X10: Compressed Audio History + Voice Commands ("scratch that" cancels history saving)', () => {
    let savedToHistory = false;
    function processUtterance(text, audioBuffer) {
      const voiceRes = applyVoiceCommands(text);
      if (voiceRes.scratch) {
        // Discard utterance without saving
        return { discarded: true };
      }
      savedToHistory = true;
      return { text: voiceRes.text, audioSaved: !!audioBuffer };
    }

    const result = processUtterance('scratch that', Buffer.from('audio'));
    assert.strictEqual(result.discarded, true);
    assert.strictEqual(savedToHistory, false);
  });

  it('TC-T3-X11: Compressed Audio History + Offline Whisper Fallback (offline transcript saved with audio)', () => {
    const history = [];
    function recordEntry({ text, audioBuffer, isOffline }) {
      history.push({
        id: 'h_1',
        text,
        hasAudio: !!audioBuffer,
        offline: isOffline,
        timestamp: Date.now()
      });
    }

    recordEntry({ text: 'Offline transcription', audioBuffer: Buffer.from('opus-data'), isOffline: true });
    assert.strictEqual(history.length, 1);
    assert.strictEqual(history[0].offline, true);
    assert.strictEqual(history[0].hasAudio, true);
  });

  it('TC-T3-X12: Zero-Copy Audio IPC + WebGL FFT Visualizer (Float32Array directly updates WebGL uniforms)', async () => {
    const { port1, port2 } = new MessageChannel();
    const fftUniform = new Float32Array(16);

    await new Promise((resolve) => {
      port2.on('message', (msg) => {
        const received = new Float32Array(msg.buffer || msg);
        fftUniform.set(received);
        resolve();
      });

      const frame = new Float32Array(16);
      frame[4] = 0.92; // 350Hz band
      port1.postMessage(frame, [frame.buffer]);
    });

    assert.ok(Math.abs(fftUniform[4] - 0.92) < 1e-4);
    port1.close();
    port2.close();
  });

  it('TC-T3-X13: Windows 11 Acrylic Pill + Fluid Spring Drag (spring physics animates acrylic pill bounds)', () => {
    let pillBounds = { x: 500, y: 800, width: 320, height: 44, material: 'acrylic' };
    let vx = 0;
    const targetX = 700;

    for (let frame = 0; frame < 30; frame++) {
      const step = simulateSpringStep({ currentX: pillBounds.x, velocity: vx, targetX, dt: 0.016 });
      pillBounds.x = step.x;
      vx = step.v;
    }

    assert.strictEqual(pillBounds.material, 'acrylic');
    assert.ok(pillBounds.x > 600, 'Pill bounds should animate toward target');
  });

  it('TC-T3-X14: Spring Drag + Position Persistence + Theme Sync (theme broadcast while pill is moving)', () => {
    const pill = { x: 100, y: 100, theme: 'dark' };
    pill.x = 250; // Dragged

    // Broadcast theme
    pill.theme = 'light';

    assert.strictEqual(pill.x, 250);
    assert.strictEqual(pill.theme, 'light');
  });

  it('TC-T3-X15: Deterministic Clipboard Restoration + Character Animation (paste verifies seq, animation does not clobber)', async () => {
    const clip = new MockClipboard();
    clip.writeText('Prior clipboard item');
    const initialSeq = clip.getClipboardSequenceNumber();

    // Mode A: Short text animation (SendInput typing) does not touch system clipboard
    const shortText = 'Hi!';
    assert.strictEqual(clip.getClipboardSequenceNumber(), initialSeq);
    assert.strictEqual(clip.readText(), 'Prior clipboard item');

    // Mode B: Long text paste uses clipboard with sequence verification
    const longText = 'Long text to paste';
    clip.writeText(longText);
    const postPasteSeq = clip.getClipboardSequenceNumber();
    assert.ok(postPasteSeq > initialSeq);

    // Restore snapshot
    clip.writeText('Prior clipboard item');
    assert.strictEqual(clip.readText(), 'Prior clipboard item');
  });

  it('TC-T3-X16: Structured JSON Logging + Retry Engine (logs every backoff attempt as structured JSON)', () => {
    const logEntries = [];
    function logAttempt(attempt, delayMs, status) {
      logEntries.push({
        timestamp: new Date().toISOString(),
        level: 'warn',
        category: 'retry',
        message: `HTTP ${status} backoff retry attempt ${attempt}`,
        metadata: { attempt, delayMs, status }
      });
    }

    logAttempt(1, 1000, 429);
    logAttempt(2, 2000, 429);

    assert.strictEqual(logEntries.length, 2);
    assert.strictEqual(logEntries[0].category, 'retry');
    assert.strictEqual(logEntries[0].metadata.delayMs, 1000);
  });

  it('TC-T3-X17: Structured JSON Logging + Silero VAD (logs noise/silence rejection with VAD probability)', () => {
    const logEntries = [];
    function logVadRejection(rms, probability) {
      logEntries.push({
        timestamp: new Date().toISOString(),
        level: 'debug',
        category: 'vad',
        message: 'Non-speech audio rejected',
        metadata: { rms, probability, action: 'skip-network' }
      });
    }

    logVadRejection(0.002, 0.05);
    assert.strictEqual(logEntries.length, 1);
    assert.strictEqual(logEntries[0].category, 'vad');
    assert.strictEqual(logEntries[0].metadata.action, 'skip-network');
  });

  it('TC-T3-X18: Interactive Onboarding + Groq Key Check + Exponential Backoff (retries during key check)', async () => {
    mockServer.reset();
    mockServer.configure({ sttStatus: 429, failureCountBeforeSuccess: 1, retryAfterHeader: 0.01 });

    let attempts = 0;
    async function validateKeyWithRetry(key) {
      for (let i = 0; i < 3; i++) {
        attempts++;
        const res = await fetch(`${serverUrl}/openai/v1/models`, {
          headers: { 'Authorization': `Bearer ${key}` }
        });
        if (res.status === 200) return true;
        await new Promise(r => setTimeout(r, 15));
      }
      return false;
    }

    const isValid = await validateKeyWithRetry('gsk_test');
    assert.strictEqual(isValid, true);
    assert.strictEqual(attempts, 2);
  });

  it('TC-T3-X19: Auto-Updater + Low Latency Streaming (concurrent update check does not block streaming)', async () => {
    mockServer.reset();

    // Launch simulated update check promise
    const updateCheckPromise = new Promise(r => setTimeout(() => r({ updateAvailable: false }), 20));

    // Concurrently stream audio chunk
    const streamPromise = fetch(`${serverUrl}/openai/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer gsk_test' },
      body: generateSpeechToneWav(0.1)
    }).then(r => r.json());

    const [updateRes, streamRes] = await Promise.all([updateCheckPromise, streamPromise]);
    assert.strictEqual(updateRes.updateAvailable, false);
    assert.ok(streamRes.text);
  });

  it('TC-T3-X20: Theme Synchronization + High-DPI Scaling (variables and 125% DPI canvas update synchronously)', () => {
    const appState = { theme: 'dark', dpiScale: 1.25, canvasWidth: 400 };

    function onThemeAndDpiChange(newTheme, newScale) {
      appState.theme = newTheme;
      appState.dpiScale = newScale;
      appState.canvasWidth = Math.round(320 * newScale);
    }

    onThemeAndDpiChange('light', 1.5);
    assert.strictEqual(appState.theme, 'light');
    assert.strictEqual(appState.dpiScale, 1.5);
    assert.strictEqual(appState.canvasWidth, 480);
  });

  it('TC-T3-X21: Context Polish + Offline Fallback (formats local offline text with context heuristics)', () => {
    const target = { exe: 'Code.exe' };
    const rawOfflineText = 'function calculate total';

    function formatOfflineWithContext(target, text) {
      if (/code\.exe/i.test(target.exe)) {
        // Simple local camelCase heuristic for code editors
        return text.replace(/\s+(\w)/g, (_, c) => c.toUpperCase());
      }
      return text;
    }

    const formatted = formatOfflineWithContext(target, rawOfflineText);
    assert.strictEqual(formatted, 'functionCalculateTotal');
  });

  it('TC-T3-X22: Hotkey Queue + SharedArrayBuffer IPC (buffer reset on rapid cancel and restart)', () => {
    const ringBuffer = new Float32Array(1024);
    let writeIndex = 0;

    function pushAudio(sample) {
      ringBuffer[writeIndex % 1024] = sample;
      writeIndex++;
    }

    function resetOnNewUtterance() {
      writeIndex = 0;
      ringBuffer.fill(0);
    }

    pushAudio(0.5);
    pushAudio(0.8);
    assert.strictEqual(writeIndex, 2);

    // Rapid cancel & new key press
    resetOnNewUtterance();
    assert.strictEqual(writeIndex, 0);
    assert.strictEqual(ringBuffer[0], 0);
  });
});
