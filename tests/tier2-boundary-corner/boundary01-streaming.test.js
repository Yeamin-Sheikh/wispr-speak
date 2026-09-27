// Tier 2 - Boundary 01: Streaming Transcription Boundary & Corner Cases
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const GroqMockServer = require('../mocks/groq-mock-server');
const { generateSpeechToneWav } = require('../helpers/audio-generator');

describe('Tier 2 - Boundary 01: Streaming Transcription Edge Cases', () => {
  let mockServer;
  let serverUrl;

  before(async () => {
    mockServer = new GroqMockServer();
    serverUrl = await mockServer.start();
  });

  after(async () => {
    await mockServer.stop();
  });

  it('TC-T2-B01-01: zero-byte audio payload handled cleanly without crashing server', async () => {
    mockServer.reset();
    const res = await fetch(`${serverUrl}/openai/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer gsk_test' },
      body: Buffer.alloc(0)
    });

    assert.ok([200, 400].includes(res.status));
  });

  it('TC-T2-B01-02: large continuous audio payload (>60s audio equivalent) processes successfully', async () => {
    mockServer.reset();
    // 60s at 16kHz 16-bit mono = ~1.92 MB
    const largeWav = generateSpeechToneWav(60.0);
    assert.ok(largeWav.length > 1.8 * 1024 * 1024);

    const res = await fetch(`${serverUrl}/openai/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer gsk_test' },
      body: largeWav
    });

    assert.strictEqual(res.status, 200);
  });

  it('TC-T2-B01-03: handles immediate TCP socket drop gracefully', async () => {
    mockServer.reset();
    mockServer.configure({ dropConnection: true });

    await assert.rejects(async () => {
      await fetch(`${serverUrl}/openai/v1/audio/transcriptions`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer gsk_test' },
        body: 'audio',
        signal: AbortSignal.timeout(300)
      });
    });
  });

  it('TC-T2-B01-04: network delay exceeding client timeout triggers abort error', async () => {
    mockServer.reset();
    mockServer.configure({ delayMs: 250 });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 50);

    await assert.rejects(async () => {
      await fetch(`${serverUrl}/openai/v1/audio/transcriptions`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer gsk_test' },
        body: 'audio',
        signal: controller.signal
      });
    }, (err) => err.name === 'AbortError');

    clearTimeout(timeout);
  });

  it('TC-T2-B01-05: malformed multipart form payload handled without unhandled exception', async () => {
    mockServer.reset();
    const malformedBody = '------wrongboundary\r\nContent-Disposition: broken\r\n\r\n';

    const res = await fetch(`${serverUrl}/openai/v1/audio/transcriptions`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer gsk_test',
        'Content-Type': 'multipart/form-data; boundary=----wisprtell'
      },
      body: malformedBody
    });

    assert.ok(res.status >= 200);
  });
});
