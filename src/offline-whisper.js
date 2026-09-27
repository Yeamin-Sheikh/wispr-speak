/**
 * src/offline-whisper.js
 * Standalone offline speech-to-text fallback engine using bundled whisper.cpp.
 *
 * Provides offline transcription when internet connectivity drops,
 * Groq API rate limits are exhausted, or DNS resolution fails.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

/**
 * Resolves paths across development and packaged Electron environments.
 * Handles both unpacked directories and asar.unpacked folder structures.
 */
function resolveAssetPath(subpath) {
  // 1. Direct relative path from source tree in development
  const devPath = path.resolve(__dirname, '..', subpath);
  if (fs.existsSync(devPath)) return devPath;

  // 2. Electron packaged resources unpacked directory
  if (process.resourcesPath) {
    const unpackedPath = path.join(process.resourcesPath, 'app.asar.unpacked', subpath);
    if (fs.existsSync(unpackedPath)) return unpackedPath;

    const resourcesPath = path.join(process.resourcesPath, subpath);
    if (fs.existsSync(resourcesPath)) return resourcesPath;

    const appPath = path.join(process.resourcesPath, 'app', subpath);
    if (fs.existsSync(appPath)) return appPath;
  }

  return devPath;
}

class WhisperLocalEngine {
  constructor(options = {}) {
    this.cliPath = options.cliPath || resolveAssetPath(path.join('bin', 'native', 'whisper-cli.exe'));
    this.modelPath = options.modelPath || resolveAssetPath(path.join('bin', 'models', 'ggml-tiny.en.bin'));
    this.timeoutMs = options.timeoutMs || 25000;
    this.threadCount = options.threadCount || 4;
    this.spawnFn = options.spawnFn || null; // Injection point for mock testing
    this.lastCommand = null;
    this.isOfflineNotified = false;
  }

  /**
   * Checks whether the required standalone executable and ggml model exist on disk.
   */
  isAvailable() {
    return fs.existsSync(this.cliPath) && fs.existsSync(this.modelPath);
  }

  /**
   * Transcribes a 16kHz mono 16-bit PCM WAV buffer locally.
   *
   * @param {Buffer} wavBuffer - Complete WAV audio buffer with 44-byte RIFF header
   * @returns {Promise<string>} - Cleaned transcription text
   */
  async transcribeLocal(wavBuffer, options = {}) {
    if (!wavBuffer || wavBuffer.length === 0) {
      throw new Error('Empty WAV buffer provided for offline transcription');
    }

    if (!fs.existsSync(this.modelPath)) {
      throw new Error(`Model file not found: ${this.modelPath}`);
    }

    if (!fs.existsSync(this.cliPath)) {
      throw new Error(`Whisper executable not found: ${this.cliPath}`);
    }

    // Set offline notification flag for pill status indicator
    this.isOfflineNotified = true;

    // Generate unique collision-free temporary file path in system temp folder
    const tempId = `wispr-temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const tempWavPath = path.join(os.tmpdir(), `${tempId}.wav`);

    // Write audio buffer to disk for whisper-cli consumption
    fs.writeFileSync(tempWavPath, wavBuffer);

    // Command-line arguments adhering to PROJECT.md interface contract
    const args = [
      '-m', this.modelPath,
      '-f', tempWavPath,
      '-nt',
      '-t', String(this.threadCount),
    ];

    if (options && options.prompt) {
      const sanitizedPrompt = String(options.prompt).replace(/["\r\n]/g, '').trim();
      if (sanitizedPrompt.length > 0) {
        args.push('--prompt', sanitizedPrompt);
      }
    }

    this.lastCommand = {
      exe: this.cliPath,
      args,
      tempWavPath,
    };

    let rawOutput = '';

    try {
      if (this.spawnFn) {
        // Test hook for unit testing without binary invocation
        rawOutput = await this.spawnFn(this.cliPath, args);
      } else {
        // Production native execution
        rawOutput = await new Promise((resolve, reject) => {
          const child = spawn(this.cliPath, args, { windowsHide: true });
          let stdoutText = '';
          let stderrText = '';
          let isTimedOut = false;
          let emergencyTimer = null;

          // Watchdog timer terminates hanging process to prevent memory leaks or deadlocks
          const timer = setTimeout(() => {
            isTimedOut = true;
            try { child.kill('SIGKILL'); } catch {}
            emergencyTimer = setTimeout(() => {
              reject(new Error(`Local whisper process timed out after ${this.timeoutMs}ms`));
            }, 2000);
          }, this.timeoutMs);

          child.stdout.on('data', chunk => {
            stdoutText += chunk.toString('utf8');
          });

          child.stderr.on('data', chunk => {
            stderrText += chunk.toString('utf8');
          });

          child.on('error', err => {
            clearTimeout(timer);
            if (emergencyTimer) clearTimeout(emergencyTimer);
            reject(err);
          });

          child.on('close', code => {
            clearTimeout(timer);
            if (emergencyTimer) clearTimeout(emergencyTimer);
            if (isTimedOut) {
              reject(new Error(`Local whisper process timed out after ${this.timeoutMs}ms`));
            } else if (code === 0) {
              resolve(stdoutText);
            } else {
              reject(new Error(`Whisper process exited with code ${code}: ${stderrText.slice(0, 200)}`));
            }
          });
        });
      }
    } finally {
      // Guaranteed cleanup of temporary WAV file even if execution failed
      if (fs.existsSync(tempWavPath)) {
        try {
          fs.unlinkSync(tempWavPath);
        } catch {}
      }
    }

    // Strip timestamp annotations like [00:00:00.000 --> 00:00:02.000] and trim whitespace
    const cleaned = (rawOutput || '')
      .replace(/\[\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3}\]/g, '')
      .trim();

    return cleaned;
  }
}

module.exports = {
  WhisperLocalEngine,
  resolveAssetPath,
};
