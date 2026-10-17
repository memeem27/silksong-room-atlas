const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const root = __dirname;
const mapScenePath = path.join(root, 'workspace', 'scenes', 'silksong-world-map-v2.json');
const manifestPath = path.join(root, 'workspace', 'preprocessed', 'manifest.json');
const navigationPath = path.join(root, 'workspace', 'preprocessed', 'maps', 'navigation.json');
const hostedNavigationPath = path.join(root, 'HostedAtlas', 'r2-data', 'maps', 'navigation.json.gz');

function normalize(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
const conditionalMapStateTokens = new Set(['destroyed', 'broken', 'break', 'fixed', 'ruined', 'collapsed', 'completed', 'quiet', 'creature', 'activated', 'inactive', 'restored', 'secret', 'opened', 'closed', 'flooded', 'repaired', 'revealed', 'shortcut']);
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
      meshVertices: (sprite.MeshVertices || []).map(vertex => ({
        x: Number(vertex.X ?? vertex.x), y: Number(vertex.Y ?? vertex.y)
      })), meshIndices: sprite.MeshIndices || [],
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

function areaBounds(area, includeConditional = false) {
  const rows = [
    ...(area.rooms || []).filter(room => includeConditional || !room.conditionalMapState),
    ...(area.unmappedMapArtwork || []),
    ...(includeConditional ? (area.conditionalMapArtwork || []) : [])
  ];
  return unionBounds(rows.map(row => row.bounds).filter(Boolean));
}

function expandAreaBounds(area) {
  const defaultBounds = areaBounds(area);
  const allBounds = areaBounds(area, true);
  area.detailBounds = expandBounds(defaultBounds || allBounds);
  area.detailBoundsWithConditional = expandBounds(allBounds || defaultBounds);
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
  const manifestRooms = new Map((manifest.rooms || []).map(room => [normalize(room.name), room]));
  const architectSummaryCache = new Map();
  function architectSummary(roomName) {
    const key = normalize(roomName);
    if (!key || architectSummaryCache.has(key)) return architectSummaryCache.get(key) || null;
    const room = manifestRooms.get(key);
    let summary = null;
    if (room?.metadata) {
      try {
        const sidecarPath = path.resolve(path.dirname(manifestPath), room.metadata);
        const raw = fs.readFileSync(sidecarPath, 'utf8');
        if (!/"architect"\s*:/.test(raw)) { architectSummaryCache.set(key, null); return null; }
        const metadata = JSON.parse(raw);
        const architect = metadata.architect;
        const markers = (architect?.markers || []).map(marker => ({
          key: marker.key, label: marker.label, kind: marker.kind,
          virtualEvent: marker.virtualEvent, virtualEndEvent: marker.virtualEndEvent,
          placementCount: marker.placementCount || 0
        }));
        if (markers.length) summary = { markerCount: markers.length, placementCount: architect.placements?.length || 0,
          waveCount: architect.eventGroups?.length || 0, markers };
      } catch (error) {
        summary = { markerCount: 0, placementCount: 0, waveCount: 0, markers: [], error: error.message };
      }
    }
    architectSummaryCache.set(key, summary);
    return summary;
  }
  const sourceAreas = (navigation.areas || []).filter(area => !area.supplemental);
  const areasByKey = new Map(sourceAreas.map(area => [area.key, { ...area, rooms: [], unmappedMapArtwork: [], conditionalMapArtwork: [] }]));
  const labels = mapLabels(objects);
  const mappedRooms = new Map();
  const objectGroups = new Map();
  const mapArtworkGroups = new Map();
  const mapAliases = new Map([
    ['aqueduct_05_caravan', 'aqueduct_05'], ['aqueduct_05_festival', 'aqueduct_05'], ['aqueduct_05_pre', 'aqueduct_05'],
    ['bellshrine_lore_additive', 'bellshrine'], ['belltown_room_doctor', 'belltown'],
    ['bonetown_boss', 'bonetown'], ['bone_05_boss', 'bone_05'],
    ['bone_east_08_boss_beastfly', 'bone_east_08'], ['bone_east_08_boss_golem_rest', 'bone_east_08'],
    ['cog_dancers_boss', 'cog_dancers'], ['greymoor_08_caravan', 'greymoor_08'], ['hang_04_boss', 'hang_04'],
    ['memory_ant_queen', 'ant_queen'], ['shellwood_11b_memory', 'shellwood_11b'], ['ward_02_boss', 'ward_02b']
  ]);

  for (const [objectOrder, object] of objects.entries()) {
    if (!object.Components?.some(component => component.ScriptName === 'GameMapScene')) continue;
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
    const sprites = mapSprites(object, objectOrder);
    const mapAnchor = !sprites.length && roomName && object.WorldPosition &&
      Number.isFinite(object.WorldPosition.X) && Number.isFinite(object.WorldPosition.Y);
    const anchorBounds = mapAnchor ? { minX: object.WorldPosition.X - .65, maxX: object.WorldPosition.X + .65,
      minY: object.WorldPosition.Y - .65, maxY: object.WorldPosition.Y + .65 } : null;
    const effectiveBounds = sprites.length ? bounds : anchorBounds;
    if (!effectiveBounds) continue;
    const center = { x: (effectiveBounds.minX + effectiveBounds.maxX) / 2, y: (effectiveBounds.minY + effectiveBounds.maxY) / 2 };
    const mapGroup = group || 'Other';
    if (!sprites.length && !mapAnchor) continue;
    const row = { name: roomName || object.Name, roomMapped: Boolean(roomName), bounds: effectiveBounds, center, mapGroup,
      mapObjectName: object.Name, mapObjectOrder: objectOrder, mapAnchor: Boolean(mapAnchor),
      conditionalMapState: isConditionalMapState(object.Name) || object.ActiveInHierarchy === false,
      ...(roomName ? { architect: architectSummary(roomName) } : {}), mapSprites: sprites };
    if (sprites.length) {
      if (!mapArtworkGroups.has(mapGroup)) mapArtworkGroups.set(mapGroup, []);
      mapArtworkGroups.get(mapGroup).push(row);
    }
    if (!roomName) continue;
    const score = (object.ActiveInHierarchy === true ? 4 : 0)
      + (sprites.length ? 2 : 0)
      + (groupToArea.has(normalize(mapGroup)) ? 1 : 0);
    const previous = mappedRooms.get(normalize(roomName));
    if (!previous || score > previous.score) mappedRooms.set(normalize(roomName), { row, score });
    if (!objectGroups.has(mapGroup)) objectGroups.set(mapGroup, []);
    objectGroups.get(mapGroup).push(row);
  }

  // Keep only the selected representation when a room has duplicate map objects.
  const selectedRooms = new Map([...mappedRooms.values()].map(({ row }) => [normalize(row.name), row]));
  const selectedMapObjectOrders = new Set([...selectedRooms.values()].map(row => row.mapObjectOrder));
  const assigned = new Set();
  for (const row of selectedRooms.values()) {
    const key = groupToArea.get(normalize(row.mapGroup));
    const area = key && areasByKey.get(key);
    if (!area) continue;
    area.rooms.push(row);
    assigned.add(normalize(row.name));
  }

  // Story, boss, and additive scenes that share a physical map tile get an
  // explicit secondary room anchor at that authored location. This records
  // discoverable renderable scenes without pretending that their scene-local
  // coordinates are global map coordinates.
  let aliasedRoomCount = 0;
  for (const [sceneName, baseName] of mapAliases) {
    const id = normalize(sceneName), baseId = normalize(baseName);
    if (assigned.has(id)) continue;
    const base = selectedRooms.get(baseId);
    const baseAreaKey = base && groupToArea.get(normalize(base.mapGroup));
    const area = baseAreaKey && areasByKey.get(baseAreaKey);
    if (!base || !area) continue;
    const room = { ...base, name: sceneName, roomMapped: true,
      bounds: { minX: base.center.x - .2, maxX: base.center.x + .2, minY: base.center.y - .2, maxY: base.center.y + .2 },
      mapAnchor: true, mapVariantOf: base.name, mapSprites: [], architect: architectSummary(sceneName) };
    area.rooms.push(room);
    assigned.add(id);
    aliasedRoomCount++;
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
  }

  // Add map sections that exist in the authored detailed map but do not have a
  // corresponding tile on the game's current wide-map screen. Include groups
  // that contain only extra sprite pieces so undiscovered sections are not lost.
  const supplemental = [];
  const allMapGroups = new Set([...objectGroups.keys(), ...mapArtworkGroups.keys()]);
  for (const group of allMapGroups) {
    const mappedAreaKey = groupToArea.get(normalize(group));
    if (mappedAreaKey && areasByKey.has(mappedAreaKey)) continue;
    const rows = objectGroups.get(group) || [];
    const extraRows = (mapArtworkGroups.get(group) || []).filter(row => !row.roomMapped);
    const rooms = [...new Map(rows.map(row => [normalize(row.name), selectedRooms.get(normalize(row.name)) || row])).values()]
      .filter(row => row && !assigned.has(normalize(row.name)));
    if (!rooms.length && !extraRows.length) continue;
    const bounds = unionBounds([...rooms, ...extraRows].map(room => room.bounds).filter(Boolean));
    if (!bounds) continue;
    const center = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
    const titleCounts = new Map();
    for (const item of [...rooms, ...extraRows]) {
      const label = nearestLabel(item.center, labels);
      const title = label?.text || group;
      titleCounts.set(title, (titleCounts.get(title) || 0) + 1);
    }
    const title = [...titleCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || group;
    const key = `MAP_SECTION_${normalize(group).toUpperCase()}`;
    supplemental.push({ key, name: title, widePosition: null, wideBounds: null,
      rooms: rooms.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })),
      sourceGroup: group, supplemental: true });
  }

  const areas = [...areasByKey.values(), ...supplemental];
  const supplementalByGroup = new Map(supplemental.map(area => [normalize(area.sourceGroup), area]));

  // Several authored GameMapScene groups contribute pieces to one visible
  // region (for example Song, Library, Hang, and Cog all contribute to the
  // Citadel). Aggregate by destination region instead of overwriting the
  // previous group's pieces. Supplemental areas are matched by source group.
  let expectedExtraArtworkCount = 0;
  for (const [group, rows] of mapArtworkGroups) {
    const key = groupToArea.get(normalize(group));
    const area = (key && areasByKey.get(key)) || supplementalByGroup.get(normalize(group));
    const extras = rows.filter(row => !row.roomMapped || !selectedMapObjectOrders.has(row.mapObjectOrder));
    expectedExtraArtworkCount += extras.length;
    if (!area) continue;
    area.unmappedMapArtwork ||= [];
    area.conditionalMapArtwork ||= [];
    area.unmappedMapArtwork.push(...extras.filter(row => !row.conditionalMapState));
    area.conditionalMapArtwork.push(...extras.filter(row => row.conditionalMapState));
  }

  const assignedExtraArtworkCount = areas.reduce((count, area) => count
    + (area.unmappedMapArtwork?.length || 0) + (area.conditionalMapArtwork?.length || 0), 0);
  if (assignedExtraArtworkCount !== expectedExtraArtworkCount) {
    throw new Error(`Map artwork assignment is incomplete: assigned ${assignedExtraArtworkCount} of ${expectedExtraArtworkCount} extra sprite objects.`);
  }
  for (const area of areas) expandAreaBounds(area);

  // The game's transition components identify exits but do not serialize a
  // destination scene. Use actual neighboring GameMapScene bounds and confirm
  // both scenes contain a serialized transition point before exposing a link.
  const transitionCountCache = new Map();
  function transitionCount(roomName) {
    const id = normalize(roomName);
    if (transitionCountCache.has(id)) return transitionCountCache.get(id);
    const room = manifestRooms.get(id);
    let count = 0;
    if (room?.metadata) {
      try {
        const sidecarPath = path.resolve(path.dirname(manifestPath), room.metadata);
        const raw = fs.readFileSync(sidecarPath, 'utf8');
        if (!/"scriptName"\s*:\s*"(?:TransitionPoint|SceneTransitionZone)"/.test(raw)) {
          transitionCountCache.set(id, 0);
          return 0;
        }
        const metadata = JSON.parse(raw);
        count = (metadata.objects || []).filter(object => (object.components || [])
          .some(component => /^(TransitionPoint|SceneTransitionZone)$/.test(component.scriptName || ''))).length;
      } catch { count = 0; }
    }
    transitionCountCache.set(id, count);
    return count;
  }
  function boundsGap(a, b) {
    const x = Math.max(0, a.bounds.minX - b.bounds.maxX, b.bounds.minX - a.bounds.maxX);
    const y = Math.max(0, a.bounds.minY - b.bounds.maxY, b.bounds.minY - a.bounds.maxY);
    return Math.hypot(x, y);
  }
  const transitionPairs = [];
  const mappedAreas = areas.filter(area => !area.supplemental);
  for (let i = 0; i < mappedAreas.length; i++) for (let j = i + 1; j < mappedAreas.length; j++) {
    const from = mappedAreas[i], to = mappedAreas[j];
    const fromRooms = from.rooms.filter(room => !room.mapVariantOf && room.bounds && transitionCount(room.name));
    const toRooms = to.rooms.filter(room => !room.mapVariantOf && room.bounds && transitionCount(room.name));
    const nearestFrom = new Map(), nearestTo = new Map();
    for (const a of fromRooms) {
      for (const b of toRooms) {
        const gap = boundsGap(a, b);
        if (gap > .3) continue;
        const oldB = nearestFrom.get(a.name);
        if (!oldB || gap < oldB.gap) nearestFrom.set(a.name, { room: b, gap });
        const oldA = nearestTo.get(b.name);
        if (!oldA || gap < oldA.gap) nearestTo.set(b.name, { room: a, gap });
      }
    }
    for (const a of fromRooms) {
      const match = nearestFrom.get(a.name);
      if (!match || nearestTo.get(match.room.name)?.room !== a) continue;
      const b = match.room, gap = match.gap;
      const pair = { fromArea: from.key, fromAreaName: from.name, fromRoom: a.name,
        fromCenter: a.center, toArea: to.key, toAreaName: to.name, toRoom: b.name,
        toCenter: b.center, edgeGap: gap, source: 'mutually nearest authored GameMapScene boundaries with serialized transition components' };
      transitionPairs.push(pair);
      a.areaTransitions ||= [];
      a.areaTransitions.push({ areaKey: to.key, areaName: to.name, roomName: b.name, edgeGap: gap });
      b.areaTransitions ||= [];
      b.areaTransitions.push({ areaKey: from.key, areaName: from.name, roomName: a.name, edgeGap: gap });
      from.transitions ||= [];
      from.transitions.push({ areaKey: to.key, areaName: to.name, fromRoom: a.name, toRoom: b.name,
        fromCenter: a.center, toCenter: b.center, edgeGap: gap });
      to.transitions ||= [];
      to.transitions.push({ areaKey: from.key, areaName: from.name, fromRoom: b.name, toRoom: a.name,
        fromCenter: b.center, toCenter: a.center, edgeGap: gap });
    }
  }

  const placedNames = new Set(areas.flatMap(area => area.rooms.map(room => normalize(room.name))));
  const unplacedRooms = (manifest.rooms || []).filter(room => room.image && !placedNames.has(normalize(room.name)))
    .map(room => ({ name: room.name, kind: room.kind, status: room.status, hasImage: true, reason: 'No authored GameMapScene position was available for this scene.' }));
  if (unplacedRooms.length) areas.push({ key: 'UNPLACED_SCENES', name: 'Other prepared scenes', widePosition: null, wideBounds: null,
    rooms: unplacedRooms.map(room => ({ ...room, roomMapped: false, bounds: null, center: null, mapAnchor: false, mapSprites: [], architect: architectSummary(room.name) })),
    supplemental: true, archive: true, sourceGroup: 'Unplaced scenes' });

  areas.sort((a, b) => {
    if (a.supplemental !== b.supplemental) return a.supplemental ? 1 : -1;
    if (a.supplemental) return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    return b.widePosition.y - a.widePosition.y || a.widePosition.x - b.widePosition.x || a.name.localeCompare(b.name);
  });
  const result = { ...navigation, format: 'silksong-room-atlas-navigation', formatVersion: 5,
    roomPositionSource: 'Game_Map_Hornet GameMapScene sprites; explicit scene variants share a base tile anchor, all remaining renderable scenes are listed as unplaced',
    unmappedMapArtworkSource: 'All additional and duplicate real GameMapScene sprites grouped by authored region; event-state variants remain separately toggleable',
    areas, unplacedRooms, transitionPairs };
  const sourceBytes = Buffer.from(JSON.stringify(result));
  await fs.promises.writeFile(navigationPath, sourceBytes);
  const hostedJson = JSON.stringify(result).replace(/("file"\s*:\s*"maps\/[^"/]+)\.png("?)/g, '$1.webp$2');
  await fs.promises.mkdir(path.dirname(hostedNavigationPath), { recursive: true });
  await fs.promises.writeFile(hostedNavigationPath, zlib.gzipSync(Buffer.from(hostedJson), { level: 9 }));
  const summary = areas.map(area => ({ key: area.key, name: area.name, roomCount: area.rooms.length,
    mapAnchorCount: area.rooms.filter(room => room.mapAnchor).length,
    architectRoomCount: area.rooms.filter(room => room.architect?.markerCount).length,
    additionalArtworkCount: area.unmappedMapArtwork?.length || 0,
    conditionalArtworkCount: (area.conditionalMapArtwork?.length || 0) + area.rooms.filter(room => room.conditionalMapState && room.mapSprites?.length).length,
    supplemental: Boolean(area.supplemental), sourceGroup: area.sourceGroup || null }));
  process.stdout.write(JSON.stringify({ status: 'ready', source: 'Game_Map_Hornet GameMapScene objects',
    matchedRoomCount: selectedRooms.size, mapAnchorCount: [...selectedRooms.values()].filter(room => room.mapAnchor).length,
    architectRoomCount: [...selectedRooms.values()].filter(room => room.architect?.markerCount).length, areaCount: areas.length,
    worldRegionCount: areas.filter(area => area.widePosition).length,
    supplementalSectionCount: supplemental.length, expectedExtraArtworkCount,
    assignedExtraArtworkCount, transitionPairCount: transitionPairs.length, unplacedRenderedRoomCount: unplacedRooms.length,
    aliasedRoomCount, matchedRoomCountByRegion: summary }, null, 2) + '\n');
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
