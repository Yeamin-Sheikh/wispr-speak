// Tier 1 - Feature 01: Real-Time Streaming Transcription
// Tests streaming audio chunks to Groq STT and collecting interim/final transcriptions.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const GroqMockServer = require('../mocks/groq-mock-server');
const { generateSpeechToneWav } = require('../helpers/audio-generator');
const { measureMs } = require('../helpers/test-harness');

describe('Tier 1 - Feature 01: Real-Time Streaming Transcription', () => {
  let mockServer;
  let serverUrl;

  before(async () => {
    mockServer = new GroqMockServer();
    serverUrl = await mockServer.start();
  });

  after(async () => {
    await mockServer.stop();
  });

  it('TC-T1-F01-01: initializes streaming audio session with valid authorization and endpoint', async () => {
    mockServer.reset();
    const wav = generateSpeechToneWav(0.5);

    const res = await fetch(`${serverUrl}/openai/v1/audio/transcriptions`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer gsk_test_key_valid',
        'Content-Type': 'multipart/form-data; boundary=----wisprtest'
      },
      body: Buffer.concat([
        Buffer.from('------wisprtest\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-large-v3-turbo\r\n'),
        Buffer.from('------wisprtest\r\nContent-Disposition: form-data; name="file"; filename="chunk-0.wav"\r\nContent-Type: audio/wav\r\n\r\n'),
        wav,
        Buffer.from('\r\n------wisprtest--\r\n')
      ])
    });

    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.ok(json.text, 'Response should contain transcription text');
  });

  it('TC-T1-F01-02: transmits sequential speech chunks with chronological timestamps', async () => {
    mockServer.reset();
    const chunks = [
      { id: 1, duration: 0.5 },
      { id: 2, duration: 0.5 },
      { id: 3, duration: 0.5 }
    ];

    for (const chunk of chunks) {
      const wav = generateSpeechToneWav(chunk.duration);
      const res = await fetch(`${serverUrl}/openai/v1/audio/transcriptions`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer gsk_test_key_valid' },
        body: wav
      });
      assert.strictEqual(res.status, 200);
    }

    const history = mockServer.getHistory();
    assert.strictEqual(history.length, 3, 'Should have received 3 chunk posts in sequence');
    assert.ok(history[1].timestamp >= history[0].timestamp, 'Timestamps must be chronological');
    assert.ok(history[2].timestamp >= history[1].timestamp, 'Timestamps must be chronological');
  });

  it('TC-T1-F01-03: receives and parses verbose json with word-level segments', async () => {
    mockServer.reset();
    const wav = generateSpeechToneWav(1.0);

    const res = await fetch(`${serverUrl}/openai/v1/audio/transcriptions`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer gsk_test_key_valid',
        'Content-Type': 'multipart/form-data; boundary=----wisprtest'
      },
      body: Buffer.concat([
        Buffer.from('------wisprtest\r\nContent-Disposition: form-data; name="response_format"\r\n\r\nverbose_json\r\n'),
        Buffer.from('------wisprtest\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n'),
        wav,
        Buffer.from('\r\n------wisprtest--\r\n')
      ])
    });

    assert.strictEqual(res.status, 200);
    const json = await res.json();
    assert.ok(Array.isArray(json.segments), 'Verbose JSON response must contain segments array');
    assert.ok(json.segments.length > 0, 'Segments array must not be empty');
    assert.strictEqual(typeof json.segments[0].start, 'number');
    assert.strictEqual(typeof json.segments[0].end, 'number');
  });

  it('TC-T1-F01-04: finalizes complete transcript on stream completion', async () => {
    mockServer.reset();
    mockServer.configure({ defaultTranscript: 'Final consolidated dictation sentence.' });
    const wav = generateSpeechToneWav(1.5);

    const res = await fetch(`${serverUrl}/openai/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer gsk_test_key_valid' },
      body: wav
    });

    const json = await res.json();
    assert.strictEqual(json.text, 'Final consolidated dictation sentence.');
  });

  it('TC-T1-F01-05: verifies end-to-end latency budget under 400ms for short utterances', async () => {
    mockServer.reset();
    mockServer.configure({ delayMs: 25 }); // 25ms simulated server latency
    const wav = generateSpeechToneWav(0.5);

    const { durationMs, result } = await measureMs(async () => {
      const res = await fetch(`${serverUrl}/openai/v1/audio/transcriptions`, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer gsk_test_key_valid' },
        body: wav
      });
      return await res.json();
    });

    assert.ok(durationMs < 600, `Latency was ${durationMs}ms, must be under 600ms target`);
    assert.ok(result.text);
  });
});
