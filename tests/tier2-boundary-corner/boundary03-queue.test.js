// Tier 2 - Boundary 03: Hotkey Event Queue Boundary & Corner Cases
const { describe, it } = require('node:test');
const assert = require('node:assert');

class RobustHotkeyQueue {
  constructor(maxQueueSize = 30) {
    this.state = 'IDLE';
    this.queue = [];
    this.maxQueueSize = maxQueueSize;
    this.activeKey = null;
    this.droppedCount = 0;
  }

  handleEvent(type, key) {
    // 1. Filter out-of-order KEY_UP if not listening
    if (type === 'KEY_UP' && this.state !== 'LISTENING_PTT' && this.state !== 'PROCESSING') {
      return { action: 'ignored', reason: 'unmatched-key-up' };
    }

    // 2. Filter OS auto-repeat KEY_DOWN when already active
    if (type === 'KEY_DOWN' && this.activeKey === key && this.state === 'LISTENING_PTT') {
      return { action: 'ignored', reason: 'auto-repeat' };
    }

    if (this.state === 'IDLE') {
      if (type === 'KEY_DOWN') {
        this.activeKey = key;
        this.state = key === 'ptt' ? 'LISTENING_PTT' : 'LISTENING_HANDSFREE';
        return { action: 'capture-start' };
      }
    } else if (this.state === 'LISTENING_PTT' && type === 'KEY_UP' && key === 'ptt') {
      this.state = 'PROCESSING';
      this.activeKey = null;
      return { action: 'capture-stop' };
    } else if (this.state === 'LISTENING_HANDSFREE' && type === 'KEY_DOWN' && key === 'handsfree') {
      this.state = 'PROCESSING';
      this.activeKey = null;
      return { action: 'capture-stop' };
    } else if (this.state === 'PROCESSING' || this.state === 'QUEUED') {
      if (this.queue.length >= this.maxQueueSize) {
        this.droppedCount++;
        return { action: 'dropped', reason: 'queue-full' };
      }
      this.queue.push({ type, key, time: Date.now() });
      this.state = 'QUEUED';
      return { action: 'enqueued', depth: this.queue.length };
    }

    return { action: 'ignored' };
  }

  drainNext() {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      this.state = next.key === 'ptt' ? 'LISTENING_PTT' : 'LISTENING_HANDSFREE';
      this.activeKey = next.key;
      return next;
    }
    this.state = 'IDLE';
    this.activeKey = null;
    return null;
  }
}

describe('Tier 2 - Boundary 03: Hotkey Event Queue Boundary Cases', () => {
  it('TC-T2-B03-01: ignores stray KEY_UP event when system is IDLE', () => {
    const q = new RobustHotkeyQueue();
    const res = q.handleEvent('KEY_UP', 'ptt');
    assert.strictEqual(res.action, 'ignored');
    assert.strictEqual(res.reason, 'unmatched-key-up');
    assert.strictEqual(q.state, 'IDLE');
  });

  it('TC-T2-B03-02: deduplicates OS keyboard auto-repeat events during active PTT', () => {
    const q = new RobustHotkeyQueue();
    q.handleEvent('KEY_DOWN', 'ptt');
    assert.strictEqual(q.state, 'LISTENING_PTT');

    // Simulate 5 repeated KEY_DOWN events from OS key repeat
    for (let i = 0; i < 5; i++) {
      const res = q.handleEvent('KEY_DOWN', 'ptt');
      assert.strictEqual(res.action, 'ignored');
      assert.strictEqual(res.reason, 'auto-repeat');
    }
    assert.strictEqual(q.state, 'LISTENING_PTT');
  });

  it('TC-T2-B03-03: enforces maxQueueSize limit and counts dropped events under flood', () => {
    const q = new RobustHotkeyQueue(5); // Cap at 5
    q.handleEvent('KEY_DOWN', 'ptt');
    q.handleEvent('KEY_UP', 'ptt'); // Now in PROCESSING

    // Enqueue 5 events
    for (let i = 0; i < 5; i++) {
      const res = q.handleEvent('KEY_DOWN', 'ptt');
      assert.strictEqual(res.action, 'enqueued');
    }

    // 6th event exceeds capacity
    const overflowRes = q.handleEvent('KEY_DOWN', 'ptt');
    assert.strictEqual(overflowRes.action, 'dropped');
    assert.strictEqual(overflowRes.reason, 'queue-full');
    assert.strictEqual(q.droppedCount, 1);
  });

  it('TC-T2-B03-04: handles rapid alternating PTT and hands-free key presses', () => {
    const q = new RobustHotkeyQueue();
    q.handleEvent('KEY_DOWN', 'ptt');
    q.handleEvent('KEY_UP', 'ptt'); // PROCESSING

    q.handleEvent('KEY_DOWN', 'handsfree');
    q.handleEvent('KEY_DOWN', 'ptt');

    assert.strictEqual(q.queue.length, 2);
    const item1 = q.drainNext();
    assert.strictEqual(item1.key, 'handsfree');
    assert.strictEqual(q.state, 'LISTENING_HANDSFREE');

    q.state = 'PROCESSING';
    const item2 = q.drainNext();
    assert.strictEqual(item2.key, 'ptt');
    assert.strictEqual(q.state, 'LISTENING_PTT');
  });

  it('TC-T2-B03-05: transitions cleanly to IDLE when queue is completely empty', () => {
    const q = new RobustHotkeyQueue();
    q.state = 'PROCESSING';
    const next = q.drainNext();
    assert.strictEqual(next, null);
    assert.strictEqual(q.state, 'IDLE');
  });
});
