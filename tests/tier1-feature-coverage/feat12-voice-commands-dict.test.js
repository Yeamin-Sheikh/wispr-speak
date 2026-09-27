// Tier 1 - Feature 12: Voice Commands Dictionary UI
// Verifies voice commands execution, custom dictionary triggers, action mapping, and enabled toggling.
const { describe, it } = require('node:test');
const assert = require('node:assert');
const { applyVoiceCommands } = require('../../src/text-utils');

// Extended voice command processor modeling custom commands dictionary
function executeVoiceCommandsExtended(text, customCommands = []) {
  const trimmed = String(text).trim();
  const low = trimmed.toLowerCase().replace(/[.!?]$/, '');

  // 1. Check custom commands table first
  for (const cmd of customCommands) {
    if (!cmd || cmd.enabled === false) continue;
    const trigger = String(cmd.trigger).trim().toLowerCase();
    if (!trigger) continue;

    if (low === trigger) {
      if (cmd.action === 'replace-text') {
        return { text: cmd.text || '', command: true, scratch: false, action: null };
      }
      if (cmd.action === 'new-line') {
        return { text: '\n', command: true, scratch: false, action: null };
      }
      if (cmd.action === 'new-paragraph') {
        return { text: '\n\n', command: true, scratch: false, action: null };
      }
      if (cmd.action === 'scratch-that') {
        return { text: '', command: true, scratch: true, action: null };
      }
      if (cmd.action === 'custom-action') {
        return { text: '', command: true, scratch: false, action: cmd.customAction };
      }
    }
  }

  // 2. Fall back to built-in commands
  return applyVoiceCommands(text);
}

describe('Tier 1 - Feature 12: Voice Commands Dictionary UI', () => {
  it('TC-T1-F12-01: executes built-in "new paragraph" command returning double newline', () => {
    const res = applyVoiceCommands('new paragraph');
    assert.strictEqual(res.command, true);
    assert.strictEqual(res.text, '\n\n');
  });

  it('TC-T1-F12-02: executes built-in "scratch that" command signaling deletion', () => {
    const res = applyVoiceCommands('scratch that');
    assert.strictEqual(res.command, true);
    assert.strictEqual(res.scratch, true);
    assert.strictEqual(res.text, '');
  });

  it('TC-T1-F12-03: matches custom user command and replaces with configured text snippet', () => {
    const customCommands = [
      { trigger: 'my email address', action: 'replace-text', text: 'yeamin@example.com', enabled: true },
      { trigger: 'insert signature', action: 'replace-text', text: 'Best regards,\nYeamin Sheikh', enabled: true }
    ];

    const res = executeVoiceCommandsExtended('my email address', customCommands);
    assert.strictEqual(res.command, true);
    assert.strictEqual(res.text, 'yeamin@example.com');
  });

  it('TC-T1-F12-04: ignores disabled voice command and transcribes as standard speech', () => {
    const customCommands = [
      { trigger: 'submit order', action: 'replace-text', text: 'ORDER_CONFIRMED', enabled: false }
    ];

    const res = executeVoiceCommandsExtended('submit order', customCommands);
    assert.strictEqual(res.command, false);
    assert.strictEqual(res.text, 'submit order');
  });

  it('TC-T1-F12-05: parses inline punctuation words into typographical symbols', () => {
    const res = applyVoiceCommands('hello comma how are you question mark');
    assert.strictEqual(res.command, false);
    assert.strictEqual(res.text, 'hello, how are you?');
  });
});
