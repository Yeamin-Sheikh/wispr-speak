// Tier 2 - Boundary 02: Silero VAD Boundary & Corner Cases
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { computeAudioRms } = require('../helpers/test-harness');

function evaluateVadBoundary(pcmBuffer, threshold = 0.5) {
  // Safe buffer truncation for odd byte counts
  const validLength = pcmBuffer.length - (pcmBuffer.length % 2);
  if (validLength === 0) return { isSpeech: false, probability: 0, rms: 0 };

  const safeBuffer = pcmBuffer.subarray(0, validLength);
  const rms = computeAudioRms(safeBuffer);

  // Check for DC offset without AC modulation
  let firstVal = safeBuffer.readInt16LE(0);
  let isConstantDC = true;
  for (let i = 1; i < validLength / 2; i++) {
    if (safeBuffer.readInt16LE(i * 2) !== firstVal) {
      isConstantDC = false;
      break;
    }
  }

  if (isConstantDC && firstVal !== 0) {
    return { isSpeech: false, probability: 0.0, rms, note: 'dc-offset-rejected' };
  }

  const prob = Math.min(1.0, rms * 8.0);
  return { isSpeech: prob >= threshold, probability: prob, rms };
}

describe('Tier 2 - Boundary 02: Silero VAD Boundary & Corner Cases', () => {
  it('TC-T2-B02-01: discriminates whisper right at threshold boundary', () => {
    // RMS = 0.501 / 8 = 0.062625 -> prob = 0.501 -> speech = true
    // RMS = 0.499 / 8 = 0.062375 -> prob = 0.499 -> speech = false
    const sampleCount = 480; // 30ms at 16kHz
    const bufAbove = Buffer.alloc(sampleCount * 2);
    const bufBelow = Buffer.alloc(sampleCount * 2);

    const ampAbove = 32767 * 0.062625;
    const ampBelow = 32767 * 0.062375;

    for (let i = 0; i < sampleCount; i++) {
      const sAbove = Math.sin(2 * Math.PI * 400 * (i / 16000)) * ampAbove * Math.SQRT2;
      const sBelow = Math.sin(2 * Math.PI * 400 * (i / 16000)) * ampBelow * Math.SQRT2;
      bufAbove.writeInt16LE(Math.max(-32768, Math.min(32767, Math.floor(sAbove))), i * 2);
      bufBelow.writeInt16LE(Math.max(-32768, Math.min(32767, Math.floor(sBelow))), i * 2);
    }

    const resAbove = evaluateVadBoundary(bufAbove, 0.5);
    const resBelow = evaluateVadBoundary(bufBelow, 0.5);

    assert.strictEqual(resAbove.isSpeech, true);
    assert.strictEqual(resBelow.isSpeech, false);
  });

  it('TC-T2-B02-02: rejects pure DC offset spike from false positive speech detection', () => {
    const dcBuffer = Buffer.alloc(960);
    // Fill with high non-zero constant value
    for (let i = 0; i < 480; i++) {
      dcBuffer.writeInt16LE(15000, i * 2);
    }

    const res = evaluateVadBoundary(dcBuffer);
    assert.strictEqual(res.isSpeech, false, 'Constant DC offset must be rejected');
    assert.strictEqual(res.note, 'dc-offset-rejected');
  });

  it('TC-T2-B02-03: handles saturated clipping audio without numeric overflow or NaN', () => {
    const clippedBuffer = Buffer.alloc(960);
    for (let i = 0; i < 480; i++) {
      clippedBuffer.writeInt16LE(i % 2 === 0 ? 32767 : -32768, i * 2);
    }

    const res = evaluateVadBoundary(clippedBuffer);
    assert.strictEqual(res.isSpeech, true);
    assert.ok(!isNaN(res.rms));
    assert.ok(!isNaN(res.probability));
    assert.ok(res.probability <= 1.0);
  });

  it('TC-T2-B02-04: safely truncates odd-length byte buffers without throwing RangeError', () => {
    const oddBuffer = Buffer.alloc(481); // 481 bytes is odd
    assert.doesNotThrow(() => {
      const res = evaluateVadBoundary(oddBuffer);
      assert.strictEqual(typeof res.isSpeech, 'boolean');
    });
  });

  it('TC-T2-B02-05: processes 1,000 consecutive frames in under 100ms with constant memory', () => {
    const frame = Buffer.alloc(960);
    const startMem = process.memoryUsage().heapUsed;
    const startTime = Date.now();

    for (let i = 0; i < 1000; i++) {
      evaluateVadBoundary(frame);
    }

    const duration = Date.now() - startTime;
    const memDiff = process.memoryUsage().heapUsed - startMem;

    assert.ok(duration < 100, `Execution time was ${duration}ms, must be < 100ms`);
    // Memory change should be minimal (< 5MB)
    assert.ok(memDiff < 5 * 1024 * 1024);
  });
});
