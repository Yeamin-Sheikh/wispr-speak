// Tier 1 - Feature 21: Context-Based Auto-Learning & Personal Dictionary Adaptation
const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  extractDictionaryCorrections,
  areTextsRelated,
  applyDictionary,
} = require('../../src/text-utils');

describe('Tier 1 - Feature 21: Context-Based Auto-Learning & Personal Dictionary Adaptation', () => {
  it('TC-T1-F21-01: extracts single word-to-symbol replacement (e.g. plus to +)', () => {
    const original = 'control plus windows plus space';
    const corrected = 'control + windows + space';

    const corrections = extractDictionaryCorrections(original, corrected);
    assert.strictEqual(corrections.length, 1);
    assert.strictEqual(corrections[0].from, 'plus');
    assert.strictEqual(corrections[0].to, '+');
  });

  it('TC-T1-F21-02: extracts technical term corrections', () => {
    const original = 'I am deploying on kubernetes with helm';
    const corrected = 'I am deploying on Kubernetes with Helm';

    const corrections = extractDictionaryCorrections(original, corrected);
    assert.strictEqual(corrections.length, 2);
    assert.deepStrictEqual(corrections, [
      { from: 'kubernetes', to: 'Kubernetes' },
      { from: 'helm', to: 'Helm' }
    ]);
  });

  it('TC-T1-F21-03: extracts multi-word phrase substitutions', () => {
    const original = 'press control windows space to start';
    const corrected = 'press Ctrl+Win+Space to start';

    const corrections = extractDictionaryCorrections(original, corrected);
    assert.strictEqual(corrections.length, 1);
    assert.strictEqual(corrections[0].from, 'control windows space');
    assert.strictEqual(corrections[0].to, 'Ctrl+Win+Space');
  });

  it('TC-T1-F21-04: returns empty array when texts are identical or whitespace-only diffs', () => {
    assert.deepStrictEqual(extractDictionaryCorrections('hello world', 'hello world'), []);
    assert.deepStrictEqual(extractDictionaryCorrections('hello   world  ', 'hello world'), []);
    assert.deepStrictEqual(extractDictionaryCorrections('', 'hello'), []);
    assert.deepStrictEqual(extractDictionaryCorrections('hello', ''), []);
    assert.deepStrictEqual(extractDictionaryCorrections(null, 'hello'), []);
  });

  it('TC-T1-F21-05: areTextsRelated accurately detects related corrections vs unrelated clipboard content', () => {
    const original = 'control plus windows plus space';
    const candidateRelated = 'control + windows + space';
    const candidateUnrelated = 'https://console.groq.com/keys?session=12345';
    const candidateCode = 'function calculateTotal(items) { return items.reduce((a, b) => a + b, 0); }';

    assert.strictEqual(areTextsRelated(original, candidateRelated), true);
    assert.strictEqual(areTextsRelated(original, candidateUnrelated), false);
    assert.strictEqual(areTextsRelated(original, candidateCode), false);
    assert.strictEqual(areTextsRelated('', candidateRelated), false);
    assert.strictEqual(areTextsRelated(original, ''), false);
  });

  it('TC-T1-F21-06: full learning cycle correctly adapts future dictations with learned rules', () => {
    const initialDict = [
      { from: 'whisper flow', to: 'Wispr Flow' }
    ];

    const originalUtterance = 'say control plus space to trigger';
    const userCorrected = 'say control + space to trigger';

    const newRules = extractDictionaryCorrections(originalUtterance, userCorrected);
    assert.strictEqual(newRules.length, 1);

    // Merge into dictionary
    const updatedDict = [...initialDict, ...newRules];

    // Future dictation: should automatically substitute learned rule
    const futureUtterance = 'press control plus space right now';
    const formatted = applyDictionary(futureUtterance, updatedDict);
    assert.strictEqual(formatted, 'press control + space right now');
  });
});
