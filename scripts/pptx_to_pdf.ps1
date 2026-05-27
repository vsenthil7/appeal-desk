# Convert Appeal-Desk pitch deck .pptx -> .pdf via PowerPoint COM automation.
#
# Looks for the most recent appeal-desk-pitch-deck-*.pptx in the sibling
# `submission_media/` folder (i.e. appeal-desk/submission_media/) and writes
# the .pdf next to it. The path is derived from the script location so the
# script keeps working regardless of where appeal-desk/ is cloned.
#
# Ported from atrio/scripts/pptx_to_pdf.ps1 with only the brand-name + glob
# changed -- the COM automation pattern is identical.

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Resolve-Path (Join-Path $here '..\submission_media') | ForEach-Object Path

# Find the most recent pptx
$pptx = Get-ChildItem $out -Filter 'appeal-desk-pitch-deck-*.pptx' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $pptx) {
    Write-Host "No pptx found in $out" -ForegroundColor Red
    Write-Host "Run first:  python appeal-desk/scripts/build_pitch_deck.py" -ForegroundColor Yellow
    exit 1
}
$pdf = [System.IO.Path]::ChangeExtension($pptx.FullName, '.pdf')
Write-Host "Converting: $($pptx.Name) -> $(Split-Path -Leaf $pdf)"

$ppt = $null
$pres = $null
try {
    $ppt = New-Object -ComObject PowerPoint.Application
    $ppt.Visible = [Microsoft.Office.Core.MsoTriState]::msoTrue
    # Constants
    $ppSaveAsPDF = 32
    $pres = $ppt.Presentations.Open($pptx.FullName, $true, $true, $false)  # ReadOnly, Untitled, WithWindow:false
    $pres.SaveAs($pdf, $ppSaveAsPDF)
    $pres.Close()
    Write-Host "  pdf: $pdf ($([math]::Round((Get-Item $pdf).Length / 1KB, 1)) KB)" -ForegroundColor Green

    # Backup
    $backup = Join-Path $out '_backup'
    New-Item -Path $backup -ItemType Directory -Force | Out-Null
    Copy-Item $pdf (Join-Path $backup (Split-Path -Leaf $pdf)) -Force
    Write-Host "  backup: $(Join-Path $backup (Split-Path -Leaf $pdf))"
} finally {
    if ($pres) {
        try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($pres) } catch {}
    }
    if ($ppt) {
        try { $ppt.Quit() } catch {}
        try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($ppt) } catch {}
    }
    [System.GC]::Collect()
    [System.GC]::WaitForPendingFinalizers()
}
