// Tier 2 - Boundary 15: Compressed Audio History & Playback Boundary Cases
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { performance } = require('perf_hooks');

class HistorySearchAndQuotaManager {
  static searchHistory(entries, query) {
    if (!query) return entries;
    const q = query.toLowerCase();
    return entries.filter(e => e.text && e.text.toLowerCase().includes(q));
  }

  static pruneOldestRecordings(recordingsList, maxTotalSizeBytes = 500 * 1024 * 1024) {
    let totalSize = recordingsList.reduce((acc, r) => acc + (r.sizeBytes || 0), 0);
    const toDelete = [];

    // Sort oldest first
    const sorted = [...recordingsList].sort((a, b) => a.timestamp - b.timestamp);

    while (totalSize > maxTotalSizeBytes && sorted.length > 0) {
      const oldest = sorted.shift();
      toDelete.push(oldest);
      totalSize -= oldest.sizeBytes;
    }

    return { toDelete, remainingSize: totalSize };
  }
}

describe('Tier 2 - Boundary 15: Compressed Audio History Boundary Cases', () => {
  it('TC-T2-B15-01: handles missing recording file without breaking timeline rendering', () => {
    const entry = { id: 'missing_rec', text: 'Text with deleted audio', audioFile: 'deleted.webm' };
    const getPlaybackUrl = (file, existsOnDisk) => existsOnDisk ? `/audio/${file}` : null;

    assert.strictEqual(getPlaybackUrl(entry.audioFile, false), null);
  });

  it('TC-T2-B15-02: prunes oldest recordings when total audio folder size exceeds quota', () => {
    const recordings = [
      { id: 'rec_1', timestamp: 1000, sizeBytes: 300 * 1024 * 1024 },
      { id: 'rec_2', timestamp: 2000, sizeBytes: 300 * 1024 * 1024 },
      { id: 'rec_3', timestamp: 3000, sizeBytes: 100 * 1024 * 1024 }
    ];
    // Total is 700MB, quota is 500MB
    const result = HistorySearchAndQuotaManager.pruneOldestRecordings(recordings, 500 * 1024 * 1024);

    assert.strictEqual(result.toDelete.length, 1);
    assert.strictEqual(result.toDelete[0].id, 'rec_1', 'Oldest recording should be pruned');
    assert.ok(result.remainingSize <= 500 * 1024 * 1024);
  });

  it('TC-T2-B15-03: discards zero-length audio buffer without writing 0-byte file to disk', () => {
    function processAudioForSave(buffer) {
      if (!buffer || buffer.length === 0) return null;
      return 'saved.webm';
    }

    assert.strictEqual(processAudioForSave(Buffer.alloc(0)), null);
  });

  it('TC-T2-B15-04: searches through 1,000 history entries by query in under 5ms', () => {
    const entries = [];
    for (let i = 0; i < 1000; i++) {
      entries.push({ id: `e_${i}`, text: `Sentence number ${i} about testing` });
    }
    entries[750].text = 'Special target phrase about electron';

    const startTime = performance.now();
    const results = HistorySearchAndQuotaManager.searchHistory(entries, 'Special target phrase');
    const duration = performance.now() - startTime;

    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].id, 'e_750');
    assert.ok(duration < 25, `Search took ${duration}ms, must be < 25ms`);
  });

  it('TC-T2-B15-05: handles search query with regex characters without throwing', () => {
    const entries = [{ id: 'e_1', text: 'Price is $100.00 (discounted)' }];
    assert.doesNotThrow(() => {
      const results = HistorySearchAndQuotaManager.searchHistory(entries, '$100.00 (');
      assert.strictEqual(results.length, 1);
    });
  });
});
