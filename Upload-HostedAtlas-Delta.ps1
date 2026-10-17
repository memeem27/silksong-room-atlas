param(
    [string]$DeltaPath = (Join-Path $PSScriptRoot 'HostedAtlas\delta-assets.json'),
    [string]$ReleaseIndexPath = (Join-Path $PSScriptRoot 'HostedAtlas\site\release-assets.json')
)

$ErrorActionPreference = 'Stop'
$delta = Get-Content -LiteralPath $DeltaPath -Raw | ConvertFrom-Json
$releaseIndex = Get-Content -LiteralPath $ReleaseIndexPath -Raw | ConvertFrom-Json
$repository = [string]$delta.repository
$tag = [string]$delta.releaseTag
$dataRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'HostedAtlas\r2-data'))
if (-not $repository -or -not $tag -or $tag -notmatch '^silksong-atlas-data-[0-9]{3}$') { throw 'Delta package repository or release tag is invalid.' }
if ($releaseIndex.repository -ne $repository) { throw 'The release index repository does not match the delta package.' }
$changed = @($delta.changedFiles | Where-Object { $_ } | Sort-Object -Unique)
if (-not $changed.Count) { throw 'The delta package does not contain any files.' }

$files = [Collections.Generic.List[string]]::new()
foreach ($relative in $changed) {
    $normalized = ([string]$relative).Replace('/', '\')
    if ([IO.Path]::IsPathRooted($normalized) -or ($normalized.Split([char]'\') -contains '..')) { throw "Unsafe release path: $relative" }
    $fullPath = [IO.Path]::GetFullPath((Join-Path $dataRoot $normalized))
    if (-not $fullPath.StartsWith($dataRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "Release path escapes the data directory: $relative" }
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) { throw "Release file is missing: $relative" }
    $files.Add($fullPath)
}

gh auth status | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'GitHub CLI authentication is unavailable.' }
gh release view $tag --repo $repository 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) {
    gh release create $tag --repo $repository --title 'Silksong atlas data 007' --notes 'Incremental map navigation and enriched room metadata for the hosted Silksong room atlas.'
    if ($LASTEXITCODE -ne 0) { throw "Could not create GitHub release $tag." }
}

for ($offset = 0; $offset -lt $files.Count; $offset += 35) {
    $end = [Math]::Min($offset + 35, $files.Count)
    $batch = @($files.GetRange($offset, $end - $offset))
    & gh release upload $tag @batch --repo $repository --clobber
    if ($LASTEXITCODE -ne 0) { throw "Upload failed for delta files $($offset + 1)-$end of $($files.Count)." }
    Write-Output "Uploaded release assets $($offset + 1)-$end of $($files.Count)."
}

foreach ($relative in $changed) {
    $key = ([string]$relative).Replace('\', '/')
    $name = [IO.Path]::GetFileName($key)
    $releaseIndex.assets | Add-Member -NotePropertyName $key -NotePropertyValue ([pscustomobject]@{ tag = $tag; name = $name }) -Force
}
$assetProperties = @($releaseIndex.assets.PSObject.Properties)
$releaseIndex.assetCount = $assetProperties.Count
$releaseIndex.releaseCount = @($assetProperties | ForEach-Object { [string]$_.Value.tag } | Sort-Object -Unique).Count
$json = ConvertTo-Json -InputObject $releaseIndex -Depth 12
[IO.File]::WriteAllText([IO.Path]::GetFullPath($ReleaseIndexPath), $json, [Text.UTF8Encoding]::new($false))
Write-Output "Updated $ReleaseIndexPath to use $tag for $($changed.Count) changed assets."
