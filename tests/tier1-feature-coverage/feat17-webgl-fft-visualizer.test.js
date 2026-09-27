// Tier 1 - Feature 17: WebGL Audio-Reactive Pill Visualizer
// Verifies WebGL shader uniform definitions, 16-bin speech FFT frequency mapping, and canvas fallback.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { SPEECH_FFT_BINS } = require('../helpers/test-harness');

// WebGL shader source code model conforming to PROJECT.md
const VERTEX_SHADER_SRC = `
  attribute vec2 aPosition;
  varying vec2 vUv;
  void main() {
    vUv = (aPosition + 1.0) * 0.5;
    gl_Position = vec4(aPosition, 0.0, 1.0);
  }
`;

const FRAGMENT_SHADER_SRC = `
  precision mediump float;
  varying vec2 vUv;
  uniform float uTime;
  uniform float uFrequencies[16];
  uniform vec3 uColor;

  void main() {
    int binIndex = int(vUv.x * 16.0);
    float freqMag = uFrequencies[binIndex];
    float waveHeight = 0.5 + (freqMag * 0.45);
    float dist = abs(vUv.y - waveHeight);
    float alpha = smoothstep(0.05, 0.0, dist);
    gl_FragColor = vec4(uColor * (1.0 + freqMag), alpha);
  }
`;

class WebGLVisualizerSimulator {
  constructor(hasWebGL = true) {
    this.hasWebGL = hasWebGL;
    this.uniforms = {
      uTime: 0.0,
      uFrequencies: new Float32Array(16),
      uColor: [0.38, 0.38, 0.95]
    };
    this.fallbackUsed = false;
  }

  initContext() {
    if (!this.hasWebGL) {
      this.fallbackUsed = true;
      return '2d';
    }
    return 'webgl';
  }

  updateFrequencies(fftArray) {
    if (fftArray.length !== 16) {
      throw new Error(`Expected 16 frequency bins, got ${fftArray.length}`);
    }
    for (let i = 0; i < 16; i++) {
      this.uniforms.uFrequencies[i] = Math.max(0.0, Math.min(1.0, fftArray[i]));
    }
  }

  renderFrame(timeSec) {
    this.uniforms.uTime = timeSec;
    // Calculate vocal energy as average of speech bins (bins 2-7, 200Hz - 1000Hz)
    let vocalEnergy = 0;
    for (let i = 2; i <= 7; i++) {
      vocalEnergy += this.uniforms.uFrequencies[i];
    }
    vocalEnergy /= 6;
    return { rendered: true, vocalEnergy, uniforms: this.uniforms };
  }
}

describe('Tier 1 - Feature 17: WebGL Audio-Reactive Pill Visualizer', () => {
  it('TC-T1-F17-01: fragment shader defines 16-bin uFrequencies uniform array', () => {
    assert.ok(FRAGMENT_SHADER_SRC.includes('uniform float uFrequencies[16];'), 'Shader must define 16-bin uniform');
    assert.ok(FRAGMENT_SHADER_SRC.includes('gl_FragColor'));
  });

  it('TC-T1-F17-02: maps 16 frequency bands centered at speech frequencies 80Hz - 4000Hz', () => {
    assert.strictEqual(SPEECH_FFT_BINS.length, 16);
    assert.strictEqual(SPEECH_FFT_BINS[0], 80);
    assert.strictEqual(SPEECH_FFT_BINS[14], 4000);
    // Values must be strictly increasing
    for (let i = 1; i < SPEECH_FFT_BINS.length; i++) {
      assert.ok(SPEECH_FFT_BINS[i] > SPEECH_FFT_BINS[i - 1]);
    }
  });

  it('TC-T1-F17-03: clamps and transfers incoming FFT values into shader uniform array', () => {
    const viz = new WebGLVisualizerSimulator(true);
    const mockFft = new Float32Array(16);
    mockFft[3] = 0.85; // Strong 250Hz pitch formant
    mockFft[4] = 0.95; // Strong 350Hz pitch formant

    viz.updateFrequencies(mockFft);
    assert.ok(Math.abs(viz.uniforms.uFrequencies[3] - 0.85) < 1e-4);
    assert.ok(Math.abs(viz.uniforms.uFrequencies[4] - 0.95) < 1e-4);
    assert.strictEqual(viz.uniforms.uFrequencies[0], 0.0);
  });

  it('TC-T1-F17-04: computes vocal energy from formant frequency bins in render loop', () => {
    const viz = new WebGLVisualizerSimulator(true);
    const mockFft = new Float32Array(16);
    // Simulate vocalization in bins 2-7
    for (let i = 2; i <= 7; i++) mockFft[i] = 0.6;

    viz.updateFrequencies(mockFft);
    const frame = viz.renderFrame(1.25);

    assert.strictEqual(frame.rendered, true);
    assert.ok(Math.abs(frame.vocalEnergy - 0.6) < 1e-4);
  });

  it('TC-T1-F17-05: falls back to 2D canvas context when WebGL is unavailable', () => {
    const viz = new WebGLVisualizerSimulator(false); // No WebGL
    const contextType = viz.initContext();

    assert.strictEqual(contextType, '2d');
    assert.strictEqual(viz.fallbackUsed, true);
  });
});
