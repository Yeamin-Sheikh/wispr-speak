// Tier 1 - Feature 05: Exponential Backoff Retry in groqPost
// Verifies HTTP 429/50x handling, Retry-After header parsing, exponential backoff delays, and max attempts.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const GroqMockServer = require('../mocks/groq-mock-server');
const { computeBackoffMs } = require('../helpers/test-harness');

// Client implementation of groqPost conforming to PROJECT.md contract
async function executeGroqPostWithBackoff({
  baseUrl,
  pathname,
  body,
  contentType,
  maxAttempts = 4,
  sleepFn = (ms) => new Promise(r => setTimeout(r, ms))
}) {
  let lastResponse = null;
  const attempts = [];

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const startTime = Date.now();
    try {
      const res = await fetch(`${baseUrl}${pathname}`, {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer gsk_test_key',
          'Content-Type': contentType || 'application/json'
        },
        body
      });

      const bodyText = await res.text();
      let parsed = null;
      try { parsed = JSON.parse(bodyText); } catch {}

      const record = {
        attempt,
        status: res.status,
        headers: Object.fromEntries(res.headers.entries()),
        body: parsed || bodyText,
        duration: Date.now() - startTime
      };
      attempts.push(record);
      lastResponse = record;

      if (res.status === 200) {
        return { success: true, attempts, data: record.body };
      }

      // Check for rate limit or server error
      if (res.status === 429 || res.status >= 500) {
        if (attempt < maxAttempts - 1) {
          const retryAfter = res.headers.get('retry-after');
          let delayMs = 0;
          if (retryAfter && !isNaN(Number(retryAfter))) {
            delayMs = Number(retryAfter) * 1000;
          } else {
            delayMs = computeBackoffMs(attempt, 50); // fast test jitter
          }
          await sleepFn(delayMs);
          continue;
        }
      } else {
        // Non-retriable error (e.g. 400 Bad Request, 401 Unauthorized)
        return { success: false, attempts, error: `Non-retriable HTTP ${res.status}` };
      }
    } catch (err) {
      attempts.push({ attempt, error: err.message });
      if (attempt < maxAttempts - 1) {
        const delayMs = computeBackoffMs(attempt, 50);
        await sleepFn(delayMs);
        continue;
      }
    }
  }

  return { success: false, attempts, error: 'Max retry attempts exhausted' };
}

describe('Tier 1 - Feature 05: Exponential Backoff Retry in groqPost', () => {
  let mockServer;
  let serverUrl;

  before(async () => {
    mockServer = new GroqMockServer();
    serverUrl = await mockServer.start();
  });

  after(async () => {
    await mockServer.stop();
  });

  it('TC-T1-F05-01: succeeds immediately on HTTP 200 without retrying', async () => {
    mockServer.reset();
    const result = await executeGroqPostWithBackoff({
      baseUrl: serverUrl,
      pathname: '/openai/v1/chat/completions',
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [] })
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.attempts.length, 1, 'Should succeed on first attempt');
    assert.strictEqual(result.attempts[0].status, 200);
  });

  it('TC-T1-F05-02: retries upon HTTP 429 and honors Retry-After header duration', async () => {
    mockServer.reset();
    mockServer.configure({
      sttStatus: 429,
      retryAfterHeader: 1, // 1 second
      failureCountBeforeSuccess: 1
    });

    const sleepCalls = [];
    const customSleep = async (ms) => { sleepCalls.push(ms); };

    const result = await executeGroqPostWithBackoff({
      baseUrl: serverUrl,
      pathname: '/openai/v1/audio/transcriptions',
      body: 'mock-audio',
      sleepFn: customSleep
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.attempts.length, 2);
    assert.strictEqual(sleepCalls.length, 1);
    assert.strictEqual(sleepCalls[0], 1000, 'Should delay exactly 1000ms based on Retry-After: 1 header');
  });

  it('TC-T1-F05-03: computes exponential backoff when Retry-After header is absent on HTTP 503', async () => {
    mockServer.reset();
    mockServer.configure({
      sttStatus: 503,
      retryAfterHeader: null,
      failureCountBeforeSuccess: 2
    });

    const sleepCalls = [];
    const customSleep = async (ms) => { sleepCalls.push(ms); };

    const result = await executeGroqPostWithBackoff({
      baseUrl: serverUrl,
      pathname: '/openai/v1/audio/transcriptions',
      body: 'mock-audio',
      sleepFn: customSleep
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.attempts.length, 3);
    assert.strictEqual(sleepCalls.length, 2);

    // Attempt 0 backoff: 500 * 2^0 = 500ms (+ jitter)
    // Attempt 1 backoff: 500 * 2^1 = 1000ms (+ jitter)
    assert.ok(sleepCalls[0] >= 500 && sleepCalls[0] <= 800, `Attempt 0 delay ${sleepCalls[0]} should be ~500ms`);
    assert.ok(sleepCalls[1] >= 1000 && sleepCalls[1] <= 1300, `Attempt 1 delay ${sleepCalls[1]} should be ~1000ms`);
  });

  it('TC-T1-F05-04: succeeds on attempt 3 after recovering from consecutive 429 errors', async () => {
    mockServer.reset();
    mockServer.configure({
      sttStatus: 429,
      failureCountBeforeSuccess: 2
    });

    const result = await executeGroqPostWithBackoff({
      baseUrl: serverUrl,
      pathname: '/openai/v1/audio/transcriptions',
      body: 'mock-audio',
      sleepFn: async () => {} // Instant sleep for test speed
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.attempts.length, 3);
    assert.strictEqual(result.attempts[0].status, 429);
    assert.strictEqual(result.attempts[1].status, 429);
    assert.strictEqual(result.attempts[2].status, 200);
  });

  it('TC-T1-F05-05: terminates and returns error after exhausting maximum retry attempts (4)', async () => {
    mockServer.reset();
    mockServer.configure({
      sttStatus: 500,
      failureCountBeforeSuccess: 10 // Stays failing
    });

    const result = await executeGroqPostWithBackoff({
      baseUrl: serverUrl,
      pathname: '/openai/v1/audio/transcriptions',
      body: 'mock-audio',
      maxAttempts: 4,
      sleepFn: async () => {}
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.attempts.length, 4);
    assert.strictEqual(result.error, 'Max retry attempts exhausted');
  });
});
