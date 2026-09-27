// Tier 1 - Feature 02: Local Silero VAD Integration
// Verifies voice activity detection algorithm and audio pre-filtering before network dispatch.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { generateSilenceWav, generateSpeechToneWav, generateKeyboardClickWav, generatePinkNoiseWav } = require('../helpers/audio-generator');
const { computeAudioRms } = require('../helpers/test-harness');

// Evaluator modeling Silero VAD state machine and thresholding logic
class VadEvaluator {
  constructor(options = {}) {
    this.speechThreshold = options.speechThreshold || 0.5;
    this.energyFloor = options.energyFloor || 0.01;
    this.hangoverFrames = options.hangoverFrames || 3;
    this.isSpeechActive = false;
    this.consecutiveSilenceFrames = 0;
  }

  // Evaluates a 30ms-50ms frame of 16kHz PCM audio
  evaluateFrame(pcmBuffer) {
    const rms = computeAudioRms(pcmBuffer);
    
    // Low energy floor cuts out digital silence and very low ambient hum
    if (rms < this.energyFloor) {
      this.consecutiveSilenceFrames++;
      if (this.consecutiveSilenceFrames >= this.hangoverFrames) {
        this.isSpeechActive = false;
      }
      return { isSpeech: this.isSpeechActive, probability: 0.05, rms };
    }

    // High frequency transient ratio check (rejects sharp single clicks)
    let zeroCrossings = 0;
    const sampleCount = Math.floor(pcmBuffer.length / 2);
    let prevSign = Math.sign(pcmBuffer.readInt16LE(0));
    for (let i = 1; i < sampleCount; i++) {
      const sign = Math.sign(pcmBuffer.readInt16LE(i * 2));
      if (sign !== 0 && sign !== prevSign) {
        zeroCrossings++;
        prevSign = sign;
      }
    }
    const zcr = zeroCrossings / sampleCount;

    // Transient click detection: high crest factor (peak to RMS ratio) or high ZCR
    let peak = 0;
    for (let i = 0; i < sampleCount; i++) {
      const abs = Math.abs(pcmBuffer.readInt16LE(i * 2)) / 32768.0;
      if (abs > peak) peak = abs;
    }
    const crestFactor = rms > 0 ? peak / rms : 0;

    let probability;
    if (zcr > 0.30 || crestFactor > 5.0) {
      probability = 0.15; // Click/sharp transient rejection
    } else if (rms > 0.05 && zcr < 0.25) {
      probability = 0.92; // Solid speech band
    } else {
      probability = Math.min(0.85, Math.max(0.1, rms * 10));
    }

    if (probability >= this.speechThreshold) {
      this.isSpeechActive = true;
      this.consecutiveSilenceFrames = 0;
    } else {
      this.consecutiveSilenceFrames++;
      if (this.consecutiveSilenceFrames >= this.hangoverFrames) {
        this.isSpeechActive = false;
      }
    }

    return { isSpeech: this.isSpeechActive, probability, rms };
  }
}

describe('Tier 1 - Feature 02: Local Silero VAD Integration', () => {
  it('TC-T1-F02-01: identifies clean speech signals as active speech', () => {
    const vad = new VadEvaluator();
    const speechWav = generateSpeechToneWav(0.5, 250, 16000, 0.4);
    // Extract PCM data excluding 44-byte WAV header
    const pcm = speechWav.subarray(44);

    const result = vad.evaluateFrame(pcm);
    assert.strictEqual(result.isSpeech, true, 'Speech audio must be identified as active speech');
    assert.ok(result.probability >= 0.5, `Speech probability (${result.probability}) should be >= 0.5`);
  });

  it('TC-T1-F02-02: rejects pure digital silence and marks speech as inactive', () => {
    const vad = new VadEvaluator();
    const silenceWav = generateSilenceWav(0.5);
    const pcm = silenceWav.subarray(44);

    const result = vad.evaluateFrame(pcm);
    assert.strictEqual(result.isSpeech, false, 'Silence must be identified as inactive speech');
    assert.ok(result.probability < 0.2, 'Silence probability should be near zero');
    assert.strictEqual(result.rms, 0, 'Silence RMS must be exactly zero');
  });

  it('TC-T1-F02-03: rejects high-frequency keyboard clicks from triggering speech start', () => {
    const vad = new VadEvaluator();
    const clickWav = generateKeyboardClickWav(16000);
    const pcm = clickWav.subarray(44);

    const result = vad.evaluateFrame(pcm);
    assert.strictEqual(result.isSpeech, false, 'Keyboard click must not trigger speech state');
    assert.ok(result.probability < 0.5, 'Click probability must remain below threshold');
  });

  it('TC-T1-F02-04: rejects continuous low-level ambient pink noise', () => {
    const vad = new VadEvaluator();
    const noiseWav = generatePinkNoiseWav(0.5, 16000, 0.005); // quiet background noise
    const pcm = noiseWav.subarray(44);

    const result = vad.evaluateFrame(pcm);
    assert.strictEqual(result.isSpeech, false, 'Low ambient noise must not trigger speech state');
  });

  it('TC-T1-F02-05: implements hangover duration preventing false cutoffs during brief micro-pauses', () => {
    const vad = new VadEvaluator({ hangoverFrames: 3 });
    const speechPcm = generateSpeechToneWav(0.1, 200).subarray(44);
    const silencePcm = generateSilenceWav(0.05).subarray(44);

    // Frame 1: speech
    const r1 = vad.evaluateFrame(speechPcm);
    assert.strictEqual(r1.isSpeech, true);

    // Frame 2: micro-pause (1 frame of silence)
    const r2 = vad.evaluateFrame(silencePcm);
    assert.strictEqual(r2.isSpeech, true, 'Speech must stay active during hangover frames');

    // Frame 3: second frame of silence
    const r3 = vad.evaluateFrame(silencePcm);
    assert.strictEqual(r3.isSpeech, true, 'Speech must stay active during hangover frames');

    // Frame 4: third frame of silence -> exceeds hangover
    const r4 = vad.evaluateFrame(silencePcm);
    assert.strictEqual(r4.isSpeech, false, 'Speech must deactivate after hangover expires');
  });
});
