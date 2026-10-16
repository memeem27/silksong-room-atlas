param(
    [string]$BucketName = 'silksong-gauntlet-atlas-data',
    [string]$DataDirectory = (Join-Path $PSScriptRoot 'HostedAtlas\r2-data')
)

$ErrorActionPreference = 'Stop'
$dataRoot = [IO.Path]::GetFullPath($DataDirectory)
if (-not (Test-Path -LiteralPath $dataRoot)) { throw "R2 data package not found: $dataRoot. Run Build-HostedAtlas.ps1 first." }
$statusPath = Join-Path $PSScriptRoot 'HostedAtlas\DATA-EXPORT-STATUS.txt'
if (-not (Test-Path -LiteralPath $statusPath) -or (Get-Content -LiteralPath $statusPath -Raw) -notmatch '^Silksong GauntletSong Atlas data export completed') {
    throw 'The export is incomplete or its completion status is missing. Finish Build-HostedAtlas.ps1 before uploading.'
}
$auditPath = Join-Path $PSScriptRoot 'HostedAtlas\AUDIT-REPORT.json'
if (-not (Test-Path -LiteralPath $auditPath)) { throw 'Run Audit-HostedAtlas.ps1 successfully before uploading.' }
$audit = Get-Content -LiteralPath $auditPath -Raw | ConvertFrom-Json
if ($audit.status -ne 'passed') { throw "The latest hosted atlas audit did not pass: $($audit.status)." }
if (-not (Get-Command npx -ErrorAction SilentlyContinue)) { throw 'Install Node.js LTS first so npx is available.' }

$files = @(Get-ChildItem -LiteralPath $dataRoot -Recurse -File)
$total = $files.Count
if ($total -eq 0) { throw 'The R2 data package is empty.' }
Write-Output "Uploading $total objects to Cloudflare R2 bucket '$BucketName'. Wrangler must already be logged in."
$index = 0
foreach ($file in $files) {
    $relative = $file.FullName.Substring($dataRoot.Length).TrimStart('\').Replace('\', '/')
    $objectPath = "$BucketName/$relative"
    $result = & npx wrangler r2 object put $objectPath --file $file.FullName --remote --force 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Upload failed for $relative : $($result -join ' ')" }
    $index++
    if ($index % 25 -eq 0 -or $index -eq $total) {
        Write-Progress -Activity 'Uploading Silksong atlas data to Cloudflare R2' -Status "$index / $total objects" -PercentComplete (($index / $total) * 100)
        Write-Output ("Uploaded {0}/{1}: {2}" -f $index, $total, $relative)
    }
}
Write-Progress -Activity 'Uploading Silksong atlas data to Cloudflare R2' -Completed
Write-Output 'R2 upload completed.'
