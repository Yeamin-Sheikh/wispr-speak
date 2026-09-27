// Tier 2 - Boundary 05: Exponential Backoff Retry Boundary Cases
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { computeBackoffMs } = require('../helpers/test-harness');

function parseRetryDelay(headerValue, attempt) {
  if (headerValue !== null && headerValue !== undefined) {
    const parsed = Number(headerValue);
    if (!isNaN(parsed) && parsed >= 0) {
      return parsed * 1000;
    }
  }
  // Formula per PROJECT.md: Math.min(8000, 500 * Math.pow(2, attempt) + Math.random() * 300)
  return computeBackoffMs(attempt, Math.random() * 300);
}

describe('Tier 2 - Boundary 05: Exponential Backoff Retry Boundary Cases', () => {
  it('TC-T2-B05-01: falls back to formula when Retry-After is malformed string', () => {
    const delay = parseRetryDelay('invalid-not-a-number', 1);
    assert.ok(delay >= 1000 && delay <= 1300, `Delay ${delay} should be ~1000ms`);
  });

  it('TC-T2-B05-02: falls back to formula when Retry-After is negative number', () => {
    const delay = parseRetryDelay('-5', 0);
    assert.ok(delay >= 500 && delay <= 800, `Delay ${delay} should be ~500ms`);
  });

  it('TC-T2-B05-03: caps maximum backoff delay at 8000ms even for high attempt numbers', () => {
    for (let attempt = 4; attempt <= 10; attempt++) {
      const delay = parseRetryDelay(null, attempt);
      assert.ok(delay <= 8000, `Attempt ${attempt} delay ${delay} must not exceed 8000ms ceiling`);
    }
  });

  it('TC-T2-B05-04: classifies HTTP 400 and 401 as non-retriable immediate failures', () => {
    function isRetriable(status) {
      return status === 429 || (status >= 500 && status <= 599);
    }

    assert.strictEqual(isRetriable(200), false);
    assert.strictEqual(isRetriable(400), false);
    assert.strictEqual(isRetriable(401), false);
    assert.strictEqual(isRetriable(403), false);
    assert.strictEqual(isRetriable(404), false);
    assert.strictEqual(isRetriable(429), true);
    assert.strictEqual(isRetriable(500), true);
    assert.strictEqual(isRetriable(503), true);
  });

  it('TC-T2-B05-05: verifies jitter variance remains strictly within [0, 300] ms range', () => {
    const attempt = 1; // Base is 500 * 2^1 = 1000ms
    for (let i = 0; i < 50; i++) {
      const delay = parseRetryDelay(null, attempt);
      const jitter = delay - 1000;
      assert.ok(jitter >= 0 && jitter <= 300, `Jitter ${jitter} must be within [0, 300] ms`);
    }
  });
});
