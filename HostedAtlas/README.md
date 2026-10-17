# Silksong Room Atlas

This is a browser-based atlas for the prepared Silksong room dataset. The viewer shell is in `site/`; local preview reads the package in `r2-data/`, while hosted deployments serve that package on demand from GitHub Releases or Cloudflare R2. Clean room images contain only preprocessed game artwork; enemy, spawn, check, and Architect/GauntletSong information is kept in sidecar metadata and drawn as optional viewer overlays.

## Local preview

Double-click `D:\SSrip\SceneViewer\Start-HostedAtlas.cmd`, or start the preview from PowerShell:

```powershell
cd D:\SSrip\SceneViewer
node .\Serve-HostedAtlas.js
```

Open <http://127.0.0.1:5181/>. The server reads the already-prepared package and does not rerun texture processing.

## Package contents

- The completed package covers 590 scene records: 566 clean full-room images plus 1 optional preview, and 24 scenes with metadata but no renderable artwork. It retains 4,176 authored camera-area bounds across 474 rooms, 922 unique game texture atlases, two navigation maps, and 593 compressed metadata files. The navigation index places every rendered room that has a GameMapScene location and lists the remaining renderable scenes in an explicit archive; it never invents geographic coordinates for cutscene-only rooms. Separate camera-section images are omitted from the hosted package by default; the viewer can crop selected areas from their full-room image. The current package contains 1,491 image files and is 6.02 GiB.
- `site/` contains the standalone viewer, Cloudflare Pages function, and Pages route rules.
- The viewer is map-first: the room-map overview and full-room artwork fill the canvas, while the region list and map/room layers open as floating drawers. The overview draws real game sprites through their authored mesh shapes and positions, with clean region labels, highlights, optional connection paths, and names that appear as you zoom. Selecting a room with a serialized transition reveals a button to its neighboring area. Optional Architect badges stay off by default and open the room's gauntlet controls. Scroll to zoom and drag to pan while markers keep the same screen size. **Show all regions** adds the other authored map sprites as context.
- `r2-data/` contains the full image package and gzip-compressed room, map, and asset metadata.
- `DATA-EXPORT-STATUS.txt` records the export summary.
- `AUDIT-REPORT.json` and `PIXEL-TEST-REPORT.json` record the completed integrity and source-pixel checks.
- [Audit-HostedAtlas.ps1](../Audit-HostedAtlas.ps1) checks image and metadata references, gzip integrity, excluded intermediate files, all rendered-room map coverage, Bone_01 and Bone Bottom Architect artwork, valid transition links, and GitHub Release file-size eligibility, then saves `AUDIT-REPORT.json`.
- [Test-HostedAtlasNavigation.js](../Test-HostedAtlasNavigation.js) verifies rendered-room coverage, real map mesh geometry, Bone Bottom enemy art, and cross-area transition destinations.
- [Test-HostedAtlasPixels.js](../Test-HostedAtlasPixels.js) verifies representative WebP images against their source PNGs at visible-pixel level and checks that the oversized PNG fallback is byte-identical.
- [Upload-HostedAtlas-GitHub.ps1](../Upload-HostedAtlas-GitHub.ps1) uploads the audited package as GitHub Release assets; [Test-HostedAtlasPagesFunction.js](../Test-HostedAtlasPagesFunction.js) checks the release proxy behavior.

## Hosting layout

The source repository and viewer code are [memeem27/silksong-room-atlas](https://github.com/memeem27/silksong-room-atlas). `site/release-assets.json` is committed on `main` and maps all 2,084 package paths to their release assets. The room images and texture atlases remain in the first three releases; navigation-index revisions use small separate releases, with release 006 containing the current room-position and Architect summaries. This avoids duplicating the 6.02 GiB image package for map-only changes. Release assets are split into groups of at most 900 files, each under GitHub's per-file size limit. The Pages Function proxies only requested room, map, and metadata files, so the viewer does not download every image at startup.

The release data is available here: [part 1](https://github.com/memeem27/silksong-room-atlas/releases/tag/silksong-atlas-data-001), [part 2](https://github.com/memeem27/silksong-room-atlas/releases/tag/silksong-atlas-data-002), [part 3](https://github.com/memeem27/silksong-room-atlas/releases/tag/silksong-atlas-data-003), and the small map/metadata revisions beginning with [release 006](https://github.com/memeem27/silksong-room-atlas/releases/tag/silksong-atlas-data-006). A metadata-only revision should use `Build-HostedAtlasDelta.js` followed by `Upload-HostedAtlas-Delta.ps1` so it does not re-upload the multi-gigabyte image package. The viewer is deployed at <https://silksong-room-atlas.pages.dev/>. Cloudflare Pages is connected to the GitHub repository and automatically deploys changes pushed to `main`.

A plain GitHub Pages deployment is not supported by this configuration because it does not run the Pages Function that resolves split release assets. Use Cloudflare Pages Git integration for the viewer and GitHub Releases for its data. Once connected, pushes to `main` deploy the viewer and the committed release map together.

Create the viewer on Cloudflare Pages using **Git integration** so pushes to main deploy automatically. In the Cloudflare dashboard, open **Workers & Pages → Create application → Pages → Connect to Git**, choose memeem27/silksong-room-atlas, and use these settings:

| Setting | Value |
| --- | --- |
| Project name | silksong-room-atlas |
| Production branch | main |
| Framework preset | None |
| Root directory | HostedAtlas/site |
| Build command | Leave blank |
| Build output directory | . |

The Pages Function lives in `HostedAtlas/site/functions`, so keep that folder at the Pages project root. Do not create a Direct Upload Pages project for this repository: Cloudflare does not let a Direct Upload project switch to Git integration later. If Cloudflare asks to install its GitHub app, limit the installation to this repository when that option is available.

To publish a future replacement dataset, rebuild and audit it, then use `Upload-HostedAtlas-GitHub.ps1` with a new `-ReleasePrefix` so existing releases remain intact. Commit and push the new `site/release-assets.json` only after every upload has completed. Use `-Resume` only when continuing the same interrupted upload.

r2-data/ and generated worker files are excluded from Git, while site/release-assets.json is committed after upload. The Pages Git integration uses `site/wrangler.toml` with the GitHub Releases proxy and no R2 binding, so it works without an account-specific bucket. The optional R2 configuration is preserved in `site/wrangler.r2.toml`; use it only after creating the configured bucket. `site/wrangler.github.toml` is the matching GitHub Releases configuration for explicit Wrangler CLI use. See [R2 pricing](https://developers.cloudflare.com/r2/pricing/) for current terms.

The game files used to generate this package are local source data and are not redistributed by these hosting instructions. Confirm that any public release follows the applicable game asset permissions.
## Rebuilding and checks

To rebuild the data package from the preprocessed workspace and cached game artwork, run:

```powershell
cd D:\SSrip
.\SceneViewer\Build-HostedAtlas.ps1 -Workers 3
.\SceneViewer\Audit-HostedAtlas.ps1
$env:FFMPEG_PATH = (Get-Command ffmpeg).Source
node .\SceneViewer\Test-HostedAtlasPixels.js
node .\SceneViewer\Test-HostedAtlasPagesFunction.js
```

The pixel test compares full-room images, authored camera-section images when included, the broad map, and a game texture atlas at visible RGBA level. Hosted room pages default to the whole-room image. The **Room States** panel can reveal serialized-inactive sprite and mesh branches, toggle disabled SpriteRenderers, and select named mutually exclusive states. These views are rebuilt from real Silksong bundle textures and renderer geometry; they do not simulate the game. By default, the hosted package omits separate camera-area images and retains their bounds so the viewer can crop them from the full-room image; pass `-IncludeCameraViewImages` to the build script to include standalone camera renders. PNG export uses only the exact saved pixels for the selected clean room image; marker overlays, controls, and viewer UI are not included. Oversized full-room images remain byte-identical PNGs, and other room images are lossless WebP.

These exports reconstruct static bundle artwork, authored camera bounds, and serialized inactive branches. When a room-state toggle is selected, the browser composes its real serialized sprites and meshes once and caches the result in memory for pan and zoom; it does not create or download pre-rendered variants. Unity runtime lights, shaders, scripted check/event activation, and room transitions are not executed by the offline renderer, so states driven only at runtime cannot be inferred solely from the saved texture data.

The game files used to generate this package are local source data and are not redistributed by these hosting instructions. Confirm that any public release follows the applicable game asset permissions.
