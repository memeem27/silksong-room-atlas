#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const sceneDirectory = path.join(root, 'workspace', 'gauntlet-song', 'source', 'Architect', 'Scenes');
const roomDirectory = path.join(root, 'workspace', 'preprocessed', 'rooms');
const navigationPath = path.join(root, 'workspace', 'preprocessed', 'maps', 'navigation.json');
const outputPath = path.join(root, 'workspace', 'gauntlet-song', 'export', 'gauntlet-catalog.json');

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

// The GauntletSong prefab uses the display name Flintbeetle, while the game
// animation is indexed as Rock Roller. Reuse the verified bundle-derived
// sprite geometry already present in Bone 01's room sidecar; never synthesize
// an enemy image or substitute a journal icon.
function loadEnemyArtworkAliases() {
  const sourcePath = path.join(roomDirectory, 'bone_01.json');
  if (!fs.existsSync(sourcePath)) throw new Error('Bone 01 sidecar is required to validate the real Flintbeetle sprite.');
  const source = readJson(sourcePath).architect?.enemyArtwork?.boneroller;
  const sprite = source?.sprite;
  if (source?.objectName !== 'RR_idle0000' || source.sourceBundle !== 'animations_assets_areabone.bundle' ||
      !/^[a-f0-9]{64}$/i.test(sprite?.textureSha256 || '') || sprite.name !== 'RR_idle0000') {
    throw new Error('Bone 01 does not contain the expected authentic Flintbeetle/Rock Roller idle sprite.');
  }
  return { flintbeetle: { ...source, aliasOf: 'boneroller' } };
}
const enemyArtworkAliases = loadEnemyArtworkAliases();

// Keep the hosted catalog as an index. Per-instance placement data and textures
// stay in the already-compressed room sidecars and load only when a room opens.
function loadRoom(name, areaByRoom) {
  const key = sceneId(name), file = path.join(roomDirectory, `${key}.json`);
  const sidecar = fs.existsSync(file) ? readJson(file) : null;
  const architect = sidecar?.architect || null;
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

  const rooms = new Map();
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
    const cells = (arena.tilemap || []).map(cell => [Number(cell.Item1), Number(cell.Item2)]).filter(pair => pair.every(Number.isFinite));
    const tileBounds = cells.length ? {
      minX: Math.min(...cells.map(pair => pair[0])), maxX: Math.max(...cells.map(pair => pair[0])),
      minY: Math.min(...cells.map(pair => pair[1])), maxY: Math.max(...cells.map(pair => pair[1]))
    } : null;
    return {
      ...base, status: 'architect-export-only', tileCellCount: cells.length, tileBounds,
      placementCount: arena.placements?.length || 0, scriptBlockCount: arena.script?.length || 0,
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
    coverage: {
      hubEntrances: gauntlets.length,
      routeCount: gauntlets.reduce((sum, gauntlet) => sum + gauntlet.routes.length, 0),
      baseRoomRouteCount: gauntlets.reduce((sum, gauntlet) => sum + gauntlet.routes.filter(route => route.targetType === 'base-room').length, 0),
      architectArenaRouteCount: gauntlets.reduce((sum, gauntlet) => sum + gauntlet.routes.filter(route => route.targetType === 'architect-arena').length, 0),
      internalTransitionCount: gauntlets.reduce((sum, gauntlet) => sum + gauntlet.internalTransitions.length, 0),
      uniqueBaseRooms: rooms.size,
      roomsWithMappedPosition: [...rooms.values()].filter(room => room.map).length,
      roomsWithPreprocessedSidecar: [...rooms.values()].filter(room => room.hasPreprocessedRoomSidecar).length,
      enemyTypes: new Set([...rooms.values()].flatMap(room => room.architect?.enemies?.map(enemy => enemy.key) || [])).size
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
  console.log(`Built GauntletSong index: ${catalog.coverage.hubEntrances} markers, ${catalog.coverage.routeCount} gates, ${catalog.coverage.uniqueBaseRooms} linked rooms.`);
  console.log(`Compact catalog ${Buffer.byteLength(JSON.stringify(catalog)).toLocaleString()} bytes; no arena tiles or base images were fabricated or modified.`);
}

function boundsForCells(cells) {
  const points = cells.map(cell => [Number(cell.Item1), Number(cell.Item2)]).filter(pair => pair.every(Number.isFinite));
  if (!points.length) return null;
  return { minX: Math.min(...points.map(pair => pair[0])), maxX: Math.max(...points.map(pair => pair[0])),
    minY: Math.min(...points.map(pair => pair[1])), maxY: Math.max(...points.map(pair => pair[1])) };
}

main();
