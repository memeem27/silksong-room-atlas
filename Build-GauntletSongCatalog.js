#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const sceneDirectory = path.join(root, 'workspace', 'gauntlet-song', 'source', 'Architect', 'Scenes');
const roomDirectory = path.join(root, 'workspace', 'preprocessed', 'rooms');
const navigationPath = path.join(root, 'workspace', 'preprocessed', 'maps', 'navigation.json');
const outputPath = path.join(root, 'workspace', 'gauntlet-song', 'export', 'gauntlet-catalog.json');
const arenaExportDirectory = path.join(root, 'workspace', 'gauntlet-song', 'export', 'arenas');
const rockRollerIdlePath = path.join(root, 'GauntletSongData', 'rockroller-idle.json');
const enemyFactsPath = path.join(root, 'GauntletSongData', 'enemy-facts.json');
const enemyRegistryPath = path.join(root, 'GauntletSongData', 'enemy-registry.json');
const roomEnemyArtworkAliases = new Map();

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function sceneId(value) { return String(value || '').replace(/\.bundle$/i, '').toLowerCase(); }
function normalizeId(value) { return String(value || '').replace(/^prefab_/i, '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function cleanName(value) {
  return String(value || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
}
function point(value) {
  if (!value || !Number.isFinite(Number(value.x)) || !Number.isFinite(Number(value.y))) return null;
  return { x: Number(value.x), y: Number(value.y), ...(Number.isFinite(Number(value.z)) ? { z: Number(value.z) } : {}) };
}
function placementOf(record) { return record?.placement || record || {}; }
function configOf(record) { return record?.config || {}; }

// GauntletSong's Flintbeetle corresponds to the upright Rock Roller frame
// serialized in Bone 01. The first idle frame is side-on and does not match
// the enemy pose shown in game. Reuse the real bundle-derived sprite metadata;
// never synthesize an enemy image or substitute a journal icon.
function loadEnemyArtworkAliases() {
  const sourcePath = path.join(roomDirectory, 'bone_01.json');
  if (!fs.existsSync(sourcePath)) throw new Error('Bone 01 sidecar is required to validate the real Flintbeetle sprite.');
  const room = readJson(sourcePath);
  const owner = (room.objects || []).find(object => (object.sprites || []).some(sprite => sprite.name === 'RR_antic0003'));
  const sprite = (owner?.sprites || []).find(item => item.name === 'RR_antic0003');
  if (!sprite || !/^[a-f0-9]{64}$/i.test(sprite.textureSha256 || '') ||
      !Array.isArray(sprite.meshVertices) || sprite.meshVertices.length < 3 ||
      !Array.isArray(sprite.meshIndices) || sprite.meshIndices.length < 3) {
    throw new Error('Bone 01 does not contain the expected authentic Flintbeetle/Rock Roller sprite frame and mesh.');
  }
  if (!fs.existsSync(rockRollerIdlePath)) throw new Error(`Verified Rock Roller animation metadata is missing: ${rockRollerIdlePath}`);
  const idleAnimation = readJson(rockRollerIdlePath);
  if (idleAnimation.sourceBundle !== 'tk2danimations_assets_areabone.bundle' ||
      idleAnimation.sourceCollection !== 'Rock Roller Cln' || idleAnimation.clip !== 'Idle' ||
      Number(idleAnimation.framesPerSecond) !== 12 || !Array.isArray(idleAnimation.frames) || idleAnimation.frames.length !== 4) {
    throw new Error('Rock Roller idle animation metadata does not match the verified source clip.');
  }
  for (const frame of idleAnimation.frames) {
    if (!/^RR_idle\d{4}$/.test(frame.name || '') || !/^[a-f0-9]{64}$/i.test(frame.textureSha256 || '') ||
        !Number.isFinite(Number(frame.pixelsPerUnit)) || !Number.isFinite(Number(frame.pivotX)) ||
        !Number.isFinite(Number(frame.pivotY))) {
      throw new Error(`Rock Roller idle frame metadata is incomplete: ${frame.name || 'unknown frame'}`);
    }
  }
  return { flintbeetle: {
    placementId: 'flintbeetle', objectName: sprite.name,
    sourceBundle: 'animations_assets_areabone.bundle', offsetX: 0, offsetY: 0,
    sprite: { ...sprite }, idleAnimation: { ...idleAnimation }, aliasOf: 'rockroller-antic-frame'
  } };
}
const enemyArtworkAliases = loadEnemyArtworkAliases();
if (!fs.existsSync(enemyFactsPath)) throw new Error(`Sourced enemy fact entries are missing: ${enemyFactsPath}`);
const enemyFacts = readJson(enemyFactsPath);
for (const [key, facts] of Object.entries(enemyFacts)) {
  if (!/^[a-z0-9]+$/.test(key) || !facts.displayName || !facts.summary ||
      !Number.isFinite(Number(facts.health)) || Number(facts.health) <= 0 ||
      !Array.isArray(facts.needleDamageModifiers) || facts.needleDamageModifiers.length !== 5 ||
      !Array.isArray(facts.sources) || !facts.sources.length ||
      facts.sources.some(source => !/^https:\/\//.test(source.url || ''))) {
    throw new Error(`Enemy fact entry is incomplete or lacks a source: ${key}`);
  }
}
if (!fs.existsSync(enemyRegistryPath)) throw new Error(`GauntletSong enemy registry is missing: ${enemyRegistryPath}`);
const enemyRegistryFile = readJson(enemyRegistryPath);
if (enemyRegistryFile.format !== 'gauntletsong-enemy-registry' || enemyRegistryFile.formatVersion !== 1 ||
    !Array.isArray(enemyRegistryFile.entries) || enemyRegistryFile.entries.length < 100) {
  throw new Error('GauntletSong enemy registry format or coverage is invalid.');
}
const enemyRegistry = new Map(enemyRegistryFile.entries.filter(entry => entry.id && !entry.composite)
  .map(entry => [normalizeId(entry.id), entry]));

function isEnemyPlacement(record) {
  const id = String(placementOf(record).id || ''), normalized = normalizeId(id), config = configOf(record);
  if (/enemy[\s_-]?(?:remover|clear)/i.test(id) || /^(?:enemydamager|enemyhook|enemymanager|objecthook)$/.test(normalized)) return false;
  if (enemyRegistry.has(normalized) || (normalized.startsWith('g') && enemyRegistry.has(normalized.slice(1)))) return true;
  const hasEnemySettings = Object.keys(config).some(key => /enemy_(?:hp|health|damage|spawn|stay_dead)/i.test(key));
  return hasEnemySettings || /^prefab_g[A-Z]/.test(id) ||
    /(?:enemy|boss|spitter|trapper|hunter|hulk|bellbearer|groveller|pouncer|envoy|reed|disciple|watcher|skarr|snipper|ductsucker|charger|gargant|drifter|juror|flintflameflyer|pilgrim_03|goomba|roller|silkfly)/i.test(id);
}
function isNpcPlacement(record) {
  const id = String(placementOf(record).id || '');
  return !isEnemyPlacement(record) && /(?:^|[_-])(?:npc|caretaker|flick|mask.?maker|shakra|flea|elder|merchant)(?:$|[_-])/i.test(id);
}
function normalizedListeners(record) {
  return (Array.isArray(record?.listeners) ? record.listeners : []).map(listener => ({
    event: String(listener?.event ?? listener?.Item1 ?? '').trim(),
    action: String(listener?.action ?? listener?.Item2 ?? '').trim(),
    order: Number.isFinite(Number(listener?.order ?? listener?.Item3)) ? Number(listener.order ?? listener.Item3) : 0
  })).filter(listener => listener.event);
}
function buildArenaData(sceneName, key, arena, roomArtwork = new Map()) {
  const cells = (arena.tilemap || []).map(cell => [Number(cell.Item1), Number(cell.Item2)]).filter(pair => pair.every(Number.isFinite));
  const placements = (arena.placements || []).map((record, index) => {
    const placement = placementOf(record), id = String(placement.id || 'unknown_object'), normalized = normalizeId(id);
    const registryEntry = enemyRegistry.get(normalized) || (normalized.startsWith('g') ? enemyRegistry.get(normalized.slice(1)) : null);
    const listeners = normalizedListeners(record), config = configOf(record), position = point(placement.pos);
    const visibleConfig = Object.fromEntries(Object.entries(config).filter(([name]) =>
      /^start_active$|^trans_other_(?:scene|id)$|^enemy_/i.test(name)));
    const activeValue = String(config.start_active ?? '').trim().toLowerCase();
    const activeByDefault = !['false', '0', 'off', 'no'].includes(activeValue);
    const enemyCandidate = isEnemyPlacement(record), npcCandidate = !enemyCandidate && isNpcPlacement(record);
    return {
      key: `${key}:${String(placement.pid || index)}`, index,
      label: registryEntry?.displayName || cleanName(id.replace(/^prefab_/i, '')),
      placement: { id, pid: String(placement.pid || index), pos: placement.pos || {}, flipped: Boolean(placement.flipped),
        rotation: Number(placement.rotation) || 0, scale: Number.isFinite(Number(placement.scale)) ? Number(placement.scale) : 1,
        layer: Number(placement.layer) || 0 },
      config: visibleConfig, listeners, worldPosition: position,
      activeByDefault, enemyCandidate, npcCandidate, controllerMarker: false,
      ...(registryEntry ? { registry: { displayName: registryEntry.displayName, runtimeName: registryEntry.runtimeName,
        sourceName: registryEntry.sourceName, reusesNativeType: registryEntry.reusesNativeType } } : {})
    };
  }).filter(record => record.worldPosition);
  const eventMap = new Map();
  for (const record of placements) for (const listener of record.listeners) {
    const group = eventMap.get(listener.event) || { name: listener.event, placements: new Set(), actions: new Set() };
    group.placements.add(record.key); if (listener.action) group.actions.add(listener.action); eventMap.set(listener.event, group);
  }
  const eventGroups = [...eventMap.values()].map(group => ({ name: group.name, placementCount: group.placements.size,
    actions: [...group.actions].sort().join(' / ') })).sort((a, b) => a.name.localeCompare(b.name));
  const scriptBlocks = arena.script || [], scriptById = new Map(scriptBlocks.map(block => [String(block.block_id || ''), block]));
  const scriptChoices = scriptBlocks.filter(block => /choice\s*display/i.test(block.type || '') && block.config?.choice_text)
    .map(block => ({ label: String(block.config.choice_text), requirement: String(block.config.choice_requirement || ''),
      cost: String(block.config.choice_cost || ''), blockId: String(block.block_id || ''),
      triggerEvents: [...new Set((block.events?.Yes || []).filter(link => scriptById.get(String(link.Item1 || ''))?.type === 'object')
        .map(link => String(link.Item2 || '').trim()).filter(Boolean))] }));
  const allArtwork = new Map(roomArtwork);
  for (const [artKey, artwork] of Object.entries(enemyArtworkAliases)) allArtwork.set(artKey, artwork);
  const arenaEnemyArtwork = {};
  for (const record of placements) {
    if (!record.enemyCandidate) continue;
    const normalized = normalizeId(record.placement?.id);
    const artworkKey = [normalized, ...(normalized.startsWith('g') ? [normalized.slice(1)] : [])]
      .find(candidate => allArtwork.has(candidate));
    if (artworkKey) {
      record.artworkKey = artworkKey;
      arenaEnemyArtwork[artworkKey] = allArtwork.get(artworkKey);
    }
  }
  const bounds = boundsForCells(cells.map(([x, y]) => ({ Item1: x, Item2: y })));
  return {
    format: 'silksong-architect-arena-layout', formatVersion: 1, scene: sceneName, key,
    source: { mod: 'GauntletSong Architect export', file: `Scenes/${sceneName}.architect.json` },
    coordinateSpace: 'scene-world', rendering: { terrainTextureStatus: 'not-in-export', terrainWasFabricated: false,
      tileOccupancySource: 'Architect scene tilemap', placementSource: 'Architect scene placement records' },
    tileCellCount: cells.length, tileBounds: bounds, tileCells: cells,
    placementCount: placements.length, enemyCount: placements.filter(record => record.enemyCandidate).length,
    npcCount: placements.filter(record => record.npcCandidate).length, placements, enemyArtwork: arenaEnemyArtwork,
    eventGroups, scriptBlockCount: (arena.script || []).length, scriptChoices
  };
}

// Keep the hosted catalog as an index. Per-instance placement data and textures
// stay in the already-compressed room sidecars and load only when a room opens.
function loadRoom(name, areaByRoom) {
  const key = sceneId(name), file = path.join(roomDirectory, `${key}.json`);
  const sidecar = fs.existsSync(file) ? readJson(file) : null;
  const architect = sidecar?.architect || null;
  for (const [artKey, artwork] of Object.entries(architect?.enemyArtwork || {})) {
    const normalized = normalizeId(artKey), sprite = artwork?.sprite;
    if (!normalized || roomEnemyArtworkAliases.has(normalized) ||
        !/^[a-f0-9]{64}$/i.test(sprite?.textureSha256 || '') ||
        !(Number(sprite?.rectWidth) > 0) || !(Number(sprite?.rectHeight) > 0) ||
        (sprite?.meshVertices || []).length < 3 || (sprite?.meshIndices || []).length < 3) continue;
    roomEnemyArtworkAliases.set(normalized, artwork);
  }
  const mapped = areaByRoom.get(key) || null;
  const eventGroups = (architect?.eventGroups || []).map(group => ({
    name: String(group.name || ''), action: String(group.actions || ''),
    placementCount: Number(group.placementCount || 0)
  }));
  const enemyGroups = new Map();
  for (const record of architect?.placements || []) {
    if (!record.enemyCandidate || record.controllerMarker) continue;
    const id = String(record.placement?.id || 'unknown_enemy'), enemyKey = normalizeId(id);
    const group = enemyGroups.get(enemyKey) || { id, key: enemyKey, count: 0, activeByDefault: 0, sprite: null };
    group.count++;
    if (record.activeByDefault) group.activeByDefault++;
    const artwork = architect.enemyArtwork?.[enemyKey] || enemyArtworkAliases[enemyKey] ||
      (enemyKey.startsWith('g') ? enemyArtworkAliases[enemyKey.slice(1)] : null);
    if (!group.sprite && artwork?.sprite?.textureSha256) group.sprite = {
      name: artwork.objectName || artwork.sprite.name || null,
      sourceBundle: artwork.sourceBundle || null,
      textureSha256: artwork.sprite.textureSha256
    };
    enemyGroups.set(enemyKey, group);
  }
  return {
    scene: name,
    map: mapped ? { areaKey: mapped.areaKey, areaName: mapped.areaName, position: point(mapped.center), bounds: mapped.bounds || null } : null,
    baseRoomImage: sidecar?.image?.file || null,
    hasPreprocessedRoomSidecar: Boolean(sidecar),
    architect: architect ? {
      markerCount: architect.markers?.length || 0,
      markers: (architect.markers || []).map(marker => ({
        label: marker.label || '', kind: marker.kind || '', position: point(marker.worldPosition),
        virtualEvent: marker.virtualEvent || null, virtualEndEvent: marker.virtualEndEvent || null
      })),
      eventGroups,
      enemyCounts: {
        all: [...enemyGroups.values()].reduce((sum, enemy) => sum + enemy.count, 0),
        activeByDefault: [...enemyGroups.values()].reduce((sum, enemy) => sum + enemy.activeByDefault, 0),
        withRealSprite: [...enemyGroups.values()].filter(enemy => enemy.sprite).reduce((sum, enemy) => sum + enemy.count, 0)
      },
      enemies: [...enemyGroups.values()].map(({ id, key, count, activeByDefault, sprite }) => ({ id, key, count, activeByDefault, sprite }))
    } : null
  };
}

function main() {
  if (!fs.existsSync(sceneDirectory)) throw new Error(`GauntletSong Architect source is missing: ${sceneDirectory}`);
  const navigation = readJson(navigationPath), areaByRoom = new Map();
  for (const area of navigation.areas || []) for (const room of area.rooms || []) {
    areaByRoom.set(sceneId(room.name), { areaKey: area.key, areaName: area.name, center: room.center, bounds: room.bounds || null });
  }

  const hubScene = 'gaunthomeMain', hubPath = path.join(sceneDirectory, `${hubScene}.architect.json`);
  if (!fs.existsSync(hubPath)) throw new Error(`GauntletSong hub export ${hubScene} is missing.`);
  const hub = readJson(hubPath);
  const entrances = (hub.placements || []).map((record, sourceOrder) => ({
    placement: placementOf(record), config: configOf(record), sourceOrder
  })).filter(record => record.placement.id === 'transition_gate' && /^gh[A-Z]/.test(String(record.config.trans_other_scene || '')));

  const rooms = new Map(), arenaSidecars = [];
  // Gather verified game sprite frames from the linked room sidecars before
  // creating arena sidecars. Arena enemy IDs are matched only to exact
  // normalized enemy keys; unmatched types remain neutral E markers.
  for (const entrance of entrances) {
    const scene = String(entrance.config.trans_other_scene), arenaPath = path.join(sceneDirectory, `${scene}.architect.json`);
    if (!fs.existsSync(arenaPath)) continue;
    const arena = readJson(arenaPath);
    for (const record of arena.placements || []) {
      const placement = placementOf(record), config = configOf(record), target = String(config.trans_other_scene || '');
      if (placement.id !== 'transition_gate' || !target || sceneId(target) === sceneId(hubScene) || /^gh/i.test(target)) continue;
      const roomKey = sceneId(target);
      if (!rooms.has(roomKey)) rooms.set(roomKey, loadRoom(target, areaByRoom));
    }
  }
  const wantedArtworkKeys = new Set();
  for (const entrance of entrances) {
    const scene = String(entrance.config.trans_other_scene), arenaPath = path.join(sceneDirectory, `${scene}.architect.json`);
    if (!fs.existsSync(arenaPath)) continue;
    const arena = readJson(arenaPath);
    for (const record of arena.placements || []) {
      if (!isEnemyPlacement(record)) continue;
      const id = normalizeId(placementOf(record).id), registryEntry = enemyRegistry.get(id) || (id.startsWith('g') ? enemyRegistry.get(id.slice(1)) : null);
      for (const value of [id, id.startsWith('g') ? id.slice(1) : '', registryEntry?.displayName,
        String(registryEntry?.runtimeName || '').replace(/^\[Architect\]\s*/i, '')]) {
        const candidate = normalizeId(value); if (candidate) wantedArtworkKeys.add(candidate);
      }
    }
  }
  if (wantedArtworkKeys.size) {
    const artworkKeyPattern = new RegExp(`\\"(?:${[...wantedArtworkKeys].sort((a, b) => b.length - a.length).join('|')})\\"\\s*:`);
    for (const filename of fs.readdirSync(roomDirectory).filter(name => name.toLowerCase().endsWith('.json'))) {
      const file = path.join(roomDirectory, filename), source = fs.readFileSync(file, 'utf8');
      if (!artworkKeyPattern.test(source)) continue;
      const sidecar = readJson(file);
      for (const [artKey, artwork] of Object.entries(sidecar.architect?.enemyArtwork || {})) {
        const normalized = normalizeId(artKey), sprite = artwork?.sprite;
        if (!wantedArtworkKeys.has(normalized) || roomEnemyArtworkAliases.has(normalized) ||
            !/^[a-f0-9]{64}$/i.test(sprite?.textureSha256 || '') ||
            !(Number(sprite?.rectWidth) > 0) || !(Number(sprite?.rectHeight) > 0) ||
            (sprite?.meshVertices || []).length < 3 || (sprite?.meshIndices || []).length < 3) continue;
        roomEnemyArtworkAliases.set(normalized, artwork);
      }
    }
  }
  const gauntlets = entrances.map(entrance => {
    const scene = String(entrance.config.trans_other_scene), key = sceneId(scene);
    const arenaPath = path.join(sceneDirectory, `${scene}.architect.json`);
    const base = {
      key, name: cleanName(scene.replace(/^gh/i, '')), scene,
      hubPosition: point(entrance.placement.pos),
      hubTransition: { id: String(entrance.config.trans_other_id || ''), scene: String(entrance.config.trans_other_scene || '') }
    };
    if (!fs.existsSync(arenaPath)) return { ...base, status: 'missing-source', tileCellCount: 0, tileBounds: null, placementCount: 0, scriptBlockCount: 0, internalTransitions: [], routes: [] };

    const arena = readJson(arenaPath);
    const gates = (arena.placements || []).map((record, sourceOrder) => ({
      placement: placementOf(record), config: configOf(record), sourceOrder
    })).filter(record => record.placement.id === 'transition_gate');
    const internalTransitions = gates.filter(record => sceneId(record.config.trans_other_scene) === key).map(record => ({
      targetScene: String(record.config.trans_other_scene || ''), targetTransition: String(record.config.trans_other_id || ''),
      position: point(record.placement.pos)
    }));
    const routes = gates.filter(record => sceneId(record.config.trans_other_scene) !== sceneId(hubScene) &&
      sceneId(record.config.trans_other_scene) !== key).map(record => {
      const targetScene = String(record.config.trans_other_scene || ''), targetType = /^gh/i.test(targetScene) ? 'architect-arena' : 'base-room';
      let room = null;
      if (targetType === 'base-room') {
        const roomKey = sceneId(targetScene);
        if (!rooms.has(roomKey)) rooms.set(roomKey, loadRoom(targetScene, areaByRoom));
        room = rooms.get(roomKey);
      }
      return {
        targetScene, targetTransition: String(record.config.trans_other_id || ''), targetType,
        position: point(record.placement.pos), roomScene: room?.scene || null,
        roomArea: room?.map ? { key: room.map.areaKey, name: room.map.areaName, position: room.map.position } : null,
        roomImage: room?.baseRoomImage || null, roomHasSidecar: Boolean(room?.hasPreprocessedRoomSidecar)
      };
    });
    const arenaData = buildArenaData(scene, key, arena, roomEnemyArtworkAliases);
    arenaSidecars.push({ file: `${key}.json`, data: arenaData });
    const cells = (arena.tilemap || []).map(cell => [Number(cell.Item1), Number(cell.Item2)]).filter(pair => pair.every(Number.isFinite));
    const tileBounds = cells.length ? {
      minX: Math.min(...cells.map(pair => pair[0])), maxX: Math.max(...cells.map(pair => pair[0])),
      minY: Math.min(...cells.map(pair => pair[1])), maxY: Math.max(...cells.map(pair => pair[1]))
    } : null;
    return {
      ...base, status: 'architect-export-only', arenaData: `maps/gauntlet-scenes/${key}.json`,
      tileCellCount: cells.length, tileBounds,
      placementCount: arena.placements?.length || 0, scriptBlockCount: arena.script?.length || 0,
      arenaEnemyCount: arenaData.enemyCount, arenaEventCount: arenaData.eventGroups.length,
      internalTransitions, routes
    };
  });

  const catalog = {
    format: 'silksong-gauntletsong-catalog', formatVersion: 2, generatedAt: new Date().toISOString(),
    source: { name: 'GauntletSong Architect export', hubScene, localOnlySourceFolder: 'workspace/gauntlet-song/source/Architect' },
    rendering: {
      portalCoordinatesAreArchitectWorldPositions: true,
      baseRoomImagesRemainUnmodified: true,
      perRoomPlacementsLoadFromRoomSidecars: true,
      customArenaImageStatus: 'Architect exports contain tile coordinates but no game tile textures or compiled scene bundles; no arena background is fabricated.'
    },
    enemyArtworkAliases,
    enemyFacts,
    coverage: {
      hubEntrances: gauntlets.length,
      routeCount: gauntlets.reduce((sum, gauntlet) => sum + gauntlet.routes.length, 0),
      baseRoomRouteCount: gauntlets.reduce((sum, gauntlet) => sum + gauntlet.routes.filter(route => route.targetType === 'base-room').length, 0),
      architectArenaRouteCount: gauntlets.reduce((sum, gauntlet) => sum + gauntlet.routes.filter(route => route.targetType === 'architect-arena').length, 0),
      internalTransitionCount: gauntlets.reduce((sum, gauntlet) => sum + gauntlet.internalTransitions.length, 0),
      uniqueBaseRooms: rooms.size,
      roomsWithMappedPosition: [...rooms.values()].filter(room => room.map).length,
      roomsWithPreprocessedSidecar: [...rooms.values()].filter(room => room.hasPreprocessedRoomSidecar).length,
      enemyTypes: new Set([...rooms.values()].flatMap(room => room.architect?.enemies?.map(enemy => enemy.key) || [])).size,
      arenaScenes: arenaSidecars.length
    },
    hub: {
      scene: hubScene, coordinateSpace: 'scene-world',
      tileCellCount: (hub.tilemap || []).length,
      tileBounds: boundsForCells(hub.tilemap || []),
      tileCells: (hub.tilemap || []).map(cell => [Number(cell.Item1), Number(cell.Item2)]).filter(pair => pair.every(Number.isFinite))
    },
    gauntlets,
    mappedRooms: [...rooms.values()]
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(catalog), 'utf8'); fs.renameSync(temporary, outputPath);
  fs.mkdirSync(arenaExportDirectory, { recursive: true });
  for (const sidecar of arenaSidecars) {
    const sidecarPath = path.join(arenaExportDirectory, sidecar.file), sidecarTemporary = `${sidecarPath}.${process.pid}.tmp`;
    fs.writeFileSync(sidecarTemporary, JSON.stringify(sidecar.data), 'utf8'); fs.renameSync(sidecarTemporary, sidecarPath);
  }
  console.log(`Built GauntletSong index: ${catalog.coverage.hubEntrances} markers, ${catalog.coverage.routeCount} gates, ${catalog.coverage.uniqueBaseRooms} linked rooms.`);
  console.log(`Compact catalog ${Buffer.byteLength(JSON.stringify(catalog)).toLocaleString()} bytes; ${arenaSidecars.length} lazy arena sidecars contain source tile cells and placements. No terrain image is fabricated or changed.`);
}

function boundsForCells(cells) {
  const points = cells.map(cell => [Number(cell.Item1), Number(cell.Item2)]).filter(pair => pair.every(Number.isFinite));
  if (!points.length) return null;
  return { minX: Math.min(...points.map(pair => pair[0])), maxX: Math.max(...points.map(pair => pair[0])),
    minY: Math.min(...points.map(pair => pair[1])), maxY: Math.max(...points.map(pair => pair[1])) };
}

main();
