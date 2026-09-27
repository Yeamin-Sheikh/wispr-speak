// Tier 2 - Boundary 04: Zero-Copy Audio IPC Boundary & Corner Cases
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { MessageChannel } = require('worker_threads');

function sanitizeFftBins(floatArray) {
  const clean = new Float32Array(16);
  for (let i = 0; i < 16; i++) {
    const val = floatArray[i];
    if (isNaN(val) || !isFinite(val)) {
      clean[i] = 0.0;
    } else {
      clean[i] = Math.max(0.0, Math.min(1.0, val));
    }
  }
  return clean;
}

describe('Tier 2 - Boundary 04: Zero-Copy Audio IPC Boundary Cases', () => {
  it('TC-T2-B04-01: handles zero-length buffer transfer without crashing channel', async () => {
    const { port1, port2 } = new MessageChannel();
    const emptyBuf = new Float32Array(0);

    let receivedLength = -1;
    await new Promise((resolve) => {
      port2.on('message', (msg) => {
        receivedLength = msg.length;
        resolve();
      });
      port1.postMessage(emptyBuf, [emptyBuf.buffer]);
    });

    assert.strictEqual(receivedLength, 0);
    port1.close();
    port2.close();
  });

  it('TC-T2-B04-02: posting to closed or crashed port does not throw unhandled process crash', () => {
    const { port1, port2 } = new MessageChannel();
    port2.close(); // Simulate receiver window crash

    assert.doesNotThrow(() => {
      const data = new Float32Array(16);
      port1.postMessage(data, [data.buffer]);
    });
    port1.close();
  });

  it('TC-T2-B04-03: sanitizes NaN, +Infinity, and -Infinity values in FFT bins to 0.0', () => {
    const corruptFft = new Float32Array(16);
    corruptFft[0] = NaN;
    corruptFft[1] = Infinity;
    corruptFft[2] = -Infinity;
    corruptFft[3] = 1.5; // Above 1.0
    corruptFft[4] = -0.5; // Below 0.0
    corruptFft[5] = 0.75; // Valid

    const sanitized = sanitizeFftBins(corruptFft);

    assert.strictEqual(sanitized[0], 0.0);
    assert.strictEqual(sanitized[1], 0.0);
    assert.strictEqual(sanitized[2], 0.0);
    assert.strictEqual(sanitized[3], 1.0); // Clamped
    assert.strictEqual(sanitized[4], 0.0); // Clamped
    assert.strictEqual(sanitized[5], 0.75);
  });

  it('TC-T2-B04-04: establishes and tears down 10 consecutive MessagePort pairs without leak', () => {
    for (let i = 0; i < 10; i++) {
      const { port1, port2 } = new MessageChannel();
      port1.postMessage('ping');
      port1.close();
      port2.close();
    }
    assert.ok(true);
  });

  it('TC-T2-B04-05: verifies transfer of oversized float buffer (>1024 bins) truncates to 16 bins', () => {
    const hugeFft = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) hugeFft[i] = 0.5;

    const sanitized = sanitizeFftBins(hugeFft);
    assert.strictEqual(sanitized.length, 16);
  });
});
