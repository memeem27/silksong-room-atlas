# Silksong Scene Viewer

A local Windows application for indexing Silksong room bundles, inspecting scene objects, and exporting room images.

## Run the application

Install the .NET 10 SDK. From this folder, double-click `Start-SilksongSceneViewer.cmd`, or run:

```powershell
dotnet run --project src/SilksongSceneViewer -- --source "../ExtractionInput/Bundles/scenes_scenes_scenes"
```

Open the local address printed at startup. To scan another source folder, enter its exact path in the viewer under **Change folder** or pass it to the launcher. The indexer reads `.bundle` files directly in the selected folder; it does not recursively pick up other workspace folders.

The viewer reads serialized Unity objects, world transforms, 2D collider outlines, and referenced `SpriteRenderer` assets. It resolves only CAB files referenced by the selected room from the known Silksong Addressables export and sprite-atlas folder, then stores decoded PNG atlas images under `workspace/scenes/artwork`. Use **Import scene list** to batch-load newline-separated room names. Toggle the **Artwork** layer to show or hide sprites, then use **Export room image** for a PNG with the visible artwork, colliders, and object categories. The matching JSON sidecar includes coordinates and sprite references.

If those extracted game-asset folders are absent, the viewer still loads scene layout and marks unresolved sprite references in its diagnostics. It reads only the selected room directory and these explicit asset roots; it does not recursively search unrelated workspace folders.

## Preprocessed atlas reader

Use **Prepare offline reader** to pre-render the game-authored wide map, detailed area map, and every indexed room. The generated dataset is stored in `workspace/preprocessed` as clean native-resolution PNGs, room JSON sidecars, and map navigation metadata. Rooms larger than one safe browser canvas are rendered in tiles and get a smaller reader preview; use the room inspector’s **Download** link for the full-resolution PNG. Exports use real Silksong bundle textures and exclude viewer overlays and Architect images. The reader loads one preview and sidecar only when selected. Architect gauntlet markers are recorded in room metadata and hidden by default; the reader exposes a wave/event selector and per-placement toggles. During preprocessing, the viewer writes a partial manifest; the completed manifest becomes available when the pass finishes.

The alternate-port launcher uses the prebuilt binary in `src/SilksongSceneViewer/bin/experiment-5180-fullres`. For this workspace’s four-worker preprocessing run, workers write checkpoint indexes as `manifest-worker-N.json`; the `Finalize-PreprocessedSceneViewer.ps1 -Watch` process validates and merges those checkpoints into `workspace/preprocessed/manifest.json` as the batch progresses. It marks the dataset ready when all workers finish all 590 scenes. `Enrich-PreprocessedEnemyArtwork.ps1` adds matching sprites from Silksong’s sprite atlases to Architect sidecars for already-rendered rooms without changing their PNGs. To retry named scenes, use `?batchScene=scene_name` (comma-separated names are supported) and **Prepare offline reader**. A single retry worker writes `manifest-retry.json`; parallel retry workers write separate `manifest-retry-worker-N.json` files. Validate and merge each completed retry manifest with `Merge-PreprocessedRetries.ps1`.

Run `Start-PreprocessedSceneViewer.cmd` to open an independent experiment instance on `http://127.0.0.1:5180/preprocessed-reader/`. Keep the regular viewer on port 5178. The reader uses the same extracted bundle and asset folders, but it does not decode every room texture at startup. A live manifest is written during preprocessing so already completed rooms can be inspected before the full pass finishes.

## Packaged atlas for local or hosted use

The static browser atlas is in `HostedAtlas/site`, with pre-rendered room images and compressed room metadata under `HostedAtlas/r2-data`. Its sketch-like overview uses real game map sprites at their authored positions; select a region to see its room layout, then select a room for its render and metadata. Room labels appear as you zoom in, and serialized transition rooms include buttons to move to the neighboring region. All rendered scenes are indexed: scenes with no authored geographic position stay in a clearly marked archive instead of receiving guessed coordinates. Room PNG export includes only the selected clean game image; enemy, spawn, check, and Architect overlays remain separate and start hidden. Run `Start-HostedAtlas.cmd` to open it locally on port 5181. See [HostedAtlas/README.md](HostedAtlas/README.md) for package checks and no-storage-bill GitHub Releases/Cloudflare Pages hosting steps, plus the optional R2 route. Large generated data and conversion files are excluded from Git by `.gitignore`.

## Rendering fidelity and in-game captures

The standalone renderer reads the real room bundle and referenced atlas textures. It applies serialized transforms, sprite pivots and trimming, renderer tint, sorting layers/groups, and the stored background/foreground separation. It does not run Unity's custom shaders, live particle simulation, or runtime lighting and background effects, so an extracted room can still differ from the game even when every texture file is present.

For exact pixels from the game, the optional capture plugin in `CaptureMod` saves a screenshot plus the Unity camera and room manifest when you press **F9**. Build it with `dotnet build CaptureMod/SilksongSceneViewer.Capture.csproj -c Release`, then copy `CaptureMod/bin/Release/netstandard2.1/Silksong.SceneViewer.Capture.dll` to `BepInEx/plugins/SceneViewerCapture/`. Captures are written under `BepInEx/config/SilksongSceneViewerCaptures/`. In the viewer, choose that folder under **In-game capture**, open a matching room, then turn on **Use captured game view**. The saved camera viewport is projected into room coordinates, and **Export room image** includes the selected captured view.

Captured frames retain whatever was visible at that moment, including the player, HUD, particles, and temporary effects. The latest single frame is selected first; composite the other views to extend room coverage, though combining frames from different moments may produce visible seams. The extracted bundle artwork remains available outside captured viewports.
