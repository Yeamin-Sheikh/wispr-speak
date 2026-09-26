// Wispr Tell — pure text utilities (no Electron deps; unit-testable).
const FILLERS = /\b(um|uh|er|ah|like|you know)\b[, ]*/gi;

function formatText(raw) {
  let t = String(raw).replace(FILLERS, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  t = t.charAt(0).toUpperCase() + t.slice(1);
  if (!/[.!?]$/.test(t)) t += '.';
  return t;
}

// Spoken punctuation -> symbols, for mid-sentence use ("hello comma world" -> "hello, world").
const INLINE_PUNCT = [
  [/(\s|^)comma(?=\s|$)/gi, ','],
  [/(\s|^)full stop(?=\s|$)/gi, '.'],
  [/(\s|^)period(?=\s|$)/gi, '.'],
  [/(\s|^)question mark(?=\s|$)/gi, '?'],
  [/(\s|^)exclamation(?: mark| point)?(?=\s|$)/gi, '!'],
  [/(\s|^)colon(?=\s|$)/gi, ':'],
  [/(\s|^)semicolon(?=\s|$)/gi, ';'],
];
function applyInlinePunctuation(t) {
  let s = ' ' + String(t) + ' ';
  for (const [re, sym] of INLINE_PUNCT) s = s.replace(re, sym);
  s = s.replace(/\s+([,.;:?!])/g, '$1');        // no space before the mark
  s = s.replace(/([,;:?!])(?=[A-Za-z0-9])/g, '$1 '); // space after it
  return s.trim().replace(/\s+/g, ' ');
}

// Voice commands.
// Whole-utterance: new line / new paragraph / scratch that / undo that / delete word /
//   comma / period / question mark / exclamation mark / colon / semicolon.
// Inline: "new line", "new paragraph", and spoken punctuation mid-sentence.
// Returns { text, command, scratch, action } — action is null | 'undo' | 'delete-word'.
function applyVoiceCommands(text) {
  const t = String(text).trim();
  const low = t.toLowerCase().replace(/[.!?]$/, '');
  if (/^(new paragraph|next paragraph)$/.test(low)) return { text: '\n\n', command: true, scratch: false, action: null };
  if (/^(new line|next line)$/.test(low)) return { text: '\n', command: true, scratch: false, action: null };
  if (/^(scratch that|delete that)$/.test(low)) return { text: '', command: true, scratch: true, action: null };
  if (/^undo that$/.test(low)) return { text: '', command: true, scratch: false, action: 'undo' };
  if (/^delete word$/.test(low)) return { text: '', command: true, scratch: false, action: 'delete-word' };
  const punctWhole = { 'comma': ',', 'period': '.', 'full stop': '.', 'question mark': '?',
    'exclamation mark': '!', 'exclamation point': '!', 'colon': ':', 'semicolon': ';' };
  if (punctWhole[low] !== undefined)
    return { text: punctWhole[low], command: true, scratch: false, action: null };
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
