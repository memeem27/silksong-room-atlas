param(
    [string]$Workspace = (Join-Path $PSScriptRoot 'workspace\preprocessed'),
    [string]$BaseUrl = 'http://127.0.0.1:5180',
    [string[]]$Room,
    [switch]$AllowIncomplete
)

$ErrorActionPreference = 'Stop'
$Workspace = [System.IO.Path]::GetFullPath($Workspace)
$manifestPath = Join-Path $Workspace 'manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "Missing preprocessed manifest: $manifestPath" }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if (-not $manifest.complete -and -not $AllowIncomplete) {
    throw 'The preprocessed room pass is not complete. Use -AllowIncomplete only for a targeted repair.'
}

$entries = @($manifest.rooms)
if ($Room -and $Room.Count -gt 0) {
    $wanted = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($name in $Room) { [void]$wanted.Add($name) }
    $entries = @($entries | Where-Object { $wanted.Contains($_.name) })
    $missing = @($Room | Where-Object { $_ -notin $entries.name })
    if ($missing.Count -gt 0) { throw "Rooms are not in the manifest: $($missing -join ', ')" }
}

function Normalize-EnemyId([string]$Value) {
    $valueWithoutPrefix = $Value -replace '^prefab_', ''
    return ($valueWithoutPrefix.ToLowerInvariant() -replace '[^a-z0-9]', '')
}

$metadataPaths = [System.Collections.Generic.List[string]]::new()
$idsByKey = [ordered]@{}
foreach ($entry in $entries) {
    if (-not $entry.metadata) { continue }
    $path = Join-Path $Workspace $entry.metadata
    if (-not (Test-Path -LiteralPath $path)) { throw "Missing room sidecar: $($entry.name)" }
    $metadata = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    $metadataPaths.Add($path)
    foreach ($record in @($metadata.architect.placements)) {
        if (-not $record.enemyCandidate) { continue }
        $id = [string]$record.placement.id
        $key = Normalize-EnemyId $id
        if ($key.Length -ge 5 -and -not $idsByKey.Contains($key)) { $idsByKey[$key] = $id }
    }
}

$artworkByKey = @{}
$ids = @($idsByKey.Values)
for ($offset = 0; $offset -lt $ids.Count; $offset += 150) {
    $end = [Math]::Min($offset + 150, $ids.Count)
    $batch = @($ids[$offset..($end - 1)])
    $body = @{ placementIds = $batch } | ConvertTo-Json -Compress
    $response = Invoke-RestMethod -Uri "$($BaseUrl.TrimEnd('/'))/api/enemy-artwork" -Method Post `
        -ContentType 'application/json' -Body $body -TimeoutSec 180
    foreach ($key in @($response.artwork.PSObject.Properties.Name)) {
        $record = $response.artwork.$key
        $imageUrl = [string]$record.sprite.imageUrl
        $match = [regex]::Match($imageUrl, '^/api/artwork/([a-f0-9]{64})\.png$', 'IgnoreCase')
        if (-not $match.Success) { continue }
        $sprite = [ordered]@{}
        foreach ($property in $record.sprite.PSObject.Properties) {
            if ($property.Name -ne 'imageUrl') { $sprite[$property.Name] = $property.Value }
        }
        $sprite.textureSha256 = $match.Groups[1].Value.ToLowerInvariant()
        $normalized = Normalize-EnemyId $key
        $artworkByKey[$normalized] = [ordered]@{
            placementId = $idsByKey[$normalized]
            objectName = $record.objectName
            sourceBundle = $record.sourceBundle
            offsetX = $record.offsetX
            offsetY = $record.offsetY
            sprite = $sprite
        }
    }
}

$updatedRooms = 0
$addedMatches = 0
foreach ($path in $metadataPaths) {
    $metadata = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    if (-not $metadata.architect) { continue }
    if (-not $metadata.architect.enemyArtwork) {
        $metadata.architect | Add-Member -NotePropertyName enemyArtwork -NotePropertyValue ([pscustomobject]@{}) -Force
    }
    $changed = $false
    foreach ($placement in @($metadata.architect.placements)) {
        $placementId = [string]$placement.placement.id
        if ($placement.enemyCandidate -and $placementId -match 'enemy[\s_-]?(?:remover|clear)') {
            $placement.enemyCandidate = $false
            $changed = $true
        }
    }
    $roomIds = @($metadata.architect.placements | Where-Object { $_.enemyCandidate } |
        ForEach-Object { Normalize-EnemyId ([string]$_.placement.id) } | Select-Object -Unique)
    $added = 0
    foreach ($key in $roomIds) {
        if (-not $artworkByKey.ContainsKey($key)) { continue }
        if (-not $metadata.architect.enemyArtwork.PSObject.Properties[$key]) { $added++ }
        $metadata.architect.enemyArtwork | Add-Member -NotePropertyName $key -NotePropertyValue $artworkByKey[$key] -Force
        $changed = $true
    }
    $matched = @($roomIds | Where-Object { $metadata.architect.enemyArtwork.PSObject.Properties[$_] }).Count
    $lookup = [pscustomobject]@{ source = 'Silksong sprite atlases'; requestedEnemyTypes = $roomIds.Count;
        matchedEnemyTypes = $matched; unmatchedEnemyTypes = $roomIds.Count - $matched }
    if (-not $metadata.architect.enemyArtworkLookup -or
        $metadata.architect.enemyArtworkLookup.requestedEnemyTypes -ne $lookup.requestedEnemyTypes -or
        $metadata.architect.enemyArtworkLookup.matchedEnemyTypes -ne $lookup.matchedEnemyTypes) { $changed = $true }
    $metadata.architect | Add-Member -NotePropertyName enemyArtworkLookup -NotePropertyValue $lookup -Force
    if (-not $changed) { continue }
    $temporaryPath = "$path.$([Guid]::NewGuid().ToString('N')).tmp"
    try {
        $json = ConvertTo-Json -InputObject $metadata -Depth 100 -Compress
        [System.IO.File]::WriteAllText($temporaryPath, $json, [System.Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporaryPath -Destination $path -Force
    } finally {
        if (Test-Path -LiteralPath $temporaryPath) { Remove-Item -LiteralPath $temporaryPath -Force }
    }
    $updatedRooms++
    $addedMatches += $added
}

Write-Output "Queried $($ids.Count) enemy types; matched $($artworkByKey.Count) to Silksong sprites; added $addedMatches room-sidecar matches across $updatedRooms rooms."
