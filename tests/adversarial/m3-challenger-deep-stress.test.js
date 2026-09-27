// Independent Empirical Challenger Stress Suite: Features 10, 11, 12 Remediation
// Focuses on:
// 1. Boundary matching in CONTEXT_RULES.formal.titleRegex (\b) preventing false-positives
// 2. Voice commands evaluation under high load with pre-compiled regex cache
// 3. Custom voice command isolation and action normalization

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { performance } = require('perf_hooks');

const {
  classifyTargetWindow,
  buildPolishingPrompt,
  applyVoiceCommands,
  DEFAULT_PERSONAS,
  DEFAULT_COMMANDS,
  VoiceCommandEngine,
} = require('../../src/text-utils');

describe('Challenger Stress Suite 1: Title Regex Word Boundary Validation (Feature 10)', () => {
  it('TC-CHAL-01: prevents false-positive formal classification for React Documentation and 1Password Vault', () => {
    const targets = [
      { exe: 'chrome.exe', title: 'React Documentation' },
      { exe: 'msedge.exe', title: 'React Documentation - Getting Started' },
      { exe: 'firefox.exe', title: '1Password Vault' },
      { exe: 'chrome.exe', title: '1Password Vault - Personal' },
      { exe: 'browser.exe', title: '1Password Extension' },
    ];

    for (const t of targets) {
      const res = classifyTargetWindow(t);
      assert.strictEqual(
        res.category,
        'general',
        `Expected 'general' for title '${t.title}', but got '${res.category}'`
      );
    }
  });

  it('TC-CHAL-02: verifies all 15 formal keywords embedded as substrings do not trigger formal classification', () => {
    // Keywords in formal.titleRegex:
    // outlook, word, excel, powerpoint, thunderbird, document, inbox, draft, mail, spreadsheet, presentation, memo, report, notes, overleaf
    const substringTests = [
      // outlook
      { title: 'lookout mountain park guide', expected: 'general' },
      // word
      { title: 'crossword daily puzzle', expected: 'general' },
      { title: 'catchword marketing analysis', expected: 'general' },
      { title: 'passwordless authentication system', expected: 'general' },
      { title: 'foreword to the biography', expected: 'general' },
      { title: 'afterword and conclusions', expected: 'general' },
      { title: 'sword art online streaming', expected: 'general' },
      // excel
      { title: 'excellent adventures documentary', expected: 'general' },
      { title: 'center of excellence portal', expected: 'general' },
      // powerpoint
      { title: 'powerpointer clicker driver', expected: 'general' },
      // thunderbird
      { title: 'thunderbirds retro series', expected: 'general' },
      // document
      { title: 'Vue Documentation - Mozilla Firefox', expected: 'general' },
      { title: 'Python Documentation Portal', expected: 'general' },
      { title: 'documentary film showcase', expected: 'general' },
      { title: 'undocumented operating system APIs', expected: 'general' },
      { title: 'documenting code practices', expected: 'general' },
      // inbox
      { title: 'inboxing matches highlights', expected: 'general' },
      // draft
      { title: 'draftsman drafting tools review', expected: 'general' },
      { title: 'updraft velocity measurements', expected: 'general' },
      // mail
      { title: 'blackmail extortion case studies', expected: 'general' },
      { title: 'snailmail delivery schedules', expected: 'general' },
      { title: 'mailbox settings configuration', expected: 'general' },
      { title: 'chainmail armor replica', expected: 'general' },
      // spreadsheet
      { title: 'spreadsheets comparison article', expected: 'general' },
      // presentation
      { title: 'representational state transfer', expected: 'general' },
      // memo
      { title: 'memory management in rust', expected: 'general' },
      { title: 'memoirs of a philosopher', expected: 'general' },
      { title: 'memorandum archive (internal)', expected: 'general' },
      { title: 'memorial day observance', expected: 'general' },
      // report
      { title: 'reportage photography gallery', expected: 'general' },
      { title: 'unreported income auditing', expected: 'general' },
      // notes
      { title: 'banknotes of the united kingdom', expected: 'general' },
      { title: 'footnotes indexing plugin', expected: 'general' },
      { title: 'keynotes speaker biography', expected: 'general' },
      // overleaf
      { title: 'cloverleaf intersection design', expected: 'general' },
    ];

    for (const st of substringTests) {
      const res = classifyTargetWindow({ exe: 'browser.exe', title: st.title });
      assert.strictEqual(
        res.category,
        st.expected,
        `False-positive formal classification triggered for substring in '${st.title}'`
      );
    }
  });

  it('TC-CHAL-03: verifies standalone formal keywords with various punctuation, delimiters, and casings match formal', () => {
    const positiveFormalTitles = [
      'My Document - Word',
      'Quarterly Report [Final]',
      'Weekly Team Notes (2026)',
      'Confidential Memo: Budget Cuts',
      'Draft of Legal Contract',
      'Financial Spreadsheet - Revenue',
      'Sales Presentation - Q3 Review',
      'Outlook - yeamin@company.com',
      'Thunderbird - Local Folders',
      'Inbox (4) - Webmail',
      'Overleaf - Academic Paper Draft',
      'Annual Report; Approved',
      'Word - Document1.docx',
      'Excel - BalanceSheet.xlsx',
      'PowerPoint - PitchDeck.pptx',
      'Check Mail now',
      'Drafting memo for staff',
    ];

    for (const title of positiveFormalTitles) {
      const res = classifyTargetWindow({ exe: 'chrome.exe', title });
      assert.strictEqual(
        res.category,
        'formal',
        `Expected formal classification for '${title}', but got '${res.category}'`
      );
    }
  });

  it('TC-CHAL-04: verifies priority hierarchy when code or chat keywords coexist with formal words', () => {
    // Code should take precedence over formal
    const codeWithFormal = { exe: 'code.exe', title: 'report.py - Visual Studio Code' };
    assert.strictEqual(classifyTargetWindow(codeWithFormal).category, 'code');

    const terminalWithFormal = { exe: 'powershell.exe', title: 'generate-report.ps1' };
    assert.strictEqual(classifyTargetWindow(terminalWithFormal).category, 'code');

    // Chat should take precedence over formal
    const chatWithFormal = { exe: 'slack.exe', title: '#quarterly-report-discussion' };
    assert.strictEqual(classifyTargetWindow(chatWithFormal).category, 'chat');
  });
});

describe('Challenger Stress Suite 2: Voice Command Load & Regex Cache (Feature 12)', () => {
  it('TC-CHAL-05: pre-compiles regex cache during setCommands and maintains object identity across 1,000 evaluations', () => {
    const engine = new VoiceCommandEngine(DEFAULT_COMMANDS);
    assert.ok(engine.regexRules.length > 0, 'regexRules must be populated');

    // Snapshot RegExp object references
    const cachedReferences = engine.regexRules.map(r => r.regex);

    for (let i = 0; i < 1000; i++) {
      engine.evaluate('dictated sentence with comma and new line');
      engine.evaluate('new paragraph');
      engine.evaluate('scratch that');
      engine.evaluate('completely unrelated speech utterance');
    }

    // References must be strictly identical (no re-compilation in evaluate loop)
    for (let i = 0; i < engine.regexRules.length; i++) {
      assert.strictEqual(
        engine.regexRules[i].regex,
        cachedReferences[i],
        `RegExp at index ${i} was recompiled or replaced`
      );
    }
  });

  it('TC-CHAL-06: sustained high-throughput stress: evaluates 500 custom commands against 2,000 utterances with < 0.1ms average latency', () => {
    // Generate 500 unique commands
    const largeCommandSet = [];
    for (let i = 0; i < 500; i++) {
      largeCommandSet.push({
        id: `cmd_stress_${i}`,
        trigger: `custom macro trigger phrase number ${i}`,
        action: i % 2 === 0 ? 'replace-text' : 'replace',
        replacement: `replaced value ${i}`,
        text: `replaced value ${i}`,
        enabled: true,
      });
    }

    const engine = new VoiceCommandEngine(largeCommandSet);
    assert.strictEqual(engine.exactMap.size, 500);
    assert.strictEqual(engine.regexRules.length, 500);

    const testUtterances = [
      'custom macro trigger phrase number 42',
      'custom macro trigger phrase number 499.',
      'custom macro trigger phrase number 0!',
      'This is standard conversational speech without any macro trigger.',
      'Please run custom macro trigger phrase number 10 mid sentence.',
    ];

    const iterations = 400; // 400 * 5 = 2,000 evaluations
    const totalEvals = iterations * testUtterances.length;

    // Warm-up
    for (const u of testUtterances) engine.evaluate(u);

    const start = performance.now();
    for (let i = 0; i < iterations; i++) {
      for (let j = 0; j < testUtterances.length; j++) {
        engine.evaluate(testUtterances[j]);
      }
    }
    const elapsed = performance.now() - start;
    const avgLatencyMs = elapsed / totalEvals;

    assert.ok(
      avgLatencyMs < 0.1,
      `Average latency was ${avgLatencyMs.toFixed(4)}ms, must be < 0.1ms under sustained load`
    );
  });

  it('TC-CHAL-07: verifies regex rules evaluate when exact map misses (e.g. whitespace, punctuation variations)', () => {
    const customCommands = [
      { trigger: 'deploy service', action: 'replace-text', text: 'DEPLOY_TRIGGERED', enabled: true },
    ];
    const engine = new VoiceCommandEngine(customCommands);

    // Exact match
    const exact = engine.evaluate('deploy service');
    assert.strictEqual(exact.command, true);
    assert.strictEqual(exact.text, 'DEPLOY_TRIGGERED');

    // Trailing punctuation matching via pre-compiled regex rule
    const withPunct = engine.evaluate('  deploy service,  ');
    assert.strictEqual(withPunct.command, true);
    assert.strictEqual(withPunct.text, 'DEPLOY_TRIGGERED');

    const withPeriod = engine.evaluate('deploy service.');
    assert.strictEqual(withPeriod.command, true);
    assert.strictEqual(withPeriod.text, 'DEPLOY_TRIGGERED');

    // Substring / mid-sentence must NOT match
    const midSentence = engine.evaluate('Please deploy service right now');
    assert.strictEqual(midSentence.command, false);
    assert.notStrictEqual(midSentence.text, 'DEPLOY_TRIGGERED');
  });
});

describe('Challenger Stress Suite 3: Custom Command Isolation & Action Normalization', () => {
  it('TC-CHAL-08: verifies applyVoiceCommands uses ephemeral engine and never mutates module singleton state', () => {
    const custom = [
      { trigger: 'temporary command', action: 'replace', replacement: 'TEMP_SUCCESS', enabled: true },
    ];

    // Call 1: With custom commands
    const res1 = applyVoiceCommands('temporary command', custom);
    assert.strictEqual(res1.command, true);
    assert.strictEqual(res1.text, 'TEMP_SUCCESS');

    // Call 2: Default invocation must NOT have 'temporary command'
    const res2 = applyVoiceCommands('temporary command');
    assert.strictEqual(res2.command, false);
    assert.strictEqual(res2.text, 'temporary command');

    // Call 3: Default command still works
    const res3 = applyVoiceCommands('new paragraph');
    assert.strictEqual(res3.command, true);
    assert.strictEqual(res3.text, '\n\n');

    // Call 4: Another custom command invocation does not see previous custom command
    const otherCustom = [
      { trigger: 'other command', action: 'replace', replacement: 'OTHER', enabled: true },
    ];
    const res4 = applyVoiceCommands('temporary command', otherCustom);
    assert.strictEqual(res4.command, false);

    const res5 = applyVoiceCommands('other command', otherCustom);
    assert.strictEqual(res5.command, true);
    assert.strictEqual(res5.text, 'OTHER');
  });

  it('TC-CHAL-09: verifies complete normalization of action variants and property names', () => {
    const variedCommands = [
      // Action: replace with replacement
      { trigger: 'macro one', action: 'replace', replacement: 'VAL_1', enabled: true },
      // Action: replace-text with text
      { trigger: 'macro two', action: 'replace-text', text: 'VAL_2', enabled: true },
      // Action: replace_text with replacement
      { trigger: 'macro three', action: 'replace_text', replacement: 'VAL_3', enabled: true },
      // Action: new_line (underscore)
      { trigger: 'line break', action: 'new_line', enabled: true },
      // Action: new-line (kebab)
      { trigger: 'break line', action: 'new-line', enabled: true },
      // Action: new_paragraph
      { trigger: 'para break', action: 'new_paragraph', enabled: true },
      // Action: scratch_that
      { trigger: 'wipe that', action: 'scratch_that', enabled: true },
      // Action: custom_action with customAction field
      { trigger: 'run script', action: 'custom_action', customAction: 'execute_build', enabled: true },
      // Action: delete_word
      { trigger: 'kill word', action: 'delete_word', enabled: true },
    ];

    const engine = new VoiceCommandEngine(variedCommands);

    assert.deepStrictEqual(engine.evaluate('macro one'), { text: 'VAL_1', command: true, scratch: false, action: null });
    assert.deepStrictEqual(engine.evaluate('macro two'), { text: 'VAL_2', command: true, scratch: false, action: null });
    assert.deepStrictEqual(engine.evaluate('macro three'), { text: 'VAL_3', command: true, scratch: false, action: null });
    assert.deepStrictEqual(engine.evaluate('line break'), { text: '\n', command: true, scratch: false, action: null });
    assert.deepStrictEqual(engine.evaluate('break line'), { text: '\n', command: true, scratch: false, action: null });
    assert.deepStrictEqual(engine.evaluate('para break'), { text: '\n\n', command: true, scratch: false, action: null });
    assert.deepStrictEqual(engine.evaluate('wipe that'), { text: '', command: true, scratch: true, action: null });
    assert.deepStrictEqual(engine.evaluate('run script'), { text: '', command: true, scratch: false, action: 'execute_build' });
    assert.deepStrictEqual(engine.evaluate('kill word'), { text: '', command: true, scratch: false, action: 'delete-word' });
  });

  it('TC-CHAL-10: handles disabled, malformed, and empty custom commands safely', () => {
    // Test empty array falls back to DEFAULT_COMMANDS
    const emptyEngine = new VoiceCommandEngine([]);
    assert.strictEqual(emptyEngine.evaluate('new line').command, true);

    // Test malformed/disabled array registers 0 active rules
    const malformed = [
      null,
      undefined,
      {},
      { trigger: '', action: 'replace', text: 'empty trigger' },
      { trigger: 'disabled trigger', action: 'replace', text: 'should not run', enabled: false },
      { trigger: '   ', action: 'replace', text: 'whitespace trigger', enabled: true },
    ];

    const engine = new VoiceCommandEngine(malformed);
    assert.strictEqual(engine.exactMap.size, 0);
    assert.strictEqual(engine.regexRules.length, 0);

    const disabledRes = engine.evaluate('disabled trigger');
    assert.strictEqual(disabledRes.command, false);

    // Because this engine was given an explicit non-empty list of commands (all disabled),
    // it does not have built-in commands
    const nlRes = engine.evaluate('new line');
    assert.strictEqual(nlRes.command, false);
  });

  it('TC-CHAL-11: verifies custom commands can safely override default commands within their engine instance', () => {
    const overriding = [
      { trigger: 'new line', action: 'replace', replacement: 'CUSTOM_NEW_LINE', enabled: true },
      { trigger: 'scratch that', action: 'replace', replacement: 'NOT_SCRATCH', enabled: true },
    ];

    const engine = new VoiceCommandEngine(overriding);

    const nlRes = engine.evaluate('new line');
    assert.strictEqual(nlRes.command, true);
    assert.strictEqual(nlRes.text, 'CUSTOM_NEW_LINE');
    assert.strictEqual(nlRes.scratch, false);

    const stRes = engine.evaluate('scratch that');
    assert.strictEqual(stRes.command, true);
    assert.strictEqual(stRes.text, 'NOT_SCRATCH');
    assert.strictEqual(stRes.scratch, false);

    // Global defaultEngine remains untouched
    const defaultNL = applyVoiceCommands('new line');
    assert.strictEqual(defaultNL.text, '\n');
    const defaultST = applyVoiceCommands('scratch that');
    assert.strictEqual(defaultST.scratch, true);
  });
});
