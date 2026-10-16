param(
    [string]$Workspace = (Join-Path $PSScriptRoot 'workspace\preprocessed')
)

$ErrorActionPreference = 'Stop'
$node = Get-Command node -ErrorAction Stop
$mergeScript = Join-Path $PSScriptRoot 'Merge-PreprocessedCameraViews.js'
if (-not (Test-Path -LiteralPath $mergeScript)) { throw "Camera merge script not found: $mergeScript" }
& $node.Source $mergeScript ([IO.Path]::GetFullPath($Workspace))
if ($LASTEXITCODE -ne 0) { throw "Camera metadata merge failed with exit code $LASTEXITCODE." }
