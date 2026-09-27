// Tier 2 - Boundary 14: Custom Dictionary Whisper Prompt Injection Boundary Cases
const { describe, it } = require('node:test');
const assert = require('node:assert');

function buildWhisperPromptBounded(dictionary, maxChars = 800) {
  if (!dictionary || !Array.isArray(dictionary) || dictionary.length === 0) return '';

  const terms = [];
  let currentLength = 0;

  for (const item of dictionary) {
    if (!item) continue;
    const term = (item.to || item.from || '').trim().replace(/["\r\n]/g, '');
    if (!term) continue;

    // Check budget
    const addition = terms.length === 0 ? term.length : term.length + 2; // comma space
    if (currentLength + addition > maxChars) break;

    terms.push(term);
    currentLength += addition;
  }

  return terms.join(', ');
}

describe('Tier 2 - Boundary 14: Custom Dictionary Whisper Prompt Boundary Cases', () => {
  it('TC-T2-B14-01: enforces maximum prompt character budget (~800 chars) for large dictionaries', () => {
    const hugeDictionary = [];
    for (let i = 0; i < 200; i++) {
      hugeDictionary.push({ from: `term${i}`, to: `VeryLongSpecificTechnicalTerm${i}` });
    }

    const prompt = buildWhisperPromptBounded(hugeDictionary, 800);
    assert.ok(prompt.length <= 800, `Prompt length ${prompt.length} must not exceed 800 chars`);
    assert.ok(prompt.length > 700, 'Prompt should fill available budget');
  });

  it('TC-T2-B14-02: sanitizes double quotes and newlines from dictionary entries', () => {
    const badDict = [
      { from: 'test', to: 'Word "With Quotes"' },
      { from: 'break', to: 'Word\nWith\nNewlines' }
    ];

    const prompt = buildWhisperPromptBounded(badDict);
    assert.strictEqual(prompt.includes('"'), false);
    assert.strictEqual(prompt.includes('\n'), false);
    assert.strictEqual(prompt, 'Word With Quotes, WordWithNewlines');
  });

  it('TC-T2-B14-03: preserves uppercase casing for technical acronyms (e.g. GraphQL, CUDA)', () => {
    const acronymDict = [
      { from: 'graph ql', to: 'GraphQL' },
      { from: 'cuda', to: 'CUDA' },
      { from: 'webrtc', to: 'WebRTC' }
    ];

    const prompt = buildWhisperPromptBounded(acronymDict);
    assert.strictEqual(prompt, 'GraphQL, CUDA, WebRTC');
  });

  it('TC-T2-B14-04: returns empty string when dictionary is empty or null', () => {
    assert.strictEqual(buildWhisperPromptBounded([]), '');
    assert.strictEqual(buildWhisperPromptBounded(null), '');
    assert.strictEqual(buildWhisperPromptBounded([{ from: '', to: '' }]), '');
  });

  it('TC-T2-B14-05: ignores malformed dictionary items (null, undefined, non-objects)', () => {
    const mixedDict = [null, undefined, 'string', { to: 'ValidTerm' }, {}];
    const prompt = buildWhisperPromptBounded(mixedDict);
    assert.strictEqual(prompt, 'ValidTerm');
  });

  it('TC-T2-B14-06: applyDictionary sorts multi-word phrases by length to prevent substring mangling', () => {
    const { applyDictionary } = require('../../src/text-utils.js');
    const dict = [
      { from: 'whisper', to: 'Wispr' },
      { from: 'whisper flow', to: 'Wispr Flow' },
      { from: 'whisper speak', to: 'Wispr Speak' }
    ];
    const res = applyDictionary('I use whisper flow and whisper speak alongside whisper daily.', dict);
    assert.strictEqual(res, 'I use Wispr Flow and Wispr Speak alongside Wispr daily.');
  });

  it('TC-T2-B14-07: applyDictionary normalizes case for single vocabulary words', () => {
    const { applyDictionary } = require('../../src/text-utils.js');
    const dict = [
      { word: 'Yeamin Sheikh' },
      { to: 'Antigravity' },
      'Kubernetes'
    ];
    const res = applyDictionary('hello yeamin sheikh, testing antigravity and kubernetes.', dict);
    assert.strictEqual(res, 'hello Yeamin Sheikh, testing Antigravity and Kubernetes.');
  });

  it('TC-T2-B14-08: applyDictionary matches hyphenated and spaced variants', () => {
    const { applyDictionary } = require('../../src/text-utils.js');
    const dict = [{ from: 'whisper flow', to: 'Wispr Flow' }];
    assert.strictEqual(applyDictionary('try whisper-flow now', dict), 'try Wispr Flow now');
    assert.strictEqual(applyDictionary('try whisper  flow now', dict), 'try Wispr Flow now');
  });
});
