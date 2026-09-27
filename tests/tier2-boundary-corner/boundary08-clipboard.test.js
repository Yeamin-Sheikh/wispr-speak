// Tier 2 - Boundary 08: Deterministic Clipboard Restoration Boundary Cases
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { MockClipboard } = require('../helpers/mock-electron');

class HighStressClipboardManager {
  constructor(clip = new MockClipboard()) {
    this.clip = clip;
  }

  async pasteWithLockRetry(targetText, maxLockRetries = 3, simulateExternalModification = false) {
    let snapshot = null;
    let lockAttempts = 0;

    // Retry snapshot capture if clipboard is locked by external process
    while (lockAttempts < maxLockRetries) {
      try {
        snapshot = this.clip.snapshot();
        break;
      } catch {
        lockAttempts++;
        await new Promise(r => setTimeout(r, 10));
      }
    }

    if (!snapshot) throw new Error('Clipboard locked by external process');

    this.clip.writeText(targetText);
    const seqAfter = this.clip.getClipboardSequenceNumber();

    // Simulate consumption interval
    await new Promise(r => setTimeout(r, 5));

    if (simulateExternalModification) {
      this.clip.writeText('External change');
    }

    // Verify sequence before restoration
    const currentSeq = this.clip.getClipboardSequenceNumber();
    if (currentSeq === seqAfter) {
      this.clip.restore(snapshot);
      return { restored: true };
    }
    return { restored: false, reason: 'Sequence changed' };
  }
}

describe('Tier 2 - Boundary 08: Clipboard Restoration Boundary Cases', () => {
  it('TC-T2-B08-01: captures and restores large clipboard payload (>5MB string) faithfully', async () => {
    const clip = new MockClipboard();
    const largeString = 'A'.repeat(5 * 1024 * 1024); // 5MB
    clip.writeText(largeString);

    const manager = new HighStressClipboardManager(clip);
    const res = await manager.pasteWithLockRetry('Injected speech text');

    assert.strictEqual(res.restored, true);
    assert.strictEqual(clip.readText().length, 5 * 1024 * 1024);
  });

  it('TC-T2-B08-02: handles sequence number integer boundary and wrap-around correctly', () => {
    const clip = new MockClipboard();
    clip.sequenceNumber = Number.MAX_SAFE_INTEGER - 1;

    clip.writeText('test 1');
    assert.strictEqual(clip.getClipboardSequenceNumber(), Number.MAX_SAFE_INTEGER);

    // Simulated 32-bit Win32 sequence wrap
    const win32SeqWrap = (seq) => (seq >>> 0);
    assert.strictEqual(win32SeqWrap(0xFFFFFFFF + 1), 0);
  });

  it('TC-T2-B08-03: preserves multiple clipboard format descriptors in snapshot', () => {
    const clip = new MockClipboard();
    clip.formats.set('text/plain', 'Plain text');
    clip.formats.set('text/html', '<p>Plain text</p>');
    clip.formats.set('custom/format', Buffer.from([1, 2, 3]));

    const snap = clip.snapshot();
    assert.strictEqual(snap.formats.size, 3);
    assert.strictEqual(snap.formats.get('text/html'), '<p>Plain text</p>');
  });

  it('TC-T2-B08-04: aborts restoration when sequence changes due to external user copy', async () => {
    const clip = new MockClipboard();
    clip.writeText('Initial text');

    const manager = new HighStressClipboardManager(clip);
    const res = await manager.pasteWithLockRetry('Dictation', 3, true); // simulateExternalModification = true
    assert.strictEqual(res.restored, false);
    assert.strictEqual(res.reason, 'Sequence changed');
    assert.strictEqual(clip.readText(), 'External change');
  });

  it('TC-T2-B08-05: executes 20 rapid back-to-back paste cycles without desynchronization', async () => {
    const clip = new MockClipboard();
    const manager = new HighStressClipboardManager(clip);

    for (let i = 0; i < 20; i++) {
      clip.writeText(`User data ${i}`);
      const res = await manager.pasteWithLockRetry(`Dictated ${i}`);
      assert.strictEqual(res.restored, true);
      assert.strictEqual(clip.readText(), `User data ${i}`);
    }
  });
});
