// Smooth-motion integration test (REAL desktop, REAL input).
// Run: CUP_REAL=1 node --test --test-timeout=600000 tests/integration/motion.test.mjs
// Verifies scripts/send-input.ps1 move/drag against independent observation
// (separate cursor reads, screenshot hashes, pixel counts) — never trusts
// the backend report alone. Cursor motion needs no window; drags run on a
// disposable Paint window (own pid only, never saved).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const CUP = process.env.CUP_REAL === '1' ? undefined : { skip: 'set CUP_REAL=1 to run the real desktop test' };
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const TASKKILL = 'C:\\Windows\\System32\\taskkill.exe';
const MOD = path.join(ROOT, 'scripts', 'send-input.ps1');
const EVMOD = path.join(ROOT, 'scripts', 'capture-evidence.ps1');
const TMP = path.join(os.tmpdir(), 'cup-motion-test');

function wrapCall(mod, action, params) {
  const wrap = path.join(TMP, `w-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}.ps1`);
  fs.writeFileSync(wrap, `$mod = '${mod}'\n$j = '${JSON.stringify(params)}'\n& $mod -Action ${action} -ParamsJson $j\n`);
  const r = spawnSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrap], { encoding: 'utf8' });
  try { fs.unlinkSync(wrap); } catch {}
  if (r.error) throw new Error('spawn failed: ' + r.error.message);
  return JSON.parse((r.stdout || '').trim().split(/\r?\n/).pop());
}

function wrapCallRetry(mod, action, params, attempts = 3) {
  // Like wrapCall, but retries runs aborted by foreign focus changes
  // (cancel_on_focus_loss) — environmental, not a product defect.
  let last = null;
  for (let i = 0; i < attempts; i++) {
    last = wrapCall(mod, action, params);
    if (last.ok || !/cancelled/.test(String(last.error || ''))) return last;
  }
  return last;
}

function psFile(content, name) {
  const f = path.join(TMP, name);
  fs.writeFileSync(f, content);
  return f;
}

const CUR_SRC = `Add-Type @"
using System; using System.Runtime.InteropServices;
public static class CurR {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int v);
}
"@
$pt = New-Object CurR+POINT
[void][CurR]::GetCursorPos([ref]$pt)
$lb = [CurR]::GetAsyncKeyState(0x01)
$btn = 'up'
if (($lb -band 0x8000) -ne 0) { $btn = 'DOWN' }
Write-Output ("cursor=" + $pt.X + "," + $pt.Y + " lbutton=" + $btn)
`;

function cursorState() {
  const f = psFile(CUR_SRC, 'cur.ps1');
  const r = spawnSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', f], { encoding: 'utf8' });
  const m = /cursor=(\d+),(\d+) lbutton=(\w+)/.exec(r.stdout || '');
  if (!m) throw new Error('cursor read failed: ' + (r.stdout || '').slice(0, 200));
  return { x: Number(m[1]), y: Number(m[2]), down: m[3] === 'DOWN' };
}

// Run a move in a child process while polling the cursor independently.
// Retries on focus-loss cancellation: the machine may be in active use and
// a foreign foreground change aborts the run by design (max 3 attempts).
async function sampledMoveOnce(params, pollMs) {
  const wrap = path.join(TMP, 'sampler.ps1');
  fs.writeFileSync(wrap,
    `param([int]$Millis,[int]$Interval)\n` +
    `Add-Type @"\nusing System; using System.Runtime.InteropServices;\npublic static class Samp {\n` +
    `  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }\n` +
    `  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);\n}\n"@\n` +
    `$sw=[Diagnostics.Stopwatch]::StartNew();$o=@();while($sw.Elapsed.TotalMilliseconds -lt $Millis){` +
    `$p=New-Object Samp+POINT;[void][Samp]::GetCursorPos([ref]$p);$o+=\"\"+$p.X+\",\"+$p.Y;` +
    `Start-Sleep -Milliseconds $Interval};$sw.Stop();$o\n`);
  const child = spawn(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    psFile(`$mod='${MOD}'\n$j='${JSON.stringify(params)}'\n& $mod -Action move -ParamsJson $j\n`, 'mv.ps1')],
    { encoding: 'utf8' });
  let moveOut = '';
  child.stdout.on('data', (d) => { moveOut += d; });
  const poll = spawnSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrap,
    '-Millis', String(pollMs), '-Interval', '60'], { encoding: 'utf8' });
  return new Promise((resolve, reject) => {
    child.on('close', () => {
      const samples = (poll.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => /^\d+,\d+$/.test(l));
      let report = null;
      try { report = JSON.parse((moveOut || '').trim().split(/\r?\n/).pop()); } catch (e) { reject(new Error('move output unparseable: ' + moveOut.slice(0, 200))); return; }
      resolve({ report, samples });
    });
    child.on('error', reject);
  });
}

async function sampledMove(params, pollMs, attempts = 3) {
  let last = null;
  for (let i = 0; i < attempts; i++) {
    last = await sampledMoveOnce(params, pollMs);
    if (last.report.ok || !/cancelled/.test(String(last.report.error || ''))) return last;
  }
  return last;
}

function darkPixelDelta(beforePng, afterPng, region) {
  const f = psFile(
    `Add-Type -AssemblyName System.Drawing\n` +
    `$a=[Drawing.Bitmap]::FromFile('${beforePng}')\n$b=[Drawing.Bitmap]::FromFile('${afterPng}')\n` +
    `function dark($img){$n=0;for($x=${region[0]};$x -lt ${region[2]};$x+=3){for($y=${region[1]};$y -lt ${region[3]};$y+=3){` +
    `$p=$img.GetPixel($x,$y);if($p.R -lt 100 -and $p.G -lt 100 -and $p.B -lt 100){$n++}}};return $n}\n` +
    `$da=dark $a;$db=dark $b;$a.Dispose();$b.Dispose()\nWrite-Output ("before=$da after=$db")\n`, 'px.ps1');
  const r = spawnSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', f], { encoding: 'utf8' });
  const m = /before=(\d+) after=(\d+)/.exec(r.stdout || '');
  if (!m) throw new Error('pixel compare failed: ' + (r.stdout || '').slice(0, 200));
  return { before: Number(m[1]), after: Number(m[2]) };
}

function sh(cmd) {
  const r = spawnSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { encoding: 'utf8' });
  if (r.error) throw new Error('spawn failed: ' + r.error.message);
  if (r.status !== 0 && (r.stdout || '') === '' && (r.stderr || '') === '') return '';
  if (r.status !== 0) throw new Error('powershell failed: ' + ((r.stderr || r.stdout || '').slice(0, 300)));
  return r.stdout;
}

let paintPid = null;

describe('integration: smooth motion backend (REAL input)', CUP ?? {}, () => {
  before(() => {
    fs.mkdirSync(TMP, { recursive: true });
    const beforeIds = sh('Get-Process mspaint -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id').trim();
    sh('Start-Process mspaint.exe');
    let pid = null;
    for (let i = 0; i < 20 && !pid; i++) {
      const list = sh('Get-Process mspaint -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id').trim().split(/\s+/).map(Number);
      pid = list.find((n) => n > 0 && String(beforeIds).trim().split(/\s+/).indexOf(String(n)) < 0);
      if (!pid) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
    assert.ok(pid, 'must launch automation-owned Paint');
    paintPid = pid;
  });

  after(() => {
    if (paintPid) spawnSync(TASKKILL, ['/F', '/PID', String(paintPid)], { encoding: 'utf8' });
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  it('MO-01 straight line reaches endpoint with sampled intermediates', async () => {
    const { report, samples } = await sampledMove(
      { start: [200, 200], end: [800, 800], duration_ms: 1500, easing: 'ease_in_out' }, 1900);
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.deepEqual(report.landed, [800, 800]);
    const uniq = [...new Set(samples)];
    assert.ok(uniq.length >= 8, 'must traverse intermediates, got ' + uniq.length);
    const end = cursorState();
    assert.ok(Math.abs(end.x - 800) <= 2 && Math.abs(end.y - 800) <= 2, 'independent cursor read at endpoint');
  });

  it('MO-02 quadratic arc passes near its control region', async () => {
    const { report, samples } = await sampledMove(
      { start: [200, 600], end: [800, 600], path: 'quadratic', control_points: [[500, 200]], duration_ms: 1200, easing: 'ease_out' }, 1600);
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.deepEqual(report.landed, [800, 600]);
    const pts = [...new Set(samples)].map((s) => s.split(',').map(Number));
    const apex = pts.reduce((a, b) => (b[1] < a[1] ? b : a));
    assert.ok(Math.abs(apex[0] - 500) < 80 && Math.abs(apex[1] - 400) < 80, 'arc apex near (500,400), got ' + apex);
  });

  it('MO-03 cubic S-curve lands exactly', async () => {
    const { report, samples } = await sampledMove(
      { start: [200, 400], end: [800, 400], path: 'cubic', control_points: [[350, 150], [650, 650]], duration_ms: 1200, easing: 'linear' }, 1600);
    assert.equal(report.ok, true, JSON.stringify(report));
    assert.deepEqual(report.landed, [800, 400]);
    assert.ok(new Set(samples).size >= 8, 'cubic must emit intermediates');
  });

  it('MO-04 pencil tool selects natively; straight drag draws pixels', () => {
    // Select pencil through the native semantic route (verified pattern).
    const code = `var app=await cua.getApp("mspaint");var s=await app.getAXState({emit:false});` +
      `var m=/^\\s*(\\d+) button Pencil\\b/m.exec(s);nodeRepl.write("CUP::pi="+(m?m[1]:"NONE"));` +
      `await app.click(m[1]);var s2=await app.getAXState({emit:false});` +
      `nodeRepl.write("CUP::tool=" + (/Using ([A-Za-z]+)( with color)? tool on Canvas/.exec(s2)||[])[1]);`;
    const oc = spawnSync('C:\\Windows\\System32\\cmd.exe', ['/c', 'ocu', 'js', '--timeout', '120000', '-'],
      { input: code, encoding: 'utf8' });
    const tool = /CUP::tool=(\w+)/.exec(oc.stdout || '');
    assert.equal(tool && tool[1], 'Pencil', 'pencil must activate, got ' + (oc.stdout || '').slice(-200));
    const before = wrapCall(EVMOD, 'capture', { app: 'mspaint', mode: 'temporary', purpose: 'mo04-before' });
    assert.equal(before.ok, true, JSON.stringify(before));
    const drag = wrapCallRetry(MOD, 'drag', { start: [450, 350], end: [850, 650], duration_ms: 1000, easing: 'ease_in_out', button: 'left' });
    assert.equal(drag.ok, true, JSON.stringify(drag));
    const after = wrapCall(EVMOD, 'capture', { app: 'mspaint', mode: 'temporary', purpose: 'mo04-after' });
    assert.equal(after.ok, true, JSON.stringify(after));
    // Compare the temp capture files directly (helper returns temp path in auto/temporary modes).
    const px = darkPixelDelta(before.path, after.path, [300, 250, 1000, 800]);
    assert.ok(px.after - px.before > 30, `drag must add dark pixels (before=${px.before} after=${px.after})`);
    const st = cursorState();
    assert.equal(st.down, false, 'button released after drag');
    // Keep the pair as evidence of a verified draw.
    const k1 = wrapCall(EVMOD, 'retain', { src: before.path, kind: 'evidence', purpose: 'mo04 pre-drag canvas', test_ref: 'MO-04', why: 'before-state for verified draw' });
    const k2 = wrapCall(EVMOD, 'retain', { src: after.path, kind: 'evidence', purpose: 'mo04 post-drag line', test_ref: 'MO-04', why: 'after-state proving pixels drawn' });
    assert.equal(k1.ok && k2.ok, true, JSON.stringify([k1, k2]));
    wrapCall(EVMOD, 'discard', { path: before.path });
    wrapCall(EVMOD, 'discard', { path: after.path });
  });

  it('MO-05 curved drag bows away from the chord', () => {
    const before = wrapCall(EVMOD, 'capture', { app: 'mspaint', mode: 'temporary', purpose: 'mo05-before' });
    assert.equal(before.ok, true);
    const drag = wrapCallRetry(MOD, 'drag', { start: [450, 780], end: [950, 780], path: 'quadratic', control_points: [[700, 620]], duration_ms: 1000, button: 'left' });
    assert.equal(drag.ok, true, JSON.stringify(drag));
    const after = wrapCall(EVMOD, 'capture', { app: 'mspaint', mode: 'temporary', purpose: 'mo05-after' });
    assert.equal(after.ok, true);
    const px = darkPixelDelta(before.path, after.path, [400, 550, 1000, 850]);
    assert.ok(px.after - px.before > 30, `curve must add pixels (before=${px.before} after=${px.after})`);
    const st = cursorState();
    assert.equal(st.down, false, 'button released after curved drag');
    wrapCall(EVMOD, 'discard', { path: before.path });
    const k = wrapCall(EVMOD, 'retain', { src: after.path, kind: 'evidence', purpose: 'mo05 curved drag result', test_ref: 'MO-05', why: 'after-state proving curved stroke' });
    assert.equal(k.ok, true, JSON.stringify(k));
    wrapCall(EVMOD, 'discard', { path: after.path });
  });

  it('MO-06 key tap releases; validation errors are explicit', () => {
    const k = wrapCall(MOD, 'key', { key: 'shift', hold_ms: 50 });
    assert.equal(k.ok, true, JSON.stringify(k));
    assert.equal(cursorState().down, false);
    const cases = [
      [{ end: [99999, 0], duration_ms: 300 }, /outside the virtual screen/],
      [{ end: [100, 100], duration_ms: -5 }, /duration_ms/],
      [{ end: [100, 100], duration_ms: 300, easing: 'bounce' }, /easing/],
      [{ end: [100, 100], path: 'quadratic', duration_ms: 300 }, /control point/],
      [{ end: [100, 100], duration_ms: 300, steps: 1 }, /steps/],
      [{ duration_ms: 300 }, /requires 'end'/],
    ];
    for (const [params, re] of cases) {
      const r = wrapCall(MOD, 'move', params);
      assert.equal(r.ok, false, JSON.stringify(params));
      assert.match(String(r.error), re, JSON.stringify(params));
    }
    const refused = wrapCall(MOD, 'key', { key: 'shift', expect_hwnd: 1, require_focus: true });
    assert.equal(refused.ok, false, 'focus mismatch must refuse');
    assert.match(String(refused.error), /focus not verified/);
    const badDir = wrapCall(MOD, 'scroll', { direction: 'diagonal', amount: 3 });
    assert.equal(badDir.ok, false, 'bad direction must fail');
    assert.match(String(badDir.error), /direction/);
    const badAmt = wrapCall(MOD, 'scroll', { direction: 'down', amount: 99 });
    assert.equal(badAmt.ok, false, 'excessive amount must fail');
    assert.match(String(badAmt.error), /amount/);
  });

  it('MO-07 backend click reaches its target coordinates', () => {
    const r = wrapCall(MOD, 'click', { x: 300, y: 300 });
    assert.equal(r.ok, true, JSON.stringify(r));
    const st = cursorState();
    assert.ok(Math.abs(st.x - 300) <= 2 && Math.abs(st.y - 300) <= 2, 'cursor at click point, got ' + st.x + ',' + st.y);
    assert.equal(st.down, false, 'no stuck button after click');
  });

  it('MO-08 focused typing stays BLOCKED without verified focus', () => {
    // SendInput typing requires a verified foreground window. The harness
    // session host holds foreground here, so typing at a control cannot be
    // proven safe: assert the guard refuses instead of typing blind.
    const r = wrapCall(MOD, 'type', { text: 'E2E-PROBE', expect_hwnd: 1, require_focus: true });
    assert.equal(r.ok, false, 'must refuse unfocused typing');
    assert.match(String(r.error), /focus not verified/);
  });
});
