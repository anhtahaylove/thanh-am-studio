// Long-project gate against the packaged app: 500 segments (~60 min audio), cancel, hard crash
// mid-batch, restart/retry, full render, STT round trip with WER/CER, RAM and timing.
// usage: node gate.mjs <app.exe> <outDir> [segments=500]
import {chromium} from 'playwright-core';
import {spawn, execSync} from 'node:child_process';
import {mkdirSync, writeFileSync, appendFileSync, copyFileSync} from 'node:fs';
import {join} from 'node:path';

// usage: ... [segments] [from-render]: resume an existing gate project at the render step.
const [exe, out, n = '500', resume] = process.argv.slice(2);
const N = Number(n);
mkdirSync(out, {recursive: true});
const log = (m) => { const l = `${new Date().toISOString()} ${m}`; console.log(l); appendFileSync(join(out, 'gate.log'), l + '\n'); };
const report = {segments: N};
let page, app, browser;
const invoke = (c, a = {}) => page.evaluate(([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a), [c, a]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = () => { try { return JSON.parse(execSync(`powershell -NoProfile -Command "Get-Process python,thanh-am-studio -EA SilentlyContinue | Where-Object { $_.Path -like '*thanh*' -or $_.ProcessName -like 'thanh*' } | Select-Object Id,ProcessName,WorkingSet64 | ConvertTo-Json -Compress"`, {encoding: 'utf8'}) || '[]'); } catch { return []; } };
const peak = {python: 0, app: 0};
const sample = () => { for (const p of [procs()].flat()) { const k = p.ProcessName === 'python' ? 'python' : 'app'; peak[k] = Math.max(peak[k], p.WorkingSet64); } };

async function launch() {
  const t = Date.now();
  app = spawn(exe, [], {env: {...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9222', THANHAM_E2E_CDP_PORT: '9222'}, stdio: 'ignore'});
  browser = undefined;
  for (let i = 0; i < 120 && !browser; i++) { try { browser = await chromium.connectOverCDP('http://127.0.0.1:9222'); } catch { await sleep(500); } }
  page = browser.contexts()[0].pages()[0];
  await page.getByRole('navigation', {name: 'Điều hướng chính'}).waitFor({timeout: 60000});
  return Date.now() - t;
}
const nav = (name) => page.getByRole('navigation', {name: 'Điều hướng chính'}).getByRole('button', {name: new RegExp(`^${name}`)}).click(); // the queue button also carries a count badge

// Original synthetic Vietnamese script, ~25-30 words per segment.
const who = ['Người dẫn chuyện', 'Cô giáo trẻ', 'Bác nông dân', 'Anh kỹ sư', 'Chị bán hàng', 'Cậu học trò', 'Ông cụ', 'Bà ngoại'];
const where = ['ở Hà Nội', 'bên bờ sông Hồng', 'trên cao nguyên', 'giữa chợ Bến Thành', 'trong làng nhỏ', 'ở Đà Nẵng', 'gần bến xe', 'trên con đường quê'];
const what = ['kể lại một kỷ niệm đẹp về mùa thu năm ấy', 'giải thích cách trồng lúa cho thật tốt', 'chia sẻ bí quyết nấu bát phở thơm ngon', 'nói về những chuyến đi xa đầy thú vị', 'hướng dẫn mọi người tiết kiệm điện mỗi ngày', 'đọc một bài thơ về quê hương yêu dấu'];
const tail = ['Mọi người lắng nghe rất chăm chú và mỉm cười.', 'Sau đó trời bắt đầu đổ mưa nhẹ.', 'Câu chuyện khiến ai cũng nhớ về tuổi thơ.', 'Buổi chiều trôi qua thật nhẹ nhàng và bình yên.', 'Cuối cùng cả nhóm cùng nhau ra về.'];
const script = Array.from({length: N}, (_, i) => `${who[i % who.length]} ${where[(i * 3) % where.length]} ${what[(i * 5) % what.length]}. ${tail[(i * 7) % tail.length]}`);

const norm = (s) => s.toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const dist = (a, b) => { let prev = Array.from({length: b.length + 1}, (_, j) => j); for (let i = 1; i <= a.length; i++) { const cur = [i]; for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; } return prev[b.length]; };
const ttsJobs = async (pid) => (await invoke('list_jobs')).filter((j) => j.kind === 'tts' && j.project_id === pid);

try {
  report.cold_start_ms = await launch();
  const models = await invoke('list_models');
  for (const id of ['vieneu-v3', 'whisper-small']) if (!models.find((m) => m.id === id)?.installed) await invoke('download_model', {id});
  while ((await invoke('list_models')).filter((m) => ['vieneu-v3', 'whisper-small'].includes(m.id) && m.installed).length < 2) await sleep(2000);

  let p, pid, pack = join(out, 'listening');
  if (resume === 'from-render') {
    p = await invoke('load_project', {id: (await invoke('list_projects')).find((x) => x.name === `Gate ${N} đoạn`).id});
    pid = p.id;
    report.audio_ms = p.segments.reduce((a, s) => a + (s.takes.find((t) => t.id === s.selected_take_id)?.duration_ms ?? 0), 0);
    mkdirSync(pack, {recursive: true});
  } else {
    p = await invoke('create_project', {name: `Gate ${N} đoạn`});
    p.segments = script.map((text, i) => ({id: `g${i}`, text, normalized_text: text, voice_id: null, speaker: 'Người dẫn', gap_ms: 300, takes: [], selected_take_id: null, trim_start_ms: 0, trim_end_ms: null, fade_in_ms: 0, fade_out_ms: 0, gain_db: 0}));
    p = await invoke('save_project', {project: p});
    pid = p.id;
    await nav('Dự án');
    await page.getByRole('button', {name: 'Mở dự án'}).first().click();
    await page.getByRole('textbox', {name: `Nội dung đoạn ${N}`}).waitFor({timeout: 60000});
    const t0 = Date.now();
    await page.getByRole('button', {name: 'Tạo giọng tất cả'}).click();
    log('generation started');

    // Cancel three queued jobs, then crash the app mid-batch.
    while ((await ttsJobs(pid)).filter((j) => j.status === 'succeeded').length < 40) { sample(); await sleep(5000); }
    const queued = (await ttsJobs(pid)).filter((j) => j.status === 'queued').slice(-3);
    for (const j of queued) await invoke('cancel_job', {id: j.id});
    report.cancelled = queued.length;
    sample();
    const before = (await ttsJobs(pid)).filter((j) => j.status === 'succeeded').length;
    execSync(`taskkill /F /T /PID ${app.pid}`); // hard crash, no graceful shutdown
    await sleep(3000);
    report.orphan_workers_after_crash = procs().filter((x) => x.ProcessName === 'python').length;
    log(`crashed after ${before} takes; orphan python=${report.orphan_workers_after_crash}`);

    report.restart_ms = await launch();
    const after = await ttsJobs(pid);
    report.after_restart = Object.fromEntries(['succeeded', 'interrupted', 'queued', 'cancelled', 'running', 'failed'].map((s) => [s, after.filter((j) => j.status === s).length]));
    log(`after restart ${JSON.stringify(report.after_restart)}`);
    await nav('Hàng đợi');
    for (const j of after.filter((j) => ['interrupted', 'cancelled'].includes(j.status))) await invoke('retry_job', {id: j.id});

    for (;;) {
      sample();
      const js = await ttsJobs(pid);
      const failed = js.filter((j) => ['failed', 'interrupted'].includes(j.status));
      if (failed.length) throw Error(`tts failed: ${failed[0].error}`);
      if (js.filter((j) => j.status === 'succeeded').length >= N) break;
      await sleep(10000);
    }
    report.tts_wall_s = Math.round((Date.now() - t0) / 1000);
    p = await invoke('load_project', {id: pid});
    const takes = p.segments.map((s) => s.takes.length);
    report.segments_with_take = p.segments.filter((s) => s.selected_take_id && s.takes.length).length;
    report.total_takes = takes.reduce((a, b) => a + b, 0);
    report.audio_ms = p.segments.reduce((a, s) => a + (s.takes.find((t) => t.id === s.selected_take_id)?.duration_ms ?? 0), 0);
    report.rtf = +(report.tts_wall_s * 1000 / report.audio_ms).toFixed(3);
    // Listening pack: first 20 sentences as separate files (same order as the script) for a human A/B pass.
    mkdirSync(pack, {recursive: true});
    p.segments.slice(0, 20).forEach((s, i) => copyFileSync(s.takes.find((t) => t.id === s.selected_take_id).path, join(pack, `${String(i + 1).padStart(2, '0')}.wav`)));
    writeFileSync(join(pack, 'script.txt'), script.slice(0, 20).map((t, i) => `${String(i + 1).padStart(2, '0')} ${t}`).join('\n'));
    log(`tts done ${JSON.stringify(report)}`);

  }
  // Open the project in the UI (a restart leaves no project open), then render through the UI.
  await nav('Dự án');
  await page.getByRole('button', {name: 'Mở dự án'}).first().click();
  await page.getByRole('textbox', {name: `Nội dung đoạn ${N}`}).waitFor({timeout: 60000});
  // Full render through the UI.
  await page.getByRole('navigation', {name: 'Điều hướng chính'}).getByRole('button').first().click();
  const tr = Date.now();
  await page.getByRole('button', {name: 'Xuất audio'}).click();
  let render;
  while (!(render = (await invoke('list_jobs')).find((j) => j.kind === 'render' && j.project_id === pid && j.status === 'succeeded'))) {
    const bad = (await invoke('list_jobs')).find((j) => j.kind === 'render' && j.project_id === pid && j.status === 'failed');
    if (bad) throw Error(`render failed: ${bad.error}`);
    sample(); await sleep(5000);
  }
  report.render_s = Math.round((Date.now() - tr) / 1000);
  report.render_duration_ms = render.result.duration_ms;
  report.render_expected_ms = report.audio_ms + 300 * N;
  copyFileSync(render.result.path, join(pack, 'full-render.wav'));

  // STT round trip on the full render; reference = the script that was synthesized.
  const ts = Date.now();
  const stt = await invoke('enqueue_job', {kind: 'stt', projectId: pid, payload: {asset_id: render.result.asset_id, model_id: 'whisper-small', language: 'vi'}});
  let done;
  while (!(done = (await invoke('list_jobs')).find((j) => j.id === stt.id && ['succeeded', 'failed'].includes(j.status)))) { sample(); await sleep(10000); }
  if (done.status !== 'succeeded') throw Error(`stt failed: ${done.error}`);
  report.stt_s = Math.round((Date.now() - ts) / 1000);
  report.stt_rtf = +(report.stt_s * 1000 / report.render_duration_ms).toFixed(3);
  const hyp = norm(done.result.transcript.map((s) => s.text).join(' ')), ref = norm(script.join(' '));
  report.wer = +(dist(ref.split(' '), hyp.split(' ')) / ref.split(' ').length).toFixed(4);
  report.cer = +(dist([...ref.replace(/ /g, '')], [...hyp.replace(/ /g, '')]) / ref.replace(/ /g, '').length).toFixed(4);
  writeFileSync(join(out, 'stt-hypothesis.txt'), hyp);
  writeFileSync(join(out, 'reference.txt'), ref);

  // Reopen the large project after a clean restart.
  app.kill(); await sleep(3000);
  await launch();
  const tl = Date.now();
  await nav('Dự án');
  await page.getByRole('button', {name: 'Mở dự án'}).first().click();
  await page.getByRole('textbox', {name: `Nội dung đoạn ${N}`}).waitFor({timeout: 60000});
  report.reopen_ui_ms = Date.now() - tl;
  report.peak_python_mb = Math.round(peak.python / 2 ** 20);
  report.peak_app_mb = Math.round(peak.app / 2 ** 20);
  report.ok = report.render_duration_ms === report.render_expected_ms && (resume === 'from-render' || (report.segments_with_take === N && report.orphan_workers_after_crash === 0));
} catch (e) {
  report.error = String(e); log(`ABORT ${e}`);
} finally {
  writeFileSync(join(out, 'gate.json'), JSON.stringify(report, null, 1));
  log(JSON.stringify(report));
  try { app?.kill(); } catch {}
  process.exit(report.ok ? 0 : 1);
}
