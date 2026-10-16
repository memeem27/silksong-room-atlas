#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const workspaceRoot = path.resolve(process.argv[2] || path.join(__dirname, 'workspace', 'preprocessed'));
const manifestPath = path.join(workspaceRoot, 'manifest.json');
const missingTextureRefs = new Set();

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(value), 'utf8');
  fs.renameSync(temporaryPath, filePath);
}

function fail(message) {
  throw new Error(message);
}

function normalizedName(value) {
  return String(value || '').trim().toLowerCase();
}

function resolveWorkspaceFile(relativePath) {
  if (!relativePath) return null;
  return path.resolve(workspaceRoot, String(relativePath).replace(/[\\/]/g, path.sep));
}

function ensureWorkspacePath(filePath, description) {
  const relative = path.relative(workspaceRoot, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) fail(`${description} escapes the preprocessed workspace.`);
}

try {
  if (!fs.existsSync(manifestPath)) fail(`Base scene manifest not found: ${manifestPath}`);
  const manifest = readJson(manifestPath);
  if (!manifest.complete) fail('The base scene pass must be complete before camera views are merged.');

  const workerPaths = fs.readdirSync(workspaceRoot)
    .filter(name => /^manifest-retry-worker-\d+\.json$/i.test(name))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map(name => path.join(workspaceRoot, name));
  if (!workerPaths.length) fail('No completed camera-view worker manifests were found.');
  const workers = workerPaths.map(readJson);
  const expectedWorkers = Number(workers[0].workerCount);
  if (workerPaths.length !== expectedWorkers || workers.filter(worker => worker.workerComplete && worker.cameraSectionPass).length !== expectedWorkers) {
    fail(`Camera-view workers are incomplete: found ${workerPaths.length} of ${expectedWorkers} complete worker manifests.`);
  }
  if (workers.some(worker => Number(worker.workerCount) !== expectedWorkers || !worker.cameraSectionPass)) {
    fail('Worker manifests disagree about the camera-view pass.');
  }

  const expectedNamesPath = path.join(workspaceRoot, 'camera-limited-scenes.txt');
  if (!fs.existsSync(expectedNamesPath)) fail('The capped-room name list is missing.');
  const expectedNames = fs.readFileSync(expectedNamesPath, 'utf8').split(/\r?\n/).map(normalizedName).filter(Boolean);
  const workerRooms = workers.flatMap(worker => Array.isArray(worker.rooms) ? worker.rooms : []);
  const workerNames = workerRooms.map(room => normalizedName(room.name));
  if (workerNames.length !== expectedNames.length || new Set(workerNames).size !== workerNames.length) {
    fail(`Camera worker coverage mismatch: expected ${expectedNames.length} capped rooms, found ${workerNames.length}.`);
  }
  const workerNameSet = new Set(workerNames);
  const missingNames = expectedNames.filter(name => !workerNameSet.has(name));
  const expectedNameSet = new Set(expectedNames);
  const extraNames = workerNames.filter(name => !expectedNameSet.has(name));
  if (missingNames.length || extraNames.length) {
    fail(`Camera worker room list mismatch. Missing ${missingNames.length}, unexpected ${extraNames.length}.`);
  }

  const cleanupManifestPaths = [...workerPaths];
  const runs = [...workers];
  const singleManifestPath = path.join(workspaceRoot, 'manifest-retry.json');
  if (fs.existsSync(singleManifestPath)) {
    const singleRun = readJson(singleManifestPath);
    if (!singleRun.complete || !singleRun.workerComplete || !singleRun.cameraSectionPass || Number(singleRun.workerCount) !== 1) {
      fail('The single-worker camera validation pass is incomplete or malformed.');
    }
    cleanupManifestPaths.push(singleManifestPath);
    const standaloneRooms = (singleRun.rooms || []).filter(room => !expectedNameSet.has(normalizedName(room.name)));
    if (standaloneRooms.length) runs.push({ ...singleRun, rooms: standaloneRooms });
  }

  const retryRooms = runs.flatMap(run => Array.isArray(run.rooms) ? run.rooms : []);
  const retryNames = retryRooms.map(room => normalizedName(room.name));
  if (new Set(retryNames).size !== retryNames.length) fail('A room appears in more than one camera-view worker manifest.');

  const baseRoomsByName = new Map((manifest.rooms || []).map(room => [normalizedName(room.name), room]));
  const cameraMetadataPaths = [];
  const cameraFiles = [];
  const fallbackRooms = [];
  let cameraRoomCount = 0;
  let cameraViewCount = 0;
  let cappedCameraViewCount = 0;

  for (let index = 0; index < retryRooms.length; index++) {
    const retryRoom = retryRooms[index];
    const name = String(retryRoom.name || '');
    const normalized = normalizedName(name);
    const baseRoom = baseRoomsByName.get(normalized);
    if (!baseRoom) fail(`Camera-view worker returned an unknown room: ${name}`);

    const metadataPath = resolveWorkspaceFile(retryRoom.metadata);
    if (!metadataPath) fail(`Camera-view metadata reference is missing for ${name}.`);
    ensureWorkspacePath(metadataPath, `Camera metadata for ${name}`);
    if (!fs.existsSync(metadataPath)) fail(`Camera-view metadata is missing for ${name}.`);
    cameraMetadataPaths.push(metadataPath);
    const retryMetadata = readJson(metadataPath);
    const views = Array.isArray(retryMetadata.image?.cameraSections)
      ? retryMetadata.image.cameraSections.filter(view => view && view.file)
      : [];
    const declaredFiles = Array.isArray(retryRoom.cameraViews)
      ? retryRoom.cameraViews.filter(file => typeof file === 'string' && file.length)
      : [];
    const viewFiles = views.map(view => String(view.file));
    if (declaredFiles.length !== viewFiles.length || declaredFiles.some((file, i) => file !== viewFiles[i])) {
      fail(`Camera-view file list disagrees with its metadata for ${name}.`);
    }

    const isFallback = retryRoom.status === 'no-artwork' && views.length === 0;
    if (retryRoom.status === 'exported' && views.length === 0) fail(`A room camera render has no views: ${name}.`);
    if (!isFallback && retryRoom.status !== 'exported') {
      fail(`A room camera render is incomplete: ${name} (${retryRoom.status || 'missing status'}).`);
    }
    if (isFallback) {
      const baseImagePath = resolveWorkspaceFile(baseRoom.image);
      if (baseRoom.status !== 'exported' || !baseImagePath) fail(`Camera fallback has no full-scene image record: ${name}.`);
      ensureWorkspacePath(baseImagePath, `Full-scene image for ${name}`);
      if (!fs.existsSync(baseImagePath) || fs.statSync(baseImagePath).size === 0) fail(`Camera fallback has no complete full-scene image: ${name}.`);
      fallbackRooms.push(name);
    }

    for (const view of views) {
      const imagePath = resolveWorkspaceFile(view.file);
      if (!imagePath) fail(`Camera render file is missing for ${name}.`);
      ensureWorkspacePath(imagePath, `Camera image for ${name}`);
      if (!fs.existsSync(imagePath) || fs.statSync(imagePath).size === 0) fail(`Camera render is missing for ${name}: ${view.file}`);
      if (!(Number(view.pixelsPerWorldUnit) > 0) || !(Number(view.width) > 0) || !(Number(view.height) > 0) || !view.bounds) {
        fail(`Camera render metadata has invalid dimensions for ${name}: ${view.file}`);
      }
      cameraFiles.push(String(view.file));
      cameraViewCount++;
      if (view.resolutionLimited) cappedCameraViewCount++;
      for (const hash of view.missingTextureSha256 || []) missingTextureRefs.add(`${name}:${hash}`);
    }

    const baseMetadataPath = resolveWorkspaceFile(baseRoom.metadata);
    if (!baseMetadataPath) fail(`Base metadata reference is missing for ${name}.`);
    ensureWorkspacePath(baseMetadataPath, `Base metadata for ${name}`);
    if (!fs.existsSync(baseMetadataPath)) fail(`Base room metadata is missing for ${name}.`);
    const baseMetadata = readJson(baseMetadataPath);
    if (!baseMetadata.image) fail(`Base room metadata has no image record for ${name}.`);
    baseMetadata.image.cameraSections = views;
    baseMetadata.image.cameraSectionRenderProfile = 'Active Silksong bundle renderers clipped to authored camera-lock bounds; native texture density retained where practical and extreme views capped at 16,379 px per edge or 100 megapixels.';
    if (retryMetadata.cameraSectionExport) {
      baseMetadata.cameraSectionExport = { ...retryMetadata.cameraSectionExport };
      if (isFallback) baseMetadata.cameraSectionExport.status = 'no-authored-camera-bounds';
    } else if (isFallback) {
      baseMetadata.cameraSectionExport = { viewCount: 0, status: 'no-authored-camera-bounds' };
    }
    writeJsonAtomic(baseMetadataPath, baseMetadata);

    baseRoom.cameraViewCount = views.length;
    baseRoom.cameraViews = views;
    if (isFallback) baseRoom.cameraViewFallback = 'full-scene-image-no-authored-camera-bounds';
    else delete baseRoom.cameraViewFallback;
    if (views.length) cameraRoomCount++;

    if ((index + 1) % 25 === 0 || index + 1 === retryRooms.length) {
      process.stdout.write(`Merged camera metadata ${index + 1}/${retryRooms.length} rooms · ${cameraViewCount} views\n`);
    }
  }

  manifest.cameraSectionRenderProfile = 'Authored room camera-lock sections rendered from Silksong bundle textures; native texture density is retained where practical, with extreme views capped at 16,379 px per edge or 100 megapixels. Whole-scene images remain available for navigation.';
  manifest.cameraSectionSummary = {
    processedRoomCount: retryRooms.length,
    roomCount: cameraRoomCount,
    fullSceneFallbackRoomCount: fallbackRooms.length,
    fullSceneFallbackRooms: fallbackRooms,
    viewCount: cameraViewCount,
    resolutionLimitedViewCount: cappedCameraViewCount,
    files: cameraFiles,
    missingTextureReferenceCount: missingTextureRefs.size,
    workerCount: expectedWorkers,
    mergedAt: new Date().toISOString(),
  };
  manifest.cameraSectionPass = true;
  writeJsonAtomic(manifestPath, manifest);

  for (const filePath of new Set(cameraMetadataPaths)) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  for (const filePath of cleanupManifestPaths) {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }

  process.stdout.write(`Merged ${cameraViewCount} authored camera sections across ${cameraRoomCount} rooms; ${fallbackRooms.length} rooms retain their complete full-scene image because they have no authored camera bounds. Missing texture references: ${missingTextureRefs.size}.\n`);
} catch (error) {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
}
