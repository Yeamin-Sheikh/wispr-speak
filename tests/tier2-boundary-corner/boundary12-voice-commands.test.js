// Tier 2 - Boundary 12: Voice Commands Dictionary UI Boundary Cases
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { performance } = require('perf_hooks');
const { applyVoiceCommands } = require('../../src/text-utils');

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchCustomVoiceCommand(spokenText, command) {
  if (!command || !command.trigger || command.enabled === false) return null;
  const triggerClean = command.trigger.trim().toLowerCase();
  const textClean = spokenText.trim().toLowerCase().replace(/[.!?]$/, '');

  // Exact whole-phrase match
  if (textClean === triggerClean) {
    return { matched: true, action: command.action, text: command.text };
  }

  // Regex boundary match with special characters properly escaped
  const escapedTrigger = escapeRegExp(triggerClean);
  const regex = new RegExp(`(^|\\s)${escapedTrigger}(\\s|$)`, 'i');
  if (regex.test(textClean)) {
    return { matched: true, action: command.action, text: command.text };
  }

  return null;
}

describe('Tier 2 - Boundary 12: Voice Commands Dictionary UI Boundary Cases', () => {
  it('TC-T2-B12-01: escapes regex special characters in custom trigger without crashing RegExp', () => {
    const command = { trigger: 'fix [bug] (urgent)', action: 'replace-text', text: 'HIGH PRIORITY BUG', enabled: true };
    assert.doesNotThrow(() => {
      const match = matchCustomVoiceCommand('fix [bug] (urgent)', command);
      assert.ok(match && match.matched);
    });
  });

  it('TC-T2-B12-02: prevents substring false positive for whole-phrase voice commands', () => {
    // "scratch that" should trigger scratch
    // "I would like to scratch that scratchy dog" should NOT trigger scratch
    const resWhole = applyVoiceCommands('scratch that');
    assert.strictEqual(resWhole.scratch, true);

    const resSubstring = applyVoiceCommands('I want to scratch that cat');
    assert.strictEqual(resSubstring.scratch, false);
    assert.ok(resSubstring.text.includes('scratch that'));
  });

  it('TC-T2-B12-03: matches spoken command even when accompanied by trailing punctuation', () => {
    const res = applyVoiceCommands('new paragraph.');
    assert.strictEqual(res.command, true);
    assert.strictEqual(res.text, '\n\n');
  });

  it('TC-T2-B12-04: rejects command with empty trigger string safely', () => {
    const invalidCommand = { trigger: '   ', action: 'replace-text', text: 'something', enabled: true };
    const match = matchCustomVoiceCommand('hello', invalidCommand);
    assert.strictEqual(match, null);
  });

  it('TC-T2-B12-05: evaluates list of 100 commands in under 10ms', () => {
    const commands = [];
    for (let i = 0; i < 100; i++) {
      commands.push({ trigger: `command number ${i}`, action: 'replace-text', text: `CMD_${i}`, enabled: true });
    }

    const startTime = performance.now();
    let found = null;
    for (const cmd of commands) {
      const res = matchCustomVoiceCommand('command number 77', cmd);
      if (res) {
        found = res;
        break;
      }
    }
    const duration = performance.now() - startTime;

    assert.ok(found);
    assert.strictEqual(found.text, 'CMD_77');
    assert.ok(duration < 10, `Evaluation took ${duration}ms, must be < 10ms`);
  });
});
