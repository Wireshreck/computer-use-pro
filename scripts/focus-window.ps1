#Requires -Version 5.1
<#
.SYNOPSIS
  Brings an automation-owned window to the foreground.
.DESCRIPTION
  Used only for the skill's own disposable test windows (e.g. the Notepad
  instance created by launch-notepad.ps1). Coordinate drag/scroll need a
  visible, non-minimized, on-screen window; this restores that precondition
  after the terminal has covered it. Never target windows the automation did
  not create: the caller must pass the exact pid it owns.
#>
[CmdletBinding()]
param([Parameter(Mandatory = $true)][int]$TargetPid)
$ErrorActionPreference = 'Stop'
$proc = Get-Process -Id $TargetPid -ErrorAction Stop
if ($proc.ProcessName -ne 'notepad') { throw "refusing to focus non-Notepad process $($proc.ProcessName) (pid $TargetPid)" }
$shell = New-Object -ComObject WScript.Shell
if (-not $shell.AppActivate($TargetPid)) { throw "AppActivate failed for pid $TargetPid" }
Start-Sleep -Milliseconds 800
$proc.Refresh()
if ($proc.MainWindowHandle -eq 0) { throw "window handle missing for pid $TargetPid after focus" }
Write-Output "focused pid $TargetPid title $($proc.MainWindowTitle)"
