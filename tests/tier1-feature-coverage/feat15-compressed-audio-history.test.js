// Tier 1 - Feature 15: Compressed Audio History & Playback
// Verifies saving Opus/WebM audio, linking to history entries, audio playback retrieval, and deletion cleanup.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

class AudioHistoryManager {
  constructor(options = {}) {
    this.baseDir = options.baseDir || path.join(os.tmpdir(), 'wispr-history-test-' + Math.random().toString(36).substring(2, 7));
    this.recordingsDir = path.join(this.baseDir, 'recordings');
    this.historyFile = path.join(this.baseDir, 'wispr-tell-history.json');
    this.history = [];

    if (!fs.existsSync(this.recordingsDir)) fs.mkdirSync(this.recordingsDir, { recursive: true });
    this.saveHistory();
  }

  saveHistory() {
    fs.writeFileSync(this.historyFile, JSON.stringify(this.history, null, 2), 'utf8');
  }

  addEntry({ text, durationMs, audioBuffer }) {
    const id = 'entry_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
    let audioFileName = null;

    if (audioBuffer && audioBuffer.length > 0) {
      audioFileName = `${id}.webm`;
      const audioPath = path.join(this.recordingsDir, audioFileName);
      fs.writeFileSync(audioPath, audioBuffer);
    }

    const words = text.trim().split(/\s+/).filter(Boolean);
    const entry = {
      id,
      text,
      timestamp: Date.now(),
      wordCount: words.length,
      durationMs,
      audioFile: audioFileName,
      starred: false
    };

    this.history.unshift(entry);
    this.saveHistory();
    return entry;
  }

  getAudioFilePath(id) {
    const entry = this.history.find(e => e.id === id);
    if (!entry || !entry.audioFile) return null;
    const fullPath = path.join(this.recordingsDir, entry.audioFile);
    return fs.existsSync(fullPath) ? fullPath : null;
  }

  deleteEntry(id) {
    const index = this.history.findIndex(e => e.id === id);
    if (index === -1) return false;
    const [removed] = this.history.splice(index, 1);
    if (removed.audioFile) {
      const audioPath = path.join(this.recordingsDir, removed.audioFile);
      if (fs.existsSync(audioPath)) {
        try { fs.unlinkSync(audioPath); } catch {}
      }
    }
    this.saveHistory();
    return true;
  }

  cleanup() {
    try {
      if (fs.existsSync(this.baseDir)) {
        fs.rmSync(this.baseDir, { recursive: true, force: true });
      }
    } catch {}
  }
}

describe('Tier 1 - Feature 15: Compressed Audio History & Playback', () => {
  it('TC-T1-F15-01: saves compressed audio recording alongside history entry', () => {
    const manager = new AudioHistoryManager();
    try {
      const mockOpus = Buffer.from([0x1A, 0x45, 0xDF, 0xA3, 0x9F]); // Mock WebM/EBML header
      const entry = manager.addEntry({
        text: 'Testing audio persistence',
        durationMs: 2500,
        audioBuffer: mockOpus
      });

      assert.ok(entry.id);
      assert.strictEqual(entry.wordCount, 3);
      assert.ok(entry.audioFile.endsWith('.webm'));
      assert.strictEqual(fs.existsSync(path.join(manager.recordingsDir, entry.audioFile)), true);
    } finally {
      manager.cleanup();
    }
  });

  it('TC-T1-F15-02: retrieves audio file path for playback when entry exists', () => {
    const manager = new AudioHistoryManager();
    try {
      const mockOpus = Buffer.from('mock-webm-opus-data');
      const entry = manager.addEntry({
        text: 'Playback audio test',
        durationMs: 1500,
        audioBuffer: mockOpus
      });

      const audioPath = manager.getAudioFilePath(entry.id);
      assert.ok(audioPath);
      assert.strictEqual(fs.readFileSync(audioPath).toString(), 'mock-webm-opus-data');
    } finally {
      manager.cleanup();
    }
  });

  it('TC-T1-F15-03: returns null when requesting audio for entry without recording', () => {
    const manager = new AudioHistoryManager();
    try {
      const entry = manager.addEntry({
        text: 'Text only dictation without audio',
        durationMs: 800,
        audioBuffer: null
      });

      const audioPath = manager.getAudioFilePath(entry.id);
      assert.strictEqual(audioPath, null);
    } finally {
      manager.cleanup();
    }
  });

  it('TC-T1-F15-04: deletes corresponding audio file from disk when deleting history item', () => {
    const manager = new AudioHistoryManager();
    try {
      const mockOpus = Buffer.from('will be deleted');
      const entry = manager.addEntry({
        text: 'Item to delete',
        durationMs: 1000,
        audioBuffer: mockOpus
      });

      const savedAudioPath = path.join(manager.recordingsDir, entry.audioFile);
      assert.strictEqual(fs.existsSync(savedAudioPath), true);

      const deleted = manager.deleteEntry(entry.id);
      assert.strictEqual(deleted, true);
      assert.strictEqual(fs.existsSync(savedAudioPath), false, 'Audio file must be deleted from disk');
      assert.strictEqual(manager.history.length, 0);
    } finally {
      manager.cleanup();
    }
  });

  it('TC-T1-F15-05: correctly computes wordCount and durationMs for history timeline', () => {
    const manager = new AudioHistoryManager();
    try {
      const entry = manager.addEntry({
        text: 'The quick brown fox jumps over the lazy dog',
        durationMs: 3400,
        audioBuffer: Buffer.from('audio')
      });

      assert.strictEqual(entry.wordCount, 9);
      assert.strictEqual(entry.durationMs, 3400);
      assert.strictEqual(entry.starred, false);
    } finally {
      manager.cleanup();
    }
  });
});
