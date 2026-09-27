// Tier 1 - Feature 10: Context-Aware Smart Polish
// Verifies target window detection parsing, application classification, and prompt style adaptation.
const { describe, it } = require('node:test');
const assert = require('node:assert');

class ContextClassifier {
  static parseDetectOutput(rawOutput) {
    const lines = rawOutput.trim().split('\n');
    const info = {};
    for (const line of lines) {
      const match = line.match(/^([A-Z_]+)\s+(.*)$/);
      if (match) {
        info[match[1]] = match[2].trim();
      }
    }
    return {
      hwnd: info.TARGET || null,
      windowClass: info.WINDOW_CLASS || null,
      exe: info.EXE_NAME || null,
      title: info.WINDOW_TITLE || null
    };
  }

  static classifyContext(targetInfo) {
    const exe = (targetInfo.exe || '').toLowerCase();
    const title = (targetInfo.title || '').toLowerCase();

    // Code editors & terminals
    if (/code\.exe|cursor\.exe|devenv\.exe|sublime_text\.exe|windowsterminal\.exe|powershell\.exe|cmd\.exe/.test(exe) ||
        /\.js|\.ts|\.py|\.cpp|\.cs|visual studio code/.test(title)) {
      return { category: 'code', persona: 'Code', styleInstruction: 'Use technical formatting, preserve code symbols, use camelCase for identifiers where appropriate.' };
    }

    // Chat and messaging
    if (/slack\.exe|discord\.exe|teams\.exe|telegram\.exe|whatsapp\.exe/.test(exe)) {
      return { category: 'chat', persona: 'Natural', styleInstruction: 'Use casual, conversational phrasing. Contractions are welcome. Keep it direct and friendly.' };
    }

    // Email and formal docs
    if (/outlook\.exe|winword\.exe|excel\.exe|thunderbird\.exe/.test(exe) || /mail|document|inbox/.test(title)) {
      return { category: 'formal', persona: 'Formal', styleInstruction: 'Use professional business tone, complete grammatical sentences, and polished vocabulary.' };
    }

    // Default general context
    return { category: 'general', persona: 'Natural', styleInstruction: 'Fix grammar, remove speech fillers, and format cleanly.' };
  }

  static buildPolishingPrompt(contextCategory, userRawText) {
    const context = this.classifyContext(contextCategory);
    return {
      systemPrompt: `You are an expert voice-to-text editor. ${context.styleInstruction}`,
      userMessage: userRawText,
      category: context.category
    };
  }
}

describe('Tier 1 - Feature 10: Context-Aware Smart Polish', () => {
  it('TC-T1-F10-01: parses native window detection output accurately', () => {
    const rawOutput = 'TARGET 000000000002037C\nWINDOW_CLASS Chrome_WidgetWin_1\nEXE_NAME Code.exe\nWINDOW_TITLE main.js - wispr-tell - Visual Studio Code';
    const parsed = ContextClassifier.parseDetectOutput(rawOutput);

    assert.strictEqual(parsed.hwnd, '000000000002037C');
    assert.strictEqual(parsed.windowClass, 'Chrome_WidgetWin_1');
    assert.strictEqual(parsed.exe, 'Code.exe');
    assert.strictEqual(parsed.title, 'main.js - wispr-tell - Visual Studio Code');
  });

  it('TC-T1-F10-02: classifies VS Code / Cursor as code context with technical instructions', () => {
    const target = { exe: 'Code.exe', title: 'test.py' };
    const context = ContextClassifier.classifyContext(target);

    assert.strictEqual(context.category, 'code');
    assert.strictEqual(context.persona, 'Code');
    assert.ok(context.styleInstruction.includes('camelCase') || context.styleInstruction.includes('technical'));
  });

  it('TC-T1-F10-03: classifies Slack and Discord as conversational chat context', () => {
    const target = { exe: 'slack.exe', title: '#general - Workspace' };
    const context = ContextClassifier.classifyContext(target);

    assert.strictEqual(context.category, 'chat');
    assert.ok(context.styleInstruction.includes('casual') || context.styleInstruction.includes('conversational'));
  });

  it('TC-T1-F10-04: classifies Outlook and Word as formal professional context', () => {
    const target = { exe: 'OUTLOOK.EXE', title: 'Inbox - user@company.com' };
    const context = ContextClassifier.classifyContext(target);

    assert.strictEqual(context.category, 'formal');
    assert.strictEqual(context.persona, 'Formal');
    assert.ok(context.styleInstruction.includes('professional'));
  });

  it('TC-T1-F10-05: generates LLM prompt payload with appropriate system instructions', () => {
    const target = { exe: 'notepad.exe', title: 'Untitled' };
    const payload = ContextClassifier.buildPolishingPrompt(target, 'um i think we should test this');

    assert.strictEqual(payload.category, 'general');
    assert.strictEqual(payload.userMessage, 'um i think we should test this');
    assert.ok(payload.systemPrompt.includes('voice-to-text editor'));
  });
});
