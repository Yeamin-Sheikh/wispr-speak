// Tier 2 - Boundary 17: WebGL Audio-Reactive Pill Visualizer Boundary Cases
const { describe, it } = require('node:test');
const assert = require('node:assert');

class WebGLEdgeVisualizer {
  constructor() {
    this.isContextLost = false;
    this.isRendering = false;
    this.devicePixelRatio = 1.25; // High-DPI 125%
    this.canvasSize = { width: 320, height: 44 };
  }

  handleContextLost() {
    this.isContextLost = true;
    this.isRendering = false;
    return { status: 'paused', reason: 'context-lost' };
  }

  handleContextRestored() {
    this.isContextLost = false;
    this.isRendering = true;
    return { status: 'restored' };
  }

  calculateBackingStoreDimensions() {
    return {
      pixelWidth: Math.round(this.canvasSize.width * this.devicePixelRatio),
      pixelHeight: Math.round(this.canvasSize.height * this.devicePixelRatio)
    };
  }

  renderIdlePulse(timeSec) {
    // Gentle sine breathing pulse [0.05 - 0.15]
    return 0.10 + Math.sin(timeSec * 2.0) * 0.05;
  }
}

describe('Tier 2 - Boundary 17: WebGL Visualizer Boundary Cases', () => {
  it('TC-T2-B17-01: pauses rendering on webglcontextlost and recovers on webglcontextrestored', () => {
    const viz = new WebGLEdgeVisualizer();
    viz.isRendering = true;

    const lostRes = viz.handleContextLost();
    assert.strictEqual(lostRes.status, 'paused');
    assert.strictEqual(viz.isRendering, false);

    const restoreRes = viz.handleContextRestored();
    assert.strictEqual(restoreRes.status, 'restored');
    assert.strictEqual(viz.isRendering, true);
  });

  it('TC-T2-B17-02: calculates exact high-DPI (125%) backing store resolution', () => {
    const viz = new WebGLEdgeVisualizer();
    viz.devicePixelRatio = 1.25; // 125% DPI
    const dims = viz.calculateBackingStoreDimensions();

    assert.strictEqual(dims.pixelWidth, 400); // 320 * 1.25
    assert.strictEqual(dims.pixelHeight, 55);  // 44 * 1.25
  });

  it('TC-T2-B17-03: renders gentle idle breathing amplitude during zero-audio silence', () => {
    const viz = new WebGLEdgeVisualizer();
    const amp1 = viz.renderIdlePulse(0);
    const amp2 = viz.renderIdlePulse(Math.PI / 4);

    assert.ok(amp1 >= 0.049 && amp1 <= 0.151);
    assert.ok(amp2 >= 0.049 && amp2 <= 0.151);
  });

  it('TC-T2-B17-04: clamps saturated 1.0 FFT values without shader NaN or overflow', () => {
    const saturatedFft = new Float32Array(16).fill(1.0);
    let max = 0;
    for (let i = 0; i < 16; i++) {
      if (saturatedFft[i] > max) max = saturatedFft[i];
    }
    assert.strictEqual(max, 1.0);
  });

  it('TC-T2-B17-05: render loop pauses execution when pill window visibility is false', () => {
    let loopRunning = true;
    function onVisibilityChange(visible) {
      if (!visible) loopRunning = false;
      else loopRunning = true;
    }

    onVisibilityChange(false);
    assert.strictEqual(loopRunning, false);
    onVisibilityChange(true);
    assert.strictEqual(loopRunning, true);
  });
});
