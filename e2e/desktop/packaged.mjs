// Acceptance run against the packaged desktop app (UI -> Rust -> worker -> files).
// usage: node packaged.mjs <app.exe> <outDir> <phase: full|reopen|turbo|offline|export|clone|dpi|longstt>
// Drives the real WebView2 over CDP; native file dialogs are filled by file-dialog.ps1.
import {chromium} from 'playwright-core';
import {spawn, execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, writeFileSync, appendFileSync, statSync, copyFileSync, readdirSync, readFileSync} from 'node:fs';
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

const saved = async (path) => {
  for (let i = 0; i < 60 && !existsSync(path); i++) await page.waitForTimeout(500);
  if (!existsSync(path)) throw Error(`not saved after 30 s; folder has: ${readdirSync(dirname(path)).join(' | ')}`);
};
// The queue UI refreshes every 2.5 s, so pick the row by its text instead of the first button:
// a stale list would offer an earlier render whose format the save dialog then rejects.
const jobButton = (text, name) => page.locator('article', {hasText: text}).getByRole('button', {name});
const done = async (kind) => (await invoke('list_jobs')).filter((j) => j.kind === kind && j.status === 'succeeded').length;
async function exportSteps() {
  const wav = join(saves, `xuất thử ổn định ${Date.now()}.wav`);
  await step('render and export wav via save dialog', async () => {
    const before = await done('render');
    await page.getByRole('button', {name: 'Xuất audio'}).click();
    const [job] = await waitJobs('render', before + 1, 5 * 60000);
    await nav('Hàng đợi');
    await jobButton(job.id, 'Lưu audio').click();
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
  }

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
    await exportSteps();
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
      await page.getByRole('button', {name: 'Mở dự án'}).first().click();
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
      const pid = await project('Mẫu giọng kiểm thử', ['Xin chào các bạn, tôi là người dẫn chương trình. Hôm nay trời rất đẹp, chúng ta cùng nhau đi dạo quanh hồ Gươm và nghe kể về những câu chuyện xưa của thành phố.'], 'Trúc Ly');
      await generateAll(1);
      const take = (await invoke('load_project', {id: pid})).segments[0].takes[0];
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
        const ps = JSON.parse(execFileSync('powershell', ['-NoProfile', '-Command', "@(Get-Process python -EA SilentlyContinue | Where-Object { $_.Path -like '*thanh*' } | Select-Object WorkingSet64) | ConvertTo-Json -Compress"], {encoding: 'utf8'}) || '[]');
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
    await page.getByRole('button', {name: 'Mở dự án'}).first().click();
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
              else if (el.scrollWidth > el.clientWidth + 1 && cs.overflow !== 'visible' && el.tagName !== 'TEXTAREA' && el.tagName !== 'SELECT') out.push(`${el.tagName.toLowerCase()} "${(el.textContent || '').trim().slice(0, 30)}" text is clipped`);
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
  if (phase === 'export') {
    await nav('Dự án');
    await page.getByRole('button', {name: 'Mở dự án'}).first().click();
    await page.getByRole('textbox', {name: 'Nội dung đoạn 1'}).waitFor();
    await exportSteps();
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
