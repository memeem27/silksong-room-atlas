const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');

const root = __dirname;
const sourceRoot = path.join(root, 'workspace', 'preprocessed');
const dataRoot = path.join(root, 'HostedAtlas', 'r2-data');
const gauntletMapOnly = process.argv.includes('--gauntlet-map-only');
function parseJsonText(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return JSON.parse(text);
}
function readJson(file) { return parseJsonText(fs.readFileSync(file, 'utf8')); }
const manifest = readJson(path.join(sourceRoot, 'manifest.json'));
const hostedManifest = parseJsonText(zlib.gunzipSync(fs.readFileSync(path.join(dataRoot, 'manifest.json.gz'))).toString('utf8'));
const assetIndexPath = path.join(dataRoot, 'asset-index.json.gz');
const assetIndex = readGzipJson(assetIndexPath);
const releaseIndexPath = path.join(root, 'HostedAtlas', 'site', 'release-assets.json');
const releaseIndex = readJson(releaseIndexPath);
const publishedAssets = new Set(Object.keys(releaseIndex.assets || {}));
const indexedAssets = new Set((assetIndex.images || []).map(asset => asset.file));
const enemyTextureHashes = new Set();
const gauntletCatalogPath = path.join(root, 'workspace', 'gauntlet-song', 'export', 'gauntlet-catalog.json');
if (!fs.existsSync(gauntletCatalogPath)) throw new Error('GauntletSong catalog is missing. Run Build-GauntletSongCatalog.js first.');
const gauntletCatalog = readJson(gauntletCatalogPath);
const gauntletArenaExportRoot = path.resolve(root, 'workspace', 'gauntlet-song', 'export', 'arenas');
const arenaSidecarPackages = [];
for (const gauntlet of gauntletCatalog.gauntlets || []) {
  if (!gauntlet.arenaData) continue;
  const expectedRelative = `maps/gauntlet-scenes/${String(gauntlet.key || '').toLowerCase()}.json`;
  if (!/^[a-z0-9]+$/.test(String(gauntlet.key || '')) || gauntlet.arenaData !== expectedRelative)
    throw new Error(`Unsafe Architect arena sidecar route: ${gauntlet.arenaData}`);
  const sourcePath = path.resolve(gauntletArenaExportRoot, `${gauntlet.key}.json`);
  if (!sourcePath.startsWith(`${gauntletArenaExportRoot}${path.sep}`) || !fs.existsSync(sourcePath))
    throw new Error(`Missing or unsafe Architect arena sidecar: ${sourcePath}`);
  const arenaData = readJson(sourcePath);
  if (arenaData.format !== 'silksong-architect-arena-layout' || arenaData.formatVersion !== 1 ||
      arenaData.key !== gauntlet.key || arenaData.scene !== gauntlet.scene ||
      !Array.isArray(arenaData.tileCells) || arenaData.tileCellCount !== arenaData.tileCells.length ||
      !Array.isArray(arenaData.placements) || arenaData.placementCount !== arenaData.placements.length ||
      arenaData.rendering?.terrainWasFabricated !== false)
    throw new Error(`Architect arena sidecar failed source-data validation: ${gauntlet.key}`);
  for (const cell of arenaData.tileCells) if (!Array.isArray(cell) || cell.length < 2 || !cell.slice(0, 2).every(Number.isFinite))
    throw new Error(`Architect arena ${gauntlet.key} contains an invalid source tile cell.`);
  for (const artwork of Object.values(arenaData.enemyArtwork || {})) {
    const hashes = [artwork.sprite?.textureSha256, ...(artwork.idleAnimation?.frames || []).map(frame => frame.textureSha256)];
    for (const value of hashes) {
      const hash = String(value || '').toLowerCase();
      if (/^[a-f0-9]{64}$/.test(hash)) enemyTextureHashes.add(hash);
    }
  }
  arenaSidecarPackages.push({ relative: `${expectedRelative}.gz`, data: arenaData });
}
let oversizedNames = new Set((hostedManifest.rooms || [])
  .filter(room => /\.png$/i.test(room.image || ''))
  .map(room => path.basename(room.image, '.png').toLowerCase()));
const cameraImagesIncluded = hostedManifest.cameraViewImagesIncluded !== false;
const changedFiles = [];
const changedRoomMetadata = [];
const imagePlanArg = process.argv.indexOf('--rooms-from');
if (imagePlanArg >= 0 && !process.argv[imagePlanArg + 1]) throw new Error('--rooms-from requires a JSON plan path.');
const imagePlan = imagePlanArg >= 0
  ? readJson(path.resolve(process.argv[imagePlanArg + 1])) : null;
const imageRoomNames = imagePlan
  ? new Set((imagePlan.workers || []).flatMap(worker => worker.rooms || []).map(room => String(room.name || room).toLowerCase()))
  : new Set();
const hostedByName = new Map((hostedManifest.rooms || []).map(room => [String(room.name || '').toLowerCase(), room]));
const sourceByName = new Map((manifest.rooms || []).map(room => [String(room.name || '').toLowerCase(), room]));
const removedFiles = [];
const imageUpdates = [];

function readGzipJson(file) {
  return parseJsonText(zlib.gunzipSync(fs.readFileSync(file), { maxOutputLength: 1_000_000_000 }).toString('utf8'));
}

function pngDimensions(file) {
  const fd = fs.openSync(file, 'r'), header = Buffer.alloc(24);
  try {
    if (fs.readSync(fd, header, 0, header.length, 0) !== header.length || header.toString('hex', 0, 8) !== '89504e470d0a1a0a')
      throw new Error(`Invalid source PNG: ${file}`);
  } finally { fs.closeSync(fd); }
  const width = header.readUInt32BE(16), height = header.readUInt32BE(20);
  if (!width || !height) throw new Error(`Invalid source PNG dimensions: ${file}`);
  return { width, height };
}

for (const name of imageRoomNames) {
  const room = sourceByName.get(name), hostedRoom = hostedByName.get(name);
  if (!room) throw new Error(`Image refresh requested for unknown room: ${name}`);
  if (!hostedRoom) throw new Error(`Hosted manifest entry is missing for ${name}`);
  if (!room.image) {
    if (room.status !== 'no-artwork') throw new Error(`Image refresh requested for image-less room with status ${room.status}: ${name}`);
    if (hostedRoom.image) {
      const previousRelative = String(hostedRoom.image).replaceAll('\\', '/');
      if (!/^images\/[a-z0-9_.-]+\.(?:png|webp)$/i.test(previousRelative)) throw new Error(`Unsafe hosted image route for ${name}: ${previousRelative}`);
      removedFiles.push(previousRelative);
    }
    hostedRoom.image = null;
    hostedRoom.previewImage = null;
    hostedRoom.status = 'no-artwork';
    imageUpdates.push({ room, hostedRoom, remove: true });
    continue;
  }
  if (!hostedRoom.image) throw new Error(`Hosted image route is missing for ${name}`);
  const sourceImage = path.resolve(sourceRoot, room.image);
  if (!sourceImage.startsWith(`${sourceRoot}${path.sep}`)) throw new Error(`Unsafe source image path for ${name}: ${room.image}`);
  if (!fs.existsSync(sourceImage)) throw new Error(`Refreshed room PNG is missing: ${sourceImage}`);
  const dimensions = pngDimensions(sourceImage), extension = dimensions.width > 16383 || dimensions.height > 16383 ? 'png' : 'webp';
  const nextRelative = `images/${path.basename(room.image, path.extname(room.image))}.${extension}`;
  const previousRelative = String(hostedRoom.image).replaceAll('\\', '/');
  if (!/^images\/[a-z0-9_.-]+\.(?:png|webp)$/i.test(previousRelative)) throw new Error(`Unsafe hosted image route for ${name}: ${previousRelative}`);
  if (previousRelative !== nextRelative) {
    removedFiles.push(previousRelative);
    hostedRoom.image = nextRelative;
  }
  const base = path.basename(room.image, path.extname(room.image)).toLowerCase();
  if (extension === 'png') oversizedNames.add(base); else oversizedNames.delete(base);
  imageUpdates.push({ room, hostedRoom, sourceImage, dimensions, relative: nextRelative });
}

function rewrite(value, key, sourceBase) {
  if (Array.isArray(value)) return value.map(item => rewrite(item, '', sourceBase));
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string') {
      const decoded = value.replace(/Ã‚Â·/g, '·').replace(/Â·/g, '·');
      if (key === 'file' && !cameraImagesIncluded && /(?:^|\/)images\/[^/]*-camera-\d+\.png$/i.test(decoded)) return null;
      if (['file', 'image', 'previewFile', 'previewImage'].includes(key)) {
        return decoded.replace(/^(images|maps)\/([^/]+)\.png$/i, (match, folder, base) => {
          const extension = folder.toLowerCase() === 'images' && oversizedNames.has(base.toLowerCase()) ? 'png' : 'webp';
          return `${folder}/${base}.${extension}`;
        });
      }
      if (key === 'mimeType' && decoded.toLowerCase() === 'image/png' && !oversizedNames.has(sourceBase.toLowerCase())) return 'image/webp';
      return decoded;
    }
    return value;
  }
  const result = {};
  for (const [childKey, child] of Object.entries(value)) result[childKey] = rewrite(child, childKey, sourceBase);
  return result;
}

if (!gauntletMapOnly) for (const room of manifest.rooms || []) {
  if (!room.metadata) continue;
  const sourcePath = path.resolve(sourceRoot, room.metadata);
  const source = readJson(sourcePath);
  for (const artwork of Object.values(source.architect?.enemyArtwork || {})) {
    const hash = String(artwork.sprite?.textureSha256 || '').toLowerCase();
    if (/^[a-f0-9]{64}$/.test(hash)) enemyTextureHashes.add(hash);
  }
  const destinationRelative = `${room.metadata}.gz`.replaceAll('\\', '/');
  const destination = path.resolve(dataRoot, destinationRelative);
  if (!fs.existsSync(destination)) throw new Error(`Missing hosted metadata: ${destinationRelative}`);
  const hosted = readGzipJson(destination);
  const transformed = rewrite(source, '', path.basename(room.metadata, '.json'));
  if (isDeepStrictEqual(transformed, hosted)) continue;
  fs.writeFileSync(destination, zlib.gzipSync(Buffer.from(JSON.stringify(transformed)), { level: 9 }));
  changedFiles.push(destinationRelative);
  changedRoomMetadata.push({ name: room.name, path: destinationRelative,
    markers: transformed.architect?.markers?.length || 0,
    placements: transformed.architect?.placements?.length || 0,
    enemyArtworkTypes: Object.keys(transformed.architect?.enemyArtwork || {}).length });
}

// Gauntlet-only exports still need the verified enemy frames referenced by
// their compact catalog. Keep this independent of the much larger room-art
// refresh path so a small marker update does not repackage every room sprite.
for (const artwork of Object.values(gauntletCatalog.enemyArtworkAliases || {})) {
  const hashes = [artwork.sprite?.textureSha256,
    ...(artwork.idleAnimation?.frames || []).map(frame => frame.textureSha256)];
  for (const value of hashes) {
    const hash = String(value || '').toLowerCase();
    if (/^[a-f0-9]{64}$/.test(hash)) enemyTextureHashes.add(hash);
  }
}

const refreshedImages = [];
if (imageUpdates.length) {
  const indexedByFile = new Map((assetIndex.images || []).map(asset => [asset.file, asset]));
  for (const update of imageUpdates) {
    if (update.remove) continue;
    const { room, sourceImage, dimensions, relative } = update;
    const destination = path.resolve(dataRoot, relative);
    if (!destination.startsWith(`${path.resolve(dataRoot)}${path.sep}`)) throw new Error(`Hosted image path escapes the data folder: ${relative}`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const isWebp = /\.webp$/i.test(relative);
    const temporary = path.join(path.dirname(destination), `${path.basename(destination, path.extname(destination))}.${process.pid}.partial${isWebp ? '.webp' : '.png'}`);
    fs.rmSync(temporary, { force: true });
    if (isWebp) {
      const encoder = process.env.FFMPEG_PATH || 'ffmpeg';
      const result = spawnSync(encoder, ['-y', '-hide_banner', '-loglevel', 'error', '-i', sourceImage,
        '-frames:v', '1', '-c:v', 'libwebp', '-pix_fmt', 'bgra', '-lossless', '1', '-quality', '80',
        '-compression_level', '4', temporary], { stdio: 'inherit', windowsHide: true });
      if (result.error || result.status !== 0 || !fs.existsSync(temporary) || fs.statSync(temporary).size === 0) {
        fs.rmSync(temporary, { force: true });
        throw new Error(`Could not losslessly package refreshed room image ${room.name}: ${result.error?.message || `ffmpeg exited ${result.status}`}`);
      }
    } else {
      fs.copyFileSync(sourceImage, temporary);
    }
    fs.renameSync(temporary, destination);
    const oldAsset = indexedByFile.get(relative) || {};
    const updatedAsset = { ...oldAsset, file: relative, source: path.basename(room.image),
      format: isWebp ? 'webp' : 'png', width: dimensions.width, height: dimensions.height,
      sourceBytes: fs.statSync(sourceImage).size, outputBytes: fs.statSync(destination).size, mode: isWebp ? 'webp' : 'copy' };
    indexedByFile.set(relative, updatedAsset);
    changedFiles.push(relative);
    refreshedImages.push({ name: room.name, file: relative, width: dimensions.width, height: dimensions.height,
      bytes: updatedAsset.outputBytes });
  }
  for (const removed of removedFiles) indexedByFile.delete(removed);
  assetIndex.images = [...indexedByFile.values()].sort((a, b) => a.file.localeCompare(b.file));
  assetIndex.imageCount = assetIndex.images.length;
  fs.writeFileSync(assetIndexPath, zlib.gzipSync(Buffer.from(JSON.stringify(assetIndex)), { level: 9 }));
  changedFiles.push('asset-index.json.gz');
  if (removedFiles.length) {
    fs.writeFileSync(path.join(dataRoot, 'manifest.json.gz'), zlib.gzipSync(Buffer.from(JSON.stringify(hostedManifest)), { level: 9 }));
    changedFiles.push('manifest.json.gz');
  }
}

const newArtworkFiles = [];
for (const hash of enemyTextureHashes) {
  const relative = `artwork/${hash}.webp`;
  if (indexedAssets.has(relative)) {
    if (!publishedAssets.has(relative)) {
      const existingOutput = path.join(dataRoot, 'artwork', `${hash}.webp`);
      if (!fs.existsSync(existingOutput)) throw new Error(`Indexed but unpublished enemy artwork is missing locally: ${existingOutput}`);
      newArtworkFiles.push(relative);
    }
    continue;
  }
  const sourcePng = path.join(root, 'workspace', 'scenes', 'artwork', `${hash}.png`);
  if (!fs.existsSync(sourcePng)) throw new Error(`Missing authentic Silksong enemy atlas PNG: ${sourcePng}`);
  const png = fs.readFileSync(sourcePng);
  const actualHash = crypto.createHash('sha256').update(png).digest('hex');
  if (actualHash !== hash) throw new Error(`Enemy atlas content hash does not match its metadata: ${sourcePng}`);
  if (png.length < 24 || png.toString('hex', 0, 8) !== '89504e470d0a1a0a') throw new Error(`Invalid PNG source for enemy atlas: ${sourcePng}`);
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (!width || !height) throw new Error(`Enemy atlas PNG has invalid dimensions: ${sourcePng}`);
  const output = path.join(dataRoot, 'artwork', `${hash}.webp`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  if (!fs.existsSync(output)) {
    const temporary = output.replace(/\.webp$/i, `.${process.pid}.partial.webp`);
    const encoder = process.env.FFMPEG_PATH || 'ffmpeg';
    const result = spawnSync(encoder, ['-y', '-hide_banner', '-loglevel', 'error', '-i', sourcePng,
      '-frames:v', '1', '-c:v', 'libwebp', '-pix_fmt', 'bgra', '-lossless', '1', '-quality', '80',
      '-compression_level', '4', temporary], { stdio: 'inherit', windowsHide: true });
    if (result.error || result.status !== 0 || !fs.existsSync(temporary) || fs.statSync(temporary).size === 0) {
      fs.rmSync(temporary, { force: true });
      throw new Error(`Could not losslessly package enemy atlas ${hash}: ${result.error?.message || `ffmpeg exited ${result.status}`}`);
    }
    fs.renameSync(temporary, output);
  }
  const outputBytes = fs.statSync(output).size;
  assetIndex.images.push({ file: relative, source: `${hash}.png`, format: 'webp', width, height,
    sourceBytes: png.length, outputBytes, mode: 'webp' });
  indexedAssets.add(relative);
  newArtworkFiles.push(relative);
}
if (newArtworkFiles.length) {
  assetIndex.images.sort((a, b) => a.file.localeCompare(b.file));
  assetIndex.imageCount = assetIndex.images.length;
  fs.writeFileSync(assetIndexPath, zlib.gzipSync(Buffer.from(JSON.stringify(assetIndex)), { level: 9 }));
  changedFiles.push('asset-index.json.gz', ...newArtworkFiles);
}

const navigationFile = 'maps/navigation.json.gz';
const navigationPath = path.join(dataRoot, 'maps', 'navigation.json.gz');
if (!fs.existsSync(navigationPath)) throw new Error('Hosted navigation output is missing. Run Build-HostedNavigation.js first.');
readGzipJson(navigationPath);
changedFiles.push(navigationFile);

// The portal map is a small index. Keep per-instance enemy placement and
// sprite geometry in room sidecars so the initial map request stays lightweight.
if (gauntletCatalog.format !== 'silksong-gauntletsong-catalog' || gauntletCatalog.formatVersion !== 2) {
  throw new Error('GauntletSong catalog format is not the compact hosted format.');
}
const gauntletCatalogRelative = 'maps/gauntlet-song.json.gz';
const gauntletCatalogDestination = path.resolve(dataRoot, gauntletCatalogRelative);
if (!gauntletCatalogDestination.startsWith(`${path.resolve(dataRoot)}${path.sep}`)) throw new Error('Unsafe hosted GauntletSong catalog path.');
fs.mkdirSync(path.dirname(gauntletCatalogDestination), { recursive: true });
fs.writeFileSync(gauntletCatalogDestination, zlib.gzipSync(Buffer.from(JSON.stringify(gauntletCatalog)), { level: 9 }));
changedFiles.push(gauntletCatalogRelative);
for (const item of arenaSidecarPackages) {
  const destination = path.resolve(dataRoot, item.relative);
  if (!destination.startsWith(`${path.resolve(dataRoot)}${path.sep}`)) throw new Error(`Unsafe hosted arena output: ${item.relative}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, zlib.gzipSync(Buffer.from(JSON.stringify(item.data)), { level: 9 }));
  changedFiles.push(item.relative);
}
const unique = [...new Set(changedFiles)].sort();
const versionTags = Object.values(releaseIndex.assets || {}).map(asset => String(asset.tag || '')).map(tag => /^silksong-atlas-data-v2-(\d{3})$/.exec(tag)).filter(Boolean);
const nextVersion = Math.max(0, ...versionTags.map(match => Number(match[1]))) + 1;
const delta = { releaseTag: `silksong-atlas-data-v2-${String(nextVersion).padStart(3, '0')}`, repository: releaseIndex.repository || 'memeem27/silksong-room-atlas',
  changedFiles: unique, removedFiles: [...new Set(removedFiles)].sort(), changedRoomMetadata };
const deltaPath = path.join(root, 'HostedAtlas', 'delta-assets.json');
fs.writeFileSync(deltaPath, `${JSON.stringify(delta, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ status: 'ready', releaseTag: delta.releaseTag, changedFiles: unique.length,
  changedRoomMetadata: changedRoomMetadata.length, changedRooms: changedRoomMetadata.length,
  refreshedRoomImages: refreshedImages,
  gauntletCatalog: { file: gauntletCatalogRelative, gauntlets: gauntletCatalog.coverage.hubEntrances,
    routes: gauntletCatalog.coverage.routeCount, rooms: gauntletCatalog.coverage.uniqueBaseRooms,
    bytes: fs.statSync(gauntletCatalogDestination).size },
  boneBottom: changedRoomMetadata.find(room => room.name.toLowerCase() === 'bone_01b') || null,
  newAuthenticEnemyAtlasFiles: newArtworkFiles, enemyTextureTypes: enemyTextureHashes.size,
  files: unique, output: path.relative(root, deltaPath) }, null, 2)}\n`);
