// Audio generator utility for synthesizing test audio buffers (16kHz 16-bit mono PCM/WAV).
// Provides deterministic speech-like signals, silence, clicks, and noise profiles.

function createWavHeader(dataLength, sampleRate = 16000, numChannels = 1, bitsPerSample = 16) {
  const buffer = Buffer.alloc(44);
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);

  // RIFF identifier
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataLength, 4);
  buffer.write('WAVE', 8);

  // 'fmt ' chunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // Subchunk1Size for PCM
  buffer.writeUInt16LE(1, 20);  // AudioFormat 1 = PCM
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  // 'data' chunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataLength, 40);

  return buffer;
}

function generateSilenceWav(durationSeconds = 1, sampleRate = 16000) {
  const numSamples = Math.floor(sampleRate * durationSeconds);
  const dataLength = numSamples * 2;
  const header = createWavHeader(dataLength, sampleRate);
  const data = Buffer.alloc(dataLength); // all zeros = silence
  return Buffer.concat([header, data]);
}

function generateSpeechToneWav(durationSeconds = 1, fundamentalFreq = 220, sampleRate = 16000, amplitude = 0.5) {
  const numSamples = Math.floor(sampleRate * durationSeconds);
  const dataLength = numSamples * 2;
  const header = createWavHeader(dataLength, sampleRate);
  const data = Buffer.alloc(dataLength);

  const maxVal = 32767 * amplitude;
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    // Harmonic mixture characteristic of human vowel formants (F0 + harmonics)
    const sample = (
      Math.sin(2 * Math.PI * fundamentalFreq * t) * 0.6 +
      Math.sin(2 * Math.PI * (fundamentalFreq * 2) * t) * 0.3 +
      Math.sin(2 * Math.PI * (fundamentalFreq * 3) * t) * 0.1
    ) * maxVal;
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.floor(sample))), i * 2);
  }

  return Buffer.concat([header, data]);
}

function generateKeyboardClickWav(sampleRate = 16000) {
  // A sharp transient click: 5ms sharp impulse decaying rapidly
  const durationSeconds = 0.05;
  const numSamples = Math.floor(sampleRate * durationSeconds);
  const dataLength = numSamples * 2;
  const header = createWavHeader(dataLength, sampleRate);
  const data = Buffer.alloc(dataLength);

  for (let i = 0; i < numSamples; i++) {
    // Fast exponential decay of a high frequency pulse
    const decay = Math.exp(-i / (sampleRate * 0.003));
    const sample = Math.sin(2 * Math.PI * 3500 * (i / sampleRate)) * decay * 20000;
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.floor(sample))), i * 2);
  }

  return Buffer.concat([header, data]);
}

function generatePinkNoiseWav(durationSeconds = 1, sampleRate = 16000, amplitude = 0.05) {
  const numSamples = Math.floor(sampleRate * durationSeconds);
  const dataLength = numSamples * 2;
  const header = createWavHeader(dataLength, sampleRate);
  const data = Buffer.alloc(dataLength);

  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < numSamples; i++) {
    const white = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.96900 * b2 + white * 0.1538520;
    b3 = 0.86650 * b3 + white * 0.3104856;
    b4 = 0.55000 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.0168980;
    const pink = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
    b6 = white * 0.115926;
    const sample = pink * amplitude * 32767;
    data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.floor(sample))), i * 2);
  }

  return Buffer.concat([header, data]);
}

function generateCorruptedWav(size = 500) {
  const buf = Buffer.alloc(size);
  // Fill with random garbage
  for (let i = 0; i < size; i++) {
    buf[i] = Math.floor(Math.random() * 256);
  }
  return buf;
}

module.exports = {
  createWavHeader,
  generateSilenceWav,
  generateSpeechToneWav,
  generateKeyboardClickWav,
  generatePinkNoiseWav,
  generateCorruptedWav,
};
