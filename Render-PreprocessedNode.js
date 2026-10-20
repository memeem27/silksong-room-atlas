#!/usr/bin/env node
'use strict';

// Offline room renderer for recovery/rebuild runs. It evaluates the same
// renderer functions used by the standalone viewer against a native Canvas
// implementation, so it uses the real cached Silksong atlas PNGs without
// needing a browser window or changing the scene-rendering rules.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createWriteStream } = require('node:fs');
const { once } = require('node:events');
const { finished } = require('node:stream/promises');

let canvasApi;
try {
  canvasApi = require('@napi-rs/canvas');
} catch (error) {
  throw new Error('Install the renderer dependency with `npm install` before running this tool.', { cause: error });
}
const { createCanvas, loadImage } = canvasApi;

const projectRoot = __dirname;
const workspaceRoot = path.join(projectRoot, 'workspace', 'preprocessed');
const sceneSource = path.join(projectRoot, 'src', 'SilksongSceneViewer', 'wwwroot', 'app.js');
const artworkRoot = path.join(projectRoot, 'workspace', 'scenes', 'artwork');
const defaultManifest = path.join(workspaceRoot, 'manifest.json');

function parseArguments(argv) {
  const options = { manifest: defaultManifest, outputRoot: workspaceRoot, suffix: 'native', manifestName: 'manifest-retry-native.json', scenes: [], limit: 0, resume: true, inactive: true, colors: false, disabledRenderers: false, boundedPreview: false };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    const next = () => {
      if (index + 1 >= argv.length) throw new Error(`Missing value for ${value}`);
      return argv[++index];
    };
    if (value === '--manifest') options.manifest = path.resolve(next());
    else if (value === '--output-root') options.outputRoot = path.resolve(next());
    else if (value === '--suffix') options.suffix = next().replace(/[^a-z0-9_-]/gi, '');
    else if (value === '--checkpoint') options.manifestName = next();
    else if (value === '--scene') options.scenes.push(next().trim().toLowerCase());
    else if (value === '--limit') options.limit = Math.max(0, Number.parseInt(next(), 10) || 0);
    else if (value === '--no-resume') options.resume = false;
    else if (value === '--active-only') options.inactive = false;
    else if (value === '--include-disabled-renderers') options.disabledRenderers = true;
    else if (value === '--bounded-preview') options.boundedPreview = true;
    else if (value === '--renderer-colors') options.colors = true;
    else if (value === '--no-renderer-colors') options.colors = false;
    else if (value === '--help' || value === '-h') options.help = true;
    else throw new Error(`Unknown option: ${value}`);
  }
  if (!options.suffix) throw new Error('The output suffix cannot be empty.');
  if (!/^[a-z0-9_-]+\.json$/i.test(options.manifestName)) throw new Error('Checkpoint name must be a simple JSON filename.');
  return options;
}

function printHelp() {
  process.stdout.write(`Render Silksong room sidecars to staged, real-game-asset PNGs.\n\n` +
    `Usage: node Render-PreprocessedNode.js [options]\n\n` +
    `  --scene NAME          Render one room (repeatable)\n` +
    `  --limit N             Render only the first N rooms from the base manifest\n` +
    `  --suffix NAME         Staged output suffix (default: native)\n` +
    `  --checkpoint FILE     Checkpoint manifest name (default: manifest-retry-native.json)\n` +
    `  --manifest FILE       Base manifest (default: workspace/preprocessed/manifest.json)\n` +
    `  --output-root DIR     Output root (default: workspace/preprocessed)\n` +
    `  --no-resume           Re-render rooms even when a valid checkpoint exists\n` +
    `  --active-only         Do not include progression-hidden renderers\n` +
    `  --renderer-colors    Apply serialized SpriteRenderer tint (default: ignored)\n` +
    `  --bounded-preview     Cap output at 25 megapixels instead of writing oversized native intermediates\n` +
    `  --include-disabled-renderers  Include renderers disabled in the Unity scene (default: excluded)\n`);
}

function findFunction(source, name) {
  const pattern = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`, 'g');
  const match = pattern.exec(source);
  if (!match) throw new Error(`Renderer function not found in app.js: ${name}`);
  const start = match.index;
  const open = source.indexOf('{', pattern.lastIndex);
  if (open < 0) throw new Error(`Renderer function body not found: ${name}`);
  let depth = 0, quote = '', escaped = false, lineComment = false, blockComment = false;
  for (let cursor = open; cursor < source.length; cursor++) {
    const ch = source[cursor], next = source[cursor + 1];
    if (lineComment) { if (ch === '\n') lineComment = false; continue; }
    if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; cursor++; } continue; }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; cursor++; continue; }
    if (ch === '/' && next === '*') { blockComment = true; cursor++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return source.slice(start, cursor + 1);
  }
  throw new Error(`Unterminated renderer function: ${name}`);
}

function makeRendererContext(source, { inactive, colors, disabledRenderers }) {
  const names = [
    'isGameBundleTexture', 'objectIsActive', 'manualVisibilityFor', 'normalizeSceneArtworkName',
    'isKnownEnemyArtworkName', 'isKnownEnemyActorName',
    'isEnemyArtworkObject', 'buildObjectStateIndex', 'setGroupOverride',
    'spritePassesFilters', 'meshPassesFilters', 'isGeneratedCollisionTileMesh', 'visibleSpriteBounds',
    'nativeArtworkPixelsPerUnit', 'spriteLocalGeometry', 'spriteWorldMatrix', 'drawArtworkLayer',
    'getTintedSpriteCrop', 'drawTexturedMesh', 'canvasBlendMode', 'isScreenEffect', 'isSceneBorderArtwork',
    'isLightingArtwork', 'isSafeAmbientLightingArtwork', 'textureHashFromUrl', 'waitForDecodedImage', 'batchRenderInactiveEnabled',
    'batchRendererColorsEnabled', 'batchIncludeDisabledRenderersEnabled', 'encodePngChunk', 'renderBatchScenePngTiled', 'renderBatchScene',
    'batchFilteredEffectSummary'
  ];
  const functions = names.map(name => findFunction(source, name)).join('\n\n');
  const context = {
    createCanvas, loadImage, console, setTimeout, clearTimeout, Promise, Map, Set, Math, Number, String, Object,
    Array, RegExp, TextEncoder, DataView, Uint8Array, Uint8ClampedArray, Blob, CompressionStream,
    URLSearchParams,
    document: { createElement(name) { if (name !== 'canvas') throw new Error(`Unsupported headless element: ${name}`); return createCanvas(1, 1); } },
    window: { location: { search: `?batchRenderInactive=${inactive ? '1' : '0'}&batchRendererColors=${colors ? '1' : '0'}&batchIncludeDisabledRenderers=${disabledRenderers ? '1' : '0'}` } }
  };
  vm.createContext(context);
  const bootstrap = `
    const state = {
      scene: null, objectById: new Map(), meshAssets: new Map(), images: new Map(),
      tintedSpriteImages: new Map(), objectVisibilityOverrides: new Map(),
      batchDefaultStateOverrides: new Map(), hiddenSortingLayers: new Set(),
      batchRendering: true, batchServerOutput: true
    };
    const componentsOf = object => object.components || [];
    const byId = () => ({ checked: false, value: '' });
    const zipCrcTable = (() => {
      const table = new Uint32Array(256);
      for (let index = 0; index < 256; index++) {
        let value = index;
        for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
        table[index] = value >>> 0;
      }
      return table;
    })();
    ${functions}
    function loadSceneImage(url) { return state.images.get(url) || { complete: true, naturalWidth: 0, naturalHeight: 0 }; }
    globalThis.__state = state;
    globalThis.__helpers = {
      buildObjectStateIndex, setGroupOverride, objectIsActive, isKnownEnemyActorName, renderBatchScene,
      batchFilteredEffectSummary, batchRenderInactiveEnabled, batchRendererColorsEnabled, batchIncludeDisabledRenderersEnabled
    };
  `;
  vm.runInContext(bootstrap, context, { filename: 'SilksongSceneViewer-render-functions.js' });
  return { context, state: context.__state, helpers: context.__helpers };
}

function textureUrl(hash) {
  return /^[a-f0-9]{64}$/i.test(String(hash || '')) ? `/api/artwork/${hash.toLowerCase()}.png` : '';
}

function sceneForRenderer(metadata) {
  return {
    sceneName: metadata.scene?.name,
    sourceBundle: metadata.scene?.source?.bundle,
    sourceSha256: metadata.scene?.source?.sha256,
    schemaVersion: metadata.scene?.sourceSchemaVersion,
    diagnostics: metadata.scene?.diagnostics || [],
    objects: (metadata.objects || []).map(object => ({
      ...object,
      sprites: (object.sprites || []).map(sprite => ({ ...sprite, imageUrl: textureUrl(sprite.textureSha256) })),
      meshes: (object.meshes || []).map(mesh => ({ ...mesh, imageUrl: textureUrl(mesh.textureSha256) }))
    })),
    meshAssets: metadata.meshAssets || []
  };
}

function attachDefaultWorldState(renderer, scene) {
  const objects = scene.objects || [];
  renderer.state.scene = scene;
  renderer.state.objectById = new Map(objects.map(object => [object.id, object]));
  renderer.state.meshAssets = new Map((scene.meshAssets || []).map(asset => [asset.id, asset]));
  renderer.state.images = new Map();
  renderer.state.tintedSpriteImages = new Map();
  renderer.state.objectVisibilityOverrides = new Map();
  renderer.state.batchDefaultStateOverrides = new Map();
  const stateIndex = renderer.helpers.buildObjectStateIndex(objects);
  for (const group of stateIndex.groups) {
    const normalWorld = group.options.find(option => option.name.trim().toLowerCase() === 'normal world');
    if (normalWorld) renderer.helpers.setGroupOverride(group, normalWorld.id);
    else if (renderer.helpers.batchRenderInactiveEnabled()) {
      const activeOptions = group.options.filter(option => renderer.helpers.objectIsActive(renderer.state.objectById.get(option.id)));
      for (const option of group.options)
        renderer.state.objectVisibilityOverrides.set(option.id, activeOptions.includes(option) ? 'show' : 'hide');
    }
    for (const [id, visibility] of renderer.state.objectVisibilityOverrides)
      renderer.state.batchDefaultStateOverrides.set(id, visibility);
  }
}

function pointToImage(point, render) {
  if (!point || !render.bounds || !render.ppu) return null;
  return {
    x: 2 + ((Number(point.x) || 0) - render.bounds.minX) * render.ppu,
    y: 2 + (render.bounds.maxY - (Number(point.y) || 0)) * render.ppu
  };
}

function refreshedMetadata(previous, scene, render, outputName, status, renderer) {
  const result = structuredClone(previous);
  const imageFile = render.blob ? `images/${outputName}.png` : null;
  const previewFile = render.previewBlob ? `images/${outputName}-preview.png` : imageFile;
  result.status = status;
  result.image = render.blob ? {
    ...(result.image || {}), file: imageFile, previewFile, mimeType: 'image/png', alpha: true,
    width: render.width, height: render.height, pixelsPerWorldUnit: render.ppu,
    requestedPixelsPerWorldUnit: render.nativePpu, resolutionLimited: render.resolutionLimited,
    previewWidth: render.previewWidth, previewHeight: render.previewHeight,
    previewPixelsPerWorldUnit: render.previewPpu, bounds: render.bounds,
    worldToPixel: { x: '2 + (worldX - bounds.minX) * pixelsPerWorldUnit', y: '2 + (bounds.maxY - worldY) * pixelsPerWorldUnit' }
  } : null;
  result.objects = (scene.objects || []).map((object, index) => {
    const oldObject = result.objects?.find(candidate => candidate.id === object.id) || previous.objects?.[index] || object;
    const worldPosition = object.worldPosition || { x: 0, y: 0, z: 0 };
    return {
      ...oldObject, worldPosition,
      classification: oldObject.classification?.enemy || renderer.helpers.isKnownEnemyActorName(object.name)
        ? { ...(oldObject.classification || {}), enemy: true } : oldObject.classification,
      activeInRoom: renderer.helpers.objectIsActive(object),
      imagePixel: pointToImage(worldPosition, render),
      colliders: (oldObject.colliders || []).map(collider => ({
        ...collider,
        imagePoints: (collider.worldPoints || []).map(point => pointToImage(point, render))
      }))
    };
  });
  const counts = result.objects.reduce((total, object) => {
    total.active += object.activeInRoom ? 1 : 0;
    total.enemyCandidates += object.classification?.enemy ? 1 : 0;
    total.spawnCandidates += object.classification?.spawn ? 1 : 0;
    total.checkCandidates += object.classification?.check ? 1 : 0;
    return total;
  }, { objectCount: result.objects.length, active: 0, enemyCandidates: 0, spawnCandidates: 0, checkCandidates: 0 });
  result.counts = counts;
  const overrides = Object.fromEntries(renderer.state.batchDefaultStateOverrides);
  result.render = {
    ...(result.render || {}),
    profile: renderer.helpers.batchRenderInactiveEnabled() ? 'all-in-room-silksong-bundle-renderers' : 'serialized-active-plus-normal-world-branches',
    nativeResolutionDensityBasis: renderer.helpers.batchRenderInactiveEnabled()
      ? 'active room renderers; progression-hidden artwork is drawn at the same density'
      : 'selected active-state room renderers',
    activeRenderersOnly: !renderer.helpers.batchRenderInactiveEnabled() && Object.keys(overrides).length === 0,
    inactiveRenderersIncluded: renderer.helpers.batchRenderInactiveEnabled() || Object.keys(overrides).length > 0,
    inactiveArtworkClippedToActiveBounds: renderer.helpers.batchRenderInactiveEnabled(),
    disabledRenderersIncluded: renderer.helpers.batchIncludeDisabledRenderersEnabled(),
    defaultStateOverrides: overrides,
    normalWorldBranchesIncluded: Object.keys(overrides).length > 0,
    gameBundleTexturesOnly: true, screenEffectsIncluded: render.screenEffectsIncluded,
    rendererColorsApplied: render.rendererColorsApplied,
    shaderDrivenLightingIncluded: false, shaderDrivenMaskArtworkIncluded: false,
    viewerAnnotations: false, architectModAssets: false, runtimeLightingSimulation: false,
    enemyArtworkInBaseImage: false, enemyArtworkAvailableAsOverlay: true,
    eligibleRendererCount: render.rendererCount || 0, textureCount: render.textureCount || 0,
    missingTextureSha256: render.missingTextures || [],
    filteredEffectRenderers: renderer.helpers.batchFilteredEffectSummary(scene.objects || []),
    sorting: 'Unity sorting group, layer, order, and depth sequence; unresolved layer mappings are excluded',
    excluded: [
      ...(!renderer.helpers.batchRenderInactiveEnabled() ? ['inactive objects outside selected Normal World branches'] : []),
      ...(!renderer.helpers.batchIncludeDisabledRenderersEnabled() ? ['disabled renderers'] : []),
      'enemy object subtrees', 'known enemy actor sprites and enemy-only animation frames',
      'generated collision-only tile chunk meshes', 'destination blend renderers',
      ...(!render.screenEffectsIncluded ? ['shader-driven mask/light/fog effects'] : []),
      ...(renderer.helpers.batchRenderInactiveEnabled() ? ['inactive artwork outside active room bounds'] : []), 'non-bundle textures'
    ]
  };
  return result;
}

async function writePartsAtomically(parts, filePath) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.partial`;
  await fsp.rm(temporary, { force: true });
  const stream = createWriteStream(temporary, { flags: 'w' });
  const completion = finished(stream);
  try {
    for (const part of parts) {
      const bytes = Buffer.from(part.buffer, part.byteOffset, part.byteLength);
      if (!stream.write(bytes)) await once(stream, 'drain');
    }
    stream.end();
    await completion;
    await fsp.rename(temporary, filePath);
  } catch (error) {
    stream.destroy();
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function simpleBaseName(name) {
  return String(name || 'room').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '') || 'room';
}

function countStatuses(rooms) {
  return rooms.reduce((counts, room) => { counts[room.status] = (counts[room.status] || 0) + 1; return counts; }, {});
}

async function atomicJson(filePath, value) {
  const temporary = `${filePath}.${process.pid}.partial`;
  await fsp.writeFile(temporary, JSON.stringify(value));
  await fsp.rename(temporary, filePath);
}

async function readJson(filePath) {
  return JSON.parse((await fsp.readFile(filePath, 'utf8')).replace(/^\uFEFF/, ''));
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) { printHelp(); return; }
  const appCode = await fsp.readFile(sceneSource, 'utf8');
  const appHash = crypto.createHash('sha256').update(appCode).digest('hex');
  const baseManifest = await readJson(options.manifest);
  if (!baseManifest.complete || !Array.isArray(baseManifest.rooms) || !baseManifest.rooms.length)
    throw new Error('The base preprocessed manifest must be complete and contain room entries.');
  let selected = baseManifest.rooms;
  if (options.scenes.length) {
    const requested = new Set(options.scenes);
    selected = selected.filter(room => requested.has(String(room.name || '').toLowerCase()));
    const found = new Set(selected.map(room => String(room.name || '').toLowerCase()));
    const missing = [...requested].filter(name => !found.has(name));
    if (missing.length) throw new Error(`Scenes not found in base manifest: ${missing.join(', ')}`);
  }
  if (options.limit) selected = selected.slice(0, options.limit);
  const fullPass = !options.scenes.length && !options.limit && path.resolve(options.outputRoot) === workspaceRoot && options.suffix === 'native';
  const checkpointPath = path.join(options.outputRoot, options.manifestName);
  let previous = null;
  if (options.resume && fs.existsSync(checkpointPath)) {
    previous = await readJson(checkpointPath);
    if (previous.rendererSourceSha256 !== appHash || previous.outputSuffix !== options.suffix) {
      process.stdout.write('Existing checkpoint uses a different renderer version; starting a fresh pass.\n');
      previous = null;
    }
  }
  const completed = new Map((previous?.rooms || []).map(room => [String(room.name || '').toLowerCase(), room]));
  const renderer = makeRendererContext(appCode, options);
  const state = renderer.state;
  const imageCache = new Map();
  let imageCacheBytes = 0;
  const maxCacheBytes = 256 * 1024 * 1024;
  async function getTexture(hash) {
    if (!hash) return null;
    if (imageCache.has(hash)) {
      const cached = imageCache.get(hash);
      imageCache.delete(hash); imageCache.set(hash, cached);
      return cached.image;
    }
    const filePath = path.join(artworkRoot, `${hash}.png`);
    try {
      const image = await loadImage(filePath);
      const bytes = image.width * image.height * 4;
      imageCache.set(hash, { image, bytes }); imageCacheBytes += bytes;
      while (imageCacheBytes > maxCacheBytes && imageCache.size > 1) {
        const [oldHash, old] = imageCache.entries().next().value;
        imageCache.delete(oldHash); imageCacheBytes -= old.bytes;
      }
      return image;
    } catch {
      return null;
    }
  }
  const passRooms = previous?.rendererSourceSha256 === appHash && previous?.outputSuffix === options.suffix
    ? [...(previous.rooms || [])] : [];
  const passNames = new Set(passRooms.map(room => String(room.name || '').toLowerCase()));
  const startedAt = Date.now();
  let processedThisRun = 0;
  const writeCheckpoint = async (complete, canceled = false) => {
    const counts = countStatuses(passRooms);
    const checkpoint = {
      format: 'silksong-room-atlas', formatVersion: 2, createdAt: new Date().toISOString(),
      rendererSourceSha256: appHash, outputSuffix: options.suffix,
      complete: Boolean(complete), canceled, cameraSectionPass: false,
      workerComplete: Boolean(complete), workerIndex: 0, workerCount: 1,
      requestedSceneCount: selected.length, processedSceneCount: passRooms.length,
      unprocessedSceneCount: Math.max(0, selected.length - passRooms.length), counts,
      sourceFolderName: baseManifest.sourceFolderName || null,
      renderProfile: {
        gameBundleTexturesOnly: true, activeRenderersOnly: !options.inactive,
        inactiveRenderersIncluded: options.inactive, inactiveArtworkClippedToActiveBounds: options.inactive,
        disabledRenderersIncluded: options.disabledRenderers,
        nativeResolutionDensityBasis: options.inactive ? 'active room renderers; progression-hidden artwork is drawn at the same density' : 'selected active-state room renderers',
        rendererColorsApplied: options.colors, backgroundArtworkIncluded: true,
        lightingRendererArtworkIncluded: true, safeAmbientLightingIncluded: true,
        shaderDrivenLightingIncluded: false, runtimeLightingSimulation: false,
        viewerAnnotations: false, architectModAssets: false, architectPlacementMetadataIncluded: true,
        png: 'native texture density; full-resolution PNGs with optional bounded-size reader previews'
      },
      rooms: passRooms
    };
    await atomicJson(checkpointPath, checkpoint);
  };

  process.stdout.write(`Rendering ${selected.length} room(s) with ${options.inactive ? 'progression-hidden art enabled' : 'active renderers only'}, renderer colors ${options.colors ? 'enabled' : 'disabled'}.\n`);
  for (let index = 0; index < selected.length; index++) {
    const sourceRoom = selected[index];
    const sceneName = String(sourceRoom.name || '');
    const key = sceneName.toLowerCase();
    const outputName = `${simpleBaseName(sceneName)}-${options.suffix}`;
    const roomMetadataPath = path.join(options.outputRoot, 'rooms', `${outputName}.json`);
    const nativeImagePath = path.join(options.outputRoot, 'images', `${outputName}.png`);
    const previewImagePath = path.join(options.outputRoot, 'images', `${outputName}-preview.png`);
    const oldCheckpoint = completed.get(key);
    const checkpointFilesValid = oldCheckpoint && oldCheckpoint.status !== 'failed' && oldCheckpoint.status !== 'render-failed' &&
      fs.existsSync(roomMetadataPath) && (!oldCheckpoint.image || fs.existsSync(nativeImagePath)) &&
      (!oldCheckpoint.previewImage || fs.existsSync(previewImagePath));
    if (options.resume && passNames.has(key) && checkpointFilesValid) {
      process.stdout.write(`[${index + 1}/${selected.length}] ${sceneName}: checkpoint valid, skipped.\n`);
      continue;
    }

    const roomStarted = Date.now();
    let status = 'failed', errorMessage = null, missingTextures = [];
    let metadata = null, render = null, scene = null;
    try {
      const existingMetadataPath = path.join(options.outputRoot, sourceRoom.metadata || `rooms/${simpleBaseName(sceneName)}.json`);
      metadata = await readJson(existingMetadataPath);
      if (metadata.format !== 'silksong-room-atlas-room' || !Array.isArray(metadata.objects))
        throw new Error('Room sidecar is missing or has an unsupported format.');
      scene = sceneForRenderer(metadata);
      attachDefaultWorldState(renderer, scene);
      const hashes = new Set(scene.objects.flatMap(object => [...(object.sprites || []), ...(object.meshes || [])]
        .map(item => item.textureSha256).filter(hash => /^[a-f0-9]{64}$/i.test(String(hash || '')))));
      for (const hash of hashes) {
        const image = await getTexture(hash);
        if (image) state.images.set(textureUrl(hash), image);
      }
      const outputLimits = options.boundedPreview ? { maxEdge: 32760, maxPixels: 25_000_000 } : null;
      render = await renderer.helpers.renderBatchScene(scene.objects, false, null, null, outputLimits);
      missingTextures = render.missingTextures || [];
      if (missingTextures.length) throw new Error(`Missing game texture atlases: ${missingTextures.join(', ')}`);
      if (render.blob) {
        await writePartsAtomically(render.blob.pngParts, nativeImagePath);
        if (render.previewBlob) await writePartsAtomically(render.previewBlob.pngParts, previewImagePath);
        else await fsp.rm(previewImagePath, { force: true });
        status = 'exported';
      } else {
        await fsp.rm(nativeImagePath, { force: true });
        await fsp.rm(previewImagePath, { force: true });
        status = 'no-artwork';
      }
      const refreshed = refreshedMetadata(metadata, scene, render, outputName, status, renderer);
      await atomicJson(roomMetadataPath, refreshed);
      const previewRelative = render.previewBlob ? `images/${outputName}-preview.png` : undefined;
      const imageRelative = render.blob ? `images/${outputName}.png` : null;
      const room = {
        name: sceneName, order: sourceRoom.order, kind: sourceRoom.kind || 'room', status,
        image: imageRelative, ...(previewRelative ? { previewImage: previewRelative } : {}),
        metadata: `rooms/${outputName}.json`, objectCount: refreshed.counts?.objectCount || 0,
        cameraViews: sourceRoom.cameraViews || undefined
      };
      const priorIndex = passRooms.findIndex(item => String(item.name || '').toLowerCase() === key);
      if (priorIndex >= 0) passRooms[priorIndex] = room; else passRooms.push(room);
      passRooms.sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
      completed.set(key, room); passNames.add(key);
      processedThisRun++;
      await writeCheckpoint(false);
      const dims = render.blob ? `${render.width}×${render.height} px @ ${render.ppu.toFixed(1)} px/u` : 'no renderable bundle art';
      const bytes = render.blob?.size ? ` · ${(render.blob.size / 1024 / 1024).toFixed(1)} MiB` : '';
      process.stdout.write(`[${index + 1}/${selected.length}] ${sceneName}: ${status} · ${dims}${bytes} · ${(Date.now() - roomStarted) / 1000 | 0}s\n`);
    } catch (error) {
      errorMessage = String(error?.message || error);
      status = scene ? 'render-failed' : 'failed';
      const failedRoom = {
        name: sceneName, order: sourceRoom.order, kind: sourceRoom.kind || 'room', status,
        image: null, metadata: sourceRoom.metadata || `rooms/${simpleBaseName(sceneName)}.json`, error: errorMessage,
        objectCount: sourceRoom.objectCount || 0
      };
      const priorIndex = passRooms.findIndex(item => String(item.name || '').toLowerCase() === key);
      if (priorIndex >= 0) passRooms[priorIndex] = failedRoom; else passRooms.push(failedRoom);
      passRooms.sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
      await writeCheckpoint(false);
      process.stderr.write(`[${index + 1}/${selected.length}] ${sceneName}: ${status}: ${errorMessage}\n`);
    } finally {
      state.images.clear(); state.tintedSpriteImages.clear(); state.objectById.clear(); state.meshAssets.clear();
      state.objectVisibilityOverrides.clear(); state.batchDefaultStateOverrides.clear();
      state.scene = null;
      render = null; scene = null; metadata = null;
      if (global.gc) global.gc();
    }
  }
  const allDone = passRooms.length === selected.length && passRooms.every(room => room.status === 'exported' || room.status === 'no-artwork');
  await writeCheckpoint(allDone);
  const elapsed = ((Date.now() - startedAt) / 60000).toFixed(1);
  process.stdout.write(`Finished ${processedThisRun} newly rendered room(s) in ${elapsed} min. ` +
    `${passRooms.length}/${selected.length} checkpointed; status counts ${JSON.stringify(countStatuses(passRooms))}.\n`);
  if (fullPass && allDone) process.stdout.write('Full room pass is ready for visual QA and Merge-PreprocessedRetries.ps1.\n');
  if (!allDone) process.exitCode = 2;
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
