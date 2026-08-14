# install-watch-windows.ps1 — run the ayin watch daemon on Windows via Task Scheduler.
#
# The Windows counterpart of the macOS launchd job (com.ayin.watch): registers a task that starts
# `ayin watch` at logon and restarts it on failure (launchd KeepAlive equivalent), so the reviewer
# is always up and resumes its queue on boot — same power-cut discipline.
#
#   powershell -ExecutionPolicy Bypass -File tool\install-watch-windows.ps1 `
#       -LlmUrl http://<your-llm-host>:9100
#
# `-LlmUrl` is REQUIRED and has no default: it used to ship pointing at one machine on the author's
# own LAN, which silently aimed every fresh install at a host that isn't yours. If the endpoint runs on
# this same Windows box, pass http://localhost:9100 explicitly.
#
# Requires: Node on PATH, and Git for Windows (git runs the .git/hooks/post-commit + post-merge
# shell hooks through its bundled bash — the hooks are portable `#!/bin/sh`). Uninstall:
#   Unregister-ScheduledTask -TaskName AyinWatch -Confirm:$false
param(
  [Parameter(Mandatory = $true)]
  [string]$LlmUrl,
  [string]$TaskName = "AyinWatch"
)
$ErrorActionPreference = "Stop"

# Resolve node + the built entrypoint (this script lives in <repo>/tool).
$node = (Get-Command node -ErrorAction Stop).Source
$repo = Split-Path -Parent $PSScriptRoot            # <repo> (parent of tool\)
$entry = Join-Path $repo "dist\index.js"
if (-not (Test-Path $entry)) { throw "built entrypoint not found: $entry  (run `npm run build` first)" }

# A tiny launcher .cmd that sets AYIN_MODEL_URL then runs the daemon — avoids Task Scheduler arg-quoting
# pain and gives one place to see/edit the env.
$dir = Join-Path $env:USERPROFILE ".ayin-cli"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$cmd = Join-Path $dir "ayin-watch.cmd"
@"
@echo off
set AYIN_MODEL_URL=$LlmUrl
"$node" "$entry" watch
"@ | Set-Content -Encoding ASCII $cmd

$action   = New-ScheduledTaskAction -Execute $cmd
$trigger  = New-ScheduledTaskTrigger -AtLogOn
# Keep it alive: restart on failure, run indefinitely, don't stop on idle/battery.
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -StartWhenAvailable -Hidden

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
  -Description "ayin watch — local code-review daemon (post-commit/merge review, 10-min working-tree pass)" | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Host "Installed scheduled task '$TaskName'."
Write-Host "Launcher: $cmd   (AYIN_MODEL_URL=$LlmUrl)"
Write-Host "Register a repo to watch:  ayin watch --repo C:\path\to\repo"
Write-Host "Stop/remove:  Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
