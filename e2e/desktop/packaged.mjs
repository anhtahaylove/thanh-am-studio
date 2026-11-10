// Acceptance run against the packaged desktop app (UI -> Rust -> worker -> files).
// usage: node packaged.mjs <app.exe> <outDir> <phase: full|reopen|offline>
// Drives the real WebView2 over CDP; native file dialogs are filled by file-dialog.ps1.
import {chromium} from 'playwright-core';
import {spawn, execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, writeFileSync, appendFileSync, statSync} from 'node:fs';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const [exe, out, phase = 'full'] = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(out, {recursive: true});
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
const dialog = (path) => execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'file-dialog.ps1'), '-Path', path], {encoding: 'utf8'});
const nav = (name) => page.getByRole('navigation', {name: 'Điều hướng chính'}).getByRole('button', {name, exact: true}).click();
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
  app = spawn(exe, [], {env: {...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9222'}, stdio: 'ignore'});
  let browser;
  for (let i = 0; i < 120 && !browser; i++) { try { browser = await chromium.connectOverCDP('http://127.0.0.1:9222'); } catch { await new Promise((r) => setTimeout(r, 500)); } }
  if (!browser) throw Error('app did not expose WebView2 CDP');
  page = browser.contexts()[0].pages()[0];
  await page.getByRole('navigation', {name: 'Điều hướng chính'}).waitFor({timeout: 60000});
  return Date.now() - started;
}
async function quit() { app.kill(); await new Promise((r) => setTimeout(r, 3000)); }

const fixture = 'Xin chào, đây là Thanh Âm Studio. Hôm nay trời Hà Nội trong xanh.\nChúng tôi kiểm tra giọng đọc tiếng Việt trên máy tính.';
try {
  await step('launch', async () => `cold start ${await launch()} ms`);
  await step('runtime bundled', async () => {
    const s = await invoke('runtime_status');
    if (!s.python_ready || !s.ffmpeg_ready || !s.worker_ready) throw Error(JSON.stringify(s));
    return s.python_path;
  });
  if (phase === 'full') {
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
      return `2 segments in ${Date.now() - t} ms, audio ${jobs.map((j) => j.result.duration_ms).join('+')} ms`;
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
    const wav = join(out, 'xuất thử ổn định.wav');
    await step('render and export wav via save dialog', async () => {
      await page.getByRole('button', {name: 'Xuất audio'}).click();
      await waitJobs('render', 1, 5 * 60000);
      await nav('Hàng đợi');
      await page.getByRole('button', {name: 'Lưu audio'}).first().click();
      dialog(wav);
      for (let i = 0; i < 20 && !existsSync(wav); i++) await page.waitForTimeout(500);
      return `${statSync(wav).size} bytes`;
    });
    await step('stt from exported audio and apply', async () => {
      await nav('Chép lời');
      await page.getByRole('combobox', {name: 'Model STT'}).selectOption('whisper-small');
      const t = Date.now();
      await page.getByRole('button', {name: 'Chọn tệp & chép lời'}).click();
      dialog(wav);
      const [job] = await waitJobs('stt', 1, 10 * 60000);
      await nav('Hàng đợi');
      await page.getByRole('button', {name: 'Áp dụng transcript'}).first().click();
      await nav('Chép lời');
      const text = job.result.transcript.map((s) => s.text).join(' ');
      writeFileSync(join(out, 'stt.txt'), text);
      return `${Date.now() - t} ms: ${text}`;
    });
    await step('export srt via save dialog', async () => {
      const srt = join(out, 'phụ đề.srt');
      await page.getByRole('button', {name: 'SRT', exact: true}).first().click();
      dialog(srt);
      for (let i = 0; i < 20 && !existsSync(srt); i++) await page.waitForTimeout(500);
      return `${statSync(srt).size} bytes`;
    });
  }
  if (phase === 'reopen' || phase === 'offline') {
    await step('project persisted after restart', async () => {
      await nav('Dự án');
      await page.getByRole('button', {name: 'Mở dự án'}).first().click();
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
  await shot(`end-${phase}`);
} catch (e) {
  log(`ABORT ${e}`);
} finally {
  writeFileSync(join(out, `results-${phase}.json`), JSON.stringify(results, null, 1));
  if (app) await quit();
  process.exit(results.every((r) => r.ok) ? 0 : 1);
}
