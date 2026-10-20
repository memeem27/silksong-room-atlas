using AssetsTools.NET;
using AssetsTools.NET.Extra;
using AssetsTools.NET.Texture;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace SilksongSceneViewer;

internal sealed record SpriteCrop(string Url, string Name, float X, float Y, float Width, float Height,
    float PivotX, float PivotY, float PixelsPerUnit, float TextureWidth, float TextureHeight,
    float OriginalWidth, float OriginalHeight, float TrimOffsetX, float TrimOffsetY,
    IReadOnlyList<SpriteMeshVertex> MeshVertices, IReadOnlyList<int> MeshIndices, int PackingRotation = 0);
internal sealed record SpriteMeshVertex(float X, float Y);
internal sealed record NamedSpriteAsset(string PlacementId, string SpriteName, string SourceBundle,
    SceneSpriteReference Sprite);
internal sealed record NamedSpriteSearchResult(IReadOnlyDictionary<string, NamedSpriteAsset> Assets,
    int BundlesScanned, int BundleErrors);

internal sealed class SpriteAssetLoader {
    // Architect's actor IDs do not always match the Silksong journal atlas labels.
    // These links are confirmed by the selected GauntletSong registry evidence:
    // `pilgrim_hulk` reuses Pilgrim 02, `envoy` reuses Song Pilgrim 01, and
    // `pilgrim_guide` reuses Pilgrim StaffWeilder in the native game registry.
    private static readonly IReadOnlyDictionary<string, string[]> KnownEnemySpriteAliases =
        new Dictionary<string, string[]>(StringComparer.Ordinal) {
            ["envoy"] = ["songpilgrim01"],
            ["pilgrimhulk"] = ["pilgrim02"],
            ["pilgrimguide"] = ["pilgrimstaffweilder"],
            ["pilgrimbell"] = ["pilgrimbellthrower"],
            // The in-game idle sprite is named RR_idle0000 and lives in the
            // area-bone animation bundle, not either journal atlas. Prefer it
            // over the small journal portrait for both Architect spellings.
            ["boneroller"] = ["rridle0000"],
            ["rockroller"] = ["rridle0000"]
        };
    private readonly string[] _assetDirectories;
    private readonly string _assetOutputDirectory;
    private readonly Func<string> _sceneBundleDirectory;
    private readonly Dictionary<string, BundleLocation> _bundleIndex = new(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> _loadedCandidates = new(StringComparer.OrdinalIgnoreCase);
    private readonly object _indexLock = new();
    private readonly object _namedSpriteIndexLock = new();
    private NamedSpriteIndexCache? _namedSpriteIndex;
    private IndexedSpriteName[]? _rockRollerIdleSprites;
    private string _rockRollerIdleBundlePath = "";
    private long _rockRollerIdleBundleTicks;

    public SpriteAssetLoader(IEnumerable<string> assetDirectories, string packageDirectory,
        Func<string> sceneBundleDirectory) {
        _assetDirectories = assetDirectories.Select(Path.GetFullPath).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        _assetOutputDirectory = Path.Combine(packageDirectory, "artwork");
        _sceneBundleDirectory = sceneBundleDirectory;
    }

    public ScenePackage AttachAssets(ScenePackage scene, CancellationToken cancellationToken) {
        var all = scene.Objects.SelectMany(o => o.Sprites).Where(s => !string.IsNullOrWhiteSpace(s.ExternalPath))
            .DistinctBy(s => (s.ExternalPath, s.PathId)).ToArray();
        if (all.Length == 0 || !_assetDirectories.Any(Directory.Exists)) return scene;
        Directory.CreateDirectory(_assetOutputDirectory);
        var index = GetLocations(all.Select(r => BundleKey(r.ExternalPath)).Where(k => k.Length > 0).ToHashSet(StringComparer.OrdinalIgnoreCase));
        var loaded = new Dictionary<string, SpriteCrop>(StringComparer.OrdinalIgnoreCase);
        var textureImages = new Dictionary<string, (string Url, int Width, int Height)>(StringComparer.OrdinalIgnoreCase);
        var diagnostics = scene.Diagnostics.ToList();
        var missingBundle = 0; var missingSprite = 0; var missingTexture = 0; var pointerMissing = 0; var noTextureAsset = 0;
        var manager = new AssetsManager();
        foreach (var reference in all) {
            cancellationToken.ThrowIfCancellationRequested();
            var key = BundleKey(reference.ExternalPath);
            if (key.Length == 0 || !index.TryGetValue(key, out var location)) { missingBundle++; continue; }
            var spriteKey = $"{key}:{reference.PathId}";
            if (loaded.ContainsKey(spriteKey)) continue;
            try {
                var bundle = manager.LoadBundleFile(location.BundlePath, true);
                var assetsFile = manager.LoadAssetsFileFromBundle(bundle, location.FileIndex, false);
                var spriteInfo = assetsFile.file.GetAssetInfo(reference.PathId);
                if (spriteInfo is null) { missingSprite++; continue; }
                var sprite = manager.GetBaseField(assetsFile, spriteInfo);
                var spriteName = StringField(sprite, "m_Name", "sprite");
                var texturePointer = Field(sprite, "m_RD", "texture") ?? Field(sprite, "m_Texture");
                var originalRect = Field(sprite, "m_Rect");
                var renderData = Field(sprite, "m_RD");
                var sourceRect = Field(renderData, "textureRect") ?? originalRect;
                if (LongField(texturePointer!, "m_PathID") == 0) {
                    var packedData = FindAtlasRenderData(sprite, assetsFile, manager);
                    if (packedData is not null) {
                        renderData = packedData;
                        texturePointer = Field(renderData, "texture") ?? Field(renderData, "m_Texture");
                        sourceRect = Field(renderData, "textureRect") ?? sourceRect;
                    } else {
                        diagnostics.Add(new("warning", $"Could not match packed atlas metadata for {spriteName} ({key}:{reference.PathId}); skipped to avoid drawing an incorrect atlas region."));
                        missingTexture++;
                        continue;
                    }
                }
                if (texturePointer is null) {
                    pointerMissing++; missingTexture++;
                    continue;
                }
                var texturePathId = LongField(texturePointer, "m_PathID");
                var textureFileId = (int)LongField(texturePointer, "m_FileID");
                if (texturePathId == 0) {
                    pointerMissing++; missingTexture++;
                    continue;
                }
                var textureAssetFile = assetsFile;
                var textureExternal = "";
                if (textureFileId > 0 && textureFileId <= assetsFile.file.Metadata.Externals.Count) {
                    textureExternal = assetsFile.file.Metadata.Externals[textureFileId - 1].PathName ?? "";
                    var textureKey = BundleKey(textureExternal);
                    if (!index.TryGetValue(textureKey, out var textureLocation))
                        textureLocation = GetLocations(new HashSet<string>([textureKey], StringComparer.OrdinalIgnoreCase)).GetValueOrDefault(textureKey)!;
                    if (textureLocation is null) { missingTexture++; continue; }
                    var textureBundle = manager.LoadBundleFile(textureLocation.BundlePath, true);
                    textureAssetFile = manager.LoadAssetsFileFromBundle(textureBundle, textureLocation.FileIndex, false);
                }
                var textureCacheKey = textureFileId > 0
                    ? $"{textureExternal}:{texturePathId}"
                    : $"{location.BundlePath}:{location.FileIndex}:{texturePathId}";
                if (!textureImages.TryGetValue(textureCacheKey, out var image)) {
                    var textureInfo = textureAssetFile.file.GetAssetInfo(texturePathId);
                    if (textureInfo is null) { noTextureAsset++; missingTexture++; continue; }
                    var textureBase = manager.GetBaseField(textureAssetFile, textureInfo);
                    var texture = TextureFile.ReadTextureFile(textureBase);
                    var bgra = texture.DecodeTextureRaw(texture.FillPictureData(textureAssetFile), true);
                    if (bgra is null || bgra.Length < texture.m_Width * texture.m_Height * 4) continue;
                    var png = EncodeRgbaPng(bgra, texture.m_Width, texture.m_Height);
                    var hash = Convert.ToHexString(SHA256.HashData(png)).ToLowerInvariant();
                    var fileName = hash + ".png";
                    var outputPath = Path.Combine(_assetOutputDirectory, fileName);
                    if (!File.Exists(outputPath)) File.WriteAllBytes(outputPath, png);
                    image = ("/api/artwork/" + fileName, texture.m_Width, texture.m_Height);
                    textureImages[textureCacheKey] = image;
                }
                var pivot = Field(sprite, "m_Pivot");
                var trimOffset = Field(renderData, "textureRectOffset");
                var mesh = ReadSpriteMesh(Field(sprite, "m_RD"));
                var crop = new SpriteCrop(image.Url, spriteName,
                    FloatField(sourceRect, "x"), FloatField(sourceRect, "y"), FloatField(sourceRect, "width"), FloatField(sourceRect, "height"),
                    FloatField(pivot, "x", .5f), FloatField(pivot, "y", .5f), FloatField(sprite, "m_PixelsToUnits", 100),
                    image.Width, image.Height,
                    FloatField(originalRect, "width", FloatField(sourceRect, "width")),
                    FloatField(originalRect, "height", FloatField(sourceRect, "height")),
                    FloatField(trimOffset, "x"), FloatField(trimOffset, "y"), mesh.Vertices, mesh.Indices);
                crop = crop with { PackingRotation = (int)((UIntField(Field(renderData, "settingsRaw")) >> 2) & 0xF) };
                loaded[spriteKey] = crop;
            } catch (Exception exception) when (exception is not OperationCanceledException) {
                diagnostics.Add(new("warning", $"Could not extract sprite asset {key}:{reference.PathId}: {exception.Message}"));
            }
        }
        var objects = scene.Objects.Select(o => o with {
            Sprites = o.Sprites.Select(s => {
                var key = BundleKey(s.ExternalPath);
                return loaded.TryGetValue($"{key}:{s.PathId}", out var crop)
                    ? s with { Name = crop.Name, ImageUrl = crop.Url, RectX = crop.X, RectY = crop.Y,
                        RectWidth = crop.Width, RectHeight = crop.Height, PivotX = crop.PivotX, PivotY = crop.PivotY,
                        PixelsPerUnit = crop.PixelsPerUnit, TextureWidth = crop.TextureWidth, TextureHeight = crop.TextureHeight }
                    with { OriginalWidth = crop.OriginalWidth, OriginalHeight = crop.OriginalHeight,
                        TrimOffsetX = crop.TrimOffsetX, TrimOffsetY = crop.TrimOffsetY,
                        MeshVertices = crop.MeshVertices, MeshIndices = crop.MeshIndices, PackingRotation = crop.PackingRotation }
                    : s;
            }).ToArray()
        }).ToArray();
        if (missingBundle + missingSprite + missingTexture > 0)
            diagnostics.Add(new("info", $"Sprite lookup: loaded {loaded.Count} assets; unresolved references: {missingBundle} bundle, {missingSprite} sprite, {pointerMissing} sprite texture pointer, {noTextureAsset} texture asset, {missingTexture - pointerMissing - noTextureAsset} texture bundle."));
        return scene with { Objects = objects, Diagnostics = diagnostics };
    }

    public Task<NamedSpriteSearchResult> FindNamedSpritesAsync(
        IReadOnlyCollection<string> placementIds, CancellationToken cancellationToken) =>
        Task.Run(() => FindNamedSprites(placementIds, cancellationToken), cancellationToken);

    private NamedSpriteSearchResult FindNamedSprites(IReadOnlyCollection<string> placementIds,
        CancellationToken cancellationToken) {
        var requested = placementIds.Select(NormalizeSpriteName).Where(value => value.Length >= 5)
            .Distinct(StringComparer.Ordinal).Take(150).ToArray();
        if (requested.Length == 0 || !_assetDirectories.Any(Directory.Exists))
            return new(new Dictionary<string, NamedSpriteAsset>(StringComparer.Ordinal), 0, 0);
        var aliases = requested.ToDictionary(name => name, SpriteNameAliases, StringComparer.Ordinal);
        var candidates = new Dictionary<string, (int Score, string PlacementId, string SpriteName, string SourceBundle, SceneSpriteReference Reference)>(StringComparer.Ordinal);
        var spriteIndex = GetOrBuildNamedSpriteIndex(cancellationToken, out var scannedBundles, out var bundleErrors);
        foreach (var sprite in spriteIndex.Sprites) {
            cancellationToken.ThrowIfCancellationRequested();
            foreach (var target in requested) {
                var score = SpriteNameMatchScore(sprite.NormalizedName, aliases[target]);
                if (score == 0 || (candidates.TryGetValue(target, out var previous) && previous.Score >= score)) continue;
                candidates[target] = (score, target, sprite.SpriteName, sprite.SourceBundle,
                    new SceneSpriteReference(sprite.PathId, 0, sprite.ExternalPath, sprite.SpriteName));
            }
        }

        if (requested.Any(name => name is "boneroller" or "rockroller")) {
            var sceneSprites = GetRockRollerIdleSprites(cancellationToken, out var sceneBundleErrors);
            bundleErrors += sceneBundleErrors;
            foreach (var sprite in sceneSprites) {
                cancellationToken.ThrowIfCancellationRequested();
                foreach (var target in requested.Where(name => name is "boneroller" or "rockroller")) {
                    // When a real idle frame and journal portrait both match,
                    // prefer the scene frame even if their normalized scores tie.
                    var score = SpriteNameMatchScore(sprite.NormalizedName, aliases[target]) + 1;
                    if (score == 0 || (candidates.TryGetValue(target, out var previous) && previous.Score >= score)) continue;
                    candidates[target] = (score, target, sprite.SpriteName, sprite.SourceBundle,
                        new SceneSpriteReference(sprite.PathId, 0, sprite.ExternalPath, sprite.SpriteName));
                }
            }
        }

        if (candidates.Count == 0)
            return new(new Dictionary<string, NamedSpriteAsset>(StringComparer.Ordinal), scannedBundles, bundleErrors);
        var references = candidates.Values.Select(candidate => candidate.Reference).ToArray();
        var placeholderObject = new SceneObject("enemy-art-catalog", "enemy-art-catalog", "", 0, true,
            new(0, 0, 0), new(0, 0, 0), [], [], references);
        var package = new ScenePackage(28, "enemy-art-catalog", "", 0, "", DateTimeOffset.UtcNow,
            DateTimeOffset.UtcNow, "unknown", false, [], [], [placeholderObject], [], [], null, []);
        var loaded = AttachAssets(package, cancellationToken).Objects[0].Sprites;
        var loadedByKey = loaded.Where(sprite => !string.IsNullOrWhiteSpace(sprite.ImageUrl))
            .GroupBy(sprite => $"{BundleKey(sprite.ExternalPath)}:{sprite.PathId}", StringComparer.OrdinalIgnoreCase)
            .ToDictionary(group => group.Key, group => group.First(), StringComparer.OrdinalIgnoreCase);
        var result = new Dictionary<string, NamedSpriteAsset>(StringComparer.Ordinal);
        foreach (var (key, candidate) in candidates) {
            var lookup = $"{BundleKey(candidate.Reference.ExternalPath)}:{candidate.Reference.PathId}";
            if (loadedByKey.TryGetValue(lookup, out var sprite))
                result[key] = new(candidate.PlacementId, candidate.SpriteName, candidate.SourceBundle, sprite);
        }
        return new(result, scannedBundles, bundleErrors);
    }

    private IndexedSpriteName[] GetRockRollerIdleSprites(CancellationToken cancellationToken,
        out int bundleErrors) {
        bundleErrors = 0;
        var scenePath = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(_assetOutputDirectory)!, "bone_01.json"));
        if (!File.Exists(scenePath)) return [];
        var stamp = new FileInfo(scenePath);
        lock (_namedSpriteIndexLock) {
            if (_rockRollerIdleSprites is not null &&
                string.Equals(_rockRollerIdleBundlePath, scenePath, StringComparison.OrdinalIgnoreCase) &&
                _rockRollerIdleBundleTicks == stamp.LastWriteTimeUtc.Ticks)
                return _rockRollerIdleSprites;

            try {
                cancellationToken.ThrowIfCancellationRequested();
                using var stream = File.OpenRead(scenePath);
                var package = JsonSerializer.Deserialize<ScenePackage>(stream,
                    new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
                var sprites = (package?.Objects ?? [])
                    .SelectMany(sceneObject => sceneObject.Sprites ?? [])
                    .Where(sprite => System.Text.RegularExpressions.Regex.IsMatch(
                        NormalizeSpriteName(sprite.Name), @"^rridle\d{4}$"))
                    .Select(sprite => new IndexedSpriteName(NormalizeSpriteName(sprite.Name), sprite.Name,
                        "animations_assets_areabone.bundle", sprite.PathId, sprite.ExternalPath))
                    .DistinctBy(sprite => (sprite.NormalizedName, sprite.PathId, sprite.ExternalPath))
                    .OrderBy(sprite => sprite.NormalizedName, StringComparer.Ordinal)
                    .ToArray();
                _rockRollerIdleSprites = sprites;
                _rockRollerIdleBundlePath = scenePath;
                _rockRollerIdleBundleTicks = stamp.LastWriteTimeUtc.Ticks;
                return _rockRollerIdleSprites;
            } catch {
                bundleErrors++;
                return [];
            }
        }
    }

    private NamedSpriteIndexCache GetOrBuildNamedSpriteIndex(CancellationToken cancellationToken,
        out int scannedBundles, out int bundleErrors) {
        lock (_namedSpriteIndexLock) {
            if (_namedSpriteIndex is not null) {
                scannedBundles = _namedSpriteIndex.Bundles.Length;
                bundleErrors = _namedSpriteIndex.BundleErrors;
                return _namedSpriteIndex;
            }

            var spriteAtlasDirectory = _assetDirectories.FirstOrDefault(directory =>
                Path.GetFileName(directory).Equals("_atlases", StringComparison.OrdinalIgnoreCase) && Directory.Exists(directory));
            var searchDirectories = _assetDirectories.Where(Directory.Exists).ToArray();
            var atlasPrefix = spriteAtlasDirectory is null ? null :
                Path.GetFullPath(spriteAtlasDirectory).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
            var bundles = searchDirectories
                .SelectMany(directory => Directory.EnumerateFiles(directory, "*.bundle", SearchOption.AllDirectories))
                .Where(path => (atlasPrefix is not null && Path.GetFullPath(path).StartsWith(atlasPrefix, StringComparison.OrdinalIgnoreCase)) || IsSpriteSearchBundle(path))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .OrderBy(path => IsJournalSpriteBundle(path) ? 1 : 0)
                .ThenBy(path => Path.GetFileName(path), StringComparer.OrdinalIgnoreCase)
                .ToArray();
            var bundleStamps = bundles.Select(path => {
                var file = new FileInfo(path);
                return new SpriteBundleStamp(file.FullName, file.Length, file.LastWriteTimeUtc.Ticks);
            }).ToArray();
            var cachePath = Path.Combine(_assetOutputDirectory, "enemy-sprite-name-index.json");
            Directory.CreateDirectory(_assetOutputDirectory);
            var hasCachedIndex = TryLoadNamedSpriteIndex(cachePath, bundleStamps, out var cached);
            var indexedBundlePaths = hasCachedIndex
                ? cached.Bundles.Select(stamp => stamp.Path).ToHashSet(StringComparer.OrdinalIgnoreCase)
                : new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var bundlesToScan = bundles.Where(path => !indexedBundlePaths.Contains(path)).ToArray();
            var sprites = hasCachedIndex ? cached.Sprites.ToList() : new List<IndexedSpriteName>();
            bundleErrors = hasCachedIndex ? cached.BundleErrors : 0;
            foreach (var bundlePath in bundlesToScan) {
                cancellationToken.ThrowIfCancellationRequested();
                var manager = new AssetsManager();
                try {
                    var bundle = manager.LoadBundleFile(bundlePath, true);
                    var embeddedFiles = bundle.file.GetAllFileNames();
                    for (var fileIndex = 0; fileIndex < embeddedFiles.Count; fileIndex++) {
                        cancellationToken.ThrowIfCancellationRequested();
                        AssetsFileInstance assetsFile;
                        try { assetsFile = manager.LoadAssetsFileFromBundle(bundle, fileIndex, false); }
                        catch { continue; }
                        if (assetsFile is null || assetsFile.file is null) continue;
                        try {
                            foreach (var info in assetsFile.file.GetAssetsOfType(AssetClassID.Sprite)) {
                                cancellationToken.ThrowIfCancellationRequested();
                                try {
                                    var sprite = manager.GetBaseField(assetsFile, info);
                                    var spriteName = StringField(sprite, "m_Name", "");
                                    var normalizedName = NormalizeSpriteName(spriteName);
                                    if (normalizedName.Length == 0) continue;
                                    var embeddedName = embeddedFiles[fileIndex];
                                    var externalPath = embeddedName.StartsWith("archive:/", StringComparison.OrdinalIgnoreCase)
                                        ? embeddedName : $"archive:/{Path.GetFileName(embeddedName).Split('.')[0]}/{Path.GetFileName(embeddedName).Split('.')[0]}";
                                    sprites.Add(new(normalizedName, spriteName, Path.GetFileName(bundlePath),
                                        info.PathId, externalPath));
                                } catch { /* Skip damaged Sprite objects and keep indexing the bundle. */ }
                            }
                        } catch { /* Resource-only entries expose no serialized Sprite table. */ }
                    }
                } catch { bundleErrors++; /* Skip addressable bundles this reader cannot enumerate. */ }
                finally {
                    try { manager.UnloadAllAssetsFiles(true); } catch { }
                    try { manager.UnloadAllBundleFiles(); } catch { }
                }
            }

            var index = new NamedSpriteIndexCache(2, bundleStamps, sprites.ToArray(), bundleErrors);
            var temporaryPath = cachePath + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try {
                var options = new JsonSerializerOptions { WriteIndented = false };
                using (var stream = new FileStream(temporaryPath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                    JsonSerializer.Serialize(stream, index, options);
                File.Move(temporaryPath, cachePath, overwrite: true);
            } finally {
                if (File.Exists(temporaryPath)) File.Delete(temporaryPath);
            }
            _namedSpriteIndex = index;
            scannedBundles = bundles.Length;
            return index;
        }
    }

    private static bool TryLoadNamedSpriteIndex(string path, IReadOnlyList<SpriteBundleStamp> bundles,
        out NamedSpriteIndexCache index) {
        index = default!;
        if (!File.Exists(path)) return false;
        try {
            using var stream = File.OpenRead(path);
            var cached = JsonSerializer.Deserialize<NamedSpriteIndexCache>(stream);
            if (cached is null || cached.FormatVersion is < 1 or > 2) return false;
            var currentByPath = bundles.ToDictionary(stamp => stamp.Path, StringComparer.OrdinalIgnoreCase);
            if (cached.Bundles.Any(stamp => !currentByPath.TryGetValue(stamp.Path, out var current) || current != stamp)) return false;
            index = cached;
            return true;
        } catch (IOException) { return false; }
        catch (JsonException) { return false; }
    }

    private static bool IsJournalSpriteBundle(string path) {
        var name = Path.GetFileName(path);
        return name.Equals("journal_enemy_images.spriteatlas.bundle", StringComparison.OrdinalIgnoreCase) ||
            name.Equals("journal_enemy_icons.spriteatlas.bundle", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsSpriteSearchBundle(string path) {
        return IsJournalSpriteBundle(path) ||
            Path.GetFileName(path).StartsWith("animations_assets_", StringComparison.OrdinalIgnoreCase);
    }

    private sealed record SpriteBundleStamp(string Path, long Length, long LastWriteUtcTicks);
    private sealed record IndexedSpriteName(string NormalizedName, string SpriteName, string SourceBundle,
        long PathId, string ExternalPath);
    private sealed record NamedSpriteIndexCache(int FormatVersion, SpriteBundleStamp[] Bundles,
        IndexedSpriteName[] Sprites, int BundleErrors);

    private static string NormalizeSpriteName(string value) {
        var withoutPrefix = value.StartsWith("prefab_", StringComparison.OrdinalIgnoreCase) ? value[7..] : value;
        return new(withoutPrefix.Where(char.IsLetterOrDigit).Select(char.ToLowerInvariant).ToArray());
    }

    private static string[] SpriteNameAliases(string normalized) {
        var aliases = new List<string> { normalized };
        if (KnownEnemySpriteAliases.TryGetValue(normalized, out var known)) aliases.AddRange(known);
        if (normalized.Length > 5 && normalized[0] == 'g') aliases.Add(normalized[1..]);
        // Many game animation bundles label their first animation frame with
        // the enemy's normalized placement name followed by idle0000.
        aliases.Add(normalized + "idle0000");
        if (normalized.Length > 5 && normalized[0] == 'g') aliases.Add(normalized[1..] + "idle0000");
        return aliases.Distinct(StringComparer.Ordinal).ToArray();
    }

    private static int SpriteNameMatchScore(string spriteName, IReadOnlyList<string> aliases) {
        var best = 0;
        foreach (var alias in aliases) {
            if (spriteName == alias) best = Math.Max(best, 1000 + alias.Length);
            else if (spriteName.StartsWith(alias, StringComparison.Ordinal)) {
                var suffix = spriteName.AsSpan(alias.Length);
                var idleFrame = suffix.StartsWith("idle", StringComparison.Ordinal) &&
                    (suffix.Length == 4 || char.IsAsciiDigit(suffix[4]));
                best = Math.Max(best, (idleFrame ? 1400 : 800) + alias.Length);
            }
            else if (alias.Length >= 9 && spriteName.Contains(alias, StringComparison.Ordinal)) best = Math.Max(best, 500 + alias.Length);
        }
        if (best > 0 && (spriteName.EndsWith("0000", StringComparison.Ordinal) || spriteName.Contains("idle", StringComparison.Ordinal))) best += 5;
        return best;
    }

    public ScenePackage AttachMeshAssets(ScenePackage scene, CancellationToken cancellationToken) {
        var all = (scene.Objects ?? []).SelectMany(o => o.Meshes ?? [])
            .Where(mesh => mesh.MaterialPathId != 0 && !string.IsNullOrWhiteSpace(mesh.MaterialExternalPath))
            .ToArray();
        if (all.Length == 0 || !_assetDirectories.Any(Directory.Exists)) return scene;
        Directory.CreateDirectory(_assetOutputDirectory);
        var materialKeys = all.Select(mesh => BundleKey(mesh.MaterialExternalPath))
            .Where(key => key.Length > 0).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var index = GetLocations(materialKeys);
        var manager = new AssetsManager();
        var textureImages = new Dictionary<string, (string Url, int Width, int Height)>(StringComparer.OrdinalIgnoreCase);
        var materials = new Dictionary<string, MeshMaterialData>(StringComparer.OrdinalIgnoreCase);
        var diagnostics = scene.Diagnostics.ToList();
        var unresolved = 0;

        foreach (var reference in all.DistinctBy(mesh => (BundleKey(mesh.MaterialExternalPath), mesh.MaterialPathId))) {
            cancellationToken.ThrowIfCancellationRequested();
            var bundleKey = BundleKey(reference.MaterialExternalPath);
            if (!index.TryGetValue(bundleKey, out var location)) { unresolved++; continue; }
            var materialKey = $"{bundleKey}:{reference.MaterialPathId}";
            if (materials.ContainsKey(materialKey)) continue;
            try {
                var bundle = manager.LoadBundleFile(location.BundlePath, true);
                var materialFile = manager.LoadAssetsFileFromBundle(bundle, location.FileIndex, false);
                var materialInfo = materialFile.file.GetAssetInfo(reference.MaterialPathId);
                if (materialInfo is null) { unresolved++; continue; }
                var material = manager.GetBaseField(materialFile, materialInfo);
                var textureEntry = Field(material, "m_SavedProperties", "m_TexEnvs", "Array")?.Children
                    .FirstOrDefault(entry => StringValue(Field(entry, "first")) == "_MainTex");
                if (textureEntry is null) { unresolved++; continue; }
                var textureEnv = Field(textureEntry, "second");
                var texturePointer = Field(textureEnv, "m_Texture");
                if (texturePointer is null) { unresolved++; continue; }
                var texturePathId = LongField(texturePointer, "m_PathID");
                var textureFileId = (int)LongField(texturePointer, "m_FileID");
                if (texturePathId == 0) { unresolved++; continue; }
                var textureFile = materialFile;
                var textureExternal = "";
                if (textureFileId > 0 && textureFileId <= materialFile.file.Metadata.Externals.Count) {
                    textureExternal = materialFile.file.Metadata.Externals[textureFileId - 1].PathName ?? "";
                    var textureKey = BundleKey(textureExternal);
                    var textureLocations = GetLocations(new HashSet<string>([textureKey], StringComparer.OrdinalIgnoreCase));
                    if (!textureLocations.TryGetValue(textureKey, out var textureLocation)) { unresolved++; continue; }
                    var textureBundle = manager.LoadBundleFile(textureLocation.BundlePath, true);
                    textureFile = manager.LoadAssetsFileFromBundle(textureBundle, textureLocation.FileIndex, false);
                }
                var textureCacheKey = textureFileId > 0
                    ? $"{textureExternal}:{texturePathId}"
                    : $"{location.BundlePath}:{location.FileIndex}:{texturePathId}";
                if (!textureImages.TryGetValue(textureCacheKey, out var image)) {
                    var textureInfo = textureFile.file.GetAssetInfo(texturePathId);
                    if (textureInfo is null) { unresolved++; continue; }
                    var textureBase = manager.GetBaseField(textureFile, textureInfo);
                    var texture = TextureFile.ReadTextureFile(textureBase);
                    var pixels = texture.DecodeTextureRaw(texture.FillPictureData(textureFile), true);
                    if (pixels is null || pixels.Length < texture.m_Width * texture.m_Height * 4) { unresolved++; continue; }
                    var png = EncodeRgbaPng(pixels, texture.m_Width, texture.m_Height);
                    var hash = Convert.ToHexString(SHA256.HashData(png)).ToLowerInvariant();
                    var fileName = hash + ".png";
                    var outputPath = Path.Combine(_assetOutputDirectory, fileName);
                    if (!File.Exists(outputPath)) File.WriteAllBytes(outputPath, png);
                    image = ("/api/artwork/" + fileName, texture.m_Width, texture.m_Height);
                    textureImages[textureCacheKey] = image;
                }
                var scale = Field(textureEnv, "m_Scale");
                var offset = Field(textureEnv, "m_Offset");
                var color = ReadMaterialColor(material);
                materials[materialKey] = new(image.Url, image.Width, image.Height,
                    FloatField(scale, "x", 1), FloatField(scale, "y", 1),
                    FloatField(offset, "x"), FloatField(offset, "y"),
                    StringField(material, "m_Name", "material"), color.R, color.G, color.B, color.A,
                    ReadBlendMode(material));
            } catch (Exception exception) when (exception is not OperationCanceledException) {
                diagnostics.Add(new("warning", $"Could not extract mesh material {bundleKey}:{reference.MaterialPathId}: {exception.Message}"));
            }
        }

        var objects = (scene.Objects ?? []).Select(sceneObject => sceneObject with {
            Meshes = (sceneObject.Meshes ?? []).Select(mesh => {
                var key = $"{BundleKey(mesh.MaterialExternalPath)}:{mesh.MaterialPathId}";
                return materials.TryGetValue(key, out var material)
                    ? mesh with { ImageUrl = material.ImageUrl, TextureWidth = material.Width, TextureHeight = material.Height,
                        TextureScaleX = material.ScaleX, TextureScaleY = material.ScaleY, TextureOffsetX = material.OffsetX,
                        TextureOffsetY = material.OffsetY, MaterialName = material.Name, TintR = material.R, TintG = material.G,
                        TintB = material.B, TintA = material.A, BlendMode = material.BlendMode }
                    : mesh;
            }).ToArray()
        }).ToArray();
        if (unresolved > 0) diagnostics.Add(new("info", $"Mesh material lookup: attached {materials.Count} textured materials; {unresolved} material or texture references could not be resolved."));
        return scene with { Objects = objects, Diagnostics = diagnostics };
    }

    public ScenePackage AttachSpriteMaterials(ScenePackage scene, CancellationToken cancellationToken) {
        var all = (scene.Objects ?? []).SelectMany(o => o.Sprites ?? [])
            .Where(sprite => sprite.MaterialPathId != 0 && !string.IsNullOrWhiteSpace(sprite.MaterialExternalPath)).ToArray();
        if (all.Length == 0 || !_assetDirectories.Any(Directory.Exists)) return scene;
        var wanted = all.Select(sprite => BundleKey(sprite.MaterialExternalPath)).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var index = GetLocations(wanted); var manager = new AssetsManager();
        var data = new Dictionary<string, SpriteMaterialData>(StringComparer.OrdinalIgnoreCase);
        var diagnostics = scene.Diagnostics.ToList(); var unresolved = 0;
        foreach (var reference in all.DistinctBy(sprite => (BundleKey(sprite.MaterialExternalPath), sprite.MaterialPathId))) {
            cancellationToken.ThrowIfCancellationRequested();
            var bundleKey = BundleKey(reference.MaterialExternalPath);
            if (!index.TryGetValue(bundleKey, out var location)) { unresolved++; continue; }
            var key = $"{bundleKey}:{reference.MaterialPathId}";
            try {
                var bundle = manager.LoadBundleFile(location.BundlePath, true);
                var assetsFile = manager.LoadAssetsFileFromBundle(bundle, location.FileIndex, false);
                var info = assetsFile.file.GetAssetInfo(reference.MaterialPathId);
                if (info is null) { unresolved++; continue; }
                var material = manager.GetBaseField(assetsFile, info);
                var color = ReadMaterialColor(material);
                data[key] = new(ReadBlendMode(material), color.R, color.G, color.B, color.A,
                    StringField(material, "m_Name", ""));
            } catch (Exception exception) when (exception is not OperationCanceledException) {
                diagnostics.Add(new("warning", $"Could not read SpriteRenderer material {bundleKey}:{reference.MaterialPathId}: {exception.Message}"));
            }
        }
        var objects = (scene.Objects ?? []).Select(sceneObject => sceneObject with {
            Sprites = (sceneObject.Sprites ?? []).Select(sprite => {
                var key = $"{BundleKey(sprite.MaterialExternalPath)}:{sprite.MaterialPathId}";
                return data.TryGetValue(key, out var material)
                    ? sprite with { BlendMode = material.BlendMode, MaterialTintR = material.R,
                        MaterialTintG = material.G, MaterialTintB = material.B, MaterialTintA = material.A,
                        MaterialName = material.Name }
                    : sprite;
            }).ToArray()
        }).ToArray();
        if (unresolved > 0) diagnostics.Add(new("info", $"Sprite material lookup: applied saved blend/tint settings for {data.Count} materials; {unresolved} material references could not be resolved."));
        return scene with { Objects = objects, Diagnostics = diagnostics };
    }

    public ScenePackage AttachScriptNames(ScenePackage scene, CancellationToken cancellationToken) {
        var all = (scene.Objects ?? []).SelectMany(obj => obj.Components ?? [])
            .Where(component => component.Type == "MonoBehaviour" && component.ScriptPathId != 0 &&
                !string.IsNullOrWhiteSpace(component.ScriptExternalPath) && string.IsNullOrWhiteSpace(component.ScriptName))
            .ToArray();
        if (all.Length == 0 || !_assetDirectories.Any(Directory.Exists)) return scene;
        var wanted = all.Select(component => BundleKey(component.ScriptExternalPath ?? ""))
            .Where(key => key.Length > 0).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var index = GetLocations(wanted); var manager = new AssetsManager();
        var names = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var component in all.DistinctBy(item => (BundleKey(item.ScriptExternalPath ?? ""), item.ScriptPathId))) {
            cancellationToken.ThrowIfCancellationRequested();
            var bundleKey = BundleKey(component.ScriptExternalPath ?? "");
            if (!index.TryGetValue(bundleKey, out var location)) continue;
            try {
                var bundle = manager.LoadBundleFile(location.BundlePath, true);
                var assetsFile = manager.LoadAssetsFileFromBundle(bundle, location.FileIndex, false);
                var info = assetsFile.file.GetAssetInfo(component.ScriptPathId);
                if (info is null) continue;
                var script = manager.GetBaseField(assetsFile, info);
                var className = StringField(script, "m_ClassName", "");
                var ns = StringField(script, "m_Namespace", "");
                var name = className.Length > 0 ? (ns.Length > 0 ? $"{ns}.{className}" : className)
                    : StringField(script, "m_Name", "");
                if (name.Length > 0) names[$"{bundleKey}:{component.ScriptPathId}"] = name;
            } catch { /* Script metadata improves inspection, but must not prevent room rendering. */ }
        }
        var objects = (scene.Objects ?? []).Select(sceneObject => sceneObject with {
            Components = (sceneObject.Components ?? []).Select(component => {
                var key = $"{BundleKey(component.ScriptExternalPath ?? "")}:{component.ScriptPathId}";
                return string.IsNullOrWhiteSpace(component.ScriptName) && names.TryGetValue(key, out var name)
                    ? component with { ScriptName = name }
                    : component;
            }).ToArray()
        }).ToArray();
        return scene with { Objects = objects };
    }

    private Dictionary<string, BundleLocation> GetLocations(HashSet<string> wanted) {
        lock (_indexLock) {
            var existingDirectories = _assetDirectories.Where(Directory.Exists)
                .Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
            if (existingDirectories.Length == 0) return _bundleIndex;
            var missing = wanted.Where(k => !_bundleIndex.ContainsKey(k)).ToHashSet(StringComparer.OrdinalIgnoreCase);
            if (missing.Count == 0) return _bundleIndex;
            var animationBundlePath = Path.Combine(
                Directory.GetParent(_sceneBundleDirectory())?.FullName ?? _sceneBundleDirectory(),
                "animations_assets_areabone.bundle");
            var bundleFiles = existingDirectories.SelectMany(directory =>
                    Directory.EnumerateFiles(directory, "*.bundle", SearchOption.AllDirectories))
                .Concat(_assetDirectories.Where(path => File.Exists(path) &&
                    Path.GetExtension(path).Equals(".bundle", StringComparison.OrdinalIgnoreCase)))
                .Concat(File.Exists(animationBundlePath) ? [animationBundlePath] : [])
                .Distinct(StringComparer.OrdinalIgnoreCase);
            foreach (var path in bundleFiles) {
                if (FindKeys(path, missing).Count == 0 || !_loadedCandidates.Add(path)) continue;
                try {
                    var manager = new AssetsManager();
                    var bundle = manager.LoadBundleFile(path, true);
                    var names = bundle.file.GetAllFileNames();
                    for (var i = 0; i < names.Count; i++) {
                        var key = Path.GetFileName(names[i]).Split('.')[0];
                        if (key.StartsWith("CAB-", StringComparison.OrdinalIgnoreCase)) _bundleIndex.TryAdd(key, new(path, i));
                    }
                    missing.ExceptWith(_bundleIndex.Keys);
                    if (missing.Count == 0) break;
                } catch { /* Ignore unreadable files; later dependencies may still resolve. */ }
            }
            return _bundleIndex;
        }
    }
    private static HashSet<string> FindKeys(string path, HashSet<string> wanted) {
        var found = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var carry = Array.Empty<byte>(); var buffer = new byte[1024 * 1024];
        using var stream = File.OpenRead(path);
        int read;
        while ((read = stream.Read(buffer, 0, buffer.Length)) > 0) {
            var data = new byte[carry.Length + read]; carry.CopyTo(data, 0); Buffer.BlockCopy(buffer, 0, data, carry.Length, read);
            var remaining = data.AsSpan();
            while (true) {
                var offset = remaining.IndexOf("CAB-"u8);
                if (offset < 0) break;
                if (remaining.Length - offset >= 36) {
                    var candidate = Encoding.ASCII.GetString(remaining.Slice(offset, 36));
                    if (wanted.Contains(candidate)) found.Add(candidate);
                }
                remaining = remaining[(offset + 4)..];
            }
            const int carryLength = 40;
            var keep = Math.Min(carryLength, data.Length); carry = data.AsSpan(data.Length - keep, keep).ToArray();
            if (found.Count == wanted.Count) break;
        }
        return found;
    }

    private static string BundleKey(string path) {
        var leaf = path.Replace('\\', '/').Split('/').LastOrDefault() ?? "";
        return leaf.Split('.')[0];
    }
    private static AssetTypeValueField? Field(AssetTypeValueField? root, params string[] path) {
        try {
            foreach (var name in path) {
                root = root![name];
                if (root.IsDummy) return null;
            }
            return root;
        } catch { return null; }
    }
    private static float FloatField(AssetTypeValueField? root, string name, float fallback = 0) {
        try { return root![name].AsFloat; } catch { return fallback; }
    }
    private static long LongField(AssetTypeValueField root, string name) {
        try { return root[name].AsLong; } catch { try { return root[name].AsInt; } catch { return 0; } }
    }
    private static uint UIntField(AssetTypeValueField? field) {
        try { return field!.AsUInt; } catch { try { return unchecked((uint)field!.AsInt); } catch { return 0; } }
    }
    private static string StringValue(AssetTypeValueField? field) {
        try { return field?.AsString ?? ""; } catch { return ""; }
    }
    private static (float R, float G, float B, float A) ReadMaterialColor(AssetTypeValueField material) {
        try {
            var entry = Field(material, "m_SavedProperties", "m_Colors", "Array")?.Children
                .FirstOrDefault(item => StringValue(Field(item, "first")) == "_Color");
            var value = Field(entry, "second");
            if (value is null) return (1, 1, 1, 1);
            return (FloatField(value, "r", 1), FloatField(value, "g", 1),
                FloatField(value, "b", 1), FloatField(value, "a", 1));
        } catch { return (1, 1, 1, 1); }
    }
    private static string ReadBlendMode(AssetTypeValueField material) {
        var properties = Field(material, "m_SavedProperties", "m_Floats", "Array")?.Children;
        if (properties is null) return "normal";
        var values = properties.ToDictionary(entry => StringValue(Field(entry, "first")),
            entry => FloatField(Field(entry, "second"), "value", FloatValue(Field(entry, "second"))), StringComparer.OrdinalIgnoreCase);
        var source = values.GetValueOrDefault("_SrcBlend", 5);
        var destination = values.GetValueOrDefault("_DstBlend", 10);
        if ((source == 1 && destination == 1) || (source == 5 && destination == 1)) return "additive";
        if (source == 2 && destination == 0) return "multiply";
        if (source == 0 && destination == 1) return "destination";
        return "normal";
    }
    private static float FloatValue(AssetTypeValueField? field) {
        try { return field!.AsFloat; } catch { try { return field!.AsInt; } catch { return float.NaN; } }
    }
    private static (IReadOnlyList<SpriteMeshVertex> Vertices, IReadOnlyList<int> Indices) ReadSpriteMesh(AssetTypeValueField? renderData) {
        try {
            var vertexData = Field(renderData, "m_VertexData");
            var vertexCount = (int)LongField(vertexData!, "m_VertexCount");
            var channels = Field(vertexData, "m_Channels", "Array")?.Children;
            var data = Field(vertexData, "m_DataSize")?.Value?.AsByteArray;
            if (vertexCount < 3 || channels is null || data is null) return ([], []);
            var positionChannel = channels.Select(ChannelValue).FirstOrDefault(channel =>
                LongField(channel!, "dimension") >= 2 && LongField(channel!, "format") == 0);
            if (positionChannel is null) return ([], []);
            var positionStream = (int)LongField(positionChannel, "stream");
            var positionOffset = (int)LongField(positionChannel, "offset");
            var dimension = (int)LongField(positionChannel, "dimension");
            var streamStrides = new int[8];
            foreach (var channelEntry in channels) {
                var channel = ChannelValue(channelEntry);
                if (channel is null) continue;
                var channelDimension = (int)LongField(channel, "dimension");
                if (channelDimension == 0) continue;
                var channelStream = (int)LongField(channel, "stream");
                var componentBytes = FormatByteSize((int)LongField(channel, "format"));
                if (channelStream < 0 || channelStream >= streamStrides.Length || componentBytes == 0) continue;
                streamStrides[channelStream] = Math.Max(streamStrides[channelStream], (int)LongField(channel, "offset") + channelDimension * componentBytes);
            }
            var streamStart = 0;
            for (var stream = 0; stream < positionStream; stream++) streamStart += Align16(streamStrides[stream] * vertexCount);
            var positionSize = FormatByteSize((int)LongField(positionChannel, "format"));
            var elementStride = streamStrides[positionStream];
            if (positionSize != 4 || dimension < 2 || elementStride < positionOffset + 8 || streamStart + (vertexCount - 1) * elementStride + positionOffset + 8 > data.Length)
                return ([], []);
            var vertices = new SpriteMeshVertex[vertexCount];
            for (var index = 0; index < vertexCount; index++) {
                var start = streamStart + index * elementStride + positionOffset;
                var x = BitConverter.ToSingle(data, start);
                var y = BitConverter.ToSingle(data, start + 4);
                if (!float.IsFinite(x) || !float.IsFinite(y)) return ([], []);
                vertices[index] = new(x, y);
            }
            var indexBytes = Field(renderData, "m_IndexBuffer", "Array")?.Value?.AsByteArray;
            var submesh = Field(renderData, "m_SubMeshes", "Array")?.Children.FirstOrDefault();
            if (indexBytes is null || submesh is null) return (vertices, []);
            var firstByte = (int)LongField(submesh, "firstByte");
            var indexCount = (int)LongField(submesh, "indexCount");
            var indicesPerVertex = vertexCount > 65_535 ? 4 : 2;
            if (firstByte < 0 || indexCount < 3 || firstByte + indexCount * indicesPerVertex > indexBytes.Length) return (vertices, []);
            var indices = new int[indexCount];
            for (var i = 0; i < indexCount; i++)
                indices[i] = indicesPerVertex == 2
                    ? System.Buffers.Binary.BinaryPrimitives.ReadUInt16LittleEndian(indexBytes.AsSpan(firstByte + i * 2, 2))
                    : (int)System.Buffers.Binary.BinaryPrimitives.ReadUInt32LittleEndian(indexBytes.AsSpan(firstByte + i * 4, 4));
            return (vertices, indices);
        } catch { return ([], []); }
    }
    private static int FormatByteSize(int format) => format switch { 0 or 4 or 5 or 8 or 9 => 4, 2 or 3 or 6 or 7 => 1, 1 => 2, _ => 0 };
    private static int Align16(int value) => (value + 15) & ~15;
    private static AssetTypeValueField? ChannelValue(AssetTypeValueField field) =>
        Field(field, "stream") is not null ? field : Field(field, "data");
    private static string StringField(AssetTypeValueField root, string name, string fallback) {
        try { return root[name].AsString; } catch { return fallback; }
    }
    private static AssetTypeValueField? FindAtlasRenderData(AssetTypeValueField sprite, AssetsFileInstance sourceFile, AssetsManager manager) {
        try {
            var atlasPointer = Field(sprite, "m_SpriteAtlas");
            if (atlasPointer is null) return null;
            var atlasPathId = LongField(atlasPointer, "m_PathID");
            if (atlasPathId == 0) return null;
            var atlasFileId = (int)LongField(atlasPointer, "m_FileID");
            if (atlasFileId != 0) return null;
            var atlasInfo = sourceFile.file.GetAssetInfo(atlasPathId);
            if (atlasInfo is null) return null;
            var atlas = manager.GetBaseField(sourceFile, atlasInfo);
            var renderData = Field(atlas, "m_RenderDataMap", "Array");
            if (renderData is null) return null;
            var wantedKey = Field(sprite, "m_RenderDataKey");
            if (wantedKey is null) return null;
            foreach (var entry in renderData.Children) {
                var entryKey = Field(entry, "first");
                if (entryKey is not null && SameSerializedValue(entryKey, wantedKey))
                    return Field(entry, "second");
            }
        } catch { }
        return null;
    }

    private static bool SameSerializedValue(AssetTypeValueField left, AssetTypeValueField right) {
        if (left.Children.Count > 0 || right.Children.Count > 0)
            return left.Children.Count == right.Children.Count && left.Children.Zip(right.Children).All(pair =>
                pair.First.FieldName == pair.Second.FieldName && SameSerializedValue(pair.First, pair.Second));
        try { return left.AsUInt == right.AsUInt; } catch { }
        try { return left.AsLong == right.AsLong; } catch { }
        try { return left.AsFloat.Equals(right.AsFloat); } catch { }
        try { return left.AsString == right.AsString; } catch { }
        return false;
    }

    private static byte[] EncodeRgbaPng(byte[] bgra, int width, int height) {
        var scanlines = new byte[checked((width * 4 + 1) * height)];
        for (var y = 0; y < height; y++) {
            var target = y * (width * 4 + 1); scanlines[target] = 0;
            var sourceY = height - 1 - y;
            for (var x = 0; x < width; x++) {
                var source = (sourceY * width + x) * 4; var destination = target + 1 + x * 4;
                scanlines[destination] = bgra[source + 2]; scanlines[destination + 1] = bgra[source + 1];
                scanlines[destination + 2] = bgra[source]; scanlines[destination + 3] = bgra[source + 3];
            }
        }
        using var output = new MemoryStream();
        output.Write(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 });
        var header = new byte[13]; WriteInt(header, 0, width); WriteInt(header, 4, height); header[8] = 8; header[9] = 6;
        WriteChunk(output, "IHDR", header);
        using var compressed = new MemoryStream();
        using (var zlib = new ZLibStream(compressed, CompressionLevel.Fastest, true)) zlib.Write(scanlines);
        WriteChunk(output, "IDAT", compressed.ToArray()); WriteChunk(output, "IEND", Array.Empty<byte>());
        return output.ToArray();
    }
    private static void WriteChunk(Stream output, string name, byte[] data) {
        var type = Encoding.ASCII.GetBytes(name); Span<byte> length = stackalloc byte[4];
        System.Buffers.Binary.BinaryPrimitives.WriteInt32BigEndian(length, data.Length); output.Write(length); output.Write(type); output.Write(data);
        var crcBuffer = new byte[type.Length + data.Length]; type.CopyTo(crcBuffer, 0); data.CopyTo(crcBuffer, type.Length);
        Span<byte> crc = stackalloc byte[4]; System.Buffers.Binary.BinaryPrimitives.WriteUInt32BigEndian(crc, Crc32(crcBuffer)); output.Write(crc);
    }
    private static uint Crc32(ReadOnlySpan<byte> data) {
        uint crc = 0xffffffff;
        foreach (var b in data) { crc ^= b; for (var i = 0; i < 8; i++) crc = (crc >> 1) ^ (0xedb88320u & (uint)-(int)(crc & 1)); }
        return ~crc;
    }
    private static void WriteInt(byte[] data, int offset, int value) => System.Buffers.Binary.BinaryPrimitives.WriteInt32BigEndian(data.AsSpan(offset, 4), value);
    private sealed record BundleLocation(string BundlePath, int FileIndex);
    private sealed record MeshMaterialData(string ImageUrl, int Width, int Height, float ScaleX, float ScaleY,
        float OffsetX, float OffsetY, string Name, float R, float G, float B, float A, string BlendMode);
    private sealed record SpriteMaterialData(string BlendMode, float R, float G, float B, float A, string Name);
}
