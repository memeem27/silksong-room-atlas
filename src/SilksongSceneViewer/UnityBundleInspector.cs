using AssetsTools.NET;
using AssetsTools.NET.Extra;
using System.Numerics;
using System.Security.Cryptography;
using System.Text.Json;

namespace SilksongSceneViewer;

internal sealed record WorldPoint(float X, float Y, float Z);
internal sealed record SceneComponent(string Type, string? ScriptName = null, string? ScriptExternalPath = null,
    long ScriptPathId = 0, SceneComponentData? Data = null);
internal sealed record SceneColor(float R, float G, float B, float A);
internal sealed record SceneCurveKey(float Time, float Value, float InSlope, float OutSlope);
internal sealed record SceneComponentData(IReadOnlyDictionary<string, bool> Flags,
    IReadOnlyDictionary<string, float> Numbers, IReadOnlyDictionary<string, SceneColor> Colors,
    IReadOnlyDictionary<string, IReadOnlyList<SceneCurveKey>> Curves,
    IReadOnlyDictionary<string, string>? Strings = null);
internal sealed record SceneSpriteReference(long PathId, int FileId, string ExternalPath, string Name,
    string ImageUrl = "", float RectX = 0, float RectY = 0, float RectWidth = 0, float RectHeight = 0,
    float PivotX = .5f, float PivotY = .5f, float PixelsPerUnit = 100, float TextureWidth = 0, float TextureHeight = 0,
    float WorldRotationZ = 0, float WorldScaleX = 1, float WorldScaleY = 1,
    float OriginalWidth = 0, float OriginalHeight = 0, float TrimOffsetX = 0, float TrimOffsetY = 0,
    int SortingLayerValue = 0, int SortingOrder = 0, bool RendererEnabled = true, bool FlipX = false, bool FlipY = false,
    float TintR = 1, float TintG = 1, float TintB = 1, float TintA = 1, IReadOnlyList<SpriteMeshVertex>? MeshVertices = null,
    IReadOnlyList<int>? MeshIndices = null, int PackingRotation = 0,
    int SortingLayerId = 0, int LegacySortingLayer = 0, string SortingLayerName = "Default", bool SortingLayerKnown = true,
    float WorldM00 = 1, float WorldM01 = 0, float WorldM10 = 0, float WorldM11 = 1,
    long MaterialPathId = 0, int MaterialFileId = 0, string MaterialExternalPath = "", string BlendMode = "normal",
    float MaterialTintR = 1, float MaterialTintG = 1, float MaterialTintB = 1, float MaterialTintA = 1,
    string MaterialName = "");
internal sealed record SceneMeshVertex(float X, float Y, float Z, float U, float V,
    float R = 1, float G = 1, float B = 1, float A = 1);
internal sealed record SceneMeshSubmesh(int Topology, IReadOnlyList<int> Indices);
internal sealed record SceneMeshAsset(string Id, string Name, IReadOnlyList<SceneMeshVertex> Vertices,
    IReadOnlyList<SceneMeshSubmesh> Submeshes);
internal sealed record SceneMeshReference(string MeshAssetId, int SubmeshIndex, long MaterialPathId,
    int MaterialFileId, string MaterialExternalPath, string MaterialName, string ImageUrl = "",
    float TextureWidth = 0, float TextureHeight = 0, float TextureScaleX = 1, float TextureScaleY = 1,
    float TextureOffsetX = 0, float TextureOffsetY = 0, int SortingLayerId = 0, int SortingOrder = 0,
    int SortingLayerValue = 0, bool SortingLayerKnown = true,
    bool RendererEnabled = true, float TintR = 1, float TintG = 1, float TintB = 1, float TintA = 1,
    float WorldM00 = 1, float WorldM01 = 0, float WorldM10 = 0, float WorldM11 = 1, string BlendMode = "normal");
internal sealed record SceneSortingGroup(string ObjectId, int SortingLayerId, int SortingLayerValue,
    string SortingLayerName, bool SortingLayerKnown, int SortingOrder, bool Enabled, WorldPoint WorldPosition);
internal sealed record SceneCollider(string Type, bool Enabled, bool IsTrigger, IReadOnlyList<WorldPoint> WorldPoints);
internal sealed record LocalCollider(string Type, bool Enabled, bool IsTrigger, Vector2 Offset, IReadOnlyList<Vector2> Points);
internal sealed record SceneObject(string Id, string Name, string ParentId, int SiblingIndex,
    bool Active, Vector3Data LocalPosition, WorldPoint WorldPosition, IReadOnlyList<SceneComponent> Components,
    IReadOnlyList<SceneCollider> Colliders, IReadOnlyList<SceneSpriteReference> Sprites,
    IReadOnlyList<SceneMeshReference>? Meshes = null, bool ActiveInHierarchy = true,
    SceneSortingGroup? SortingGroup = null, int UnityLayer = 0);
internal sealed record Vector3Data(float X, float Y, float Z);
internal sealed record SceneDiagnostic(string Level, string Message);
internal sealed record SceneExternal(int FileId, string PathName);
internal sealed record ScenePackage(int SchemaVersion, string SceneName, string SourceBundle, long SourceBytes,
    string SourceSha256, DateTimeOffset SourceLastWrittenUtc, DateTimeOffset ExtractedUtc, string UnityVersion, bool TypeTreeEnabled,
    IReadOnlyList<string> SerializedFiles, IReadOnlyList<SceneExternal> ExternalFiles, IReadOnlyList<SceneObject> Objects,
    IReadOnlyList<SceneDiagnostic> Diagnostics, IReadOnlyList<SortingLayerDefinition> SortingLayers,
    string? SortingLayerSettingsPath, IReadOnlyList<SceneMeshAsset>? MeshAssets = null);

internal sealed class UnityBundleInspector {
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };
    private readonly SpriteAssetLoader _spriteAssets;
    private readonly SceneSourceOptions _source;
    public UnityBundleInspector(SpriteAssetLoader spriteAssets, SceneSourceOptions source) {
        _spriteAssets = spriteAssets;
        _source = source;
    }

    public async Task<ScenePackage> InspectAsync(SceneBundleEntry entry, string packageDirectory,
        CancellationToken cancellationToken, bool forceReimport = false) {
        cancellationToken.ThrowIfCancellationRequested();
        var file = new FileInfo(entry.BundleFile);
        if (!file.Exists) throw new FileNotFoundException("The selected room bundle was moved or deleted.", entry.BundleFile);

        Directory.CreateDirectory(packageDirectory);
        var outputPath = Path.Combine(packageDirectory, $"{entry.Id}.json");
        if (!forceReimport && TryReadCached(outputPath, file, out var cached)) return cached;

        var package = await Task.Run(() => {
            var extracted = ResolveSortingLayers(Extract(file, cancellationToken), _source.SortingLayers, _source.SortingLayerSettingsPath);
            var withAssets = _spriteAssets.AttachAssets(extracted, cancellationToken);
            var withScriptNames = _spriteAssets.AttachScriptNames(withAssets, cancellationToken);
            var withSpriteMaterials = _spriteAssets.AttachSpriteMaterials(withScriptNames, cancellationToken);
            return _spriteAssets.AttachMeshAssets(withSpriteMaterials, cancellationToken);
        }, cancellationToken);
        var temporaryPath = outputPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try {
            await using (var stream = new FileStream(temporaryPath, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                             65_536, FileOptions.Asynchronous | FileOptions.SequentialScan)) {
                await JsonSerializer.SerializeAsync(stream, package, JsonOptions, cancellationToken);
            }
            File.Move(temporaryPath, outputPath, true);
            return package;
        } finally {
            if (File.Exists(temporaryPath)) File.Delete(temporaryPath);
        }
    }

    private static bool TryReadCached(string path, FileInfo source, out ScenePackage package) {
        package = default!;
        if (!File.Exists(path)) return false;
        try {
            using var stream = File.OpenRead(path);
            var stored = JsonSerializer.Deserialize<ScenePackage>(stream);
            if (stored is null || stored.SchemaVersion != 28 || !Path.GetFullPath(stored.SourceBundle).Equals(Path.GetFullPath(source.FullName),
                    StringComparison.OrdinalIgnoreCase) || stored.SourceBytes != source.Length ||
                stored.SourceLastWrittenUtc != source.LastWriteTimeUtc ||
                !stored.SourceSha256.Equals(ComputeSha256(source.FullName), StringComparison.OrdinalIgnoreCase)) return false;
            package = stored;
            return true;
        } catch (IOException) {
            return false;
        } catch (JsonException) {
            return false;
        }
    }

    private static ScenePackage Extract(FileInfo source, CancellationToken cancellationToken) {
        var manager = new AssetsManager();
        var diagnostics = new List<SceneDiagnostic>();
        var objectsById = new Dictionary<long, RawObject>();
        var meshAssets = new Dictionary<string, SceneMeshAsset>(StringComparer.Ordinal);
        var serializedFiles = new List<string>();
        var externalFiles = new List<SceneExternal>();
        var typeTreeEnabled = false;
        var unityVersion = "unknown";
        var sourceHash = ComputeSha256(source.FullName);

        var bundle = manager.LoadBundleFile(source.FullName, true);
        var fileNames = bundle.file.GetAllFileNames();
        if (fileNames.Count == 0) throw new InvalidDataException("The bundle contains no readable files.");

        for (var fileIndex = 0; fileIndex < fileNames.Count; fileIndex++) {
            cancellationToken.ThrowIfCancellationRequested();
            var embeddedName = fileNames[fileIndex];
            AssetsFileInstance assetsFile;
            try {
                assetsFile = manager.LoadAssetsFileFromBundle(bundle, fileIndex, false);
            } catch (Exception exception) {
                diagnostics.Add(new("warning", $"Skipped serialized file '{embeddedName}': {exception.Message}"));
                continue;
            }

            if (assetsFile?.file is null) {
                diagnostics.Add(new("warning", $"Skipped serialized file '{embeddedName}': the bundle reader returned no assets file."));
                continue;
            }

            serializedFiles.Add(embeddedName);
            var assets = assetsFile.file;
            var externalPaths = new List<string> { "" };
            foreach (var external in assets.Metadata.Externals) {
                var externalPath = external.PathName ?? "";
                externalPaths.Add(externalPath);
                if (externalPath.Length > 0 && !externalFiles.Any(item => item.PathName.Equals(externalPath, StringComparison.OrdinalIgnoreCase)))
                    externalFiles.Add(new(externalFiles.Count + 1, externalPath));
            }
            if (!string.IsNullOrWhiteSpace(assets.Metadata.UnityVersion)) unityVersion = assets.Metadata.UnityVersion;
            typeTreeEnabled |= assets.Metadata.TypeTreeEnabled;

            foreach (var gameObjectInfo in assets.GetAssetsOfType(AssetClassID.GameObject)) {
                cancellationToken.ThrowIfCancellationRequested();
                try {
                    var baseField = manager.GetBaseField(assetsFile, gameObjectInfo);
                    var gameObject = new RawObject {
                        PathId = gameObjectInfo.PathId,
                        Name = ReadString(baseField, "m_Name", $"GameObject {gameObjectInfo.PathId}"),
                        Active = ReadBool(baseField, "m_IsActive", true),
                        UnityLayer = (int)ReadLong(baseField, "m_Layer", 0),
                        Components = new List<SceneComponent>()
                    };
                    var components = baseField["m_Component.Array"];
                    foreach (var componentPair in components) {
                        var componentPointer = componentPair["component"];
                        var pathId = ReadLong(componentPointer, "m_PathID", 0);
                        if (pathId == 0) continue;
                        try {
                            var externalAsset = manager.GetExtAsset(assetsFile, componentPointer, true);
                            var typeId = externalAsset.info.TypeId;
                            var componentType = Enum.GetName(typeof(AssetClassID), typeId) ?? $"UnityClass_{typeId}";
                            var sceneComponent = new SceneComponent(componentType);
                            if (componentType == nameof(AssetClassID.MonoBehaviour)) {
                                var componentInfo = assets.GetAssetInfo(pathId);
                                if (componentInfo is not null) {
                                    var behaviour = manager.GetBaseField(assetsFile, componentInfo);
                                    var scriptPointer = behaviour["m_Script"];
                                    var scriptFileId = (int)ReadLong(scriptPointer, "m_FileID", 0);
                                    var scriptPathId = ReadLong(scriptPointer, "m_PathID", 0);
                                    var scriptExternalPath = scriptFileId > 0 && scriptFileId < externalPaths.Count
                                        ? externalPaths[scriptFileId] : "";
                                    sceneComponent = new(componentType,
                                        ReadString(behaviour, "m_EditorClassIdentifier", ""), scriptExternalPath, scriptPathId,
                                        ReadComponentData(behaviour));
                                }
                            }
                            gameObject.Components.Add(sceneComponent);
                            if (componentType == "SpriteRenderer") {
                                var spritePointer = manager.GetBaseField(assetsFile, assets.GetAssetInfo(pathId))["m_Sprite"];
                                var spritePathId = ReadLong(spritePointer, "m_PathID", 0);
                                var spriteFileId = (int)ReadLong(spritePointer, "m_FileID", 0);
                                var spriteExternalPath = spriteFileId >= 0 && spriteFileId < externalPaths.Count ? externalPaths[spriteFileId] : "";
                                if (spritePathId != 0) {
                                    var renderer = manager.GetBaseField(assetsFile, assets.GetAssetInfo(pathId));
                                    var materialPointer = TryFirstMaterial(renderer);
                                    var materialFileId = materialPointer is null ? 0 : (int)ReadLong(materialPointer, "m_FileID", 0);
                                    var materialPathId = materialPointer is null ? 0 : ReadLong(materialPointer, "m_PathID", 0);
                                    var materialExternalPath = materialFileId > 0 && materialFileId < externalPaths.Count
                                        ? externalPaths[materialFileId] : "";
                                    var materialName = materialFileId == 0 ? ReadSpriteMaterialName(manager, assetsFile, materialPathId) : "";
                                    gameObject.Sprites.Add(new(spritePathId, spriteFileId, spriteExternalPath, "",
                                        SortingLayerId: (int)ReadLong(renderer, "m_SortingLayerID", 0),
                                        LegacySortingLayer: (int)ReadLong(renderer, "m_SortingLayer", 0),
                                        SortingOrder: (int)ReadLong(renderer, "m_SortingOrder", 0),
                                        RendererEnabled: ReadBool(renderer, "m_Enabled", true),
                                        FlipX: ReadBool(renderer, "m_FlipX", false), FlipY: ReadBool(renderer, "m_FlipY", false),
                                        TintR: ReadColorChannel(renderer, "r", 1), TintG: ReadColorChannel(renderer, "g", 1),
                                        TintB: ReadColorChannel(renderer, "b", 1), TintA: ReadColorChannel(renderer, "a", 1),
                                        MaterialPathId: materialPathId, MaterialFileId: materialFileId,
                                        MaterialExternalPath: materialExternalPath, MaterialName: materialName));
                                }
                            }
                            if (componentType == "MeshFilter") {
                                var componentInfo = assets.GetAssetInfo(pathId);
                                if (componentInfo is not null) {
                                    var filter = manager.GetBaseField(assetsFile, componentInfo);
                                    var mesh = ReadMeshAsset(manager, assetsFile, filter["m_Mesh"], fileIndex);
                                    if (mesh is not null) {
                                        meshAssets.TryAdd(mesh.Id, mesh);
                                        gameObject.MeshAssetId = mesh.Id;
                                    }
                                }
                            }
                            if (componentType == "MeshRenderer") {
                                var componentInfo = assets.GetAssetInfo(pathId);
                                if (componentInfo is not null) {
                                    var renderer = manager.GetBaseField(assetsFile, componentInfo);
                                    var materials = new List<RawMeshMaterial>();
                                    foreach (var materialPointer in renderer["m_Materials.Array"]) {
                                        var materialFileId = (int)ReadLong(materialPointer, "m_FileID", 0);
                                        var materialPathId = ReadLong(materialPointer, "m_PathID", 0);
                                        var materialExternalPath = materialFileId > 0 && materialFileId < externalPaths.Count
                                            ? externalPaths[materialFileId] : "";
                                        materials.Add(new(materialPathId, materialFileId, materialExternalPath));
                                    }
                                    gameObject.MeshRenderer = new(materials,
                                        (int)ReadLong(renderer, "m_SortingLayerID", 0),
                                        (int)ReadLong(renderer, "m_SortingOrder", 0),
                                        ReadBool(renderer, "m_Enabled", true));
                                }
                            }
                            if (componentType == "SortingGroup") {
                                var componentInfo = assets.GetAssetInfo(pathId);
                                if (componentInfo is not null) {
                                    var group = manager.GetBaseField(assetsFile, componentInfo);
                                    gameObject.SortingGroup = new((int)ReadLong(group, "m_SortingLayerID", 0),
                                        (int)ReadLong(group, "m_SortingOrder", 0), ReadBool(group, "m_Enabled", true));
                                }
                            }
                            if (componentType is nameof(AssetClassID.Transform) or nameof(AssetClassID.RectTransform)) gameObject.TransformPathId = pathId;
                            if (IsColliderType(componentType)) {
                                var componentInfo = assets.GetAssetInfo(pathId);
                                if (componentInfo is not null)
                                    gameObject.Colliders.Add(ReadCollider(componentType, manager.GetBaseField(assetsFile, componentInfo)));
                            }
                        } catch (Exception exception) {
                            gameObject.Components.Add(new SceneComponent("UnresolvedComponent"));
                            diagnostics.Add(new("warning", $"Could not resolve component PathID {pathId} in GameObject {gameObject.Name}: {exception.Message}"));
                        }
                    }
                    if (gameObject.MeshAssetId is not null && gameObject.MeshRenderer is { } meshRenderer &&
                        meshAssets.TryGetValue(gameObject.MeshAssetId, out var meshAsset)) {
                        for (var submeshIndex = 0; submeshIndex < meshAsset.Submeshes.Count; submeshIndex++) {
                            if (submeshIndex >= meshRenderer.Materials.Count) break;
                            var material = meshRenderer.Materials[submeshIndex];
                            if (material.PathId == 0) continue;
                            gameObject.Meshes.Add(new(meshAsset.Id, submeshIndex, material.PathId, material.FileId,
                                material.ExternalPath, "", SortingLayerId: meshRenderer.SortingLayerId,
                                SortingOrder: meshRenderer.SortingOrder, RendererEnabled: meshRenderer.Enabled));
                        }
                    }
                    objectsById[gameObjectInfo.PathId] = gameObject;
                } catch (Exception exception) {
                    diagnostics.Add(new("warning", $"Could not decode GameObject PathID {gameObjectInfo.PathId}: {exception.Message}"));
                }
            }

            foreach (var transformInfo in assets.GetAssetsOfType(AssetClassID.Transform)
                         .Concat(assets.GetAssetsOfType(AssetClassID.RectTransform))) {
                cancellationToken.ThrowIfCancellationRequested();
                try {
                    var transform = manager.GetBaseField(assetsFile, transformInfo);
                    var ownerPathId = ReadLong(transform["m_GameObject"], "m_PathID", 0);
                    if (!objectsById.TryGetValue(ownerPathId, out var owner)) continue;
                    owner.TransformPathId = transformInfo.PathId;
                    owner.LocalPosition = ReadVector3(transform["m_LocalPosition"]);
                    owner.LocalRotation = ReadQuaternion(transform["m_LocalRotation"]);
                    owner.LocalScale = ReadVector3(transform["m_LocalScale"], new Vector3(1, 1, 1));
                    owner.ParentTransformPathId = ReadLong(transform["m_Father"], "m_PathID", 0);
                    var children = transform["m_Children.Array"];
                    foreach (var child in children) {
                        var childPathId = ReadLong(child, "m_PathID", 0);
                        if (childPathId != 0) owner.ChildTransformPathIds.Add(childPathId);
                    }
                } catch (Exception exception) {
                    diagnostics.Add(new("warning", $"Could not decode Transform PathID {transformInfo.PathId}: {exception.Message}"));
                }
            }
        }

        if (objectsById.Count == 0) {
            diagnostics.Add(new("warning", "The bundle was readable, but contained no decoded Unity GameObjects."));
        }
        var transformOwners = objectsById.Values.Where(raw => raw.TransformPathId != 0)
            .GroupBy(raw => raw.TransformPathId).ToDictionary(group => group.Key, group => group.First());
        foreach (var raw in objectsById.Values) {
            if (raw.TransformPathId == 0) continue;
            raw.ParentGameObjectPathId = transformOwners.TryGetValue(raw.ParentTransformPathId, out var parent) ? parent.PathId : 0;
        }
        var rootObjects = objectsById.Values.Where(raw => raw.ParentGameObjectPathId == 0)
            .OrderBy(raw => raw.Name, StringComparer.Ordinal).ThenBy(raw => raw.PathId).ToArray();
        var siblingIndices = new Dictionary<long, int>();
        for (var index = 0; index < rootObjects.Length; index++) siblingIndices[rootObjects[index].PathId] = index;
        foreach (var parent in objectsById.Values) {
            for (var index = 0; index < parent.ChildTransformPathIds.Count; index++) {
                if (transformOwners.TryGetValue(parent.ChildTransformPathIds[index], out var child)) siblingIndices[child.PathId] = index;
            }
        }

        var result = new List<SceneObject>(objectsById.Count);
        foreach (var raw in objectsById.Values.OrderBy(raw => raw.PathId)) {
            cancellationToken.ThrowIfCancellationRequested();
            var world = ResolveWorld(raw, objectsById, new HashSet<long>());
            var colliders = raw.Colliders.Select(collider => new SceneCollider(collider.Type, collider.Enabled,
                collider.IsTrigger, collider.Points.Select(local => {
                    var local3d = new Vector3(local.X + collider.Offset.X, local.Y + collider.Offset.Y, 0);
                    var transformed = TransformVector(world, local3d);
                    return new WorldPoint(world.Position.X + transformed.X, world.Position.Y + transformed.Y,
                        world.Position.Z + transformed.Z);
                }).ToArray())).ToArray();
            result.Add(new SceneObject($"{sourceHash}:{raw.PathId}", raw.Name,
                raw.ParentGameObjectPathId == 0 ? "" : $"{sourceHash}:{raw.ParentGameObjectPathId}",
                siblingIndices.GetValueOrDefault(raw.PathId), raw.Active,
                ToData(raw.LocalPosition), new(world.Position.X, world.Position.Y, world.Position.Z), raw.Components, colliders,
                raw.Sprites.Select(sprite => sprite with {
                    // Keep the full projected transform; decomposing it loses mirrors
                    // when a rotated child is below a negatively-scaled parent.
                    WorldRotationZ = MathF.Atan2(world.AxisX.Y, world.AxisX.X),
                    WorldScaleX = world.AxisX.Length(), WorldScaleY = world.AxisY.Length(),
                    WorldM00 = world.AxisX.X, WorldM01 = world.AxisY.X,
                    WorldM10 = world.AxisX.Y, WorldM11 = world.AxisY.Y
                }).ToArray(),
                raw.Meshes.Select(mesh => mesh with {
                    WorldM00 = world.AxisX.X, WorldM01 = world.AxisY.X,
                    WorldM10 = world.AxisX.Y, WorldM11 = world.AxisY.Y
                }).ToArray(),
                IsActiveInHierarchy(raw, objectsById, new HashSet<long>()),
                ResolveSortingGroup(raw, objectsById, sourceHash), raw.UnityLayer));
        }

        return new ScenePackage(28, Path.GetFileNameWithoutExtension(source.Name), source.FullName,
            source.Length, sourceHash, source.LastWriteTimeUtc, DateTimeOffset.UtcNow, unityVersion, typeTreeEnabled,
            serializedFiles, externalFiles, result, diagnostics, [], null, meshAssets.Values.ToArray());
    }

    private static SceneMeshAsset? ReadMeshAsset(AssetsManager manager, AssetsFileInstance sourceFile,
        AssetTypeValueField meshPointer, int serializedFileIndex) {
        var meshAsset = manager.GetExtAsset(sourceFile, meshPointer, true);
        if (meshAsset.info is null || meshAsset.file is null) return null;
        var mesh = manager.GetBaseField(meshAsset.file, meshAsset.info);
        var vertexData = mesh["m_VertexData"];
        var vertexCount = (int)ReadLong(vertexData, "m_VertexCount", 0);
        var channels = vertexData["m_Channels.Array"].Children;
        var rawData = vertexData["m_DataSize"].Value?.AsByteArray;
        if (vertexCount < 1 || channels.Count == 0 || rawData is null) return null;
        var parsedChannels = channels.Select((field, index) => new MeshChannel(index,
            (int)ReadLong(field, "stream", 0), (int)ReadLong(field, "offset", 0),
            (int)ReadLong(field, "format", 0), (int)ReadLong(field, "dimension", 0))).ToArray();
        var streamStrides = new int[8];
        foreach (var channel in parsedChannels) {
            var size = VertexFormatSize(channel.Format);
            if (channel.Dimension <= 0 || channel.Stream < 0 || channel.Stream >= streamStrides.Length || size == 0) continue;
            streamStrides[channel.Stream] = Math.Max(streamStrides[channel.Stream], channel.Offset + channel.Dimension * size);
        }
        var position = parsedChannels.FirstOrDefault(channel => channel.Semantic == 0 && channel.Dimension >= 2);
        if (position is null) return null;
        var uv = parsedChannels.FirstOrDefault(channel => channel.Semantic == 4 && channel.Dimension >= 2)
            ?? new MeshChannel(4, 0, 0, 0, 0);
        var color = parsedChannels.FirstOrDefault(channel => channel.Semantic == 3 && channel.Dimension >= 3)
            ?? new MeshChannel(3, 0, 0, 0, 0);
        var streamStarts = new int[streamStrides.Length];
        for (var stream = 1; stream < streamStarts.Length; stream++)
            streamStarts[stream] = streamStarts[stream - 1] + Align16(streamStrides[stream - 1] * vertexCount);
        var vertices = new SceneMeshVertex[vertexCount];
        for (var index = 0; index < vertexCount; index++) {
            var x = ReadVertexComponent(rawData, streamStarts[position.Stream] + index * streamStrides[position.Stream] + position.Offset, position.Format);
            var y = ReadVertexComponent(rawData, streamStarts[position.Stream] + index * streamStrides[position.Stream] + position.Offset, position.Format, 1);
            var z = position.Dimension >= 3
                ? ReadVertexComponent(rawData, streamStarts[position.Stream] + index * streamStrides[position.Stream] + position.Offset, position.Format, 2) : 0;
            var u = uv.Dimension >= 2
                ? ReadVertexComponent(rawData, streamStarts[uv.Stream] + index * streamStrides[uv.Stream] + uv.Offset, uv.Format) : 0;
            var v = uv.Dimension >= 2
                ? ReadVertexComponent(rawData, streamStarts[uv.Stream] + index * streamStrides[uv.Stream] + uv.Offset, uv.Format, 1) : 0;
            var colorOffset = color.Dimension >= 3
                ? streamStarts[color.Stream] + index * streamStrides[color.Stream] + color.Offset : 0;
            var r = color.Dimension >= 3 ? ReadVertexComponent(rawData, colorOffset, color.Format) : 1;
            var g = color.Dimension >= 3 ? ReadVertexComponent(rawData, colorOffset, color.Format, 1) : 1;
            var b = color.Dimension >= 3 ? ReadVertexComponent(rawData, colorOffset, color.Format, 2) : 1;
            var a = color.Dimension >= 4 ? ReadVertexComponent(rawData, colorOffset, color.Format, 3) : 1;
            if (!new[] { x, y, z, u, v, r, g, b, a }.All(float.IsFinite)) return null;
            vertices[index] = new(x, y, z, u, v, r, g, b, a);
        }
        var indexBytes = mesh["m_IndexBuffer.Array"].Value?.AsByteArray;
        if (indexBytes is null) return null;
        var indexWidth = ReadLong(mesh, "m_IndexFormat", 0) == 0 ? 2 : 4;
        var submeshes = new List<SceneMeshSubmesh>();
        foreach (var submesh in mesh["m_SubMeshes.Array"]) {
            var firstByte = (int)ReadLong(submesh, "firstByte", 0);
            var indexCount = (int)ReadLong(submesh, "indexCount", 0);
            var baseVertex = (int)ReadLong(submesh, "baseVertex", 0);
            var topology = (int)ReadLong(submesh, "topology", 0);
            if (firstByte < 0 || indexCount < 0 || firstByte + (long)indexCount * indexWidth > indexBytes.Length) {
                submeshes.Add(new(topology, []));
                continue;
            }
            var indices = new int[indexCount];
            for (var index = 0; index < indexCount; index++) {
                var offset = firstByte + index * indexWidth;
                indices[index] = indexWidth == 2
                    ? System.Buffers.Binary.BinaryPrimitives.ReadUInt16LittleEndian(indexBytes.AsSpan(offset, 2)) + baseVertex
                    : (int)System.Buffers.Binary.BinaryPrimitives.ReadUInt32LittleEndian(indexBytes.AsSpan(offset, 4)) + baseVertex;
            }
            submeshes.Add(new(topology, indices));
        }
        var id = $"mesh-{serializedFileIndex}-{meshAsset.info.PathId}";
        return new(id, ReadString(mesh, "m_Name", id), vertices, submeshes);
    }

    private static int VertexFormatSize(int format) => format switch {
        0 or 10 or 11 => 4, 1 => 2, 2 or 3 or 6 or 7 => 1, 4 or 5 or 8 or 9 => 2, _ => 0
    };
    private static int Align16(int value) => (value + 15) & ~15;
    private static float ReadVertexComponent(byte[] data, int start, int format, int component = 0) {
        var bytes = VertexFormatSize(format); var offset = start + component * bytes;
        if (bytes == 0 || offset < 0 || offset + bytes > data.Length) return float.NaN;
        return format switch {
            0 => BitConverter.ToSingle(data, offset),
            1 => (float)BitConverter.UInt16BitsToHalf(System.Buffers.Binary.BinaryPrimitives.ReadUInt16LittleEndian(data.AsSpan(offset, 2))),
            2 => data[offset] / 255f,
            3 => Math.Max(-1, unchecked((sbyte)data[offset]) / 127f),
            4 => System.Buffers.Binary.BinaryPrimitives.ReadUInt16LittleEndian(data.AsSpan(offset, 2)) / 65535f,
            5 => Math.Max(-1, System.Buffers.Binary.BinaryPrimitives.ReadInt16LittleEndian(data.AsSpan(offset, 2)) / 32767f),
            6 => data[offset],
            7 => unchecked((sbyte)data[offset]),
            8 => System.Buffers.Binary.BinaryPrimitives.ReadUInt16LittleEndian(data.AsSpan(offset, 2)),
            9 => System.Buffers.Binary.BinaryPrimitives.ReadInt16LittleEndian(data.AsSpan(offset, 2)),
            10 => System.Buffers.Binary.BinaryPrimitives.ReadUInt32LittleEndian(data.AsSpan(offset, 4)),
            11 => System.Buffers.Binary.BinaryPrimitives.ReadInt32LittleEndian(data.AsSpan(offset, 4)),
            _ => float.NaN
        };
    }

    private static ScenePackage ResolveSortingLayers(ScenePackage package, IReadOnlyList<SortingLayerDefinition> definitions,
        string? settingsPath) {
        var layersById = definitions.ToDictionary(layer => layer.Id);
        var objects = package.Objects.Select(sceneObject => sceneObject with {
            Sprites = sceneObject.Sprites.Select(sprite => layersById.TryGetValue(sprite.SortingLayerId, out var layer)
                ? sprite with { SortingLayerValue = layer.Value, SortingLayerName = layer.Name, SortingLayerKnown = true }
                : sprite with { SortingLayerValue = sprite.LegacySortingLayer, SortingLayerName = $"Unknown ID {sprite.SortingLayerId}", SortingLayerKnown = false }).ToArray(),
            Meshes = (sceneObject.Meshes ?? []).Select(mesh => layersById.TryGetValue(mesh.SortingLayerId, out var layer)
                ? mesh with { SortingLayerValue = layer.Value, SortingLayerKnown = true }
                : mesh with { SortingLayerValue = mesh.SortingLayerId, SortingLayerKnown = false }).ToArray(),
            SortingGroup = sceneObject.SortingGroup is { } group && layersById.TryGetValue(group.SortingLayerId, out var groupLayer)
                ? group with { SortingLayerValue = groupLayer.Value, SortingLayerName = groupLayer.Name, SortingLayerKnown = true }
                : sceneObject.SortingGroup is { } unknownGroup
                    ? unknownGroup with { SortingLayerValue = unknownGroup.SortingLayerId,
                        SortingLayerName = $"Unknown ID {unknownGroup.SortingLayerId}", SortingLayerKnown = false } : null
        }).ToArray();
        var unknownIds = objects.SelectMany(sceneObject =>
                sceneObject.Sprites.Where(sprite => !sprite.SortingLayerKnown).Select(sprite => (sprite.SortingLayerId, Kind: "sprites"))
                    .Concat((sceneObject.Meshes ?? []).Where(mesh => !mesh.SortingLayerKnown).Select(mesh => (mesh.SortingLayerId, Kind: "meshes")))
                    .Concat(sceneObject.SortingGroup is { SortingLayerKnown: false } group
                        ? [(group.SortingLayerId, Kind: "sorting groups")] : []))
            .GroupBy(item => item.SortingLayerId).Select(group => $"{group.Key} ({group.Count()} artwork items)").ToArray();
        var diagnostics = package.Diagnostics.ToList();
        if (unknownIds.Length > 0) {
            var settingsName = settingsPath is null ? "Unity's default layer only" : Path.GetFileName(settingsPath);
            diagnostics.Add(new("info", $"Unmapped sorting-layer IDs in {settingsName}: {string.Join(", ", unknownIds)}. These artwork items are kept in the object data and hidden by default until enabled in Artwork filters."));
        }
        return package with { Objects = objects, SortingLayers = definitions, SortingLayerSettingsPath = settingsPath, Diagnostics = diagnostics };
    }

    private static WorldTransform ResolveWorld(RawObject current, IReadOnlyDictionary<long, RawObject> objects,
        HashSet<long> seen) {
        if (!seen.Add(current.PathId)) return LocalTransform(current);
        if (current.ParentGameObjectPathId == 0 || !objects.TryGetValue(current.ParentGameObjectPathId, out var parent))
            return LocalTransform(current);

        var parentWorld = ResolveWorld(parent, objects, seen);
        var local = LocalTransform(current);
        return new(parentWorld.Position + TransformVector(parentWorld, current.LocalPosition),
            TransformVector(parentWorld, local.AxisX), TransformVector(parentWorld, local.AxisY),
            TransformVector(parentWorld, local.AxisZ));
    }

    private static SceneSortingGroup? ResolveSortingGroup(RawObject raw,
        IReadOnlyDictionary<long, RawObject> objects, string sourceHash) {
        var current = raw; var seen = new HashSet<long>();
        while (current is not null && seen.Add(current.PathId)) {
            if (current.SortingGroup is { Enabled: true } group) {
                var world = ResolveWorld(current, objects, new HashSet<long>());
                return new($"{sourceHash}:{current.PathId}", group.SortingLayerId, 0, "Default", true,
                    group.SortingOrder, group.Enabled, new(world.Position.X, world.Position.Y, world.Position.Z));
            }
            if (current.ParentGameObjectPathId == 0 || !objects.TryGetValue(current.ParentGameObjectPathId, out var parent)) break;
            current = parent;
        }
        return null;
    }

    private static WorldTransform LocalTransform(RawObject current) => new(current.LocalPosition,
        Vector3.Transform(new Vector3(current.LocalScale.X, 0, 0), current.LocalRotation),
        Vector3.Transform(new Vector3(0, current.LocalScale.Y, 0), current.LocalRotation),
        Vector3.Transform(new Vector3(0, 0, current.LocalScale.Z), current.LocalRotation));

    private static Vector3 TransformVector(WorldTransform transform, Vector3 vector) =>
        transform.AxisX * vector.X + transform.AxisY * vector.Y + transform.AxisZ * vector.Z;

    private static bool IsActiveInHierarchy(RawObject current, IReadOnlyDictionary<long, RawObject> objects,
        HashSet<long> seen) {
        if (!current.Active) return false;
        if (!seen.Add(current.PathId)) return true;
        return current.ParentGameObjectPathId == 0 || !objects.TryGetValue(current.ParentGameObjectPathId, out var parent) ||
            IsActiveInHierarchy(parent, objects, seen);
    }

    private static string ComputeSha256(string path) {
        using var stream = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(stream));
    }

    private static Vector3Data ToData(Vector3 value) => new(value.X, value.Y, value.Z);
    private static string ReadString(AssetTypeValueField field, string name, string fallback) {
        try { return field[name].AsString; } catch { return fallback; }
    }
    private static SceneComponentData? ReadComponentData(AssetTypeValueField component) {
        var flags = new Dictionary<string, bool>(StringComparer.Ordinal);
        foreach (var name in new[] { "affectAmbientLight", "affectHeroLight", "affectBloom", "affectSaturation",
                     "affectCharacterTint", "affectCharacterLightDust", "enableGrade" }) {
            var value = FindField(component, name);
            if (value is not null) flags[name] = ReadBoolValue(value, false);
        }
        var numbers = new Dictionary<string, float>(StringComparer.Ordinal);
        foreach (var name in new[] { "ambientIntensity", "ambientLightIntensity", "bloomThreshold", "bloomIntensity",
                     "bloomBlurSize", "saturation", "alpha", "maxIntensityRadius", "cutoffRadius", "priority",
                     "fadeDuration", "Factor", "AmbientIntensityA", "AmbientIntensityB", "SaturationA", "SaturationB" }) {
            var value = FindField(component, name);
            if (value is not null && ReadOptionalFloat(value) is { } number) numbers[name] = number;
        }
        var colors = new Dictionary<string, SceneColor>(StringComparer.Ordinal);
        foreach (var name in new[] { "ambientColor", "ambientLightColor", "heroLightColor", "characterTint",
                     "characterLightDustColor", "AmbientColorA", "AmbientColorB", "HeroLightColorA", "HeroLightColorB" }) {
            var value = FindField(component, name);
            if (value is not null && ReadSceneColor(value) is { } color) colors[name] = color;
        }
        var curves = new Dictionary<string, IReadOnlyList<SceneCurveKey>>(StringComparer.Ordinal);
        foreach (var name in new[] { "redChannel", "greenChannel", "blueChannel" }) {
            var value = FindField(component, name);
            if (value is null) continue;
            var keys = ReadSceneCurve(value);
            if (keys.Count > 0) curves[name] = keys;
        }
        var strings = new Dictionary<string, string>(StringComparer.Ordinal);
        CollectSceneStrings(component, strings, 0);
        return flags.Count + numbers.Count + colors.Count + curves.Count + strings.Count == 0
            ? null : new(flags, numbers, colors, curves, strings);
    }
    private static readonly HashSet<string> SceneStringFields = new(StringComparer.Ordinal) {
        "m_text", "convName", "Key", "key", "sheetName", "areaName", "m_LanguageString"
    };
    private static void CollectSceneStrings(AssetTypeValueField field, IDictionary<string, string> values, int depth) {
        if (depth > 8) return;
        if (SceneStringFields.Contains(field.FieldName)) {
            try {
                var text = field.AsString;
                if (!string.IsNullOrWhiteSpace(text) && text.Length <= 240) values.TryAdd(field.FieldName, text);
            } catch { }
        }
        foreach (var child in field.Children) CollectSceneStrings(child, values, depth + 1);
    }
    private static AssetTypeValueField? FindField(AssetTypeValueField field, string name) =>
        field.Children.FirstOrDefault(child => child.FieldName.Equals(name, StringComparison.Ordinal));
    private static bool ReadBoolValue(AssetTypeValueField field, bool fallback) {
        try { return field.AsBool; } catch {
            try { return field.AsInt != 0; } catch { return fallback; }
        }
    }
    private static float? ReadOptionalFloat(AssetTypeValueField field) {
        try { var number = field.AsFloat; return float.IsFinite(number) ? number : null; } catch {
            try { var number = field.AsInt; return number; } catch {
                try { var number = field.AsLong; return number is >= -16_777_216 and <= 16_777_216 ? number : null; }
                catch { return null; }
            }
        }
    }
    private static SceneColor? ReadSceneColor(AssetTypeValueField field) {
        var r = FindField(field, "r"); var g = FindField(field, "g");
        var b = FindField(field, "b"); var a = FindField(field, "a");
        if (r is null || g is null || b is null || a is null) return null;
        var values = new[] { ReadOptionalFloat(r), ReadOptionalFloat(g), ReadOptionalFloat(b), ReadOptionalFloat(a) };
        return values.Any(value => value is null) ? null : new(values[0]!.Value, values[1]!.Value, values[2]!.Value, values[3]!.Value);
    }
    private static IReadOnlyList<SceneCurveKey> ReadSceneCurve(AssetTypeValueField field) {
        try {
            return field["m_Curve.Array"].Children.Select(key => new SceneCurveKey(
                    ReadOptionalFloat(key["time"]) ?? 0,
                    ReadOptionalFloat(key["value"]) ?? 0,
                    ReadOptionalFloat(key["inSlope"]) ?? 0,
                    ReadOptionalFloat(key["outSlope"]) ?? 0))
                .Where(key => float.IsFinite(key.Time) && float.IsFinite(key.Value))
                .OrderBy(key => key.Time).ToArray();
        } catch { return []; }
    }
    private static long ReadLong(AssetTypeValueField field, string name, long fallback) {
        try { return field[name].AsLong; } catch {
            try { return field[name].AsInt; } catch { return fallback; }
        }
    }
    private static bool ReadBool(AssetTypeValueField field, string name, bool fallback) {
        try { return field[name].AsBool; } catch { return fallback; }
    }
    private static float ReadFloat(AssetTypeValueField field, string name, float fallback) {
        try { return field[name].AsFloat; } catch { return fallback; }
    }
    private static float ReadColorChannel(AssetTypeValueField renderer, string channel, float fallback) {
        try { return ReadFloat(renderer["m_Color"], channel, fallback); } catch { return fallback; }
    }
    private static string ReadSpriteMaterialName(AssetsManager manager, AssetsFileInstance sourceFile, long materialPathId) {
        if (materialPathId == 0) return "";
        try {
            var materialInfo = sourceFile.file.GetAssetInfo(materialPathId);
            if (materialInfo is null) return "";
            var material = manager.GetBaseField(sourceFile, materialInfo);
            return ReadString(material, "m_Name", "");
        } catch {
            return "";
        }
    }
    private static AssetTypeValueField? TryFirstMaterial(AssetTypeValueField renderer) {
        try { return renderer["m_Materials.Array"].Children.FirstOrDefault(); } catch { return null; }
    }
    private static Vector3 ReadVector3(AssetTypeValueField field, Vector3? fallback = null) => new(
        ReadFloat(field, "x", fallback?.X ?? 0), ReadFloat(field, "y", fallback?.Y ?? 0),
        ReadFloat(field, "z", fallback?.Z ?? 0));
    private static Quaternion ReadQuaternion(AssetTypeValueField field) => new(
        ReadFloat(field, "x", 0), ReadFloat(field, "y", 0), ReadFloat(field, "z", 0), ReadFloat(field, "w", 1));

    private static Vector2 ReadVector2(AssetTypeValueField field, Vector2? fallback = null) => new(
        ReadFloat(field, "x", fallback?.X ?? 0), ReadFloat(field, "y", fallback?.Y ?? 0));

    private static bool IsColliderType(string type) => type is "BoxCollider2D" or "CapsuleCollider2D" or
        "CircleCollider2D" or "PolygonCollider2D" or "EdgeCollider2D";

    private static LocalCollider ReadCollider(string type, AssetTypeValueField field) {
        var offset = ReadVector2(field["m_Offset"]);
        var points = new List<Vector2>();
        if (type == "CircleCollider2D") {
            var radius = Math.Max(.01f, ReadFloat(field, "m_Radius", .5f));
            const int segments = 24;
            for (var index = 0; index < segments; index++) {
                var angle = MathF.PI * 2f * index / segments;
                points.Add(new Vector2(MathF.Cos(angle) * radius, MathF.Sin(angle) * radius));
            }
        } else if (type is "BoxCollider2D" or "CapsuleCollider2D") {
            var half = ReadVector2(field["m_Size"], new Vector2(1, 1)) / 2f;
            points.AddRange([new(-half.X, -half.Y), new(half.X, -half.Y), new(half.X, half.Y), new(-half.X, half.Y)]);
        } else {
            try {
                foreach (var point in field["m_Points.Array"]) points.Add(ReadVector2(point));
            } catch {
                // Keep the collider in the scene record even when its vertices cannot be decoded.
            }
        }
        return new LocalCollider(type, ReadBool(field, "m_Enabled", true), ReadBool(field, "m_IsTrigger", false),
            offset, points);
    }

    private sealed class RawObject {
        public long PathId { get; init; }
        public string Name { get; init; } = "";
        public bool Active { get; init; } = true;
        public int UnityLayer { get; init; }
        public long TransformPathId { get; set; }
        public long ParentTransformPathId { get; set; }
        public long ParentGameObjectPathId { get; set; }
        public Vector3 LocalPosition { get; set; }
        public Quaternion LocalRotation { get; set; } = Quaternion.Identity;
        public Vector3 LocalScale { get; set; } = new(1, 1, 1);
        public List<long> ChildTransformPathIds { get; } = new();
        public List<SceneComponent> Components { get; init; } = new();
        public List<SceneSpriteReference> Sprites { get; } = new();
        public List<LocalCollider> Colliders { get; } = new();
        public string? MeshAssetId { get; set; }
        public RawMeshRenderer? MeshRenderer { get; set; }
        public RawSortingGroup? SortingGroup { get; set; }
        public List<SceneMeshReference> Meshes { get; } = new();
    }

    private sealed record MeshChannel(int Semantic, int Stream, int Offset, int Format, int Dimension);
    private sealed record RawMeshMaterial(long PathId, int FileId, string ExternalPath);
    private sealed record RawMeshRenderer(IReadOnlyList<RawMeshMaterial> Materials,
        int SortingLayerId, int SortingOrder, bool Enabled);
    private sealed record RawSortingGroup(int SortingLayerId, int SortingOrder, bool Enabled);
    private sealed record WorldTransform(Vector3 Position, Vector3 AxisX, Vector3 AxisY, Vector3 AxisZ);
}
