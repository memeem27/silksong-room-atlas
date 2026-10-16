# Silksong Scene Viewer Capture

This optional BepInEx 5 plugin records a real in-game frame for comparison with the standalone renderer. It does not create or replace game artwork, patch room content, or upload data.

Press **F9** in game. The plugin saves a PNG screenshot and a JSON manifest to:

`BepInEx/config/SilksongSceneViewerCaptures/`

The manifest records the active and loaded scenes, Unity camera state and matrices, game version, object hierarchy and transforms, renderer sorting values, sprite colors, material and shader names, and live particle counts. The renderer inventory can be disabled in the generated BepInEx configuration file.

Build with `dotnet build SilksongSceneViewer.Capture.csproj -c Release`. Copy `Silksong.SceneViewer.Capture.dll` into `BepInEx/plugins/SceneViewerCapture/` to use it. This project is not installed into the game automatically.
