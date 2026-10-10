#Requires -Version 5.1
<#
.SYNOPSIS
  Smart screenshot capture and evidence management for computer-use-pro.
.DESCRIPTION
  Screenshots come from the existing native source only: the app-bound
  getScreenshot() in `ocu js` (same pixels as get_app_state). This helper
  never invents an image: every retained file is decoded with System.Drawing
  before it is indexed, and a capture that yields no bytes is an explicit
  error, not an empty file.

  Layout (created on demand under the skill root):
    artifacts/screenshots/  retained images useful for future work
    artifacts/evidence/     before/after pairs and test evidence
    artifacts/index.json    metadata for every retained image
    test-results/           summaries, logs, temporary test artifacts

  Retention modes:
    keep       preserve the image (verified, indexed).
    temporary  keep only while the current operation needs it (owned temp dir).
    auto       capture to temp, then decide usefulness (see decide action).
    discard    capture for proof-of-capture only, then delete immediately.

  JSON interface (mirrors scripts/send-input.ps1):
    powershell -NoProfile -ExecutionPolicy Bypass -File capture-evidence.ps1 `
      -Action capture -ParamsJson '{"app":"mspaint","mode":"auto","purpose":"..."}'
    Actions: capture | decide | retain | discard | list | verify
    Prints one JSON object; exit 0 on transport.

  Deletion guard: discard/decide(delete) only remove files under owned
  temporary zones (%TEMP%\cup-* or <skill>\test-results\). Anything else —
  retained artifacts, user files — is refused, never force-deleted.
.EXAMPLE
  .\capture-evidence.ps1 -Action capture -ParamsJson '{"app":"mspaint","mode":"keep","purpose":"baseline","why":"pre-drag canvas state"}'
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('capture', 'decide', 'retain', 'discard', 'list', 'verify')]
  [string]$Action,
  [Parameter(Mandatory = $false)]
  [string]$ParamsJson = '{}',
  [Parameter(Mandatory = $false)]
  [int]$TimeoutMs = 120000
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$SkillRoot = Split-Path $PSScriptRoot -Parent
$ArtifactsRoot = Join-Path $SkillRoot 'artifacts'
$ShotsDir = Join-Path $ArtifactsRoot 'screenshots'
$EvidenceDir = Join-Path $ArtifactsRoot 'evidence'
$IndexPath = Join-Path $ArtifactsRoot 'index.json'
$ResultsRoot = Join-Path $SkillRoot 'test-results'
$OwnedTempRoots = @(
  (Join-Path ([IO.Path]::GetTempPath()) 'cup-evidence'),
  (Join-Path ([IO.Path]::GetTempPath()) 'cup-e2e'),
  (Join-Path ([IO.Path]::GetTempPath()) 'cup-paint-test'),
  (Join-Path ([IO.Path]::GetTempPath()) 'cup-probe'),
  $ResultsRoot
)

function Get-FileSha256([string]$path) {
  # Inline .NET instead of Get-FileHash: module autoload can resolve
  # Microsoft.PowerShell.Utility to the PowerShell 7 module directory first,
  # where the binary cmdlet fails to load under Windows PowerShell 5.1.
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $stream = [IO.File]::OpenRead($path)
    try {
      return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '')
    } finally {
      $stream.Dispose()
    }
  } finally {
    $sha.Dispose()
  }
}

function Get-OcuCommand {
  $cand = Join-Path $env:APPDATA 'npm\ocu.cmd'
  if (Test-Path $cand) { return $cand }
  $found = (Get-Command ocu.cmd -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)
  if ($found) { return $found }
  throw 'ocu.cmd not found; open-computer-use must be installed with `ocu` on PATH'
}

function Test-OwnedTempFile([string]$path) {
  if ([string]::IsNullOrWhiteSpace($path)) { return $false }
  try { $full = [IO.Path]::GetFullPath($path) } catch { return $false }
  foreach ($root in $OwnedTempRoots) {
    $r = [IO.Path]::GetFullPath($root)
    if ($full.StartsWith($r, [StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $false
}

function Read-Index {
  if (-not (Test-Path $IndexPath)) { return @() }
  $raw = [IO.File]::ReadAllText($IndexPath)
  if ([string]::IsNullOrWhiteSpace($raw)) { return @() }
  $parsed = $raw | ConvertFrom-Json
  if ($null -eq $parsed) { return @() }
  if ($parsed -is [array]) { return $parsed }
  return @($parsed)
}

function Write-Index($entries) {
  New-Item -ItemType Directory -Force -Path $ArtifactsRoot | Out-Null
  $json = ConvertTo-Json @($entries) -Depth 8
  [IO.File]::WriteAllText($IndexPath, $json, [Text.Encoding]::UTF8)
}

function Get-ImageInfo([string]$path) {
  $img = [Drawing.Image]::FromFile($path)
  try {
    return @{ width = $img.Width; height = $img.Height; format = $img.RawFormat.Guid.ToString() }
  } finally {
    $img.Dispose()
  }
}

function New-EvidenceId {
  return ('ev-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + ([Guid]::NewGuid().ToString('N').Substring(0, 8)))
}

function Invoke-OcuScreenshot([string]$app, [string]$outPath, [int]$timeoutMs) {
  $ocu = Get-OcuCommand
  $workDir = Split-Path $outPath -Parent
  $jsFile = Join-Path $workDir 'input.js'
  $outFile = Join-Path $workDir 'stdout.txt'
  $errFile = Join-Path $workDir 'stderr.txt'
  $js = @'
var app = await cua.getApp(APPNAME);
var shot = await app.getScreenshot({emit:false});
var fs = await import("node:fs");
fs.writeFileSync(OUTPATH, shot);
nodeRepl.write("CUP::bytes=" + shot.length);
'@ -replace 'APPNAME', ($app | ConvertTo-Json -Compress) `
    -replace 'OUTPATH', ($outPath | ConvertTo-Json -Compress)
  # File-based stdio throughout: feeding stdin and draining stdout through
  # .NET redirected pipes deadlocks when the child emits a large AX tree
  # while the parent waits (64 KB pipe buffer, nobody reading). cmd-level
  # redirection to files cannot deadlock.
  [IO.File]::WriteAllText($jsFile, $js, [Text.Encoding]::UTF8)
  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = 'C:\Windows\System32\cmd.exe'
  $psi.Arguments = '/c ""' + $ocu + '" js --timeout ' + $timeoutMs + ' - < "' + $jsFile + '" > "' + $outFile + '" 2> "' + $errFile + '"'
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $proc = [Diagnostics.Process]::Start($psi)
  # Transient capture contention (e.g. a just-launched window whose DWM
  # surface is not ready) can stall the native call: bound the wait, retry
  # once in a fresh session, then fail explicitly. Never wait forever.
  if (-not $proc.WaitForExit($timeoutMs + 15000)) {
    try { $proc.Kill() } catch {}
    throw "ocu js did not finish within $($timeoutMs + 15000) ms (transient capture stall?)"
  }
  $out = ''
  if (Test-Path $outFile) { $out = [IO.File]::ReadAllText($outFile) }
  if ($proc.ExitCode -ne 0 -and $out -notmatch 'CUP::bytes=') {
    $err = ''
    if (Test-Path $errFile) { $err = [IO.File]::ReadAllText($errFile) }
    if ($err.Length -gt 300) { $err = $err.Substring(0, 300) }
    throw ('ocu js failed: ' + $err).Trim()
  }
  $m = [regex]::Match($out, 'CUP::bytes=(\d+)')
  if (-not $m.Success) { throw 'ocu returned no screenshot bytes (target may have no capturable window)' }
  if (-not (Test-Path $outPath)) { throw 'ocu reported bytes but wrote no file' }
  return [int]$m.Groups[1].Value
}

function Add-IndexEntry($entry) {
  foreach ($f in @('id', 'path', 'captured_at', 'purpose', 'reason')) {
    if ([string]::IsNullOrWhiteSpace($entry[$f])) { throw "index entry missing required field '$f'" }
  }
  $entries = @(Read-Index)
  if ($entries | Where-Object { $_.id -eq $entry.id }) { throw "duplicate index id '$($entry.id)'" }
  $entries += $entry
  Write-Index $entries
  return $entry
}

function Invoke-RetainFile([string]$src, [string]$dest, $meta, [string]$why) {
  if ([string]::IsNullOrWhiteSpace($why)) { $why = $meta.purpose }
  $destDir = Split-Path $dest -Parent
  New-Item -ItemType Directory -Force -Path $destDir | Out-Null
  if (Test-Path $dest) { throw 'refusing to overwrite existing artifact: ' + $dest }
  Copy-Item $src $dest -Force
  # Relative path without .NET Core-only GetRelativePath (PS 5.1 compat).
  $rel = [string]$dest
  $rootPrefix = $SkillRoot.TrimEnd('\') + '\'
  if ($rel.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    $rel = $rel.Substring($rootPrefix.Length)
  }
  $rel = $rel.Replace('\', '/')
  $entry = @{
    id = $meta.id; path = $rel; captured_at = $meta.captured_at
    app = $meta.app; purpose = $meta.purpose; context = $meta.context
    test_ref = $meta.test_ref; reason = $why
    width = $meta.width; height = $meta.height
    bytes = $meta.bytes; sha256 = $meta.sha256
  }
  Add-IndexEntry $entry | Out-Null
  # Re-read to confirm the write landed (never claim saved until verified).
  $check = Read-Index | Where-Object { $_.id -eq $entry.id }
  if (-not $check -or -not (Test-Path $dest)) { throw 'retention write could not be verified' }
  return @{ id = $entry.id; path = $rel; abs_path = $dest }
}

try {
  $p = $ParamsJson | ConvertFrom-Json
  $result = $null
  switch ($Action) {
    'capture' {
      if ([string]::IsNullOrWhiteSpace($p.app)) { throw "capture requires 'app'" }
      $mode = if ([string]::IsNullOrWhiteSpace($p.mode)) { 'auto' } else { $p.mode.ToLowerInvariant() }
      if (@('keep', 'temporary', 'auto', 'discard') -notcontains $mode) { throw "unknown mode '$($p.mode)'" }
      $purpose = if ([string]::IsNullOrWhiteSpace($p.purpose)) { 'unspecified' } else { [string]$p.purpose }
      $id = New-EvidenceId
      $tmpDir = Join-Path ([IO.Path]::GetTempPath()) (Join-Path 'cup-evidence' $id)
      New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null
      $tmpFile = Join-Path $tmpDir 'capture.png'
      $bytes = 0
      $attemptErr = ''
      $ocuTimeout = [math]::Min($TimeoutMs, 45000)
      for ($attempt = 1; $attempt -le 2 -and $bytes -le 0; $attempt++) {
        try {
          $bytes = Invoke-OcuScreenshot ([string]$p.app) $tmpFile $ocuTimeout
        } catch {
          $attemptErr = $_.Exception.Message
          if ($attempt -eq 1) { Start-Sleep -Seconds 5 }
        }
      }
      if ($bytes -le 0) { throw "capture failed after 2 attempts: $attemptErr" }
      if ($bytes -le 0) { throw 'capture produced zero bytes' }
      $info = Get-ImageInfo $tmpFile  # throws unless decodable
      $hash = Get-FileSha256 $tmpFile
      $meta = @{
        id          = $id
        app         = [string]$p.app
        captured_at = (Get-Date).ToUniversalTime().ToString('o')
        purpose     = $purpose
        context     = if ($null -ne $p.context) { [string]$p.context } else { '' }
        test_ref    = if ($null -ne $p.test_ref) { [string]$p.test_ref } else { '' }
        width       = $info.width; height = $info.height
        bytes       = $bytes; sha256 = $hash
      }
      if ($mode -eq 'discard') {
        Remove-Item $tmpFile -Force
        $result = @{ ok = $true; action = 'capture'; mode = 'discard'; retained = $false } + $meta
      } elseif ($mode -eq 'keep') {
        $dest = Join-Path $ShotsDir ($id + '.png')
        $r = Invoke-RetainFile $tmpFile $dest $meta ([string]$p.why)
        $result = @{ ok = $true; action = 'capture'; mode = 'keep'; retained = $true } + $r
      } else {
        $meta.path = $tmpFile
        $result = @{ ok = $true; action = 'capture'; mode = $mode; retained = $false } + $meta
      }
    }
    'decide' {
      if ([string]::IsNullOrWhiteSpace($p.path)) { throw "decide requires 'path'" }
      if (-not (Test-Path $p.path)) { throw 'capture file no longer exists: ' + $p.path }
      $useful = [bool]$p.useful
      if ($null -ne $p.dedupe_against_index -and [bool]$p.dedupe_against_index) {
        $hash = Get-FileSha256 ([string]$p.path)
        if (Read-Index | Where-Object { $_.sha256 -eq $hash }) { $useful = $false }
      }
      if ($useful) {
        $meta = @{
          id          = if ([string]::IsNullOrWhiteSpace($p.id)) { New-EvidenceId } else { [string]$p.id }
          app         = if ($null -ne $p.app) { [string]$p.app } else { '' }
          captured_at = if ([string]::IsNullOrWhiteSpace($p.captured_at)) { (Get-Date).ToUniversalTime().ToString('o') } else { [string]$p.captured_at }
          purpose     = if ([string]::IsNullOrWhiteSpace($p.purpose)) { 'unspecified' } else { [string]$p.purpose }
          context     = if ($null -ne $p.context) { [string]$p.context } else { '' }
          test_ref    = if ($null -ne $p.test_ref) { [string]$p.test_ref } else { '' }
          width       = [int]$p.width; height = [int]$p.height
          bytes       = [int]$p.bytes; sha256 = Get-FileSha256 ([string]$p.path)
        }
        $kind = if ([string]$p.kind -eq 'evidence') { 'evidence' } else { 'screenshots' }
        $dest = Join-Path (Join-Path $ArtifactsRoot $kind) ($meta.id + '.png')
        $r = Invoke-RetainFile ([string]$p.path) $dest $meta ([string]$p.why)
        $result = @{ ok = $true; action = 'decide'; retained = $true; kind = $kind } + $r
      } else {
        if (-not (Test-OwnedTempFile ([string]$p.path))) { throw 'refusing to delete a file outside owned temporary zones: ' + $p.path }
        Remove-Item ([string]$p.path) -Force
        $result = @{ ok = $true; action = 'decide'; retained = $false; reason = 'not useful' }
      }
    }
    'retain' {
      if ([string]::IsNullOrWhiteSpace($p.src)) { throw "retain requires 'src'" }
      if (-not (Test-Path $p.src)) { throw 'source file does not exist: ' + $p.src }
      $kind = if ([string]$p.kind -eq 'evidence') { 'evidence' } else { 'screenshots' }
      $meta = @{
        id          = if ([string]::IsNullOrWhiteSpace($p.id)) { New-EvidenceId } else { [string]$p.id }
        app         = if ($null -ne $p.app) { [string]$p.app } else { '' }
        captured_at = (Get-Date).ToUniversalTime().ToString('o')
        purpose     = if ([string]::IsNullOrWhiteSpace($p.purpose)) { 'unspecified' } else { [string]$p.purpose }
        context     = if ($null -ne $p.context) { [string]$p.context } else { '' }
        test_ref    = if ($null -ne $p.test_ref) { [string]$p.test_ref } else { '' }
      }
      $info = Get-ImageInfo ([string]$p.src)
      $meta.width = $info.width; $meta.height = $info.height
      $meta.bytes = (Get-Item ([string]$p.src)).Length
      $meta.sha256 = Get-FileSha256 ([string]$p.src)
      $dest = Join-Path (Join-Path $ArtifactsRoot $kind) ($meta.id + '.png')
      $r = Invoke-RetainFile ([string]$p.src) $dest $meta ([string]$p.why)
      $result = @{ ok = $true; action = 'retain'; kind = $kind } + $r
    }
    'discard' {
      if ([string]::IsNullOrWhiteSpace($p.path)) { throw "discard requires 'path'" }
      if (-not (Test-OwnedTempFile ([string]$p.path))) {
        throw 'refusing to delete outside owned temporary zones (retained artifacts and user files are never deleted): ' + $p.path
      }
      if (Test-Path $p.path) { Remove-Item ([string]$p.path) -Force }
      $result = @{ ok = $true; action = 'discard'; path = [string]$p.path; deleted = $true }
    }
    'list' {
      $result = @{ ok = $true; action = 'list'; entries = @(Read-Index) }
    }
    'verify' {
      $found = Read-Index | Where-Object { $_.id -eq [string]$p.id }
      if (-not $found) { throw "no index entry for id '" + $p.id + "'" }
      $full = Join-Path $SkillRoot ([string]$found.path)
      if (-not (Test-Path $full)) { throw 'indexed file is missing: ' + $found.path }
      $info = Get-ImageInfo $full
      $result = @{ ok = $true; action = 'verify'; id = [string]$p.id; path = [string]$found.path; width = $info.width; height = $info.height }
    }
  }
  $result | ConvertTo-Json -Compress -Depth 8
} catch {
  @{ ok = $false; action = $Action; error = $_.Exception.Message } | ConvertTo-Json -Compress -Depth 6
}
