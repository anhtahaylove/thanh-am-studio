// Reads what NVDA spoke from its log (started with --log-level=12, so speech.speak logs every sequence as
// `IO - speech.speech.speak (hh:mm:ss.mmm) - MainThread (id):` followed by `Speaking [<Python repr of the sequence>]`).
// usage: node nvdalog.mjs <nvda.log>     prints one JSON line per spoken sequence
//        node nvdalog.mjs --self-test    checks the parser against fixtures/nvda-sample.log
import {openSync, readSync, fstatSync, closeSync, readFileSync, writeFileSync, appendFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

const HEAD = /^(INFO|DEBUGWARNING|DEBUG|IO|WARNING|ERROR|CRITICAL) - (\S+)(?: \((\d\d:\d\d:\d\d\.\d{3})\))?/;

/** Log entries: a header line, then message lines up to the next header. */
export function parseEntries(text) {
  const entries = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, ''), m = line.match(HEAD);
    if (m) entries.push({level: m[1], codepath: m[2], time: m[3] ?? null, message: ''});
    else if (entries.length) { const e = entries.at(-1); e.message = e.message ? `${e.message}\n${line}` : line; }
  }
  for (const e of entries) e.message = e.message.replace(/\n+$/, '');
  return entries;
}

// One Python string literal starting at s[i] (a quote); returns [value, index of the closing quote].
function pyLiteral(s, i) {
  const q = s[i];
  let v = '', j = i + 1;
  for (; j < s.length && s[j] !== q; j++) {
    if (s[j] !== '\\') { v += s[j]; continue; }
    const c = s[++j], hex = {x: 2, u: 4, U: 8}[c];
    if (hex) { v += String.fromCodePoint(parseInt(s.slice(j + 1, j + 1 + hex), 16)); j += hex; }
    else v += {n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"'}[c] ?? `\\${c}`;
  }
  return [v, j];
}

/** The strings of a spoken sequence's repr, NFC; commands such as LangChangeCommand ('vi') or CancellableSpeech (...) are skipped. */
export function pyStrings(repr) {
  const out = [];
  let depth = 0;
  for (let i = 0; i < repr.length; i++) {
    const c = repr[i];
    if (c === "'" || c === '"') { const [v, end] = pyLiteral(repr, i); if (depth === 1) out.push(v.normalize('NFC')); i = end; }
    else if ('[({'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
  }
  return out;
}

/** Spoken sequences of the given entries: [{time, strings}]. */
export const speechOf = (entries) => entries.filter((e) => e.level === 'IO' && e.message.startsWith('Speaking [')).map((e) => ({time: e.time, strings: pyStrings(e.message.slice('Speaking '.length))}));

/** Entries written to `path` after byte `offset`. A trailing header whose message may still be on its way is left for the next read. */
export function readNew(path, offset) {
  let fd;
  try { fd = openSync(path, 'r'); } catch { return {entries: [], offset}; }
  try {
    const size = fstatSync(fd).size;
    if (size < offset) offset = 0; // a new log replaced the old one
    if (size === offset) return {entries: [], offset};
    const buf = Buffer.alloc(size - offset);
    readSync(fd, buf, 0, buf.length, offset);
    let end = buf.lastIndexOf(0x0a) + 1;
    const lines = buf.subarray(0, end).toString('utf8').split('\n').slice(0, -1);
    if (lines.length && HEAD.test(lines.at(-1).replace(/\r$/, ''))) end -= Buffer.byteLength(lines.at(-1)) + 1;
    return {entries: end > 0 ? parseEntries(buf.subarray(0, end).toString('utf8')) : [], offset: offset + Math.max(end, 0)};
  } finally { closeSync(fd); }
}

function selfTest() {
  const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'nvda-sample.log'), text = readFileSync(fixture, 'utf8');
  const entries = parseEntries(text), speech = speechOf(entries);
  assert.deepEqual(entries.map((e) => e.level), ['INFO', 'INFO', 'IO', 'IO', 'IO', 'IO', 'DEBUGWARNING', 'IO', 'WARNING', 'IO', 'IO']);
  assert.equal(entries[1].message, 'NVDA initialized');
  assert.equal(entries[0].message.split('\n').length, 2, 'a message keeps its continuation lines');
  assert.deepEqual(speech.map((s) => s.strings), [
    ['Bỏ qua đến Xuất audio', 'link'],
    ['Thao tác đoạn 1', 'tool bar', 'Chia đoạn tại con trỏ', 'button'],
    ['Đưa đoạn lên', 'button', 'unavailable', 'Đây là đoạn đầu tiên'],
    ["Lan's take", 'say "hi"', 'a\\b', 'tab\there', '\u00a0x'],
    ['Đã tạo xong đoạn 1'],
    ['Giọng đoạn 1', 'combo box', 'collapsed'],
  ]);
  assert.equal(speech[0].time, '10:01:06.050');
  assert.equal(speech[4].strings[0], 'Đã tạo xong đoạn 1'.normalize('NFC'), 'a decomposed (NFD) string comes back NFC');
  const nfd = text.split('\n').find((l) => l.includes('xong'));
  assert.notEqual(nfd, nfd.normalize('NFC'), 'the fixture really holds an NFD line');
  assert.deepEqual(pyStrings("[LangChangeCommand ('vi'), 'a', BreakCommand(time=100), \"b'c\", CancellableSpeech (still valid)]"), ['a', "b'c"]);
  // Incremental reads (CRLF as NVDA writes on Windows): the same sequences however the file grows, and a header waits for its message.
  const dir = mkdtempSync(join(tmpdir(), 'nvdalog-')), log = join(dir, 'nvda.log');
  try {
    const crlf = Buffer.from(text.replace(/\r?\n/g, '\r\n')), got = [];
    writeFileSync(log, '');
    let offset = 0;
    for (let at = 0; at < crlf.length; at += 37) {
      appendFileSync(log, crlf.subarray(at, Math.min(at + 37, crlf.length)));
      const r = readNew(log, offset);
      offset = r.offset;
      got.push(...speechOf(r.entries));
    }
    assert.deepEqual(got.map((s) => s.strings), speech.map((s) => s.strings));
    writeFileSync(log, 'IO - speech.speech.speak (10:00:00.000) - MainThread (1):\r\n');
    assert.deepEqual(readNew(log, 0), {entries: [], offset: 0}, 'a header without its message is not consumed');
    appendFileSync(log, "Speaking ['late']\r\n");
    assert.deepEqual(speechOf(readNew(log, 0).entries).map((s) => s.strings), [['late']]);
  } finally { rmSync(dir, {recursive: true, force: true}); }
  console.log(`nvdalog self-test passed: ${entries.length} entries, ${speech.length} spoken sequences`);
}

const arg = process.argv[2];
if (process.argv[1]?.endsWith('nvdalog.mjs')) { // run as a script, not imported by packaged.mjs
  if (arg === '--self-test') selfTest();
  else if (arg) for (const s of speechOf(parseEntries(readFileSync(arg, 'utf8')))) console.log(JSON.stringify(s));
  else { console.error('usage: node nvdalog.mjs <nvda.log> | --self-test'); process.exit(2); }
}
