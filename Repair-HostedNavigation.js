const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const root = __dirname;
const preparedRoot = path.join(root, 'workspace', 'preprocessed');
const navigationPath = path.join(preparedRoot, 'maps', 'navigation.json');
const manifestPath = path.join(preparedRoot, 'manifest.json');
const hostedNavigationPath = path.join(root, 'HostedAtlas', 'r2-data', 'maps', 'navigation.json.gz');

function normalize(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

function detailObjects(objects) {
  const byId = new Map(objects.map(object => [object.id, object]));
  const sceneRoot = objects.find(object => object.name === 'Game_Map_Hornet' && !object.parentId);
  if (!sceneRoot) throw new Error('Game_Map_Hornet was not found in the map bundle.');
  return objects.filter(object => {
    if (object.id === sceneRoot.id) return true;
    let current = object, steps = 0;
    while (current?.parentId && steps++ < 80) {
      current = byId.get(current.parentId);
      if (!current) return false;
      if (current.id === sceneRoot.id) return true;
    }
    return false;
  });
}

function spriteBounds(object) {
  const point = object.worldPosition || { x: 0, y: 0 };
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const sprite of object.sprites || []) {
    const ppu = Math.max(1, Number(sprite.pixelsPerUnit) || 100);
    const rotated = Number(sprite.packingRotation) === 4;
    const width = (rotated ? sprite.rectHeight : sprite.rectWidth) / ppu;
    const height = (rotated ? sprite.rectWidth : sprite.rectHeight) / ppu;
    const originalWidth = (sprite.originalWidth || sprite.rectWidth) / ppu;
    const originalHeight = (sprite.originalHeight || sprite.rectHeight) / ppu;
    const left = (sprite.trimOffsetX || 0) / ppu - (sprite.pivotX ?? .5) * originalWidth;
    const bottom = (sprite.trimOffsetY || 0) / ppu - (sprite.pivotY ?? .5) * originalHeight;
    const angle = Number(sprite.worldRotationZ) || 0;
    const cosine = Math.cos(angle), sine = Math.sin(angle);
    const sx = Number.isFinite(sprite.worldScaleX) ? sprite.worldScaleX : 1;
    const sy = Number.isFinite(sprite.worldScaleY) ? sprite.worldScaleY : 1;
    const matrix = [sprite.worldM00, sprite.worldM01, sprite.worldM10, sprite.worldM11].every(Number.isFinite)
      ? { m00: sprite.worldM00, m01: sprite.worldM01, m10: sprite.worldM10, m11: sprite.worldM11 }
      : { m00: cosine * sx, m01: -sine * sy, m10: sine * sx, m11: cosine * sy };
    for (const [x, y] of [[left, bottom], [left + width, bottom], [left, bottom + height], [left + width, bottom + height]]) {
      const worldX = point.x + matrix.m00 * x + matrix.m01 * y;
      const worldY = point.y + matrix.m10 * x + matrix.m11 * y;
      minX = Math.min(minX, worldX); maxX = Math.max(maxX, worldX);
      minY = Math.min(minY, worldY); maxY = Math.max(maxY, worldY);
    }
  }
  return Number.isFinite(minX) ? { minX, maxX, minY, maxY } : null;
}

function expandBounds(bounds, padding = 1) {
  if (!bounds) return null;
  const marginX = Math.max(padding, (bounds.maxX - bounds.minX) * .08);
  const marginY = Math.max(padding, (bounds.maxY - bounds.minY) * .08);
  return { minX: bounds.minX - marginX, maxX: bounds.maxX + marginX,
    minY: bounds.minY - marginY, maxY: bounds.maxY + marginY };
}

function unionBounds(bounds) {
  if (!bounds.length) return null;
  return { minX: Math.min(...bounds.map(bound => bound.minX)), maxX: Math.max(...bounds.map(bound => bound.maxX)),
    minY: Math.min(...bounds.map(bound => bound.minY)), maxY: Math.max(...bounds.map(bound => bound.maxY)) };
}

async function main() {
  const [navigation, manifest, response] = await Promise.all([
    fs.promises.readFile(navigationPath, 'utf8').then(JSON.parse),
    fs.promises.readFile(manifestPath, 'utf8').then(JSON.parse),
    fetch('http://127.0.0.1:5183/api/world-map')
  ]);
  if (!response.ok) throw new Error(`World map API request failed (${response.status}).`);
  const mapScene = await response.json();
  const roomsByName = new Map(manifest.rooms.map(room => [normalize(room.name), room.name]));
  const rooms = detailObjects(mapScene.objects || []).filter(object => object.sprites?.length)
    .filter(object => /^(song|library|hang|cog)_/i.test(object.name || ''))
    .map(object => ({ name: roomsByName.get(normalize(object.name)), bounds: spriteBounds(object) }))
    .filter(room => room.name && room.bounds)
    .map(room => ({ ...room, center: { x: (room.bounds.minX + room.bounds.maxX) / 2,
      y: (room.bounds.minY + room.bounds.maxY) / 2 } }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  const city = navigation.areas.find(area => area.key === 'CITY_OF_SONG');
  if (!city) throw new Error('The Citadel wide-map region is missing from navigation metadata.');
  city.rooms = rooms;
  city.detailBounds = expandBounds(unionBounds(rooms.map(room => room.bounds)), 1.25);
  const sourceBytes = Buffer.from(JSON.stringify(navigation));
  const hostedJson = JSON.stringify(navigation).replace(/("file"\s*:\s*"maps\/[^"/]+)\.png("?)/g, '$1.webp$2');
  const hostedBytes = Buffer.from(hostedJson);
  await fs.promises.writeFile(navigationPath, sourceBytes);
  await fs.promises.mkdir(path.dirname(hostedNavigationPath), { recursive: true });
  await fs.promises.writeFile(hostedNavigationPath, zlib.gzipSync(hostedBytes, { level: 9 }));
  process.stdout.write(JSON.stringify({ status: 'repaired', citadelRoomCount: rooms.length,
    detailBounds: city.detailBounds, bayRoomCount: navigation.areas.find(area => area.key === 'BAY')?.rooms.length ?? null,
    source: 'Game_Map_Hornet room sprites and the prepared scene manifest' }, null, 2) + '\n');
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
