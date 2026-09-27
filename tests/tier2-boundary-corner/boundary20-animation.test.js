// Tier 2 - Boundary 20: Character-by-Character Text Injection Animation Boundary Cases
const { describe, it } = require('node:test');
const assert = require('node:assert');

class InterruptibleTypingEngine {
  constructor() {
    this.isInterrupted = false;
    this.typedChars = [];
  }

  interrupt() {
    this.isInterrupted = true;
  }

  async typeString(text, delayMs = 5) {
    this.isInterrupted = false;
    this.typedChars = [];
    const chars = Array.from(text);

    for (let i = 0; i < chars.length; i++) {
      if (this.isInterrupted) {
        // Fast dump of all remaining characters at once
        const remaining = chars.slice(i).join('');
        this.typedChars.push({ dumped: remaining });
        return { completedVia: 'interrupted-flush', total: text.length };
      }

      this.typedChars.push(chars[i]);
      if (delayMs > 0) {
        await new Promise(r => setTimeout(r, delayMs));
      }
    }

    return { completedVia: 'normal-animation', total: text.length };
  }
}

describe('Tier 2 - Boundary 20: Character Typing Animation Boundary Cases', () => {
  it('TC-T2-B20-01: handles single character utterance without indexing errors', async () => {
    const engine = new InterruptibleTypingEngine();
    const res = await engine.typeString('A', 0);
    assert.strictEqual(res.completedVia, 'normal-animation');
    assert.strictEqual(res.total, 1);
    assert.deepStrictEqual(engine.typedChars, ['A']);
  });

  it('TC-T2-B20-02: flushes remaining characters immediately upon user interruption', async () => {
    const engine = new InterruptibleTypingEngine();

    // Start typing long word with 10ms delay
    const typingPromise = engine.typeString('Supercalifragilistic', 10);

    // Trigger interruption after 15ms (~1-2 characters typed)
    setTimeout(() => engine.interrupt(), 15);

    const res = await typingPromise;
    assert.strictEqual(res.completedVia, 'interrupted-flush');
    const dumpEntry = engine.typedChars.find(item => item && item.dumped);
    assert.ok(dumpEntry, 'Must flush remaining characters in batch');
  });

  it('TC-T2-B20-03: preserves tabs and newlines during sequential character typing', async () => {
    const engine = new InterruptibleTypingEngine();
    const formattedCode = '\tconst x = 1;\n\treturn x;';

    const res = await engine.typeString(formattedCode, 0);
    assert.strictEqual(res.total, formattedCode.length);
    assert.strictEqual(engine.typedChars[0], '\t');
    assert.ok(engine.typedChars.includes('\n'));
  });

  it('TC-T2-B20-04: executes 0ms character delay instantly without stack overflow', async () => {
    const engine = new InterruptibleTypingEngine();
    const text = 'Fast'.repeat(20);

    const startTime = Date.now();
    const res = await engine.typeString(text, 0);
    const duration = Date.now() - startTime;

    assert.strictEqual(res.total, text.length);
    assert.ok(duration < 20, `Execution took ${duration}ms, must be < 20ms`);
  });

  it('TC-T2-B20-05: handles empty string input gracefully without error', async () => {
    const engine = new InterruptibleTypingEngine();
    const res = await engine.typeString('', 0);
    assert.strictEqual(res.total, 0);
    assert.deepStrictEqual(engine.typedChars, []);
  });
});
