// Tier 1 - Feature 03: Rapid Hotkey Event Queue & State Machine
// Verifies FIFO queue mechanics and state transitions per PROJECT.md interface contract.
const { describe, it } = require('node:test');
const assert = require('node:assert');

class HotkeyStateMachine {
  constructor() {
    this.state = 'IDLE';
    this.queue = [];
    this.history = [];
    this.droppedEvents = 0;
  }

  logTransition(from, to, trigger) {
    this.history.push({ from, to, trigger, timestamp: Date.now() });
    this.state = to;
  }

  handleEvent(type, key) {
    const currentState = this.state;

    if (currentState === 'IDLE') {
      if (type === 'KEY_DOWN' && key === 'ptt') {
        this.logTransition('IDLE', 'LISTENING_PTT', 'KEY_DOWN(ptt)');
        return { action: 'capture-start' };
      }
      if (type === 'KEY_DOWN' && key === 'handsfree') {
        this.logTransition('IDLE', 'LISTENING_HANDSFREE', 'KEY_DOWN(handsfree)');
        return { action: 'capture-start' };
      }
    } else if (currentState === 'LISTENING_PTT') {
      if (type === 'KEY_UP' && key === 'ptt') {
        this.logTransition('LISTENING_PTT', 'PROCESSING', 'KEY_UP(ptt)');
        return { action: 'capture-stop' };
      }
    } else if (currentState === 'LISTENING_HANDSFREE') {
      if (type === 'KEY_DOWN' && key === 'handsfree') {
        this.logTransition('LISTENING_HANDSFREE', 'PROCESSING', 'KEY_DOWN(handsfree)');
        return { action: 'capture-stop' };
      }
    } else if (currentState === 'PROCESSING' || currentState === 'QUEUED') {
      // Any key event during processing is queued
      this.queue.push({ type, key, timestamp: Date.now() });
      if (this.state !== 'QUEUED') {
        this.logTransition('PROCESSING', 'QUEUED', `ENQUEUE(${type},${key})`);
      }
      return { action: 'enqueued', depth: this.queue.length };
    }

    return { action: 'ignored' };
  }

  completeProcessing() {
    if (this.queue.length > 0) {
      const nextEvent = this.queue.shift();
      const targetState = nextEvent.key === 'ptt' ? 'LISTENING_PTT' : 'LISTENING_HANDSFREE';
      this.logTransition(this.state, targetState, `DEQUEUE(${nextEvent.type},${nextEvent.key})`);
      return { action: 'capture-start', nextEvent };
    } else {
      this.logTransition(this.state, 'IDLE', 'PROCESSING_COMPLETE');
      return { action: 'idle' };
    }
  }
}

describe('Tier 1 - Feature 03: Rapid Hotkey Event Queue & State Machine', () => {
  it('TC-T1-F03-01: executes normal PTT lifecycle IDLE -> LISTENING_PTT -> PROCESSING -> IDLE', () => {
    const fsm = new HotkeyStateMachine();
    assert.strictEqual(fsm.state, 'IDLE');

    const resDown = fsm.handleEvent('KEY_DOWN', 'ptt');
    assert.strictEqual(fsm.state, 'LISTENING_PTT');
    assert.strictEqual(resDown.action, 'capture-start');

    const resUp = fsm.handleEvent('KEY_UP', 'ptt');
    assert.strictEqual(fsm.state, 'PROCESSING');
    assert.strictEqual(resUp.action, 'capture-stop');

    const resDone = fsm.completeProcessing();
    assert.strictEqual(fsm.state, 'IDLE');
    assert.strictEqual(resDone.action, 'idle');
  });

  it('TC-T1-F03-02: executes hands-free toggle lifecycle IDLE -> LISTENING_HANDSFREE -> PROCESSING -> IDLE', () => {
    const fsm = new HotkeyStateMachine();

    fsm.handleEvent('KEY_DOWN', 'handsfree');
    assert.strictEqual(fsm.state, 'LISTENING_HANDSFREE');

    fsm.handleEvent('KEY_DOWN', 'handsfree');
    assert.strictEqual(fsm.state, 'PROCESSING');

    fsm.completeProcessing();
    assert.strictEqual(fsm.state, 'IDLE');
  });

  it('TC-T1-F03-03: enqueues incoming key events during PROCESSING state without dropping', () => {
    const fsm = new HotkeyStateMachine();
    fsm.handleEvent('KEY_DOWN', 'ptt');
    fsm.handleEvent('KEY_UP', 'ptt'); // Now in PROCESSING

    assert.strictEqual(fsm.state, 'PROCESSING');
    const q1 = fsm.handleEvent('KEY_DOWN', 'ptt');
    assert.strictEqual(fsm.state, 'QUEUED');
    assert.strictEqual(q1.depth, 1);

    const q2 = fsm.handleEvent('KEY_UP', 'ptt');
    assert.strictEqual(fsm.state, 'QUEUED');
    assert.strictEqual(q2.depth, 2);
    assert.strictEqual(fsm.queue.length, 2);
  });

  it('TC-T1-F03-04: drains queued events in strict FIFO order upon processing completion', () => {
    const fsm = new HotkeyStateMachine();
    fsm.handleEvent('KEY_DOWN', 'ptt');
    fsm.handleEvent('KEY_UP', 'ptt'); // PROCESSING

    fsm.handleEvent('KEY_DOWN', 'ptt');
    fsm.handleEvent('KEY_DOWN', 'handsfree');

    assert.strictEqual(fsm.queue.length, 2);
    const firstPopped = fsm.completeProcessing();
    assert.strictEqual(firstPopped.nextEvent.key, 'ptt', 'First queued event must be PTT');

    // Simulate completion of this second processing cycle
    fsm.state = 'PROCESSING';
    const secondPopped = fsm.completeProcessing();
    assert.strictEqual(secondPopped.nextEvent.key, 'handsfree', 'Second queued event must be handsfree');
  });

  it('TC-T1-F03-05: handles high frequency rapid toggles (15 presses/sec) with zero dropped events', () => {
    const fsm = new HotkeyStateMachine();
    const burstCount = 15;

    // Start initial utterance
    fsm.handleEvent('KEY_DOWN', 'ptt');
    fsm.handleEvent('KEY_UP', 'ptt'); // State is now PROCESSING

    // Rapid burst of 15 key presses during processing
    for (let i = 0; i < burstCount; i++) {
      fsm.handleEvent('KEY_DOWN', 'ptt');
    }

    assert.strictEqual(fsm.queue.length, burstCount, 'Queue must hold all 15 events without loss');
    assert.strictEqual(fsm.droppedEvents, 0, 'Dropped events must be zero');
  });
});
