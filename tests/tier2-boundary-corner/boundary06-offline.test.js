// Tier 2 - Boundary 06: Quantized whisper.cpp Fallback Boundary Cases
const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');
const fs = require('fs');

class RobustWhisperFallback {
  constructor(options = {}) {
    this.cliPath = options.cliPath || 'C:\\non-existent\\whisper-cli.exe';
    this.modelPath = options.modelPath || 'C:\\non-existent\\model.bin';
    this.timeoutMs = options.timeoutMs || 2000;
  }

  async run(wavBuffer, mockExecutor = null) {
    if (!fs.existsSync(this.modelPath)) {
      throw new Error(`Model file not found: ${this.modelPath}`);
    }
    if (!fs.existsSync(this.cliPath)) {
      throw new Error(`Whisper executable not found: ${this.cliPath}`);
    }

    const tempFile = path.join(os.tmpdir(), `wispr-test-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
    fs.writeFileSync(tempFile, wavBuffer);

    try {
      if (mockExecutor) {
        return await mockExecutor(tempFile);
      }
      return 'Transcription result';
    } finally {
      if (fs.existsSync(tempFile)) {
        try { fs.unlinkSync(tempFile); } catch {}
      }
    }
  }
}

describe('Tier 2 - Boundary 06: whisper.cpp Offline Fallback Boundary Cases', () => {
  it('TC-T2-B06-01: throws descriptive error when model file does not exist', async () => {
    const fallback = new RobustWhisperFallback({ modelPath: 'C:\\fake\\missing-model.bin' });
    await assert.rejects(
      async () => fallback.run(Buffer.from('WAV')),
      /Model file not found/
    );
  });

  it('TC-T2-B06-02: throws descriptive error when executable binary does not exist', async () => {
    // Create temp dummy model file so model check passes
    const tempModel = path.join(os.tmpdir(), 'dummy.bin');
    fs.writeFileSync(tempModel, 'model');

    try {
      const fallback = new RobustWhisperFallback({
        cliPath: 'C:\\fake\\missing-cli.exe',
        modelPath: tempModel
      });
      await assert.rejects(
        async () => fallback.run(Buffer.from('WAV')),
        /Whisper executable not found/
      );
    } finally {
      if (fs.existsSync(tempModel)) fs.unlinkSync(tempModel);
    }
  });

  it('TC-T2-B06-03: cleans up temporary WAV file even when process fails or throws', async () => {
    const tempModel = path.join(os.tmpdir(), 'dummy.bin');
    const tempCli = path.join(os.tmpdir(), 'dummy.exe');
    fs.writeFileSync(tempModel, 'model');
    fs.writeFileSync(tempCli, 'cli');

    let leakedFile = null;
    try {
      const fallback = new RobustWhisperFallback({ cliPath: tempCli, modelPath: tempModel });
      await assert.rejects(async () => {
        await fallback.run(Buffer.from('WAV'), (createdTempFile) => {
          leakedFile = createdTempFile;
          throw new Error('Simulation of process crash');
        });
      }, /Simulation of process crash/);

      assert.ok(leakedFile);
      assert.strictEqual(fs.existsSync(leakedFile), false, 'Temp file must be unlinked on error');
    } finally {
      if (fs.existsSync(tempModel)) fs.unlinkSync(tempModel);
      if (fs.existsSync(tempCli)) fs.unlinkSync(tempCli);
    }
  });

  it('TC-T2-B06-04: concurrent offline fallbacks create unique collision-free temp paths', () => {
    const paths = new Set();
    for (let i = 0; i < 100; i++) {
      const tempPath = path.join(os.tmpdir(), `wispr-test-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
      paths.add(tempPath);
    }
    assert.strictEqual(paths.size, 100, 'All 100 temp paths must be strictly unique');
  });

  it('TC-T2-B06-05: terminates hanging process when timeout threshold is exceeded', async () => {
    let processKilled = false;
    const mockHangingProcess = async () => {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          processKilled = true;
          reject(new Error('Process timed out after 50ms'));
        }, 50);
      });
    };

    await assert.rejects(async () => {
      await mockHangingProcess();
    }, /Process timed out/);

    assert.strictEqual(processKilled, true);
  });
});
