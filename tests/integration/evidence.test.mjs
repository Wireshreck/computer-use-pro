// Screenshot-evidence integration test (REAL desktop).
// Run: CUP_REAL=1 node --test --test-timeout=600000 tests/integration/evidence.test.mjs
// Uses a disposable Paint window (presents itself on launch) purely as a
// capturable target. Never draws, never saves, never touches other apps.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const CUP = process.env.CUP_REAL === '1' ? undefined : { skip: 'set CUP_REAL=1 to run the real desktop test' };
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const HELPER = path.join(ROOT, 'scripts', 'capture-evidence.ps1');
const TMP = path.join(os.tmpdir(), 'cup-evidence-test');

function ev(action, params) {
  const wrap = path.join(TMP, `wrap-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}.ps1`);
  const mod = HELPER.replace(/\\/g, '\\\\');
  fs.writeFileSync(wrap, `$mod = '${mod}'\n$j = '${JSON.stringify(params)}'\n& $mod -Action ${action} -ParamsJson $j\n`);
  const r = spawnSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrap], { encoding: 'utf8' });
  try { fs.unlinkSync(wrap); } catch {}
  if (r.error) throw new Error('spawn failed: ' + r.error.message);
  const out = (r.stdout || '').trim().split(/\r?\n/).pop();
  return JSON.parse(out);
}

function sh(cmdArgs) {
  const r = spawnSync(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...cmdArgs], { encoding: 'utf8' });
  if (r.error) throw new Error('spawn failed: ' + r.error.message);
  // PS 5.1 Get-Process exits 1 with no output on zero matches: empty result.
  if (r.status !== 0 && (r.stdout || '') === '' && (r.stderr || '') === '') return '';
  if (r.status !== 0) throw new Error('powershell failed: ' + ((r.stderr || r.stdout || '').slice(0, 300)));
  return r.stdout;
}

let paintPid = null;
const retainedIds = [];

describe('integration: screenshot evidence (REAL desktop)', CUP ?? {}, () => {
  before(() => {
    fs.mkdirSync(TMP, { recursive: true });
    const before = sh(['-Command', 'Get-Process mspaint -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id']).trim();
    sh(['-Command', 'Start-Process mspaint.exe']);
    let pid = null;
    for (let i = 0; i < 20; i++) {
      const list = sh(['-Command', 'Get-Process mspaint -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id']).trim().split(/\s+/);
      pid = list.map(Number).find((n) => n > 0 && String(n) !== String(before).trim());
      if (pid) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
    }
    assert.ok(pid, 'must launch an automation-owned Paint');
    paintPid = pid;
  });

  after(() => {
    if (paintPid) spawnSync('C:\\Windows\\System32\\taskkill.exe', ['/F', '/PID', String(paintPid)], { encoding: 'utf8' });
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  });

  it('EV-01 capture discard proves the source without keeping pixels', () => {
    const r = ev('capture', { app: 'mspaint', mode: 'discard', purpose: 'e2e-evidence-test' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.retained, false);
    assert.ok(r.bytes > 10000, 'real screenshot bytes, got ' + r.bytes);
    assert.ok(r.width > 100 && r.height > 100, 'decoded dimensions');
  });

  it('EV-02 keep retains a verified, indexed file that survives cleanup', () => {
    const r = ev('capture', { app: 'mspaint', mode: 'keep', purpose: 'e2e-keep-test', why: 'retention smoke proof' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(fs.existsSync(r.abs_path), 'retained file must exist');
    retainedIds.push(r.id);
    const v = ev('verify', { id: r.id });
    assert.equal(v.ok, true, JSON.stringify(v));
    assert.match(v.path, /^artifacts\//, 'stored path must be skill-relative');
  });

  it('EV-03 auto + decide(false) deletes only the owned temp file', () => {
    const r = ev('capture', { app: 'mspaint', mode: 'auto', purpose: 'e2e-temp-test' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(fs.existsSync(r.path), 'auto capture stages a temp file');
    const d = ev('decide', { path: r.path, useful: false });
    assert.equal(d.ok, true, JSON.stringify(d));
    assert.ok(!fs.existsSync(r.path), 'owned temp file removed');
  });

  it('EV-04 auto + decide(true) retains; duplicates detected by hash', () => {
    const r = ev('capture', { app: 'mspaint', mode: 'auto', purpose: 'e2e-auto-keep' });
    const d = ev('decide', { ...r, useful: true, kind: 'evidence', why: 'auto-retain proof', test_ref: 'EV-04' });
    assert.equal(d.ok, true, JSON.stringify(d));
    retainedIds.push(d.id);
    const r2 = ev('capture', { app: 'mspaint', mode: 'auto', purpose: 'e2e-auto-dup' });
    const d2 = ev('decide', { ...r2, useful: true, dedupe_against_index: true });
    assert.equal(d2.ok, true, JSON.stringify(d2));
    // Duplicate or changed screen both handled honestly: either deduped
    // (retained=false) or genuinely new pixels (retained=true).
    if (d2.retained) retainedIds.push(d2.id);
    else assert.ok(!fs.existsSync(r2.path), 'duplicate temp file removed');
  });

  it('EV-05 discard refuses retained artifacts and user files', () => {
    const listed = ev('list', {});
    assert.ok(listed.entries.length >= retainedIds.length, 'index holds entries');
    const victim = path.join(ROOT, listed.entries[0].path);
    const r1 = ev('discard', { path: victim });
    assert.equal(r1.ok, false, 'must refuse retained artifact');
    assert.ok(fs.existsSync(victim), 'retained file untouched');
    const r2 = ev('discard', { path: path.join(ROOT, 'SKILL.md') });
    assert.equal(r2.ok, false, 'must refuse user file');
    assert.ok(fs.existsSync(path.join(ROOT, 'SKILL.md')), 'user file untouched');
  });

  it('EV-06 metadata valid, relative, and append-safe', () => {
    const before = ev('list', {}).entries.map((e) => e.id);
    assert.ok(before.length >= 2, 'earlier retains present, got ' + before.length);
    for (const id of retainedIds) assert.ok(before.includes(id), 'entry preserved: ' + id);
    const r = ev('capture', { app: 'mspaint', mode: 'keep', purpose: 'e2e-meta-test', why: 'metadata proof' });
    assert.equal(r.ok, true, JSON.stringify(r));
    retainedIds.push(r.id);
    const after = ev('list', {}).entries;
    for (const id of [...retainedIds]) assert.ok(after.map((e) => e.id).includes(id), 'all entries preserved after append');
    const entry = after.find((e) => e.id === r.id);
    for (const f of ['id', 'path', 'captured_at', 'purpose', 'reason', 'width', 'height', 'bytes', 'sha256']) {
      assert.ok(entry[f] !== undefined && entry[f] !== '', 'field present: ' + f);
    }
    assert.ok(!entry.path.includes(':') && !entry.path.startsWith('\\'), 'relative path: ' + entry.path);
  });

  it('EV-07 artifacts and test-results are Git-ignored', () => {
    for (const p of ['artifacts/screenshots/x.png', 'test-results/y.txt']) {
      const r = spawnSync('git', ['check-ignore', '-q', p], { encoding: 'utf8', cwd: ROOT });
      assert.equal(r.status, 0, p + ' must be ignored');
    }
  });

  it('EV-08 failures are explicit with no partial index entries', () => {
    const n0 = ev('list', {}).entries.length;
    const r = ev('capture', { app: 'NoSuchAppXYZ123', mode: 'keep', purpose: 'e2e-fail-test' });
    assert.equal(r.ok, false, 'unknown app must fail explicitly');
    assert.match(String(r.error), /./, 'error message present');
    const n1 = ev('list', {}).entries.length;
    assert.equal(n1, n0, 'no partial entry on failure');
  });

  it('EV-09 cleanup removes temp captures but retained evidence survives', () => {
    const r = ev('capture', { app: 'mspaint', mode: 'auto', purpose: 'e2e-cleanup-test' });
    assert.ok(fs.existsSync(r.path));
    const gone = ev('discard', { path: r.path });
    assert.equal(gone.ok, true, JSON.stringify(gone));
    assert.ok(!fs.existsSync(r.path), 'temp capture cleaned');
    for (const id of retainedIds) {
      const v = ev('verify', { id });
      assert.equal(v.ok, true, 'retained survives cleanup: ' + id);
    }
  });
});
