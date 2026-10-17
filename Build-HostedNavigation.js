const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const root = __dirname;
const mapScenePath = path.join(root, 'workspace', 'scenes', 'silksong-world-map-v2.json');
const manifestPath = path.join(root, 'workspace', 'preprocessed', 'manifest.json');
const navigationPath = path.join(root, 'workspace', 'preprocessed', 'maps', 'navigation.json');
const hostedNavigationPath = path.join(root, 'HostedAtlas', 'r2-data', 'maps', 'navigation.json.gz');

function normalize(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
const conditionalMapStateTokens = new Set(['destroyed', 'broken', 'fixed', 'ruined', 'collapsed', 'completed', 'quiet', 'creature', 'activated', 'inactive', 'restored', 'secret', 'opened', 'closed', 'flooded', 'repaired', 'revealed']);
function isConditionalMapState(name) {
  return String(name || '').split(/[_\s-]+/).some(part => conditionalMapStateTokens.has(normalize(part)));
}

// These are the parent groups in Team Cherry's Game_Map_Hornet hierarchy.
// Group membership is a more reliable region signal than assigning each room
// to whichever floating map label happens to be closest to it.
const groupToArea = new Map([
  ['cradle', 'CRADLE'], ['aqueduct', 'AQUEDUCT'], ['peak', 'PEAK'], ['slab', 'THE_SLAB'],
  ['song', 'CITY_OF_SONG'], ['library', 'CITY_OF_SONG'], ['hang', 'CITY_OF_SONG'], ['cog', 'CITY_OF_SONG'],
  ['songgate', 'UNDERSTORE'], ['swamp', 'SWAMP'], ['coralcaves', 'RED_CORAL_GORGE'],
  ['under', 'UNDERSTORE'], ['dust', 'DUSTPENS'], ['dustmaze', 'DUSTPENS'], ['blastedsteps', 'JUDGE_STEPS'],
  ['clover', 'CLOVER'], ['greymoor', 'GREYMOOR'], ['shellwood', 'SHELLWOOD_THICKET'],
  ['belltown', 'BELLTOWN'], ['crawl', 'CRAWLSPACE'], ['ant', 'HUNTERS_NEST'], ['wilds', 'WILDS'],
  ['bone', 'PATH_OF_BONE'], ['bonetown', 'BONETOWN'], ['dock', 'DOCKS'],
  ['weavehome', 'WEAVER_SHRINE'], ['abyss', 'ABYSS']
]);

function spriteBounds(object) {
  const point = object.WorldPosition || { X: 0, Y: 0 };
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const sprite of object.Sprites || []) {
    if (sprite.RendererEnabled === false) continue;
    const ppu = Math.max(1, Number(sprite.PixelsPerUnit) || 100);
    const rotated = Number(sprite.PackingRotation) === 4;
    const width = (rotated ? sprite.RectHeight : sprite.RectWidth) / ppu;
    const height = (rotated ? sprite.RectWidth : sprite.RectHeight) / ppu;
    const originalWidth = (sprite.OriginalWidth || sprite.RectWidth) / ppu;
    const originalHeight = (sprite.OriginalHeight || sprite.RectHeight) / ppu;
    const left = (sprite.TrimOffsetX || 0) / ppu - (sprite.PivotX ?? .5) * originalWidth;
    const bottom = (sprite.TrimOffsetY || 0) / ppu - (sprite.PivotY ?? .5) * originalHeight;
    const angle = Number(sprite.WorldRotationZ) || 0;
    const cosine = Math.cos(angle), sine = Math.sin(angle);
    const sx = Number.isFinite(sprite.WorldScaleX) ? sprite.WorldScaleX : 1;
    const sy = Number.isFinite(sprite.WorldScaleY) ? sprite.WorldScaleY : 1;
    const hasMatrix = [sprite.WorldM00, sprite.WorldM01, sprite.WorldM10, sprite.WorldM11].every(Number.isFinite);
    const matrix = hasMatrix
      ? { m00: sprite.WorldM00, m01: sprite.WorldM01, m10: sprite.WorldM10, m11: sprite.WorldM11 }
      : { m00: cosine * sx, m01: -sine * sy, m10: sine * sx, m11: cosine * sy };
    for (const [x, y] of [[left, bottom], [left + width, bottom], [left, bottom + height], [left + width, bottom + height]]) {
      const worldX = point.X + matrix.m00 * x + matrix.m01 * y;
      const worldY = point.Y + matrix.m10 * x + matrix.m11 * y;
      minX = Math.min(minX, worldX); maxX = Math.max(maxX, worldX);
      minY = Math.min(minY, worldY); maxY = Math.max(maxY, worldY);
    }
  }
  return Number.isFinite(minX) ? { minX, maxX, minY, maxY } : null;
}

function mapSprites(object, objectOrder) {
  const position = object.WorldPosition || { X: 0, Y: 0 };
  return (object.Sprites || []).flatMap((sprite, spriteOrder) => {
    if (sprite.RendererEnabled === false) return [];
    const textureSha256 = String(sprite.ImageUrl || '').match(/\/([a-f0-9]{64})\.png$/i)?.[1]?.toLowerCase();
    if (!textureSha256) return [];
    return [{
      textureSha256, name: sprite.Name || object.Name,
      rectX: sprite.RectX, rectY: sprite.RectY, rectWidth: sprite.RectWidth, rectHeight: sprite.RectHeight,
      textureWidth: sprite.TextureWidth, textureHeight: sprite.TextureHeight,
      pivotX: sprite.PivotX, pivotY: sprite.PivotY, pixelsPerUnit: sprite.PixelsPerUnit,
      originalWidth: sprite.OriginalWidth, originalHeight: sprite.OriginalHeight,
      trimOffsetX: sprite.TrimOffsetX, trimOffsetY: sprite.TrimOffsetY,
      packingRotation: sprite.PackingRotation, flipX: sprite.FlipX, flipY: sprite.FlipY,
      worldPosition: { x: position.X, y: position.Y, z: Number(position.Z) || 0 },
      worldM00: sprite.WorldM00, worldM01: sprite.WorldM01, worldM10: sprite.WorldM10, worldM11: sprite.WorldM11,
      tintR: sprite.TintR, tintG: sprite.TintG, tintB: sprite.TintB, tintA: sprite.TintA,
      sortingLayerValue: sprite.SortingLayerValue, sortingOrder: sprite.SortingOrder,
      mapObjectOrder: objectOrder, mapSpriteOrder: spriteOrder
    }];
  });
}

function expandBounds(bounds, padding = 1.25) {
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

function mapLabels(objects) {
  return objects.filter(object => object.Name?.startsWith('Area Name') && object.WorldPosition?.X < -100).flatMap(object => {
    let key = '', text = '';
    for (const component of object.Components || []) {
      const strings = component.Data?.Strings || {};
      if (component.ScriptName === 'SetTextMeshProGameText') key = strings.Key || key;
      if (component.ScriptName === 'TMProOld.TextMeshPro') text = strings.m_text || text;
    }
    return key ? [{ key: String(key), text: String(text || key), x: object.WorldPosition.X, y: object.WorldPosition.Y }] : [];
  });
}

function nearestLabel(point, labels) {
  let best = null, bestDistance = Infinity;
  for (const label of labels) {
    const distance = Math.hypot(point.x - label.x, point.y - label.y);
    if (distance < bestDistance) { best = label; bestDistance = distance; }
  }
  return best;
}

async function main() {
  const [mapScene, manifest, navigation] = await Promise.all([
    fs.promises.readFile(mapScenePath, 'utf8').then(JSON.parse),
    fs.promises.readFile(manifestPath, 'utf8').then(JSON.parse),
    fs.promises.readFile(navigationPath, 'utf8').then(JSON.parse)
  ]);
  const objects = mapScene.Objects || [];
  const byId = new Map(objects.map(object => [object.Id, object]));
  const mapRoot = objects.find(object => object.Name === 'Game_Map_Hornet' && !object.ParentId);
  if (!mapRoot) throw new Error('The extracted Game_Map_Hornet map hierarchy was not found.');
  const roomNames = new Map((manifest.rooms || []).map(room => [normalize(room.name), room.name]));
  const sourceAreas = (navigation.areas || []).filter(area => !area.supplemental);
  const areasByKey = new Map(sourceAreas.map(area => [area.key, { ...area, rooms: [] }]));
  const labels = mapLabels(objects);
  const mappedRooms = new Map();
  const objectGroups = new Map();
  const mapArtworkGroups = new Map();

  for (const [objectOrder, object] of objects.entries()) {
    if (!object.Components?.some(component => component.ScriptName === 'GameMapScene')) continue;
    if (object.ActiveInHierarchy === false || !(object.Sprites || []).some(sprite => sprite.RendererEnabled !== false)) continue;
    const roomName = roomNames.get(normalize(object.Name));
    let parent = byId.get(object.ParentId);
    let group = parent?.Name || '';
    while (parent && parent.Id !== mapRoot.Id && !parent.Components?.some(component => component.ScriptName === 'GameMapScene')) {
      const next = byId.get(parent.ParentId);
      if (!next || next.Id === mapRoot.Id) break;
      parent = next;
      group = parent.Name || group;
    }
    const bounds = spriteBounds(object);
    if (!bounds) continue;
    const center = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
    const mapGroup = group || 'Other';
    const sprites = mapSprites(object, objectOrder);
    if (!sprites.length) continue;
    const row = { name: roomName || object.Name, roomMapped: Boolean(roomName), bounds, center, mapGroup,
      mapObjectName: object.Name, conditionalMapState: isConditionalMapState(object.Name), mapSprites: sprites };
    if (!mapArtworkGroups.has(mapGroup)) mapArtworkGroups.set(mapGroup, []);
    mapArtworkGroups.get(mapGroup).push(row);
    if (!roomName) continue;
    const score = (object.ActiveInHierarchy === true ? 4 : 0)
      + ((object.Sprites || []).some(sprite => sprite.RendererEnabled !== false) ? 2 : 0)
      + (groupToArea.has(normalize(mapGroup)) ? 1 : 0);
    const previous = mappedRooms.get(normalize(roomName));
    if (!previous || score > previous.score) mappedRooms.set(normalize(roomName), { row, score });
    if (!objectGroups.has(mapGroup)) objectGroups.set(mapGroup, []);
    objectGroups.get(mapGroup).push(row);
  }

  // Keep only the selected representation when a room has duplicate map objects.
  const selectedRooms = new Map([...mappedRooms.values()].map(({ row }) => [normalize(row.name), row]));
  const assigned = new Set();
  for (const row of selectedRooms.values()) {
    const key = groupToArea.get(normalize(row.mapGroup));
    const area = key && areasByKey.get(key);
    if (!area) continue;
    area.rooms.push(row);
    assigned.add(normalize(row.name));
  }

  // Several authored map sections are assembled from extra GameMapScene
  // sprite objects whose names are not exported scene names. Preserve those
  // real assets so composite rooms do not appear as blank gaps in the atlas.
  for (const [group, rows] of mapArtworkGroups) {
    const key = groupToArea.get(normalize(group));
    const area = key && areasByKey.get(key);
    if (!area) continue;
    const unmapped = rows.filter(row => !row.roomMapped);
    area.unmappedMapArtwork = unmapped.filter(row => !row.conditionalMapState);
    area.conditionalMapArtwork = unmapped.filter(row => row.conditionalMapState);
  }

  // Preserve valid locations from older prepared navigation when their source
  // object is unavailable in this map bundle, without duplicating remapped rooms.
  for (const area of areasByKey.values()) {
    const original = sourceAreas.find(item => item.key === area.key);
    for (const room of original?.rooms || []) {
      const id = normalize(room.name);
      if (assigned.has(id) || !room.bounds || !room.center) continue;
      area.rooms.push(room);
      assigned.add(id);
    }
    area.rooms.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    const bounds = unionBounds([...area.rooms, ...(area.unmappedMapArtwork || []), ...(area.conditionalMapArtwork || [])].map(room => room.bounds).filter(Boolean));
    if (bounds) area.detailBounds = expandBounds(bounds);
  }

  // Add map sections that exist in the authored detailed map but do not have a
  // corresponding tile on the game's current wide-map screen. They remain
  // reachable from the region list and use their real map positions.
  const supplemental = [];
  for (const [group, rows] of objectGroups) {
    if (groupToArea.has(normalize(group))) continue;
    const rooms = [...new Map(rows.map(row => [normalize(row.name), selectedRooms.get(normalize(row.name)) || row])).values()]
      .filter(row => row && !assigned.has(normalize(row.name)));
    if (!rooms.length) continue;
    const bounds = unionBounds(rooms.map(room => room.bounds).filter(Boolean));
    if (!bounds) continue;
    const center = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
    const titleCounts = new Map();
    for (const room of rooms) {
      const label = nearestLabel(room.center, labels);
      const title = label?.text || group;
      titleCounts.set(title, (titleCounts.get(title) || 0) + 1);
    }
    const title = [...titleCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || group;
    const key = `MAP_SECTION_${normalize(group).toUpperCase()}`;
    supplemental.push({ key, name: title, widePosition: null, wideBounds: null, detailBounds: expandBounds(bounds),
      rooms: rooms.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })),
      sourceGroup: group, supplemental: true });
  }

  const areas = [...areasByKey.values(), ...supplemental];
  areas.sort((a, b) => {
    if (a.supplemental !== b.supplemental) return a.supplemental ? 1 : -1;
    if (a.supplemental) return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    return b.widePosition.y - a.widePosition.y || a.widePosition.x - b.widePosition.x || a.name.localeCompare(b.name);
  });
  const result = { ...navigation, format: 'silksong-room-atlas-navigation', formatVersion: 3,
    roomPositionSource: 'Game_Map_Hornet GameMapScene sprites and their authored parent map sections',
    unmappedMapArtworkSource: 'Additional real GameMapScene sprites in authored map groups that do not match an exported room name; named state variants remain separately toggleable',
    areas };
  const sourceBytes = Buffer.from(JSON.stringify(result));
  await fs.promises.writeFile(navigationPath, sourceBytes);
  const hostedJson = JSON.stringify(result).replace(/("file"\s*:\s*"maps\/[^"/]+)\.png("?)/g, '$1.webp$2');
  await fs.promises.mkdir(path.dirname(hostedNavigationPath), { recursive: true });
  await fs.promises.writeFile(hostedNavigationPath, zlib.gzipSync(Buffer.from(hostedJson), { level: 9 }));
  const summary = areas.map(area => ({ key: area.key, name: area.name, roomCount: area.rooms.length,
    supplemental: Boolean(area.supplemental), sourceGroup: area.sourceGroup || null }));
  process.stdout.write(JSON.stringify({ status: 'ready', source: 'Game_Map_Hornet GameMapScene objects',
    matchedRoomCount: selectedRooms.size, areaCount: areas.length,
    worldRegionCount: areas.filter(area => area.widePosition).length,
    supplementalSectionCount: supplemental.length, matchedRoomCountByRegion: summary }, null, 2) + '\n');
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
