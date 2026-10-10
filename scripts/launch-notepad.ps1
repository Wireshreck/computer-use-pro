#Requires -Version 5.1
<#
.SYNOPSIS
  Approved application launcher for computer-use-pro automation.
.DESCRIPTION
  Opens a disposable Notepad window on a caller-supplied temp file and waits
  until the main window exists. This is the sanctioned replacement for the
  unsupported Windows/Super key: the native 9-tool surface has no launch or
  key-based Start-menu support (see lib/keys.mjs), so Start-Process is the
  legitimate mechanism. Only ever opens the file it is given; never touches
  other Notepad instances or pre-existing tabs.
.EXAMPLE
  $r = .\launch-notepad.ps1 -FilePath "$env:TEMP\cup-probe\case-1.txt" -SeedLines 120
  $r | ConvertTo-Json  # {"pid":1234,"title":"case-1.txt - Notepad","file":"..."}
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$FilePath,
  [int]$SeedLines = 120,
  [int]$WaitSeconds = 15
)

$ErrorActionPreference = 'Stop'

# Confine test data to the temp area so automation can never aim at real files.
$tempRoot = [System.IO.Path]::GetFullPath($env:TEMP)
$target = [System.IO.Path]::GetFullPath($FilePath)
if (-not $target.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "refusing to open a file outside TEMP: $target"
}

$dir = Split-Path $target -Parent
New-Item -ItemType Directory -Force -Path $dir | Out-Null
if (-not (Test-Path $target)) {
  $lines = 1..$SeedLines | ForEach-Object { "probe line {0:D4} abcdefghij" -f $_ }
  Set-Content -Path $target -Value ($lines -join "`r`n") -Encoding UTF8
}

$before = Get-Process notepad -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id
$proc = Start-Process notepad.exe -ArgumentList "`"$target`"" -PassThru
$base = [System.IO.Path]::GetFileNameWithoutExtension($target)
$deadline = (Get-Date).AddSeconds($WaitSeconds)
$handle = 0
$title = ''
do {
  Start-Sleep -Milliseconds 300
  try { $proc.Refresh(); $handle = $proc.MainWindowHandle; $title = $proc.MainWindowTitle } catch { $handle = 0; $title = '' }
  if ([string]::IsNullOrEmpty($title) -or $title -notlike "*$base*") {
    # Fresh window shows a transient bare "Notepad" title before the tab
    # loads; adopt any new titled instance and keep waiting for our file.
    $cand = Get-Process notepad -ErrorAction SilentlyContinue |
      Where-Object { ($before -notcontains $_.Id) -and $_.MainWindowTitle -like "*$base*" } |
      Select-Object -First 1
    if ($cand) { $proc = $cand; $title = $cand.MainWindowTitle; $handle = $cand.MainWindowHandle }
  }
} while (($handle -eq 0 -or [string]::IsNullOrEmpty($title) -or $title -notlike "*$base*") -and (Get-Date) -lt $deadline)

if ($handle -eq 0 -or [string]::IsNullOrEmpty($title) -or $title -notlike "*$base*") {
  throw "launched Notepad (pid $($proc.Id)) but '$base' did not appear in the title within ${WaitSeconds}s (last title: '$title')"
}

[pscustomobject]@{
  pid   = $proc.Id
  title = $title
  file  = $target
} | ConvertTo-Json -Compress
