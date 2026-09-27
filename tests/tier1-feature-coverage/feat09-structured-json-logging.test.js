// Tier 1 - Feature 09: Structured JSON Logging with Daily Rotation
// Verifies structured NDJSON log serialization, mandatory fields, daily file rotation, and log levels.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

class StructuredJsonLogger {
  constructor(options = {}) {
    this.logDir = options.logDir || path.join(os.tmpdir(), 'wispr-tell-test-logs-' + Math.random().toString(36).substring(2, 7));
    this.retentionDays = options.retentionDays || 7;
    if (!fs.existsSync(this.logDir)) fs.mkdirSync(this.logDir, { recursive: true });
  }

  getLogFileName(date = new Date()) {
    const yyyy = date.getUTCFullYear();
    const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(date.getUTCDate()).padStart(2, '0');
    return `wispr-tell-${yyyy}-${mm}-${dd}.log`;
  }

  log(level, category, message, metadata = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      level: level.toLowerCase(),
      category,
      message,
      metadata
    };

    const filePath = path.join(this.logDir, this.getLogFileName());
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf8');
    return entry;
  }

  readEntries(date = new Date()) {
    const filePath = path.join(this.logDir, this.getLogFileName(date));
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line));
  }

  pruneOldLogs(currentDate = new Date()) {
    const cutoffTime = currentDate.getTime() - (this.retentionDays * 24 * 60 * 60 * 1000);
    const files = fs.readdirSync(this.logDir);
    const deletedFiles = [];

    for (const file of files) {
      const match = file.match(/^wispr-tell-(\d{4})-(\d{2})-(\d{2})\.log$/);
      if (match) {
        const fileDate = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
        if (fileDate.getTime() < cutoffTime) {
          fs.unlinkSync(path.join(this.logDir, file));
          deletedFiles.push(file);
        }
      }
    }
    return deletedFiles;
  }

  cleanup() {
    try {
      if (fs.existsSync(this.logDir)) {
        fs.rmSync(this.logDir, { recursive: true, force: true });
      }
    } catch {}
  }
}

describe('Tier 1 - Feature 09: Structured JSON Logging with Daily Rotation', () => {
  it('TC-T1-F09-01: serializes log events as single-line JSON with required schema fields', () => {
    const logger = new StructuredJsonLogger();
    try {
      const entry = logger.log('INFO', 'transcription', 'Speech decoded successfully', { durationMs: 1200, words: 14 });

      assert.ok(entry.timestamp);
      assert.strictEqual(entry.level, 'info');
      assert.strictEqual(entry.category, 'transcription');
      assert.strictEqual(entry.message, 'Speech decoded successfully');
      assert.strictEqual(entry.metadata.durationMs, 1200);

      const entries = logger.readEntries();
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].message, 'Speech decoded successfully');
    } finally {
      logger.cleanup();
    }
  });

  it('TC-T1-F09-02: formats log file name daily with wispr-tell-YYYY-MM-DD.log pattern', () => {
    const logger = new StructuredJsonLogger();
    try {
      const testDate = new Date('2026-09-27T04:00:00Z');
      const filename = logger.getLogFileName(testDate);
      assert.strictEqual(filename, 'wispr-tell-2026-09-27.log');
    } finally {
      logger.cleanup();
    }
  });

  it('TC-T1-F09-03: supports standard logging levels (debug, info, warn, error)', () => {
    const logger = new StructuredJsonLogger();
    try {
      logger.log('DEBUG', 'vad', 'VAD evaluated frame', { probability: 0.12 });
      logger.log('INFO', 'groq', 'Connection established');
      logger.log('WARN', 'groq', 'Received HTTP 429 backoff required');
      logger.log('ERROR', 'whisper', 'Process exited with non-zero code');

      const entries = logger.readEntries();
      assert.strictEqual(entries.length, 4);
      assert.strictEqual(entries[0].level, 'debug');
      assert.strictEqual(entries[1].level, 'info');
      assert.strictEqual(entries[2].level, 'warn');
      assert.strictEqual(entries[3].level, 'error');
    } finally {
      logger.cleanup();
    }
  });

  it('TC-T1-F09-04: appends sequential log lines in newline-delimited format (ndjson)', () => {
    const logger = new StructuredJsonLogger();
    try {
      for (let i = 0; i < 5; i++) {
        logger.log('INFO', 'hotkey', `Key pressed iteration ${i}`);
      }

      const rawContent = fs.readFileSync(path.join(logger.logDir, logger.getLogFileName()), 'utf8');
      const lines = rawContent.trim().split('\n');
      assert.strictEqual(lines.length, 5);
      lines.forEach(line => {
        assert.doesNotThrow(() => JSON.parse(line));
      });
    } finally {
      logger.cleanup();
    }
  });

  it('TC-T1-F09-05: automatically prunes log files older than retention policy (7 days)', () => {
    const logger = new StructuredJsonLogger({ retentionDays: 7 });
    try {
      // Create a 10-day-old log file
      const oldDate = new Date('2026-09-17T00:00:00Z');
      const oldFilename = logger.getLogFileName(oldDate);
      fs.writeFileSync(path.join(logger.logDir, oldFilename), '{"message":"ancient log"}\n');

      // Create a today log file
      const todayDate = new Date('2026-09-27T00:00:00Z');
      const todayFilename = logger.getLogFileName(todayDate);
      fs.writeFileSync(path.join(logger.logDir, todayFilename), '{"message":"fresh log"}\n');

      const pruned = logger.pruneOldLogs(todayDate);
      assert.strictEqual(pruned.length, 1);
      assert.strictEqual(pruned[0], oldFilename);
      assert.strictEqual(fs.existsSync(path.join(logger.logDir, oldFilename)), false);
      assert.strictEqual(fs.existsSync(path.join(logger.logDir, todayFilename)), true);
    } finally {
      logger.cleanup();
    }
  });
});
