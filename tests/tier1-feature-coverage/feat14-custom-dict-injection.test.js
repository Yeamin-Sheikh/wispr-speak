// Tier 1 - Feature 14: Custom Dictionary Whisper Prompt Injection
// Verifies formatting glossary terms into Whisper prompt multipart parameter and post-processing replacements.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { applyDictionary, buildMultipart } = require('../../src/text-utils');

// Formatter to prepare Whisper prompt from user dictionary entries
function formatWhisperPromptFromDict(dictionary = []) {
  if (!dictionary || dictionary.length === 0) return '';
  const terms = dictionary
    .filter(d => d && (d.to || d.from))
    .map(d => (d.to || d.from).trim())
    .filter(Boolean);

  // Deduplicate terms
  const uniqueTerms = Array.from(new Set(terms));
  // Whisper prompt convention: comma separated list of vocabulary hints
  return uniqueTerms.join(', ');
}

describe('Tier 1 - Feature 14: Custom Dictionary Whisper Prompt Injection', () => {
  it('TC-T1-F14-01: formats custom dictionary terms into Whisper prompt string', () => {
    const dict = [
      { from: 'whisper flow', to: 'Wispr Flow' },
      { from: 'wispr tell', to: 'Wispr Tell' },
      { from: 'groq', to: 'Groq' },
      { from: 'silero', to: 'Silero' }
    ];

    const prompt = formatWhisperPromptFromDict(dict);
    assert.strictEqual(prompt, 'Wispr Flow, Wispr Tell, Groq, Silero');
  });

  it('TC-T1-F14-02: injects prompt field into multipart request body via buildMultipart', () => {
    const dict = [{ from: 'react', to: 'React.js' }];
    const prompt = formatWhisperPromptFromDict(dict);

    const fields = {
      model: 'whisper-large-v3-turbo',
      language: 'en',
      prompt: prompt
    };

    const dummyWav = Buffer.from('RIFF....WAVEfmt ');
    const multipart = buildMultipart(fields, 'file', 'audio.wav', dummyWav, 'audio/wav');

    const bodyString = multipart.body.toString('utf8');
    assert.ok(bodyString.includes('name="prompt"'), 'Multipart body must include prompt field');
    assert.ok(bodyString.includes('React.js'), 'Multipart body must contain dictionary term');
  });

  it('TC-T1-F14-03: applies exact dictionary replacement for misheard terms in transcription', () => {
    const dict = [
      { from: 'whisper flow', to: 'Wispr Flow' },
      { from: 'tell me', to: 'Tell Me' }
    ];

    const input = 'I am testing whisper flow and tell me today';
    const output = applyDictionary(input, dict);
    assert.strictEqual(output, 'I am testing Wispr Flow and Tell Me today');
  });

  it('TC-T1-F14-04: handles word boundary matches avoiding partial substring corruption', () => {
    const dict = [
      { from: 'flow', to: 'Flow' }
    ];

    // "flower" should NOT be replaced with "Flower"
    const input = 'Look at that beautiful flower and check the flow';
    const output = applyDictionary(input, dict);
    assert.strictEqual(output, 'Look at that beautiful flower and check the Flow');
  });

  it('TC-T1-F14-05: deduplicates repeated terms in dictionary before prompt generation', () => {
    const dict = [
      { from: 'groq', to: 'Groq' },
      { from: 'GROQ', to: 'Groq' },
      { from: 'groq cloud', to: 'Groq' }
    ];

    const prompt = formatWhisperPromptFromDict(dict);
    assert.strictEqual(prompt, 'Groq', 'Duplicate target terms should be collapsed into single entry');
  });
});
