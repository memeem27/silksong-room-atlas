using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Collections;
using BepInEx;
using BepInEx.Configuration;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace Silksong.SceneViewer.Capture;

[BepInPlugin("silksong.sceneviewer.capture", "Silksong Scene Viewer Capture", "1.0.0")]
public sealed class SceneCapturePlugin : BaseUnityPlugin {
    private ConfigEntry<KeyboardShortcut> _captureKey = null!;
    private ConfigEntry<bool> _includeRendererInventory = null!;
    private string _outputDirectory = "";
    private bool _captureInProgress;

    private void Awake() {
        _captureKey = Config.Bind("Capture", "CaptureKey", new KeyboardShortcut(KeyCode.F9),
            "Save the current game frame and a local scene/render-state manifest.");
        _includeRendererInventory = Config.Bind("Capture", "IncludeRendererInventory", true,
            "Record active and inactive renderer names, transforms, sorting values, sprites, and materials in the JSON manifest.");
        _outputDirectory = Config.Bind("Output", "Directory", Path.Combine(Paths.ConfigPath, "SilksongSceneViewerCaptures"),
            "Local folder for screenshots and JSON manifests. Nothing is uploaded.").Value;
        Logger.LogInfo($"Capture ready. Press {_captureKey.Value.MainKey} to save a frame and manifest to {_outputDirectory}");
    }

    private void Update() {
        if (_captureInProgress || !_captureKey.Value.IsDown()) return;
        StartCoroutine(CaptureAtEndOfFrame());
    }

    private IEnumerator CaptureAtEndOfFrame() {
        _captureInProgress = true;
        yield return new WaitForEndOfFrame();

        try {
            Directory.CreateDirectory(_outputDirectory);
            var activeScene = SceneManager.GetActiveScene();
            var stamp = DateTime.UtcNow.ToString("yyyyMMdd-HHmmss-fff");
            var baseName = $"{SafeName(activeScene.name)}-{stamp}-{Time.frameCount}";
            var imagePath = Path.Combine(_outputDirectory, baseName + ".png");
            var manifestPath = Path.Combine(_outputDirectory, baseName + ".json");
            var manifest = BuildManifest(activeScene, Path.GetFileName(imagePath));

            ScreenCapture.CaptureScreenshot(imagePath);
            File.WriteAllText(manifestPath, JsonUtility.ToJson(manifest, true));
            Logger.LogInfo($"Captured {activeScene.name}: {imagePath}");
        } catch (Exception exception) {
            Logger.LogError($"Scene capture failed: {exception}");
        } finally {
            _captureInProgress = false;
        }
    }

    private CaptureManifest BuildManifest(Scene activeScene, string screenshotFile) {
        var loadedScenes = new List<string>();
        var cameras = new List<CameraRecord>();
        var objects = new List<ObjectRecord>();
        var renderers = new List<RendererRecord>();

        for (var sceneIndex = 0; sceneIndex < SceneManager.sceneCount; sceneIndex++) {
            var scene = SceneManager.GetSceneAt(sceneIndex);
            if (!scene.IsValid() || !scene.isLoaded) continue;
            loadedScenes.Add(scene.name);
            foreach (var root in scene.GetRootGameObjects()) {
                foreach (var transform in root.GetComponentsInChildren<Transform>(true)) {
                    var gameObject = transform.gameObject;
                    var objectRecord = new ObjectRecord {
                        scene = scene.name,
                        name = gameObject.name,
                        path = HierarchyPath(transform),
                        activeSelf = gameObject.activeSelf,
                        activeInHierarchy = gameObject.activeInHierarchy,
                        position = transform.position,
                        rotation = transform.rotation,
                        localScale = transform.localScale,
                        components = gameObject.GetComponents<Component>()
                            .Where(component => component != null)
                            .Select(component => component!.GetType().FullName ?? component.GetType().Name)
                            .ToArray()
                    };
                    objects.Add(objectRecord);
                    if (!_includeRendererInventory.Value) continue;

                    foreach (var renderer in gameObject.GetComponents<Renderer>())
                        renderers.Add(DescribeRenderer(scene.name, transform, renderer));
                }
            }
        }

        foreach (var camera in Camera.allCameras) {
            if (camera == null) continue;
            cameras.Add(new CameraRecord {
                name = camera.name,
                scene = camera.gameObject.scene.name,
                enabled = camera.enabled && camera.gameObject.activeInHierarchy,
                position = camera.transform.position,
                rotation = camera.transform.rotation,
                orthographic = camera.orthographic,
                orthographicSize = camera.orthographicSize,
                fieldOfView = camera.fieldOfView,
                aspect = camera.aspect,
                depth = camera.depth,
                pixelRect = camera.pixelRect,
                cullingMask = camera.cullingMask,
                transparencySortMode = camera.transparencySortMode.ToString(),
                transparencySortAxis = camera.transparencySortAxis,
                projectionMatrix = MatrixToArray(camera.projectionMatrix),
                worldToCameraMatrix = MatrixToArray(camera.worldToCameraMatrix)
            });
        }

        return new CaptureManifest {
            schemaVersion = 1,
            capturedAtUtc = DateTime.UtcNow.ToString("O"),
            gameVersion = Application.version,
            activeScene = activeScene.name,
            loadedScenes = loadedScenes.ToArray(),
            screenshotFile = screenshotFile,
            screenWidth = Screen.width,
            screenHeight = Screen.height,
            frameCount = Time.frameCount,
            gameTimeSeconds = Time.time,
            cameras = cameras.ToArray(),
            objects = objects.ToArray(),
            renderers = renderers.ToArray()
        };
    }

    private static RendererRecord DescribeRenderer(string sceneName, Transform transform, Renderer renderer) {
        var spriteRenderer = renderer as SpriteRenderer;
        var particleRenderer = renderer as ParticleSystemRenderer;
        var materials = renderer.sharedMaterials.Where(material => material != null).ToArray();
        return new RendererRecord {
            scene = sceneName,
            gameObject = transform.gameObject.name,
            path = HierarchyPath(transform),
            rendererType = renderer.GetType().FullName ?? renderer.GetType().Name,
            activeInHierarchy = transform.gameObject.activeInHierarchy,
            enabled = renderer.enabled,
            position = transform.position,
            rotation = transform.rotation,
            localScale = transform.localScale,
            sortingLayerId = renderer.sortingLayerID,
            sortingLayerName = SortingLayer.IDToName(renderer.sortingLayerID),
            sortingOrder = renderer.sortingOrder,
            sortingGroup = transform.GetComponent<UnityEngine.Rendering.SortingGroup>()?.name ?? "",
            sprite = spriteRenderer != null ? spriteRenderer.sprite?.name ?? "" : "",
            spriteColor = spriteRenderer != null ? spriteRenderer.color : Color.white,
            particleCount = particleRenderer != null && transform.TryGetComponent<ParticleSystem>(out var particleSystem)
                ? particleSystem.particleCount : 0,
            materials = materials.Select(material => material.name).ToArray(),
            shaders = materials.Select(material => material.shader != null ? material.shader.name : "").ToArray()
        };
    }

    private static string HierarchyPath(Transform transform) {
        var parts = new Stack<string>();
        var current = transform;
        while (current != null) {
            parts.Push(current.name);
            current = current.parent;
        }
        return string.Join("/", parts);
    }

    private static float[] MatrixToArray(Matrix4x4 matrix) => new[] {
        matrix.m00, matrix.m01, matrix.m02, matrix.m03,
        matrix.m10, matrix.m11, matrix.m12, matrix.m13,
        matrix.m20, matrix.m21, matrix.m22, matrix.m23,
        matrix.m30, matrix.m31, matrix.m32, matrix.m33
    };

    private static string SafeName(string value) {
        var invalid = Path.GetInvalidFileNameChars().ToHashSet();
        var sanitized = new string(value.Select(character => invalid.Contains(character) ? '_' : character).ToArray()).Trim();
        return sanitized.Length == 0 ? "scene" : sanitized;
    }

    [Serializable]
    private sealed class CaptureManifest {
        public int schemaVersion;
        public string capturedAtUtc = "";
        public string gameVersion = "";
        public string activeScene = "";
        public string[] loadedScenes = Array.Empty<string>();
        public string screenshotFile = "";
        public int screenWidth;
        public int screenHeight;
        public int frameCount;
        public float gameTimeSeconds;
        public CameraRecord[] cameras = Array.Empty<CameraRecord>();
        public ObjectRecord[] objects = Array.Empty<ObjectRecord>();
        public RendererRecord[] renderers = Array.Empty<RendererRecord>();
    }

    [Serializable]
    private sealed class CameraRecord {
        public string name = "";
        public string scene = "";
        public bool enabled;
        public Vector3 position;
        public Quaternion rotation;
        public bool orthographic;
        public float orthographicSize;
        public float fieldOfView;
        public float aspect;
        public float depth;
        public Rect pixelRect;
        public int cullingMask;
        public string transparencySortMode = "";
        public Vector3 transparencySortAxis;
        public float[] projectionMatrix = Array.Empty<float>();
        public float[] worldToCameraMatrix = Array.Empty<float>();
    }

    [Serializable]
    private sealed class ObjectRecord {
        public string scene = "";
        public string name = "";
        public string path = "";
        public bool activeSelf;
        public bool activeInHierarchy;
        public Vector3 position;
        public Quaternion rotation;
        public Vector3 localScale;
        public string[] components = Array.Empty<string>();
    }

    [Serializable]
    private sealed class RendererRecord {
        public string scene = "";
        public string gameObject = "";
        public string path = "";
        public string rendererType = "";
        public bool activeInHierarchy;
        public bool enabled;
        public Vector3 position;
        public Quaternion rotation;
        public Vector3 localScale;
        public int sortingLayerId;
        public string sortingLayerName = "";
        public int sortingOrder;
        public string sortingGroup = "";
        public string sprite = "";
        public Color spriteColor;
        public int particleCount;
        public string[] materials = Array.Empty<string>();
        public string[] shaders = Array.Empty<string>();
    }
}
