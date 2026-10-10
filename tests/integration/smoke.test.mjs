// Real-desktop integration test for computer-use-pro.
//
// REAL interaction test: drives a disposable Notepad window through the
// native `ocu` CLI. Run with:
//
//   CUP_REAL=1 npm run test:integration
//
// Without CUP_REAL the suite skips (unit tests in tests/unit/ cover the
// mocked cases). Verified capability model (open-computer-use 1.0.0,
// Windows 11 — see ARCHITECTURE.md, all probed on disposable windows):
//
// - VERIFIED with postconditions: list_apps, get_app_state (+screenshot),
//   element/coordinate click (focuses; typing lands after), type_text
//   (ASCII + Unicode), set_value, honest structured errors.
// - CHARACTERIZED (accepted by the runtime, no effect observed — asserted
//   as tripwires so a runtime fix or regression fails loudly instead of
//   silently changing meaning): press_key effects, drag selection,
//   double-click word selection, coordinate caret placement.
// - BLOCKED: native clipboard tool (absent), Windows-key presses.
//
// Safety rules enforced here:
// - test file lives under %TEMP% and is deleted afterwards;
// - only the Notepad pid this test launched is ever closed (taskkill /PID);
// - pre-existing Notepad processes are recorded before/after and must be
//   untouched (the test aborts if an unrelated VISIBLE Notepad exists);
// - clipboard is used only for a disposable "cup-probe-..." string.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const CUP = process.env.CUP_REAL === '1' ? undefined : { skip: 'set CUP_REAL=1 to run the real desktop test' };

const CASE = `cup-case-${Date.now().toString(36)}`;
const PROBE_FILE = path.join(os.tmpdir(), 'cup-probe', `${CASE}.txt`);
const MARK_KEYBOARD = `KB-${CASE}`;
const MARK_UNICODE = 'é中-UNI';
const MARK_SETVALUE = `SV-${CASE}`;

const PS_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const CMD_EXE = 'C:\\Windows\\System32\\cmd.exe';
const TASKKILL_EXE = 'C:\\Windows\\System32\\taskkill.exe';

function ps(scriptArgs) {
  const r = spawnSync(PS_EXE, ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...scriptArgs], {
    encoding: 'utf8',
  });
  if (r.error) throw new Error(`powershell spawn failed: ${r.error.message}`);
  if (r.status !== 0) {
    // PS 5.1 Get-Process exits 1 with no output on zero matches: empty result.
    if ((r.stdout || '') === '' && (r.stderr || '') === '') return '';
    throw new Error(`powershell failed: ${(r.stderr || r.stdout || '').slice(0, 500)}`);
  }
  return r.stdout;
}

function ocuJs(code, timeoutMs = 180000) {
  // ocu is a .cmd shim: invoke through cmd.exe so CreateProcess resolves it.
  const r = spawnSync(CMD_EXE, ['/c', 'ocu', 'js', '--timeout', String(timeoutMs), '-'], {
    input: code,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const out = stripAnsi(`${r.stdout || ''}\n${r.stderr || ''}`);
  if (r.status !== 0 && !/CUP::/.test(out)) {
    throw new Error(`ocu js failed (code ${r.status}): ${out.slice(-800)}`);
  }
  return out;
}

function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

/** Collect CUP::key=value marker lines emitted via nodeRepl.write. */
function markers(out) {
  const m = {};
  for (const line of out.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith('CUP::')) {
      const i = t.indexOf('=', 5);
      if (i > 0) m[t.slice(5, i)] = t.slice(i + 1);
    }
  }
  return m;
}

function visibleNotepads() {
  const out = ps([
    '-Command',
    `Get-Process notepad -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | ForEach-Object { "$($_.Id):$($_.MainWindowTitle)" }`,
  ]);
  return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

// Prepended to every scripted sequence: derive target indexes from FRESH
// state. Notepad re-lays out its tree when content becomes scrollable (the
// document moves from element 2 to 6), so hardcoded indexes are forbidden.
const IDX_SNIPPET = `
async function freshState(app) { return await app.getAXState({emit:false}); }
async function docIdx(app) {
  var m = /^\\s*(\\d+) document[^\\n]*SetValue/m.exec(await freshState(app));
  if (!m) throw new Error("document element not found in fresh state");
  return m[1];
}
async function scrollIdx(app) {
  var m = /^\\s*(\\d+) pane ID: ScrollViewer/m.exec(await freshState(app));
  if (m) return m[1];
  return await docIdx(app);
}
async function docFrame(app) {
  var m = /^\\s*(\\d+) document[^\\n]*Frame: \\{x: (\\d+), y: (\\d+)/m.exec(await freshState(app));
  if (!m) throw new Error("document frame not found in fresh state");
  return { idx: m[1], x: Number(m[2]), y: Number(m[3]) };
}
`;

let OWN_PID = null;
let othersBefore = [];

describe('integration: disposable Notepad end-to-end (REAL desktop)', CUP ?? {}, () => {
  before(() => {
    othersBefore = visibleNotepads();
    if (othersBefore.length > 0) {
      throw new Error(
        `refusing to run: visible Notepad window(s) not owned by this test exist [${othersBefore.join('; ')}]. ` +
          `Save/close them first, then rerun.`,
      );
    }
    const out = ps([
      '-File',
      path.join(ROOT, 'scripts', 'launch-notepad.ps1'),
      '-FilePath',
      PROBE_FILE,
      '-SeedLines',
      '120',
    ]);
    const info = JSON.parse(out.trim().split(/\r?\n/).pop());
    OWN_PID = info.pid;
    assert.ok(OWN_PID > 0, 'launcher must report a pid');
    assert.match(info.title, /\.txt - Notepad/, 'launcher must report the Notepad title');
  });

  after(() => {
    if (OWN_PID) {
      spawnSync(TASKKILL_EXE, ['/PID', String(OWN_PID), '/F'], { encoding: 'utf8' });
      const start = Date.now();
      while (Date.now() - start < 10000) {
        const gone = ps(['-Command', `Get-Process -Id ${OWN_PID} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id`]).trim();
        if (!gone) break;
      }
    }
    try {
      fs.unlinkSync(PROBE_FILE);
    } catch {}
    assert.ok(!fs.existsSync(PROBE_FILE), 'disposable test file must be deleted');
    const othersAfter = visibleNotepads().filter((l) => !l.startsWith(`${OWN_PID}:`));
    assert.deepEqual(othersAfter, othersBefore, 'no unrelated Notepad window may be touched');
  });

  it('Test A+B: observes the owned window with a real screenshot', () => {
    const out = ocuJs(`
var app = await cua.getApp("Notepad");
var s0 = await app.getAXState({emit:false});
var lines = s0.split("\\n");
nodeRepl.write("CUP::header=" + lines[0].slice(0,80));
nodeRepl.write("CUP::window=" + (lines[1] || "").slice(0,120));
var shot = await app.getScreenshot({emit:false});
nodeRepl.write("CUP::screenshot=" + shot.length);
`);
    const m = markers(out);
    const pid = /pid (\d+)/.exec(m.header ?? '');
    assert.ok(pid, `state must identify the app pid (got ${m.header})`);
    assert.equal(Number(pid[1]), OWN_PID, 'bound window must be the automation-owned pid');
    assert.match(m.window ?? '', new RegExp(CASE.slice(0, 12).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'state must show the disposable file');
    assert.ok(Number(m.screenshot) > 10000, `screenshot must be real bytes (got ${m.screenshot})`);
  });

  it('Test C: genuine keyboard text entry (ASCII + Unicode) lands verbatim', () => {
    const out = ocuJs(IDX_SNIPPET + `
var app = await cua.getApp("Notepad");
var idx = await docIdx(app);
await app.click(idx);
await app.pressKey("End");
await app.typeText(" ${MARK_KEYBOARD}");
await app.typeText("${MARK_UNICODE}");
var s = await app.getAXState({emit:false, textLimit:"max"});
nodeRepl.write("CUP::hasKB=" + (s.includes("${MARK_KEYBOARD}") ? "yes" : "no"));
nodeRepl.write("CUP::hasUNI=" + (s.includes("${MARK_UNICODE}") ? "yes" : "no"));
`);
    const m = markers(out);
    assert.equal(m.hasKB, 'yes', 'physical type_text must land in the document');
    assert.equal(m.hasUNI, 'yes', 'Unicode keyboard input must survive');
  });

  it('Test D-scroll: element scroll moves the viewport (screenshot proof)', () => {
    // UIA Value: is the whole buffer, so viewport movement is proven by
    // screenshot change. Scroll the ScrollViewer element (scrolling the
    // document element itself is honestly refused by the runtime).
    // Coordinate scroll needs a visible window: refocus our owned pid first.
    ps(['-File', path.join(ROOT, 'scripts', 'focus-window.ps1'), '-TargetPid', String(OWN_PID)]);
    let m = null;
    let lastErr = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      const out = ocuJs(IDX_SNIPPET + `
var app = await cua.getApp("Notepad");
async function shotHash() {
  var shot = await app.getScreenshot({emit:false});
  var crypto = await import("node:crypto");
  return crypto.createHash("sha256").update(shot).digest("hex").slice(0,16);
}
try {
  nodeRepl.write("CUP::before=" + await shotHash());
  await app.scroll(await scrollIdx(app), "down", 3);
  nodeRepl.write("CUP::after=" + await shotHash());
  await app.scroll(await scrollIdx(app), "up", 3);
  nodeRepl.write("CUP::restored=" + await shotHash());
} catch (e) { nodeRepl.write("CUP::scrollErr=" + String(e.message||e).slice(0,120).replace(/\\r?\\n/g," | ")); }
`);
      m = markers(out);
      if (m.before && m.after && m.restored) break;
      lastErr = m.scrollErr ?? 'no markers';
      ps(['-File', path.join(ROOT, 'scripts', 'focus-window.ps1'), '-TargetPid', String(OWN_PID)]);
    }
    assert.ok(m && m.before && m.after, `scroll sequence must complete (last: ${lastErr})`);
    assert.notEqual(m.after, m.before, 'scrolling down must change the viewport');
    assert.notEqual(m.restored, m.after, 'scrolling up must move the viewport again');
  });

  it('Test D-click: coordinate click focuses; caret placement is not driven (tripwire)', () => {
    const out = ocuJs(IDX_SNIPPET + `
var app = await cua.getApp("Notepad");
await app.setValue(await docIdx(app), "alpha beta gamma");
var f = await docFrame(app);
var fx = f.x, fy = f.y;
await app.click([fx + 15, fy + 18]);
await app.typeText("Q1");
await app.click([fx + 70, fy + 18], {clickCount: 2});
await app.typeText("Q2");
var s2 = await app.getAXState({emit:false, textLimit:"max"});
var mv = /Value: ([^\\n]{0,120})/.exec(s2);
nodeRepl.write("CUP::v=" + (mv ? mv[1].split(" Secondary")[0] : "NOMATCH"));
`);
    const m = markers(out);
    // Current runtime behavior: clicks focus the control (typing lands) but
    // do not move the caret to the click point and double-click selects no
    // word, so both markers append at the end. If a runtime fix ever drives
    // caret/selection, this tripwire fails and the docs must be re-verified.
    assert.equal(m.v, 'alpha beta gammaQ1Q2', `click characterization changed (got: ${m.v}) — re-verify mouse behavior`);
  });

  it('Test D-drag: drag selection has no observed effect (tripwire)', () => {
    const out = ocuJs(IDX_SNIPPET + `
var app = await cua.getApp("Notepad");
await app.setValue(await docIdx(app), "AAAABBBBCCCCDDDDEEEEFFFFGGGG");
await app.click(await docIdx(app));
var f = await docFrame(app);
var fx = f.x, fy = f.y;
await app.drag([fx + 15, fy + 18], [fx + 250, fy + 18]);
await app.typeText("Q");
var s2 = await app.getAXState({emit:false, textLimit:"max"});
var mv = /Value: ([^\\n]{0,120})/.exec(s2);
nodeRepl.write("CUP::v=" + (mv ? mv[1].split(" Secondary")[0] : "NOMATCH"));
`);
    const m = markers(out);
    // Current behavior: the drag selects nothing, so Q appends at the end. A
    // future runtime that drives window-server drags will replace the span
    // with Q and fail here — update the docs then.
    assert.equal(m.v, 'AAAABBBBCCCCDDDDEEEEFFFFGGGGQ', `drag characterization changed (got: ${m.v}) — re-verify drag behavior`);
  });

  it('Test C-keys: press_key is accepted but moves no caret (tripwire)', () => {
    const out = ocuJs(IDX_SNIPPET + `
var app = await cua.getApp("Notepad");
await app.setValue(await docIdx(app), "");
await app.click(await docIdx(app));
await app.typeText("AB");
await app.pressKey("Left");
await app.typeText("X");
var s = await app.getAXState({emit:false, textLimit:"max"});
var mv = /Value: ([^\\n]{0,120})/.exec(s);
nodeRepl.write("CUP::v=" + (mv ? mv[1].split(" Secondary")[0] : "NOMATCH"));
`);
    const m = markers(out);
    // press_key("Left") is accepted without error but the caret does not
    // move, so X appends. If key delivery ever starts working, expect AXB —
    // this tripwire will fail and the keyboard docs must be re-verified.
    assert.equal(m.v, 'ABX', `press_key characterization changed (got: ${m.v}) — re-verify keyboard behavior`);
  });

  it('Test E: set_value writes the control value directly (distinct from typing)', () => {
    const out = ocuJs(IDX_SNIPPET + `
var app = await cua.getApp("Notepad");
await app.setValue(await docIdx(app), "${MARK_SETVALUE}");
var s = await app.getAXState({emit:false, textLimit:"max"});
var mv = /Value: ([^\\n]{0,120})/.exec(s);
nodeRepl.write("CUP::sv=" + (mv ? mv[1].split(" Secondary")[0] : "NOMATCH"));
`);
    const m = markers(out);
    assert.match(m.sv ?? '', new RegExp(MARK_SETVALUE), 'set_value postcondition must hold');
  });

  it('Test F: native surface exposes no clipboard tool (BLOCKED); OS probe only', () => {
    const out = ocuJs(`
var app = await cua.getApp("Notepad");
nodeRepl.write("CUP::hasClip=" + (("clipboard" in app || "getClipboard" in app || "setClipboard" in app) ? "yes" : "no"));
`);
    const m = markers(out);
    assert.equal(m.hasClip, 'no', 'no clipboard member may exist on the app binding');
    const probe = ps([
      '-Command',
      `Add-Type -AssemblyName System.Windows.Forms; ` +
        `[System.Windows.Forms.Clipboard]::SetText('cup-probe-clipboard-TempTest'); ` +
        `[System.Windows.Forms.Clipboard]::GetText()`,
    ]).trim();
    assert.equal(probe, 'cup-probe-clipboard-TempTest', 'OS clipboard round-trips only the disposable probe string');
  });

  it('Test G: invalid app, missing element, and unsupported key fail honestly', () => {
    const out = ocuJs(`
var log = [];
try { await cua.getApp("NoSuchAppXYZ123"); log.push("badapp=OK-UNEXPECTED"); }
catch(e){ log.push("badapp=" + String(e.message||e).slice(0,60).replace(/\\r?\\n/g," | ")); }
var app = await cua.getApp("Notepad");
try { await app.click("9999"); log.push("badel=OK-UNEXPECTED"); }
catch(e){ log.push("badel=" + String(e.message||e).slice(0,60).replace(/\\r?\\n/g," | ")); }
try { await app.pressKey("super"); log.push("superkey=OK-UNEXPECTED"); }
catch(e){ log.push("superkey=" + String(e.message||e).slice(0,60).replace(/\\r?\\n/g," | ")); }
nodeRepl.write("CUP::" + log.join("\\nCUP::"));
`);
    const m = markers(out);
    assert.match(m.badapp ?? '', /appNotFound/i, 'unknown app must report appNotFound');
    assert.match(m.badel ?? '', /unknown element_index/i, 'missing element must be reported');
    assert.match(m.superkey ?? '', /Unsupported key: super/i, 'Windows key must be honestly refused');
  });
});
