param(
    [string]$DeltaPath = (Join-Path $PSScriptRoot 'HostedAtlas\delta-assets.json'),
    [string]$ReleaseIndexPath = (Join-Path $PSScriptRoot 'HostedAtlas\site\release-assets.json'),
    [string]$ReleaseNotes = 'Incremental hosted atlas data update.'
)

$ErrorActionPreference = 'Stop'
$delta = Get-Content -LiteralPath $DeltaPath -Raw | ConvertFrom-Json
$releaseIndex = [IO.File]::ReadAllText($ReleaseIndexPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
$repository = [string]$delta.repository
$tag = [string]$delta.releaseTag
$dataRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'HostedAtlas\r2-data'))
if (-not $repository -or -not $tag -or $tag -notmatch '^silksong-atlas-data-v2-[0-9]{3}$') { throw 'Delta package repository or release tag is invalid.' }
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

function Invoke-GhQuietly([string[]]$Arguments) {
    $previousPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & gh @Arguments 2>$null | Out-Null
        return [int]$LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousPreference
    }
}

gh auth status | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'GitHub CLI authentication is unavailable.' }
$releaseViewExit = Invoke-GhQuietly -Arguments @('release', 'view', $tag, '--repo', $repository)
if ($releaseViewExit -ne 0) {
    $createExit = Invoke-GhQuietly -Arguments @('release', 'create', $tag, '--repo', $repository, '--title', $tag, '--notes', $ReleaseNotes)
    if ($createExit -ne 0) { throw "Could not create GitHub release $tag." }
}

for ($offset = 0; $offset -lt $files.Count; $offset += 35) {
    $end = [Math]::Min($offset + 35, $files.Count)
    $batch = @($files.GetRange($offset, $end - $offset))
    $uploadArguments = @('release', 'upload', $tag) + $batch + @('--repo', $repository, '--clobber')
    $uploadExit = Invoke-GhQuietly -Arguments $uploadArguments
    if ($uploadExit -ne 0) { throw "Upload failed for delta files $($offset + 1)-$end of $($files.Count)." }
    Write-Output "Uploaded release assets $($offset + 1)-$end of $($files.Count)."
}

foreach ($relative in $changed) {
    $key = ([string]$relative).Replace('\', '/')
    $name = [IO.Path]::GetFileName($key)
    $entry = [pscustomobject]@{ tag = $tag; name = $name }
    $existingAsset = $releaseIndex.assets.PSObject.Properties[$key]
    if ($existingAsset) { $existingAsset.Value = $entry }
    else { $releaseIndex.assets | Add-Member -NotePropertyName $key -NotePropertyValue $entry }
}
foreach ($relative in @($delta.removedFiles)) {
    $key = ([string]$relative).Replace('\', '/')
    if ($key) { $releaseIndex.assets.PSObject.Properties.Remove($key) }
}
$assetProperties = @($releaseIndex.assets.PSObject.Properties)
$releaseIndex.assetCount = $assetProperties.Count
$releaseIndex.releaseCount = @($assetProperties | ForEach-Object { [string]$_.Value.tag } | Sort-Object -Unique).Count
$json = ConvertTo-Json -InputObject $releaseIndex -Depth 12
[IO.File]::WriteAllText([IO.Path]::GetFullPath($ReleaseIndexPath), $json, [Text.UTF8Encoding]::new($false))
Write-Output "Updated $ReleaseIndexPath to use $tag for $($changed.Count) changed assets."

$hostConfigPath = Join-Path $PSScriptRoot 'HostedAtlas\site\host-config.js'
$hostConfig = [IO.File]::ReadAllText($hostConfigPath, [Text.Encoding]::UTF8)
$versionLine = "window.SILKSONG_ATLAS_DATA_VERSION = '$tag';"
if ($hostConfig -match '(?m)^window\.SILKSONG_ATLAS_DATA_VERSION\s*=') {
    $hostConfig = [regex]::Replace($hostConfig, '(?m)^window\.SILKSONG_ATLAS_DATA_VERSION\s*=\s*[^;]+;', $versionLine)
} else {
    $hostConfig = $hostConfig.TrimEnd() + "`n$versionLine`n"
}
[IO.File]::WriteAllText([IO.Path]::GetFullPath($hostConfigPath), $hostConfig, [Text.UTF8Encoding]::new($false))
Write-Output "Updated hosted data cache-buster in $hostConfigPath to $tag."

$indexPath = Join-Path $PSScriptRoot 'HostedAtlas\site\index.html'
$indexHtml = [IO.File]::ReadAllText($indexPath, [Text.Encoding]::UTF8)
$versionedConfig = "./host-config.js?v=$tag"
if ($indexHtml -notmatch '(?m)host-config\.js') { throw "The host-config.js script tag was not found in $indexPath." }
$indexHtml = [regex]::Replace($indexHtml, '(<script src=")([.]/host-config\.js)(?:\?v=[^"]*)?("></script>)', ('$1' + $versionedConfig + '$3'))
[IO.File]::WriteAllText([IO.Path]::GetFullPath($indexPath), $indexHtml, [Text.UTF8Encoding]::new($false))
Write-Output "Updated host-config script URL in $indexPath to $tag."

$indexTemporaryPath = [IO.Path]::GetTempFileName()
try {
    $compactJson = ConvertTo-Json -InputObject $releaseIndex -Depth 12 -Compress
    [IO.File]::WriteAllText($indexTemporaryPath, $compactJson, [Text.UTF8Encoding]::new($false))
    $nodeScript = "const fs=require('node:fs');const source=process.argv[1];const target=process.argv[2];const data=JSON.parse(fs.readFileSync(source,'utf8'));fs.writeFileSync(target,JSON.stringify(data,null,2)+'\n');"
    & node -e $nodeScript $indexTemporaryPath ([IO.Path]::GetFullPath($ReleaseIndexPath))
    if ($LASTEXITCODE -ne 0) { throw 'Could not serialize the hosted release index.' }
} finally {
    Remove-Item -LiteralPath $indexTemporaryPath -Force -ErrorAction SilentlyContinue
}
