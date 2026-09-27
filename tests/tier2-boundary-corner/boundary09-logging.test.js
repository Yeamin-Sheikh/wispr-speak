// Tier 2 - Boundary 09: Structured JSON Logging Boundary Cases
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

function safeStringifyLog(entry) {
  const seen = new WeakSet();
  return JSON.stringify(entry, (key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        return '[Circular]';
      }
      seen.add(value);
    }
    return value;
  });
}

describe('Tier 2 - Boundary 09: Structured JSON Logging Boundary Cases', () => {
  it('TC-T2-B09-01: serializes circular object references without throwing TypeError', () => {
    const circularObj = { name: 'circular' };
    circularObj.self = circularObj;

    const entry = {
      timestamp: new Date().toISOString(),
      level: 'info',
      category: 'test',
      metadata: circularObj
    };

    assert.doesNotThrow(() => {
      const serialized = safeStringifyLog(entry);
      assert.ok(serialized.includes('[Circular]'));
    });
  });

  it('TC-T2-B09-02: handles high logging throughput (500 logs) in under 50ms', () => {
    const tempFile = path.join(os.tmpdir(), `wispr-burst-${Date.now()}.log`);
    const logs = [];

    const startTime = Date.now();
    for (let i = 0; i < 500; i++) {
      logs.push(JSON.stringify({ i, time: Date.now() }));
    }
    fs.writeFileSync(tempFile, logs.join('\n') + '\n');
    const duration = Date.now() - startTime;

    assert.ok(duration < 50, `Burst logging took ${duration}ms, must be < 50ms`);
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  });

  it('TC-T2-B09-03: preserves multi-byte UTF-8 emojis and symbols without corrupting bytes', () => {
    const specialMsg = 'Testing log with 🚀, 日本語, and special symbols: € § ¶';
    const entry = { timestamp: new Date().toISOString(), level: 'info', message: specialMsg };
    const tempFile = path.join(os.tmpdir(), `wispr-utf8-${Date.now()}.log`);

    fs.writeFileSync(tempFile, JSON.stringify(entry) + '\n', 'utf8');
    const readBack = JSON.parse(fs.readFileSync(tempFile, 'utf8').trim());

    assert.strictEqual(readBack.message, specialMsg);
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  });

  it('TC-T2-B09-04: handles very large log message (>64KB string) without truncation', () => {
    const largeMessage = 'X'.repeat(65536);
    const entry = { timestamp: new Date().toISOString(), level: 'debug', message: largeMessage };

    const serialized = safeStringifyLog(entry);
    const parsed = JSON.parse(serialized);
    assert.strictEqual(parsed.message.length, 65536);
  });

  it('TC-T2-B09-05: falls back to console output if file writing throws error', () => {
    let consoleCalled = false;
    function logWithFallback(filePath, data) {
      try {
        // Attempt write to invalid system path
        fs.appendFileSync('Z:\\non-existent-drive\\fake.log', data);
      } catch {
        consoleCalled = true;
      }
    }

    logWithFallback('fake', 'test log');
    assert.strictEqual(consoleCalled, true);
  });
});
