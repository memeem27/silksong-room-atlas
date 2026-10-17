param(
    [string]$Workspace = (Join-Path $PSScriptRoot 'workspace\preprocessed'),
    [string]$BaseUrl = 'http://127.0.0.1:5180',
    [string[]]$Room,
    [switch]$AllowIncomplete
)

$ErrorActionPreference = 'Stop'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js is required to enrich the Architect sidecars.' }

$scriptPath = Join-Path $PSScriptRoot 'Enrich-PreprocessedEnemyArtwork.js'
$arguments = @($scriptPath, '--workspace', [System.IO.Path]::GetFullPath($Workspace), '--base-url', $BaseUrl)
if ($Room -and $Room.Count -gt 0) { $arguments += "--rooms=$($Room -join ',')" }
if ($AllowIncomplete) { $arguments += '--allow-incomplete' }

& $node.Source @arguments
if ($LASTEXITCODE -ne 0) { throw "Enemy-artwork enrichment exited with code $LASTEXITCODE." }
