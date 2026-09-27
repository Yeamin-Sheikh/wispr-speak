// Test harness providing timing, assertion helpers, and specification models.
const assert = require('assert');

// Measure execution time of async functions
async function measureMs(fn) {
  const start = process.hrtime.bigint();
  const result = await fn();
  const end = process.hrtime.bigint();
  const durationMs = Number(end - start) / 1e6;
  return { durationMs, result };
}

// Spring physics simulation equation per PROJECT.md:
// a = -k*(x - target) - c*v
// Returns next { x, v, a }
function simulateSpringStep({ currentX, velocity, targetX, k = 180, c = 12, mass = 1, dt = 0.016 }) {
  const displacement = currentX - targetX;
  const springForce = -k * displacement;
  const dampingForce = -c * velocity;
  const acceleration = (springForce + dampingForce) / mass;
  const nextVelocity = velocity + acceleration * dt;
  const nextX = currentX + nextVelocity * dt;
  return { x: nextX, v: nextVelocity, a: acceleration };
}

// Exponential backoff calculation per PROJECT.md:
// Math.min(8000, 500 * Math.pow(2, attempt) + Math.random() * 300)
function computeBackoffMs(attempt, randomJitter = 150) {
  return Math.min(8000, 500 * Math.pow(2, attempt) + randomJitter);
}

// VAD Energy Calculator (RMS amplitude)
function computeAudioRms(buffer) {
  let sum = 0;
  const sampleCount = Math.floor(buffer.length / 2);
  for (let i = 0; i < sampleCount; i++) {
    const sample = buffer.readInt16LE(i * 2) / 32768.0;
    sum += sample * sample;
  }
  return Math.sqrt(sum / sampleCount);
}

// 16-bin FFT frequency centers for speech (80Hz to 4000Hz)
const SPEECH_FFT_BINS = [
  80, 120, 180, 250, 350, 500, 700, 950,
  1250, 1600, 2000, 2500, 3000, 3500, 4000, 4500
];

module.exports = {
  assert,
  measureMs,
  simulateSpringStep,
  computeBackoffMs,
  computeAudioRms,
  SPEECH_FFT_BINS,
};
