const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

const sceneViewerRoot = __dirname;
const projectRoot = path.resolve(sceneViewerRoot, '..');
const preprocessedRoot = path.join(sceneViewerRoot, 'workspace', 'preprocessed');
const hostedRoot = path.join(sceneViewerRoot, 'HostedAtlas', 'r2-data');
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';

function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(4 * 1024 * 1024);
  try {
    for (let bytes; (bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0;) hash.update(buffer.subarray(0, bytes));
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

function decodeRgba(inputPath, outputPath) {
  const result = spawnSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', inputPath,
    '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', outputPath], { stdio: 'ignore', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`FFmpeg failed to decode ${inputPath} (exit ${result.status}).`);
}

function compareVisibleRgba(leftPath, rightPath) {
  const leftStat = fs.statSync(leftPath), rightStat = fs.statSync(rightPath);
  if (leftStat.size !== rightStat.size || leftStat.size % 4 !== 0) throw new Error('Decoded image dimensions differ.');
  const leftFd = fs.openSync(leftPath, 'r'), rightFd = fs.openSync(rightPath, 'r');
  const left = Buffer.allocUnsafe(4 * 1024 * 1024), right = Buffer.allocUnsafe(4 * 1024 * 1024);
  let visibleRgbDifferences = 0, alphaDifferences = 0, pixels = 0;
  try {
    for (let offset = 0; offset < leftStat.size;) {
      const bytes = fs.readSync(leftFd, left, 0, Math.min(left.length, leftStat.size - offset), offset);
      const otherBytes = fs.readSync(rightFd, right, 0, bytes, offset);
      if (bytes !== otherBytes || bytes % 4 !== 0) throw new Error('Unable to compare decoded image pixels.');
      for (let index = 0; index < bytes; index += 4) {
        const alpha = left[index + 3], otherAlpha = right[index + 3];
        if (alpha !== otherAlpha) alphaDifferences++;
        else if (alpha && (left[index] !== right[index] || left[index + 1] !== right[index + 1] || left[index + 2] !== right[index + 2])) visibleRgbDifferences++;
        pixels++;
      }
      offset += bytes;
    }
  } finally { fs.closeSync(leftFd); fs.closeSync(rightFd); }
  return { pixels, visibleRgbDifferences, alphaDifferences };
}

function runWebpSample(name, sourcePath, hostedPath) {
  const tempBase = path.join(os.tmpdir(), `silksong-atlas-${process.pid}-${name}`);
  const sourceRaw = `${tempBase}-source.rgba`, hostedRaw = `${tempBase}-hosted.rgba`;
  try {
    decodeRgba(sourcePath, sourceRaw);
    decodeRgba(hostedPath, hostedRaw);
    return { sample: name, ...compareVisibleRgba(sourceRaw, hostedRaw) };
  } finally {
    for (const file of [sourceRaw, hostedRaw]) { try { fs.unlinkSync(file); } catch {} }
  }
}

const results = [];
const hostedManifest = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(hostedRoot, 'manifest.json.gz'))).toString('utf8'));
const cameraImageFiles = fs.readdirSync(path.join(hostedRoot, 'images')).filter(name => /-camera-\d+\.(?:webp|png)$/i.test(name));
if (hostedManifest.cameraViewImagesIncluded === false) {
  if (cameraImageFiles.length || hostedManifest.cameraViewImageCount !== 0) throw new Error('The package says camera-view images are excluded, but camera images are present or still referenced.');
  results.push({ sample: 'camera-section image policy', separateImages: 0, retainedRoomAreas: hostedManifest.cameraSectionSummary?.viewCount || 0 });
}
results.push(runWebpSample('bone_01 room',
  path.join(preprocessedRoot, 'images', 'bone_01.png'),
  path.join(hostedRoot, 'images', 'bone_01.webp')));
for (const [label, baseName] of [
  ['bone_01 camera section', 'bone_01-camera-03'],
  ['ant_14 camera section', 'ant_14-camera-01'],
  ['aqueduct_03 camera section', 'aqueduct_03-camera-01']
]) {
  const source = path.join(preprocessedRoot, 'images', `${baseName}.png`);
  const webp = path.join(hostedRoot, 'images', `${baseName}.webp`);
  const png = path.join(hostedRoot, 'images', `${baseName}.png`);
  if (fs.existsSync(source) && (fs.existsSync(webp) || fs.existsSync(png))) {
    results.push(fs.existsSync(webp)
      ? runWebpSample(label, source, webp)
      : { sample: `${label} PNG fallback`, exactFileCopy: hashFile(source) === hashFile(png) });
  }
}
results.push(runWebpSample('wide map',
  path.join(preprocessedRoot, 'maps', 'wide.png'),
  path.join(hostedRoot, 'maps', 'wide.webp')));

const atlasSourceDir = path.join(sceneViewerRoot, 'workspace', 'scenes', 'artwork');
const atlasName = fs.readdirSync(atlasSourceDir).filter(name => name.toLowerCase().endsWith('.png')).sort()[0];
if (!atlasName) throw new Error('No source texture atlas found for the pixel test.');
results.push(runWebpSample('game texture atlas',
  path.join(atlasSourceDir, atlasName),
  path.join(hostedRoot, 'artwork', `${path.parse(atlasName).name}.webp`)));
const deltaPath = path.join(sceneViewerRoot, 'HostedAtlas', 'delta-assets.json');
if (fs.existsSync(deltaPath)) {
  const delta = JSON.parse(fs.readFileSync(deltaPath, 'utf8'));
  const newEnemyAtlases = (delta.changedFiles || []).filter(relative => /^artwork\/[a-f0-9]{64}\.webp$/i.test(relative));
  for (const relative of newEnemyAtlases) {
    const fileName = path.basename(relative);
    const hash = path.parse(fileName).name;
    results.push(runWebpSample(`Architect enemy atlas ${hash.slice(0, 12)}`,
      path.join(atlasSourceDir, `${hash}.png`), path.join(hostedRoot, relative)));
  }
}

const sourcePng = path.join(preprocessedRoot, 'images', 'abandoned_town.png');
const hostedPng = path.join(hostedRoot, 'images', 'abandoned_town.png');
const sourceHash = hashFile(sourcePng), hostedHash = hashFile(hostedPng);
results.push({ sample: 'oversized PNG fallback', exactFileCopy: sourceHash === hostedHash });

console.log(JSON.stringify({ status: results.every(result =>
  result.exactFileCopy !== false && (result.visibleRgbDifferences ?? 0) === 0 && (result.alphaDifferences ?? 0) === 0) ? 'passed' : 'failed', results }, null, 2));
if (results.some(result => result.exactFileCopy === false || (result.visibleRgbDifferences ?? 0) !== 0 || (result.alphaDifferences ?? 0) !== 0)) process.exit(1);
