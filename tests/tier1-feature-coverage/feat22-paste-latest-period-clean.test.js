// Tier 1 - Feature 22: Non-Sentence Period Truncation & Paste Latest Dictation
const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  formatText,
  cleanTrailingPeriod,
  shouldHaveTrailingPeriod,
} = require('../../src/text-utils');

describe('Tier 1 - Feature 22: Non-Sentence Period Truncation & Paste Latest Dictation', () => {
  it('TC-T1-F22-01: formatText leaves single words without trailing period', () => {
    assert.strictEqual(formatText('submit'), 'Submit');
    assert.strictEqual(formatText('cancel'), 'Cancel');
    assert.strictEqual(formatText('hello'), 'Hello');
    assert.strictEqual(formatText('react'), 'React');
    assert.strictEqual(formatText('yes'), 'Yes');
    assert.strictEqual(formatText('no'), 'No');
  });

  it('TC-T1-F22-02: cleanTrailingPeriod strips trailing period from single words and standalone labels', () => {
    assert.strictEqual(cleanTrailingPeriod('Submit.'), 'Submit');
    assert.strictEqual(cleanTrailingPeriod('Cancel.'), 'Cancel');
    assert.strictEqual(cleanTrailingPeriod('Hello.'), 'Hello');
    assert.strictEqual(cleanTrailingPeriod('Save changes.'), 'Save changes');
    assert.strictEqual(cleanTrailingPeriod('Username.'), 'Username');
    assert.strictEqual(cleanTrailingPeriod('Next button.'), 'Next button');
  });

  it('TC-T1-F22-03: cleanTrailingPeriod preserves trailing periods on complete sentences', () => {
    assert.strictEqual(cleanTrailingPeriod('This is a test.'), 'This is a test.');
    assert.strictEqual(cleanTrailingPeriod('We are deploying to production today.'), 'We are deploying to production today.');
    assert.strictEqual(cleanTrailingPeriod('I agree.'), 'I agree.');
  });

  it('TC-T1-F22-04: cleanTrailingPeriod preserves question marks, exclamation marks, and ellipses', () => {
    assert.strictEqual(cleanTrailingPeriod('Hello?'), 'Hello?');
    assert.strictEqual(cleanTrailingPeriod('Stop!'), 'Stop!');
    assert.strictEqual(cleanTrailingPeriod('Loading...'), 'Loading...');
  });

  it('TC-T1-F22-05: shouldHaveTrailingPeriod correctly distinguishes sentences from non-sentences', () => {
    assert.strictEqual(shouldHaveTrailingPeriod('word'), false);
    assert.strictEqual(shouldHaveTrailingPeriod('first name'), false);
    assert.strictEqual(shouldHaveTrailingPeriod('this works'), true);
    assert.strictEqual(shouldHaveTrailingPeriod('it failed'), true);
    assert.strictEqual(shouldHaveTrailingPeriod('this is a complete sentence'), true);
  });
});
