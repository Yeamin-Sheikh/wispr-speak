// Tier 1 - Feature 20: Character-by-Character Text Injection Animation
// Verifies sequential character typing animation, short utterance threshold, instant paste bypass, and unicode support.
const { describe, it } = require('node:test');
const assert = require('node:assert');

class TextInjectionEngine {
  constructor(options = {}) {
    this.animationEnabled = options.animationEnabled !== false;
    this.maxAnimatedLength = options.maxAnimatedLength || 100;
    this.charDelayMs = options.charDelayMs || 5;
    this.injectedEvents = [];
  }

  async injectText(text, onCharInjected = null) {
    this.injectedEvents = [];
    const str = String(text);

    // Bypass animation if disabled or text is longer than threshold
    if (!this.animationEnabled || str.length > this.maxAnimatedLength) {
      this.injectedEvents.push({ type: 'clipboard-paste', text: str });
      return { method: 'paste', charCount: str.length };
    }

    // Character-by-character typing animation
    // Use Array.from to correctly handle unicode surrogate pairs (emojis)
    const characters = Array.from(str);
    for (let i = 0; i < characters.length; i++) {
      const char = characters[i];
      this.injectedEvents.push({ type: 'char-type', char, index: i });
      if (onCharInjected) onCharInjected(char, i);
      if (this.charDelayMs > 0) {
        await new Promise(r => setTimeout(r, this.charDelayMs));
      }
    }

    return { method: 'animated-typing', charCount: characters.length };
  }
}

describe('Tier 1 - Feature 20: Character-by-Character Text Injection Animation', () => {
  it('TC-T1-F20-01: animates short text (< 100 chars) character-by-character when enabled', async () => {
    const engine = new TextInjectionEngine({ animationEnabled: true, charDelayMs: 1 });
    const text = 'Quick test!';

    const res = await engine.injectText(text);
    assert.strictEqual(res.method, 'animated-typing');
    assert.strictEqual(res.charCount, 11);
    assert.strictEqual(engine.injectedEvents.length, 11);
    assert.strictEqual(engine.injectedEvents[0].char, 'Q');
    assert.strictEqual(engine.injectedEvents[10].char, '!');
  });

  it('TC-T1-F20-02: bypasses animation and uses instant paste for long text (> 100 chars)', async () => {
    const engine = new TextInjectionEngine({ animationEnabled: true, maxAnimatedLength: 100 });
    const longText = 'This is a very long dictation sentence designed specifically to exceed the one hundred character threshold for character-by-character animation.'.repeat(2);

    assert.ok(longText.length > 100);
    const res = await engine.injectText(longText);

    assert.strictEqual(res.method, 'paste');
    assert.strictEqual(engine.injectedEvents.length, 1);
    assert.strictEqual(engine.injectedEvents[0].type, 'clipboard-paste');
    assert.strictEqual(engine.injectedEvents[0].text, longText);
  });

  it('TC-T1-F20-03: bypasses animation when animationEnabled setting is false', async () => {
    const engine = new TextInjectionEngine({ animationEnabled: false });
    const shortText = 'Short text';

    const res = await engine.injectText(shortText);
    assert.strictEqual(res.method, 'paste');
    assert.strictEqual(engine.injectedEvents.length, 1);
  });

  it('TC-T1-F20-04: correctly handles multi-byte unicode characters and emojis', async () => {
    const engine = new TextInjectionEngine({ animationEnabled: true, charDelayMs: 0 });
    const unicodeText = 'Hello 🚀 café!';

    const res = await engine.injectText(unicodeText);
    assert.strictEqual(res.method, 'animated-typing');
    // 'H','e','l','l','o',' ','🚀',' ','c','a','f','é','!' -> 13 code points
    assert.strictEqual(res.charCount, 13);
    const chars = engine.injectedEvents.map(e => e.char);
    assert.ok(chars.includes('🚀'), 'Emoji must be injected as single character');
    assert.ok(chars.includes('é'), 'Accented letter must be injected accurately');
  });

  it('TC-T1-F20-05: invokes per-character callback on each keystroke', async () => {
    const engine = new TextInjectionEngine({ animationEnabled: true, charDelayMs: 0 });
    const typed = [];

    await engine.injectText('ABC', (char) => {
      typed.push(char);
    });

    assert.deepStrictEqual(typed, ['A', 'B', 'C']);
  });
});
