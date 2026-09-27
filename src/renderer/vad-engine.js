// Silero VAD engine for Wispr Tell in-renderer speech detection.
// Runs locally in Chromium via ONNX Runtime Web Wasm.
// Rejects silence, typing, coughs, and transient acoustic noise before network transmission.
// Also provides an acoustic feature analyzer for offline verification and zero-dependency fallback.

/**
 * Acoustic feature evaluator modeling energy, zero-crossing rate,
 * crest factor (transient click rejection), and hangover frames.
 */
class VadEvaluator {
  constructor(options = {}) {
    this.speechThreshold = options.speechThreshold || 0.5;
    this.energyFloor = options.energyFloor || 0.01;
    this.hangoverFrames = options.hangoverFrames || 3;
    this.isSpeechActive = false;
    this.consecutiveSilenceFrames = 0;
  }

  /**
   * Computes RMS of a PCM Float32Array or Int16 Buffer.
   */
  computeRms(samples) {
    if (!samples || samples.length === 0) return 0;
    let sumSq = 0;
    if (samples instanceof Float32Array) {
      for (let i = 0; i < samples.length; i++) {
        sumSq += samples[i] * samples[i];
      }
      return Math.sqrt(sumSq / samples.length);
    } else if (Buffer.isBuffer(samples)) {
      const count = Math.floor(samples.length / 2);
      for (let i = 0; i < count; i++) {
        const val = samples.readInt16LE(i * 2) / 32768.0;
        sumSq += val * val;
      }
      return Math.sqrt(sumSq / count);
    }
    return 0;
  }

  /**
   * Evaluates a single frame (e.g. 30ms-50ms) of 16kHz PCM audio.
   */
  evaluateFrame(pcmData) {
    const rms = this.computeRms(pcmData);

    // Low energy floor cuts out digital silence and very low ambient hum
    if (rms < this.energyFloor) {
      this.consecutiveSilenceFrames++;
      if (this.consecutiveSilenceFrames >= this.hangoverFrames) {
        this.isSpeechActive = false;
      }
      return { isSpeech: this.isSpeechActive, probability: 0.05, rms };
    }

    // Zero-crossing rate & crest factor to identify transient clicks vs sustained phonemes
    let zeroCrossings = 0;
    let peak = 0;
    let sampleCount = 0;
    let sum = 0;

    if (pcmData instanceof Float32Array) {
      sampleCount = pcmData.length;
      let prevSign = Math.sign(pcmData[0]);
      for (let i = 0; i < sampleCount; i++) {
        const val = pcmData[i];
        sum += val;
        const abs = Math.abs(val);
        if (abs > peak) peak = abs;
        const sign = Math.sign(val);
        if (sign !== 0 && sign !== prevSign) {
          zeroCrossings++;
          prevSign = sign;
        }
      }
    } else if (Buffer.isBuffer(pcmData)) {
      sampleCount = Math.floor(pcmData.length / 2);
      let prevSign = Math.sign(pcmData.readInt16LE(0));
      for (let i = 0; i < sampleCount; i++) {
        const val = pcmData.readInt16LE(i * 2) / 32768.0;
        sum += val;
        const abs = Math.abs(val);
        if (abs > peak) peak = abs;
        const sign = Math.sign(val);
        if (sign !== 0 && sign !== prevSign) {
          zeroCrossings++;
          prevSign = sign;
        }
      }
    }

    if (sampleCount === 0) {
      return { isSpeech: false, probability: 0, rms: 0 };
    }

    const mean = sum / sampleCount;
    let variance = 0;
    if (pcmData instanceof Float32Array) {
      for (let i = 0; i < sampleCount; i++) {
        const diff = pcmData[i] - mean;
        variance += diff * diff;
      }
    } else if (Buffer.isBuffer(pcmData)) {
      for (let i = 0; i < sampleCount; i++) {
        const diff = (pcmData.readInt16LE(i * 2) / 32768.0) - mean;
        variance += diff * diff;
      }
    }
    variance /= sampleCount;

    // AC variance and flatline check (reject pure DC offsets and flatline signals)
    if (variance < 1e-4 || zeroCrossings === 0) {
      this.consecutiveSilenceFrames++;
      if (this.consecutiveSilenceFrames >= this.hangoverFrames) {
        this.isSpeechActive = false;
      }
      return { isSpeech: this.isSpeechActive, probability: 0.05, rms };
    }

    const zcr = sampleCount > 0 ? zeroCrossings / sampleCount : 0;
    const crestFactor = rms > 0 ? peak / rms : 0;

    // Autocorrelation across human pitch lags (80Hz - 640Hz => lag 25 - 200 at 16kHz)
    let maxCorr = 0;
    if (variance > 0 && sampleCount >= 200) {
      const maxLag = Math.min(200, Math.floor(sampleCount / 2));
      for (let lag = 25; lag <= maxLag; lag += 2) {
        let corr = 0;
        const count = sampleCount - lag;
        if (pcmData instanceof Float32Array) {
          for (let i = 0; i < count; i++) {
            corr += (pcmData[i] - mean) * (pcmData[i + lag] - mean);
          }
        } else if (Buffer.isBuffer(pcmData)) {
          for (let i = 0; i < count; i++) {
            corr += ((pcmData.readInt16LE(i * 2) / 32768.0) - mean) *
                    ((pcmData.readInt16LE((i + lag) * 2) / 32768.0) - mean);
          }
        }
        corr /= (count * variance);
        if (corr > maxCorr) maxCorr = corr;
      }
    }

    let probability;
    // Transient click detection: high crest factor or high ZCR with short duration
    if (zcr > 0.30 || crestFactor > 5.0) {
      probability = 0.15; // Click/sharp transient rejection
    } else if (zcr < 0.01) {
      probability = 0.05; // Too low for voiced speech (sub-audible rumble or near-DC)
    } else if (rms > 0.05 && zcr < 0.18 && maxCorr >= 0.60) {
      probability = 0.92; // Solid human speech band with pitch periodicity
    } else if (rms > 0.05 && (zcr >= 0.18 || maxCorr < 0.45)) {
      // Broadband ambient noise (e.g. pink noise, HVAC, fan noise) lacking pitch periodicity
      probability = 0.20;
    } else if (maxCorr >= 0.60 && zcr < 0.25) {
      probability = Math.min(0.85, Math.max(0.2, rms * 10));
    } else {
      probability = Math.min(0.35, Math.max(0.05, rms * 5));
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

/**
 * Main Silero VAD Engine implementing ONNX Runtime Web Wasm inference
 * with hysteresis state machine and acoustic fallback.
 */
class SileroVadEngine {
  constructor(options = {}) {
    this.modelPath = options.modelPath || '../../assets/vad/silero_vad.onnx';
    this.wasmPath = options.wasmPath || '../../assets/vad/';
    this.sampleRate = 16000;
    this.frameSamples = 512; // 32ms at 16kHz

    // Probability thresholds
    this.positiveSpeechThreshold = options.positiveSpeechThreshold ?? 0.5;
    this.negativeSpeechThreshold = options.negativeSpeechThreshold ?? 0.35;

    // Minimum consecutive frames to confirm speech onset (3 frames = 96ms)
    // Effectively rejects mouse clicks, mechanical keyboard taps, and throat clearing
    this.minSpeechFrames = options.minSpeechFrames ?? 3;

    // Rolling circular pre-speech buffer in frames (8 frames = 256ms)
    // Captures soft unvoiced consonants before speech threshold triggers
    this.preSpeechFrames = options.preSpeechFrames ?? 8;

    // Hangover duration in frames (15 frames = 480ms)
    // Bridges natural inter-word pauses without fragmenting the utterance
    this.hangoverFrames = options.hangoverFrames ?? 15;

    // ONNX Runtime session & architecture
    this.session = null;
    this.isModelV5 = false;
    this.ready = false;

    // Silero v4 states: h [2, 1, 64], c [2, 1, 64]
    this.h = new Float32Array(2 * 1 * 64);
    this.c = new Float32Array(2 * 1 * 64);

    // Silero v5 states: state [2, 1, 128], context [64]
    this.stateV5 = new Float32Array(2 * 1 * 128);
    this.contextV5 = new Float32Array(64);

    this.srTensor = null;

    // Session tracking
    this.isSpeechActive = false;
    this.consecutiveSpeechFrames = 0;
    this.hangoverRemaining = 0;
    this.totalSpeechFrames = 0;
    this.totalFramesProcessed = 0;

    this.preSpeechBuffer = [];
    this.capturedFrames = [];

    // Fallback evaluator when Wasm is unavailable
    this.fallbackEvaluator = new VadEvaluator({
      speechThreshold: this.positiveSpeechThreshold,
      hangoverFrames: this.hangoverFrames,
    });
  }

  /**
   * Initializes the ONNX session and warms up weights before user speech.
   */
  async init() {
    if (this.ready) return;

    if (typeof ort === 'undefined') {
      console.warn('[VAD] ONNX Runtime (ort) is not defined; using local acoustic evaluator fallback.');
      this.ready = true;
      return;
    }

    try {
      if (ort.env && ort.env.wasm) {
        ort.env.wasm.wasmPaths = this.wasmPath;
        ort.env.wasm.numThreads = 1;
      }

      this.session = await ort.InferenceSession.create(this.modelPath, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      });

      const inputNames = this.session.inputNames;
      this.isModelV5 = inputNames.includes('state');

      this.srTensor = new ort.Tensor('int64', new BigInt64Array([BigInt(this.sampleRate)]), [1]);

      // Warm up inference with a silent frame
      const blank = new Float32Array(this.frameSamples);
      await this.runInference(blank);
      this.resetStates();

      this.ready = true;
      console.log('[VAD] Silero VAD ONNX session initialized successfully (version:', this.isModelV5 ? 'v5' : 'v4', ')');
    } catch (err) {
      console.warn('[VAD] Failed to initialize ONNX session:', err.message, '- falling back to acoustic evaluator.');
      this.ready = true;
    }
  }

  /**
   * Resets recurrent state tensors and buffers for a new utterance session.
   */
  resetStates() {
    this.h.fill(0);
    this.c.fill(0);
    this.stateV5.fill(0);
    this.contextV5.fill(0);

    this.isSpeechActive = false;
    this.consecutiveSpeechFrames = 0;
    this.hangoverRemaining = 0;
    this.totalSpeechFrames = 0;
    this.totalFramesProcessed = 0;

    this.preSpeechBuffer = [];
    this.capturedFrames = [];

    this.fallbackEvaluator = new VadEvaluator({
      speechThreshold: this.positiveSpeechThreshold,
      hangoverFrames: this.hangoverFrames,
    });
  }

  /**
   * Evaluates a single 512-sample Float32 frame through ONNX or fallback.
   */
  async runInference(frame512) {
    if (!this.session) {
      const evalResult = this.fallbackEvaluator.evaluateFrame(frame512);
      return evalResult.probability;
    }

    try {
      if (this.isModelV5) {
        const frameWithContext = new Float32Array(64 + 512);
        frameWithContext.set(this.contextV5, 0);
        frameWithContext.set(frame512, 64);

        const feeds = {
          input: new ort.Tensor('float32', frameWithContext, [1, 576]),
          state: new ort.Tensor('float32', this.stateV5, [2, 1, 128]),
        };
        if (this.session.inputNames.includes('sr')) {
          feeds.sr = this.srTensor;
        }

        const results = await this.session.run(feeds);
        this.contextV5.set(frame512.subarray(512 - 64));

        const stateName = this.session.outputNames.find(n => n.includes('state')) || this.session.outputNames[1];
        if (stateName && results[stateName]) {
          this.stateV5.set(results[stateName].data);
        }

        const probName = this.session.outputNames[0];
        return results[probName].data[0];
      } else {
        const feeds = {
          input: new ort.Tensor('float32', frame512, [1, 512]),
          sr: this.srTensor,
          h: new ort.Tensor('float32', this.h, [2, 1, 64]),
          c: new ort.Tensor('float32', this.c, [2, 1, 64]),
        };

        const results = await this.session.run(feeds);
        const probName = this.session.outputNames[0];
        const hnName = this.session.outputNames[1] || 'hn';
        const cnName = this.session.outputNames[2] || 'cn';

        if (results[hnName]) this.h.set(results[hnName].data);
        if (results[cnName]) this.c.set(results[cnName].data);

        return results[probName].data[0];
      }
    } catch (err) {
      console.warn('[VAD] Inference exception, using acoustic fallback:', err.message);
      return this.fallbackEvaluator.evaluateFrame(frame512).probability;
    }
  }

  /**
   * Processes a 512-sample frame and updates hysteresis state machine.
   */
  async processFrame(frame512) {
    this.totalFramesProcessed++;
    const prob = await this.runInference(frame512);

    if (prob >= this.positiveSpeechThreshold) {
      this.consecutiveSpeechFrames++;

      if (!this.isSpeechActive && this.consecutiveSpeechFrames >= this.minSpeechFrames) {
        // Speech confirmed: flush pre-speech buffer so onset consonants are intact
        this.isSpeechActive = true;
        for (const pre of this.preSpeechBuffer) {
          this.capturedFrames.push(pre);
        }
        this.preSpeechBuffer = [];
      }

      if (this.isSpeechActive) {
        this.capturedFrames.push(new Float32Array(frame512));
        this.hangoverRemaining = this.hangoverFrames;
        this.totalSpeechFrames++;
      }
    } else if (prob < this.negativeSpeechThreshold) {
      this.consecutiveSpeechFrames = 0;

      if (this.isSpeechActive) {
        if (this.hangoverRemaining > 0) {
          // Keep trailing pause frames within hangover budget
          this.capturedFrames.push(new Float32Array(frame512));
          this.hangoverRemaining--;
        } else {
          this.isSpeechActive = false;
        }
      } else {
        // Rolling pre-speech circular buffer
        this.preSpeechBuffer.push(new Float32Array(frame512));
        if (this.preSpeechBuffer.length > this.preSpeechFrames) {
          this.preSpeechBuffer.shift();
        }
      }
    } else {
      // Hysteresis middle band
      if (this.isSpeechActive) {
        this.capturedFrames.push(new Float32Array(frame512));
        if (this.hangoverRemaining > 0) this.hangoverRemaining--;
      }
    }

    return {
      probability: prob,
      isSpeechActive: this.isSpeechActive,
      totalSpeechFrames: this.totalSpeechFrames,
    };
  }

  /**
   * Returns captured audio as a contiguous Float32Array, or null if rejected.
   */
  getProcessedAudio() {
    if (this.totalSpeechFrames < this.minSpeechFrames || this.capturedFrames.length === 0) {
      return null;
    }

    const totalSamples = this.capturedFrames.reduce((acc, f) => acc + f.length, 0);
    const result = new Float32Array(totalSamples);
    let offset = 0;
    for (const frame of this.capturedFrames) {
      result.set(frame, offset);
      offset += frame.length;
    }
    return result;
  }
}

if (typeof window !== 'undefined') {
  window.SileroVadEngine = SileroVadEngine;
  window.VadEvaluator = VadEvaluator;
}

if (typeof module !== 'undefined') {
  module.exports = { SileroVadEngine, VadEvaluator };
}
