param(
    [string]$Workspace = (Join-Path $PSScriptRoot 'workspace\preprocessed'),
    [string]$RetryManifest = 'manifest-retry.json',
    [switch]$UsePreviewAsCanonicalImage
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
for ($retryIndex = 0; $retryIndex -lt $retry.rooms.Count; $retryIndex++) {
    $room = $retry.rooms[$retryIndex]
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
    if ($UsePreviewAsCanonicalImage -and $room.status -ne 'no-artwork' -and -not $retryPreviewPath -and -not $retryImagePath) {
        throw "A retry PNG is required to promote a canonical room image for $name."
    }

    $index = [int]$roomIndexes[$name]
    $previousRoom = $manifest.rooms[$index]
    $retryMetadataFile = Join-Path $Workspace $retryMetadataPath
    $newMetadata = Get-Content -LiteralPath $retryMetadataFile -Raw | ConvertFrom-Json
    $previousMetadata = $null
    $previousImage = $null
    $previousArchitect = $null
    if ($previousRoom.metadata) {
        $previousMetadataPath = Join-Path $Workspace ([string]$previousRoom.metadata)
        if (Test-Path -LiteralPath $previousMetadataPath) {
            $previousMetadata = Get-Content -LiteralPath $previousMetadataPath -Raw | ConvertFrom-Json
            if ($previousMetadata.PSObject.Properties['image']) { $previousImage = $previousMetadata.image }
            if ($previousMetadata.PSObject.Properties['architect']) { $previousArchitect = $previousMetadata.architect }
        }
    }

    if ($UsePreviewAsCanonicalImage -and $retryPreviewPath) {
        $image = $newMetadata.image
        if (-not $image -or [double]$image.previewPixelsPerWorldUnit -le 0 -or
            [int]$image.previewWidth -le 0 -or [int]$image.previewHeight -le 0) {
            throw "Retry metadata has no valid preview dimensions for $name."
        }
        $image.width = [int]$image.previewWidth
        $image.height = [int]$image.previewHeight
        $image.pixelsPerWorldUnit = [double]$image.previewPixelsPerWorldUnit
        if ($image.PSObject.Properties['resolutionLimited']) { $image.resolutionLimited = $true }
        else { $image | Add-Member -NotePropertyName resolutionLimited -NotePropertyValue $true }
        foreach ($propertyName in @('previewWidth', 'previewHeight', 'previewPixelsPerWorldUnit', 'previewResolutionLimited')) {
            $image.PSObject.Properties.Remove($propertyName)
        }
    }

    # Retry renders are staged as *-native files. Promote them to the room's
    # stable filenames only after validating every input, then point the
    # canonical manifest and metadata at those promoted files.
    $canonicalMetadata = if ($previousRoom.metadata) { [string]$previousRoom.metadata } else { "rooms/$name.json" }
    if ($UsePreviewAsCanonicalImage -and ($retryPreviewPath -or $retryImagePath)) {
        $canonicalImage = if ($previousRoom.image) { [string]$previousRoom.image }
            elseif ($retryImagePath) { $retryImagePath -replace '-(?:native|node|clean|plain|smoke)(?=\.png$)', '' }
            else { $retryPreviewPath -replace '-(?:native|node|clean|plain|smoke)-preview(?=\.[^.]+$)', '' }
        $canonicalSource = if ($retryPreviewPath) { $retryPreviewPath } else { $retryImagePath }
        $sourceImage = Join-Path $Workspace $canonicalSource
        $destinationImage = Join-Path $Workspace $canonicalImage
        if (-not [string]::Equals([IO.Path]::GetFullPath($sourceImage), [IO.Path]::GetFullPath($destinationImage), [StringComparison]::OrdinalIgnoreCase)) {
            Move-Item -LiteralPath $sourceImage -Destination $destinationImage -Force
        }
        $room.image = $canonicalImage
        if ($retryPreviewPath -and $retryImagePath) {
            if ($room.PSObject.Properties['nativeImage']) { $room.nativeImage = $retryImagePath }
            else { $room | Add-Member -NotePropertyName nativeImage -NotePropertyValue $retryImagePath }
        } elseif ($room.PSObject.Properties['nativeImage']) {
            $room.PSObject.Properties.Remove('nativeImage')
        }
        if (-not $room.PSObject.Properties['previewImage']) {
            $room | Add-Member -NotePropertyName previewImage -NotePropertyValue $null
        } else {
            $room.previewImage = $null
        }
    } elseif ($UsePreviewAsCanonicalImage) {
        $room.image = $null
        if (-not $room.PSObject.Properties['previewImage']) {
            $room | Add-Member -NotePropertyName previewImage -NotePropertyValue $null
        } else {
            $room.previewImage = $null
        }
        if ($room.PSObject.Properties['nativeImage']) { $room.PSObject.Properties.Remove('nativeImage') }
    } else {
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
    }

    # A retry page may not have Architect's folder handle. Preserve the old
    # serialized mod records, then recalculate their image pixels for the new
    # native-resolution canvas before replacing the canonical sidecar.
    if (-not $newMetadata.architect -and $previousArchitect) {
        if ($newMetadata.PSObject.Properties['architect']) { $newMetadata.architect = $previousArchitect }
        else { $newMetadata | Add-Member -NotePropertyName architect -NotePropertyValue $previousArchitect }
        $architect = $newMetadata.architect
        if ($newMetadata.image) {
            $ppu = [double]$newMetadata.image.pixelsPerWorldUnit
            $bounds = $newMetadata.image.bounds
            foreach ($record in @($architect.markers) + @($architect.placements)) {
                $position = $record.worldPosition
                if ($position -and $bounds -and $ppu -gt 0) {
                    $imagePixel = [pscustomobject]@{
                        x = 2 + ([double]$position.x - [double]$bounds.minX) * $ppu
                        y = 2 + ([double]$bounds.maxY - [double]$position.y) * $ppu
                    }
                    if ($record.PSObject.Properties['imagePixel']) { $record.imagePixel = $imagePixel }
                    else { $record | Add-Member -NotePropertyName imagePixel -NotePropertyValue $imagePixel }
                }
            }
        }
    }

    # A full-room retry does not regenerate the separately baked camera
    # sections. Keep their metadata and manifest references so replacing a
    # room composite cannot silently remove the room-section menu.
    if (-not $retry.cameraSectionPass -and $previousImage -and $newMetadata.image) {
        foreach ($propertyName in @('cameraSections', 'cameraSectionRenderProfile')) {
            $previousProperty = $previousImage.PSObject.Properties[$propertyName]
            if (-not $previousProperty) { continue }
            if ($newMetadata.image.PSObject.Properties[$propertyName]) { $newMetadata.image.$propertyName = $previousProperty.Value }
            else { $newMetadata.image | Add-Member -NotePropertyName $propertyName -NotePropertyValue $previousProperty.Value }
        }
        if ($previousRoom.cameraViews) {
            if ($room.PSObject.Properties['cameraViews']) { $room.cameraViews = $previousRoom.cameraViews }
            else { $room | Add-Member -NotePropertyName cameraViews -NotePropertyValue $previousRoom.cameraViews }
        }
    }

    if ($newMetadata.image) {
        $imageFile = [string]$room.image
        $previewFile = if ($room.previewImage) { [string]$room.previewImage } else { [string]$room.image }
        if ($newMetadata.image.PSObject.Properties['file']) { $newMetadata.image.file = $imageFile }
        else { $newMetadata.image | Add-Member -NotePropertyName file -NotePropertyValue $imageFile }
        if ($newMetadata.image.PSObject.Properties['previewFile']) { $newMetadata.image.previewFile = $previewFile }
        else { $newMetadata.image | Add-Member -NotePropertyName previewFile -NotePropertyValue $previewFile }
        if ($UsePreviewAsCanonicalImage) {
            $previewFileProperty = $newMetadata.image.PSObject.Properties['previewFile']
            if ($previewFileProperty) { $previewFileProperty.Value = $imageFile }
        }
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
    $retry.rooms[$retryIndex] = $room
    $replacedNames += $name
}

$counts = [ordered]@{}
foreach ($group in ($manifest.rooms | Group-Object -Property status)) { $counts[$group.Name] = $group.Count }
if ($manifest.renderProfile) {
    # The retry pass may change which serialized renderers are baked into the
    # canonical room image. Keep the top-level manifest profile in sync with
    # the room sidecars instead of leaving the original active-only claim.
    if ($retry.renderProfile) {
        foreach ($propertyName in @(
            'gameBundleTexturesOnly', 'activeRenderersOnly', 'inactiveRenderersIncluded',
            'inactiveArtworkClippedToActiveBounds', 'disabledRenderersIncluded',
            'normalWorldBranchesIncluded', 'screenEffectsIncluded', 'rendererColorsApplied',
            'backgroundArtworkIncluded', 'lightingRendererArtworkIncluded',
            'shaderDrivenLightingIncluded', 'runtimeLightingSimulation',
            'viewerAnnotations', 'architectModAssets', 'architectPlacementMetadataIncluded'
        )) {
            $retryProperty = $retry.renderProfile.PSObject.Properties[$propertyName]
            if (-not $retryProperty) { continue }
            $manifestProperty = $manifest.renderProfile.PSObject.Properties[$propertyName]
            if ($propertyName -eq 'architectPlacementMetadataIncluded' -and $manifestProperty -and
                [bool]$manifestProperty.Value -and -not [bool]$retryProperty.Value) {
                continue
            }
            if ($manifestProperty) { $manifest.renderProfile.$propertyName = $retryProperty.Value }
            else { $manifest.renderProfile | Add-Member -NotePropertyName $propertyName -NotePropertyValue $retryProperty.Value }
        }
    }
    $profilePng = if ($UsePreviewAsCanonicalImage) {
        'browser-sized transparent RGBA room previews are canonical; native-resolution tiled PNGs remain staged separately as *-native files'
    } else {
        'transparent RGBA at native bundle texture density; oversized rooms are tiled and a smaller preview is included for the reader'
    }
    if ($manifest.renderProfile.PSObject.Properties['png']) { $manifest.renderProfile.png = $profilePng }
    else { $manifest.renderProfile | Add-Member -NotePropertyName png -NotePropertyValue $profilePng }
}
foreach ($property in @(
    @{ Name = 'counts'; Value = $counts },
    @{ Name = 'processedSceneCount'; Value = $manifest.rooms.Count },
    @{ Name = 'unprocessedSceneCount'; Value = [Math]::Max(0, [int]$manifest.requestedSceneCount - $manifest.rooms.Count) },
    @{ Name = 'createdAt'; Value = [DateTimeOffset]::UtcNow.ToString('o') }
)) {
    if ($manifest.PSObject.Properties[$property.Name]) { $manifest.($property.Name) = $property.Value }
    else { $manifest | Add-Member -NotePropertyName $property.Name -NotePropertyValue $property.Value }
}
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
$retryTempPath = "$retryPath.$([Guid]::NewGuid().ToString('N')).tmp"
try {
    [System.IO.File]::WriteAllText($retryTempPath,
        (ConvertTo-Json -InputObject $retry -Depth 100 -Compress),
        [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $retryTempPath -Destination $retryPath -Force
} finally {
    if (Test-Path -LiteralPath $retryTempPath) { Remove-Item -LiteralPath $retryTempPath -Force }
}
Write-Host "Merged $($replacedNames.Count) retry room(s): $($replacedNames -join ', ')."
Write-Host "Atlas manifest: $manifestPath"
