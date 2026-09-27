// Wispr Tell text utilities.
const { VoiceCommandEngine, DEFAULT_COMMANDS, escapeRegExp } = require('./voice-commands');

const defaultEngine = new VoiceCommandEngine(DEFAULT_COMMANDS);

const FILLERS = /\b(um|uh|er|ah|like|you know)\b[, ]*/gi;

function formatText(raw) {
  let t = String(raw).replace(FILLERS, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  t = t.charAt(0).toUpperCase() + t.slice(1);

  // Intent detection: if speaker ends with "or" as an open question, format as ", or?"
  if (/\b(or)\s*$/i.test(t)) {
    t = t.replace(/\s*,\s*or\s*$/i, ', or?').replace(/\s+or\s*$/i, ', or?');
  } else if (!/[.!?…]$/.test(t) && !t.endsWith('...')) {
    t += '.';
  }
  return t;
}

// Spoken punctuation to symbols with intent recognition
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

function applyInlinePunctuation(t) {
  let s = ' ' + String(t) + ' ';
  for (const [re, sym] of INLINE_PUNCT) s = s.replace(re, sym);

  // Spacing cleanup
  s = s.replace(/\s+([,.;:?!])/g, '$1');

  // Prevent conflicting duplicate punctuation
  s = s.replace(/([?!])([.,;:]+)/g, '$1');
  s = s.replace(/([.,;:])([?!]+)/g, '$2');
  s = s.replace(/([,;])([.]+)/g, '$2');

  // Space after punctuation before letters/numbers
  s = s.replace(/([,;:?!])(?=[A-Za-z0-9])/g, '$1 ');

  return s.trim().replace(/\s+/g, ' ');
}

// Voice commands and whole-utterance controls
function applyVoiceCommands(text, customCommands = null) {
  if (customCommands && Array.isArray(customCommands)) {
    const ephemeralEngine = new VoiceCommandEngine(customCommands);
    return ephemeralEngine.evaluate(text);
  }
  return defaultEngine.evaluate(text);
}

// Personal dictionary: [{ from, to }] — fixes words the transcription mishears
// ("whisper flow" -> "Wispr Flow"). Case-insensitive, whole-word/phrase match.
function escapeReg(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function applyDictionary(text, dict) {
  let t = String(text);
  for (const e of (dict || [])) {
    if (!e || !e.from || !e.to) continue;
    const from = String(e.from).trim(), to = String(e.to).trim();
    if (!from || !to) continue;
    const re = new RegExp('(^|[^A-Za-z0-9])' + escapeReg(from) + '(?![A-Za-z0-9])', 'gi');
    t = t.replace(re, (m, p1) => p1 + to);
  }
  return t;
}

// Minimal multipart/form-data builder (no dependencies).
function buildMultipart(fields, fileField, fileName, fileBuffer, fileType) {
  const boundary = '----wisprtell' + Date.now().toString(36);
  const parts = [];
  for (const [k, v] of Object.entries(fields))
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${fileName}"\r\n` +
    `Content-Type: ${fileType}\r\n\r\n`));
  parts.push(Buffer.isBuffer(fileBuffer) ? fileBuffer : Buffer.from(fileBuffer));
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

// Window title and application context classifier
const CONTEXT_RULES = {
  code: {
    category: 'code',
    persona: 'Code',
    exeRegex: /^(code|cursor|devenv|idea64|pycharm64|webstorm64|rider64|clion64|sublime_text|notepad\+\+|nvim-qt|atom|zed|eclipse|windowsterminal|powershell|pwsh|cmd|mintty|conhost|alacritty|wezterm-gui|tabby|kitty|hyper|git-bash)\.exe$/i,
    titleRegex: /(\.([jt]sx?|py|cpp|c|h|hpp|rs|go|rb|php|java|cs|swift|kt|kts|sql|sh|bash|zsh|ps1|json|ya?ml|toml|xml|html|css|scss|md|proto)\b)|visual studio code|sublime text|jetbrains|cursor|neovim|terminal|powershell|command prompt|bash/i,
    styleInstruction: 'Use technical formatting, preserve code symbols, use camelCase for identifiers where appropriate.'
  },
  chat: {
    category: 'chat',
    persona: 'Natural',
    exeRegex: /^(slack|discord|teams|ms-teams|telegram|whatsapp|signal|element|skype|mattermost|messenger)\.exe$/i,
    titleRegex: /slack|discord|microsoft teams|telegram|whatsapp|signal|messenger|chat|direct message|channel|#\w+/i,
    styleInstruction: 'Use casual, conversational phrasing. Contractions are welcome. Keep it direct and friendly.'
  },
  formal: {
    category: 'formal',
    persona: 'Formal',
    exeRegex: /^(outlook|winword|excel|powerpnt|thunderbird|acrobat|acrord32|onenote|notion|obsidian)\.exe$/i,
    titleRegex: /\b(outlook|word|excel|powerpoint|thunderbird|document|inbox|draft|mail|spreadsheet|presentation|memo|report|notes|overleaf)\b/i,
    styleInstruction: 'Use professional business tone, complete grammatical sentences, and polished vocabulary.'
  },
  general: {
    category: 'general',
    persona: 'Natural',
    styleInstruction: 'Fix grammar, remove speech fillers, and format cleanly.'
  }
};

function classifyTargetWindow(targetInfo) {
  if (!targetInfo) return { ...CONTEXT_RULES.general };

  const exe = String(targetInfo.exe || targetInfo.exeName || '').trim().toLowerCase();
  const title = String(targetInfo.title || targetInfo.windowTitle || '').trim();
  const isTerminal = Boolean(targetInfo.isTerminal);

  if (isTerminal) return { ...CONTEXT_RULES.code };
  if (CONTEXT_RULES.code.exeRegex.test(exe) || CONTEXT_RULES.code.titleRegex.test(title)) return { ...CONTEXT_RULES.code };
  if (CONTEXT_RULES.chat.exeRegex.test(exe) || CONTEXT_RULES.chat.titleRegex.test(title)) return { ...CONTEXT_RULES.chat };
  if (CONTEXT_RULES.formal.exeRegex.test(exe) || CONTEXT_RULES.formal.titleRegex.test(title)) return { ...CONTEXT_RULES.formal };

  return { ...CONTEXT_RULES.general };
}

const DEFAULT_PERSONAS = [
  {
    id: 'natural',
    name: 'Natural',
    systemPrompt: 'You are an intelligent voice typing assistant. Clean up grammar, remove filler words like um and uh, and format punctuation naturally while preserving spoken cadence. Return ONLY the final text with no quotes, explanations, or introductory remarks.',
    temperature: 0.3,
    isDefault: true,
  },
  {
    id: 'formal',
    name: 'Formal',
    systemPrompt: 'You are an executive correspondence editor. Rewrite spoken audio into professional, grammatically complete prose suitable for business emails, reports, and formal documentation. Return ONLY the final text with no quotes, explanations, or introductory remarks.',
    temperature: 0.2,
    isDefault: true,
  },
  {
    id: 'code',
    name: 'Code',
    systemPrompt: 'You are a software development dictation assistant. Format variable and function names in camelCase or snake_case where context indicates code, preserve technical terminology, syntax symbols, and markdown code blocks. Return ONLY the final text with no quotes, explanations, or introductory remarks.',
    temperature: 0.1,
    isDefault: true,
  },
  {
    id: 'casual',
    name: 'Casual',
    systemPrompt: 'You are a direct chat messaging assistant. Polish spoken thoughts into friendly, conversational messages using natural contractions and casual phrasing. Return ONLY the final text with no quotes, explanations, or introductory remarks.',
    temperature: 0.4,
    isDefault: true,
  },
  {
    id: 'minimal',
    name: 'Minimal',
    systemPrompt: 'You are a minimal voice correction filter. Only fix obvious spelling errors, repeated stumbles, and spoken punctuation symbols. Do not rephrase, reorder, or alter vocabulary. Return ONLY the final text with no quotes, explanations, or introductory remarks.',
    temperature: 0.0,
    isDefault: true,
  },
];

function buildPolishingPrompt(optsOrContext, maybeText) {
  if (typeof optsOrContext === 'string' || (optsOrContext && !optsOrContext.text && maybeText !== undefined)) {
    const context = typeof optsOrContext === 'string'
      ? (CONTEXT_RULES[optsOrContext] || CONTEXT_RULES.general)
      : classifyTargetWindow(optsOrContext);
    return {
      systemPrompt: `You are an expert voice-to-text editor. ${context.styleInstruction}`,
      userMessage: maybeText,
      userText: maybeText,
      category: context.category,
      personaId: context.category,
      personaName: context.persona,
      temperature: context.category === 'code' ? 0.1 : (context.category === 'formal' ? 0.2 : 0.3),
    };
  }

  const opts = optsOrContext || {};
  const text = opts.text || '';
  const targetInfo = opts.targetInfo;
  const personas = opts.personas || DEFAULT_PERSONAS;
  const activePersonaId = opts.activePersonaId || 'natural';
  const contextPolishEnabled = opts.contextPolishEnabled !== false;
  const dictionary = opts.dictionary || [];

  let selectedPersona = personas.find(p => p.id === activePersonaId) || personas[0] || DEFAULT_PERSONAS[0];
  let category = 'general';

  if (contextPolishEnabled && targetInfo) {
    const context = classifyTargetWindow(targetInfo);
    category = context.category;

    if (category === 'code') {
      selectedPersona = personas.find(p => p.id === 'code') || selectedPersona;
    } else if (category === 'chat') {
      selectedPersona = personas.find(p => p.id === 'casual' || p.id === 'natural') || selectedPersona;
    } else if (category === 'formal') {
      selectedPersona = personas.find(p => p.id === 'formal') || selectedPersona;
    }
  }

  let prompt = selectedPersona.systemPrompt;

  const validWords = (dictionary || [])
    .filter(d => d && (d.to || d.from))
    .map(d => String(d.to || d.from).trim())
    .filter(Boolean);

  const uniqueWords = Array.from(new Set(validWords));
  if (uniqueWords.length > 0) {
    prompt += ' Always spell these words exactly as given: ' + uniqueWords.join(', ') + '.';
  }

  return {
    systemPrompt: prompt,
    temperature: selectedPersona.temperature,
    category,
    personaId: selectedPersona.id,
    personaName: selectedPersona.name,
    userText: text,
    userMessage: text,
  };
}

function formatWhisperPromptFromDict(dictionary = []) {
  if (!dictionary || !Array.isArray(dictionary) || dictionary.length === 0) return '';
  const terms = dictionary
    .filter(d => d && (d.to || d.from))
    .map(d => (d.to || d.from).trim())
    .filter(Boolean);

  const uniqueTerms = Array.from(new Set(terms));
  return uniqueTerms.join(', ');
}

function buildWhisperPromptBounded(dictionary, maxChars = 800) {
  if (!dictionary || !Array.isArray(dictionary) || dictionary.length === 0) return '';

  const terms = [];
  let currentLength = 0;

  for (const item of dictionary) {
    if (!item || typeof item !== 'object') continue;
    const term = (item.to || item.from || '').trim().replace(/["\r\n]/g, '');
    if (!term) continue;

    const addition = terms.length === 0 ? term.length : term.length + 2;
    if (currentLength + addition > maxChars) break;

    terms.push(term);
    currentLength += addition;
  }

  return terms.join(', ');
}

module.exports = {
  formatText,
  applyVoiceCommands,
  applyDictionary,
  applyInlinePunctuation,
  buildMultipart,
  classifyTargetWindow,
  DEFAULT_PERSONAS,
  buildPolishingPrompt,
  formatWhisperPromptFromDict,
  buildWhisperPromptBounded,
  VoiceCommandEngine,
  DEFAULT_COMMANDS,
};
