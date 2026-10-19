param(
    [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')][string]$Repository,
    [string]$DataDirectory = (Join-Path $PSScriptRoot 'HostedAtlas\r2-data'),
    [string]$ReleasePrefix = 'silksong-atlas-data',
    [ValidateRange(1, 1000)][int]$AssetsPerRelease = 900,
    [ValidateRange(1, 100)][int]$UploadBatchSize = 25,
    [switch]$Resume
)

$ErrorActionPreference = 'Stop'
$dataRoot = [IO.Path]::GetFullPath($DataDirectory)
if (-not (Test-Path -LiteralPath $dataRoot)) { throw "Hosted atlas data package not found: $dataRoot" }

$statusPath = Join-Path $PSScriptRoot 'HostedAtlas\DATA-EXPORT-STATUS.txt'
if (-not (Test-Path -LiteralPath $statusPath) -or (Get-Content -LiteralPath $statusPath -Raw) -notmatch '^Silksong GauntletSong Atlas data export completed') {
    throw 'The export is incomplete. Finish Build-HostedAtlas.ps1 before uploading.'
}
$auditPath = Join-Path $PSScriptRoot 'HostedAtlas\AUDIT-REPORT.json'
if (-not (Test-Path -LiteralPath $auditPath)) { throw 'Run Audit-HostedAtlas.ps1 successfully before uploading.' }
$audit = Get-Content -LiteralPath $auditPath -Raw | ConvertFrom-Json
if ($audit.status -ne 'passed') { throw "The latest hosted atlas audit did not pass: $($audit.status)." }

if ($ReleasePrefix -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$') { throw 'ReleasePrefix may contain only letters, digits, dots, underscores, and hyphens.' }
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw 'Install GitHub CLI (gh) and sign in before uploading release assets.' }
$null = & gh auth status --hostname github.com 2>&1
if ($LASTEXITCODE -ne 0) { throw 'GitHub CLI is not signed in. Run gh auth login, then retry.' }
$visibility = (& gh repo view $Repository --json visibility --jq .visibility 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) { throw "Could not read GitHub repository '$Repository': $visibility" }
if ($visibility -ne 'PUBLIC') { throw 'The repository must be public so the wiki viewer can read release data without credentials.' }

$files = @(Get-ChildItem -LiteralPath $dataRoot -Recurse -File | Sort-Object { $_.FullName.Substring($dataRoot.Length + 1).Replace('\', '/') })
if (-not $files.Count) { throw 'The R2 data package is empty.' }
$maxReleaseAssetBytes = [int64]2GB
$assetMap = [ordered]@{}
$groups = [Collections.Generic.List[object]]::new()
for ($index = 0; $index -lt $files.Count; $index++) {
    $file = $files[$index]
    if ($file.Length -ge $maxReleaseAssetBytes) { throw "GitHub Releases requires files under 2 GiB; '$($file.Name)' is $($file.Length) bytes." }
    $relative = $file.FullName.Substring($dataRoot.Length + 1).Replace('\', '/')
    $assetName = $file.Name
    $groupIndex = [int][Math]::Floor($index / $AssetsPerRelease)
    $tag = '{0}-{1:D3}' -f $ReleasePrefix, ($groupIndex + 1)
    if ($groupIndex -ge $groups.Count) {
        $groups.Add([pscustomobject]@{
            Tag = $tag
            Assets = [Collections.Generic.List[object]]::new()
            AssetNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        })
    }
    if (-not $groups[$groupIndex].AssetNames.Add($assetName)) {
        throw "Two files in release group $($groupIndex + 1) have the same basename '$assetName'; rename or regroup them before upload."
    }
    $groups[$groupIndex].Assets.Add([pscustomobject]@{ Path = $relative; FullName = $file.FullName; AssetName = $assetName })
    $assetMap[$relative] = [pscustomobject]@{ tag = $tag; name = $assetName }
}

$existingJson = (& gh release list --repo $Repository --json tagName --limit 1000 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0) { throw "Could not list existing releases: $existingJson" }
$existingTags = @($existingJson | ConvertFrom-Json | ForEach-Object { $_.tagName })
$conflicts = @($groups | Where-Object { $_.Tag -in $existingTags })
if ($conflicts.Count -and -not $Resume) { throw "Release tag '$($conflicts[0].Tag)' already exists. Use -Resume to continue this package without re-uploading existing assets, or choose a new ReleasePrefix for a different package." }

$siteRoot = Join-Path $PSScriptRoot 'HostedAtlas\site'
$mapPath = Join-Path $siteRoot 'release-assets.json'
$temporaryMap = $mapPath + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
$releaseMap = [ordered]@{
    schemaVersion = 1
    repository = $Repository
    assetCount = $files.Count
    releaseCount = $groups.Count
    assets = $assetMap
}
$json = ConvertTo-Json -InputObject $releaseMap -Depth 6
[IO.File]::WriteAllText($temporaryMap, $json, [Text.UTF8Encoding]::new($false))

Write-Output ("Uploading {0} audited package files to public GitHub repository {1} in {2} releases." -f $files.Count, $Repository, $groups.Count)
try {
    for ($groupIndex = 0; $groupIndex -lt $groups.Count; $groupIndex++) {
        $group = $groups[$groupIndex]
        $title = 'Silksong atlas data {0}/{1}' -f ($groupIndex + 1), $groups.Count
        $uploadedNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        if ($group.Tag -in $existingTags) {
            if (-not $Resume) { throw "Release '$($group.Tag)' already exists. Re-run with -Resume to continue safely." }
            $releaseJson = (& gh release view $group.Tag --repo $Repository --json name,assets 2>&1 | Out-String)
            if ($LASTEXITCODE -ne 0) { throw "Could not inspect existing release '$($group.Tag)': $releaseJson" }
            $release = $releaseJson | ConvertFrom-Json
            if ($release.name -ne $title) { throw "Existing tag '$($group.Tag)' belongs to a different release ('$($release.name)'). Refusing to add atlas data to it." }
            foreach ($existingAsset in $release.assets) { [void]$uploadedNames.Add($existingAsset.name) }
            Write-Output ("Resuming release {0}/{1}: {2} already has {3} assets." -f ($groupIndex + 1), $groups.Count, $group.Tag, $uploadedNames.Count)
        } else {
            & gh release create $group.Tag --repo $Repository --title $title --notes 'Pre-rendered game-derived room images and compressed metadata for the Silksong Room Atlas.'
            if ($LASTEXITCODE -ne 0) { throw "Could not create release '$($group.Tag)'." }
        }

        $pendingAssets = @($group.Assets | Where-Object { -not $uploadedNames.Contains($_.AssetName) })
        for ($start = 0; $start -lt $pendingAssets.Count; $start += $UploadBatchSize) {
            $end = [Math]::Min($start + $UploadBatchSize, $pendingAssets.Count)
            $arguments = [Collections.Generic.List[string]]::new()
            $arguments.Add('release'); $arguments.Add('upload'); $arguments.Add($group.Tag)
            for ($index = $start; $index -lt $end; $index++) {
                $asset = $pendingAssets[$index]
                $arguments.Add($asset.FullName)
            }
            $arguments.Add('--repo'); $arguments.Add($Repository)
            & gh @arguments
            if ($LASTEXITCODE -ne 0) { throw "Upload failed for release '$($group.Tag)' near pending asset $($start + 1). Existing uploads are retained; wait for GitHub's rate limit to clear, then rerun with -Resume." }
            $uploaded = $uploadedNames.Count + $end
            Write-Progress -Activity 'Uploading Silksong atlas data to GitHub Releases' -Status "$($group.Tag): $uploaded / $($group.Assets.Count)" -PercentComplete (($uploaded / $group.Assets.Count) * 100)
        }
        Write-Progress -Activity 'Uploading Silksong atlas data to GitHub Releases' -Completed
        Write-Output ("Uploaded release {0}/{1}: {2} ({3} files)." -f ($groupIndex + 1), $groups.Count, $group.Tag, $group.Assets.Count)
    }
    Move-Item -LiteralPath $temporaryMap -Destination $mapPath -Force
    Write-Output "Release mapping saved to $mapPath. Deploy HostedAtlas/site with wrangler.github.toml so Pages can proxy the public release files."
} catch {
    Remove-Item -LiteralPath $temporaryMap -Force -ErrorAction SilentlyContinue
    throw
}
