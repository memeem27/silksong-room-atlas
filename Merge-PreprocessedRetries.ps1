param(
    [string]$Workspace = (Join-Path $PSScriptRoot 'workspace\preprocessed'),
    [string]$RetryManifest = 'manifest-retry.json'
)

$Workspace = [System.IO.Path]::GetFullPath($Workspace)
$manifestPath = Join-Path $Workspace 'manifest.json'
$retryPath = Join-Path $Workspace $RetryManifest
if (-not (Test-Path -LiteralPath $manifestPath)) { throw "Base manifest not found: $manifestPath" }
if (-not (Test-Path -LiteralPath $retryPath)) { throw "Retry manifest not found: $retryPath" }

$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$retry = Get-Content -LiteralPath $retryPath -Raw | ConvertFrom-Json
if (-not $manifest.complete) { throw 'The base scene pass must be complete before retries are merged.' }
if (-not $retry.complete -or $retry.canceled) { throw 'The retry pass is incomplete or canceled.' }
if (-not $manifest.rooms -or -not $retry.rooms) { throw 'A manifest has no room entries.' }

$roomIndexes = @{}
for ($index = 0; $index -lt $manifest.rooms.Count; $index++) {
    $roomName = [string]$manifest.rooms[$index].name
    if ($roomIndexes.ContainsKey($roomName)) { throw "Duplicate room in base manifest: $roomName" }
    $roomIndexes[$roomName] = $index
}

$replacedNames = @()
foreach ($room in $retry.rooms) {
    $name = [string]$room.name
    if (-not $roomIndexes.ContainsKey($name)) { throw "Retry room is not in the base manifest: $name" }
    $retryMetadataPath = [string]$room.metadata
    if (-not $retryMetadataPath -or -not (Test-Path -LiteralPath (Join-Path $Workspace $retryMetadataPath))) {
        throw "Retry room metadata is missing for $name."
    }
    $retryImagePath = [string]$room.image
    if ($retryImagePath -and -not (Test-Path -LiteralPath (Join-Path $Workspace $retryImagePath))) {
        throw "Retry PNG is missing for $name."
    }
    $retryPreviewPath = [string]$room.previewImage
    if ($retryPreviewPath -and -not (Test-Path -LiteralPath (Join-Path $Workspace $retryPreviewPath))) {
        throw "Retry preview PNG is missing for $name."
    }

    $index = [int]$roomIndexes[$name]
    $previousRoom = $manifest.rooms[$index]
    $retryMetadataFile = Join-Path $Workspace $retryMetadataPath
    $newMetadata = Get-Content -LiteralPath $retryMetadataFile -Raw | ConvertFrom-Json
    $previousMetadata = $null
    if ($previousRoom.metadata) {
        $previousMetadataPath = Join-Path $Workspace ([string]$previousRoom.metadata)
        if (Test-Path -LiteralPath $previousMetadataPath) {
            $previousMetadata = Get-Content -LiteralPath $previousMetadataPath -Raw | ConvertFrom-Json
        }
    }

    # Retry renders are staged as *-native files. Promote them to the room's
    # stable filenames only after validating every input, then point the
    # canonical manifest and metadata at those promoted files.
    $canonicalMetadata = if ($previousRoom.metadata) { [string]$previousRoom.metadata } else { "rooms/$name.json" }
    if ($retryImagePath) {
        $canonicalImage = if ($previousRoom.image) { [string]$previousRoom.image } else { $retryImagePath -replace '-native(?=\.png$)', '' }
        $sourceImage = Join-Path $Workspace $retryImagePath
        $destinationImage = Join-Path $Workspace $canonicalImage
        if (-not [string]::Equals([IO.Path]::GetFullPath($sourceImage), [IO.Path]::GetFullPath($destinationImage), [StringComparison]::OrdinalIgnoreCase)) {
            Move-Item -LiteralPath $sourceImage -Destination $destinationImage -Force
        }
        $room.image = $canonicalImage
    }
    if ($retryPreviewPath) {
        $canonicalPreview = if ($previousRoom.previewImage) { [string]$previousRoom.previewImage } else { $retryPreviewPath -replace '-native-preview(?=\.[^.]+$)', '-preview' -replace '-native(?=\.[^.]+$)', '' }
        $sourcePreview = Join-Path $Workspace $retryPreviewPath
        $destinationPreview = Join-Path $Workspace $canonicalPreview
        if (-not [string]::Equals([IO.Path]::GetFullPath($sourcePreview), [IO.Path]::GetFullPath($destinationPreview), [StringComparison]::OrdinalIgnoreCase)) {
            Move-Item -LiteralPath $sourcePreview -Destination $destinationPreview -Force
        }
        $room.previewImage = $canonicalPreview
    } else {
        if (-not $room.PSObject.Properties['previewImage']) {
            $room | Add-Member -NotePropertyName previewImage -NotePropertyValue $null
        } else {
            $room.previewImage = $null
        }
    }

    # A retry page may not have Architect's folder handle. Preserve the old
    # serialized mod records, then recalculate their image pixels for the new
    # native-resolution canvas before replacing the canonical sidecar.
    if (-not $newMetadata.architect -and $previousMetadata?.architect) {
        if ($newMetadata.PSObject.Properties['architect']) { $newMetadata.architect = $previousMetadata.architect }
        else { $newMetadata | Add-Member -NotePropertyName architect -NotePropertyValue $previousMetadata.architect }
        $architect = $newMetadata.architect
        if ($newMetadata.image) {
            $ppu = [double]$newMetadata.image.pixelsPerWorldUnit
            $bounds = $newMetadata.image.bounds
            foreach ($record in @($architect.markers) + @($architect.placements)) {
                $position = $record.worldPosition
                if ($position -and $bounds -and $ppu -gt 0) {
                    $record.imagePixel = [pscustomobject]@{
                        x = 2 + ([double]$position.x - [double]$bounds.minX) * $ppu
                        y = 2 + ([double]$bounds.maxY - [double]$position.y) * $ppu
                    }
                }
            }
        }
    }

    if ($newMetadata.image) {
        $newMetadata.image.file = [string]$room.image
        $newMetadata.image.previewFile = if ($room.previewImage) { [string]$room.previewImage } else { [string]$room.image }
    }
    $room.metadata = $canonicalMetadata
    $canonicalMetadataPath = Join-Path $Workspace $canonicalMetadata
    $temporaryMetadataPath = "$canonicalMetadataPath.$([Guid]::NewGuid().ToString('N')).tmp"
    try {
        [System.IO.File]::WriteAllText($temporaryMetadataPath,
            (ConvertTo-Json -InputObject $newMetadata -Depth 100 -Compress),
            [System.Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporaryMetadataPath -Destination $canonicalMetadataPath -Force
    } finally {
        if (Test-Path -LiteralPath $temporaryMetadataPath) { Remove-Item -LiteralPath $temporaryMetadataPath -Force }
    }
    if (-not [string]::Equals([IO.Path]::GetFullPath($retryMetadataFile), [IO.Path]::GetFullPath($canonicalMetadataPath), [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $retryMetadataFile -Force
    }

    $manifest.rooms[$index] = $room
    $replacedNames += $name
}

$counts = [ordered]@{}
foreach ($group in ($manifest.rooms | Group-Object -Property status)) { $counts[$group.Name] = $group.Count }
$manifest.counts = $counts
$manifest.renderProfile.png = 'transparent RGBA at native bundle texture density; oversized rooms are tiled and a smaller preview is included for the reader'
$manifest.processedSceneCount = $manifest.rooms.Count
$manifest.unprocessedSceneCount = [Math]::Max(0, [int]$manifest.requestedSceneCount - $manifest.rooms.Count)
$manifest.createdAt = [DateTimeOffset]::UtcNow.ToString('o')
$retryMergeInfo = [ordered]@{
    source = [System.IO.Path]::GetFileName($retryPath)
    mergedAt = [DateTimeOffset]::UtcNow.ToString('o')
    roomNames = @($replacedNames)
}
if ($manifest.PSObject.Properties['retryMerge']) { $manifest.retryMerge = $retryMergeInfo }
else { $manifest | Add-Member -NotePropertyName retryMerge -NotePropertyValue $retryMergeInfo }

$tempPath = "$manifestPath.$([Guid]::NewGuid().ToString('N')).tmp"
$manifest | ConvertTo-Json -Depth 100 -Compress | Set-Content -LiteralPath $tempPath -Encoding utf8
Move-Item -LiteralPath $tempPath -Destination $manifestPath -Force
Write-Host "Merged $($replacedNames.Count) retry room(s): $($replacedNames -join ', ')."
Write-Host "Atlas manifest: $manifestPath"
