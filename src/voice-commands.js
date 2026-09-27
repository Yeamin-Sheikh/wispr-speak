// Voice commands engine with pre-compiled regex cache and action dispatch.

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const DEFAULT_COMMANDS = [
  { id: 'cmd_1', trigger: 'new line', action: 'new-line', text: '\n', enabled: true, builtin: true },
  { id: 'cmd_2', trigger: 'next line', action: 'new-line', text: '\n', enabled: true, builtin: true },
  { id: 'cmd_3', trigger: 'new paragraph', action: 'new-paragraph', text: '\n\n', enabled: true, builtin: true },
  { id: 'cmd_4', trigger: 'next paragraph', action: 'new-paragraph', text: '\n\n', enabled: true, builtin: true },
  { id: 'cmd_5', trigger: 'scratch that', action: 'scratch-that', text: '', enabled: true, builtin: true },
  { id: 'cmd_6', trigger: 'delete that', action: 'scratch-that', text: '', enabled: true, builtin: true },
  { id: 'cmd_7', trigger: 'undo that', action: 'undo', text: '', enabled: true, builtin: true },
  { id: 'cmd_8', trigger: 'delete word', action: 'delete-word', text: '', enabled: true, builtin: true },
  { id: 'cmd_9', trigger: 'delete sentence', action: 'delete-sentence', text: '', enabled: true, builtin: true },
  { id: 'cmd_10', trigger: 'select all', action: 'select-all', text: '', enabled: true, builtin: true },
  { id: 'cmd_11', trigger: 'copy that', action: 'copy', text: '', enabled: true, builtin: true },
  { id: 'cmd_12', trigger: 'paste that', action: 'paste', text: '', enabled: true, builtin: true },
  { id: 'cmd_13', trigger: 'quote that', action: 'quote-that', text: '', enabled: true, builtin: true },
  { id: 'cmd_14', trigger: 'press enter', action: 'enter', text: '\n', enabled: true, builtin: true },
];

const PUNCTUATION_MAP = {
  'comma': ',',
  'period': '.',
  'full stop': '.',
  'question mark': '?',
  'exclamation mark': '!',
  'exclamation point': '!',
  'colon': ':',
  'semicolon': ';',
  'dash': ' - ',
  'hyphen': ' - ',
  'ellipsis': '...',
};

const INLINE_PUNCT = [
  [/(\s|^)(?:comma)(?=[.,!?;:\s]|$)/gi, ','],
  [/(\s|^)(?:full stop|period)(?=[.,!?;:\s]|$)/gi, '.'],
  [/(\s|^)(?:question mark)(?=[.,!?;:\s]|$)/gi, '?'],
  [/(\s|^)(?:exclamation(?: mark| point)?)(?=[.,!?;:\s]|$)/gi, '!'],
  [/(\s|^)(?:colon)(?=[.,!?;:\s]|$)/gi, ':'],
  [/(\s|^)(?:semicolon)(?=[.,!?;:\s]|$)/gi, ';'],
  [/(\s|^)(?:dash|hyphen)(?=[.,!?;:\s]|$)/gi, ' - '],
  [/(\s|^)(?:ellipsis|dot dot dot)(?=[.,!?;:\s]|$)/gi, '...'],
  [/(\s|^)(?:open quote|open quotation)(?=[.,!?;:\s]|$)/gi, ' "'],
  [/(\s|^)(?:close quote|close quotation)(?=[.,!?;:\s]|$)/gi, '" '],
];

class VoiceCommandEngine {
  constructor(commands = DEFAULT_COMMANDS) {
    this.exactMap = new Map();
    this.regexRules = [];
    this.setCommands(commands);
  }

  setCommands(commands = []) {
    this.exactMap.clear();
    this.regexRules = [];

    const activeList = Array.isArray(commands) && commands.length > 0 ? commands : DEFAULT_COMMANDS;

    for (const cmd of activeList) {
      if (!cmd || typeof cmd !== 'object' || cmd.enabled === false) continue;
      const rawTrigger = String(cmd.trigger || '').trim().toLowerCase().replace(/[.!?]+$/, '');
      if (!rawTrigger) continue;

      this.exactMap.set(rawTrigger, cmd);
      const escaped = escapeRegExp(rawTrigger);
      this.regexRules.push({
        cmd,
        regex: new RegExp('^\\s*' + escaped + '[\\s.!?,:;]*$', 'i'),
      });
    }
  }

  evaluate(text, customCommands = null) {
    if (customCommands && Array.isArray(customCommands)) {
      this.setCommands(customCommands);
    }

    const raw = String(text || '').trim();
    if (!raw) {
      return { text: '', command: false, scratch: false, action: null };
    }

    const low = raw.toLowerCase().replace(/[.!?]+$/, '');

    // 1. Instant Map lookup for whole-phrase triggers
    const exactMatch = this.exactMap.get(low);
    if (exactMatch) {
      return this._formatResult(exactMatch);
    }

    // 2. Query pre-compiled regex rules when exact map does not match
    for (const rule of this.regexRules) {
      if (rule.regex.test(raw) || rule.regex.test(low)) {
        return this._formatResult(rule.cmd);
      }
    }

    // 3. Whole punctuation spoken word
    if (PUNCTUATION_MAP[low] !== undefined) {
      return { text: PUNCTUATION_MAP[low], command: true, scratch: false, action: null };
    }

    // 4. Fallback to inline command substitutions and punctuation formatting
    return this._formatInlineSpeech(raw);
  }

  _formatResult(cmd) {
    const act = (cmd.action || '').toLowerCase().replace(/_/g, '-');
    const text = cmd.text !== undefined ? cmd.text : (cmd.replacement || '');
    if (act === 'replace-text' || act === 'replace') {
      return { text, command: true, scratch: false, action: null };
    }
    if (act === 'new-line') {
      return { text: '\n', command: true, scratch: false, action: null };
    }
    if (act === 'new-paragraph') {
      return { text: '\n\n', command: true, scratch: false, action: null };
    }
    if (act === 'scratch-that') {
      return { text: '', command: true, scratch: true, action: null };
    }
    if (act === 'custom-action') {
      return { text: '', command: true, scratch: false, action: cmd.customAction || 'custom' };
    }
    return { text, command: true, scratch: false, action: act };
  }

  _formatInlineSpeech(text) {
    let out = ' ' + text + ' ';

    for (const [re, sym] of INLINE_PUNCT) {
      out = out.replace(re, sym);
    }

    out = out.replace(/\s+([,.;:?!])/g, '$1');
    out = out.replace(/([?!])([.,;:]+)/g, '$1');
    out = out.replace(/([.,;:])([?!]+)/g, '$2');
    out = out.replace(/([,;])([.]+)/g, '$2');
    out = out.replace(/([,;:?!])(?=[A-Za-z0-9])/g, '$1 ');
    out = out.trim().replace(/\s+/g, ' ');

    out = out.replace(/\s+new paragraph\s+/gi, '\n\n').replace(/\s+new line\s+/gi, '\n');

    return { text: out, command: false, scratch: false, action: null };
  }
}

module.exports = {
  VoiceCommandEngine,
  DEFAULT_COMMANDS,
  escapeRegExp,
};
