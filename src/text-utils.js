// Wispr Tell text utilities.
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
function applyVoiceCommands(text) {
  const t = String(text).trim();
  const low = t.toLowerCase().replace(/[.!?]$/, '');
  if (/^(new paragraph|next paragraph)$/.test(low)) return { text: '\n\n', command: true, scratch: false, action: null };
  if (/^(new line|next line)$/.test(low)) return { text: '\n', command: true, scratch: false, action: null };
  if (/^(scratch that|delete that)$/.test(low)) return { text: '', command: true, scratch: true, action: null };
  if (/^undo that$/.test(low)) return { text: '', command: true, scratch: false, action: 'undo' };
  if (/^delete word$/.test(low)) return { text: '', command: true, scratch: false, action: 'delete-word' };

  const punctWhole = {
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
  if (punctWhole[low] !== undefined) {
    return { text: punctWhole[low], command: true, scratch: false, action: null };
  }

  let out = applyInlinePunctuation(t);
  out = out.replace(/\s+new paragraph\s+/gi, '\n\n').replace(/\s+new line\s+/gi, '\n');
  return { text: out, command: false, scratch: false, action: null };
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

module.exports = { formatText, applyVoiceCommands, applyDictionary, applyInlinePunctuation, buildMultipart };
