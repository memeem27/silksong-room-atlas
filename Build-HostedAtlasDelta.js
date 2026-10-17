const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');

const root = __dirname;
const sourceRoot = path.join(root, 'workspace', 'preprocessed');
const dataRoot = path.join(root, 'HostedAtlas', 'r2-data');
const manifest = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'manifest.json'), 'utf8'));
const hostedManifest = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dataRoot, 'manifest.json.gz'))));
const assetIndexPath = path.join(dataRoot, 'asset-index.json.gz');
const assetIndex = readGzipJson(assetIndexPath);
const indexedAssets = new Set((assetIndex.images || []).map(asset => asset.file));
const enemyTextureHashes = new Set();
const oversizedNames = new Set((hostedManifest.rooms || [])
  .filter(room => /\.png$/i.test(room.image || ''))
  .map(room => path.basename(room.image, '.png').toLowerCase()));
const cameraImagesIncluded = hostedManifest.cameraViewImagesIncluded !== false;
const changedFiles = [];
const changedRoomMetadata = [];

function readGzipJson(file) {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file), { maxOutputLength: 1_000_000_000 }).toString('utf8'));
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

for (const room of manifest.rooms || []) {
  if (!room.metadata) continue;
  const sourcePath = path.resolve(sourceRoot, room.metadata);
  const source = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  if (!source.architect) continue;
  for (const artwork of Object.values(source.architect.enemyArtwork || {})) {
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
    markers: transformed.architect.markers?.length || 0,
    placements: transformed.architect.placements?.length || 0,
    enemyArtworkTypes: Object.keys(transformed.architect.enemyArtwork || {}).length });
}

const newArtworkFiles = [];
for (const hash of enemyTextureHashes) {
  const relative = `artwork/${hash}.webp`;
  if (indexedAssets.has(relative)) continue;
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
const unique = [...new Set(changedFiles)].sort();
const delta = { releaseTag: 'silksong-atlas-data-007', repository: 'memeem27/silksong-room-atlas',
  changedFiles: unique, changedRoomMetadata };
const deltaPath = path.join(root, 'HostedAtlas', 'delta-assets.json');
fs.writeFileSync(deltaPath, `${JSON.stringify(delta, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ status: 'ready', releaseTag: delta.releaseTag, changedFiles: unique.length,
  changedRoomMetadata: changedRoomMetadata.length, changedRooms: changedRoomMetadata.length,
  boneBottom: changedRoomMetadata.find(room => room.name.toLowerCase() === 'bone_01b') || null,
  newAuthenticEnemyAtlasFiles: newArtworkFiles, enemyTextureTypes: enemyTextureHashes.size,
  files: unique, output: path.relative(root, deltaPath) }, null, 2)}\n`);
