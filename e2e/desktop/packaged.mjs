// Acceptance run against the packaged desktop app (UI -> Rust -> worker -> files).
// usage: node packaged.mjs <app.exe> <outDir> <phase: full|reopen|turbo|offline|export|clone|dpi|longstt|ux|features|dub|scripts|update|update-seeded|ab|nvda>
// Drives the real WebView2 over CDP; native file dialogs are filled by file-dialog.ps1.
import {chromium} from 'playwright-core';
import {spawn, execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, writeFileSync, appendFileSync, statSync, copyFileSync, cpSync, readdirSync, readFileSync, createReadStream, rmSync, openSync, closeSync, readSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const [exe, out, phase = 'full'] = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(out, {recursive: true});
// Native dialogs save to a local Unicode folder (sandbox mapped folders are not reliable dialog targets); copies go to out.
const saves = join(tmpdir(), 'thanh âm e2e'); mkdirSync(saves, {recursive: true});
const log = (m) => { const line = `${new Date().toISOString()} ${m}`; console.log(line); appendFileSync(join(out, 'run.log'), line + '\n'); };
const results = [];
const step = async (name, fn) => {
  const t = Date.now();
  try { const detail = await fn(); results.push({name, ok: true, ms: Date.now() - t, detail}); log(`PASS ${name} ${detail ?? ''}`); }
  catch (e) { results.push({name, ok: false, ms: Date.now() - t, error: String(e).slice(0, 800)}); log(`FAIL ${name} ${e}`); await shot(`fail-${name}`); throw e; }
};
let page, app;
const shot = async (name) => { try { await page?.screenshot({path: join(out, `${name.replace(/[^\w-]+/g, '_')}.png`)}); } catch {} };
const invoke = (cmd, args = {}) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [cmd, args]);
const dialog = (path) => log('dialog ' + execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'file-dialog.ps1'), '-Path', path], {encoding: 'utf8'}).trim());
const nav = (name) => page.getByRole('navigation', {name: 'Điều hướng chính'}).getByRole('button', {name: new RegExp(`^${name}`)}).click(); // the queue button also carries a count badge
const waitJobs = async (kind, count, timeoutMs) => {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const jobs = (await invoke('list_jobs')).filter((j) => j.kind === kind);
    const failed = jobs.find((j) => ['failed', 'interrupted'].includes(j.status));
    if (failed) throw Error(`${kind} job ${failed.status}: ${failed.error}`);
    const done = jobs.filter((j) => j.status === 'succeeded');
    if (done.length >= count) return done;
    await page.waitForTimeout(1000);
  }
  throw Error(`timeout waiting for ${count} ${kind} jobs`);
};

async function launch() {
  const started = Date.now();
  app = spawn(exe, [], {env: {...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9222', THANHAM_E2E_CDP_PORT: '9222'}, stdio: 'ignore'});
  let browser;
  for (let i = 0; i < 120 && !browser; i++) { try { browser = await chromium.connectOverCDP('http://127.0.0.1:9222'); } catch { await new Promise((r) => setTimeout(r, 500)); } }
  if (!browser) throw Error('app did not expose WebView2 CDP');
  page = browser.contexts()[0].pages()[0];
  await page.getByRole('navigation', {name: 'Điều hướng chính'}).waitFor({timeout: 60000});
  return Date.now() - started;
}
async function quit() { app.kill(); await new Promise((r) => setTimeout(r, 3000)); }

// The app saves with CopyFileExW, which creates the file first and keeps it locked until the copy ends.
const readable = (path) => { try { closeSync(openSync(path, 'r')); return true; } catch { return false; } };
const saved = async (path) => {
  for (let i = 0; i < 60 && !readable(path); i++) await page.waitForTimeout(500);
  if (!readable(path)) throw Error(existsSync(path) ? `still being written after 30 s: ${path}` : `not saved after 30 s; folder has: ${readdirSync(dirname(path)).join(' | ')}`);
};
// The queue UI refreshes every 2.5 s, so pick the row by its text instead of the first button:
// a stale list would offer an earlier render whose format the save dialog then rejects.
const jobButton = (text, name) => page.locator('article', {hasText: text}).getByRole('button', {name});
const done = async (kind) => (await invoke('list_jobs')).filter((j) => j.kind === kind && j.status === 'succeeded').length;
// First channel of a PCM or float WAV, with its sample rate.
function readWav(path) {
  const b = readFileSync(path);
  let fmt, ch, rate, bits, data;
  for (let off = 12; off + 8 <= b.length && !data; ) {
    const id = b.toString('ascii', off, off + 4), size = b.readUInt32LE(off + 4);
    if (id === 'fmt ') [fmt, ch, rate, bits] = [b.readUInt16LE(off + 8), b.readUInt16LE(off + 10), b.readUInt32LE(off + 12), b.readUInt16LE(off + 22)];
    if (id === 'fmt ' && fmt === 0xfffe) fmt = b.readUInt16LE(off + 32); // WAVE_FORMAT_EXTENSIBLE: the sub-format GUID starts with the format code
    if (id === 'data') data = b.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size & 1);
  }
  const block = (bits / 8) * ch;
  const at = (i) => (fmt === 3 ? data.readFloatLE(i * block) : data.readIntLE(i * block, bits / 8) / 2 ** (bits - 1));
  return {rate, samples: Float32Array.from({length: Math.floor(data.length / block)}, (_, i) => at(i))};
}
// Mono 32-bit float WAV.
function writeWav(path, rate, samples) {
  const b = Buffer.alloc(44 + 4 * samples.length);
  b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(36 + 4 * samples.length, 4); b.write('WAVEfmt ', 8, 'ascii'); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(3, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(4 * rate, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(32, 34);
  b.write('data', 36, 'ascii'); b.writeUInt32LE(4 * samples.length, 40);
  samples.forEach((v, i) => b.writeFloatLE(v, 44 + 4 * i));
  writeFileSync(path, b);
}
// Peak level of each 10 ms frame of a PCM or float WAV (first channel).
function framePeaks(path) {
  const {rate, samples} = readWav(path), n = samples.length, per = rate / 100;
  const peaks = [];
  for (let f = 0; f * per < n; f++) { let m = 0; for (let i = f * per; i < Math.min(n, (f + 1) * per); i++) m = Math.max(m, Math.abs(samples[i])); peaks.push(m); }
  return peaks;
}
// [first, last] ms of the frames between from and to ms that reach 10 % of that stretch's peak.
function loud(peaks, from, to) {
  const a = Math.max(0, Math.floor(from / 10)), z = Math.min(peaks.length, Math.ceil(to / 10)), top = Math.max(...peaks.slice(a, z));
  let first = -1, last = -1;
  for (let f = a; f < z; f++) if (peaks[f] > 0.1 * top) { if (first < 0) first = f; last = f; }
  return [first * 10, last * 10 + 10];
}
// Lag in ms (10 ms steps, up to 200 ms either way) at which b's level envelope best matches a's.
function lag(a, b) {
  let best = [0, -Infinity];
  for (let d = -20; d <= 20; d++) {
    let s = 0;
    for (let i = Math.max(0, -d); i < Math.min(a.length, b.length - d); i++) s += Math.sqrt(a[i] * b[i + d]);
    if (s > best[1]) best = [d, s];
  }
  return best[0] * 10;
}
// Where in a (ms, 10 ms steps) b's level envelope fits best: cosine of the 10 ms peaks, so the two levels may differ.
function bestMatch(a, b) {
  let best = [0, -Infinity];
  for (let d = 0; d + b.length <= a.length; d++) {
    let s = 0, n = 0;
    for (let i = 0; i < b.length; i++) { s += a[d + i] * b[i]; n += a[d + i] ** 2; }
    if (s / Math.sqrt(n || 1) > best[1]) best = [d, s / Math.sqrt(n || 1)];
  }
  return best[0] * 10;
}
// The VieNeu model, downloaded through the UI when this phase runs on a fresh install.
async function voiceModel() {
  if ((await invoke('list_models')).find((m) => m.id === 'vieneu-v3')?.installed) return 'already installed';
  const before = await done('model_download');
  await nav('Model & cài đặt');
  await page.locator('article', {has: page.getByRole('heading', {name: 'VieNeu v3 Turbo', exact: true})}).getByRole('button', {name: 'Tải model'}).click();
  await waitJobs('model_download', before + 1, 20 * 60000);
  return 'downloaded through the UI';
}
const sha256File = (path) => { const h = createHash('sha256'), fd = openSync(path, 'r'), buf = Buffer.alloc(4 << 20); try { for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n)); } finally { closeSync(fd); } return h.digest('hex'); };
const relFiles = (dir) => readdirSync(dir, {recursive: true}).map(String).filter((f) => statSync(join(dir, f)).isFile()).map((f) => f.replaceAll('\\', '/')).sort();
// The separation pack (a download, not part of the installer) lives in the data folder; its manifest lists every file as `<sha256>  <size>  <path>`.
const PACK = 'separation-runtime', packDir = () => join(process.env.LOCALAPPDATA, 'studio.thanham.desktop', 'models', PACK);
async function separationPack() {
  if ((await invoke('list_models')).find((m) => m.id === PACK)?.installed) return 'already installed';
  const before = await done('model_download');
  await nav('Model & cài đặt');
  await page.locator('article', {has: page.getByRole('heading', {name: 'Gói chạy tách nhạc nền (Python + PyTorch)', exact: true})}).getByRole('button', {name: 'Tải gói'}).click();
  await page.getByRole('dialog', {name: 'Tải gói chạy tách nhạc nền'}).getByRole('button', {name: 'Đồng ý và tải'}).click();
  await waitJobs('model_download', before + 1, 30 * 60000);
  const record = JSON.parse(readFileSync(join(packDir(), 'installed.json'), 'utf8'));
  if (!record.license_accepted_at) throw Error(`no licence consent recorded: ${JSON.stringify(record)}`);
  // Only the pack carries torch: its own python loads it, with `-B` so that nothing is written into the pack.
  const request = JSON.stringify({protocol: 1, id: 'health', operation: 'health', payload: {profile: 'separation'}});
  const {result} = JSON.parse(execFileSync(join(packDir(), 'python.exe'), ['-B', '-I', '-X', 'utf8', join(dirname(exe), 'worker', 'main.py')], {input: request, encoding: 'utf8'}).trim().split('\n').at(-1));
  if (!result?.ready || !result.modules.torch) throw Error(JSON.stringify(result));
  return `downloaded through the UI, licence accepted at ${record.license_accepted_at}; torch loads from the pack`;
}
// After a separation: "Kiểm tra lại gói" passes and the pack tree is exactly its manifest (same files, same hashes, nothing new).
async function packRecheck() {
  const before = await done('model_download');
  await nav('Model & cài đặt');
  await page.locator('article', {has: page.getByRole('heading', {name: 'Gói chạy tách nhạc nền (Python + PyTorch)', exact: true})}).getByRole('button', {name: 'Kiểm tra lại gói'}).click();
  await waitJobs('model_download', before + 1, 15 * 60000);
  const listed = new Map(readFileSync(join(packDir(), 'MANIFEST.sha256'), 'utf8').split('\n').filter(Boolean).map((l) => { const [, hash, size, rel] = l.match(/^(\w{64}) {2}(\d+) {2}(.+)$/); return [rel, [hash, Number(size)]]; }));
  const files = relFiles(packDir()).filter((f) => f !== 'MANIFEST.sha256' && f !== 'installed.json'), problems = [];
  for (const f of files) { const entry = listed.get(f); if (!entry) problems.push(`new: ${f}`); else if (statSync(join(packDir(), f)).size !== entry[1] || sha256File(join(packDir(), f)) !== entry[0]) problems.push(`changed: ${f}`); }
  for (const f of listed.keys()) if (!files.includes(f)) problems.push(`missing: ${f}`);
  if (problems.length) throw Error(`${problems.length} differences from MANIFEST.sha256, first: ${problems.slice(0, 5).join(' | ')}`);
  return `re-check passed; ${files.length} files equal MANIFEST.sha256`;
}
async function newProject(prefix) {
  const name = `${prefix} ${Date.now()}`;
  await nav('Dự án');
  await page.getByRole('textbox', {name: 'Tên dự án mới'}).fill(name);
  await page.getByRole('button', {name: 'Tạo dự án'}).click();
  return name;
}
async function exportSteps() {
  const wav = join(saves, `xuất thử ổn định ${Date.now()}.wav`);
  let wavMs = 0;
  await step('render and export wav via save dialog', async () => {
    const before = await done('render');
    await page.getByRole('button', {name: 'Xuất audio'}).click();
    const [job] = await waitJobs('render', before + 1, 5 * 60000);
    await nav('Hàng đợi');
    await jobButton(job.id, 'Lưu audio').click();
    wavMs = job.result.duration_ms;
    dialog(wav);
    await saved(wav);
    copyFileSync(wav, join(out, 'xuất thử ổn định.wav'));
    return `${statSync(wav).size} bytes at ${wav}`;
  });
  await step('stt from exported audio and apply', async () => {
    await nav('Chép lời');
    await page.getByRole('combobox', {name: 'Model STT'}).selectOption('whisper-small');
    const s0 = await done('stt');
    const t = Date.now();
    await page.getByRole('button', {name: 'Chọn tệp & chép lời'}).click();
    dialog(wav);
    const [job] = await waitJobs('stt', s0 + 1, 10 * 60000);
    await nav('Hàng đợi');
    await page.getByRole('button', {name: 'Áp dụng transcript'}).first().click();
    await nav('Chép lời');
    const text = job.result.transcript.map((s) => s.text).join(' ');
    writeFileSync(join(out, 'stt.txt'), text);
    return `${Date.now() - t} ms: ${text}`;
  });
  await step('export srt via save dialog', async () => {
    const srt = join(saves, `phụ đề ${Date.now()}.srt`);
    await page.getByRole('button', {name: 'SRT', exact: true}).first().click();
    dialog(srt);
    for (let i = 0; i < 20 && !existsSync(srt); i++) await page.waitForTimeout(500);
    copyFileSync(srt, join(out, 'phụ đề.srt'));
    return `${statSync(srt).size} bytes`;
  });
  // M4A, FLAC and Opus: same render as the WAV, saved to Unicode paths; the codec, 48 kHz and the length are read back with ffprobe.
  const ffprobe = join(dirname(exe), 'runtime', 'ffmpeg', 'ffprobe.exe');
  const formats = {m4a: {label: 'M4A', codec: 'aac', container: 'mov,mp4,m4a,3gp,3g2,mj2'}, flac: {label: 'FLAC', codec: 'flac', container: 'flac'}, opus: {label: 'Opus', codec: 'opus', container: 'ogg'}};
  const files = {};
  for (const [ext, {label, codec, container}] of Object.entries(formats)) {
    await step(`render and export ${ext} via save dialog`, async () => {
      await nav('Dự án');
      await page.getByRole('button', {name: 'Mở dự án', exact: true}).first().click();
      await page.getByRole('textbox', {name: 'Nội dung đoạn 1'}).waitFor();
      await page.getByRole('combobox', {name: 'Định dạng audio'}).selectOption({label});
      const before = await done('render');
      await page.getByRole('button', {name: 'Xuất audio'}).click();
      const [job] = await waitJobs('render', before + 1, 5 * 60000);
      await nav('Hàng đợi');
      await jobButton(job.id, 'Lưu audio').click();
      const file = files[ext] = join(saves, `xuất thử định dạng ${Date.now()}.${ext}`);
      dialog(file);
      await saved(file);
      copyFileSync(file, join(out, `xuất thử định dạng.${ext}`));
      const {streams: [stream], format} = JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,sample_rate,channels,bits_per_raw_sample:format=duration,format_name', '-of', 'json', file], {encoding: 'utf8'}));
      const ms = Math.round(Number(format.duration) * 1000);
      if (stream.codec_name !== codec || stream.sample_rate !== '48000' || stream.channels !== 1 || format.format_name !== container) throw Error(`unexpected stream: ${JSON.stringify({stream, format})}`);
      if (ext === 'flac' && stream.bits_per_raw_sample !== '24') throw Error(`FLAC is not 24-bit: ${JSON.stringify(stream)}`);
      if (Math.abs(ms - wavMs) > 50) throw Error(`${ext} is ${ms} ms, the WAV ${wavMs} ms`);
      return `${statSync(file).size} bytes, ${stream.codec_name} ${stream.sample_rate} Hz, ${ms} ms vs WAV ${wavMs} ms`;
    });
  }
  await step('stt from the exported m4a', async () => {
    await nav('Chép lời');
    await page.getByRole('combobox', {name: 'Model STT'}).selectOption('whisper-small');
    const s0 = await done('stt');
    await page.getByRole('button', {name: 'Chọn tệp & chép lời'}).click();
    dialog(files.m4a);
    const [job] = await waitJobs('stt', s0 + 1, 10 * 60000);
    const text = job.result.transcript.map((s) => s.text).join(' ').trim();
    if (!text) throw Error('no text from the m4a');
    return text;
  });
  }

// update phase: a local feed made from the release's latest.json serves its installer (THANHAM_UPDATE_SETUP), or its first
// MiB at /bad, which must fail the signature check. The app reads the feed from THANHAM_UPDATE_MANIFEST on every check.
const served = [];
let feed;
if (phase === 'update') {
  const release = JSON.parse(readFileSync(process.env.THANHAM_UPDATE_FEED, 'utf8').replace(/^\uFEFF/, '')), setup = process.env.THANHAM_UPDATE_SETUP;
  const server = createServer((q, r) => { served.push(q.url); r.writeHead(200, {'content-type': 'application/octet-stream'}); createReadStream(setup, q.url === '/bad' ? {end: (1 << 20) - 1} : {}).pipe(r); });
  await new Promise((ok) => server.listen(8765, '127.0.0.1', ok)); server.unref();
  feed = (path) => { const m = join(tmpdir(), 'thanh-am-update.json'); writeFileSync(m, JSON.stringify({...release, platforms: {'windows-x86_64': {...release.platforms['windows-x86_64'], url: `http://127.0.0.1:8765${path}`}}})); return m; };
  process.env.THANHAM_UPDATE_MANIFEST = feed('/bad');
}
const fixture = 'Xin chào, đây là Thanh Âm Studio. Hôm nay trời Hà Nội trong xanh.\nChúng tôi kiểm tra giọng đọc tiếng Việt trên máy tính.';
// Read by a preset voice to make the reference of the clone and ab phases.
const refText = 'Xin chào các bạn, tôi là người dẫn chương trình. Hôm nay trời rất đẹp, chúng ta cùng nhau đi dạo quanh hồ Gươm và nghe kể về những câu chuyện xưa của thành phố. Những câu chuyện ấy đã được người Hà Nội kể lại qua nhiều thế hệ.';
try {
  await step('launch', async () => `cold start ${await launch()} ms`);
  await step('runtime bundled', async () => {
    const s = await invoke('runtime_status');
    // In the update phase the app is the -From release, which may predate the native worker; it is checked after the update.
    if (!s.python_ready || !s.ffmpeg_ready || !s.worker_ready || (phase !== 'update' && !s.native_worker_ready)) throw Error(JSON.stringify(s));
    return s.python_path;
  });
  if (phase === 'full') {
    await step('runtime health: the installer ships the engines and no torch', async () => {
      const root = dirname(exe), request = JSON.stringify({protocol: 1, id: 'health', operation: 'health', payload: {profile: 'base'}});
      const {result} = JSON.parse(execFileSync(join(root, 'runtime', 'python', 'python.exe'), ['-I', '-X', 'utf8', join(root, 'worker', 'main.py')], {input: request, encoding: 'utf8'}).trim().split('\n').at(-1));
      if (!result?.ready || 'torch' in result.modules || result.torch_imported_by_engines !== false) throw Error(JSON.stringify(result));
      const site = join(root, 'runtime', 'python', 'Lib', 'site-packages'), stale = ['torch', 'demucs', 'julius', 'einops', 'safetensors'].filter((p) => existsSync(join(site, p)));
      if (stale.length) throw Error(`the installer still ships ${stale.join(', ')}`);
      const bytes = readdirSync(root, {recursive: true}).map((f) => statSync(join(root, f))).reduce((sum, s) => sum + (s.isFile() ? s.size : 0), 0);
      return `ready; installed ${(bytes / 2 ** 20).toFixed(0)} MiB`; // size is information, not a gate
    });
    await step('download models via UI', async () => {
      for (const name of ['VieNeu v3 Turbo', 'Whisper Small']) {
        await nav('Model & cài đặt');
        await page.locator('article', {has: page.getByRole('heading', {name, exact: true})}).getByRole('button', {name: 'Tải model'}).click();
        await page.waitForTimeout(500);
      }
      await shot('downloading');
      await waitJobs('model_download', 2, 20 * 60000);
      const models = await invoke('list_models');
      if (!['vieneu-v3', 'whisper-small'].every((id) => models.find((m) => m.id === id)?.installed)) throw Error(JSON.stringify(models));
    });
    await step('tts script and generate', async () => {
      await page.getByRole('navigation', {name: 'Điều hướng chính'}).getByRole('button').first().click();
      await page.getByRole('button', {name: 'Thêm nội dung', exact: true}).click();
      await page.getByRole('textbox', {name: 'Nội dung cần thêm'}).fill(fixture);
      await page.getByRole('button', {name: 'Thêm vào kịch bản'}).click();
      await page.getByRole('textbox', {name: 'Nội dung đoạn 2'}).waitFor();
      await page.waitForTimeout(1500); // autosave
      const t = Date.now();
      await page.getByRole('button', {name: 'Tạo giọng tất cả'}).click();
      const jobs = await waitJobs('tts', 2, 10 * 60000);
      // The server trims each segment to its first take's speech edges when it selects that take.
      const project = await invoke('load_project', {id: jobs[0].project_id});
      const trims = project.segments.map((s) => {
        const take = s.takes.find((x) => x.id === s.selected_take_id);
        if (!take || typeof take.speech_start_ms !== 'number' || s.trim_start_ms !== take.speech_start_ms || (s.trim_end_ms ?? null) !== (take.speech_end_ms ?? null))
          throw Error(`segment trim does not follow the take's speech edges: ${JSON.stringify({trim: [s.trim_start_ms, s.trim_end_ms], take})}`);
        return `${s.trim_start_ms}-${s.trim_end_ms ?? take.duration_ms}`;
      });
      return `2 segments in ${Date.now() - t} ms, audio ${jobs.map((j) => j.result.duration_ms).join('+')} ms, trimmed to ${trims.join(' and ')} ms`;
    });
    await step('takes visible and preview plays', async () => {
      await page.getByText('1 take').first().waitFor({timeout: 15000});
      await page.getByRole('button', {name: 'Nghe thử đoạn'}).first().click();
      await page.getByRole('button', {name: 'Dừng nghe thử'}).waitFor({timeout: 10000});
      if (await page.getByRole('alert').count()) throw Error(await page.getByRole('alert').innerText());
      await shot('tts-preview');
    });
    await step('regenerate keeps old take', async () => {
      await page.getByRole('button', {name: 'Tạo take mới'}).first().click();
      await waitJobs('tts', 3, 5 * 60000);
      await page.getByText('2 take').first().waitFor({timeout: 15000});
    });
    await exportSteps();
    // The shipped .pyc headers stay valid after install (and update); .pyc files Python wrote on this machine are information only.
    await step('shipped bytecode is unchanged after the jobs', async () => {
      const python = join(dirname(exe), 'runtime', 'python'), listed = readFileSync(join(python, 'pyc-sha256.txt'), 'utf8').split('\n').filter(Boolean).map((l) => { const [, hash, rel] = l.match(/^(\w{64}) {2}(.+)$/); return [rel, hash]; });
      const changed = listed.filter(([rel, hash]) => !existsSync(join(python, rel)) || sha256File(join(python, rel)) !== hash).map(([rel]) => rel);
      if (changed.length) throw Error(`${changed.length} of ${listed.length} shipped .pyc files changed or are gone, first: ${changed.slice(0, 5).join(' | ')}`);
      const known = new Set(listed.map(([rel]) => rel)), added = relFiles(python).filter((f) => f.endsWith('.pyc') && !known.has(f));
      return `${listed.length} shipped .pyc files unchanged; ${added.length} new ones written by the jobs (information)${added.length ? `: ${added.slice(0, 5).join(', ')}` : ''}`;
    });
  }
  if (phase === 'turbo') {
    await step('download whisper turbo via UI', async () => {
      const before = await done('model_download');
      await nav('Model & cài đặt');
      await page.locator('article', {has: page.getByRole('heading', {name: 'Whisper Large v3 Turbo', exact: true})}).getByRole('button', {name: 'Tải model'}).click();
      const t = Date.now();
      await waitJobs('model_download', before + 1, 60 * 60000);
      if (!(await invoke('list_models')).find((m) => m.id === 'whisper-turbo')?.installed) throw Error('whisper-turbo not installed');
      return `${Math.round((Date.now() - t) / 1000)} s`;
    });
    const mp3 = join(saves, `xuất thử mp3 ${Date.now()}.mp3`);
    await step('render and export mp3 via save dialog', async () => {
      await nav('Dự án');
      await page.getByRole('button', {name: 'Mở dự án', exact: true}).first().click();
      await page.getByRole('textbox', {name: 'Nội dung đoạn 1'}).waitFor();
      await page.getByRole('combobox', {name: 'Định dạng audio'}).selectOption('mp3');
      const before = await done('render');
      await page.getByRole('button', {name: 'Xuất audio'}).click();
      const [job] = await waitJobs('render', before + 1, 5 * 60000);
      await nav('Hàng đợi');
      await jobButton(job.id, 'Lưu audio').click();
      dialog(mp3);
      await saved(mp3);
      copyFileSync(mp3, join(out, 'xuất thử.mp3'));
      const ffprobe = join(dirname(exe), 'runtime', 'ffmpeg', 'ffprobe.exe');
      const probe = execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_name,sample_rate,bit_rate:format=duration', '-of', 'compact', mp3], {encoding: 'utf8'}).trim().replace(/\r?\n/g, ' ');
      if (!probe.includes('codec_name=mp3')) throw Error(`not mp3: ${probe}`);
      return `${statSync(mp3).size} bytes, render ${job.result.duration_ms} ms, ${probe}`;
    });
    await step('stt with whisper turbo on the mp3 and apply', async () => {
      await nav('Chép lời');
      await page.getByRole('combobox', {name: 'Model STT'}).selectOption('whisper-turbo');
      const s0 = await done('stt');
      const t = Date.now();
      await page.getByRole('button', {name: 'Chọn tệp & chép lời'}).click();
      dialog(mp3);
      const jobs = await waitJobs('stt', s0 + 1, 30 * 60000);
      const job = jobs.find((j) => j.payload?.model_id === 'whisper-turbo');
      if (!job) throw Error('no succeeded whisper-turbo STT job');
      await nav('Hàng đợi');
      await jobButton('whisper-turbo', 'Áp dụng transcript').click();
      const text = job.result.transcript.map((s) => s.text).join(' ');
      writeFileSync(join(out, 'stt-turbo.txt'), text);
      return `${Date.now() - t} ms (incl. model load): ${text}`;
    });
  }
  if (phase === 'clone') {
    // Reference voice = a preset clip made by the app itself (no third-party voice rights involved).
    // "Trúc Ly" is female, the engine default "Hải Đăng" is male, so cloning is audible and measurable.
    const clip = join(out, 'clone'); mkdirSync(clip, {recursive: true});
    const ref = join(saves, `mẫu giọng ${Date.now()}.wav`);
    const lines = ['Buổi sáng ở Hà Nội thường bắt đầu bằng tiếng rao quen thuộc trên những con phố nhỏ.', 'Hôm nay chúng tôi giới thiệu một cuốn sách mới về lịch sử và văn hóa Việt Nam.', 'Xin vui lòng giữ trật tự và làm theo hướng dẫn của nhân viên trên tàu.', 'Thời tiết cuối tuần này có mưa rào rải rác ở các tỉnh phía Bắc.', 'Cảm ơn các bạn đã lắng nghe, hẹn gặp lại trong chương trình lần sau.'];
    const project = async (name, texts, voice) => {
      const p = await invoke('create_project', {name});
      p.segments = texts.map((text, i) => ({id: `c${i}`, text, normalized_text: text, voice_id: voice, speaker: 'Người dẫn', gap_ms: 300, takes: [], selected_take_id: null, trim_start_ms: 0, trim_end_ms: null, fade_in_ms: 0, fade_out_ms: 0, gain_db: 0}));
      await invoke('save_project', {project: p});
      await nav('Dự án');
      await page.locator('article', {has: page.getByRole('heading', {name, exact: true})}).getByRole('button', {name: 'Mở dự án'}).click();
      await page.getByRole('textbox', {name: `Nội dung đoạn ${texts.length}`}).waitFor();
      return p.id;
    };
    const generateAll = async (n) => {
      const before = await done('tts');
      await page.getByRole('button', {name: 'Tạo giọng tất cả'}).click();
      return (await waitJobs('tts', before + n, 15 * 60000)).slice(0, n);
    };
    await step('reference clip from preset voice', async () => {
      const pid = await project('Mẫu giọng kiểm thử', [refText], 'Trúc Ly');
      await generateAll(1);
      const take = (await invoke('load_project', {id: pid})).segments[0].takes[0];
      // The preview step needs a full 8 s of speech behind its 6 s of bursts.
      if (take.duration_ms < 8500) throw Error(`reference take is ${take.duration_ms} ms, needs >= 8500 ms`);
      copyFileSync(take.path, ref); copyFileSync(take.path, join(clip, 'reference.wav'));
      return `${take.duration_ms} ms`;
    });
    let voiceId;
    await step('register reference voice via UI with consent', async () => {
      await nav('Thư viện giọng');
      await page.getByRole('textbox', {name: 'Tên hiển thị'}).fill('Giọng mẫu kiểm thử');
      await page.getByRole('button', {name: 'Chọn mẫu audio'}).click();
      dialog(ref);
      await page.getByRole('button', {name: 'Chọn mẫu audio'}).waitFor({state: 'detached', timeout: 30000}); // shows the file name once imported
      const save = page.getByRole('button', {name: 'Lưu mẫu giọng'});
      if (await save.isEnabled()) throw Error('save enabled before consent');
      await page.getByRole('checkbox', {name: /quyền sử dụng/}).check();
      await save.click();
      const v = (await invoke('list_voices')).find((x) => x.name === 'Giọng mẫu kiểm thử');
      if (v?.kind !== 'reference' || !v.consent || !v.reference_asset_id) throw Error(JSON.stringify(v));
      voiceId = v.id;
      await shot('clone-voice-library');
    });
    await step('cleaned-sample preview skips 6 s of leading tone bursts', async () => {
      // 80 ms bursts at the reference's peak every 600 ms: too sparse to win the best-8 s window, too loud for VieNeu's
      // edge trim. A preview of the first 8 s would match the padded reference at 0 ms.
      const {rate, samples} = readWav(ref), peak = samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
      const lead = Float32Array.from({length: 6 * rate}, (_, i) => (i % (0.6 * rate) < 0.08 * rate ? peak * Math.sin(2 * Math.PI * 440 * i / rate) : 0));
      const padded = join(saves, `mẫu có tiếng bíp ${Date.now()}.wav`);
      writeWav(padded, rate, [...lead, ...samples]); copyFileSync(padded, join(clip, 'reference-padded.wav'));
      await nav('Thư viện giọng');
      await page.getByRole('button', {name: 'Chọn mẫu audio'}).click();
      dialog(padded);
      await page.getByRole('button', {name: 'Chọn mẫu audio'}).waitFor({state: 'detached', timeout: 30000});
      if (!await page.getByText('Chỉ dùng 8 giây có âm thanh to và liền mạch nhất của mẫu (nhạc hoặc tiếng ồn to cũng có thể được chọn), đã lọc ồn.').isVisible()) throw Error('hint not visible');
      const before = await done('clone_preview');
      await page.getByRole('button', {name: 'Nghe mẫu đã làm sạch'}).click();
      const [job] = await waitJobs('clone_preview', before + 1, 10 * 60000);
      copyFileSync(job.result.path, join(clip, 'preview.wav'));
      const preview = readWav(job.result.path), ms = Math.round(1000 * preview.samples.length / preview.rate);
      if (preview.rate !== 44100 || ms > 8000) throw Error(`preview is ${preview.rate} Hz, ${ms} ms`);
      const at = bestMatch(framePeaks(padded), framePeaks(job.result.path));
      if (at < 6000 - 50) throw Error(`preview fits the padded reference at ${at} ms, inside the bursts`);
      await page.waitForFunction(() => document.querySelector('audio[aria-label="Mẫu đã làm sạch"]')?.currentTime > 0.3, null, {timeout: 15000});
      await shot('clone-preview');
      return `${ms} ms at 44.1 kHz, fits the padded reference at ${at} ms; playback advanced`;
    });
    await step('clone 5 sentences and the same with the default voice', async () => {
      const pid = await project('Nhân bản giọng', lines, null);
      await page.getByRole('combobox', {name: 'Giọng của Người dẫn'}).selectOption({label: 'Giọng mẫu kiểm thử'});
      await page.waitForTimeout(1500); // autosave
      const cloned = await generateAll(5);
      if (!cloned.every((j) => j.payload.reference_asset_id && j.payload.voice_id === voiceId)) throw Error(`not cloned: ${JSON.stringify(cloned.map((j) => j.payload))}`);
      await page.getByRole('combobox', {name: 'Giọng của Người dẫn'}).selectOption({value: ''});
      await page.waitForTimeout(1500);
      await generateAll(5);
      const segs = (await invoke('load_project', {id: pid})).segments;
      segs.forEach((s, i) => { copyFileSync(s.takes[0].path, join(clip, `clone-${i + 1}.wav`)); copyFileSync(s.takes[1].path, join(clip, `default-${i + 1}.wav`)); });
      // Intelligibility of each cloned take via the app's own STT.
      const norm = (s) => s.toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim().split(' ');
      let errs = 0, words = 0; const rows = [];
      for (const [i, s] of segs.entries()) {
        const before = await done('stt');
        await invoke('enqueue_job', {kind: 'stt', projectId: pid, payload: {asset_id: s.takes[0].asset_id, model_id: 'whisper-small', language: 'vi'}});
        const [j] = await waitJobs('stt', before + 1, 10 * 60000);
        const ref = norm(lines[i]), hyp = norm(j.result.transcript.map((x) => x.text).join(' '));
        let prev = Array.from({length: hyp.length + 1}, (_, k) => k);
        for (let a = 1; a <= ref.length; a++) { const cur = [a]; for (let b = 1; b <= hyp.length; b++) cur[b] = Math.min(prev[b] + 1, cur[b - 1] + 1, prev[b - 1] + (ref[a - 1] === hyp[b - 1] ? 0 : 1)); prev = cur; }
        errs += prev[hyp.length]; words += ref.length; rows.push(`${i + 1}\t${hyp.join(' ')}`);
      }
      writeFileSync(join(clip, 'stt-clone.txt'), rows.join('\n'));
      writeFileSync(join(clip, 'script.txt'), lines.map((l, i) => `${i + 1}\t${l}`).join('\n'));
      return `5 cloned + 5 default takes; clone WER ${(100 * errs / words).toFixed(1)} %`;
    });
  }
  if (phase === 'longstt') {
    // Long-file STT through the UI: THANHAM_LONG_AUDIO (e.g. a 70-minute gate render) and a .txt
    // reference next to it; checks memory stays bounded and timestamps cover the whole file.
    await step('long file stt through the UI', async () => {
      const src = process.env.THANHAM_LONG_AUDIO;
      if (!src || !existsSync(src)) throw Error(`THANHAM_LONG_AUDIO missing: ${src}`);
      const audio = join(saves, `bản dài ${Date.now()}${src.slice(src.lastIndexOf('.'))}`);
      copyFileSync(src, audio); // mapped Sandbox folders are not reliable dialog targets
      await nav('Chép lời');
      await page.getByRole('combobox', {name: 'Model STT'}).selectOption('whisper-small');
      const finished = async () => (await invoke('list_jobs')).filter((j) => j.kind === 'stt' && ['succeeded', 'failed'].includes(j.status));
      const n0 = (await finished()).length, t = Date.now();
      await page.getByRole('button', {name: 'Chọn tệp & chép lời'}).click();
      dialog(audio);
      let peak = 0, job;
      for (;;) {
        const fin = await finished();
        if (fin.length > n0) { job = fin[0]; break; } // list_jobs is newest first
        const ps = JSON.parse(execFileSync('powershell', ['-NoProfile', '-Command', "@(Get-Process python,thanham-worker -EA SilentlyContinue | Where-Object { $_.Path -like '*thanh*' } | Select-Object WorkingSet64) | ConvertTo-Json -Compress"], {encoding: 'utf8'}) || '[]');
        peak = Math.max(peak, ...[ps].flat().map((p) => p?.WorkingSet64 ?? 0));
        if (Date.now() - t > 90 * 60000) throw Error('timeout');
        await page.waitForTimeout(5000);
      }
      if (job.status !== 'succeeded') throw Error(`stt failed: ${job.error}`);
      const rows = job.result.transcript;
      if (rows.some((r, i) => i && r.start_ms < rows[i - 1].start_ms)) throw Error('timestamps go backwards');
      const norm = (s) => s.toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim().split(' ');
      const ref = readFileSync(src.replace(/\.[^.]+$/, '.txt'), 'utf8').trim().split(' '), hyp = norm(rows.map((r) => r.text).join(' '));
      let prev = Array.from({length: hyp.length + 1}, (_, k) => k);
      for (let a = 1; a <= ref.length; a++) { const cur = [a]; for (let b = 1; b <= hyp.length; b++) cur[b] = Math.min(prev[b] + 1, cur[b - 1] + 1, prev[b - 1] + (ref[a - 1] === hyp[b - 1] ? 0 : 1)); prev = cur; }
      return `${Math.round((Date.now() - t) / 1000)} s, worker peak ${Math.round(peak / 2 ** 20)} MB (sampled every 5 s), ${rows.length} rows, last end ${(rows.at(-1).end_ms / 60000).toFixed(1)} min, WER ${(100 * prev[hyp.length] / ref.length).toFixed(2)} %`;
    });
  }
  if (phase === 'dpi') {
    // Emulates the logical (CSS px) window a user gets at high Windows scaling: 1080p at 150 % and the
    // 1024x720 minimum window at 125 %, 4K at 200 %, and a 1366x768 laptop at 125 % (shorter than the minimum).
    const cdp = await page.context().newCDPSession(page);
    const views = [['1080p-150', 1280, 680, 1.5], ['min-125', 1024, 720, 1.25], ['4k-200', 1920, 1040, 2], ['768p-125', 1093, 574, 1.25]];
    const pages = ['Tạo giọng đọc', 'Chép lời', 'Thư viện giọng', 'Hàng đợi', 'Dự án', 'Model & cài đặt'];
    await nav('Dự án');
    await page.getByRole('button', {name: 'Mở dự án', exact: true}).first().click();
    await page.getByRole('textbox', {name: 'Nội dung đoạn 1'}).waitFor();
    for (const [name, width, height, deviceScaleFactor] of views) {
      await step(`layout at ${name} (${width}x${height} css px, x${deviceScaleFactor})`, async () => {
        await cdp.send('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor, mobile: false});
        const issues = [];
        for (const [i, p] of pages.entries()) {
          await nav(p);
          await page.waitForTimeout(400);
          const bad = await page.evaluate(() => {
            const w = document.documentElement.clientWidth, out = [];
            if (document.documentElement.scrollWidth > w + 1) out.push(`page scrolls horizontally (${document.documentElement.scrollWidth}>${w})`);
            for (const el of document.querySelectorAll('button, a, label, h1, h2, h3, input, select, textarea, .badge, .status')) {
              const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
              if (!r.width || cs.visibility === 'hidden') continue;
              if (r.right > w + 1) out.push(`${el.tagName.toLowerCase()} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30)}" overflows the window by ${Math.round(r.right - w)} px`);
              else if (el.scrollWidth > el.clientWidth + 1 && cs.overflow !== 'visible' && el.tagName !== 'TEXTAREA' && el.tagName !== 'SELECT') out.push(`${el.tagName.toLowerCase()}${el.type ? `[${el.type}]` : ''} "${(el.textContent || el.getAttribute('aria-label') || el.closest('label')?.textContent || '').trim().slice(0, 30)}" text is clipped (${el.scrollWidth}>${el.clientWidth})`);
            }
            return [...new Set(out)].slice(0, 8);
          });
          await page.screenshot({path: join(out, `dpi-${name}-${i + 1}.png`)});
          if (bad.length) issues.push(`${p}: ${bad.join('; ')}`);
        }
        if (issues.length) throw Error(issues.join(' | '));
        return `${pages.length} pages clean`;
      }).catch(() => {}); // recorded as FAIL; keep checking the other sizes
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride');
  }
  if (phase === 'ux') {
    // Drag and drop plus transcript follow-along. The OS drag cannot be driven over CDP, so the page emits
    // Tauri's own drag events; the dropped paths then take the app's real route (read/import, STT job).
    // Needs whisper-small installed (run `full` first) and THANHAM_UX_AUDIO, a short Vietnamese speech file.
    const emit = (event, paths) => invoke('plugin:event|emit', {event, payload: {paths, position: {x: 400, y: 300}}});
    await step('drop a script file adds segments', async () => {
      await nav('Tạo giọng đọc');
      const txt = join(saves, `kéo thả ${Date.now()}.txt`);
      writeFileSync(txt, ['Đoạn thứ nhất được kéo vào cửa sổ.', 'Đoạn thứ hai cũng được thêm như vậy.'].join('\n')); // one segment per line
      const before = await page.getByRole('textbox', {name: /^Nội dung đoạn/}).count();
      await emit('tauri://drag-enter', [txt]);
      await page.locator('.drop-overlay').waitFor({timeout: 5000});
      await emit('tauri://drag-drop', [txt]);
      await page.locator('.drop-overlay').waitFor({state: 'detached', timeout: 5000});
      await page.getByRole('textbox', {name: `Nội dung đoạn ${before + 2}`}).waitFor({timeout: 10000});
      return `${before} -> ${await page.getByRole('textbox', {name: /^Nội dung đoạn/}).count()} segments`;
    });
    await step('drop an audio file, transcribe, and rows follow playback', async () => {
      const src = process.env.THANHAM_UX_AUDIO;
      if (!src || !existsSync(src)) throw Error(`THANHAM_UX_AUDIO missing: ${src}`);
      const audio = join(saves, `kéo thả ${Date.now()}${src.slice(src.lastIndexOf('.'))}`);
      copyFileSync(src, audio);
      await nav('Chép lời');
      await page.getByRole('combobox', {name: 'Model STT'}).selectOption('whisper-small');
      const s0 = await done('stt');
      await emit('tauri://drag-drop', [audio]);
      const [job] = await waitJobs('stt', s0 + 1, 10 * 60000);
      await nav('Hàng đợi');
      const apply = page.getByRole('button', {name: 'Áp dụng transcript'}); // newest first; STT rows do not show the job id
      const total = await done('stt');
      for (let i = 0; i < 20 && (await apply.count()) < total; i++) await page.waitForTimeout(500); // the list refreshes every 2.5 s
      await apply.first().click();
      await nav('Chép lời');
      const rows = job.result.transcript;
      if (rows.length < 2) throw Error(`need at least 2 transcript rows, got ${rows.length}`);
      const playing = () => page.locator('.transcript-row[aria-current="true"]').getAttribute('data-row', {timeout: 5000});
      const seek = (s) => page.locator('.source-player audio').evaluate((a, t) => { a.muted = true; a.currentTime = t; return a.play(); }, s);
      await seek(rows[0].start_ms / 1000 + 0.05);
      const first = await playing();
      await seek(rows.at(-1).start_ms / 1000 + 0.05);
      await page.waitForTimeout(600);
      const last = await playing();
      await page.locator('.source-player audio').evaluate((a) => a.pause());
      if (first === last) throw Error(`highlight did not move (${first})`);
      await shot('ux-follow-along');
      return `${rows.length} rows; highlight moved from row 1 to row ${rows.length}`;
    });
  }
  if (phase === 'features') {
    // v0.1.1 editing features end to end. Needs `full` first (models + a project with takes) and THANHAM_UX_AUDIO
    // (ideally two speakers; diarization labels are checked, not their correctness).
    await step('download diarization model via UI', async () => {
      if ((await invoke('list_models')).find((m) => m.id === 'diarization')?.installed) return 'already installed';
      await nav('Model & cài đặt');
      await page.locator('article', {has: page.getByRole('heading', {name: /^Phân biệt người nói/})}).getByRole('button', {name: 'Tải model'}).click();
      await waitJobs('model_download', 1 + (await invoke('list_jobs')).filter((j) => j.kind === 'model_download' && j.status === 'succeeded').length, 10 * 60000);
      if (!(await invoke('list_models')).find((m) => m.id === 'diarization')?.installed) throw Error('diarization not installed');
    });
    await step('pause mark, speed and self-check reach a new take', async () => {
      await nav('Dự án');
      await page.getByRole('button', {name: 'Mở dự án', exact: true}).first().click();
      const box = page.getByRole('textbox', {name: 'Nội dung đoạn 1'});
      await box.waitFor();
      await box.click(); await page.keyboard.press('Control+End');
      await page.keyboard.type(' Cứ do it đi.'); // English words go through sea-g2p's English engine in the bundled runtime
      const english = page.getByRole('checkbox', {name: 'Đọc từ tiếng Anh'});
      await english.check();
      await page.getByRole('button', {name: 'Chèn khoảng nghỉ 0,5 giây tại con trỏ'}).first().click();
      // Since 1.0.8 the pause button inserts like the emotion buttons: at the end of the text it adds a space after the tag.
      if (!/\[nghỉ 0\.5s\] ?$/.test(await box.inputValue())) throw Error(`pause mark missing: ${await box.inputValue()}`);
      await box.click(); // the speed select is in the inspector, which shows the selected segment
      await page.getByRole('combobox', {name: 'Tốc độ đọc đoạn 1'}).selectOption('1.1');
      const check = page.getByRole('checkbox', {name: 'Tự kiểm bằng Whisper'});
      if (!(await check.isChecked())) await check.check();
      await page.waitForTimeout(1500); // autosave
      const before = await done('tts');
      await page.getByRole('button', {name: 'Tạo take mới'}).first().click();
      const [job] = await waitJobs('tts', before + 1, 5 * 60000); // newest first
      if (job.payload.speed !== 1.1) throw Error(`speed not sent: ${JSON.stringify(job.payload)}`);
      if (!job.payload.text.includes('<en>it</en>')) throw Error(`English word not tagged: ${job.payload.text}`);
      await english.uncheck(); // later phases measure takes without it
      const takes = page.getByRole('combobox', {name: 'Take đang sử dụng'}); // a new take does not replace the chosen one
      await page.waitForTimeout(3000); // the take reaches the project on the next refresh
      await takes.selectOption({index: (await takes.locator('option').count()) - 1});
      const badge = page.locator('.take-check').first();
      await badge.waitFor({timeout: 15000});
      // Since 1.0.10 the self-check also reports where each heard word starts; TTS subtitles time their cues from these.
      const starts = (job.result.check.words ?? []).map((w) => w.start_ms);
      if (starts.length < 5 || starts.some((ms, i) => ms < (starts[i - 1] ?? 0) || ms > job.result.duration_ms)) throw Error(`word times ${JSON.stringify(job.result.check.words)}`);
      return `${job.result.duration_ms} ms take; check "${await badge.innerText()}", ${starts.length} word times ${starts[0]}-${starts.at(-1)} ms (${JSON.stringify(job.result.check).slice(0, 200)})`;
    });
    await step('a CSV dictionary file can be read', async () => {
      const csv = join(saves, `từ điển ${Date.now()}.csv`);
      writeFileSync(csv, '﻿từ,cách đọc\r\nAI,ây ai\r\n');
      const text = await invoke('read_text_file', {path: csv});
      if (!text.startsWith('từ,cách đọc') || !text.includes('AI,ây ai')) throw Error(`unexpected CSV text: ${JSON.stringify(text)}`);
      return `${text.length} characters, BOM removed`;
    });
    await step('waveform shows playback progress', async () => {
      await page.getByRole('button', {name: 'Nghe thử đoạn'}).first().click();
      await page.waitForTimeout(1500);
      const played = await page.locator('.waveform i.played').count(), bars = await page.locator('.waveform i').count();
      await shot('features-waveform');
      await page.getByRole('button', {name: 'Dừng nghe thử'}).click().catch(() => {}); // may already have ended
      if (!played) throw Error(`no played bars of ${bars}`);
      return `${played}/${bars} bars played after 1.5 s`;
    });
    await step('stt with speakers becomes a multi-voice script', async () => {
      const src = process.env.THANHAM_UX_AUDIO;
      if (!src || !existsSync(src)) throw Error(`THANHAM_UX_AUDIO missing: ${src}`);
      const audio = join(saves, `người nói ${Date.now()}${src.slice(src.lastIndexOf('.'))}`);
      copyFileSync(src, audio);
      await nav('Chép lời');
      await page.getByRole('combobox', {name: 'Model STT'}).selectOption('whisper-small');
      await page.getByRole('checkbox', {name: 'Phân biệt người nói'}).check();
      await page.getByRole('combobox', {name: 'Số người nói'}).selectOption('2'); // a known count stops over-splitting
      const s0 = await done('stt');
      await invoke('plugin:event|emit', {event: 'tauri://drag-drop', payload: {paths: [audio], position: {x: 400, y: 300}}});
      const [job] = await waitJobs('stt', s0 + 1, 20 * 60000);
      const speakers = job.result.transcript.map((r) => r.speaker);
      if (job.result.diarize_error || speakers.some((s) => typeof s !== 'number')) throw Error(`no speakers: ${job.result.diarize_error ?? JSON.stringify(speakers)}`);
      await nav('Hàng đợi');
      const apply = page.getByRole('button', {name: 'Áp dụng transcript'}); // newest first, but STT rows do not name their file
      const total = await done('stt');
      for (let i = 0; i < 20 && (await apply.count()) < total; i++) await page.waitForTimeout(500); // the list refreshes every 2.5 s
      await apply.first().click();
      await nav('Chép lời');
      const chips = await page.locator('select.speaker-chip').count(); // one menu per row; the speaker panel's cards reuse the class
      if (chips !== speakers.length) throw Error(`${chips} speaker chips for ${speakers.length} rows`);
      if (job.payload.num_speakers !== 2 || new Set(speakers).size !== 2) throw Error(`asked for 2 speakers, got ${new Set(speakers).size} (payload ${job.payload.num_speakers})`);
      const first = page.locator('select.speaker-chip').first(), relabel = String(1 - Number(await first.inputValue()));
      await first.selectOption(relabel); // fix a label by hand
      await page.waitForTimeout(1500); // autosave
      const [recent] = await invoke('list_projects'); // newest first: the project just saved
      const saved = (await invoke('load_project', {id: recent.id})).transcript[0].speaker;
      if (saved !== Number(relabel)) throw Error(`relabel not saved: ${saved} (wanted ${relabel})`);
      await shot('features-speakers');
      await page.getByRole('button', {name: 'Thành kịch bản'}).click();
      await page.getByRole('textbox', {name: /^Nội dung đoạn/}).first().waitFor();
      const segs = await page.getByRole('textbox', {name: /^Nội dung đoạn/}).count();
      return `${speakers.length} rows, ${new Set(speakers).size} speakers [${speakers.join('')}], ${chips} chips; script now ${segs} segments`;
    });
  }
  if (phase === 'scripts') {
    // 1.0.7 script features in the installed app: a Word file made by Word imported through the open dialog, a take whose
    // text has a pause alias and an emotion cue inserted with its button, and a per-chapter export. Needs THANHAM_DOCX.
    let project;
    await step('voice model ready', voiceModel);
    await step('a Word script imports with its speakers', async () => {
      const src = process.env.THANHAM_DOCX;
      if (!src || !existsSync(src)) throw Error(`THANHAM_DOCX missing: ${src}`);
      const docx = join(saves, `kịch bản ${Date.now()}.docx`);
      copyFileSync(src, docx);
      const name = await newProject('Kịch bản Word');
      await page.getByRole('button', {name: /^Nhập TXT \/ SRT/}).click();
      dialog(docx);
      await page.getByRole('textbox', {name: 'Nội dung đoạn 3'}).waitFor({timeout: 15000});
      await page.waitForTimeout(1500); // autosave
      project = await invoke('load_project', {id: (await invoke('list_projects')).find((p) => p.name === name)?.id});
      const got = project.segments.map((s) => [s.speaker, s.text]);
      const want = [['Lan', 'Xin chào các bạn, đây là kịch bản Word.'], ['Minh', 'Hôm nay trời đẹp quá.'], ['Lan', 'Chúng ta bắt đầu nhé.']];
      if (JSON.stringify(got) !== JSON.stringify(want)) throw Error(`segments ${JSON.stringify(got)}`);
      return got.map(([who, text]) => `${who}: ${text}`).join(' | ');
    });
    await step('a pause alias and an emotion cue reach a new take', async () => {
      const box = page.getByRole('textbox', {name: 'Nội dung đoạn 2'});
      await box.click();
      await box.fill('Hôm nay [pause 0.4s] trời đẹp quá.');
      await box.press('End');
      await page.getByRole('button', {name: 'Thở dài', exact: true}).click();
      const text = await box.inputValue();
      if (!/^Hôm nay \[pause 0\.4s\] trời đẹp quá\. ?\[thở dài\] ?$/.test(text)) throw Error(`text after the cue button: "${text}"`);
      const before = await done('tts');
      // A segment without a take labels this button "Tạo giọng"; it reads "Tạo take mới" once a take exists.
      await page.locator('article.segment').nth(1).getByRole('button', {name: /^(Tạo giọng|Tạo take mới)$/}).click();
      const [job] = await waitJobs('tts', before + 1, 10 * 60000);
      if (!job.payload.text.includes('[pause 0.4s]') || !job.payload.text.includes('[thở dài]')) throw Error(`sent "${job.payload.text}"`);
      // The longest quiet stretch (frames under 5 % of the take's peak) between the first and the last speech frame.
      const peaks = framePeaks(job.result.path), top = Math.max(...peaks), on = peaks.map((v) => v > 0.05 * top);
      let run = 0, longest = 0;
      for (let f = on.indexOf(true); f <= on.lastIndexOf(true); f++) { run = on[f] ? 0 : run + 1; longest = Math.max(longest, run); }
      if (longest * 10 < 350) throw Error(`longest pause inside the take is ${longest * 10} ms`);
      return `sent "${job.payload.text}", ${job.result.duration_ms} ms take, longest pause inside ${longest * 10} ms`;
    });
    let chapters;
    await step('one file per chapter from [P1] markers', async () => {
      await newProject('Chương');
      await page.getByRole('button', {name: 'Thêm nội dung', exact: true}).click();
      await page.getByRole('textbox', {name: 'Nội dung cần thêm'}).fill('[P1]\nMột hai ba bốn năm.\nSáu bảy tám chín mười.\n[P2] Hết chương một, sang chương hai.');
      await page.getByRole('button', {name: 'Thêm vào kịch bản'}).click();
      await page.getByRole('textbox', {name: 'Nội dung đoạn 3'}).waitFor();
      await page.waitForTimeout(1500); // autosave
      const tts = await done('tts');
      await page.getByRole('button', {name: 'Tạo giọng tất cả'}).click();
      await waitJobs('tts', tts + 3, 10 * 60000);
      // The editor picks up new takes on its next job poll (2.5 s) and refuses to export a segment without one before that.
      const withTake = page.locator('article.segment').getByRole('button', {name: 'Tạo take mới'});
      for (const end = Date.now() + 30000; (await withTake.count()) < 3 && Date.now() < end;) await page.waitForTimeout(500);
      await nav('Tạo giọng đọc');
      await page.getByRole('checkbox', {name: 'Mỗi chương một file'}).check();
      const before = await done('render');
      await page.getByRole('button', {name: 'Xuất audio'}).click();
      const rendered = await waitJobs('render', before + 2, 5 * 60000).catch(async (e) => { throw Error(`${e.message}; alerts: ${JSON.stringify(await page.locator('.alert').allInnerTexts())}`); });
      const jobs = rendered.slice(0, 2).sort((a, b) => a.payload.name.localeCompare(b.payload.name));
      const id = jobs[0].project_id, project = await invoke('load_project', {id});
      // Each file holds its chapter's segments: their trimmed takes, each followed by its gap.
      const len = (s) => (s.trim_end_ms ?? s.takes.find((t) => t.id === s.selected_take_id).duration_ms) - s.trim_start_ms + s.gap_ms;
      const want = [['001-P1', project.segments.slice(0, 2)], ['002-P2', project.segments.slice(2)]];
      chapters = jobs.map((job, i) => {
        const [name, segments] = want[i], expected = segments.reduce((sum, s) => sum + len(s), 0);
        if (job.payload.name !== name || job.payload.batch !== jobs[0].payload.batch || JSON.stringify(job.payload.segments.map((s) => s.id)) !== JSON.stringify(segments.map((s) => s.id)))
          throw Error(`job ${i}: ${JSON.stringify({name: job.payload.name, batch: job.payload.batch, segments: job.payload.segments.map((s) => s.text)})}`);
        if (Math.abs(job.result.duration_ms - expected) > 30) throw Error(`${name}: ${job.result.duration_ms} ms, expected ${expected} ms`);
        return {name, job, expected};
      });
      return chapters.map(({name, job, expected}) => `${name} ${job.result.duration_ms} ms (expected ${expected})`).join(', ');
    });
    await step('chapter files save into a folder without overwriting', async () => {
      // The folder picker itself is covered by the browser tests; this runs the installed app's copy command.
      const dir = join(saves, `chương ${Date.now()}`); mkdirSync(dir, {recursive: true});
      const save = ({name, job}) => invoke('export_asset_new', {assetId: job.result.asset_id, path: join(dir, `${name}.wav`)});
      const first = [], again = [];
      for (const c of chapters) first.push(await save(c));
      for (const c of chapters) again.push(await save(c));
      const sizes = chapters.map(({name, job}) => [statSync(join(dir, `${name}.wav`)).size, statSync(job.result.path).size]);
      if (first.some((v) => v !== true) || again.some((v) => v !== false) || sizes.some(([a, b]) => a !== b)) throw Error(JSON.stringify({first, again, sizes}));
      return `saved ${first.length}, second pass skipped ${again.length}, sizes ${sizes.map(([a]) => a).join(', ')} bytes`;
    });
  }
  if (phase === 'dub') {
    // Subtitle-timed export: an SRT imported through the UI, takes generated, "Theo mốc phụ đề" on, then the rendered file is
    // measured. Cue 2 is far too short for its text (sped up) and pushes cue 3 back; cues 1 and 4 have room. Segment 2 is read
    // at 1.2x, so its take keeps the reading before the speed change and the render fits that with one stretch.
    const cues = [[1000, 4000, 'Xin chào các bạn.'], [5000, 5600, 'Hôm nay chúng ta cùng nghe thử giọng đọc theo mốc thời gian của phụ đề.'],
      [6000, 8000, 'Câu này phải chờ câu trước.'], [12000, 14500, 'Cảm ơn các bạn đã lắng nghe.']];
    const stamp = (ms) => new Date(ms).toISOString().slice(11, 23).replace('.', ',');
    let project, job;
    await step('voice model ready', voiceModel);
    await step('srt import keeps the cue times', async () => {
      const name = await newProject('Lồng tiếng');
      const srt = join(saves, `phụ đề nguồn ${Date.now()}.srt`);
      writeFileSync(srt, cues.map(([a, b, text], i) => `${i + 1}\n${stamp(a)} --> ${stamp(b)}\n${text}\n`).join('\n'));
      copyFileSync(srt, join(out, 'phụ đề nguồn.srt'));
      await page.getByRole('button', {name: 'Nhập TXT / SRT'}).click();
      dialog(srt);
      await page.getByRole('textbox', {name: `Nội dung đoạn ${cues.length}`}).waitFor({timeout: 15000});
      await page.waitForTimeout(1500); // autosave
      const id = (await invoke('list_projects')).find((p) => p.name === name)?.id;
      project = await invoke('load_project', {id});
      const got = project.segments.map((s) => [s.cue_start_ms, s.cue_end_ms, s.text]);
      if (JSON.stringify(got) !== JSON.stringify(cues)) throw Error(`segments ${JSON.stringify(got)}`);
      return `${got.length} segments with their cues`;
    });
    await step('generate the takes', async () => {
      await page.getByRole('textbox', {name: 'Nội dung đoạn 2'}).click(); // select segment 2: its speed select is in the inspector
      await page.getByRole('combobox', {name: 'Tốc độ đọc đoạn 2'}).selectOption('1.2');
      await page.waitForTimeout(1500); // autosave
      const before = await done('tts');
      await page.getByRole('button', {name: 'Tạo giọng tất cả'}).click();
      await waitJobs('tts', before + cues.length, 15 * 60000);
      project = await invoke('load_project', {id: project.id});
      const raws = project.segments.map((s) => s.takes.find((t) => t.id === s.selected_take_id)).map((t) => [t.speed ?? 1, Boolean(t.raw_asset_id)]);
      if (JSON.stringify(raws) !== JSON.stringify([[1, false], [1.2, true], [1, false], [1, false]])) throw Error(`speeds and readings ${JSON.stringify(raws)}`);
      return project.segments.map((s) => `${s.takes.find((t) => t.id === s.selected_take_id)?.duration_ms} ms`).join(', ');
    });
    // The plan the spec asks for, from the saved project: start at the cue, or 50 ms after the previous take when it runs over;
    // a take longer than its cue is sped up to fit, at most 1.5x.
    const spec = () => {
      let cursor = 0;
      return project.segments.map((s, i) => {
        const take = s.takes.find((t) => t.id === s.selected_take_id), len = (s.trim_end_ms ?? take.duration_ms) - s.trim_start_ms;
        const slot = s.cue_end_ms - s.cue_start_ms, rate = len > slot ? Math.min(1.5, len / slot) : 1, at = Math.max(s.cue_start_ms, i ? cursor + 50 : 0);
        cursor = at + len / rate;
        return {cue: s.cue_start_ms, at, rate, end: cursor, take, trim: [s.trim_start_ms, s.trim_end_ms ?? take.duration_ms]};
      });
    };
    let plan;
    await step('export bar shows the dub plan', async () => {
      await nav('Tạo giọng đọc');
      await page.getByRole('checkbox', {name: 'Theo mốc phụ đề'}).check();
      plan = spec();
      const sped = plan.filter((p) => p.rate > 1).length, pushed = plan.filter((p) => p.at - p.cue > 5).length;
      if (!sped || !pushed) throw Error(`the cues did not exercise a speed-up and a push: ${JSON.stringify(plan.map(({at, rate}) => [at, rate]))}`);
      const stats = page.locator('.dub-stats');
      await stats.filter({hasText: 'đọc nhanh hơn'}).waitFor({timeout: 15000});
      const text = await stats.innerText();
      if (!text.startsWith(`${sped} đoạn đọc nhanh hơn · ${pushed} đoạn bị lùi`)) throw Error(`stats "${text}", expected ${sped} sped up and ${pushed} pushed`);
      await shot('dub-export-bar');
      return text;
    });
    const render = async (normalize, name, length) => { // length: a longer background runs the output past pad_to_ms
      await nav('Tạo giọng đọc');
      await page.getByRole('checkbox', {name: 'Chuẩn hóa'}).setChecked(normalize);
      const before = await done('render');
      await page.getByRole('button', {name: 'Xuất audio'}).click();
      const [rendered] = await waitJobs('render', before + 1, 5 * 60000);
      const {payload} = rendered, pad = Math.max(plan.at(-1).end, ...project.segments.map((s) => s.cue_end_ms));
      const sent = payload.segments.map((s) => [s.dub_at_ms, s.dub_rate]);
      if (payload.timeline !== true || payload.normalize !== normalize || Math.abs(payload.pad_to_ms - pad) > 1 || sent.some(([at, rate], i) => Math.abs(at - plan[i].at) > 1 || Math.abs(rate - plan[i].rate) > 1e-9))
        throw Error(`payload ${JSON.stringify({timeline: payload.timeline, normalize: payload.normalize, pad_to_ms: payload.pad_to_ms, sent})}, spec ${JSON.stringify({pad, plan: plan.map(({at, rate}) => [at, rate])})}`);
      if (Math.abs(rendered.result.duration_ms - (length ?? payload.pad_to_ms)) > 25) throw Error(`rendered ${rendered.result.duration_ms} ms, padded to ${payload.pad_to_ms} ms, expected ${length ?? payload.pad_to_ms} ms`);
      copyFileSync(rendered.result.path, join(out, name));
      return rendered;
    };
    await step('render follows the plan', async () => {
      job = await render(false, 'lồng tiếng theo phụ đề.wav'); // unnormalized, so the takes keep their own levels for the measurement below
      return `${job.payload.segments.map((s) => `${s.dub_at_ms} ms x${+s.dub_rate.toFixed(3)}`).join(', ')}; ${job.result.duration_ms} ms long`;
    });
    await step('each take starts where it was placed', async () => {
      // Where speech starts and ends (10 ms frames above 10 % of the stretch's peak), in the take's own file inside its trim and
      // in the rendered file around its place; the rendered one must match the take's, moved to its place and divided by its rate.
      const mix = framePeaks(job.result.path), rows = plan.map((p, i) => {
        const [first, last] = loud(framePeaks(p.take.path), p.trim[0], p.trim[1]);
        const want = [p.at + (first - p.trim[0]) / p.rate, p.at + (last - p.trim[0]) / p.rate];
        const got = loud(mix, p.at - 40, i + 1 < plan.length ? plan[i + 1].at - 40 : mix.length * 10);
        return {cue: p.cue, at: Math.round(p.at), rate: +p.rate.toFixed(3), start: [Math.round(want[0]), got[0]], end: [Math.round(want[1]), got[1]]};
      });
      writeFileSync(join(out, 'dub-positions.json'), JSON.stringify(rows, null, 1));
      const bad = rows.filter((r) => Math.abs(r.start[1] - r.start[0]) > 30 || Math.abs(r.end[1] - r.end[0]) > 40);
      if (bad.length) throw Error(`off place: ${JSON.stringify(bad)}`);
      return rows.map((r) => `cue ${r.cue}: placed ${r.at} x${r.rate}, speech ${r.start[1]}-${r.end[1]} ms (expected ${r.start[0]}-${r.end[0]})`).join('; ');
    });
    await step('normalized render keeps the same timeline', async () => {
      // Loudness normalization changes levels over time (a quiet onset after silence comes out louder), so the takes are not
      // measured again; the level envelope must line up with the unnormalized render's at no lag.
      const normalized = await render(true, 'lồng tiếng theo phụ đề (chuẩn hóa).wav'), shift = lag(framePeaks(job.result.path), framePeaks(normalized.result.path));
      if (shift) throw Error(`normalized render is ${shift} ms off the unnormalized one`);
      return `${normalized.result.duration_ms} ms long, envelope lag ${shift} ms`;
    });
    await step('srt export uses the same places', async () => {
      const srt = join(saves, `phụ đề lồng tiếng ${Date.now()}.srt`);
      await nav('Tạo giọng đọc');
      await page.getByRole('button', {name: 'SRT', exact: true}).first().click();
      dialog(srt);
      await saved(srt);
      copyFileSync(srt, join(out, 'phụ đề lồng tiếng.srt'));
      const starts = [...readFileSync(srt, 'utf8').matchAll(/(\d\d):(\d\d):(\d\d),(\d{3}) -->/g)].map(([, h, m, s, ms]) => ((+h * 60 + +m) * 60 + +s) * 1000 + +ms);
      const missing = plan.filter((p) => !starts.includes(Math.round(p.at)));
      if (missing.length) throw Error(`cue starts ${starts.join(', ')} miss ${missing.map((p) => Math.round(p.at)).join(', ')}`);
      return `${starts.length} cues starting at ${starts.join(', ')} ms`;
    });
    // "Giữ nhạc nền": a source video whose audio is a known bed with the four takes at their cue starts is picked when the box is
    // checked (the project has no source yet), separated by HTDemucs, and its background goes under the dub at 0 dB.
    const tools = join(dirname(exe), 'runtime', 'ffmpeg'), mediaMs = 16000, media = join(saves, `nguồn có nhạc ${Date.now()}.mp4`);
    const toWav = (from, name) => { const to = join(out, name); execFileSync(join(tools, 'ffmpeg.exe'), ['-nostdin', '-v', 'error', '-y', '-i', from, '-c:a', 'pcm_f32le', to]); return to; };
    const probeAudio = (file) => { const {streams: [s], format} = JSON.parse(execFileSync(join(tools, 'ffprobe.exe'), ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=codec_name,sample_rate,channels:format=duration', '-of', 'json', file], {encoding: 'utf8'})); return {...s, ms: Math.round(Number(format.duration) * 1000)}; };
    // Mean power in dB of the first channel over [from, to] ms ranges.
    const level = (path, ranges) => { const {rate, samples} = readWav(path); let sum = 0, n = 0; for (const [a, z] of ranges) for (let i = Math.round(a * rate / 1000); i < Math.min(samples.length, Math.round(z * rate / 1000)); i++, n++) sum += samples[i] ** 2; return 10 * Math.log10(sum / n); };
    const bedWav = join(out, 'nhạc nền gốc.wav');
    let stem;
    await step('separation model ready', async () => {
      if ((await invoke('list_models')).find((m) => m.id === 'htdemucs')?.installed) return 'already installed';
      const before = await done('model_download');
      await nav('Model & cài đặt');
      await page.locator('article', {has: page.getByRole('heading', {name: 'Tách giọng và nhạc nền (HTDemucs)', exact: true})}).getByRole('button', {name: 'Tải model'}).click();
      await waitJobs('model_download', before + 1, 20 * 60000);
      return 'downloaded through the UI';
    });
    await step('separation runtime pack ready', separationPack);
    await step('a source video with music under the takes', async () => {
      // Irregular plucked tones (three harmonics, decaying) at -18 dBFS RMS, as worker/tests tone_bed(); seeded, so every run is alike.
      let seed = 7; const rnd = () => (seed = seed * 16807 % 2147483647) / 2147483647, rate = 48000, n = mediaMs * rate / 1000, bed = new Float32Array(n);
      for (let at = 0; at < n; at += Math.round((0.12 + 0.33 * rnd()) * rate)) {
        const f = [110, 147, 196, 220, 262, 330, 392, 440][Math.floor(rnd() * 8)];
        for (let i = 0; i < 0.6 * rate && at + i < n; i++) bed[at + i] += [1, 2, 3].reduce((s, k) => s + Math.sin(2 * Math.PI * f * k * i / rate) / k, 0) * Math.exp(-5 * i / rate);
      }
      const scale = 10 ** (-18 / 20) / Math.sqrt(bed.reduce((s, v) => s + v * v, 0) / n);
      writeWav(bedWav, rate, bed.map((v) => v * scale));
      const takes = plan.map((p) => p.take.path);
      execFileSync(join(tools, 'ffmpeg.exe'), ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black:s=320x240:r=25:d=${mediaMs / 1000}`, '-i', bedWav, ...takes.flatMap((t) => ['-i', t]),
        '-filter_complex', `${takes.map((_, i) => `[${i + 2}:a]adelay=${cues[i][0]}:all=1[t${i}]`).join(';')};[1:a]${takes.map((_, i) => `[t${i}]`).join('')}amix=inputs=${takes.length + 1}:duration=first:normalize=0,pan=stereo|c0=c0|c1=c0[a]`,
        '-map', '0:v', '-map', '[a]', '-c:v', 'mpeg4', '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', media]);
      copyFileSync(media, join(out, 'nguồn có nhạc.mp4'));
      const a = probeAudio(media);
      return `${statSync(media).size} bytes, ${a.codec_name} ${a.sample_rate} Hz ${a.channels} ch, ${a.ms} ms`;
    });
    await step('checking "Giữ nhạc nền" picks the source and separates it', async () => {
      await nav('Tạo giọng đọc');
      await page.getByRole('checkbox', {name: 'Theo mốc phụ đề'}).check();
      const before = await done('separate'), keep = page.getByRole('checkbox', {name: 'Giữ nhạc nền'});
      await keep.click();
      dialog(media); // the project has no source yet, so the file picker opens
      await page.getByRole('status').filter({hasText: 'Đang tách nhạc nền từ'}).waitFor({timeout: 30000});
      if (!(await keep.isChecked())) throw Error('the box did not stay checked');
      await shot('dub-keep-background');
      [stem] = await waitJobs('separate', before + 1, 10 * 60000);
      project = await invoke('load_project', {id: project.id});
      if (!project.source_asset_id || stem.payload.asset_id !== project.source_asset_id) throw Error(`source ${project.source_asset_id}, separated ${stem.payload.asset_id}`);
      const s = probeAudio(stem.result.path), stemWav = toWav(stem.result.path, 'nhạc nền tách.wav'), shift = lag(framePeaks(bedWav), framePeaks(stemWav));
      // Where the takes speak in the source: their speech (inside the trims) from their cue starts.
      const speech = plan.map((p, i) => [cues[i][0] + p.trim[0], cues[i][0] + p.trim[1]]), diff = level(stemWav, speech) - level(bedWav, speech);
      const rtf = (Date.parse(stem.updated_at) - Date.parse(stem.created_at)) / mediaMs;
      if (s.codec_name !== 'flac' || s.sample_rate !== '44100' || s.channels !== 2 || Math.abs(s.ms - mediaMs) > 25 || shift || Math.abs(diff) > 3)
        throw Error(`stem ${JSON.stringify(s)}, envelope lag ${shift} ms, level in speech ${diff.toFixed(2)} dB vs the bed`);
      return `RTF ${rtf.toFixed(2)}; stem flac 44100 Hz 2 ch ${s.ms} ms; envelope lag ${shift} ms; level where the takes speak ${diff >= 0 ? '+' : ''}${diff.toFixed(2)} dB vs the bed`;
    });
    await step('the stem has no words the music alone does not', async () => {
      if (!(await invoke('list_models')).find((m) => m.id === 'whisper-small')?.installed) return 'skipped: Whisper Small is not installed';
      // Whisper makes words up on music without a voice (the bed alone gave a whole "subscribe" sentence), so the stem is
      // compared with the bed it came from: a voice left in the stem shows up as words the bed does not give.
      const heard = async (asset_id) => {
        const before = await done('stt');
        await invoke('enqueue_job', {kind: 'stt', projectId: null, payload: {asset_id, model_id: 'whisper-small', language: 'vi'}});
        const [j] = await waitJobs('stt', before + 1, 10 * 60000);
        return j.result.transcript.map((r) => r.text).join(' ').toLowerCase().normalize('NFC').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      };
      const bed = await heard((await invoke('import_asset', {path: bedWav})).id), words = await heard(stem.result.asset_id), extra = words.filter((w) => !bed.includes(w));
      if (extra.length > 1) throw Error(`the stem gives ${extra.length} words the bed does not: ${extra.join(' ')} (stem "${words.join(' ')}", bed "${bed.join(' ')}")`);
      return `stem "${words.join(' ')}"; bed alone "${bed.join(' ')}"; ${extra.length} words only in the stem`;
    });
    await step('render keeps the background under the dub', async () => {
      const mixed = await render(false, 'lồng tiếng giữ nhạc nền.wav', mediaMs), a = probeAudio(mixed.result.path);
      if (mixed.payload.background_asset_id !== stem.result.asset_id || a.channels !== 2) throw Error(`background ${mixed.payload.background_asset_id}, stem ${stem.result.asset_id}, ${a.channels} channels`);
      const shift = lag(framePeaks(job.result.path), framePeaks(mixed.result.path)), gap = [plan[2].end + 200, plan[3].at - 200];
      if (gap[1] - gap[0] < 1000) throw Error(`the gap ${gap.map(Math.round).join('-')} ms is shorter than 1 s`);
      const diff = level(mixed.result.path, [gap]) - level(bedWav, [gap]);
      if (shift || Math.abs(diff) > 1) throw Error(`envelope lag ${shift} ms vs the voice-only render, gap level ${diff.toFixed(2)} dB vs the bed`);
      return `stereo ${mixed.result.duration_ms} ms; envelope lag ${shift} ms; gap ${gap.map(Math.round).join('-')} ms at ${diff >= 0 ? '+' : ''}${diff.toFixed(2)} dB vs the bed`;
    });
    await step('a separation can be cancelled and leaves no process or partial behind', async () => {
      const again = await invoke('enqueue_job', {kind: 'separate', projectId: project.id, payload: {asset_id: project.source_asset_id}});
      let j;
      for (const end = Date.now() + 5 * 60000; ; await page.waitForTimeout(250)) {
        j = (await invoke('list_jobs')).find((x) => x.id === again.id);
        if (!['queued', 'running'].includes(j.status) || Date.now() > end) throw Error(`separation ${j.status} at ${j.progress} before it could be cancelled ${j.error ?? ''}`);
        if (j.status === 'running' && j.progress > 0.05) break;
      }
      await invoke('cancel_job', {id: again.id});
      await page.waitForTimeout(10000);
      j = (await invoke('list_jobs')).find((x) => x.id === again.id);
      const workers = [JSON.parse(execFileSync('powershell', ['-NoProfile', '-Command', `@(Get-Process python,thanham-worker,ffmpeg -EA SilentlyContinue | Where-Object { $_.Path -like '${dirname(exe)}\\*' -or $_.Path -like '*\\models\\separation-runtime\\*' } | Select-Object ProcessName,Id) | ConvertTo-Json -Compress`], {encoding: 'utf8'}) || '[]')].flat();
      const folder = join(process.env.LOCALAPPDATA, 'studio.thanham.desktop', 'jobs', again.id), files = existsSync(folder) ? readdirSync(folder) : [];
      if (j.status !== 'cancelled' || workers.length || files.some((f) => /\.flac$/i.test(f))) throw Error(JSON.stringify({status: j.status, workers, files}));
      return `cancelled at ${Math.round(j.progress * 100)} %; no worker python or ffmpeg after 10 s; job folder: ${files.join(', ') || 'none'}`;
    });
    await step('after separations the pack passes its re-check and equals its manifest', packRecheck);
  }
  if (phase === 'update') {
    await step('update refuses a package that does not match its signature', async () => {
      for (let i = 0; i < 30 && !served.length; i++) await page.waitForTimeout(500); // the automatic check runs 3 s after start
      await page.waitForTimeout(3000);
      await nav('Model & cài đặt');
      await page.getByRole('button', {name: 'Kiểm tra ngay'}).click({timeout: 120000}); // enabled once the automatic check is over
      const alert = page.getByRole('alert').filter({hasText: 'Không kiểm tra được bản mới'});
      await alert.waitFor({timeout: 120000});
      const text = (await alert.innerText()).replace(/\s+/g, ' ');
      if (await page.getByText(/đã tải xong/).count()) throw Error('a truncated package was offered for install');
      await alert.getByRole('button', {name: 'Đóng lỗi cập nhật'}).click();
      return `${served.length} requests; ${text}`;
    });
    await step('update downloads, verifies, installs and reopens the signed release, keeping projects', async () => {
      if (!(await invoke('list_projects')).length) await invoke('create_project', {name: 'Giữ qua bản cập nhật'}); // run alone, the phase brings its own project
      const projects = (await invoke('list_projects')).length, sentinel = join(dirname(exe), 'uninstall.exe'), from = await invoke('plugin:app|version');
      rmSync(sentinel, {force: true}); // the installer writes it again near its end (Sandbox only: a failed install would leave no uninstaller)
      // 1.0.15 shipped these and later versions do not; the updater installs without uninstalling, so src-tauri/installer-hooks.nsh deletes them.
      const site = join(dirname(exe), 'runtime', 'python', 'Lib', 'site-packages');
      // The separation packages left the installer in 1.0.17: the hook removes them and their dist-info as well.
      const gone = ['torch', 'demucs', 'julius', 'einops', 'safetensors'];
      const leftovers = () => [join(site, 'torch', 'lib', 'libiompstubs5md.dll'), join(site, 'ctranslate2', 'cudnn64_9.dll'), ...gone.map((p) => join(site, p)),
        ...(existsSync(site) ? readdirSync(site).filter((n) => gone.some((p) => n.startsWith(`${p}-`) && n.endsWith('.dist-info'))).map((n) => join(site, n)) : [])].filter((f) => existsSync(f));
      const before = leftovers().length;
      feed('/good');
      await page.getByRole('button', {name: 'Kiểm tra ngay'}).click();
      await page.getByText(/đã tải xong và đã kiểm chữ ký/).first().waitFor({timeout: 300000});
      const exited = new Promise((ok) => app.once('exit', ok));
      await page.getByRole('button', {name: 'Cài ngay và mở lại'}).click();
      await exited;
      // The updater copies the installer to %TEMP%\<app>-<version>-updater-*\ and exits; the next start must remove it.
      const copies = () => readdirSync(tmpdir()).filter((n) => n.normalize('NFC').startsWith('Thanh Âm Studio-') && n.includes('-updater-'));
      const left = copies();
      if (!left.length) throw Error(`no installer copy in ${tmpdir()} to check`);
      for (let i = 0; i < 360 && !existsSync(sentinel); i++) await new Promise((r) => setTimeout(r, 500));
      if (!existsSync(sentinel)) throw Error('installer did not finish within 3 min');
      let reopened = false;
      for (let i = 0; i < 60 && !reopened; i++) { await new Promise((r) => setTimeout(r, 500)); reopened = execFileSync('tasklist', ['/FI', 'IMAGENAME eq thanh-am-studio.exe', '/NH'], {encoding: 'utf8'}).includes('thanh-am-studio.exe'); }
      if (!reopened) throw Error('the app did not reopen after the install');
      // Relaunch under the harness so the checks below run in a window it controls.
      await new Promise((r) => setTimeout(r, 5000));
      try { execFileSync('taskkill', ['/IM', 'thanh-am-studio.exe', '/F'], {stdio: 'ignore'}); } catch {}
      await new Promise((r) => setTimeout(r, 2000));
      await launch(); await page.waitForTimeout(2000);
      if (await page.getByText(/Chưa cài được bản/).count()) throw Error('reported a failed install');
      for (let i = 0; i < 120 && copies().length; i++) await page.waitForTimeout(500);
      if (copies().length) throw Error(`installer copy still in ${tmpdir()}: ${copies().join(' | ')}`);
      const now = await invoke('plugin:app|version'), want = JSON.parse(readFileSync(process.env.THANHAM_UPDATE_FEED, 'utf8').replace(/^\uFEFF/, '')).version;
      if (now !== want) throw Error(`running ${now} after the update, the feed offers ${want}`);
      const rs = await invoke('runtime_status');
      if (!rs.native_worker_ready) throw Error(`native worker not ready after the update: ${JSON.stringify(rs)}`);
      if (process.env.THANHAM_UPDATE_FROM && from === now) throw Error(`-From installed ${from}, the version under test, so no earlier release was updated`);
      const after = (await invoke('list_projects')).length;
      if (after !== projects) throw Error(`projects ${projects} -> ${after}`);
      if (leftovers().length) throw Error(`left behind by the update: ${leftovers().join(' | ')}`);
      return `${from} -> ${now}, reopened; ${after} projects kept; installer copy ${left.join(' | ')} removed; ${before} of 2 files the new version no longer ships were present, none left; requests ${served.join(' ')}`;
    });
  }
  if (phase === 'update-seeded') {
    // After `update -From <previous> -Seed <folder>`: the models seeded before the first install are used as they are, with no
    // download job and no changed file, and the separation pack, which the installer no longer carries, is offered, downloaded and used.
    const models = join(process.env.LOCALAPPDATA, 'studio.thanham.desktop', 'models'), seeded = ['vieneu-v3', 'whisper-small', 'diarization', 'htdemucs'];
    const treeHash = (dir) => { const h = createHash('sha256'); for (const f of relFiles(dir)) h.update(`${f}\0${sha256File(join(dir, f))}\n`); return h.digest('hex'); };
    const audio = process.env.THANHAM_UX_AUDIO;
    if (!audio || !existsSync(audio)) throw Error('THANHAM_UX_AUDIO (dialogue.wav next to the installer) is required');
    const baseline = {}, downloadsBefore = (await invoke('list_jobs')).filter((j) => j.kind === 'model_download').length;
    await step('seeded models are installed and untouched by the update', async () => {
      const list = await invoke('list_models');
      for (const id of seeded) {
        if (!list.find((m) => m.id === id)?.installed) throw Error(`${id} is not installed: ${JSON.stringify(list.map((m) => [m.id, m.installed]))}`);
        baseline[id] = treeHash(join(models, id));
        if (process.env.THANHAM_SEED && baseline[id] !== treeHash(join(process.env.THANHAM_SEED, id))) throw Error(`${id} differs from the seed`);
      }
      const pack = list.find((m) => m.id === PACK);
      if (!pack || pack.kind !== 'runtime' || pack.installed) throw Error(`the pack should be offered, not installed: ${JSON.stringify(pack)}`);
      return `${seeded.length} models equal their seed; the separation pack is offered`;
    });
    await step('tts runs on the seeded model without a download', async () => {
      await page.getByRole('navigation', {name: 'Điều hướng chính'}).getByRole('button').first().click();
      await page.getByRole('button', {name: 'Thêm nội dung', exact: true}).click();
      await page.getByRole('textbox', {name: 'Nội dung cần thêm'}).fill(fixture);
      await page.getByRole('button', {name: 'Thêm vào kịch bản'}).click();
      await page.getByRole('textbox', {name: 'Nội dung đoạn 2'}).waitFor();
      await page.waitForTimeout(1500); // autosave
      const before = await done('tts');
      await page.getByRole('button', {name: 'Tạo giọng tất cả'}).click();
      await waitJobs('tts', before + 2, 10 * 60000);
    });
    const asset = await invoke('import_asset', {path: audio});
    await step('stt with speakers runs on the seeded models without a download', async () => {
      const before = await done('stt'), queued = await invoke('enqueue_job', {kind: 'stt', projectId: null, payload: {asset_id: asset.id, model_id: 'whisper-small', language: 'vi', diarize: true, num_speakers: 2}});
      const job = (await waitJobs('stt', before + 1, 20 * 60000)).find((j) => j.id === queued.id);
      if (!job || job.result.diarize_error || !job.result.transcript.some((r) => typeof r.speaker === 'number')) throw Error(JSON.stringify(job?.result?.diarize_error ?? job?.result));
      return `${job.result.transcript.length} rows with speakers`;
    });
    await step('separation asks for the pack, downloads it, then separates', async () => {
      const queued = await invoke('enqueue_job', {kind: 'separate', projectId: null, payload: {asset_id: asset.id}});
      for (let i = 0; i < 120; i++) { const j = (await invoke('list_jobs')).find((x) => x.id === queued.id); if (j.status === 'failed') break; if (j.status === 'succeeded') throw Error('separation ran without the pack'); await page.waitForTimeout(500); }
      const failed = (await invoke('list_jobs')).find((x) => x.id === queued.id);
      if (failed.status !== 'failed' || !String(failed.error).startsWith('MODEL_NOT_READY') || !String(failed.error).includes('Chưa có gói chạy tách nhạc nền')) throw Error(`expected the missing-pack message, got ${failed.status}: ${failed.error}`);
      await separationPack();
      const before = await done('separate'), again = await invoke('enqueue_job', {kind: 'separate', projectId: null, payload: {asset_id: asset.id}});
      const job = (await waitJobs('separate', before + 1, 20 * 60000)).find((j) => j.id === again.id);
      return `${failed.error.split('.')[0]}; then separated in ${Math.round((Date.parse(job.updated_at) - Date.parse(job.created_at)) / 1000)} s`;
    });
    await step('after separations the pack passes its re-check and equals its manifest', packRecheck);
    await step('no model download but the pack, and no seeded model file changed', async () => {
      const downloads = (await invoke('list_jobs')).filter((j) => j.kind === 'model_download' && j.payload.model_id !== PACK);
      if (downloads.length !== downloadsBefore) throw Error(`model_download jobs: ${downloadsBefore} before, ${downloads.length} now`);
      for (const id of seeded) if (treeHash(join(models, id)) !== baseline[id]) throw Error(`${id} changed`);
      return `${seeded.length} models unchanged; ${downloads.length} model downloads besides the pack`;
    });
  }
  if (phase === 'ab') {
    // The operations this build routes to the native worker (RUST_OPS: render, download, preset and cloned tts, clone_preview, stt), each
    // run on Python and on the native worker: same job, the chosen engine with no fallback, same output bytes (for tts, under a fixed seed
    // on the installed workers) and the same transcript (for stt, also every event of the installed workers).
    await step('voice model ready', voiceModel);
    const wav = join(saves, 'ab-tone.wav'), n = 24000, pcm = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(8000 * Math.sin(i * 0.05)), i * 2);
    const head = Buffer.alloc(44); head.write('RIFF', 0); head.writeUInt32LE(36 + pcm.length, 4); head.write('WAVEfmt ', 8); head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(24000, 24); head.writeUInt32LE(48000, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(pcm.length, 40);
    writeFileSync(wav, Buffer.concat([head, pcm]));
    const asset = await invoke('import_asset', {path: wav}), base = await invoke('get_settings');
    const segments = [{id: 'ab1', text: 'a', takes: [{id: 't1', asset_id: asset.id}], selected_take_id: 't1', trim_start_ms: 0, trim_end_ms: null, gap_ms: 100, fade_in_ms: 0, fade_out_ms: 0, gain_db: 0}];
    // Counted from what earlier phases left (-Only full,ab shares one Sandbox); one evaluate puts a tts list inside one 300 ms queue
    // poll, so it runs as one worker batch as "Tạo giọng tất cả" makes it (a split batch would still be checked the same way).
    const enqueue = async (list) => {
      const kind = list[0].kind, before = await done(kind);
      const ids = await page.evaluate(async (l) => { const ids = []; for (const a of l) ids.push((await window.__TAURI_INTERNALS__.invoke('enqueue_job', a)).id); return ids; }, list);
      const finished = await waitJobs(kind, before + ids.length, 20 * 60000);
      return ids.map((id) => finished.find((j) => j.id === id));
    };
    // tts items carry the app's payload (App.tsx generate) with no take check, which would keep the whole batch on Python.
    const texts = ['Xin chào, đây là Thanh Âm Studio.', 'Hôm nay trời Hà Nội trong xanh, gió thổi nhẹ.', 'Chúng tôi kiểm tra giọng đọc tiếng Việt trên máy tính.'];
    const project = await invoke('create_project', {name: `A/B ${Date.now()}`});
    project.segments = [refText, ...texts].map((text, i) => ({id: `ab${i}`, text, normalized_text: text, voice_id: 'Trúc Ly', speaker: 'Người dẫn', gap_ms: 300, takes: [], selected_take_id: null, trim_start_ms: 0, trim_end_ms: null, fade_in_ms: 0, fade_out_ms: 0, gain_db: 0}));
    await invoke('save_project', {project});
    const tts = (i, text, voice, reference = null) => ({kind: 'tts', projectId: project.id, payload: {segment_id: `ab${i}`, text, voice_id: voice, speed: 1, reference_asset_id: reference, check: false}});
    let ref, voiceId;
    // An installed worker run as the app runs it (runtime.rs attempt: command line and env), plus the parity seed that only tts reads.
    const runWorker = (rs, engine, request) => new Promise((ok, fail) => {
      const dir = request.output_dir; rmSync(dir, {recursive: true, force: true}); mkdirSync(dir, {recursive: true});
      const [cmd, args, env] = engine === 'python' ? [rs.python_path, ['-I', '-X', 'utf8', join(dirname(exe), 'worker', 'main.py')], {PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8'}] : [rs.native_worker_path, [], {}];
      const p = spawn(cmd, args, {env: {...process.env, ...env, THANHAM_FFMPEG: rs.ffmpeg_path, THANHAM_FFPROBE: join(dirname(rs.ffmpeg_path), 'ffprobe.exe'), HF_HUB_DISABLE_TELEMETRY: '1', THANHAM_TTS_SEED: '7'}, windowsHide: true});
      const timer = setTimeout(() => p.kill(), 20 * 60000);
      let text = '', log = ''; p.stdout.setEncoding('utf8').on('data', (d) => { text += d; }); p.stderr.setEncoding('utf8').on('data', (d) => { log += d; });
      p.on('error', fail).on('close', (code) => { clearTimeout(timer); writeFileSync(join(dir, 'worker.log'), log); ok({code, text}); });
      p.stdin.end(JSON.stringify(request) + '\n');
    });
    await step('reference clip from preset voice', async () => {
      // As in the clone phase, the app's own preset clip, so no third-party voice is involved; its WAV take is a format that passed parity.
      [ref] = await enqueue([tts(0, refText, 'Trúc Ly')]);
      voiceId = (await invoke('save_voice', {voice: {name: 'Giọng mẫu A/B', kind: 'reference', reference_asset_id: ref.result.asset_id, consent: true, engine_voice_id: null}})).id;
      return `${ref.result.duration_ms} ms on ${ref.result.engine}, voice ${voiceId}`;
    });
    // TTS is sampled, and the parity seed both workers carry is keyed on output_name, which the app sets to the job id: app takes never
    // match, so the installed workers run the app's request (runtime.rs prepare_request and the tts batch) with the same output names.
    await step('installed workers agree under a fixed seed', async () => {
      const rs = await invoke('runtime_status'), data = join(process.env.LOCALAPPDATA, 'studio.thanham.desktop'), model = join(data, 'models', 'vieneu-v3');
      const item = (i, text, voice, reference) => ({text, voice_id: voice, reference_path: reference, model_path: model, check_model_path: null, speed: 1, ffmpeg_path: rs.ffmpeg_path, output_name: `ab-${i}.wav`});
      const requests = {'preset tts': {operation: 'tts', payload: {model_path: model, items: texts.map((t, i) => item(i + 1, t, 'Trúc Ly', null))}},
        'cloned tts': {operation: 'tts', payload: {model_path: model, items: texts.map((t, i) => item(i + 1, t, null, ref.result.path))}},
        clone_preview: {operation: 'clone_preview', payload: {reference_path: ref.result.path, model_path: model, output_name: 'ab-preview.wav'}}};
      const run = (engine, request) => runWorker(rs, engine, request);
      const diffs = [], rows = [];
      for (const [name, r] of Object.entries(requests)) { // every request runs, so one difference does not hide the others
        const slug = name.replace(' ', '-'), dirs = {}, wavs = {};
        for (const engine of ['python', 'rust']) {
          dirs[engine] = join(tmpdir(), 'thanham-ab-seeded', engine, slug);
          const {code, text} = await run(engine, {protocol: 1, id: `ab-seeded-${slug}`, ...r, output_dir: dirs[engine], models_dir: join(data, 'models')});
          const events = text.split('\n').flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }); // the app skips lines that are not JSON
          const bad = events.find((e) => e.event === 'error' || e.error);
          if (code !== 0 || bad || !events.some((e) => e.event === 'result')) diffs.push(`${name} on ${engine}: exit ${code}, ${JSON.stringify(bad ?? events.at(-1))}`);
          wavs[engine] = Object.fromEntries(relFiles(dirs[engine]).filter((f) => f.endsWith('.wav')).map((f) => [f, sha256File(join(dirs[engine], f))]));
        }
        const named = (r.payload.items ?? [r.payload]).every((x) => x.output_name in wavs.python);
        if (!named || JSON.stringify(wavs.python) !== JSON.stringify(wavs.rust)) {
          diffs.push(`${name}: python ${JSON.stringify(wavs.python)} vs rust ${JSON.stringify(wavs.rust)}`);
          for (const engine of ['python', 'rust']) cpSync(dirs[engine], join(out, 'ab-seeded', engine, slug), {recursive: true}); // to listen to
        } else rows.push(`${name}: ${Object.keys(wavs.python).length} WAV identical`);
      }
      if (diffs.length) throw Error(diffs.join(' | '));
      return rows.join('; ');
    }).catch(() => {}); // recorded as FAIL; the app-level runs below still run
    const jobs = {render: [{kind: 'render', projectId: null, payload: {segments, normalize: false, format: 'wav'}}], download: [{kind: 'model_download', projectId: null, payload: {model_id: 'diarization'}}],
      tts: texts.map((t, i) => tts(i + 1, t, 'Trúc Ly')), 'cloned tts': texts.map((t, i) => tts(i + 1, t, voiceId, ref.result.asset_id)), clone_preview: [{kind: 'clone_preview', projectId: null, payload: {asset_id: ref.result.asset_id}}],
      stt: [{kind: 'stt', projectId: null, payload: {asset_id: ref.result.asset_id, model_id: 'whisper-small', language: 'vi', diarize: true}}]};
    const ran = {};
    try {
      for (const engine of ['python', 'auto']) {
        await invoke('save_settings', {settings: {...base, worker_engines: {render: engine, download: engine, tts: engine, clone_preview: engine, stt: engine}}});
        for (const [kind, list] of Object.entries(jobs)) {
          await step(`${kind} on ${engine}`, async () => {
            const got = ran[`${kind}-${engine}`] = await enqueue(list);
            for (const job of got) if (job?.result?.engine !== (engine === 'python' ? 'python' : 'rust') || job.result.fallback !== false) throw Error(`${kind} ran on ${job?.result?.engine} (fallback ${job?.result?.fallback}) with worker_engines=${engine}: is it in RUST_OPS for this build? ${JSON.stringify(job?.result)}`);
            return `engine ${got[0].result.engine}${got.length > 1 ? ` for ${got.length} items` : ''}`;
          });
        }
      }
      // Each comparison is recorded as PASS or FAIL and the next one still runs.
      await step('render output is identical on both engines', async () => {
        const sha = async (j) => (await import('node:crypto')).createHash('sha256').update(readFileSync((await invoke('get_asset', {id: j.result.asset_id})).path)).digest('hex');
        const [a, b] = [await sha(ran['render-python'][0]), await sha(ran['render-auto'][0])];
        if (a !== b) throw Error(`render sha256 differs: ${a} vs ${b}`);
        return a.slice(0, 16);
      }).catch(() => {});
      await step('download result is identical on both engines', async () => {
        const [a, b] = [ran['download-python'][0], ran['download-auto'][0]].map((j) => JSON.stringify({model_id: j.result.model_id, revision: j.result.revision}));
        if (a !== b) throw Error(`${a} vs ${b}`);
        return a;
      }).catch(() => {});
      await step('clone_preview output is identical on both engines', async () => {
        const [a, b] = ['python', 'auto'].map((e) => sha256File(ran[`clone_preview-${e}`][0].result.path));
        if (a !== b) throw Error(`clone_preview sha256 differs: ${a} vs ${b}`);
        return a.slice(0, 16);
      }).catch(() => {});
      // Whisper decodes at temperature 0 unless a window falls back to sampling, which a clean preset clip does not: the rows, their
      // speakers and the language must match.
      await step('stt transcript is identical on both engines', async () => {
        // Row ids are UUIDs the app gives each job's rows, so they differ by design; everything else must match.
        const [a, b] = ['python', 'auto'].map((e) => JSON.stringify({transcript: ran[`stt-${e}`][0].result.transcript.map(({id, ...row}) => row), language: ran[`stt-${e}`][0].result.language}));
        if (a !== b) throw Error(`${a} vs ${b}`);
        return `${JSON.parse(a).transcript.length} rows`;
      }).catch(() => {});
      // The installed workers on the app's stt request (runtime.rs prepare_request), with speakers and with automatic language: every
      // event, progress included, must be the same.
      await step('installed workers transcribe identically', async () => {
        const rs = await invoke('runtime_status'), models = join(process.env.LOCALAPPDATA, 'studio.thanham.desktop', 'models');
        const stt = (language, speakers) => ({operation: 'stt', payload: {input_path: ref.result.path, model_path: join(models, 'whisper-small'), language,
          diarize_model_path: speakers ? join(models, 'diarization') : null, num_speakers: null, min_speakers: null, max_speakers: null}});
        const diffs = [], rows = [];
        for (const [name, r] of Object.entries({'stt vi with speakers': stt('vi', true), 'stt auto': stt('auto', false)})) {
          const events = {};
          for (const engine of ['python', 'rust']) {
            const {code, text} = await runWorker(rs, engine, {protocol: 1, id: `ab-${name.replaceAll(' ', '-')}`, ...r, output_dir: join(tmpdir(), 'thanham-ab-stt', engine), models_dir: models});
            events[engine] = text.split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return l; } });
            if (code !== 0 || !events[engine].some((e) => e.event === 'result')) diffs.push(`${name} on ${engine}: exit ${code}, ${JSON.stringify(events[engine].at(-1))}`);
          }
          if (JSON.stringify(events.python) !== JSON.stringify(events.rust)) diffs.push(`${name}: python ${JSON.stringify(events.python)} vs rust ${JSON.stringify(events.rust)}`);
          else rows.push(`${name}: ${events.python.length} events identical`);
        }
        if (diffs.length) throw Error(diffs.join(' | '));
        return rows.join('; ');
      }).catch(() => {});
      // App takes are sampled (see the fixed-seed step), so each is checked on its own: the take and, when the speed is not 1, its
      // reading before the speed change (raw_asset_id).
      for (const kind of ['tts', 'cloned tts']) await step(`${kind} takes are non-empty 48 kHz WAV on both engines`, async () => {
        const files = [];
        for (const engine of ['python', 'auto']) for (const {result: r} of ran[`${kind}-${engine}`]) for (const p of [r.path, r.raw_asset_id && (await invoke('get_asset', {id: r.raw_asset_id})).path]) if (p) files.push(p);
        const bad = files.filter((p) => { try { const w = readWav(p); return w.rate !== 48000 || !w.samples.length; } catch { return true; } });
        if (bad.length) throw Error(`${bad.length} of ${files.length} take files missing, empty or not 48 kHz WAV: ${bad.join(' | ')}`);
        return `${files.length} files`;
      }).catch(() => {});
    } finally { await invoke('save_settings', {settings: {...base, worker_engines: base.worker_engines ?? {}}}); } // the user's engine choice; {} when none was saved, since an absent key keeps the last one
  }
  if (phase === 'export') {
    await nav('Dự án');
    await page.getByRole('button', {name: 'Mở dự án', exact: true}).first().click();
    await page.getByRole('textbox', {name: 'Nội dung đoạn 1'}).waitFor();
    await exportSteps();
  }
  if (phase === 'reopen' || phase === 'offline') {
    await step('project persisted after restart', async () => {
      await nav('Dự án');
      await page.getByRole('button', {name: 'Mở dự án', exact: true}).first().click();
      await page.getByRole('textbox', {name: 'Nội dung đoạn 1'}).waitFor();
      await page.getByText('2 take').first().waitFor({timeout: 10000});
      return await page.getByRole('textbox', {name: 'Nội dung đoạn 1'}).inputValue();
    });
  }
  if (phase === 'offline') {
    await step('offline tts after preload', async () => {
      const before = (await invoke('list_jobs')).filter((j) => j.kind === 'tts' && j.status === 'succeeded').length;
      await page.getByRole('button', {name: 'Tạo take mới'}).nth(1).click();
      await waitJobs('tts', before + 1, 5 * 60000);
    });
  }
  if (phase === 'nvda') {
    // What NVDA announces for focus, live messages, the native drop-down and Ctrl+P. Only inside the Sandbox: nvda.ps1 downloads
    // a pinned NVDA, checks it and runs a portable copy with the silent synth, browse mode off on page load and an IO log that
    // records every sequence it would speak (nvdalog.mjs reads it). Page-level keys go over CDP; Ctrl+P and the native select
    // popup need OS input (nvda.ps1 -Keys), since CDP reaches neither WebView2's host accelerators nor the popup.
    // nvdaStep() never rethrows, so every S-step runs. THANHAM_NVDA_BASELINE=1 runs it on 1.0.22, a release without these fixes
    // (the phase ABORTs on any other version; never set it in a gate run): a failing step marked baselineExpectFail logs
    // `NOTE expected-fail-1.0.22`, a passing one logs FAIL, and S7b, the print detector's negative control, runs. Needs THANHAM_UX_AUDIO; S6 needs the first-run checklist done (run `full` first),
    // since the checklist announces the first take instead of "Đã tạo xong".
    const {readNew, speechOf} = await import('./nvdalog.mjs');
    const baseline = process.env.THANHAM_NVDA_BASELINE === '1', nvdaLog = join(out, 'nvda.log'), jsonl = join(out, 'nvda-speech.jsonl');
    // A failure keeps nvda.ps1's own message (stderr); the download gets 5 minutes, every other call 1 minute.
    const nvda = (...args) => {
      try { return execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'nvda.ps1'), ...args], {encoding: 'utf8', timeout: args[0] === '-Install' ? 300000 : 60000}).trim(); }
      catch (e) { throw Error(`nvda.ps1 ${args.join(' ')}: ${String(e.stderr ?? '').split(/\r?\n/).find((l) => l.trim()) || e.message}`); }
    };
    const osKeys = (keys) => nvda('-Keys', keys, '-Pid', String(app.pid));
    const windows = () => JSON.parse(nvda('-Windows', '-Pid', String(app.pid)) || '[]');
    let cursor = {offset: 0, id: null}, heard = [], said = [], rec = null, carried = {heard: [], said: []}, s7fresh = [], projectId;
    const poll = () => { const r = readNew(nvdaLog, cursor); cursor = r.cursor; for (const s of speechOf(r.entries)) { heard.push(s.strings.join(' ')); said.push(...s.strings); } };
    const mark = () => { poll(); rec?.spoken.push(...heard); heard = []; said = []; }; // a new input: keep what was heard with the step
    const norm = (s) => s.normalize('NFC').toLowerCase();
    // A fragment may be anywhere in what was heard; an array of fragments must all be in one utterance.
    const has = (want) => Array.isArray(want) ? heard.some((u) => want.every((f) => norm(u).includes(norm(f)))) : norm(heard.join(' | ')).includes(norm(want));
    const hear = async (wants, ms) => {
      rec.expected.push(...wants);
      const end = Date.now() + ms;
      for (poll(); !wants.every(has) && Date.now() < end; poll()) await page.waitForTimeout(200);
      const missing = wants.filter((f) => !has(f));
      if (missing.length) throw Error(`not heard ${JSON.stringify(missing)}; heard ${JSON.stringify(heard).slice(0, 400)}`);
    };
    const activeLabel = () => page.evaluate(() => { const a = document.activeElement; return !a || a === document.body ? 'BODY' : a.getAttribute('aria-label') ?? a.textContent.trim().slice(0, 60); });
    const focusIs = async (label) => { const a = await activeLabel(); if (a !== label) throw Error(`CDP focus is on "${a}", not "${label}"`); };
    const focus = async (locator) => { await locator.focus(); await page.waitForTimeout(500); };
    // carry: the step starts with what the previous step heard (S7a-dialog judges the same Ctrl+P as S7a-print).
    const nvdaStep = async (name, fn, {baselineExpectFail = false, carry = false} = {}) => {
      const t = Date.now();
      poll();
      [heard, said] = carry ? [[...carried.heard, ...heard], [...carried.said, ...said]] : [[], []];
      rec = {step: name, input: '', expected: [], spoken: []};
      let error = null;
      try { await fn(rec); } catch (e) { error = String(e?.message ?? e).split('\n')[0].slice(0, 600); }
      poll();
      rec.spoken.push(...heard);
      carried = {heard, said};
      heard = []; said = [];
      const detector = rec.detector ? ` detector: ${rec.detector}` : '';
      let verdict = error ? 'FAIL' : 'PASS', line = `${verdict} ${name}${detector} ${error ?? `${rec.spoken.length} spoken sequences`}`;
      if (baseline && baselineExpectFail) {
        if (!error) { verdict = 'FAIL'; line = `FAIL ${name} baseline unexpectedly passed${detector}`; }
        else if (name !== 'S7a-print' || rec.detector === 'fired') { verdict = 'NOTE'; line = `NOTE expected-fail-1.0.22 ${name}${detector} ${error}`; }
      }
      Object.assign(rec, {verdict, error, ms: Date.now() - t});
      results.push({name, ok: verdict !== 'FAIL', verdict, ms: rec.ms, detail: line, error: error ?? undefined});
      log(line);
      // S7a-print without a fired detector proves nothing on a baseline release: the section 7 fallback applies.
      if (baseline && name === 'S7a-print' && rec.detector === 'blind') log('NOTE detector-blind S7a-print');
      appendFileSync(jsonl, JSON.stringify(rec) + '\n');
      if (verdict === 'FAIL') await shot(`fail-${name}`);
      rec = null;
    };
    // Ctrl+P's three detectors: beforeprint in the page, NVDA naming a print dialog, a new window of the app's process tree.
    // The page's counters, or null when it does not answer within 2 s (unknown, not zero).
    const printCount = () => Promise.race([page.evaluate(() => window.__printCount ?? {before: 0, after: 0, keys: 0}), new Promise((r) => setTimeout(() => r(null), 2000))]);
    const printDetect = async (before) => {
      await page.waitForTimeout(3000);
      poll();
      const count = await printCount(), fresh = windows().filter((w) => !before.some((b) => b.handle === w.handle)), speech = said.filter((s) => /^(print|in)\b/i.test(s));
      Object.assign(rec, {ctrlPKeydowns: count?.keys ?? 'unknown', beforeprint: count?.before ?? 'unknown', afterprint: count?.after ?? 'unknown', windows: {before, new: fresh}});
      // `reached`: the page saw the Ctrl+P keydown; without it, "nothing printed" proves nothing.
      return {fresh, unknown: !count, reached: count?.keys > 0, fired: [...(count?.before > 0 ? [`beforeprint x${count.before}`] : []), ...(speech.length ? [`speech ${JSON.stringify(speech)}`] : []), ...fresh.map((w) => `window ${w.class} "${w.title}"`)]};
    };
    // Why "nothing printed" is not a pass: the page did not answer, or never saw the key.
    const notProven = ({unknown, reached}) => unknown ? 'the page did not answer within 2 s (print counters unknown)' : reached ? null : 'Ctrl+P never reached the page (no keydown), so the missing print UI proves nothing';
    const countPrint = () => Promise.race([page.evaluate(() => {
      if (!window.__printCount) {
        const c = window.__printCount = {before: 0, after: 0, keys: 0};
        addEventListener('beforeprint', () => c.before++);
        addEventListener('afterprint', () => c.after++);
        addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') c.keys++; }, true);
      }
      Object.assign(window.__printCount, {before: 0, after: 0, keys: 0});
    }), new Promise((_, no) => setTimeout(() => no(Error('the page did not answer within 5 s (print counters not set)')), 5000))]);
    const segmentText = (n) => page.getByRole('textbox', {name: `Nội dung đoạn ${n}`});
    try {
      await step('voice model ready', voiceModel);
      // The baseline verdicts (expected failures) are only true for 1.0.22; a gate run must never set THANHAM_NVDA_BASELINE.
      if (baseline) await step('nvda baseline runs on 1.0.22 only', async () => {
        const version = execFileSync('powershell', ['-NoProfile', '-Command', '(Get-Item -LiteralPath $env:THANHAM_EXE).VersionInfo.ProductVersion'], {encoding: 'utf8', env: {...process.env, THANHAM_EXE: exe}}).trim();
        if (version !== '1.0.22') throw Error(`THANHAM_NVDA_BASELINE=1 is for the 1.0.22 installer only; this app is ${version || 'of unknown version'}`);
        return `app ${version}`;
      });
      await step('nvda setup: download, verify, portable copy', async () => nvda('-Install', '-Out', out));
      await step('nvda start', async () => nvda('-Start', '-Out', out));
      await step('nvda seed project "NVDA kiểm tra"', async () => {
        const src = process.env.THANHAM_UX_AUDIO;
        if (!src || !existsSync(src)) throw Error(`THANHAM_UX_AUDIO missing: ${src}`);
        const audio = join(saves, `nvda ${Date.now()}${src.slice(src.lastIndexOf('.'))}`);
        copyFileSync(src, audio);
        // import_asset does not probe the duration (duration_ms is null), so a WAV's comes from its header; other formats get 12 s.
        const asset = await invoke('import_asset', {path: audio}), created = await invoke('create_project', {name: 'NVDA kiểm tra'});
        const wav = /\.wav$/i.test(audio) ? readWav(audio) : null, d = asset.duration_ms ?? (wav ? Math.round(1000 * wav.samples.length / wav.rate) : 12000);
        const seg = (speaker, text, chapter = null) => ({id: crypto.randomUUID(), text, normalized_text: text, voice_id: null, speaker, gap_ms: 300, takes: [], selected_take_id: null, trim_start_ms: 0, trim_end_ms: null, fade_in_ms: 0, fade_out_ms: 0, gain_db: 0, chapter});
        const rows = ['Dòng thứ nhất của bản chép lời', 'Dòng thứ hai nói tiếp câu chuyện', 'Dòng thứ ba kết thúc đoạn nghe'].map((text, i) => ({id: crypto.randomUUID(), start_ms: Math.round(d * i / 3), end_ms: Math.round(d * (i + 1) / 3), text, speaker: null, overlap_speaker: null}));
        await invoke('save_project', {project: {...created, segments: [seg('Lan', 'Xin chào, đây là bài kiểm tra trình đọc màn hình.', 'P1'), seg('Minh', 'Chúng tôi nghe NVDA đọc từng nút.'), seg('Lan', '')], transcript: rows, source_asset_id: asset.id}});
        projectId = created.id;
        await nav('Dự án');
        const open = page.locator('article.project-card', {has: page.getByRole('heading', {name: 'NVDA kiểm tra', exact: true})}).getByRole('button', {name: 'Mở dự án', exact: true}).first();
        await open.waitFor({timeout: 15000});
        await open.click();
        await segmentText(3).waitFor();
        return `3 segments, ${rows.length} transcript rows over ${asset.name} (${d} ms)`;
      });
      await step('nvda hears the app', async () => {
        const f = nvda('-Focus', '-Pid', String(app.pid));
        rec = {expected: [], spoken: []}; // not an S-step: only proves that focus changes reach NVDA's log
        mark();
        await segmentText(2).focus();
        await hear(['Nội dung đoạn 2'], 10000).finally(() => { rec = null; });
        return f;
      });
      await nvdaStep('S1 skip link', async (r) => {
        r.input = 'CDP: focus the page start, Tab; Enter';
        await nav('Tạo giọng đọc');
        // Tab from the start of the page: blur() alone would keep Chromium's sequential focus starting point where focus was.
        await page.evaluate(() => { const s = document.querySelector('.app-shell'); s.tabIndex = -1; s.addEventListener('blur', () => s.removeAttribute('tabindex'), {once: true}); s.focus(); });
        await page.waitForTimeout(500);
        mark();
        await page.keyboard.press('Tab');
        await hear([['Bỏ qua đến Xuất audio', 'link']], 5000);
        await focusIs('Bỏ qua đến Xuất audio');
        mark();
        await page.keyboard.press('Enter');
        await hear(['Xuất audio'], 5000);
        await focusIs('Xuất audio');
      });
      await nvdaStep('S2 toolbar', async (r) => {
        r.input = 'CDP: focus segment 1 textarea, Shift+Tab; ArrowRight x3';
        await focus(segmentText(1));
        mark();
        await page.keyboard.press('Shift+Tab');
        await hear([['Thao tác đoạn 1', 'tool bar'], ['Chia đoạn tại con trỏ', 'button']], 5000); // NVDA's role label is "tool bar"
        await focusIs('Chia đoạn tại con trỏ');
        mark();
        for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
        await hear([['Đưa đoạn lên', 'unavailable', 'Đây là đoạn đầu tiên']], 5000);
        await focusIs('Đưa đoạn lên');
      });
      await nvdaStep('S3 blocked Ctrl+Enter', async (r) => {
        r.input = 'CDP: focus segment 3 textarea (empty), Ctrl+Enter';
        await focus(segmentText(3));
        mark();
        await page.keyboard.press('Control+Enter');
        await hear(['Chưa tạo giọng được: Đoạn này chưa có nội dung'], 5000);
      }, {baselineExpectFail: true});
      await nvdaStep('S4 inspector and Esc', async (r) => {
        r.input = 'CDP: focus segment 1 toolbar, End, Enter; Escape';
        await focus(page.getByRole('toolbar', {name: 'Thao tác đoạn 1'}).locator('button[tabindex="0"]'));
        mark();
        await page.keyboard.press('End');
        await hear([['Chi tiết đoạn 1', 'button']], 5000);
        await focusIs('Chi tiết đoạn 1');
        mark();
        await page.keyboard.press('Enter');
        await hear([['Giọng đoạn 1', 'combo box']], 5000);
        await focusIs('Giọng đoạn 1');
        mark();
        await page.keyboard.press('Escape');
        await hear([['Nội dung đoạn 1', 'edit']], 5000);
        await focusIs('Nội dung đoạn 1');
      });
      await nvdaStep('S5 native popup Esc', async (r) => {
        r.input = 'CDP: focus "Giọng đoạn 1"; OS %{DOWN}; OS {ESC}; then CDP Escape';
        const select = page.getByRole('combobox', {name: 'Giọng đoạn 1'});
        await focus(select);
        const before = windows();
        mark();
        osKeys('%{DOWN}');
        // Open: the app's process tree shows a new popup window, or NVDA says "expanded" or an "N of M" list position.
        let opened = null;
        for (const end = Date.now() + 2000; !opened;) {
          poll();
          const fresh = windows().filter((w) => !before.some((b) => b.handle === w.handle));
          if (fresh.length) opened = {by: 'window', windows: fresh};
          else if (has('expanded') || heard.some((u) => /\b\d+ of \d+\b/.test(u))) opened = {by: 'speech', windows: []};
          else if (Date.now() > end) break;
          else await page.waitForTimeout(200);
        }
        r.windows = {before, popup: opened?.windows ?? null};
        if (!opened) throw Error('popup not opened');
        r.popupProof = opened.by;
        const expanded = has('expanded'); // "collapsed" proves a close only after NVDA said "expanded"
        mark();
        const t = Date.now();
        osKeys('{ESC}');
        // Closed: its window is gone, or NVDA says "collapsed". Only then the CDP Escape, which could otherwise close a still-open popup by blur.
        let closed = null;
        for (const end = Date.now() + 2000; !closed;) {
          poll();
          if (opened.windows.length && !windows().some((w) => opened.windows.some((o) => o.handle === w.handle))) closed = 'window';
          else if (expanded && has('collapsed')) closed = 'speech';
          else if (Date.now() > end) break;
          else await page.waitForTimeout(200);
        }
        r.closeProof = closed;
        if (!closed) throw Error('popup not closed by Esc');
        await page.waitForTimeout(Math.max(0, 2000 - (Date.now() - t)));
        poll();
        if (has('Nội dung đoạn 1')) throw Error('the Esc that closed the popup also moved focus out of the select');
        await focusIs('Giọng đoạn 1');
        mark();
        await page.keyboard.press('Escape');
        await hear(['Nội dung đoạn 1'], 5000);
      });
      await nvdaStep('S6 Đã tạo xong', async (r) => {
        r.input = 'CDP: focus segment 1 textarea, Ctrl+Enter';
        await focus(segmentText(1));
        mark();
        await page.keyboard.press('Control+Enter');
        await hear(['Đã tạo xong đoạn 1'], 180000);
      });
      await nvdaStep('S8 transcript follow', async (r) => {
        r.input = 'CDP: STT page, Space (5 s of playback); focus "Theo lời khi phát", Space';
        await nav('Chép lời');
        const audio = page.locator('.source-player audio'), rows = (await invoke('load_project', {id: projectId})).transcript.map((x) => x.text);
        const follow = page.getByRole('button', {name: 'Theo lời khi phát'});
        // Follow-along must be on, so the rows really move during playback and the toggle below really turns it off.
        if ((await follow.getAttribute('aria-pressed')) !== 'true') throw Error('"Theo lời khi phát" is already off (aria-pressed is not true)');
        await audio.waitFor({timeout: 10000});
        await audio.evaluate((a) => { a.muted = true; a.currentTime = 0; });
        await page.evaluate(() => document.activeElement?.blur());
        await page.waitForTimeout(500);
        const before = await activeLabel();
        mark();
        await page.keyboard.press('Space');
        await page.waitForTimeout(5000);
        poll();
        r.forbidden = rows;
        const played = await audio.evaluate((a) => { const t = a.currentTime; a.pause(); return t; }), named = rows.filter(has), after = await activeLabel();
        if (played < 1) throw Error(`the source did not play (currentTime ${played} s)`);
        if (named.length) throw Error(`rows named during playback: ${JSON.stringify(named)}`);
        if (after !== before) throw Error(`focus moved during playback: "${before}" -> "${after}"`);
        mark();
        await follow.focus();
        await hear([['Theo lời khi phát', 'toggle button']], 5000);
        mark(); // after the focus speech, which itself says "pressed"
        await page.keyboard.press('Space');
        await hear(['not pressed'], 5000);
        const state = await follow.getAttribute('aria-pressed');
        if (state !== 'false') throw Error(`aria-pressed is ${state} after Space, not false`);
      });
      // One Ctrl+P, two verdicts: S7a-print (no print UI: the gate criterion) and S7a-dialog (quick-open).
      await nvdaStep('S7a-print', async (r) => {
        r.input = 'CDP: beforeprint/afterprint/Ctrl+P keydown counters, focus segment 1 textarea; OS ^p';
        await nav('Tạo giọng đọc');
        await countPrint();
        await focus(segmentText(1));
        const before = windows();
        mark();
        osKeys('^p');
        const found = await printDetect(before), {fired} = found;
        s7fresh = found.fresh;
        r.detector = fired.length ? 'fired' : 'blind';
        if (fired.length) throw Error(`print UI detected: ${fired.join('; ')}`);
        if (notProven(found)) throw Error(notProven(found));
      }, {baselineExpectFail: true});
      await nvdaStep('S7a-dialog', async (r) => {
        r.input = 'the Ctrl+P of S7a-print; then CDP Escape';
        const dialog = page.getByRole('dialog', {name: 'Mở nhanh dự án'});
        await hear(['Mở nhanh dự án', 'dialog'], 5000);
        if (!(await dialog.count())) throw Error('no "Mở nhanh dự án" dialog in the page');
        mark();
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
        await focusIs('Nội dung đoạn 1');
      }, {baselineExpectFail: true, carry: true});
      if (baseline) await nvdaStep('S7b detector control', async (r) => {
        r.input = 'OS {ESC} until the print UI is gone (3 tries at most); CDP capture keydown preventDefault on Ctrl+P; OS ^p';
        // Still open: the page does not answer, afterprint has not followed beforeprint, or a print window from S7a is still there.
        const open = async () => { const c = await printCount(), w = windows(); return !c || c.after < c.before || s7fresh.some((x) => w.some((y) => y.handle === x.handle)); };
        for (let i = 0; i < 3 && (i === 0 || await open()); i++) { osKeys('{ESC}'); await page.waitForTimeout(1500); }
        if (await open()) throw Error('the print UI from S7a did not close');
        await countPrint();
        await page.evaluate(() => addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') e.preventDefault(); }, true));
        await focus(segmentText(1));
        const before = windows();
        mark();
        osKeys('^p');
        const found = await printDetect(before), {fired} = found;
        r.printDetected = fired;
        if (fired.length) throw Error(`print UI detected despite a page-level preventDefault: ${fired.join('; ')} (PLAN section 11 Q8)`);
        if (notProven(found)) throw Error(notProven(found));
      });
    } finally {
      try { log(`nvda stop: ${nvda('-Stop')}`); } catch (e) { log(`nvda stop failed: ${String(e).split('\n')[0]}`); }
    }
  }
  await shot(`end-${phase}`);
} catch (e) {
  log(`ABORT ${e}`);
} finally {
  writeFileSync(join(out, `results-${phase}.json`), JSON.stringify(results, null, 1));
  if (app) await quit();
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
