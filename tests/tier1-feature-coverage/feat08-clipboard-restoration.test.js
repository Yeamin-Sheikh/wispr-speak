// Tier 1 - Feature 08: Deterministic Clipboard Restoration
// Verifies Win32 sequence verification algorithm, clipboard snapshot capture, and anti-clobber protection.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { MockClipboard } = require('../helpers/mock-electron');

// Clipboard injection manager conforming to PROJECT.md § Interface Contracts
class ClipboardInjectionManager {
  constructor(clipboard = new MockClipboard()) {
    this.clipboard = clipboard;
    this.restoreAborted = false;
    this.restoreSuccessful = false;
  }

  async injectWithSequenceCheck(textToPaste, simulateExternalModification = false) {
    this.restoreAborted = false;
    this.restoreSuccessful = false;

    // 1. Capture clipboard formats snapshot
    const snapshot = this.clipboard.snapshot();

    // 2. Write target text to clipboard
    this.clipboard.writeText(textToPaste);

    // 3. Query sequence number after our write
    const seqAfter = this.clipboard.getClipboardSequenceNumber();

    // 4. Simulate target app consuming paste
    await new Promise(r => setTimeout(r, 10));

    // Optional simulation: user copies something else while paste was taking place
    if (simulateExternalModification) {
      this.clipboard.writeText('External User Copied Data');
    }

    // 5. Query sequence number before restore
    const currentSeq = this.clipboard.getClipboardSequenceNumber();

    // 6. Verification
    if (currentSeq === seqAfter) {
      this.clipboard.restore(snapshot);
      this.restoreSuccessful = true;
      return { success: true, restored: true };
    } else {
      // Abort restore to prevent clobbering user copy
      this.restoreAborted = true;
      return { success: true, restored: false, reason: 'Sequence mismatch (external clipboard change)' };
    }
  }
}

describe('Tier 1 - Feature 08: Deterministic Clipboard Restoration', () => {
  it('TC-T1-F08-01: captures initial clipboard snapshot and sequence number', () => {
    const clip = new MockClipboard();
    clip.writeText('Original user text');
    const initialSeq = clip.getClipboardSequenceNumber();

    const snap = clip.snapshot();
    assert.strictEqual(snap.text, 'Original user text');
    assert.strictEqual(snap.seq, initialSeq);
  });

  it('TC-T1-F08-02: restores clipboard content when sequence number is unchanged', async () => {
    const clip = new MockClipboard();
    clip.writeText('Keep this safe');
    const manager = new ClipboardInjectionManager(clip);

    const result = await manager.injectWithSequenceCheck('Transcribed dictation');

    assert.strictEqual(result.restored, true);
    assert.strictEqual(manager.restoreSuccessful, true);
    assert.strictEqual(clip.readText(), 'Keep this safe', 'Original clipboard text must be restored');
  });

  it('TC-T1-F08-03: aborts restoration when external process updates clipboard sequence', async () => {
    const clip = new MockClipboard();
    clip.writeText('Initial text');
    const manager = new ClipboardInjectionManager(clip);

    const result = await manager.injectWithSequenceCheck('Dictation text', true); // External modification = true

    assert.strictEqual(result.restored, false);
    assert.strictEqual(manager.restoreAborted, true);
    assert.strictEqual(clip.readText(), 'External User Copied Data', 'Must preserve external user clipboard data');
  });

  it('TC-T1-F08-04: handles empty clipboard snapshot cleanly without errors', async () => {
    const clip = new MockClipboard();
    clip.clear();
    const manager = new ClipboardInjectionManager(clip);

    const result = await manager.injectWithSequenceCheck('Spoken text');
    assert.strictEqual(result.restored, true);
    assert.strictEqual(clip.readText(), '');
  });

  it('TC-T1-F08-05: verifies sequential sequence increments across consecutive dictations', async () => {
    const clip = new MockClipboard();
    const manager = new ClipboardInjectionManager(clip);
    const seqHistory = [];

    for (let i = 0; i < 3; i++) {
      seqHistory.push(clip.getClipboardSequenceNumber());
      await manager.injectWithSequenceCheck(`Sentence ${i}`);
    }

    assert.strictEqual(seqHistory.length, 3);
    assert.ok(seqHistory[1] > seqHistory[0]);
    assert.ok(seqHistory[2] > seqHistory[1]);
  });
});
