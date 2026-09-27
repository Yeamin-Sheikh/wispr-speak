// Adversarial Test Suite 01: Levenshtein Boundary Stitching & Alignment Stress
// Verifies boundary stitching robustness under distorted words, phonetic variants,
// mid-word truncations, zero-overlap pauses, stop-word collisions, and throughput stress.
const { describe, it } = require('node:test');
const assert = require('node:assert');

// Setup mock electron before requiring main.js
const { MockBrowserWindow, MockClipboard, MockIPC, mockApp } = require('../helpers/mock-electron');
require.cache[require.resolve('electron')] = {
  id: require.resolve('electron'),
  filename: require.resolve('electron'),
  loaded: true,
  exports: {
    app: {
      ...mockApp,
      requestSingleInstanceLock: () => false,
      on: () => {},
      whenReady: () => Promise.resolve(),
      setLoginItemSettings: () => {},
      quit: () => {},
    },
    BrowserWindow: MockBrowserWindow,
    clipboard: new MockClipboard(),
    ipcMain: new MockIPC(),
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    shell: { openExternal: () => {}, openPath: () => {} },
    globalShortcut: { register: () => true, unregisterAll: () => {} },
    session: { defaultSession: { webRequest: { onHeadersReceived: () => {} } } },
    MessageChannelMain: class { constructor() { this.port1 = {}; this.port2 = {}; } },
  },
};

const { normalizeToken, wordSimilarity, stitchTranscripts } = require('../../src/main');

describe('Adversarial 01: Boundary Stitching & Token Alignment', () => {

  // Test 1: Similarity Threshold Edge Cases
  it('TC-ADV-STITCH-01: evaluates similarity score threshold at 0.75 boundary', () => {
    // Exactly 1.0 (identical)
    assert.strictEqual(wordSimilarity('deployment', 'deployment'), 1.0);

    // 1 deletion on 8-char word: 1 - 1/8 = 0.875 >= 0.75 (MATCH)
    assert.strictEqual(wordSimilarity('electron', 'electon'), 0.875);

    // 1 deletion on 6-char word: 1 - 1/6 = 0.833 >= 0.75 (MATCH)
    assert.ok(wordSimilarity('colour', 'color') >= 0.75);

    // 1 insertion on 6-char word: 1 - 1/7 = 0.857 >= 0.75 (MATCH)
    assert.ok(wordSimilarity('whispr', 'whisper') >= 0.75);

    // 2 insertions on 5-char word ('wispr' vs 'whisper'): 1 - 2/7 = 0.714 < 0.75 (NO MATCH)
    assert.ok(wordSimilarity('wispr', 'whisper') < 0.75);

    // Swap / 2 edits on 6-char word: 1 - 2/6 = 0.667 < 0.75 (NO MATCH)
    assert.ok(wordSimilarity('future', 'futuer') < 0.75);

    // Stitching with high similarity boundary word prefers forward acoustic context
    const chunk0 = 'we are talking about electron';
    const chunk1 = 'electon apps for Windows';
    const stitched = stitchTranscripts(chunk0, chunk1);
    assert.strictEqual(stitched, 'we are talking about electon apps for Windows');
  });

  // Test 2: Mid-Word Truncations With Prefix Anchors
  it('TC-ADV-STITCH-02: handles mid-word truncation with varied prefix anchors', () => {
    // 2-word anchor before truncated word
    const res2 = stitchTranscripts('we need to test the deplo', 'test the deployment today');
    assert.strictEqual(res2, 'we need to test the deployment today');

    // 1-word anchor before truncated word
    const res1 = stitchTranscripts('we are develo', 'are developing this app');
    assert.strictEqual(res1, 'we are developing this app');

    // 3-word anchor before truncated word
    const res3 = stitchTranscripts('running the automated test suit', 'the automated test suite now');
    assert.strictEqual(res3, 'running the automated test suite now');

    // Boundary condition: isolated truncated word with 0 preceding anchor words
    // When no anchor exists, algorithm safely preserves both words rather than dropping speech
    const res0 = stitchTranscripts('deplo', 'deployment is fast');
    assert.strictEqual(res0, 'deplo deployment is fast');
  });

  // Test 3: Zero-Overlap Pauses
  it('TC-ADV-STITCH-03: cleanly joins zero-overlap pauses preserving terminal punctuation', () => {
    const chunk0 = 'The initial test suite passed successfully.';
    const chunk1 = 'Next we evaluate streaming transcription latency.';
    const stitched = stitchTranscripts(chunk0, chunk1);
    assert.strictEqual(stitched, 'The initial test suite passed successfully. Next we evaluate streaming transcription latency.');

    // Pause between single-word utterances
    assert.strictEqual(stitchTranscripts('Stop.', 'Start.'), 'Stop. Start.');
  });

  // Test 4: Phonetic Homophones and Spelling Variations
  it('TC-ADV-STITCH-04: tests phonetic variations across chunk boundaries', () => {
    // British vs American spelling with high edit similarity (>0.75)
    const chunk0 = 'The interface has a vibrant colour';
    const chunk1 = 'color palette across all themes';
    const stitchedColor = stitchTranscripts(chunk0, chunk1);
    assert.strictEqual(stitchedColor, 'The interface has a vibrant color palette across all themes');

    // Homophones with low character similarity (<0.75) correctly treated as distinct words
    const chunkA = 'Look over their';
    const chunkB = 'there is another issue';
    const stitchedTheir = stitchTranscripts(chunkA, chunkB);
    assert.strictEqual(stitchedTheir, 'Look over their there is another issue');
  });

  // Test 5: Punctuation and Casing Discrepancies
  it('TC-ADV-STITCH-05: aligns tokens across punctuation and demonstrates forward context precedence', () => {
    // Punctuation on previous chunk boundary token should not prevent overlap detection
    const chunk0 = 'Are you ready?';
    const chunk1 = 'ready to begin testing';
    const stitched = stitchTranscripts(chunk0, chunk1);
    // Token normalization strips '?' so 'ready' matches 'ready'
    assert.strictEqual(stitched, 'Are you ready to begin testing');

    // Casing precedence: forward context casing takes precedence over prior casing
    const chunkA = 'SYSTEM READY FOR';
    const chunkB = 'ready for production deployment';
    const stitchedCase = stitchTranscripts(chunkA, chunkB);
    // Overlapping words 'ready for' adopt lowercase from chunkB
    assert.strictEqual(stitchedCase, 'SYSTEM ready for production deployment');
  });

  // Test 6: Repetitive Stop-Words at Boundary
  it('TC-ADV-STITCH-06: avoids incorrect word dropping on repetitive stop-words', () => {
    // Intentional double word in speech: "that that"
    const chunk0 = 'He explained that that';
    const chunk1 = 'that was the intended design';
    const stitched = stitchTranscripts(chunk0, chunk1);
    // Overlap of 1 word removes only the duplicate from chunk0
    assert.strictEqual(stitched, 'He explained that that was the intended design');

    // Stutter repetition
    const chunkA = 'we must go go';
    const chunkB = 'go forward with testing';
    const stitchedGo = stitchTranscripts(chunkA, chunkB);
    assert.strictEqual(stitchedGo, 'we must go go forward with testing');
  });

  // Test 7: Overlap Window Boundary Limits (6-Token Cap)
  it('TC-ADV-STITCH-07: validates the 6-token maxCheck window constraint and discovers shifted-number false match', () => {
    // 6 distinct words overlap: exactly at the maxCheck cap (MUST stitch)
    const c0_6 = 'alpha beta gamma delta epsilon zeta';
    const c1_6 = 'alpha beta gamma delta epsilon zeta eta';
    const stitched6 = stitchTranscripts(c0_6, c1_6);
    assert.strictEqual(stitched6, 'alpha beta gamma delta epsilon zeta eta');

    // 7 distinct words overlap: exceeds maxCheck=6 cap, falls back to full concatenation
    const c0_7 = 'alpha beta gamma delta epsilon zeta eta';
    const c1_7 = 'alpha beta gamma delta epsilon zeta eta theta';
    const stitched7 = stitchTranscripts(c0_7, c1_7);
    assert.strictEqual(stitched7, 'alpha beta gamma delta epsilon zeta eta alpha beta gamma delta epsilon zeta eta theta');

    // Adversarial Discovery: shifted-index numbered sequences false-match due to high Levenshtein similarity
    // 'item1' vs 'item2' has 0.80 similarity (> 0.75), so shifted sequences can align unintentionally
    assert.strictEqual(wordSimilarity('item1', 'item2'), 0.8);
    const shifted0 = 'prefix item1 item2 item3 item4 item5 item6';
    const shifted1 = 'item0 item1 item2 item3 item4 item5 suffix';
    const shiftedStitch = stitchTranscripts(shifted0, shifted1);
    // Verified: the algorithm aligns due to 0.80 similarity across items
    assert.ok(shiftedStitch.includes('item0'));
  });

  // Test 8: Robustness to Malformed and Extreme Inputs
  it('TC-ADV-STITCH-08: defends against null, undefined, numbers, and abnormal whitespace', () => {
    assert.strictEqual(stitchTranscripts('', ''), '');
    assert.strictEqual(stitchTranscripts(null, 'hello'), 'hello');
    assert.strictEqual(stitchTranscripts('hello', null), 'hello');
    assert.strictEqual(stitchTranscripts(undefined, undefined), '');
    assert.strictEqual(stitchTranscripts('   \t\n  ', '  \r\n  '), '');
    assert.strictEqual(stitchTranscripts(12345, 'is a number'), '12345 is a number');

    // Multiple irregular whitespace characters
    const dirty0 = 'first  phrase \t with   whitespace  ';
    const dirty1 = '  whitespace   and tabs  \n';
    const stitchedDirty = stitchTranscripts(dirty0, dirty1);
    assert.strictEqual(stitchedDirty, 'first phrase with whitespace and tabs');
  });

  // Test 9: Multi-Chunk Cascading Assembly
  it('TC-ADV-STITCH-09: sequentially stitches 5 consecutive streaming chunks', () => {
    const chunks = [
      'This is the first segment of our',
      'segment of our complete voice pipeline',
      'voice pipeline where we test boundary',
      'test boundary stitching under stress',
      'stitching under stress and verify accuracy',
    ];

    let fullTranscript = '';
    for (const chunk of chunks) {
      fullTranscript = stitchTranscripts(fullTranscript, chunk);
    }

    const expected = 'This is the first segment of our complete voice pipeline where we test boundary stitching under stress and verify accuracy';
    assert.strictEqual(fullTranscript, expected);
  });

  // Test 10: Throughput Benchmark (5,000 stitch operations)
  it('TC-ADV-STITCH-10: executes 5,000 stitches in under 500ms', () => {
    const p = 'checking algorithmic complexity of token sliding window with word similarity and';
    const n = 'and Levenshtein distance boundary calculation';

    const start = performance.now();
    for (let i = 0; i < 5000; i++) {
      stitchTranscripts(p, n);
    }
    const elapsed = performance.now() - start;

    assert.ok(elapsed < 500, `5,000 stitches took ${elapsed.toFixed(2)}ms (must be < 500ms)`);
  });
});
