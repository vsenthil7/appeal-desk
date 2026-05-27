# Encode the Appeal-Desk demo video.
#
# Reads the 7 PNG frames from submission_media/demovideo_frames/ and produces:
#   submission_media/appeal-desk-walkthrough-<stamp>.mp4
#
# Timing target: <= 60 seconds total. 7 frames at 8 seconds each = 56s, with
# 0.4s crossfades layered between them via ffmpeg's xfade filter.
#
# Requires: ffmpeg on PATH.
#
# Note: $ErrorActionPreference is deliberately NOT 'Stop' -- ffmpeg writes its
# banner + progress to stderr, which PowerShell would otherwise treat as a
# terminating error. We check the exit code and output file existence manually.

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$frames_dir = Resolve-Path (Join-Path $here '..\submission_media\demovideo_frames') | ForEach-Object Path
$out_dir    = Resolve-Path (Join-Path $here '..\submission_media') | ForEach-Object Path

if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Host 'ffmpeg not found on PATH' -ForegroundColor Red
    exit 1
}

$frames = @(
    '01_title.png',
    '02_problem.png',
    '03_action_snapshot.png',
    '04_intake_form.png',
    '05_dashboard.png',
    '06_reply_confirm.png',
    '07_audit_outro.png'
)
foreach ($f in $frames) {
    if (-not (Test-Path (Join-Path $frames_dir $f))) {
        Write-Host "Missing frame: $f" -ForegroundColor Red
        exit 1
    }
}

$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$out_mp4 = Join-Path $out_dir "appeal-desk-walkthrough-$stamp.mp4"

# Per-frame display = 8s. Crossfade = 0.4s. 7 * 8 - 6 * 0.4 = 53.6s effective.
$dur = 8
$xfade = 0.4

$inputs_args = @()
foreach ($f in $frames) {
    $inputs_args += @('-loop', '1', '-t', "$dur", '-i', (Join-Path $frames_dir $f))
}

# Build the xfade chain. v0 + v1 -> vx1 (offset = 1*dur - 1*xfade),
# vx1 + v2 -> vx2 (offset = 2*dur - 2*xfade), ... last -> [vout].
$filter_parts = @()
$filter_parts += "[0:v]format=yuv420p,fps=30,setsar=1[v0]"
for ($i = 1; $i -lt $frames.Count; $i++) {
    $filter_parts += "[${i}:v]format=yuv420p,fps=30,setsar=1[v$i]"
}
$prev = 'v0'
for ($i = 1; $i -lt $frames.Count; $i++) {
    $offset = [math]::Round($i * $dur - $i * $xfade, 3)
    $next   = if ($i -eq $frames.Count - 1) { 'vout' } else { "vx$i" }
    # Note the use of double-quoted PowerShell strings + Format operator so that
    # PowerShell never sees a stray ':' that needs escaping.
    $line = '[{0}][v{1}]xfade=transition=fade:duration={2}:offset={3}[{4}]' -f $prev, $i, $xfade, $offset, $next
    $filter_parts += $line
    $prev = $next
}
$filter_complex = ($filter_parts -join ';')

Write-Host '=== filter_complex ===' -ForegroundColor Cyan
Write-Host $filter_complex

$ffmpeg_args = @()
$ffmpeg_args += '-y'
$ffmpeg_args += $inputs_args
$ffmpeg_args += @('-filter_complex', $filter_complex)
$ffmpeg_args += @('-map', '[vout]')
$ffmpeg_args += @('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30', '-preset', 'medium', '-crf', '21')
$ffmpeg_args += @('-movflags', '+faststart')
$ffmpeg_args += $out_mp4

Write-Host "Encoding -> $out_mp4" -ForegroundColor Cyan

# Stream ffmpeg output through stderr-redirect; capture exit code explicitly.
& ffmpeg @ffmpeg_args 2>&1 | Select-Object -Last 8
$ffmpeg_exit = $LASTEXITCODE

if (-not (Test-Path $out_mp4)) {
    Write-Host "ffmpeg failed to produce output (exit $ffmpeg_exit)" -ForegroundColor Red
    exit 1
}

$file = Get-Item $out_mp4
Write-Host '---' -ForegroundColor Green
Write-Host ('OUTPUT: {0} ({1:N2} MB)' -f $out_mp4, ($file.Length / 1MB)) -ForegroundColor Green
$probe = & ffprobe -v error -show_entries format=duration,size,bit_rate -of default=noprint_wrappers=1 $out_mp4 2>&1
$probe | ForEach-Object { Write-Host "  $_" }

# Backup
$backup = Join-Path $out_dir '_backup'
New-Item -Path $backup -ItemType Directory -Force | Out-Null
Copy-Item $out_mp4 (Join-Path $backup (Split-Path -Leaf $out_mp4)) -Force
Write-Host ('Backup: {0}' -f (Join-Path $backup (Split-Path -Leaf $out_mp4)))
