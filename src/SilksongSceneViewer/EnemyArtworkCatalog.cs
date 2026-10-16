namespace SilksongSceneViewer;

internal sealed record EnemyArtworkEntry(string PlacementId, string ObjectName, string SourceBundle,
    float OffsetX, float OffsetY, SceneSpriteReference Sprite);

internal sealed record EnemyArtworkLookup(IReadOnlyDictionary<string, EnemyArtworkEntry> Artwork,
    int BundlesScanned, int BundleErrors, int UnmatchedNames);

internal sealed class EnemyArtworkCatalog {
    private readonly SpriteAssetLoader _spriteAssets;
    private readonly SemaphoreSlim _scanLock = new(1, 1);
    private readonly Dictionary<string, EnemyArtworkEntry> _artwork = new(StringComparer.Ordinal);
    private readonly HashSet<string> _attempted = new(StringComparer.Ordinal);

    public EnemyArtworkCatalog(SpriteAssetLoader spriteAssets) => _spriteAssets = spriteAssets;

    public async Task<EnemyArtworkLookup> FindAsync(IReadOnlyCollection<string> placementIds,
        CancellationToken cancellationToken) {
        var requested = placementIds.Select(Normalize).Where(value => value.Length >= 5)
            .Distinct(StringComparer.Ordinal).Take(150).ToArray();
        var scanned = 0; var errors = 0;

        await _scanLock.WaitAsync(cancellationToken);
        try {
            var pending = requested.Where(name => !_artwork.ContainsKey(name) && !_attempted.Contains(name)).ToArray();
            if (pending.Length > 0) {
                var result = await _spriteAssets.FindNamedSpritesAsync(pending, cancellationToken);
                scanned = result.BundlesScanned; errors = result.BundleErrors;
                foreach (var name in pending) {
                    if (result.Assets.TryGetValue(name, out var sprite))
                        _artwork[name] = new(name, sprite.SpriteName, sprite.SourceBundle, 0, 0, sprite.Sprite);
                    _attempted.Add(name);
                }
            }
            var found = requested.Where(_artwork.ContainsKey)
                .ToDictionary(name => name, name => _artwork[name], StringComparer.Ordinal);
            return new(found, scanned, errors, requested.Length - found.Count);
        } finally {
            _scanLock.Release();
        }
    }

    private static string Normalize(string value) {
        var withoutPrefix = value.StartsWith("prefab_", StringComparison.OrdinalIgnoreCase) ? value[7..] : value;
        return new(withoutPrefix.Where(char.IsLetterOrDigit).Select(char.ToLowerInvariant).ToArray());
    }
}
