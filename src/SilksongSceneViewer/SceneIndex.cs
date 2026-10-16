using System.Globalization;

namespace SilksongSceneViewer;

internal sealed record SortingLayerDefinition(int Id, int Value, string Name);

internal sealed record SceneBundleEntry(string Id, string CandidateName, string BundleFile, long FileBytes,
    DateTimeOffset LastWrittenUtc, string Kind);

internal sealed class SceneSourceOptions {
    private readonly string _packageDirectory;
    private string _sceneBundleDirectory;
    private string? _sortingLayerSettingsPath;
    private IReadOnlyList<SortingLayerDefinition> _sortingLayers;
    public IReadOnlyList<string> ArtworkBundleDirectories { get; }
    public string? MapBundlePath { get; }
    public string? SortingLayerSettingsPath => Volatile.Read(ref _sortingLayerSettingsPath);
    public IReadOnlyList<SortingLayerDefinition> SortingLayers => Volatile.Read(ref _sortingLayers);

    public SceneSourceOptions(string sceneBundleDirectory, string packageDirectory, IReadOnlyList<string> artworkBundleDirectories,
        string? fallbackSortingLayerSettingsPath = null, string? mapBundlePath = null) {
        _sceneBundleDirectory = Path.GetFullPath(sceneBundleDirectory);
        _packageDirectory = Path.GetFullPath(packageDirectory);
        ArtworkBundleDirectories = artworkBundleDirectories.Select(Path.GetFullPath).ToArray();
        MapBundlePath = mapBundlePath is { Length: > 0 } ? Path.GetFullPath(mapBundlePath) : null;
        _fallbackSortingLayerSettingsPath = fallbackSortingLayerSettingsPath is { Length: > 0 }
            ? Path.GetFullPath(fallbackSortingLayerSettingsPath) : null;
        (_sortingLayerSettingsPath, _sortingLayers) = ReadSortingLayers(_sceneBundleDirectory, _fallbackSortingLayerSettingsPath);
    }

    public string SceneBundleDirectory => Volatile.Read(ref _sceneBundleDirectory);
    public string PackageDirectory => _packageDirectory;

    public string SetSceneBundleDirectory(string path) {
        if (string.IsNullOrWhiteSpace(path)) throw new ArgumentException("Enter a folder path.");
        var fullPath = Path.GetFullPath(path.Trim());
        if (!Directory.Exists(fullPath)) throw new DirectoryNotFoundException("That folder does not exist.");
        if (!Directory.EnumerateFiles(fullPath, "*.bundle", SearchOption.TopDirectoryOnly).Any())
            throw new InvalidDataException("No .bundle files were found directly inside that folder.");
        Interlocked.Exchange(ref _sceneBundleDirectory, fullPath);
        (_sortingLayerSettingsPath, _sortingLayers) = ReadSortingLayers(fullPath, _fallbackSortingLayerSettingsPath);
        return fullPath;
    }

    private readonly string? _fallbackSortingLayerSettingsPath;

    private static (string? Path, IReadOnlyList<SortingLayerDefinition> Layers) ReadSortingLayers(
        string sceneBundleDirectory, string? fallbackSortingLayerSettingsPath) {
        var current = new DirectoryInfo(Path.GetFullPath(sceneBundleDirectory));
        (string Path, IReadOnlyList<SortingLayerDefinition> Layers)? defaultOnly = null;
        for (var depth = 0; current is not null && depth <= 6; depth++, current = current.Parent) {
            var path = Path.Combine(current.FullName, "ProjectSettings", "TagManager.asset");
            if (!File.Exists(path)) continue;

            var layers = ParseSortingLayers(path);
            if (layers.Count > 1) return (path, layers);
            if (layers.Count > 0) defaultOnly ??= (path, layers);
        }

        if (fallbackSortingLayerSettingsPath is { Length: > 0 } && File.Exists(fallbackSortingLayerSettingsPath)) {
            var fallbackLayers = ParseSortingLayers(fallbackSortingLayerSettingsPath);
            if (fallbackLayers.Count > 1) return (fallbackSortingLayerSettingsPath, fallbackLayers);
            if (fallbackLayers.Count > 0) defaultOnly ??= (fallbackSortingLayerSettingsPath, fallbackLayers);
        }
        if (defaultOnly is { } only) return (only.Path, only.Layers);
        // Unity always has Default as sorting layer ID 0. Unknown IDs remain
        // explicitly unmapped instead of being assigned a guessed layer name.
        return (null, [new SortingLayerDefinition(0, 0, "Default")]);
    }

    private static IReadOnlyList<SortingLayerDefinition> ParseSortingLayers(string path) {
            var layers = new List<SortingLayerDefinition>();
            var insideSortingLayers = false;
            string? pendingName = null;
            foreach (var line in File.ReadLines(path)) {
                var trimmed = line.Trim();
                if (trimmed.Equals("m_SortingLayers:", StringComparison.Ordinal)) {
                    insideSortingLayers = true;
                    continue;
                }
                if (!insideSortingLayers) continue;
                if (trimmed.StartsWith("m_", StringComparison.Ordinal)) break;
                if (trimmed.StartsWith("- name:", StringComparison.Ordinal)) {
                    pendingName = trimmed[7..].Trim().Trim('"', '\'');
                    continue;
                }
                if (pendingName is null || !trimmed.StartsWith("uniqueID:", StringComparison.Ordinal)) continue;
                var rawId = trimmed[9..].Trim();
                if (uint.TryParse(rawId, NumberStyles.Integer, CultureInfo.InvariantCulture, out var unsignedId))
                    layers.Add(new(unchecked((int)unsignedId), layers.Count, pendingName));
                pendingName = null;
            }
            if (layers.Count > 0) return layers;
            return [];
    }
}

internal sealed class SceneIndex {
    public IReadOnlyList<SceneBundleEntry> ListScenes(string sourceDirectory) {
        if (!Directory.Exists(sourceDirectory)) return Array.Empty<SceneBundleEntry>();

        return new DirectoryInfo(sourceDirectory).EnumerateFiles("*.bundle", SearchOption.TopDirectoryOnly)
            .OrderBy(file => file.Name, StringComparer.OrdinalIgnoreCase)
            .Select(file => Describe(file))
            .ToArray();
    }

    public SceneBundleEntry? Resolve(string sourceDirectory, string requestedName) {
        var target = Path.GetFileNameWithoutExtension(requestedName.Trim());
        if (target.Length == 0) return null;

        var scenes = ListScenes(sourceDirectory);
        var exact = scenes.FirstOrDefault(scene =>
            string.Equals(scene.CandidateName, target, StringComparison.OrdinalIgnoreCase));
        if (exact is not null) return exact;

        var matches = scenes.Where(scene => scene.CandidateName.Contains(target, StringComparison.OrdinalIgnoreCase) ||
                                             Path.GetFileNameWithoutExtension(scene.BundleFile)
                                                 .Contains(target, StringComparison.OrdinalIgnoreCase))
            .Take(2).ToArray();
        return matches.Length == 1 ? matches[0] : null;
    }

    private static SceneBundleEntry Describe(FileInfo file) {
        var lower = file.Name.ToLowerInvariant();
        var kind = lower.Contains("additive", StringComparison.Ordinal) ? "additive" :
            lower.Contains("boss", StringComparison.Ordinal) || lower.Contains("arena", StringComparison.Ordinal)
                ? "arena" : "room-candidate";
        return new SceneBundleEntry(Path.GetFileNameWithoutExtension(file.Name), Path.GetFileNameWithoutExtension(file.Name),
            file.FullName, file.Length, file.LastWriteTimeUtc, kind);
    }
}
