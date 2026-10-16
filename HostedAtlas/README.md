# Silksong Room Atlas

This export is a static, browser-based atlas for the prepared Silksong room dataset. The viewer loads its shell from `site/`; local preview reads the package in `r2-data/`, while hosted deployments can serve that same package from GitHub Releases or Cloudflare R2. Clean room images contain only preprocessed game artwork; enemy, spawn, check, and Architect/GauntletSong information is kept in sidecar metadata and drawn as optional viewer overlays.

## Local preview

Double-click `D:\SSrip\SceneViewer\Start-HostedAtlas.cmd`, or start the preview from PowerShell:

```powershell
cd D:\SSrip\SceneViewer
node .\Serve-HostedAtlas.js
```

Open <http://127.0.0.1:5181/>. The server reads the already-prepared package and does not rerun texture processing.

## Package contents

- The completed package covers 590 scene records: 566 clean room images plus 1 optional preview, and 24 scenes with metadata but no renderable artwork. It includes 4,176 authored camera sections across 474 rooms, 922 unique game texture atlases, two navigation maps, and 593 compressed metadata files (15.20 GiB total).
- `site/` contains the standalone viewer, Cloudflare Pages function, and Pages route rules.
- `r2-data/` contains the full image package and gzip-compressed room, map, and asset metadata.
- `DATA-EXPORT-STATUS.txt` records the export summary.
- `AUDIT-REPORT.json` and `PIXEL-TEST-REPORT.json` record the completed integrity and source-pixel checks.
- [Audit-HostedAtlas.ps1](../Audit-HostedAtlas.ps1) checks image and metadata references, gzip integrity, excluded intermediate files, Bone_01 Architect records, and GitHub Release file-size eligibility, then saves `AUDIT-REPORT.json`.
- [Test-HostedAtlasPixels.js](../Test-HostedAtlasPixels.js) verifies representative WebP images against their source PNGs at visible-pixel level and checks that the oversized PNG fallback is byte-identical.
- [Upload-HostedAtlas-GitHub.ps1](../Upload-HostedAtlas-GitHub.ps1) uploads the audited package as GitHub Release assets; [Test-HostedAtlasPagesFunction.js](../Test-HostedAtlasPagesFunction.js) checks the release proxy behavior.

## Hosting layout

Use Cloudflare Pages for the viewer and GitHub Releases for its pre-rendered files. Upload-HostedAtlas-GitHub.ps1 indexes each relative package path, uses the original filename for its release asset, splits the package into releases of at most 900 assets, and writes site/release-assets.json. The Pages Function proxies only requested room, map, and metadata files, so the viewer does not download every image at startup. The uploader checks the current GitHub per-release asset-count and per-file-size limits before publishing.

The source repository is [memeem27/silksong-room-atlas](https://github.com/memeem27/silksong-room-atlas). Start the data upload with:

    .\Upload-HostedAtlas-GitHub.ps1 -Repository 'memeem27/silksong-room-atlas'

If GitHub rate-limits the upload, wait for its cooldown (at least one minute) and resume with:

    .\Upload-HostedAtlas-GitHub.ps1 -Repository 'memeem27/silksong-room-atlas' -Resume

After the release upload finishes, commit and push the generated mapping file:

    git add HostedAtlas/site/release-assets.json
    git commit -m "Add hosted atlas release map"
    git push

Create the viewer on Cloudflare Pages using **Git integration** so pushes to main deploy automatically. In the Cloudflare dashboard, open **Workers & Pages → Create application → Pages → Connect to Git**, choose memeem27/silksong-room-atlas, and use these settings:

| Setting | Value |
| --- | --- |
| Project name | silksong-room-atlas |
| Production branch | main |
| Framework preset | None |
| Root directory | HostedAtlas/site |
| Build command | Leave blank |
| Build output directory | . |

The Pages Function lives in HostedAtlas/site/functions, so keep that folder at the Pages project root. Do not create a Direct Upload Pages project for this repository: Cloudflare does not let a Direct Upload project switch to Git integration later. If Cloudflare asks to install its GitHub app, limit the installation to this repository when that option is available.

r2-data/ and generated worker files are excluded from Git, while site/release-assets.json is committed after upload. This project also includes an R2 option: Upload-HostedAtlas.ps1 uploads the same files to the bucket named in site/wrangler.toml. Use site/wrangler.toml for R2 or site/wrangler.github.toml for the GitHub Releases proxy. See [R2 pricing](https://developers.cloudflare.com/r2/pricing/) for current terms.

The game files used to generate this package are local source data and are not redistributed by these hosting instructions. Confirm that any public release follows the applicable game asset permissions.
## Rebuilding and checks

To rebuild the data package from the preprocessed workspace and cached game artwork, run:

```powershell
cd D:\SSrip
.\SceneViewer\Build-HostedAtlas.ps1 -Workers 3 -Resume
.\SceneViewer\Audit-HostedAtlas.ps1
$env:FFMPEG_PATH = (Get-Command ffmpeg).Source
node .\SceneViewer\Test-HostedAtlasPixels.js
node .\SceneViewer\Test-HostedAtlasPagesFunction.js
```

The pixel test compares a room image, authored camera-section images when present, the broad map, and a game texture atlas at visible RGBA level. Room pages default to a serialized camera-lock section when available and keep the full scene available from the view menu. For scenes whose full-room canvas exceeded practical rendering limits, the build stores separate images for each authored camera area using active Silksong bundle renderers. Camera views preserve native texture density when they fit; extreme bounds are capped at 16,379 pixels per edge and 100 megapixels so they remain loadable in browsers. PNG export uses only the exact saved pixels for the selected clean room image; marker overlays, controls, and viewer UI are not included. The room information panel identifies any capped render and reports the saved pixel density.

These exports reconstruct static bundle artwork and authored camera bounds. Unity runtime lights, shaders, scripted check/event activation, and room transitions are not executed by the offline renderer, so those dynamic game states cannot be inferred solely from the saved texture data.

The game files used to generate this package are local source data and are not redistributed by these hosting instructions. Confirm that any public release follows the applicable game asset permissions.
