param(
    [string]$Workspace = (Join-Path $PSScriptRoot 'workspace\preprocessed'),
    [switch]$Watch,
    [ValidateRange(5, 300)][int]$PollSeconds = 15
)

$Workspace = [System.IO.Path]::GetFullPath($Workspace)

function Write-AtlasManifest {
    param([string]$Root)

    $workerFiles = @(Get-ChildItem -LiteralPath $Root -Filter 'manifest-worker-*.json' -File)
    if ($workerFiles.Count -eq 0) { return $false }
    $workers = @($workerFiles | ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json })
    $expectedWorkers = [int]$workers[0].workerCount
    $expectedScenes = [int]$workers[0].requestedSceneCount
    if ($expectedWorkers -lt 2) { throw 'Worker manifests do not describe a parallel run.' }
    if ($workerFiles.Count -gt $expectedWorkers) { throw "Found more than $expectedWorkers worker manifests." }
    if (@($workers | Select-Object -ExpandProperty workerIndex -Unique).Count -ne $workerFiles.Count) {
        throw 'Worker manifest indexes are duplicated.'
    }
    foreach ($worker in $workers) {
        if ([int]$worker.workerCount -ne $expectedWorkers -or [int]$worker.requestedSceneCount -ne $expectedScenes) {
            throw 'Worker manifests disagree on the scene count or worker count.'
        }
    }

    $rooms = @($workers | ForEach-Object { $_.rooms } | Sort-Object { [int]$_.order })
    if ($rooms.Count -gt $expectedScenes) { throw "Workers indexed $($rooms.Count) rooms, above the expected $expectedScenes." }
    if (@($rooms | Select-Object -ExpandProperty name -Unique).Count -ne $rooms.Count) {
        throw 'Room names are duplicated across worker manifests.'
    }
    foreach ($room in $rooms) {
        if (-not $room.metadata -or -not (Test-Path -LiteralPath (Join-Path $Root $room.metadata))) {
            throw "Missing room metadata for $($room.name)."
        }
        if ($room.image -and -not (Test-Path -LiteralPath (Join-Path $Root $room.image))) {
            throw "Missing rendered PNG for $($room.name)."
        }
        if ($room.previewImage -and -not (Test-Path -LiteralPath (Join-Path $Root $room.previewImage))) {
            throw "Missing reader preview PNG for $($room.name)."
        }
    }

    $completeWorkers = @($workers | Where-Object { $_.workerComplete -and -not $_.canceled }).Count
    $complete = $workerFiles.Count -eq $expectedWorkers -and $completeWorkers -eq $expectedWorkers -and $rooms.Count -eq $expectedScenes
    $counts = [ordered]@{}
    foreach ($group in ($rooms | Group-Object -Property status)) { $counts[$group.Name] = $group.Count }
    $mapWorker = $workers | Where-Object { [int]$_.workerIndex -eq 0 } | Select-Object -First 1
    if (-not $mapWorker) { $mapWorker = $workers | Select-Object -First 1 }
    $manifest = [ordered]@{
        format = 'silksong-room-atlas'
        formatVersion = 1
        createdAt = [DateTimeOffset]::UtcNow.ToString('o')
        complete = $complete
        canceled = @($workers | Where-Object { $_.canceled }).Count -gt 0
        workerCount = $expectedWorkers
        completedWorkerCount = $completeWorkers
        requestedSceneCount = $expectedScenes
        processedSceneCount = $rooms.Count
        unprocessedSceneCount = [Math]::Max(0, $expectedScenes - $rooms.Count)
        counts = $counts
        sourceFolderName = $mapWorker.sourceFolderName
        renderProfile = $mapWorker.renderProfile
        navigation = $mapWorker.navigation
        coordinateConvention = $mapWorker.coordinateConvention
        rooms = $rooms
    }

    $destination = Join-Path $Root 'manifest.json'
    $temp = "$destination.$([Guid]::NewGuid().ToString('N')).tmp"
    $manifest | ConvertTo-Json -Depth 100 -Compress | Set-Content -LiteralPath $temp -Encoding utf8
    Move-Item -LiteralPath $temp -Destination $destination -Force
    if ($complete) { Write-Host "Ready: $($rooms.Count) rooms indexed across $expectedWorkers workers." }
    else { Write-Host "Live index: $($rooms.Count)/$expectedScenes rooms · $completeWorkers/$expectedWorkers workers finished." }
    return $complete
}

do {
    $complete = Write-AtlasManifest -Root $Workspace
    if (-not $complete -and -not $Watch) { throw 'The worker pass is still incomplete; rerun with -Watch to wait for completion.' }
    if (-not $complete -and $Watch) { Start-Sleep -Seconds $PollSeconds }
} while ($Watch -and -not $complete)

Write-Host "Manifest: $(Join-Path $Workspace 'manifest.json')"
