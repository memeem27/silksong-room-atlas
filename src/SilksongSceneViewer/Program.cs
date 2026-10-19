using System.Text.Json;
using Microsoft.Extensions.FileProviders;
using SilksongSceneViewer;

static string ResolveSourceDirectory(string[] arguments, string contentRoot) {
    var index = Array.FindIndex(arguments, argument => argument.Equals("--source", StringComparison.OrdinalIgnoreCase));
    var supplied = index >= 0 && index + 1 < arguments.Length ? arguments[index + 1] : "";
    if (supplied.Length == 0) return Path.GetFullPath(Path.Combine(contentRoot, "../../../ExtractionInput/Bundles/scenes_scenes_scenes"));
    return Path.GetFullPath(supplied, Directory.GetCurrentDirectory());
}

var builder = WebApplication.CreateBuilder(args);
var portOption = Array.FindIndex(args, argument => argument.Equals("--port", StringComparison.OrdinalIgnoreCase));
var port = portOption >= 0 && portOption + 1 < args.Length && int.TryParse(args[portOption + 1], out var customPort) && customPort is > 0 and < 65536 ? customPort : 5178;
builder.WebHost.UseUrls($"http://127.0.0.1:{port}");
// Large native-resolution images are uploaded in bounded chunks below.
builder.WebHost.ConfigureKestrel(options => options.Limits.MaxRequestBodySize = 64L * 1024 * 1024);
builder.Logging.ClearProviders();
builder.Logging.AddConsole();
builder.Services.ConfigureHttpJsonOptions(options => {
    options.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
    options.SerializerOptions.WriteIndented = false;
});
builder.Services.AddSingleton(sp => new SceneSourceOptions(
    ResolveSourceDirectory(args, builder.Environment.ContentRootPath),
    Path.GetFullPath(Path.Combine(builder.Environment.ContentRootPath, "../../workspace/scenes")),
    [Path.GetFullPath(Path.Combine(builder.Environment.ContentRootPath, "../../../ExtractionInput/Bundles/atlases_assets_assets/sprites/_atlases")),
     Path.GetFullPath(Path.Combine(builder.Environment.ContentRootPath, "../../../ExportedProject/Assets/StreamingAssets/aa/StandaloneWindows64"))],
    Path.GetFullPath(Path.Combine(builder.Environment.ContentRootPath, "../../../ExportedProject/ProjectSettings/TagManager.asset")),
    Path.GetFullPath(Path.Combine(builder.Environment.ContentRootPath, "../../../ExtractionInput/Bundles/maps_assets_all.bundle"))));
builder.Services.AddSingleton<SceneIndex>();
builder.Services.AddSingleton(sp => new SpriteAssetLoader(sp.GetRequiredService<SceneSourceOptions>().ArtworkBundleDirectories,
    sp.GetRequiredService<SceneSourceOptions>().PackageDirectory));
builder.Services.AddSingleton<UnityBundleInspector>();
builder.Services.AddSingleton(sp => new EnemyArtworkCatalog(sp.GetRequiredService<SpriteAssetLoader>()));

var app = builder.Build();
var preprocessedDirectory = Path.GetFullPath(Path.Combine(builder.Environment.ContentRootPath, "../../workspace/preprocessed"));
Directory.CreateDirectory(preprocessedDirectory);
app.UseDefaultFiles();
app.UseStaticFiles();
app.UseStaticFiles(new StaticFileOptions {
    FileProvider = new PhysicalFileProvider(preprocessedDirectory),
    RequestPath = "/atlas-data"
});
app.MapGet("/api/health", () => Results.Ok(new { status = "ready", product = "Silksong Scene Viewer" }));
app.MapMethods("/api/preprocessed/{bucket}/{fileName}", new[] { "PUT", "POST" }, async (string bucket, string fileName, HttpRequest request,
        CancellationToken cancellationToken) => {
    var safeBucket = bucket.ToLowerInvariant();
    var extensions = safeBucket switch {
        "images" => new[] { ".png" },
        "rooms" => new[] { ".json" },
        "maps" => new[] { ".json", ".png" },
        "root" => new[] { ".json", ".txt" },
        _ => Array.Empty<string>()
    };
    var extension = Path.GetExtension(fileName);
    var stem = Path.GetFileNameWithoutExtension(fileName);
    if (extensions.Length == 0 || !extensions.Contains(extension, StringComparer.OrdinalIgnoreCase) ||
        stem.Length == 0 || stem.Any(character => !char.IsAsciiLetterOrDigit(character) && character is not ('_' or '-')) ||
        !string.Equals(fileName, Path.GetFileName(fileName), StringComparison.Ordinal))
        return Results.BadRequest(new { error = "Unsupported preprocessed file path." });
    var bucketDirectory = safeBucket == "root" ? preprocessedDirectory : Path.Combine(preprocessedDirectory, safeBucket);
    Directory.CreateDirectory(bucketDirectory);
    var destination = Path.Combine(bucketDirectory, fileName);
    if (request.Method == HttpMethods.Post) {
        using var payload = await JsonDocument.ParseAsync(request.Body, cancellationToken: cancellationToken);
        var root = payload.RootElement;
        if (!root.TryGetProperty("uploadId", out var uploadIdElement) || uploadIdElement.ValueKind != JsonValueKind.String ||
            !Guid.TryParseExact(uploadIdElement.GetString(), "N", out var uploadId) ||
            !root.TryGetProperty("offset", out var offsetElement) || !offsetElement.TryGetInt64(out var offset) || offset < 0 ||
            !root.TryGetProperty("total", out var totalElement) || !totalElement.TryGetInt64(out var total) || total <= 0 ||
            total > 16L * 1024 * 1024 * 1024 || offset >= total ||
            !root.TryGetProperty("chunkBase64", out var chunkElement) || chunkElement.ValueKind != JsonValueKind.String)
            return Results.BadRequest(new { error = "Invalid JSON chunk upload parameters." });
        const int maxJsonChunkBytes = 8 * 1024 * 1024;
        byte[] chunkBytes;
        try { chunkBytes = Convert.FromBase64String(chunkElement.GetString()!); }
        catch (FormatException) { return Results.BadRequest(new { error = "Chunk payload is not valid base64." }); }
        var expectedChunkBytes = (int)Math.Min(maxJsonChunkBytes, total - offset);
        if (chunkBytes.Length != expectedChunkBytes)
            return Results.BadRequest(new { error = $"Chunk must decode to exactly {expectedChunkBytes} bytes." });
        var chunkTemporary = destination + "." + uploadId.ToString("N") + ".upload.tmp";
        if (offset > 0 && !File.Exists(chunkTemporary) && File.Exists(destination) && new FileInfo(destination).Length == total)
            return Results.Ok(new { fileName, offset, bytes = chunkBytes.Length, receivedBytes = total, total, complete = true });
        await using (var output = new FileStream(chunkTemporary,
                         offset == 0 ? FileMode.Create : FileMode.OpenOrCreate,
                         FileAccess.Write, FileShare.None, 1024 * 1024,
                         FileOptions.Asynchronous | FileOptions.SequentialScan)) {
            if (offset > output.Length)
                return Results.Conflict(new { error = "Upload offset does not match the saved chunk position." });
            output.SetLength(offset);
            output.Position = offset;
            await output.WriteAsync(chunkBytes, cancellationToken);
            await output.FlushAsync(cancellationToken);
        }
        var receivedBytes = offset + chunkBytes.Length;
        if (receivedBytes == total) File.Move(chunkTemporary, destination, overwrite: true);
        return Results.Ok(new { fileName, offset, bytes = chunkBytes.Length, receivedBytes, total, complete = receivedBytes == total });
    }
    var uploadIdText = request.Query["uploadId"].ToString();
    if (uploadIdText.Length > 0) {
        if (!Guid.TryParseExact(uploadIdText, "N", out var uploadId) ||
            !long.TryParse(request.Query["offset"], out var offset) || offset < 0 ||
            !long.TryParse(request.Query["total"], out var total) || total <= 0 || total > 16L * 1024 * 1024 * 1024 || offset >= total)
            return Results.BadRequest(new { error = "Invalid chunk upload parameters." });
        const int maxChunkBytes = 32 * 1024 * 1024;
        var expectedBytes = (int)Math.Min(maxChunkBytes, total - offset);
        if (request.ContentLength is > maxChunkBytes) return Results.BadRequest(new { error = "Upload chunk exceeds the 32 MiB limit." });
        if (request.ContentLength is not null && request.ContentLength != expectedBytes)
            return Results.BadRequest(new { error = $"Upload chunk must contain exactly {expectedBytes} bytes." });
        var chunkTemporary = destination + "." + uploadId.ToString("N") + ".upload.tmp";
        if (offset > 0 && !File.Exists(chunkTemporary) && File.Exists(destination) && new FileInfo(destination).Length == total)
            return Results.Ok(new { fileName, offset, bytes = expectedBytes, receivedBytes = total, total, complete = true });
        try {
            await using (var output = new FileStream(chunkTemporary,
                             offset == 0 ? FileMode.Create : FileMode.OpenOrCreate,
                             FileAccess.Write, FileShare.None, 1024 * 1024,
                             FileOptions.Asynchronous | FileOptions.SequentialScan)) {
                if (offset > output.Length)
                    return Results.Conflict(new { error = "Upload offset does not match the saved chunk position." });
                // Rewriting from this offset makes retrying a chunk idempotent if
                // the client lost the response after the server finished writing.
                output.SetLength(offset);
                output.Position = offset;
                var buffer = new byte[1024 * 1024];
                var copied = 0;
                while (copied < expectedBytes) {
                    var read = await request.Body.ReadAsync(buffer.AsMemory(0, Math.Min(buffer.Length, expectedBytes - copied)), cancellationToken);
                    if (read == 0) break;
                    await output.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
                    copied += read;
                }
                if (copied != expectedBytes) {
                    await output.FlushAsync(cancellationToken);
                    return Results.BadRequest(new { error = $"Incomplete upload chunk: expected {expectedBytes} bytes, received {copied}." });
                }
                await output.FlushAsync(cancellationToken);
            }
            var receivedBytes = offset + expectedBytes;
            if (receivedBytes == total) File.Move(chunkTemporary, destination, overwrite: true);
            return Results.Ok(new { fileName, offset, bytes = expectedBytes, receivedBytes, total, complete = receivedBytes == total });
        } catch {
            // Preserve the temporary file after a disconnect so the same offset
            // can be retried; the next request truncates any partial chunk.
            throw;
        }
    }
    var temporary = destination + "." + Guid.NewGuid().ToString("N") + ".tmp";
    try {
        await using (var output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                         1024 * 1024, FileOptions.Asynchronous | FileOptions.SequentialScan))
            await request.Body.CopyToAsync(output, cancellationToken);
        File.Move(temporary, destination, overwrite: true);
        return Results.Ok(new { fileName, bytes = new FileInfo(destination).Length });
    } catch {
        if (File.Exists(temporary)) File.Delete(temporary);
        throw;
    }
});
app.MapGet("/api/artwork/{fileName}", (string fileName, SceneSourceOptions source) => {
    if (fileName.Length != 68 || !fileName.EndsWith(".png", StringComparison.OrdinalIgnoreCase) ||
        fileName[..64].Any(ch => !Uri.IsHexDigit(ch))) return Results.NotFound();
    var path = Path.Combine(source.PackageDirectory, "artwork", fileName);
    return File.Exists(path) ? Results.File(path, "image/png") : Results.NotFound();
});
app.MapGet("/api/source", (SceneSourceOptions source) => Results.Ok(new { root = source.SceneBundleDirectory }));
app.MapPost("/api/source", (SourceRequest request, SceneSourceOptions source) => {
    try {
        var root = source.SetSceneBundleDirectory(request.Root ?? "");
        return Results.Ok(new { root });
    } catch (Exception exception) when (exception is ArgumentException or DirectoryNotFoundException or InvalidDataException) {
        return Results.BadRequest(new { error = exception.Message });
    }
});
app.MapPost("/api/import-list", async (ImportListRequest request, SceneIndex index, UnityBundleInspector inspector,
        SceneSourceOptions source, CancellationToken cancellationToken) => {
    var requested = (request.Names ?? Array.Empty<string>())
        .Select(name => name?.Trim() ?? "")
        .Where(name => name.Length > 0 && !name.StartsWith('#'))
        .Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
    if (requested.Length == 0) return Results.BadRequest(new { error = "Enter at least one room name." });
    if (requested.Length > 300) return Results.BadRequest(new { error = "Import lists are limited to 300 rooms at a time." });

    var completed = new List<object>(requested.Length);
    var importedObjects = 0;
    foreach (var name in requested) {
        cancellationToken.ThrowIfCancellationRequested();
        var entry = index.Resolve(source.SceneBundleDirectory, name);
        if (entry is null) {
            completed.Add(new { requested = name, status = "missing", objectCount = 0 });
            continue;
        }
        try {
            var scene = await inspector.InspectAsync(entry, source.PackageDirectory, cancellationToken);
            importedObjects += scene.Objects.Count;
            completed.Add(new { requested = name, scene = scene.SceneName, status = "ready", objectCount = scene.Objects.Count });
        } catch (Exception exception) when (exception is IOException or InvalidDataException or
                                           InvalidOperationException or ArgumentException) {
            completed.Add(new { requested = name, scene = entry.CandidateName, status = "failed", objectCount = 0, error = exception.Message });
        }
    }
    return Results.Ok(new { requested = requested.Length, importedObjects, scenes = completed });
});
app.MapGet("/api/scenes", (SceneIndex index, SceneSourceOptions source) =>
    Results.Ok(new { source = source.SceneBundleDirectory, scenes = index.ListScenes(source.SceneBundleDirectory) }));
app.MapGet("/api/world-map", async (UnityBundleInspector inspector, SceneSourceOptions source,
        CancellationToken cancellationToken) => {
    var mapPath = source.MapBundlePath;
    if (string.IsNullOrWhiteSpace(mapPath) || !File.Exists(mapPath))
        return Results.NotFound(new { error = "The extracted Silksong maps_assets_all.bundle was not found." });
    var file = new FileInfo(mapPath);
    var entry = new SceneBundleEntry("silksong-world-map-v2", "Silksong World Map", file.FullName,
        file.Length, file.LastWriteTimeUtc, "map");
    try {
        var scene = await inspector.InspectAsync(entry, source.PackageDirectory, cancellationToken);
        return Results.Ok(scene);
    } catch (Exception exception) when (exception is IOException or InvalidDataException or
                                       InvalidOperationException or ArgumentException) {
        return Results.Problem($"Could not read the Silksong map bundle: {exception.Message}",
            statusCode: StatusCodes.Status422UnprocessableEntity);
    }
});
app.MapGet("/api/scenes/{name}", async (string name, SceneIndex index, UnityBundleInspector inspector,
        SceneSourceOptions source, ILoggerFactory loggerFactory, CancellationToken cancellationToken) => {
    var entry = index.Resolve(source.SceneBundleDirectory, name);
    if (entry is null) return Results.NotFound(new { error = $"No room bundle matched '{name}'." });
    try {
        var scene = await inspector.InspectAsync(entry, source.PackageDirectory, cancellationToken);
        return Results.Ok(scene);
    } catch (Exception exception) when (exception is IOException or InvalidDataException or
                                       InvalidOperationException or ArgumentException) {
        loggerFactory.CreateLogger("SceneImport").LogError(exception, "Could not read scene bundle {SceneBundle}", entry.BundleFile);
        return Results.Problem($"Could not read the Unity room bundle: {exception.Message}",
            statusCode: StatusCodes.Status422UnprocessableEntity);
    }
});
app.MapPost("/api/enemy-artwork", async (EnemyArtworkRequest request, EnemyArtworkCatalog catalog,
        CancellationToken cancellationToken) => {
    var placementIds = (request.PlacementIds ?? [])
        .Select(value => value?.Trim() ?? "")
        .Where(value => value.Length is > 0 and <= 180)
        .Distinct(StringComparer.OrdinalIgnoreCase).Take(150).ToArray();
    if (placementIds.Length == 0) return Results.BadRequest(new { error = "No enemy placement names were supplied." });
    var result = await catalog.FindAsync(placementIds, cancellationToken);
    return Results.Ok(result);
});
app.MapPost("/api/scenes/{name}/reimport", async (string name, SceneIndex index, UnityBundleInspector inspector,
        SceneSourceOptions source, ILoggerFactory loggerFactory, CancellationToken cancellationToken) => {
    var entry = index.Resolve(source.SceneBundleDirectory, name);
    if (entry is null) return Results.NotFound(new { error = $"No room bundle matched '{name}'." });
    try {
        var scene = await inspector.InspectAsync(entry, source.PackageDirectory, cancellationToken, forceReimport: true);
        return Results.Ok(scene);
    } catch (Exception exception) when (exception is IOException or InvalidDataException or
                                       InvalidOperationException or ArgumentException) {
        loggerFactory.CreateLogger("SceneImport").LogError(exception, "Could not rebuild scene bundle {SceneBundle}", entry.BundleFile);
        return Results.Problem($"Could not read the Unity room bundle: {exception.Message}",
            statusCode: StatusCodes.Status422UnprocessableEntity);
    }
});

if (args.Contains("--help", StringComparer.OrdinalIgnoreCase) || args.Contains("-h", StringComparer.OrdinalIgnoreCase)) {
    Console.WriteLine("Silksong Scene Viewer");
    Console.WriteLine("Usage: dotnet run --project src/SilksongSceneViewer -- [--source <scene-bundle-directory>]");
    return;
}

Console.WriteLine("Silksong Scene Viewer is starting.");
Console.WriteLine($"Scene bundles: {app.Services.GetRequiredService<SceneSourceOptions>().SceneBundleDirectory}");
Console.WriteLine($"Open http://127.0.0.1:{port} in your browser.");
await app.RunAsync();

internal sealed record SourceRequest(string? Root);
internal sealed record ImportListRequest(string[]? Names);
internal sealed record EnemyArtworkRequest(string[]? PlacementIds);
