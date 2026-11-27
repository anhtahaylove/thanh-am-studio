// Windows "Text size" probe: can the accessibility text scale make the desktop app's CSS viewport narrower than the
// 1024 px its minimum window gives at 100 %? For each factor it sets HKCU\Software\Microsoft\Accessibility\TextScaleFactor,
// reads the effective factor back through WinRT UISettings (Windows PowerShell 5.1, a new process each time), starts the app
// and records innerWidth, devicePixelRatio, the window's client size, the rendered size of a 16 px test element and a
// screenshot at two window sizes: `request`, SetWindowPos to 600x500 (whether the app clamps it), and `minimum`, the client
// sized to the app's 1024x720 logical minimum (the smallest window a user can drag to). At `minimum` it then runs the dpi
// phase's no-sideways-scroll and clipping checks on every page.
// It changes the signed-in user's text size, so it runs only in Windows Sandbox (user WDAGUtilityAccount) unless given
// --allow-host, and puts the previous value back at the end (or removes it if there was none).
// usage: node textscale.mjs <app.exe> <outDir> [--allow-host]
import {chromium} from 'playwright-core';
import {spawn, execFileSync} from 'node:child_process';
import {mkdirSync, writeFileSync, appendFileSync} from 'node:fs';
import {join} from 'node:path';

const args = process.argv.slice(2), allowHost = args.includes('--allow-host'), [exe, out] = args.filter((a) => a !== '--allow-host');
if (!exe || !out) { console.error('usage: node textscale.mjs <app.exe> <outDir> [--allow-host]'); process.exit(2); }
if (process.env.USERNAME !== 'WDAGUtilityAccount' && !allowHost) { console.error(`textscale.mjs changes the user's Windows text size and runs only in Windows Sandbox (this user is ${process.env.USERNAME}); pass --allow-host to run it anyway`); process.exit(2); }
mkdirSync(out, {recursive: true});
const log = (m) => { const line = `${new Date().toISOString()} ${m}`; console.log(line); appendFileSync(join(out, 'run.log'), line + '\n'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ps = (script) => execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(`$ProgressPreference = 'SilentlyContinue'\n${script}`, 'utf16le').toString('base64')], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
const KEY = 'HKCU:\\Software\\Microsoft\\Accessibility';
const setScale = (f) => ps(`if (-not (Test-Path '${KEY}')) { New-Item -Path '${KEY}' | Out-Null }; Set-ItemProperty -Path '${KEY}' -Name TextScaleFactor -Value ${f} -Type DWord`);
const previousScale = () => ps(`(Get-ItemProperty -Path '${KEY}' -Name TextScaleFactor -ErrorAction SilentlyContinue).TextScaleFactor`);
const restoreScale = (v) => v === '' ? ps(`Remove-ItemProperty -Path '${KEY}' -Name TextScaleFactor -ErrorAction SilentlyContinue`) : setScale(Number(v));
const uiScale = () => Number(ps('$null = [Windows.UI.ViewManagement.UISettings, Windows.UI.ViewManagement, ContentType = WindowsRuntime]; (New-Object Windows.UI.ViewManagement.UISettings).TextScaleFactor'));
// Resizes the app's main window: `request` asks for a 600x500 window, `minimum` for a 1024x720 logical client (frame kept).
// Per-monitor-v2 DPI awareness, so the sizes are physical pixels and not DPI-virtualized ones.
const resize = (pid, mode) => JSON.parse(ps(`Add-Type @'
using System; using System.Runtime.InteropServices;
public static class W {
  [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Rt, B; }
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
}
'@
$null = [W]::SetThreadDpiAwarenessContext([IntPtr](-4))
$h = [IntPtr]::Zero
for ($i = 0; $i -lt 60 -and $h -eq [IntPtr]::Zero; $i++) { $h = (Get-Process -Id ${pid}).MainWindowHandle; if ($h -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 250 } }
$null = [W]::ShowWindow($h, 9)
$dpi = [W]::GetDpiForWindow($h)
$c = New-Object W+R; $w = New-Object W+R; $null = [W]::GetClientRect($h, [ref]$c); $null = [W]::GetWindowRect($h, [ref]$w)
if ('${mode}' -eq 'request') { $cx = 600; $cy = 500 } else { $cx = [math]::Round(1024 * $dpi / 96) + ($w.Rt - $w.L) - $c.Rt; $cy = [math]::Round(720 * $dpi / 96) + ($w.B - $w.T) - $c.B }
$null = [W]::SetWindowPos($h, [IntPtr]::Zero, 0, 0, $cx, $cy, 0x14)
Start-Sleep -Milliseconds 1500
$null = [W]::GetClientRect($h, [ref]$c); $null = [W]::GetWindowRect($h, [ref]$w)
@{ asked = @($cx, $cy); client = @($c.Rt, $c.B); window = @(($w.Rt - $w.L), ($w.B - $w.T)); dpi = $dpi } | ConvertTo-Json -Compress`));

let app, page;
// packaged.mjs's launch: Sandbox WebView2 ignores WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, so the app also reads THANHAM_E2E_CDP_PORT.
async function launch() {
  app = spawn(exe, [], {env: {...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9222', THANHAM_E2E_CDP_PORT: '9222'}, stdio: 'ignore'});
  let browser;
  for (let i = 0; i < 120 && !browser; i++) { try { browser = await chromium.connectOverCDP('http://127.0.0.1:9222'); } catch { await sleep(500); } }
  if (!browser) throw Error('app did not expose WebView2 CDP');
  page = browser.contexts()[0].pages()[0];
  await page.getByRole('navigation', {name: 'Điều hướng chính'}).waitFor({timeout: 60000});
}
// Kill the app's process tree and wait until its WebView2 has released the CDP port, so the next launch cannot attach to it.
async function close() {
  try { execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], {stdio: 'ignore'}); } catch {}
  for (let i = 0; i < 40; i++) { try { await fetch('http://127.0.0.1:9222/json/version'); await sleep(500); } catch { return; } }
}
// Three pages are sidebar items, then the queue button (it carries a count badge and opens the queue drawer, not a page); "Dự án" is the top-bar button; "Thư viện giọng" is the section of the models page, opened here.
// "Hàng đợi" opens the drawer when it is closed; any other name closes it first, as leaving the old queue page did.
const nav = async (name) => {
  const queue = page.getByRole('navigation', {name: 'Điều hướng chính'}).getByRole('button', {name: /^Hàng đợi/});
  if ((await queue.getAttribute('aria-expanded', {timeout: 5000}) === 'true') !== (name === 'Hàng đợi')) await queue.click({timeout: 5000});
  if (name === 'Hàng đợi') return;
  if (name === 'Dự án') return page.locator('.topbar').getByRole('button', {name: 'Dự án', exact: true}).click({timeout: 5000});
  if (name !== 'Thư viện giọng') return page.getByRole('navigation', {name: 'Điều hướng chính'}).getByRole('button', {name: new RegExp(`^${name}`)}).click({timeout: 5000});
  await nav('Model & cài đặt');
  const group = page.locator('details.mc-voices');
  if (await group.getAttribute('open', {timeout: 5000}) === null) await group.locator('summary').click({timeout: 5000});
};
const metrics = () => page.evaluate(() => {
  const probe = document.createElement('div'), medium = document.createElement('div');
  probe.style.cssText = 'position:fixed;left:0;top:0;font:16px/1 Arial,sans-serif;white-space:nowrap;visibility:hidden';
  probe.textContent = 'Thanh Âm Studio';
  medium.style.cssText = 'position:fixed;left:0;top:0;font-size:medium;visibility:hidden';
  medium.textContent = 'x';
  document.body.append(probe, medium);
  const r = probe.getBoundingClientRect(), mediumPx = parseFloat(getComputedStyle(medium).fontSize);
  probe.remove(); medium.remove();
  const de = document.documentElement;
  return {innerWidth, innerHeight, devicePixelRatio, clientWidth: de.clientWidth, scrollWidth: de.scrollWidth, visualScale: visualViewport?.scale ?? null,
    font16: {height: +r.height.toFixed(2), width: +r.width.toFixed(2)}, mediumPx, bodyFontPx: parseFloat(getComputedStyle(document.body).fontSize)};
});
// The dpi phase's page loop (packaged.mjs), on the real window instead of an emulated one; a page whose nav button
// cannot be clicked is an issue too.
const PAGES = ['Tạo giọng đọc', 'Chép lời', 'Thư viện giọng', 'Hàng đợi', 'Dự án', 'Model & cài đặt'];
async function overflow(factor) {
  const issues = [];
  for (const [i, p] of PAGES.entries()) {
    try { await nav(p); } catch (e) { issues.push(`${p}: nav button not clickable (${String(e).split('\n')[0].slice(0, 120)})`); continue; }
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
    await page.screenshot({path: join(out, `textscale-${factor}-page${i + 1}.png`)});
    if (bad.length) issues.push(`${p}: ${bad.join('; ')}`);
  }
  return issues;
}
// A project with text, so the script page has segments to lay out. The first launch creates it at the default window size,
// later ones open it.
async function openProject(first) {
  if (first) {
    await page.getByRole('navigation', {name: 'Điều hướng chính'}).getByRole('button').first().click();
    await page.getByRole('button', {name: 'Thêm nội dung', exact: true}).click();
    await page.getByRole('textbox', {name: 'Nội dung cần thêm'}).fill('Lan: Xin chào, đây là Thanh Âm Studio. Hôm nay trời Hà Nội trong xanh.\nMinh: Chúng tôi kiểm tra giọng đọc tiếng Việt trên máy tính.');
    await page.getByRole('button', {name: /^Thêm \d+ đoạn vào kịch bản$/}).click();
    await page.getByRole('textbox', {name: 'Nội dung đoạn 2'}).waitFor();
    await page.waitForTimeout(1500); // autosave
    return;
  }
  await nav('Dự án');
  await page.getByRole('button', {name: 'Mở dự án', exact: true}).first().click();
  await page.getByRole('textbox', {name: 'Nội dung đoạn 1'}).waitFor();
}

const FACTORS = [100, 125, 150, 225], rows = [];
let status = 0;
const previous = previousScale(); // '' when the value does not exist
try {
  log(`TEXTSCALE before: registry ${previous || '(unset)'}, UISettings ${uiScale()}`);
  for (const factor of FACTORS) {
    const row = {factor};
    rows.push(row);
    try {
      setScale(factor);
      row.uiSettings = uiScale();
      await launch();
      await page.waitForTimeout(800);
      await openProject(factor === FACTORS[0]).catch((e) => { row.projectError = String(e).slice(0, 300); });
      for (const mode of ['request', 'minimum']) {
        row[mode] = resize(app.pid, mode);
        await page.waitForTimeout(800);
        Object.assign(row[mode], await metrics());
        await page.screenshot({path: join(out, `textscale-${factor}-${mode}.png`)});
      }
      row.overflow = await overflow(factor).catch((e) => [`check stopped: ${String(e).slice(0, 200)}`]);
    } catch (e) {
      row.error = String(e).slice(0, 500);
      status = 1;
    } finally {
      if (app) await close();
    }
    log(`TEXTSCALE ${factor} % ${JSON.stringify(row)}`);
  }
} finally {
  try { restoreScale(previous); log(`TEXTSCALE restored: registry ${previousScale() || '(unset)'}`); } catch (e) { log(`TEXTSCALE restore failed: ${e}`); status = 1; }
}
// Outcomes (PLAN D2 step 0), on the `minimum` window: (b) some innerWidth <= 920 px; (c) UISettings did not take some factor
// or a factor could not be measured (inconclusive); otherwise (a), unless a factor grew the text without narrowing the page
// and its pages overflow (a B3b fix item).
const base = rows.find((r) => r.factor === 100 && !r.error)?.minimum;
for (const r of rows) {
  r.confirmed = Math.abs((r.uiSettings ?? 0) - r.factor / 100) < 0.005;
  r.textGrew = !!base && !r.error && r.minimum.font16.height > base.font16.height + 0.5;
  r.narrowed = !!base && !r.error && r.minimum.innerWidth < base.innerWidth - 1;
  // Without the seeded project the script page has no segments, so a clean page loop proves less.
  r.overflowComplete = !r.error && !r.projectError && !r.overflow?.some((x) => x.startsWith('check stopped'));
}
const fixItems = rows.filter((r) => r.textGrew && !r.narrowed && r.overflow?.length).map((r) => `${r.factor} %: ${r.overflow.join(' | ')}`);
const outcome = rows.some((r) => !r.error && r.minimum.innerWidth <= 920) ? 'b' : rows.some((r) => r.error || !r.confirmed) ? 'c' : fixItems.length ? 'a-with-fix-item' : 'a';
const measured = rows.filter((r) => !r.error), smallest = measured.length ? Math.min(...measured.map((r) => r.minimum.innerWidth)) : null;
const brief = (m) => m && {innerWidth: m.innerWidth, devicePixelRatio: m.devicePixelRatio, client: m.client, dpi: m.dpi, font16: m.font16, mediumPx: m.mediumPx};
const summary = {outcome, b3b: outcome !== 'a', smallestMinimumInnerWidth: smallest, fixItems,
  rows: rows.map((r) => ({factor: r.factor, uiSettings: r.uiSettings, confirmed: r.confirmed, minimum: brief(r.minimum), request: brief(r.request), textGrew: r.textGrew, narrowed: r.narrowed, overflow: r.overflow, overflowComplete: r.overflowComplete, projectError: r.projectError, error: r.error}))};
writeFileSync(join(out, 'textscale.json'), JSON.stringify({summary, rows}, null, 1));
log(`OUTCOME ${outcome} b3b=${summary.b3b ? 'yes' : 'no'} smallest=${smallest} ${rows.map((r) => `${r.factor}%: ui=${r.uiSettings} min innerWidth=${r.minimum?.innerWidth} dpr=${r.minimum?.devicePixelRatio} client=${r.minimum?.client?.join('x')} font16=${r.minimum?.font16?.height} overflow=${r.overflow?.length ?? '-'}${r.overflowComplete ? '' : ' (incomplete' + (r.projectError ? ': project not opened' : '') + ')'}; 600x500 request innerWidth=${r.request?.innerWidth} client=${r.request?.client?.join('x')}`).join(' | ')}`);
process.exit(status);
