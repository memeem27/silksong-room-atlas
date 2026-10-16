param(
    [Parameter(Mandatory)][string]$TaskListPath,
    [Parameter(Mandatory)][int]$WorkerId,
    [Parameter(Mandatory)][string]$FfmpegPath,
    [Parameter(Mandatory)][string]$LogPath
)

$ErrorActionPreference = 'Stop'
$taskJson = [IO.File]::ReadAllText($TaskListPath, [Text.Encoding]::UTF8)
$parsedTasks = ConvertFrom-Json -InputObject $taskJson
$tasks = @($parsedTasks)
Add-Content -LiteralPath $LogPath -Value ("{0:o} worker={1} tasks={2} input={3}" -f (Get-Date), $WorkerId, $tasks.Count, $TaskListPath)
$completed = 0

function Publish-CompletedFile([string]$TemporaryPath, [string]$DestinationPath) {
    try {
        [IO.File]::Move($TemporaryPath, $DestinationPath)
    } catch [IO.IOException] {
        # Another queue may finish the same deduplicated asset first; keep its complete file.
        if ((Test-Path -LiteralPath $DestinationPath) -and (Get-Item -LiteralPath $DestinationPath).Length -gt 0) {
            Remove-Item -LiteralPath $TemporaryPath -Force -ErrorAction SilentlyContinue
            return
        }
        throw
    }
}

foreach ($task in $tasks) {
    $source = [string]$task.Source
    $destination = [string]$task.Destination
    $destinationDirectory = Split-Path -Parent $destination
    if (-not (Test-Path -LiteralPath $destinationDirectory)) { New-Item -ItemType Directory -Path $destinationDirectory -Force | Out-Null }
    if ((Test-Path -LiteralPath $destination) -and (Get-Item -LiteralPath $destination).Length -gt 0) {
        $completed++
        continue
    }

    if ($task.Mode -eq 'copy') {
        $temporary = $destination + ".worker-$WorkerId-$PID.partial.png"
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        Copy-Item -LiteralPath $source -Destination $temporary -Force
        Publish-CompletedFile -TemporaryPath $temporary -DestinationPath $destination
    } elseif ($task.Mode -eq 'webp') {
        $temporary = Join-Path $destinationDirectory (([IO.Path]::GetFileNameWithoutExtension($destination)) + ".worker-$WorkerId-$PID.partial.webp")
        Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
        # WebP's lossless flag preserves decoded pixels. Level 4 keeps the CPU cost reasonable
        # while still storing the original color/alpha values exactly.
        & $FfmpegPath -y -hide_banner -loglevel error -i $source -frames:v 1 -c:v libwebp -pix_fmt bgra -lossless 1 -quality 80 -compression_level 4 $temporary
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $temporary) -or (Get-Item -LiteralPath $temporary).Length -eq 0) {
            Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
            throw "Could not losslessly encode visible pixels: $source"
        }
        Publish-CompletedFile -TemporaryPath $temporary -DestinationPath $destination
    } else {
        throw "Unsupported task mode '$($task.Mode)' for $source"
    }

    if (-not (Test-Path -LiteralPath $destination) -or (Get-Item -LiteralPath $destination).Length -eq 0) { throw "Image task produced an empty file: $destination" }
    $completed++
    if ($completed % 5 -eq 0 -or $completed -eq $tasks.Count) {
        Add-Content -LiteralPath $LogPath -Value ("{0:o} worker={1} completed={2}/{3} last={4}" -f (Get-Date), $WorkerId, $completed, $tasks.Count, (Split-Path -Leaf $source))
    }
}
Add-Content -LiteralPath $LogPath -Value ("{0:o} worker={1} done={2}/{3}" -f (Get-Date), $WorkerId, $completed, $tasks.Count)
