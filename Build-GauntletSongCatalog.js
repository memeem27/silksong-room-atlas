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
function cleanName(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
}
function sceneId(value) { return String(value || '').replace(/\.bundle$/i, '').toLowerCase(); }
function point(value) {
  if (!value || !Number.isFinite(Number(value.x)) || !Number.isFinite(Number(value.y))) return null;
  return { x: Number(value.x), y: Number(value.y), ...(Number.isFinite(Number(value.z)) ? { z: Number(value.z) } : {}) };
}
function placementOf(record) { return record?.placement || record || {}; }
function configOf(record) { return record?.config || {}; }

function loadRoom(name, areaByRoom) {
  const key = sceneId(name);
  const sidecarPath = path.join(roomDirectory, `${key}.json`);
  const sidecar = fs.existsSync(sidecarPath) ? readJson(sidecarPath) : null;
  const architect = sidecar?.architect || null;
  const map = areaByRoom.get(key) || null;
  const groups = architect?.eventGroups || [];
  const groupByName = new Map(groups.map(group => [String(group.name).toLowerCase(), group]));
  const phases = groups.map((group, sourceOrder) => {
    const name = String(group.name || '');
    const match = /^(.+?)([_-]?)start$/i.exec(name);
    const end = match ? groupByName.get(`${match[1]}${match[2]}end`.toLowerCase()) : null;
    return {
      key: name,
      label: cleanName(match?.[1] || name),
      startEvent: match ? name : null,
      endEvent: end?.name || null,
      actionSummary: group.actions || '',
      linkedPlacementCount: Number(group.placementCount || 0),
      sourceOrder,
      orderConfidence: 'event-name',
      orderNote: 'Architect exports named event phases but do not provide an explicit wave sequence.'
    };
  });
  const placements = (architect?.placements || []).filter(record => !record.controllerMarker).map(record => {
    const config = record.config || {};
    const enemyId = String(record.placement?.id || '').replace(/^prefab_/i, '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const artwork = architect?.enemyArtwork?.[enemyId] || null;
    return {
      key: record.key,
      id: record.placement?.id || '',
      label: record.label || record.placement?.id || 'Architect placement',
      enemy: Boolean(record.enemyCandidate),
      activeByDefault: Boolean(record.activeByDefault),
      position: point(record.worldPosition),
      events: (record.listeners || []).map(listener => ({ name: listener.event, action: listener.action, order: listener.order })),
      configuredHp: config.enemy_hp && Number.isFinite(Number(config.enemy_hp)) ? Number(config.enemy_hp) : null,
      spriteName: artwork?.objectName || artwork?.sprite?.name || null,
      spriteSource: artwork?.sourceBundle || null
    };
  });
  const mapPosition = map?.center ? point(map.center) : null;
  return {
    scene: name,
    map: map ? { areaKey: map.areaKey, areaName: map.areaName, position: mapPosition, bounds: map.bounds || null } : null,
    baseRoomImage: sidecar?.image?.file || null,
    baseRoomBounds: sidecar?.image?.bounds || null,
    architectMarkerCount: architect?.markers?.length || 0,
    architectMarkers: (architect?.markers || []).map(marker => ({
      label: marker.label || '', kind: marker.kind || '', position: point(marker.worldPosition),
      virtualEvent: marker.virtualEvent || null, virtualEndEvent: marker.virtualEndEvent || null
    })),
    phases,
    placements,
    enemyCounts: {
      all: placements.filter(record => record.enemy).length,
      activeByDefault: placements.filter(record => record.enemy && record.activeByDefault).length,
      withRealSprite: placements.filter(record => record.enemy && record.spriteName).length
    },
    hasPreprocessedRoomSidecar: Boolean(sidecar)
  };
}

function main() {
  if (!fs.existsSync(sceneDirectory)) throw new Error(`GauntletSong Architect source is missing: ${sceneDirectory}`);
  const navigation = readJson(navigationPath);
  const areaByRoom = new Map();
  for (const area of navigation.areas || []) {
    for (const room of area.rooms || []) areaByRoom.set(sceneId(room.name), {
      areaKey: area.key, areaName: area.name, center: room.center, bounds: room.bounds || null
    });
  }

  const hubPath = path.join(sceneDirectory, 'gauntHomeMain.architect.json');
  if (!fs.existsSync(hubPath)) throw new Error('GauntletSong hub export gauntHomeMain is missing.');
  const hub = readJson(hubPath);
  const entrances = (hub.placements || []).map((record, sourceOrder) => {
    const placement = placementOf(record), config = configOf(record);
    return { placement, config, sourceOrder };
  }).filter(record => record.placement.id === 'transition_gate' && /^gh[A-Z]/.test(String(record.config.trans_other_scene || '')));

  const gauntlets = entrances.map(entrance => {
    const arenaScene = String(entrance.config.trans_other_scene);
    const arenaPath = path.join(sceneDirectory, `${arenaScene}.architect.json`);
    if (!fs.existsSync(arenaPath)) return {
      key: sceneId(arenaScene), name: cleanName(arenaScene.replace(/^gh/i, '')),
      scene: arenaScene, status: 'missing-source', hubPosition: point(entrance.placement.pos), routes: []
    };
    const arena = readJson(arenaPath);
    const transitionGates = (arena.placements || []).map((record, sourceOrder) => {
      const placement = placementOf(record), config = configOf(record);
      return { placement, config, sourceOrder };
    }).filter(record => record.placement.id === 'transition_gate');
    const internalTransitions = transitionGates
      .filter(record => sceneId(record.config.trans_other_scene) === sceneId(arenaScene))
      .map(record => ({
        targetScene: String(record.config.trans_other_scene || ''),
        targetTransition: String(record.config.trans_other_id || ''),
        position: point(record.placement.pos),
        sourceOrder: record.sourceOrder
      }));
    const routes = transitionGates.filter(record =>
      String(record.config.trans_other_scene || '') !== 'gauntHomeMain' &&
      sceneId(record.config.trans_other_scene) !== sceneId(arenaScene))
      .map(record => ({
        targetScene: String(record.config.trans_other_scene || ''),
        targetTransition: String(record.config.trans_other_id || ''),
        targetType: /^gh/i.test(String(record.config.trans_other_scene || '')) ? 'architect-arena' : 'base-room',
        position: point(record.placement.pos),
        sourceOrder: record.sourceOrder,
        room: /^gh/i.test(String(record.config.trans_other_scene || '')) ? null : loadRoom(record.config.trans_other_scene, areaByRoom)
      }));
    const tilePositions = (arena.tilemap || []).map(cell => [Number(cell.Item1), Number(cell.Item2)])
      .filter(pair => pair.every(Number.isFinite));
    const tileBounds = tilePositions.length ? {
      minX: Math.min(...tilePositions.map(pair => pair[0])), maxX: Math.max(...tilePositions.map(pair => pair[0])),
      minY: Math.min(...tilePositions.map(pair => pair[1])), maxY: Math.max(...tilePositions.map(pair => pair[1]))
    } : null;
    return {
      key: sceneId(arenaScene),
      name: cleanName(arenaScene.replace(/^gh/i, '')),
      scene: arenaScene,
      status: 'architect-export-only',
      hubPosition: point(entrance.placement.pos),
      hubTransition: { id: String(entrance.config.trans_other_id || ''), scene: String(entrance.config.trans_other_scene || '') },
      arenaTileCellCount: tilePositions.length,
      arenaTileBounds: tileBounds,
      arenaPlacementCount: arena.placements?.length || 0,
      arenaScriptBlockCount: arena.script?.length || 0,
      internalTransitions,
      routes
    };
  });

  const uniqueRooms = new Map();
  for (const gauntlet of gauntlets) for (const route of gauntlet.routes.filter(item => item.targetType === 'base-room')) {
    const key = sceneId(route.targetScene);
    if (!uniqueRooms.has(key)) uniqueRooms.set(key, { scene: route.targetScene, routes: [] });
    uniqueRooms.get(key).routes.push({ gauntlet: gauntlet.key, name: gauntlet.name, transition: route.targetTransition });
  }

  const catalog = {
    format: 'silksong-gauntletsong-catalog',
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    source: { name: 'GauntletSong Architect export', hubScene: 'gauntHomeMain', localOnlySourceFolder: 'workspace/gauntlet-song/source/Architect' },
    rendering: {
      baseRoomImagesRemainUnmodified: true,
      gauntletChangesAreLayeredAtViewTime: true,
      customArenaImageStatus: 'The saved exports identify occupied tile coordinates but contain no tile graphics or compiled scene bundles; no synthetic room image is generated.'
    },
    coverage: {
      hubEntrances: gauntlets.length,
      routeCount: gauntlets.reduce((sum, gauntlet) => sum + gauntlet.routes.length, 0),
      baseRoomRouteCount: gauntlets.reduce((sum, gauntlet) => sum + gauntlet.routes.filter(route => route.targetType === 'base-room').length, 0),
      architectArenaRouteCount: gauntlets.reduce((sum, gauntlet) => sum + gauntlet.routes.filter(route => route.targetType === 'architect-arena').length, 0),
      internalTransitionCount: gauntlets.reduce((sum, gauntlet) => sum + gauntlet.internalTransitions.length, 0),
      uniqueBaseRooms: uniqueRooms.size,
      roomsWithMappedPosition: [...uniqueRooms.keys()].filter(key => areaByRoom.has(key)).length,
      roomsWithPreprocessedSidecar: [...uniqueRooms.values()].filter(room => loadRoom(room.scene, areaByRoom).hasPreprocessedRoomSidecar).length
    },
    gauntlets,
    mappedRooms: [...uniqueRooms.values()].map(room => ({ ...loadRoom(room.scene, areaByRoom), routes: room.routes }))
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(catalog), 'utf8');
  fs.renameSync(temporary, outputPath);
  console.log(`Built GauntletSong catalog: ${catalog.coverage.hubEntrances} hub markers, ${catalog.coverage.routeCount} gates, ${catalog.coverage.uniqueBaseRooms} unique rooms.`);
  console.log(`Catalog stays local at ${path.relative(root, outputPath)}; no arena tiles were fabricated or base images modified.`);
}

main();
