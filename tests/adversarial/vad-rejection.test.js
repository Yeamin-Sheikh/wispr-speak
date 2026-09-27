// Adversarial Stress Tests: Silero VAD Non-Speech Rejection
// Tests non-speech rejection against clicks, pink noise, pure DC offsets, and silence bursts.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { SileroVadEngine, VadEvaluator } = require('../../src/renderer/vad-engine.js');
const { generateSilenceWav, generateSpeechToneWav, generateKeyboardClickWav, generatePinkNoiseWav } = require('../helpers/audio-generator.js');

describe('Adversarial Silero VAD Non-Speech Rejection Stress Tests', () => {
  it('ADV-VAD-01: rejects pure silence bursts across multiple consecutive frames', async () => {
    const engine = new SileroVadEngine();
    await engine.init();

    // 1 second of pure digital silence (zeroes)
    const silenceWav = generateSilenceWav(1.0, 16000).subarray(44);
    const floats = new Float32Array(silenceWav.length / 2);

    for (let o = 0; o + 512 <= floats.length; o += 512) {
      const frame = floats.subarray(o, o + 512);
      const res = await engine.processFrame(frame);
      assert.strictEqual(res.isSpeechActive, false, 'Silence must never trigger active speech');
      assert.strictEqual(res.probability <= 0.1, true, 'Silence probability must remain below noise floor');
    }

    assert.strictEqual(engine.getProcessedAudio(), null, 'Silence must return null audio to prevent API call');
  });

  it('ADV-VAD-02: rejects high-amplitude transient clicks, Dirac pulses, and keyboard rattle', async () => {
    const engine = new SileroVadEngine();
    await engine.init();

    // 1. Single Dirac impulse (amplitude 1.0)
    const diracFrame = new Float32Array(512);
    diracFrame[10] = 1.0;
    const rDirac = await engine.processFrame(diracFrame);
    assert.strictEqual(rDirac.isSpeechActive, false);
    assert.strictEqual(rDirac.probability, 0.15, 'High crest factor impulse must be clamped to 0.15');

    // 2. High-frequency metallic switch rattle (6000Hz rapid burst)
    const rattleFrame = new Float32Array(512);
    for (let i = 0; i < 120; i++) {
      rattleFrame[i] = Math.sin(2 * Math.PI * 6000 * (i / 16000)) * Math.exp(-i / 15) * 0.95;
    }
    const rRattle = await engine.processFrame(rattleFrame);
    assert.strictEqual(rRattle.isSpeechActive, false);

    // 3. Realistic mechanical keyboard click burst (15 clicks across 1 second)
    const clickWav = generateKeyboardClickWav(16000).subarray(44);
    const clickFloats = new Float32Array(clickWav.length / 2);
    for (let i = 0; i < clickFloats.length; i++) {
      clickFloats[i] = clickWav.readInt16LE(i * 2) / 32768.0;
    }

    for (let o = 0; o + 512 <= clickFloats.length; o += 512) {
      await engine.processFrame(clickFloats.subarray(o, o + 512));
    }

    assert.strictEqual(engine.getProcessedAudio(), null, 'Keyboard clicks must be completely rejected');
  });

  it('ADV-VAD-03: positive control verifies speech tones trigger speech detection', async () => {
    const engine = new SileroVadEngine();
    await engine.init();

    // 0.5s sustained vowel tone (220Hz + harmonics)
    const speechWav = generateSpeechToneWav(0.5, 220, 16000, 0.4).subarray(44);
    const speechFloats = new Float32Array(speechWav.length / 2);
    for (let i = 0; i < speechFloats.length; i++) {
      speechFloats[i] = speechWav.readInt16LE(i * 2) / 32768.0;
    }

    for (let o = 0; o + 512 <= speechFloats.length; o += 512) {
      await engine.processFrame(speechFloats.subarray(o, o + 512));
    }

    const processed = engine.getProcessedAudio();
    assert.notStrictEqual(processed, null, 'Speech tone must be accepted and return audio');
    assert.strictEqual(processed.length > 0, true);
  });

  it('ADV-VAD-04: rejects pure DC offsets without classifying flatline voltage as speech', async () => {
    // Pure DC offsets (0 Hz constant signal) represent microphone hardware bias or ground hum.
    // They have 0 AC variance and 0 speech formant information.
    // Acceptance criterion: VAD must reject non-speech audio (100% rejection).
    const engine = new SileroVadEngine();
    await engine.init();

    // Test a range of DC offset amplitudes: 0.06, 0.1, 0.2, 0.5
    const dcLevels = [0.06, 0.1, 0.2, 0.5];
    for (const dc of dcLevels) {
      engine.resetStates();
      const dcFrame = new Float32Array(512).fill(dc);

      // Process 10 consecutive frames (320ms) of constant DC
      let speechDetected = false;
      for (let i = 0; i < 10; i++) {
        const res = await engine.processFrame(dcFrame);
        if (res.isSpeechActive) speechDetected = true;
      }

      const audio = engine.getProcessedAudio();
      assert.strictEqual(
        audio,
        null,
        `DC offset of amplitude ${dc} must be rejected as non-speech, but got accepted audio with length ${audio?.length}`
      );
      assert.strictEqual(
        speechDetected,
        false,
        `DC offset of amplitude ${dc} triggered false speech detection`
      );
    }
  });

  it('ADV-VAD-05: rejects loud ambient pink noise without classifying background rumble as speech', async () => {
    // Pink noise (-3dB/octave) models ambient background rumble (HVAC, computer fan, cafe noise).
    // Acceptance criterion: VAD must reject background noise without sending to API.
    const engine = new SileroVadEngine();
    await engine.init();

    // Test pink noise at amplitude 0.3 (common in noisy rooms)
    const pinkWav = generatePinkNoiseWav(0.6, 16000, 0.3).subarray(44);
    const pinkFloats = new Float32Array(pinkWav.length / 2);
    for (let i = 0; i < pinkFloats.length; i++) {
      pinkFloats[i] = pinkWav.readInt16LE(i * 2) / 32768.0;
    }

    let speechDetected = false;
    for (let o = 0; o + 512 <= pinkFloats.length; o += 512) {
      const res = await engine.processFrame(pinkFloats.subarray(o, o + 512));
      if (res.isSpeechActive) speechDetected = true;
    }

    const audio = engine.getProcessedAudio();
    assert.strictEqual(
      audio,
      null,
      `Pink noise (amp=0.3) must be rejected as non-speech background noise, but got accepted audio with length ${audio?.length}`
    );
    assert.strictEqual(speechDetected, false, 'Loud pink noise triggered false speech detection');
  });
});
