param(
    [string]$DataDirectory = (Join-Path $PSScriptRoot 'HostedAtlas\r2-data'),
    [string]$ReportPath = (Join-Path $PSScriptRoot 'HostedAtlas\AUDIT-REPORT.json')
)

$ErrorActionPreference = 'Stop'
$dataRoot = [IO.Path]::GetFullPath($DataDirectory)
if (-not (Test-Path -LiteralPath $dataRoot)) { throw "Hosted atlas data is missing: $dataRoot" }

function Read-GzipJson([string]$Path) {
    $file = [IO.File]::OpenRead($Path)
    try {
        $gzip = [IO.Compression.GZipStream]::new($file, [IO.Compression.CompressionMode]::Decompress)
        try {
            $reader = [IO.StreamReader]::new($gzip, [Text.Encoding]::UTF8)
            try { return (ConvertFrom-Json -InputObject $reader.ReadToEnd()) }
            finally { $reader.Dispose() }
        } finally { $gzip.Dispose() }
    } finally { $file.Dispose() }
}

function Test-LosslessWebp([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    try {
        $header = New-Object byte[] 12
        if ($stream.Read($header, 0, $header.Length) -ne $header.Length) { return $false }
        if ([Text.Encoding]::ASCII.GetString($header, 0, 4) -ne 'RIFF' -or [Text.Encoding]::ASCII.GetString($header, 8, 4) -ne 'WEBP') { return $false }
        $riffEnd = [math]::Min([int64]$stream.Length, [int64]([BitConverter]::ToUInt32($header, 4) + 8))
        while ($stream.Position + 8 -le $riffEnd) {
            $chunk = New-Object byte[] 8
            if ($stream.Read($chunk, 0, $chunk.Length) -ne $chunk.Length) { return $false }
            $chunkType = [Text.Encoding]::ASCII.GetString($chunk, 0, 4)
            $chunkLength = [int64][BitConverter]::ToUInt32($chunk, 4)
            if ($chunkType -eq 'VP8L') { return $chunkLength -ge 5 }
            if ($chunkType -eq 'VP8 ') { return $false }
            $nextPosition = $stream.Position + $chunkLength + ($chunkLength % 2)
            if ($nextPosition -gt $riffEnd) { return $false }
            $stream.Position = $nextPosition
        }
        return $false
    } finally { $stream.Dispose() }
}

function Get-Sha256([string]$Path) {
    $sha = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($Path)
    try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $sha.Dispose() }
}

$manifestPath = Join-Path $dataRoot 'manifest.json.gz'
$manifest = Read-GzipJson $manifestPath
$navigation = Read-GzipJson (Join-Path (Join-Path $dataRoot 'maps') 'navigation.json.gz')
$assetIndex = Read-GzipJson (Join-Path $dataRoot 'asset-index.json.gz')

$missingImages = [Collections.Generic.List[string]]::new()
$missingSidecars = [Collections.Generic.List[string]]::new()
$issues = [Collections.Generic.List[string]]::new()
$roomPreviewCount = 0
$roomImageCount = 0
$cameraViewCount = 0
$cameraRoomCount = 0
$cappedCameraViewCount = 0
$cameraViewImageCount = 0
$cameraViewImagesIncluded = $true
if ($null -ne $manifest.cameraViewImagesIncluded) { $cameraViewImagesIncluded = [bool]$manifest.cameraViewImagesIncluded }
$cameraFallbackRooms = @($manifest.cameraSectionSummary.fullSceneFallbackRooms)
foreach ($room in $manifest.rooms) {
    $metadataPath = Join-Path $dataRoot ($room.metadata + '.gz')
    if (-not (Test-Path -LiteralPath $metadataPath)) { $missingSidecars.Add($room.metadata + '.gz') }
    if ($room.image) {
        $roomImageCount++
        $imagePath = Join-Path $dataRoot ([string]$room.image)
        if (-not (Test-Path -LiteralPath $imagePath) -or (Get-Item -LiteralPath $imagePath).Length -eq 0) { $missingImages.Add([string]$room.image) }
    }
    if ($room.previewImage -and $room.previewImage -ne $room.image) {
        $roomPreviewCount++
        $previewPath = Join-Path $dataRoot ([string]$room.previewImage)
        if (-not (Test-Path -LiteralPath $previewPath) -or (Get-Item -LiteralPath $previewPath).Length -eq 0) { $missingImages.Add([string]$room.previewImage) }
    }
    $roomCameraViews = @()
    if ($null -ne $room.cameraViews) { $roomCameraViews = @($room.cameraViews | Where-Object { $null -ne $_ }) }
    if ($roomCameraViews.Count) { $cameraRoomCount++ }
    foreach ($view in $roomCameraViews) {
        $cameraViewCount++
        if ($view.resolutionLimited) { $cappedCameraViewCount++ }
        if ($view.file) {
            $cameraViewImageCount++
            $cameraPath = Join-Path $dataRoot ([string]$view.file)
            if (-not (Test-Path -LiteralPath $cameraPath) -or (Get-Item -LiteralPath $cameraPath).Length -eq 0) {
                $missingImages.Add([string]$view.file)
            }
        } elseif ($cameraViewImagesIncluded) {
            $issues.Add("Camera image reference is missing for $($room.name).")
        }
        if ([double]$view.pixelsPerWorldUnit -le 0 -or [int]$view.width -le 0 -or [int]$view.height -le 0 -or -not $view.bounds) {
            $issues.Add("Invalid native-density camera view metadata for $($room.name).")
        }
    }
}

$mapImageCount = 0
foreach ($map in $navigation.maps.PSObject.Properties) {
    if ($map.Value.file) {
        $mapImageCount++
        $mapPath = Join-Path $dataRoot ([string]$map.Value.file)
        if (-not (Test-Path -LiteralPath $mapPath) -or (Get-Item -LiteralPath $mapPath).Length -eq 0) { $missingImages.Add([string]$map.Value.file) }
    }
}

$missingIndexedAssets = [Collections.Generic.List[string]]::new()
foreach ($asset in $assetIndex.images) {
    $assetPath = Join-Path $dataRoot ([string]$asset.file)
    if (-not (Test-Path -LiteralPath $assetPath) -or (Get-Item -LiteralPath $assetPath).Length -eq 0) { $missingIndexedAssets.Add([string]$asset.file) }
}

$gzipFiles = @(Get-ChildItem -LiteralPath $dataRoot -Recurse -Filter '*.gz' -File)
$badGzipFiles = [Collections.Generic.List[string]]::new()
foreach ($path in $gzipFiles) {
    $file = [IO.File]::OpenRead($path.FullName)
    try {
        $gzip = [IO.Compression.GZipStream]::new($file, [IO.Compression.CompressionMode]::Decompress)
        try { $gzip.CopyTo([IO.Stream]::Null) }
        catch { $badGzipFiles.Add($path.FullName) }
        finally { $gzip.Dispose() }
    } catch { $badGzipFiles.Add($path.FullName) }
    finally { $file.Dispose() }
}

$roomPngCount = @(Get-ChildItem -LiteralPath (Join-Path $dataRoot 'images') -Filter '*.png' -File).Count
$roomWebpCount = @(Get-ChildItem -LiteralPath (Join-Path $dataRoot 'images') -Filter '*.webp' -File).Count
$mapWebpCount = @(Get-ChildItem -LiteralPath (Join-Path $dataRoot 'maps') -Filter '*.webp' -File).Count
$atlasWebpCount = @(Get-ChildItem -LiteralPath (Join-Path $dataRoot 'artwork') -Filter '*.webp' -File).Count
$unreferencedCameraImages = @(Get-ChildItem -LiteralPath (Join-Path $dataRoot 'images') -File | Where-Object { $_.BaseName -match '-camera-\d+$' })
$indexedImageCount = @($assetIndex.images).Count
$packageFiles = @(Get-ChildItem -LiteralPath $dataRoot -Recurse -File)
$actualImageFileCount = @(Get-ChildItem -LiteralPath $dataRoot -Recurse -File | Where-Object { $_.Extension -in @('.png', '.webp') }).Count
$webpFiles = @($packageFiles | Where-Object { $_.Extension -eq '.webp' })
$nonLosslessWebpFiles = [Collections.Generic.List[string]]::new()
foreach ($image in $webpFiles) { if (-not (Test-LosslessWebp $image.FullName)) { $nonLosslessWebpFiles.Add($image.FullName) } }
$pngFallbackFiles = @($packageFiles | Where-Object { $_.Extension -eq '.png' })
$nonMatchingPngCopies = [Collections.Generic.List[string]]::new()
$sourceImageRoot = Join-Path $PSScriptRoot 'workspace\preprocessed\images'
foreach ($image in $pngFallbackFiles) {
    $sourceImage = Join-Path $sourceImageRoot ($image.BaseName + '.png')
    if (-not (Test-Path -LiteralPath $sourceImage) -or (Get-Item -LiteralPath $sourceImage).Length -ne $image.Length -or (Get-Sha256 $sourceImage) -ne (Get-Sha256 $image.FullName)) {
        $nonMatchingPngCopies.Add($image.FullName)
    }
}
$boneMeta = Read-GzipJson (Join-Path (Join-Path $dataRoot 'rooms') 'bone_01.json.gz')
$boneMarkers = @($boneMeta.architect.markers).Count
$bonePlacements = @($boneMeta.architect.placements).Count
$boneBottomMeta = Read-GzipJson (Join-Path (Join-Path $dataRoot 'rooms') 'bone_01b.json.gz')
$boneBottomMarkers = @($boneBottomMeta.architect.markers).Count
$boneBottomPlacements = @($boneBottomMeta.architect.placements).Count
$boneBottomEnemyArtwork = @($boneBottomMeta.architect.enemyArtwork.PSObject.Properties).Count
$renderedRooms = @($manifest.rooms | Where-Object { $_.image })
$indexedMapRooms = @($navigation.areas | ForEach-Object { @($_.rooms) }) + @($navigation.unplacedRooms)
$indexedRoomNames = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($room in $indexedMapRooms) { if ($room.name) { [void]$indexedRoomNames.Add([string]$room.name) } }
$renderedRoomsMissingFromMap = @($renderedRooms | Where-Object { -not $indexedRoomNames.Contains([string]$_.name) })
$positionedRenderedRooms = @($renderedRooms | Where-Object {
    $name = [string]$_.name
    @($navigation.areas | ForEach-Object { @($_.rooms) } | Where-Object { $_.name -eq $name -and $_.center }).Count -gt 0
})
$transitionPairs = @($navigation.transitionPairs)
$navigationAreaKeys = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($area in $navigation.areas) { [void]$navigationAreaKeys.Add([string]$area.key) }
$invalidTransitionPairs = @($transitionPairs | Where-Object {
    -not $navigationAreaKeys.Contains([string]$_.fromArea) -or -not $navigationAreaKeys.Contains([string]$_.toArea) -or
    -not $_.fromRoom -or -not $_.toRoom -or -not $_.fromCenter -or -not $_.toCenter
})
$nativeFiles = @(Get-ChildItem -LiteralPath $dataRoot -Recurse -File | Where-Object { $_.Name -match '-native' -or $_.Name -match '\.partial\.' })
$bytes = ($packageFiles | Measure-Object Length -Sum).Sum
$githubTooLargeFiles = @($packageFiles | Where-Object { $_.Length -ge [int64]2GB })
$largestPackageFileBytes = [int64](($packageFiles | Measure-Object Length -Maximum).Maximum)
$githubReleaseCount = [int][math]::Ceiling($packageFiles.Count / 900)
$failedRoomCount = @($manifest.rooms | Where-Object { $_.status -eq 'failed' }).Count
$noArtworkRoomCount = @($manifest.rooms | Where-Object { $_.status -eq 'no-artwork' }).Count

if (-not $manifest.complete -or $manifest.rooms.Count -ne 590 -or $failedRoomCount -gt 0 -or $roomImageCount -ne ($manifest.rooms.Count - $noArtworkRoomCount)) { $issues.Add('Manifest completion, recovered scene count, or intentional no-artwork count is inconsistent.') }
if ($mapImageCount -ne 2 -or $mapWebpCount -ne 2) { $issues.Add('The two navigation map references are incomplete.') }
if ($indexedImageCount -ne $actualImageFileCount -or $atlasWebpCount -eq 0) { $issues.Add('Texture atlas or asset index counts do not match the prepared source.') }
if ($gzipFiles.Count -ne ($manifest.rooms.Count + 3)) { $issues.Add("Expected $($manifest.rooms.Count + 3) compressed JSON files from the manifest and shared indexes; found $($gzipFiles.Count).") }
if ($missingImages.Count) { $issues.Add("Missing image references: $($missingImages.Count).") }
if ($missingSidecars.Count) { $issues.Add("Missing room sidecars: $($missingSidecars.Count).") }
if ($missingIndexedAssets.Count) { $issues.Add("Missing indexed assets: $($missingIndexedAssets.Count).") }
if ($badGzipFiles.Count) { $issues.Add("Invalid gzip files: $($badGzipFiles.Count).") }
if ($manifest.cameraViewImageCount -ne $cameraViewImageCount) { $issues.Add('Camera-view image count does not match the package references.') }
if (-not $cameraViewImagesIncluded -and $unreferencedCameraImages.Count) { $issues.Add('Camera-section images were excluded, but camera image files remain in the package.') }
if ($unreferencedCameraImages.Count -ne $cameraViewImageCount) { $issues.Add('Camera-section image files do not match the manifest references.') }
if ($nativeFiles.Count) { $issues.Add("Native retry or partial files entered the package: $($nativeFiles.Count).") }
if ($nonLosslessWebpFiles.Count) { $issues.Add("WebP files without a lossless VP8L image chunk: $($nonLosslessWebpFiles.Count).") }
if ($nonMatchingPngCopies.Count) { $issues.Add("Oversized PNG fallbacks differ from their source renders: $($nonMatchingPngCopies.Count).") }
if ($boneMarkers -lt 1 -or $bonePlacements -lt 1) { $issues.Add('bone_01 GauntletSong marker or placement metadata is missing.') }
if ($boneBottomMarkers -lt 1 -or $boneBottomPlacements -lt 1 -or $boneBottomEnemyArtwork -lt 1) { $issues.Add('Bone Bottom (bone_01b) Architect markers, placements, or real enemy sprites are missing.') }
if ($renderedRoomsMissingFromMap.Count) { $issues.Add("Rendered room images missing from the map index/archive: $($renderedRoomsMissingFromMap.Count).") }
if ($renderedRooms.Count -ne $positionedRenderedRooms.Count + @($navigation.unplacedRooms).Count) { $issues.Add('Rendered room placement/archive totals do not cover each room exactly once.') }
if (-not $transitionPairs.Count -or $invalidTransitionPairs.Count) { $issues.Add('Cross-area transition links are missing or reference invalid map destinations.') }
if ($manifest.cameraSectionPass -and [int]$manifest.cameraSectionSummary.viewCount -ne $cameraViewCount) { $issues.Add('Camera-view manifest totals do not match room references.') }
if ($manifest.cameraSectionPass -and [int]$manifest.cameraSectionSummary.resolutionLimitedViewCount -ne $cappedCameraViewCount) { $issues.Add('Capped camera-view totals do not match room references.') }
if ($manifest.cameraSectionPass -and [int]$manifest.cameraSectionSummary.processedRoomCount -ne 483) { $issues.Add('Camera-view metadata does not cover the expected 483 capped rooms.') }
if ($manifest.cameraSectionPass -and [int]$manifest.cameraSectionSummary.fullSceneFallbackRoomCount -ne $cameraFallbackRooms.Count) { $issues.Add('Full-scene fallback room totals do not match room references.') }
if ($manifest.cameraSectionPass -and [int]$manifest.cameraSectionSummary.roomCount -ne $cameraRoomCount) { $issues.Add('Camera-section room totals do not match room references.') }
if ($manifest.cameraSectionPass -and [int]$manifest.cameraSectionSummary.missingTextureReferenceCount -ne 0) { $issues.Add('Camera images contain references to missing game textures.') }

$report = [pscustomobject]@{
    status = $(if ($issues.Count) { 'failed' } else { 'passed' })
    roomMetadata = $manifest.rooms.Count
    roomImages = $roomImageCount
    roomPreviews = $roomPreviewCount
    cameraViewRooms = $cameraRoomCount
    cameraViews = $cameraViewCount
    cameraViewImagesIncluded = $cameraViewImagesIncluded
    cameraViewImageFiles = $cameraViewImageCount
    cappedCameraViews = $cappedCameraViewCount
    fullSceneFallbackRooms = $cameraFallbackRooms.Count
    roomWebp = $roomWebpCount
    oversizedRoomPng = $roomPngCount
    losslessWebpFiles = $webpFiles.Count - $nonLosslessWebpFiles.Count
    nonLosslessWebpFiles = $nonLosslessWebpFiles.Count
    byteExactPngFallbacks = $pngFallbackFiles.Count - $nonMatchingPngCopies.Count
    nonMatchingPngFallbacks = $nonMatchingPngCopies.Count
    pngFallbackCount = $pngFallbackFiles.Count
    navigationMaps = $mapImageCount
    uniqueGameTextureAtlases = $atlasWebpCount
    indexedAssets = $indexedImageCount
    imageFiles = $actualImageFileCount
    failedScenes = $failedRoomCount
    noArtworkScenes = $noArtworkRoomCount
    gzipFiles = $gzipFiles.Count
    missingImageReferences = $missingImages.Count
    missingRoomSidecars = $missingSidecars.Count
    missingIndexedAssets = $missingIndexedAssets.Count
    invalidGzipFiles = $badGzipFiles.Count
    excludedNativeOrPartialFiles = $nativeFiles.Count
    bone01GauntletMarkers = $boneMarkers
    bone01ArchitectPlacements = $bonePlacements
    boneBottomGauntletMarkers = $boneBottomMarkers
    boneBottomArchitectPlacements = $boneBottomPlacements
    boneBottomEnemyArtworkTypes = $boneBottomEnemyArtwork
    renderedRoomImages = $renderedRooms.Count
    renderedRoomsWithAuthoredMapPositions = $positionedRenderedRooms.Count
    renderedRoomsInUnplacedSceneArchive = @($navigation.unplacedRooms).Count
    renderedRoomsMissingFromMapIndex = $renderedRoomsMissingFromMap.Count
    transitionPairCount = $transitionPairs.Count
    invalidTransitionPairs = $invalidTransitionPairs.Count
    dataBytes = $bytes
    dataGiB = [math]::Round($bytes / 1GB, 2)
    githubReleaseCompatible = ($githubTooLargeFiles.Count -eq 0)
    githubReleaseFilesPerGroup = 900
    githubReleaseCount = $githubReleaseCount
    githubFilesOver2GiB = $githubTooLargeFiles.Count
    largestPackageFileBytes = $largestPackageFileBytes
    issues = @($issues)
}
$reportJson = $report | ConvertTo-Json -Depth 6
[IO.File]::WriteAllText([IO.Path]::GetFullPath($ReportPath), $reportJson, [Text.UTF8Encoding]::new($false))
$reportJson
if ($issues.Count) { throw 'Hosted atlas audit failed.' }
