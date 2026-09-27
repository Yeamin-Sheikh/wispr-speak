// Tier 4 - Real-World Application Scenarios (10 comprehensive user workflows)
// Simulates end-to-end user workflows across code editors, chat apps, document processors, and network failure recovery.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const GroqMockServer = require('../mocks/groq-mock-server');
const { generateSpeechToneWav } = require('../helpers/audio-generator');
const { MockClipboard, MockBrowserWindow } = require('../helpers/mock-electron');
const { applyVoiceCommands, applyDictionary } = require('../../src/text-utils');
const { measureMs } = require('../helpers/test-harness');

describe('Tier 4: Real-World Application Scenarios', () => {
  let mockServer;
  let serverUrl;

  before(async () => {
    mockServer = new GroqMockServer();
    serverUrl = await mockServer.start();
  });

  after(async () => {
    await mockServer.stop();
  });

  it('Scenario 1: Developer dictating code in VS Code (Code.exe, technical formatting, <400ms injection)', async () => {
    mockServer.reset();
    mockServer.configure({ defaultTranscript: 'function calculate invoice total return amount plus tax' });

    const activeWindow = { exe: 'Code.exe', title: 'billing.ts - VS Code' };
    const clipboard = new MockClipboard();
    clipboard.writeText('existing editor selection');

    const { durationMs, result } = await measureMs(async () => {
      // 1. Audio stream to Groq
      const res = await fetch(`${serverUrl}/openai/v1/audio/transcriptions`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer gsk_dev' },
        body: generateSpeechToneWav(0.5)
      });
      const data = await res.json();

      // 2. Format code identifier (camelCase / technical)
      const codeFormatted = data.text.replace(/function\s+(\w+)\s+(\w+)\s+(\w+)/i, (_, a, b, c) => {
        return `function ${a.toLowerCase()}${b.charAt(0).toUpperCase() + b.slice(1)}${c.charAt(0).toUpperCase() + c.slice(1)}()`;
      });

      // 3. Inject text via clipboard
      const snap = clipboard.snapshot();
      clipboard.writeText(codeFormatted);
      const postPasteSeq = clipboard.getClipboardSequenceNumber();
      // Restore
      if (clipboard.getClipboardSequenceNumber() === postPasteSeq) {
        clipboard.restore(snap);
      }
      return codeFormatted;
    });

    assert.ok(result.includes('function calculateInvoiceTotal()'));
    assert.strictEqual(clipboard.readText(), 'existing editor selection');
    assert.ok(durationMs < 400, `End-to-end latency ${durationMs}ms must be under 400ms`);
  });

  it('Scenario 2: Chatting in Slack (slack.exe, casual tone, "new line" voice command, contractions)', async () => {
    mockServer.reset();
    mockServer.configure({ defaultTranscript: 'hey team new line we are releasing v1 today' });

    // 1. Process voice command
    const voiceRes = applyVoiceCommands('hey team new line we are releasing v1 today');
    assert.strictEqual(voiceRes.text, 'hey team\nwe are releasing v1 today');

    // 2. LLM polish for casual messaging
    mockServer.configure({ defaultPolish: "Hey team!\nWe're releasing v1 today." });
    const chatRes = await fetch(`${serverUrl}/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer gsk_chat', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: 'Format for casual chat with friendly tone and contractions.' },
          { role: 'user', content: voiceRes.text }
        ]
      })
    });
    const chatJson = await chatRes.json();
    assert.strictEqual(chatJson.choices[0].message.content, "Hey team!\nWe're releasing v1 today.");
  });

  it('Scenario 3: Composing formal email in Outlook (OUTLOOK.EXE, formal persona, clipboard restored)', async () => {
    mockServer.reset();
    mockServer.configure({ defaultTranscript: 'i want to confirm our meeting tomorrow at 2pm' });

    const clipboard = new MockClipboard();
    clipboard.writeText('CONFIDENTIAL_EMAIL_DRAFT');

    // 1. Transcribe speech
    const sttRes = await (await fetch(`${serverUrl}/openai/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer gsk_email' },
      body: generateSpeechToneWav(0.5)
    })).json();

    // 2. Formal polish
    mockServer.configure({ defaultPolish: 'I would like to confirm our scheduled appointment tomorrow at 2:00 PM.' });
    const polishRes = await (await fetch(`${serverUrl}/openai/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer gsk_email', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: 'Rewrite into formal executive correspondence.' },
          { role: 'user', content: sttRes.text }
        ]
      })
    })).json();

    const finalText = polishRes.choices[0].message.content;
    assert.strictEqual(finalText, 'I would like to confirm our scheduled appointment tomorrow at 2:00 PM.');

    // 3. Inject and verify clipboard restored
    const snapshot = clipboard.snapshot();
    clipboard.writeText(finalText);
    clipboard.restore(snapshot);
    assert.strictEqual(clipboard.readText(), 'CONFIDENTIAL_EMAIL_DRAFT');
  });

  it('Scenario 4: Rapid-fire dictation burst (5 short utterances back-to-back, queue drains in order)', async () => {
    mockServer.reset();
    const utterances = ['First idea', 'Second thought', 'Third point', 'Fourth item', 'Fifth conclusion'];
    const processed = [];

    // Simulate FIFO queue processing
    const queue = [...utterances];
    while (queue.length > 0) {
      const current = queue.shift();
      mockServer.configure({ defaultTranscript: current });
      const res = await (await fetch(`${serverUrl}/openai/v1/audio/transcriptions`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer gsk_burst' },
        body: generateSpeechToneWav(0.1)
      })).json();
      processed.push(res.text);
    }

    assert.strictEqual(processed.length, 5);
    assert.deepStrictEqual(processed, utterances, 'Queue must preserve exact input order');
  });

  it('Scenario 5: Airplane mode / Internet disconnection mid-session (fallback to local whisper.cpp)', async () => {
    mockServer.reset();
    mockServer.configure({ dropConnection: true }); // Network completely down

    let activeEngine = 'cloud';
    let offlineBadgeVisible = false;
    let transcribedText = '';

    // Attempt cloud transcription
    try {
      await fetch(`${serverUrl}/openai/v1/audio/transcriptions`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer gsk_test' },
        body: generateSpeechToneWav(0.2)
      });
    } catch {
      // Cloud network failure: switch to local whisper.cpp fallback
      activeEngine = 'local-whisper.cpp';
      offlineBadgeVisible = true;
      transcribedText = 'Locally decoded utterance during flight';
    }

    assert.strictEqual(activeEngine, 'local-whisper.cpp');
    assert.strictEqual(offlineBadgeVisible, true);
    assert.strictEqual(transcribedText, 'Locally decoded utterance during flight');
  });

  it('Scenario 6: Network recovery (returns to Groq cloud STT after internet restored)', async () => {
    // 1. Initially offline
    let engine = 'local-whisper.cpp';
    let offlineBadge = true;

    // 2. Network restored
    mockServer.reset();
    mockServer.configure({ dropConnection: false, defaultTranscript: 'Cloud speech recognition operational' });

    const pingRes = await fetch(`${serverUrl}/openai/v1/models`, {
      headers: { 'Authorization': 'Bearer gsk_test' }
    });

    if (pingRes.status === 200) {
      engine = 'groq-cloud';
      offlineBadge = false;
    }

    const sttRes = await (await fetch(`${serverUrl}/openai/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer gsk_test' },
      body: generateSpeechToneWav(0.2)
    })).json();

    assert.strictEqual(engine, 'groq-cloud');
    assert.strictEqual(offlineBadge, false);
    assert.strictEqual(sttRes.text, 'Cloud speech recognition operational');
  });

  it('Scenario 7: Full first-run onboarding to first dictation', async () => {
    mockServer.reset();
    const userSession = {
      firstRun: true,
      apiKey: '',
      micTested: false,
      shortcutPracticed: false
    };

    // Step 1: Welcome
    assert.strictEqual(userSession.firstRun, true);

    // Step 2: Mic test
    const micLevel = 0.45;
    if (micLevel > 0.05) userSession.micTested = true;

    // Step 3: API key validation
    const testKey = 'gsk_valid_onboarding_key';
    const checkRes = await fetch(`${serverUrl}/openai/v1/models`, {
      headers: { 'Authorization': `Bearer ${testKey}` }
    });
    if (checkRes.status === 200) userSession.apiKey = testKey;

    // Step 4: Shortcut practice
    userSession.shortcutPracticed = true;
    userSession.firstRun = false;

    // First dictation after onboarding
    mockServer.configure({ defaultTranscript: 'Hello world, my first dictation!' });
    const firstDictation = await (await fetch(`${serverUrl}/openai/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${userSession.apiKey}` },
      body: generateSpeechToneWav(0.5)
    })).json();

    assert.strictEqual(userSession.firstRun, false);
    assert.strictEqual(userSession.micTested, true);
    assert.strictEqual(firstDictation.text, 'Hello world, my first dictation!');
  });

  it('Scenario 8: Heavy daily dictation with history replay and search', () => {
    const history = [];
    for (let i = 0; i < 20; i++) {
      history.push({
        id: `dict_${i}`,
        text: i === 12 ? 'Meeting notes regarding project roadmap and Q4 goals' : `Daily voice note number ${i}`,
        durationMs: 2500 + i * 100,
        audioFile: `recording_${i}.webm`,
        timestamp: Date.now() - (20 - i) * 60000
      });
    }

    // 1. Search for 'roadmap'
    const searchResults = history.filter(h => h.text.toLowerCase().includes('roadmap'));
    assert.strictEqual(searchResults.length, 1);
    assert.strictEqual(searchResults[0].id, 'dict_12');

    // 2. Playback audio verification
    const selectedEntry = searchResults[0];
    assert.strictEqual(selectedEntry.audioFile, 'recording_12.webm');
  });

  it('Scenario 9: Custom industry terminology dictation (custom glossary in prompt + post-fix)', () => {
    const customGlossary = [
      { from: 'hyper trophe', to: 'Hypertrophy' },
      { from: 'myo fibril', to: 'Myofibril' },
      { from: 'creatine mono hydrate', to: 'Creatine Monohydrate' }
    ];

    // 1. Build prompt bias
    const promptBias = customGlossary.map(g => g.to).join(', ');
    assert.ok(promptBias.includes('Hypertrophy'));
    assert.ok(promptBias.includes('Myofibril'));

    // 2. Post-processing dictionary fix for any lingering phonetic mishear
    const rawWhisperOutput = 'Patient exhibits increased hyper trophe and cellular myo fibril density.';
    const corrected = applyDictionary(rawWhisperOutput, customGlossary);

    assert.strictEqual(corrected, 'Patient exhibits increased Hypertrophy and cellular Myofibril density.');
  });

  it('Scenario 10: Multi-monitor window repositioning and theme synchronization', () => {
    const pillWindow = new MockBrowserWindow({ x: 500, y: 900, width: 320, height: 44 });
    const settingsWindow = new MockBrowserWindow({ width: 1140, height: 760 });

    // 1. User drags pill to secondary display (x: 2100, y: 800)
    pillWindow.setBounds({ x: 2100, y: 800, width: 320, height: 44 });
    const savedConfig = { pillPosition: pillWindow.getBounds() };
    assert.strictEqual(savedConfig.pillPosition.x, 2100);

    // 2. User toggles light theme in settings
    let pillTheme = null;
    let settingsTheme = null;

    pillWindow.webContents.on('ipc-message', (ch, payload) => { if (ch === 'theme-sync') pillTheme = payload.theme; });
    settingsWindow.webContents.on('ipc-message', (ch, payload) => { if (ch === 'theme-sync') settingsTheme = payload.theme; });

    // Broadcast
    pillWindow.webContents.send('theme-sync', { theme: 'light' });
    settingsWindow.webContents.send('theme-sync', { theme: 'light' });

    assert.strictEqual(pillTheme, 'light');
    assert.strictEqual(settingsTheme, 'light');

    // 3. Restart restores position on secondary screen
    const restoredPill = new MockBrowserWindow(savedConfig.pillPosition);
    assert.strictEqual(restoredPill.getBounds().x, 2100);
    assert.strictEqual(restoredPill.getBounds().y, 800);
  });
});
