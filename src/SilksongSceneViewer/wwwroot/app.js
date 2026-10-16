const byId = id => document.getElementById(id);
const state = { source: '', scenes: [], scene: null, requested: null, selected: null, scale: 1, centerX: 0, centerY: 0, fitBounds: null, fitted: false, gameView: false, cameraLockAreas: [], cameraLockIndex: -1, grid: true, drag: null, images: new Map(), tintedSpriteImages: new Map(), hiddenSortingLayers: new Set(), objectById: new Map(), meshAssets: new Map(), activationGroups: [], stateOverrideCandidates: [], objectVisibilityOverrides: new Map(), gradePreviewObjectId: null, gradePreviewFactor: 1, artworkCanvas: null, backgroundCanvas: null, gameCaptures: new Map(), gameCaptureObjectUrls: new Set(), gameCaptureSource: '', gameCapturesEnabled: false, gameCaptureView: 'latest', architectSources: new Map(), architectScenes: new Map(), architectPrefabs: new Map(), architectSource: '', architectMarkersEnabled: false, architectSelectedMarkerId: null, architectSelectedWaveKey: null, architectWaveFilterKeys: null, architectChangesVisible: false, architectPlacementVisibility: new Map(), architectWaveEnemyVisibility: new Map(), architectPreviewName: null, architectAssetFiles: new Map(), architectAssetImages: new Map(), architectObjectUrls: new Set(), architectEnemyArt: new Map(), architectEnemyArtRequested: new Set(), architectEnemyArtPendingIds: new Set(), architectEnemyTexturesVisible: true, architectModImagesVisible: true, architectEnemyArtError: '', architectEnemyArtSummary: '', batchRendering: false, bulkExporting: false, bulkExportCancelled: false, bulkExportZipUrl: null };
state.architectActiveEvents = new Set();
state.readerMode = false;
state.readerRoomName = null;
state.readerAreaKey = null;
state.readerMapScene = null;
state.readerVisibleObjects = null;
state.readerAreas = [];
state.readerDetailLabels = [];
state.readerRoomMapObjects = [];
state.readerRoomObjectByName = new Map();
state.readerPreviousScene = null;
state.readerSavedLayers = null;
state.readerSavedGrid = true;
const componentTerms = {
  enemy: ['HealthManager', 'EnemyDeathEffects', 'BattleSceneEnemy'],
  spawn: ['EnemySpawner', 'Spawn', 'Spawner'],
  check: ['CollectableItemPickup', 'PersistentBoolItem', 'Interact', 'Bench', 'Quest', 'Flea', 'Shop']
};
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const componentsOf = object => object.components || [];
const matchComponents = (object, terms) => componentsOf(object).some(component => terms.some(term => `${component.type} ${component.scriptName || ''}`.toLowerCase().includes(term.toLowerCase())));
const kindLabel = kind => kind === 'arena' ? 'ARENA' : kind === 'additive' ? 'ADDITIVE' : 'ROOM';

async function getJson(url, init) {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.detail || data.error || `Request failed (${response.status}).`);
  return data;
}

function showToast(message) {
  const toast = byId('toast'); toast.textContent = message; toast.classList.add('show');
  clearTimeout(showToast.timeout); showToast.timeout = setTimeout(() => toast.classList.remove('show'), 2800);
}

async function refreshSceneIndex() {
  byId('sceneList').innerHTML = '<div class="empty-state compact">Reading room bundles…</div>';
  try {
    const result = await getJson('/api/scenes');
    state.source = result.source;
    state.scenes = result.scenes || [];
    const count = `${state.scenes.length.toLocaleString()} ${state.scenes.length === 1 ? 'room candidate' : 'room candidates'}`;
    byId('sceneCount').textContent = count;
    byId('exportAllButton').disabled = state.scenes.length === 0 || state.bulkExporting;
    byId('prepareReaderButton').disabled = state.scenes.length === 0 || state.bulkExporting;
    byId('sourcePath').textContent = state.source || 'No source folder selected';
    byId('sourceSummary').textContent = state.scenes.length ? `${count} · local Unity bundles` : 'No room bundles found';
    renderSceneList();
    if (state.readerMode && state.readerMapScene) { buildReaderModel(state.readerMapScene); renderReaderNavigation(); }
  } catch (error) {
    byId('sceneList').innerHTML = `<div class="empty-state compact">${escapeHtml(error.message)}</div>`;
    byId('sourceSummary').textContent = 'Local source unavailable';
    byId('exportAllButton').disabled = true;
    byId('prepareReaderButton').disabled = true;
  }
}

function renderSceneList() {
  const query = byId('sceneSearch').value.trim().toLowerCase();
  const scenes = state.requested?.length
    ? state.requested.flatMap(requested => { const entry = resolveScene(requested); return entry ? [entry] : []; })
    : state.scenes.filter(scene => scene.candidateName.toLowerCase().includes(query));
  const seen = new Set();
  const unique = scenes.filter(scene => !seen.has(scene.bundleFile) && seen.add(scene.bundleFile));
  if (!unique.length) {
    byId('sceneList').innerHTML = `<div class="empty-state compact">${state.requested?.length ? 'None of the listed names matched the selected bundle folder.' : 'No matching rooms. Check the source folder or search name.'}</div>`;
    return;
  }
  const groups = new Map([['ROOM CANDIDATES', []], ['ARENAS & BOSSES', []], ['ADDITIVE SCENES', []]]);
  for (const scene of unique) groups.get(scene.kind === 'arena' ? 'ARENAS & BOSSES' : scene.kind === 'additive' ? 'ADDITIVE SCENES' : 'ROOM CANDIDATES').push(scene);
  const html = [...groups.entries()].filter(([, entries]) => entries.length).map(([group, entries]) =>
    `<div class="scene-group">${group}</div>${entries.map(scene => `<button class="scene-entry ${state.scene?.sceneName === scene.candidateName ? 'selected' : ''}" data-name="${escapeHtml(scene.candidateName)}" title="${escapeHtml(scene.bundleFile)}"><span class="scene-glyph">${scene.kind === 'arena' ? '⚔' : scene.kind === 'additive' ? '+' : '⌂'}</span><span>${escapeHtml(scene.candidateName)}</span><span class="scene-meta">${formatBytes(scene.fileBytes)}</span></button>`).join('')}`).join('');
  byId('sceneList').innerHTML = html;
  byId('sceneList').querySelectorAll('.scene-entry').forEach(button => button.addEventListener('click', () => openScene(button.dataset.name)));
}

function readerObjectStrings(object) {
  const strings = {};
  for (const component of object?.components || []) Object.assign(strings, component.data?.strings || {});
  return strings;
}

function readerRootObjects(objects, rootName) {
  const byId = new Map(objects.map(object => [object.id, object]));
  const root = objects.find(object => object.name === rootName && !object.parentId);
  if (!root) return [];
  return objects.filter(object => {
    if (object.id === root.id) return true;
    let current = object, steps = 0;
    while (current?.parentId && steps++ < 80) {
      current = byId.get(current.parentId);
      if (!current) return false;
      if (current.id === root.id) return true;
    }
    return false;
  });
}

function readerSpriteBounds(object) {
  const point = object.worldPosition || { x: 0, y: 0 };
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const sprite of object.sprites || []) {
    const geometry = spriteLocalGeometry(sprite), matrix = spriteWorldMatrix(sprite);
    for (const [x, y] of [[geometry.left, geometry.bottom], [geometry.right, geometry.bottom],
      [geometry.left, geometry.top], [geometry.right, geometry.top]]) {
      const worldX = point.x + matrix.m00 * x + matrix.m01 * y;
      const worldY = point.y + matrix.m10 * x + matrix.m11 * y;
      minX = Math.min(minX, worldX); maxX = Math.max(maxX, worldX);
      minY = Math.min(minY, worldY); maxY = Math.max(maxY, worldY);
    }
  }
  return Number.isFinite(minX) ? { minX, maxX, minY, maxY } : null;
}

function readerUnionBounds(bounds) {
  const valid = bounds.filter(Boolean);
  if (!valid.length) return null;
  return { minX: Math.min(...valid.map(bound => bound.minX)), maxX: Math.max(...valid.map(bound => bound.maxX)),
    minY: Math.min(...valid.map(bound => bound.minY)), maxY: Math.max(...valid.map(bound => bound.maxY)) };
}

function readerExpandBounds(bounds, padding = 1) {
  if (!bounds) return null;
  const marginX = Math.max(padding, (bounds.maxX - bounds.minX) * .08);
  const marginY = Math.max(padding, (bounds.maxY - bounds.minY) * .08);
  return { minX: bounds.minX - marginX, maxX: bounds.maxX + marginX,
    minY: bounds.minY - marginY, maxY: bounds.maxY + marginY };
}

function readerNormalizeName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function buildReaderModel(mapScene) {
  const objects = mapScene.objects || [];
  const wideObjects = readerRootObjects(objects, 'Wide Map');
  const detailObjects = readerRootObjects(objects, 'Game_Map_Hornet');
  if (!wideObjects.length || !detailObjects.length) throw new Error('The map bundle did not contain its Wide Map and Game_Map_Hornet layouts.');

  const wideLabels = wideObjects.map(object => ({ object, strings: readerObjectStrings(object) }))
    .filter(entry => entry.strings.Key && entry.strings.m_text);
  const areasByKey = new Map();
  for (const entry of wideLabels) {
    const key = String(entry.strings.Key).toUpperCase();
    if (!areasByKey.has(key)) areasByKey.set(key, { key, name: String(entry.strings.m_text).trim(),
      wideLabel: entry.object, widePosition: entry.object.worldPosition || { x: 0, y: 0 }, rooms: [], detailLabels: [] });
  }
  const areas = [...areasByKey.values()];
  for (const area of areas) {
    const candidates = wideObjects.filter(object => (object.sprites || []).some(sprite => /^wide_map/i.test(sprite.name || object.name)));
    area.mapArtwork = candidates.reduce((best, object) => {
      const p = object.worldPosition || { x: 0, y: 0 };
      const distance = Math.hypot(p.x - area.widePosition.x, p.y - area.widePosition.y);
      return !best || distance < best.distance ? { object, distance } : best;
    }, null)?.object || null;
    area.wideBounds = readerExpandBounds(readerUnionBounds([
      readerSpriteBounds(area.mapArtwork),
      { minX: area.widePosition.x, maxX: area.widePosition.x, minY: area.widePosition.y, maxY: area.widePosition.y }
    ]), .12);
  }

  const detailLabels = detailObjects.map(object => ({ object, strings: readerObjectStrings(object) }))
    .filter(entry => entry.strings.Key && entry.strings.m_text)
    .map(entry => ({ key: String(entry.strings.Key).toUpperCase(), text: String(entry.strings.m_text).trim(),
      object: entry.object, position: entry.object.worldPosition || { x: 0, y: 0 } }));
  const areaByKey = new Map(areas.map(area => [area.key, area]));
  for (const label of detailLabels) {
    const area = areaByKey.get(label.key);
    if (area) area.detailLabels.push(label);
  }

  const sceneByName = new Map((state.scenes || []).filter(scene => scene.kind !== 'arena' && scene.kind !== 'additive')
    .map(scene => [readerNormalizeName(scene.candidateName), scene]));
  const mapRooms = [];
  for (const object of detailObjects) {
    if (!(object.sprites || []).length) continue;
    const scene = sceneByName.get(readerNormalizeName(object.name));
    if (!scene) continue;
    const bounds = readerSpriteBounds(object);
    if (!bounds) continue;
    const center = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
    let nearest = null;
    for (const label of detailLabels) {
      const distance = Math.hypot(center.x - label.position.x, center.y - label.position.y);
      if (!nearest || distance < nearest.distance) nearest = { label, distance };
    }
    const room = { scene, object, bounds, center, areaKey: nearest?.label.key || '', areaLabel: nearest?.label || null };
    mapRooms.push(room);
    const area = areaByKey.get(room.areaKey);
    if (area) area.rooms.push(room);
  }

  // The wide map groups the Citadel as one region, while the detailed map
  // labels its Song, Library, Conductors' Quarter, and Cog Core subareas.
  // Group their actual room-map objects under the wider region for navigation.
  const cityOfSong = areaByKey.get('CITY_OF_SONG');
  if (cityOfSong) {
    for (const room of mapRooms) {
      if (!/^(song|library|hang|cog)_/i.test(room.scene.candidateName)) continue;
      const previousArea = areaByKey.get(room.areaKey);
      if (previousArea && previousArea !== cityOfSong)
        previousArea.rooms = previousArea.rooms.filter(candidate => candidate !== room);
      if (!cityOfSong.rooms.includes(room)) cityOfSong.rooms.push(room);
      room.areaKey = cityOfSong.key;
    }
  }

  for (const area of areas) {
    const roomBounds = readerUnionBounds(area.rooms.map(room => room.bounds));
    const roomCenter = roomBounds ? { x: (roomBounds.minX + roomBounds.maxX) / 2, y: (roomBounds.minY + roomBounds.maxY) / 2 } : null;
    const closestLabel = area.detailLabels.reduce((best, label) => {
      const distance = roomCenter ? Math.hypot(label.position.x - roomCenter.x, label.position.y - roomCenter.y) : 0;
      return !best || distance < best.distance ? { label, distance } : best;
    }, null);
    area.detailFocus = closestLabel?.label || area.detailLabels[0] || null;
    const focusBounds = area.detailFocus ? { minX: area.detailFocus.position.x, maxX: area.detailFocus.position.x,
      minY: area.detailFocus.position.y, maxY: area.detailFocus.position.y } : null;
    area.detailBounds = readerExpandBounds(readerUnionBounds([roomBounds, focusBounds]), 1.25);
    area.rooms.sort((a, b) => a.scene.candidateName.localeCompare(b.scene.candidateName, undefined, { numeric: true, sensitivity: 'base' }));
  }

  areas.sort((a, b) => b.widePosition.y - a.widePosition.y || a.widePosition.x - b.widePosition.x || a.name.localeCompare(b.name));
  state.readerWideObjects = wideObjects;
  state.readerDetailObjects = detailObjects;
  state.readerDetailLabels = detailLabels;
  state.readerRoomMapObjects = mapRooms;
  state.readerRoomObjectByName = new Map(mapRooms.map(room => [readerNormalizeName(room.scene.candidateName), room]));
  state.readerAreas = areas;
}

function renderReaderNavigation() {
  if (!state.readerMode) return;
  const area = state.readerAreas.find(item => item.key === state.readerAreaKey) || null;
  const areaList = byId('readerAreaList'), roomList = byId('readerRoomList');
  byId('readerWorldButton').hidden = !area || Boolean(state.readerRoomName);
  byId('readerReturnToAreaButton').hidden = !state.readerRoomName;
  if (state.readerRoomName) {
    byId('readerNavTitle').textContent = state.readerRoomName;
    byId('readerNavDescription').textContent = `${area?.name || 'Selected area'} · rendered Silksong room`;
    byId('readerReturnToAreaButton').textContent = `← ${area?.name || 'Area map'}`;
    areaList.hidden = true; roomList.hidden = false;
  } else if (area) {
    byId('readerNavTitle').textContent = area.name;
    byId('readerNavDescription').textContent = `${area.rooms.length.toLocaleString()} mapped rooms · click a room for its rendered scene`;
    areaList.hidden = true; roomList.hidden = false;
  } else {
    byId('readerNavTitle').textContent = 'World regions';
    byId('readerNavDescription').textContent = `${state.readerAreas.length} regions from the game map · select one to zoom in`;
    areaList.hidden = false; roomList.hidden = true;
  }

  if (!area && !state.readerRoomName) {
    areaList.innerHTML = state.readerAreas.map((item, index) => `<button class="reader-area-button" type="button" data-reader-area="${escapeHtml(item.key)}" title="${escapeHtml(item.name)}"><span class="reader-area-number">${String(index + 1).padStart(2, '0')}</span><span class="reader-area-copy"><span class="reader-area-name">${escapeHtml(item.name)}</span><span class="reader-area-meta">${item.rooms.length.toLocaleString()} rooms</span></span><span class="reader-area-arrow">›</span></button>`).join('') || '<div class="reader-empty">No named map regions were read from the game bundle.</div>';
    areaList.querySelectorAll('[data-reader-area]').forEach(button => button.addEventListener('click', () => showReaderArea(button.dataset.readerArea)));
  }
  if (area || state.readerRoomName) {
    const query = byId('readerRoomSearch').value.trim().toLowerCase();
    const rooms = (area?.rooms || []).filter(room => !query || room.scene.candidateName.toLowerCase().includes(query));
    roomList.innerHTML = `<input id="readerRoomSearch" class="reader-room-search" type="search" placeholder="Find a room…" value="${escapeHtml(query)}" autocomplete="off">` +
      (rooms.length ? rooms.map((room, index) => `<button class="reader-room-button ${state.readerRoomName === room.scene.candidateName ? 'active' : ''}" type="button" data-reader-room="${escapeHtml(room.scene.candidateName)}" title="${escapeHtml(room.scene.bundleFile)}"><span class="reader-area-number">${String(index + 1).padStart(2, '0')}</span><span class="reader-room-copy"><span class="reader-room-name">${escapeHtml(room.scene.candidateName)}</span><span class="reader-room-meta">${formatBytes(room.scene.fileBytes)}</span></span><span class="reader-area-arrow">›</span></button>`).join('') : '<div class="reader-empty">No room bundles from this area are present in the selected source folder.</div>');
    roomList.querySelectorAll('[data-reader-room]').forEach(button => button.addEventListener('click', () => openReaderRoom(button.dataset.readerRoom)));
    byId('readerRoomSearch').addEventListener('input', renderReaderNavigation);
  }
}

function saveReaderLayers() {
  if (state.readerSavedLayers) return;
  const layerIds = ['layerArtwork', 'layerLighting', 'layerBackground', 'layerEffects', 'layerObjects', 'layerColliders', 'layerEnemies', 'layerSpawns', 'layerChecks'];
  state.readerSavedLayers = Object.fromEntries(layerIds.map(id => [id, byId(id).checked]));
  state.readerSavedGrid = state.grid;
}

function applyReaderMapLayers() {
  const values = { layerArtwork: true, layerLighting: true, layerBackground: true, layerEffects: false,
    layerObjects: false, layerColliders: false, layerEnemies: false, layerSpawns: false, layerChecks: false };
  for (const [id, checked] of Object.entries(values)) byId(id).checked = checked;
  state.grid = false;
  byId('gridButton').classList.toggle('active', state.grid);
}

function restoreReaderLayers() {
  if (state.readerSavedLayers) {
    for (const [id, checked] of Object.entries(state.readerSavedLayers)) byId(id).checked = checked;
    state.readerSavedLayers = null;
  }
  state.grid = state.readerSavedGrid;
  byId('gridButton').classList.toggle('active', state.grid);
}

function showReaderMapBranch(branch, bounds, title, status) {
  state.scene = state.readerMapScene;
  state.readerVisibleObjects = branch;
  state.meshAssets = new Map((state.scene.meshAssets || []).map(mesh => [mesh.id, mesh]));
  state.objectById = new Map((branch || []).map(object => [object.id, object]));
  state.hiddenSortingLayers = new Set((branch || []).flatMap(object => [
    ...(object.sprites || []), ...(object.meshes || []), ...(object.sortingGroup?.enabled ? [object.sortingGroup] : [])
  ]).filter(artwork => artwork.sortingLayerKnown === false).map(artwork => Number(artwork.sortingLayerId) || 0));
  state.objectVisibilityOverrides = new Map();
  state.activationGroups = [];
  state.gradePreviewObjectId = null;
  state.selected = null;
  state.fitBounds = bounds || null;
  state.fitted = false;
  state.cameraLockAreas = [];
  state.cameraLockIndex = -1;
  state.architectPreviewName = null;
  state.architectMarkersEnabled = false;
  state.architectChangesVisible = false;
  state.architectSelectedMarkerId = null;
  state.architectSelectedWaveKey = null;
  state.architectWaveFilterKeys = null;
  state.architectActiveEvents = new Set();
  state.architectPlacementVisibility = new Map();
  state.architectWaveEnemyVisibility = new Map();
  byId('currentSceneTitle').textContent = title;
  byId('sceneKind').textContent = state.readerAreaKey ? 'AREA MAP' : 'WIDE MAP';
  byId('viewStatus').textContent = status;
  byId('detailSceneName').textContent = title;
  byId('detailObjects').textContent = (branch || []).length.toLocaleString();
  byId('detailBundle').textContent = 'maps_assets_all.bundle';
  byId('detailBounds').textContent = bounds ? `${(bounds.maxX - bounds.minX).toFixed(1)} × ${(bounds.maxY - bounds.minY).toFixed(1)} map units` : 'game-authored layout';
  byId('objectCount').textContent = `${(branch || []).length.toLocaleString()} MAP OBJECTS · GAME BUNDLE`;
  byId('treeCount').textContent = (branch || []).length.toLocaleString();
  byId('emptyCanvas').classList.add('hidden');
  byId('exportButton').disabled = true;
  byId('mapDataButton').disabled = true;
  byId('fitZonesButton').disabled = true;
  byId('fitZonesButton').classList.remove('active');
  byId('fitButton').disabled = false;
  byId('readerRoomList').hidden = !state.readerAreaKey;
  byId('selectionContent').textContent = 'Choose an area or room from the map reader.';
  renderReaderNavigation();
  drawScene();
}

async function enterMapReader() {
  if (state.readerMode) { leaveMapReader(); return; }
  state.readerPreviousScene = state.scene?.sceneName && resolveScene(state.scene.sceneName) ? state.scene.sceneName : null;
  saveReaderLayers();
  state.readerMode = true;
  state.readerRoomName = null;
  state.readerAreaKey = null;
  state.readerVisibleObjects = null;
  document.body.classList.add('reader-mode');
  byId('mapReaderButton').classList.add('active');
  byId('mapReaderButton').innerHTML = '× <span>Close Map Reader</span>';
  byId('mapReaderNav').hidden = false;
  byId('viewStatus').textContent = 'LOADING SILKSONG MAP BUNDLE';
  byId('canvasShell').classList.add('is-loading');
  try {
    state.readerMapScene = await getJson('/api/world-map');
    buildReaderModel(state.readerMapScene);
    applyReaderMapLayers();
    showReaderMapBranch(state.readerWideObjects, null, 'Wide World Map', 'GAME WIDE MAP · AUTHORED LAYOUT');
  } catch (error) {
    state.readerMode = false;
    document.body.classList.remove('reader-mode', 'reader-room-mode');
    byId('mapReaderButton').classList.remove('active');
    byId('mapReaderButton').innerHTML = '◎ <span>Map Reader</span>';
    byId('mapReaderNav').hidden = true;
    restoreReaderLayers();
    showToast(error.message);
  } finally { byId('canvasShell').classList.remove('is-loading'); }
}

function showReaderArea(key) {
  const area = state.readerAreas.find(item => item.key === String(key || '').toUpperCase());
  if (!area) return;
  state.readerAreaKey = area.key;
  state.readerRoomName = null;
  document.body.classList.remove('reader-room-mode');
  applyReaderMapLayers();
  showReaderMapBranch(state.readerDetailObjects, area.detailBounds, area.name, `AREA DETAIL · ${area.key} · ${area.rooms.length} ROOMS`);
  byId('readerWorldButton').hidden = false;
  byId('readerWorldButton').textContent = '← All regions';
}

function showReaderWorldMap() {
  state.readerAreaKey = null;
  state.readerRoomName = null;
  document.body.classList.remove('reader-room-mode');
  applyReaderMapLayers();
  const bounds = visibleSpriteBounds(state.readerWideObjects || []);
  showReaderMapBranch(state.readerWideObjects, bounds, 'Wide World Map', 'GAME WIDE MAP · AUTHORED LAYOUT');
}

async function openReaderRoom(name) {
  if (!state.readerMode || !resolveScene(name)) return;
  state.readerRoomName = name;
  document.body.classList.add('reader-room-mode');
  restoreReaderLayers();
  renderReaderNavigation();
  await openScene(name);
}

function returnReaderToArea() {
  const area = state.readerAreas.find(item => item.key === state.readerAreaKey);
  if (!area) { showReaderWorldMap(); return; }
  state.readerRoomName = null;
  document.body.classList.remove('reader-room-mode');
  applyReaderMapLayers();
  showReaderMapBranch(state.readerDetailObjects, area.detailBounds, area.name, `AREA DETAIL · ${area.key} · ${area.rooms.length} ROOMS`);
}

function leaveMapReader() {
  if (!state.readerMode) return;
  const target = state.readerRoomName || state.readerPreviousScene;
  state.readerMode = false;
  state.readerRoomName = null;
  state.readerAreaKey = null;
  state.readerVisibleObjects = null;
  document.body.classList.remove('reader-mode', 'reader-room-mode');
  byId('mapReaderButton').classList.remove('active');
  byId('mapReaderButton').innerHTML = '◎ <span>Map Reader</span>';
  byId('mapReaderNav').hidden = true;
  restoreReaderLayers();
  if (target && resolveScene(target)) void openScene(target);
  else {
    state.scene = null;
    byId('emptyCanvas').classList.remove('hidden');
    byId('currentSceneTitle').textContent = 'Choose a room';
    byId('sceneKind').textContent = 'SCENE';
    byId('detailSceneName').textContent = 'No scene selected';
    byId('detailObjects').textContent = '—';
    byId('detailBundle').textContent = '—';
    byId('detailBounds').textContent = '—';
    byId('exportButton').disabled = true;
    byId('mapDataButton').disabled = true;
    byId('fitZonesButton').disabled = true;
    byId('sceneList').querySelectorAll('.scene-entry').forEach(button => button.classList.remove('selected'));
    renderSceneList(); drawScene();
  }
}

function drawReaderLabels(ctx, originX, originY, width, height) {
  if (!state.readerMode || state.readerRoomName) return;
  const labels = state.readerAreaKey
    ? state.readerDetailLabels
    : state.readerAreas.map(area => ({ text: area.name, position: area.widePosition, key: area.key }));
  const visibleBounds = state.readerAreaKey ? state.readerAreas.find(area => area.key === state.readerAreaKey)?.detailBounds : null;
  const unique = new Set();
  ctx.save();
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const label of labels) {
    if (state.readerAreaKey && visibleBounds && label.key !== state.readerAreaKey) continue;
    const text = String(label.text || '').trim();
    if (!text) continue;
    const position = label.position || { x: 0, y: 0 };
    const x = originX + position.x * state.scale, y = originY - position.y * state.scale;
    if (x < -75 || x > width + 75 || y < -24 || y > height + 24) continue;
    const key = `${text.toLowerCase()}|${Math.round(x)}|${Math.round(y)}`;
    if (unique.has(key)) continue;
    unique.add(key);
    const fontSize = Math.max(9, Math.min(15, state.scale * .22));
    ctx.font = `600 ${fontSize}px Georgia, serif`;
    ctx.lineWidth = Math.max(2, fontSize * .3); ctx.strokeStyle = 'rgba(16,18,15,.92)';
    ctx.fillStyle = '#d5d0a8'; ctx.shadowColor = '#0b0c0a'; ctx.shadowBlur = 5;
    ctx.strokeText(text, x, y); ctx.fillText(text, x, y);
  }
  ctx.restore();
}

function hitReaderArea(world) {
  const matches = state.readerAreas.map(area => {
    const b = area.wideBounds;
    const inside = b && world.x >= b.minX && world.x <= b.maxX && world.y >= b.minY && world.y <= b.maxY;
    const distance = Math.hypot(area.widePosition.x - world.x, area.widePosition.y - world.y);
    return { area, inside, distance };
  }).filter(match => match.inside || match.distance * state.scale < 18)
    .sort((a, b) => (a.inside === b.inside ? a.distance - b.distance : a.inside ? -1 : 1));
  return matches[0]?.area || null;
}

function hitReaderRoom(world) {
  const area = state.readerAreas.find(item => item.key === state.readerAreaKey);
  if (!area) return null;
  const matches = area.rooms.map(room => {
    const b = room.bounds;
    const inside = world.x >= b.minX && world.x <= b.maxX && world.y >= b.minY && world.y <= b.maxY;
    const distance = Math.hypot(room.center.x - world.x, room.center.y - world.y) * state.scale;
    return { room, inside, distance };
  }).filter(match => match.inside || match.distance < 12)
    .sort((a, b) => (a.inside === b.inside ? a.distance - b.distance : a.inside ? -1 : 1));
  return matches[0]?.room || null;
}

function resolveScene(requestedName) {
  const requested = requestedName.replace(/\.bundle$/i, '').trim();
  const exact = state.scenes.find(scene => scene.candidateName.toLowerCase() === requested.toLowerCase());
  if (exact) return exact;
  const similar = state.scenes.filter(scene => scene.candidateName.toLowerCase().includes(requested.toLowerCase()));
  return similar.length === 1 ? similar[0] : null;
}

async function openScene(name) {
  const entry = resolveScene(name);
  if (!entry) { showToast(`Could not resolve “${name}” to one room bundle.`); return; }
  byId('emptyCanvas').classList.add('hidden');
  if (state.readerMode && state.readerRoomName) document.body.classList.add('reader-room-mode');
  byId('viewStatus').textContent = 'READING UNITY OBJECTS';
  byId('objectTree').innerHTML = '<div class="empty-state tree-empty">Reading serialized scene objects…</div>';
  byId('canvasShell').classList.add('is-loading');
  byId('exportButton').disabled = true;
  byId('mapDataButton').disabled = true;
  try {
    state.scene = await getJson(`/api/scenes/${encodeURIComponent(entry.candidateName)}`);
    state.readerVisibleObjects = null;
    state.architectPreviewName = null;
    state.architectSelectedMarkerId = null;
    state.architectSelectedWaveKey = null;
    state.architectWaveFilterKeys = null;
    state.architectChangesVisible = false;
    state.architectActiveEvents = new Set();
    state.architectPlacementVisibility = new Map();
    state.architectWaveEnemyVisibility = new Map();
    state.meshAssets = new Map((state.scene.meshAssets || []).map(mesh => [mesh.id, mesh]));
    state.tintedSpriteImages.clear();
    state.gradePreviewObjectId = null; state.gradePreviewFactor = 1;
    byId('lightingPreviewStrength').value = '0'; byId('lightingPreviewValue').value = '—';
    state.hiddenSortingLayers = new Set((state.scene.objects || []).flatMap(object => [
      ...(object.sprites || []), ...(object.meshes || []), ...(object.sortingGroup?.enabled ? [object.sortingGroup] : [])
    ]).filter(artwork => artwork.sortingLayerKnown === false).map(artwork => Number(artwork.sortingLayerId) || 0));
    state.objectById = new Map((state.scene.objects || []).map(object => [object.id, object]));
    state.cameraLockAreas = [];
    state.cameraLockIndex = -1;
    const stateIndex = buildObjectStateIndex(state.scene.objects || []);
    state.activationGroups = stateIndex.groups;
    state.stateOverrideCandidates = stateIndex.candidates;
    state.stateSearchIndex = stateIndex.searchable;
    state.objectVisibilityOverrides = new Map();
    for (const group of state.activationGroups) {
      const normalWorld = group.options.find(option => option.name.trim().toLowerCase() === 'normal world');
      if (normalWorld) setGroupOverride(group, normalWorld.id);
    }
    renderSortingLayerFilters();
    renderActivationFilters();
    renderLightingStateFilters();
    state.selected = null;
    byId('selectionContent').textContent = 'Click an object in the tree or on the map.';
    state.fitBounds = null;
    state.gameView = false;
    byId('canvasShell').classList.remove('wide-preview');
    byId('fitZonesButton').classList.remove('active');
    state.fitted = false;
    state.centerX = 0; state.centerY = 0; state.scale = 1;
    const label = state.scene.sceneName || entry.candidateName;
    byId('currentSceneTitle').textContent = label;
    byId('sceneKind').textContent = kindLabel(entry.kind);
    byId('viewStatus').textContent = state.scene.objects?.length ? 'OBJECT LAYOUT' : 'BUNDLE INSPECTED';
    byId('detailSceneName').textContent = label;
    byId('detailObjects').textContent = (state.scene.objects?.length || 0).toLocaleString();
    byId('detailBundle').textContent = entry.bundleFile.split(/[\\/]/).pop();
    byId('detailBounds').textContent = sceneBounds(state.scene.objects || []);
    const spriteCount = (state.scene.objects || []).flatMap(object => object.sprites || []).filter(sprite => sprite.imageUrl).length;
    if (spriteCount) byId('viewStatus').textContent = `ROOM ARTWORK · ${spriteCount.toLocaleString()} SPRITES`;
    byId('objectCount').textContent = `${(state.scene.objects?.length || 0).toLocaleString()} OBJECTS · ${spriteCount.toLocaleString()} SPRITES`;
    byId('treeCount').textContent = (state.scene.objects?.length || 0).toLocaleString();
    byId('sceneList').querySelectorAll('.scene-entry').forEach(button => button.classList.toggle('selected', button.dataset.name === entry.candidateName));
    renderObjectTree();
    renderCapturePanel();
    renderArchitectPanel();
    drawScene();
    byId('exportButton').disabled = !state.scene.objects?.length;
    byId('mapDataButton').disabled = !state.scene.objects?.length;
    refreshCameraLockAreas();
    if (state.scene.diagnostics?.length) showToast(`Room read with ${state.scene.diagnostics.length} extraction notes.`);
  } catch (error) {
    state.scene = null;
    renderCapturePanel();
    byId('viewStatus').textContent = 'BUNDLE COULD NOT BE READ';
    byId('objectTree').innerHTML = `<div class="empty-state tree-empty">${escapeHtml(error.message)}</div>`;
    byId('detailSceneName').textContent = 'Scene extraction failed';
    if (state.readerMode && state.readerAreaKey) {
      state.readerRoomName = null;
      document.body.classList.remove('reader-room-mode');
      applyReaderMapLayers();
      const area = state.readerAreas.find(item => item.key === state.readerAreaKey);
      if (area) showReaderMapBranch(state.readerDetailObjects, area.detailBounds, area.name, `AREA DETAIL · ${area.key} · ${area.rooms.length} ROOMS`);
    }
    showToast(error.message);
    drawScene();
  } finally {
    byId('canvasShell').classList.remove('is-loading');
    if (state.readerMode) renderReaderNavigation(); else renderSceneList();
  }
}

function sceneBounds(objects) {
  if (!objects.length) return 'not available';
  const mapPoints = [...objects.map(object => object.worldPosition || { x: 0, y: 0 }), ...objects.flatMap(object => (object.colliders || []).flatMap(collider => collider.worldPoints || []))];
  const xs = mapPoints.map(point => point.x ?? 0), ys = mapPoints.map(point => point.y ?? 0);
  const x = Math.max(...xs) - Math.min(...xs), y = Math.max(...ys) - Math.min(...ys);
  return `${x.toFixed(1)} × ${y.toFixed(1)} units`;
}

function renderObjectTree() {
  const all = state.scene?.objects || [], query = byId('objectSearch').value.trim().toLowerCase();
  const filtered = query ? all.filter(object => object.name.toLowerCase().includes(query) || componentsOf(object).some(component => component.type.toLowerCase().includes(query))) : all.slice(0, 600);
  if (!all.length) { byId('objectTree').innerHTML = '<div class="empty-state tree-empty">No object records were found.</div>'; return; }
  if (!filtered.length) { byId('objectTree').innerHTML = '<div class="empty-state tree-empty">No objects match this filter.</div>'; return; }
  const idToObject = new Map(all.map(object => [object.id, object]));
  const visibleIds = new Set(filtered.map(object => object.id));
  byId('objectTree').innerHTML = filtered.map(object => {
    const hasParent = object.parentId && idToObject.has(object.parentId);
    const depth = hasParent ? Math.min(3, parentDepth(object, idToObject)) : 0;
    const symbols = classifyObject(object);
    const marker = symbols.enemy ? '<span style="color:#df7569">●</span>' : symbols.spawn ? '<span style="color:#e8b75c">◇</span>' : symbols.check ? '<span style="color:#80c9b7">◆</span>' : '<span class="tree-bullet">◦</span>';
    return `<button class="tree-row ${state.selected?.id === object.id ? 'active' : ''}" style="padding-left:${4 + depth * 12}px" title="${escapeHtml(object.name)}" data-id="${escapeHtml(object.id)}">${marker}<span class="tree-name">${escapeHtml(object.name || '(unnamed)')}</span></button>`;
  }).join('') + (filtered.length < all.length ? `<div class="empty-state tree-empty">Showing ${filtered.length} of ${all.length.toLocaleString()}. Search to filter.</div>` : '');
  byId('objectTree').querySelectorAll('.tree-row').forEach(button => button.addEventListener('click', () => selectObject(idToObject.get(button.dataset.id))));
  function parentDepth(object, objectsById) { let depth = 0, parent = object; const seen = new Set([object.id]); while (parent.parentId && objectsById.has(parent.parentId) && depth < 10) { parent = objectsById.get(parent.parentId); if (seen.has(parent.id)) break; seen.add(parent.id); depth++; } return depth; }
  void visibleIds;
}

function classifyObject(object) {
  const enemy = matchComponents(object, componentTerms.enemy);
  const spawn = matchComponents(object, componentTerms.spawn);
  const check = matchComponents(object, componentTerms.check);
  return { enemy, spawn, check };
}

function isGameBundleTexture(url) {
  // The artwork endpoint only serves PNGs decoded from Silksong asset bundles.
  // This deliberately excludes generated previews, external images, and capture
  // object URLs from the clean room-art export path.
  return typeof url === 'string' && /^\/api\/artwork\/[a-f0-9]{64}\.png$/i.test(url);
}

function objectIsActive(object) {
  let current = object;
  const seen = new Set();
  const chain = [];
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current);
    current = state.objectById.get(current.parentId);
  }
  let active = true;
  for (const item of chain.reverse()) {
    const override = state.objectVisibilityOverrides.get(item.id);
    if (override === 'show') active = true;
    else if (override === 'hide') active = false;
    else active = active && (item.active ?? true);
  }
  return active;
}

function manualVisibilityFor(object) {
  let current = object;
  const seen = new Set();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    const override = state.objectVisibilityOverrides.get(current.id);
    if (override) return override;
    current = state.objectById.get(current.parentId);
  }
  return 'auto';
}

function buildObjectStateIndex(objects) {
  const byId = new Map(objects.map(object => [object.id, object]));
  const children = new Map();
  for (const object of objects) {
    const siblings = children.get(object.parentId) || [];
    siblings.push(object); children.set(object.parentId, siblings);
  }
  const spriteCounts = new Map();
  function subtreeSpriteCount(object, path = new Set()) {
    if (spriteCounts.has(object.id)) return spriteCounts.get(object.id);
    if (path.has(object.id)) return 0;
    const nextPath = new Set(path); nextPath.add(object.id);
    let total = (object.sprites || []).filter(sprite => sprite.imageUrl).length;
    for (const child of children.get(object.id) || []) total += subtreeSpriteCount(child, nextPath);
    spriteCounts.set(object.id, total);
    return total;
  }
  for (const object of objects) subtreeSpriteCount(object);
  const options = objects.filter(object => !object.active && subtreeSpriteCount(object) >= 20);
  const grouped = new Map();
  for (const option of options) {
    const key = option.parentId || '__root__';
    const group = grouped.get(key) || { parentName: byId.get(option.parentId)?.name || 'Other scene states', options: [] };
    group.options.push({ id: option.id, name: option.name, spriteCount: spriteCounts.get(option.id) || 0 });
    grouped.set(key, group);
  }
  const groups = [...grouped.entries()].map(([key, group]) => ({ key, ...group })).filter(group =>
    group.options.length > 1 && /state|world|variant|phase|act/i.test(`${group.parentName} ${group.options.map(option => option.name).join(' ')}`));
  const stateTerms = /event|condition|quest|door|destroy|repair|complete|check|active|activat|normal world|black thread|intro|pre.?cleanup|post.?cleanup|before|after|lit|dark|broken|phase|act[123]/i;
  const pathById = new Map();
  function objectPath(object) {
    if (pathById.has(object.id)) return pathById.get(object.id);
    const names = [object.name || '(unnamed)'];
    let parent = byId.get(object.parentId), depth = 0;
    while (parent && depth++ < 12) { names.unshift(parent.name || '(unnamed)'); parent = byId.get(parent.parentId); }
    const path = names.join(' / '); pathById.set(object.id, path); return path;
  }
  const searchable = objects.map(object => {
    const componentNames = componentsOf(object).map(component => component.scriptName || component.type).join(' ');
    const path = objectPath(object);
    return { object, path, spriteCount: spriteCounts.get(object.id) || 0,
      searchText: `${path} ${componentNames}`.toLowerCase(), likelyState: stateTerms.test(`${object.name || ''} ${componentNames}`) };
  });
  const candidates = searchable.filter(item => item.spriteCount > 0 && (!item.object.active || item.likelyState))
    .sort((a, b) => Number(a.object.active) - Number(b.object.active) || Number(b.likelyState) - Number(a.likelyState) || b.spriteCount - a.spriteCount || a.path.localeCompare(b.path));
  return { groups, candidates, searchable };
}

function renderActivationFilters() {
  const root = byId('activationVariantFilters');
  if (!root) return;
  root.innerHTML = state.activationGroups.length ? state.activationGroups.map((group, index) => {
    const options = group.options.map(option => `<label class="filter-check activation-check"><input type="radio" name="activation-${index}" data-activation-group="${index}" value="${escapeHtml(option.id)}" ${state.objectVisibilityOverrides.get(option.id) === 'show' ? 'checked' : ''}><span>${escapeHtml(option.name)} <small>${option.spriteCount.toLocaleString()} sprites</small></span></label>`).join('');
    const noneSelected = !group.options.some(option => state.objectVisibilityOverrides.get(option.id) === 'show');
    return `<fieldset class="activation-group"><legend>${escapeHtml(group.parentName)}</legend><label class="filter-check activation-check"><input type="radio" name="activation-${index}" data-activation-group="${index}" value="" ${noneSelected ? 'checked' : ''}><span>Use serialized state</span></label>${options}</fieldset>`;
  }).join('') : '<span class="filter-empty">No clearly named sibling state sets found; use the object search below.</span>';
  const stateSetCount = byId('stateSetCount');
  if (stateSetCount) stateSetCount.textContent = state.activationGroups.length ? `${state.activationGroups.length} sets` : '';
  root.querySelectorAll('[data-activation-group]').forEach(input => input.addEventListener('change', () => {
    if (!input.checked) return;
    const group = state.activationGroups[Number(input.dataset.activationGroup)];
    setGroupOverride(group, input.value || null);
    refreshCameraLockAreas();
    renderActivationFilters();
    drawScene();
  }));
  renderStateOverrideRows();
}

function setGroupOverride(group, selectedId) {
  for (const option of group.options) {
    if (!selectedId) state.objectVisibilityOverrides.delete(option.id);
    else state.objectVisibilityOverrides.set(option.id, option.id === selectedId ? 'show' : 'hide');
  }
}

function setObjectVisibilityOverride(id, value) {
  if (value === 'auto') { state.objectVisibilityOverrides.delete(id); return; }
  const group = value === 'show' ? state.activationGroups.find(item => item.options.some(option => option.id === id)) : null;
  if (group) setGroupOverride(group, id);
  else state.objectVisibilityOverrides.set(id, value);
}

function renderStateOverrideRows() {
  const root = byId('stateOverrideRows');
  if (!root) return;
  const query = byId('stateOverrideSearch')?.value.trim().toLowerCase() || '';
  const all = state.stateOverrideCandidates || [];
  const matches = query
    ? (state.stateSearchIndex || []).filter(item => item.searchText.includes(query)).sort((a, b) =>
      Number((b.object.name || '').toLowerCase().includes(query)) - Number((a.object.name || '').toLowerCase().includes(query)) ||
      Number(b.likelyState) - Number(a.likelyState) || b.spriteCount - a.spriteCount || a.path.localeCompare(b.path))
    : all;
  const visible = matches.slice(0, query ? 75 : 32);
  if (!visible.length) {
    root.innerHTML = `<span class="filter-empty">${query ? 'No objects match that search.' : 'No likely conditional objects in this room.'}</span>`;
    return;
  }
  root.innerHTML = visible.map(item => {
    const object = item.object, override = state.objectVisibilityOverrides.get(object.id) || 'auto';
    const status = object.active ? 'serialized active' : 'serialized inactive';
    return `<div class="state-override-row"><div class="state-override-copy"><strong title="${escapeHtml(item.path)}">${escapeHtml(object.name || '(unnamed)')}</strong><small title="${escapeHtml(item.path)}">${status} · ${item.spriteCount.toLocaleString()} sprites below</small></div><select aria-label="Render override for ${escapeHtml(object.name || 'unnamed object')}" data-visibility-override="${escapeHtml(object.id)}"><option value="auto" ${override === 'auto' ? 'selected' : ''}>Auto</option><option value="show" ${override === 'show' ? 'selected' : ''}>Show</option><option value="hide" ${override === 'hide' ? 'selected' : ''}>Hide</option></select></div>`;
  }).join('') + (matches.length > visible.length ? `<span class="filter-empty">Showing ${visible.length} of ${matches.length.toLocaleString()} matches.</span>` : '');
  root.querySelectorAll('[data-visibility-override]').forEach(select => select.addEventListener('change', () => {
    const id = select.dataset.visibilityOverride;
    setObjectVisibilityOverride(id, select.value);
    refreshCameraLockAreas();
    drawScene();
    if (state.selected?.id === id) selectObject(state.selected);
  }));
}

function spritePassesFilters(object, sprite, includeScreenEffects = false, gameArtworkOnly = false) {
  if (sprite.blendMode === 'destination' || manualVisibilityFor(object) === 'hide') return false;
  if (gameArtworkOnly) {
    if (object.sortingGroup?.enabled && object.sortingGroup.sortingLayerKnown === false) return false;
    if (sprite.sortingLayerKnown === false || !objectIsActive(object) || sprite.rendererEnabled === false) return false;
    if (!includeScreenEffects && isScreenEffect(object, sprite)) return false;
    return Boolean(isGameBundleTexture(sprite.imageUrl) && sprite.rectWidth && sprite.rectHeight);
  }
  if (object.sortingGroup?.enabled && state.hiddenSortingLayers.has(Number(object.sortingGroup.sortingLayerId) || 0)) return false;
  if (!byId('layerLighting').checked && isLightingArtwork(object, sprite)) return false;
  if (!byId('layerBackground').checked && isBackgroundArtwork(object, sprite)) return false;
  if (!objectIsActive(object) && !byId('includeInactiveSprites').checked) return false;
  if (sprite.rendererEnabled === false && !byId('includeDisabledSprites').checked) return false;
  if (state.hiddenSortingLayers.has(Number(sprite.sortingLayerId) || 0)) return false;
  if (!includeScreenEffects && isScreenEffect(object, sprite)) return false;
  const excludedNames = byId('spriteNameExclude').value.split(',').map(name => name.trim().toLowerCase()).filter(Boolean);
  const searchableName = `${object.name || ''} ${sprite.name || ''}`.toLowerCase();
  if (excludedNames.some(name => searchableName.includes(name))) return false;
  return Boolean(sprite.imageUrl && sprite.rectWidth && sprite.rectHeight);
}

function visibleSpriteBounds(objects, includeScreenEffects = byId('layerEffects').checked, gameArtworkOnly = false) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const object of objects) for (const sprite of object.sprites || []) {
    if (!spritePassesFilters(object, sprite, includeScreenEffects, gameArtworkOnly)) continue;
    const geometry = spriteLocalGeometry(sprite);
    const x = object.worldPosition?.x || 0, y = object.worldPosition?.y || 0;
    const matrix = spriteWorldMatrix(sprite);
    for (const [localX, localY] of [[geometry.left, geometry.bottom], [geometry.right, geometry.bottom], [geometry.left, geometry.top], [geometry.right, geometry.top]]) {
      const worldX = x + matrix.m00 * localX + matrix.m01 * localY;
      const worldY = y + matrix.m10 * localX + matrix.m11 * localY;
      minX = Math.min(minX, worldX); maxX = Math.max(maxX, worldX);
      minY = Math.min(minY, worldY); maxY = Math.max(maxY, worldY);
    }
  }
  for (const object of objects) for (const mesh of object.meshes || []) {
    if (!meshPassesFilters(object, mesh, includeScreenEffects, gameArtworkOnly)) continue;
    const asset = state.meshAssets.get(mesh.meshAssetId), vertices = asset?.vertices || [];
    const matrix = { m00: mesh.worldM00 ?? 1, m01: mesh.worldM01 ?? 0, m10: mesh.worldM10 ?? 0, m11: mesh.worldM11 ?? 1 };
    const point = object.worldPosition || { x: 0, y: 0 };
    for (const vertex of vertices) {
      const worldX = point.x + matrix.m00 * vertex.x + matrix.m01 * vertex.y;
      const worldY = point.y + matrix.m10 * vertex.x + matrix.m11 * vertex.y;
      minX = Math.min(minX, worldX); maxX = Math.max(maxX, worldX);
      minY = Math.min(minY, worldY); maxY = Math.max(maxY, worldY);
    }
  }
  return Number.isFinite(minX) ? { minX, maxX, minY, maxY } : null;
}

function meshPassesFilters(object, mesh, includeScreenEffects = false, gameArtworkOnly = false) {
  if (!mesh.imageUrl || mesh.blendMode === 'destination' || manualVisibilityFor(object) === 'hide') return false;
  if (gameArtworkOnly) {
    if (object.sortingGroup?.enabled && object.sortingGroup.sortingLayerKnown === false) return false;
    if (mesh.sortingLayerKnown === false || !objectIsActive(object) || mesh.rendererEnabled === false) return false;
    return isGameBundleTexture(mesh.imageUrl) && (includeScreenEffects || !isScreenEffect(object, { name: mesh.materialName }));
  }
  if (object.sortingGroup?.enabled && state.hiddenSortingLayers.has(Number(object.sortingGroup.sortingLayerId) || 0)) return false;
  if (!byId('layerLighting').checked && isLightingArtwork(object, { name: mesh.materialName })) return false;
  if (!byId('layerBackground').checked && isBackgroundArtwork(object, { name: mesh.materialName })) return false;
  if (!objectIsActive(object) && !byId('includeInactiveSprites').checked) return false;
  if (mesh.rendererEnabled === false && !byId('includeDisabledSprites').checked) return false;
  if (state.hiddenSortingLayers.has(Number(mesh.sortingLayerId) || 0)) return false;
  return includeScreenEffects || !isScreenEffect(object, { name: mesh.materialName });
}

function nativeArtworkPixelsPerUnit(objects, includeScreenEffects = false) {
  let density = 1;
  for (const object of objects) {
    for (const sprite of object.sprites || []) {
      if (!spritePassesFilters(object, sprite, includeScreenEffects, true)) continue;
      const matrix = spriteWorldMatrix(sprite);
      const scaleX = Math.hypot(matrix.m00, matrix.m10), scaleY = Math.hypot(matrix.m01, matrix.m11);
      const ppu = Math.max(1, Number(sprite.pixelsPerUnit) || 100);
      density = Math.max(density, ppu / Math.max(.0001, Math.min(scaleX || 1, scaleY || 1)));
    }
    for (const mesh of object.meshes || []) {
      if (!meshPassesFilters(object, mesh, includeScreenEffects, true)) continue;
      const asset = state.meshAssets.get(mesh.meshAssetId), submesh = asset?.submeshes?.[mesh.submeshIndex];
      if (!asset || submesh?.topology !== 0) continue;
      const indices = submesh.indices || [], vertices = asset.vertices || [], matrix = {
        m00: mesh.worldM00 ?? 1, m01: mesh.worldM01 ?? 0, m10: mesh.worldM10 ?? 0, m11: mesh.worldM11 ?? 1
      };
      const point = object.worldPosition || { x: 0, y: 0 }, points = [];
      for (const index of indices) {
        const vertex = vertices[index];
        if (!vertex) continue;
        points.push({
          x: point.x + matrix.m00 * vertex.x + matrix.m01 * vertex.y,
          y: point.y + matrix.m10 * vertex.x + matrix.m11 * vertex.y,
          u: (vertex.u * (mesh.textureScaleX ?? 1) + (mesh.textureOffsetX || 0)) * (mesh.textureWidth || 1),
          v: (vertex.v * (mesh.textureScaleY ?? 1) + (mesh.textureOffsetY || 0)) * (mesh.textureHeight || 1)
        });
      }
      if (points.length < 3) continue;
      const limits = { x: [Infinity, -Infinity], y: [Infinity, -Infinity], u: [Infinity, -Infinity], v: [Infinity, -Infinity] };
      for (const vertex of points) for (const axis of ['x', 'y', 'u', 'v']) {
        limits[axis][0] = Math.min(limits[axis][0], vertex[axis]); limits[axis][1] = Math.max(limits[axis][1], vertex[axis]);
      }
      const worldWidth = limits.x[1] - limits.x[0], worldHeight = limits.y[1] - limits.y[0];
      if (worldWidth > 0 && worldHeight > 0) density = Math.max(density,
        (limits.u[1] - limits.u[0]) / worldWidth, (limits.v[1] - limits.v[0]) / worldHeight);
    }
  }
  return Number.isFinite(density) ? density : 100;
}

function spriteLocalGeometry(sprite, scale = 1) {
  const ppu = Math.max(1, sprite.pixelsPerUnit || 100), rotated = sprite.packingRotation === 4;
  const width = (rotated ? sprite.rectHeight : sprite.rectWidth) / ppu * scale;
  const height = (rotated ? sprite.rectWidth : sprite.rectHeight) / ppu * scale;
  const originalWidth = (sprite.originalWidth || sprite.rectWidth) / ppu * scale;
  const originalHeight = (sprite.originalHeight || sprite.rectHeight) / ppu * scale;
  const left = (sprite.trimOffsetX || 0) / ppu * scale - (sprite.pivotX ?? .5) * originalWidth;
  // Unity's trim offset is measured up from the original sprite's bottom edge.
  const bottom = (sprite.trimOffsetY || 0) / ppu * scale - (sprite.pivotY ?? .5) * originalHeight;
  return { left, right: left + width, bottom, top: bottom + height, width, height };
}

function spriteWorldMatrix(sprite) {
  if ([sprite.worldM00, sprite.worldM01, sprite.worldM10, sprite.worldM11].every(Number.isFinite))
    return { m00: sprite.worldM00, m01: sprite.worldM01, m10: sprite.worldM10, m11: sprite.worldM11 };
  const angle = sprite.worldRotationZ || 0, cosine = Math.cos(angle), sine = Math.sin(angle);
  const sx = sprite.worldScaleX ?? 1, sy = sprite.worldScaleY ?? 1;
  return { m00: cosine * sx, m01: -sine * sy, m10: sine * sx, m11: cosine * sy };
}

function objectBounds(objects) {
  const points = [...objects.map(object => object.worldPosition || { x: 0, y: 0 }), ...objects.flatMap(object => (object.colliders || []).flatMap(collider => collider.worldPoints || []))];
  if (!points.length) return null;
  return { minX: Math.min(...points.map(point => point.x ?? 0)), maxX: Math.max(...points.map(point => point.x ?? 0)),
    minY: Math.min(...points.map(point => point.y ?? 0)), maxY: Math.max(...points.map(point => point.y ?? 0)) };
}

function cameraLockAreas(objects) {
  const areas = [];
  for (const object of objects) {
    if (!objectIsActive(object) || !/camera.?lock|cam.?lock/i.test(object.name || '')) continue;
    const points = [];
    for (const collider of object.colliders || []) {
      if (collider.enabled === false || !['BoxCollider2D', 'PolygonCollider2D'].includes(collider.type)) continue;
      points.push(...(collider.worldPoints || []));
    }
    if (points.length < 3) continue;
    const minX = Math.min(...points.map(point => point.x)), maxX = Math.max(...points.map(point => point.x));
    const minY = Math.min(...points.map(point => point.y)), maxY = Math.max(...points.map(point => point.y));
    if (maxX <= minX || maxY <= minY) continue;
    areas.push({ id: object.id, name: object.name || 'CameraLockArea', centerX: (minX + maxX) / 2,
      centerY: (minY + maxY) / 2, bounds: { minX, maxX, minY, maxY } });
  }
  return areas.sort((a, b) => a.centerX - b.centerX || b.centerY - a.centerY || a.name.localeCompare(b.name));
}

function captureCameraRecord(capture) {
  const cameras = (capture?.manifest?.cameras || []).filter(camera => camera && camera.enabled !== false && camera.orthographic &&
    Number(camera.pixelRect?.width) > 0 && Number(camera.pixelRect?.height) > 0 && Number(camera.orthographicSize) > 0);
  return cameras.sort((a, b) => {
    const areaA = Number(a.pixelRect.width) * Number(a.pixelRect.height), areaB = Number(b.pixelRect.width) * Number(b.pixelRect.height);
    const mainA = /main.?camera/i.test(a.name || '') ? 1 : 0, mainB = /main.?camera/i.test(b.name || '') ? 1 : 0;
    return mainB - mainA || areaB - areaA || Math.abs(Number(a.depth) || 0) - Math.abs(Number(b.depth) || 0);
  })[0] || null;
}

function capturesForCurrentScene() {
  if (state.architectPreviewName || !state.scene?.sceneName) return [];
  return state.gameCaptures.get(normalizeArchitectSceneName(state.scene.sceneName)) || [];
}

function captureViewLabel(capture) {
  const camera = captureCameraRecord(capture), timestamp = Date.parse(capture.manifest.capturedAtUtc);
  const when = Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : capture.manifest.capturedAtUtc || capture.fileName;
  return `${when} · ${camera?.name || 'camera'} · ${capture.manifest.screenWidth}×${capture.manifest.screenHeight}`;
}

function renderCapturePanel() {
  const captures = capturesForCurrentScene(), scenesCount = state.gameCaptures.size;
  byId('captureSceneCount').textContent = captures.length ? `${captures.length} views` : scenesCount ? 'no room match' : 'not loaded';
  byId('captureFolderStatus').textContent = scenesCount
    ? `${state.gameCaptureSource} · ${[...state.gameCaptures.values()].reduce((sum, room) => sum + room.length, 0)} capture frames across ${scenesCount} rooms${captures.length ? ` · ${captures.length} for this room` : ''}`
    : 'Use the optional F9 capture mod to import real game frames and camera data.';
  const useCapture = byId('useGameCaptures');
  useCapture.disabled = captures.length === 0;
  if (!captures.length) state.gameCapturesEnabled = false;
  useCapture.checked = state.gameCapturesEnabled;
  const select = byId('captureViewSelect');
  select.innerHTML = `<option value="latest">Latest single frame</option><option value="all">Composite all ${captures.length} views</option>` + captures.map((capture, index) =>
    `<option value="${escapeHtml(capture.id)}">${escapeHtml(captureViewLabel(capture))}</option>`).join('');
  select.disabled = captures.length < 2;
  if (!['all', 'latest'].includes(state.gameCaptureView) && !captures.some(capture => capture.id === state.gameCaptureView)) state.gameCaptureView = 'latest';
  select.value = state.gameCaptureView;
}

async function importCaptureFolder(fileList) {
  const files = [...fileList], imageFiles = new Map(), manifestFiles = [];
  if (files.length > 10000) throw new Error('This folder contains more than 10,000 files; select the capture output folder directly.');
  for (const file of files) {
    const relative = String(file.webkitRelativePath || file.name).replace(/\\/g, '/');
    const base = relative.split('/').pop().toLowerCase();
    if (base.endsWith('.png')) {
      if (!imageFiles.has(base)) imageFiles.set(base, []);
      imageFiles.get(base).push({ file, relative });
    } else if (base.endsWith('.json') && !base.endsWith('.architect.json')) manifestFiles.push({ file, relative });
  }
  if (!manifestFiles.length || !imageFiles.size) throw new Error('No paired game-capture JSON manifests and PNG frames found.');
  if (manifestFiles.length > 1000) throw new Error('This folder contains more than 1,000 capture manifests; select a smaller capture folder.');
  const captures = new Map(); let skipped = 0, read = 0;
  for (let index = 0; index < manifestFiles.length; index++) {
    const { file, relative } = manifestFiles[index];
    if (file.size > 32 * 1024 * 1024) { skipped++; continue; }
    try {
      const manifest = JSON.parse(await file.text());
      if (manifest?.schemaVersion !== 1 || !manifest.activeScene || !Array.isArray(manifest.cameras)) { skipped++; continue; }
      const screenshotName = String(manifest.screenshotFile || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
      const matches = imageFiles.get(screenshotName) || [];
      const manifestDirectory = relative.slice(0, relative.lastIndexOf('/') + 1).toLowerCase();
      const paired = matches.find(item => item.relative.toLowerCase().startsWith(manifestDirectory)) || matches[0];
      const camera = captureCameraRecord({ manifest });
      const screenWidth = Number(manifest.screenWidth), screenHeight = Number(manifest.screenHeight), rect = camera?.pixelRect;
      const rectValues = rect ? [rect.x, rect.y, rect.width, rect.height].map(Number) : [];
      if (!paired || paired.file.size > 128 * 1024 * 1024 || !camera || !(screenWidth > 0 && screenHeight > 0) ||
          rectValues.length !== 4 || !rectValues.every(Number.isFinite) || rectValues[0] < 0 || rectValues[1] < 0 ||
          rectValues[0] + rectValues[2] > screenWidth + 1 || rectValues[1] + rectValues[3] > screenHeight + 1) { skipped++; continue; }
      const sceneKey = normalizeArchitectSceneName(manifest.activeScene);
      const compactManifest = { schemaVersion: 1, activeScene: manifest.activeScene,
        capturedAtUtc: String(manifest.capturedAtUtc || ''), screenshotFile: manifest.screenshotFile,
        screenWidth, screenHeight, cameras: [camera] };
      const capture = { id: `${sceneKey}:${manifest.capturedAtUtc || file.name}:${index}`, manifest: compactManifest, imageFile: paired.file, fileName: file.name, image: null, imageUrl: null };
      if (!captures.has(sceneKey)) captures.set(sceneKey, []);
      captures.get(sceneKey).push(capture); read++;
    } catch { skipped++; }
    if (index % 16 === 0 || index === manifestFiles.length - 1) {
      byId('captureFolderStatus').textContent = `Reading capture manifest ${index + 1} of ${manifestFiles.length}…`;
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  if (!read) throw new Error('No supported schema 1 captures with an orthographic camera were found.');
  for (const roomCaptures of captures.values()) roomCaptures.sort((a, b) => {
    const timeA = Date.parse(a.manifest.capturedAtUtc), timeB = Date.parse(b.manifest.capturedAtUtc);
    return (Number.isFinite(timeA) ? timeA : 0) - (Number.isFinite(timeB) ? timeB : 0) || a.fileName.localeCompare(b.fileName);
  });
  for (const url of state.gameCaptureObjectUrls) URL.revokeObjectURL(url);
  state.gameCaptureObjectUrls.clear(); state.gameCaptures = captures;
  state.gameCaptureSource = String(files[0]?.webkitRelativePath || files[0]?.name || 'capture folder').replace(/\\/g, '/').split('/')[0];
  state.gameCapturesEnabled = false; state.gameCaptureView = 'latest';
  renderCapturePanel(); drawScene();
  byId('captureFolderStatus').textContent = `${state.gameCaptureSource} · ${read} paired camera captures loaded${skipped ? ` · ${skipped} unsupported/unpaired files skipped` : ''}`;
}

function captureImage(capture) {
  if (!capture.image && !capture.imageFailed) {
    capture.imageUrl = URL.createObjectURL(capture.imageFile);
    state.gameCaptureObjectUrls.add(capture.imageUrl);
    capture.image = new Image(); capture.image.onload = drawScene;
    capture.image.onerror = () => { capture.image = null; capture.imageFailed = true; drawScene(); };
    capture.image.src = capture.imageUrl;
  }
  return capture.image || null;
}

function drawGameCaptures(ctx, sceneName, originX, originY, width, height, scale = state.scale, respectArtworkToggle = true) {
  if (!state.gameCapturesEnabled || (respectArtworkToggle && !byId('layerArtwork').checked)) return;
  let captures = capturesForCurrentScene();
  if (state.gameCaptureView === 'latest') captures = captures.slice(-1);
  else if (state.gameCaptureView !== 'all') captures = captures.filter(capture => capture.id === state.gameCaptureView);
  for (const capture of captures) {
    const image = captureImage(capture), camera = captureCameraRecord(capture);
    if (!image || !image.complete || !image.naturalWidth || !camera) continue;
    const rect = camera.pixelRect, manifest = capture.manifest;
    const screenWidth = Number(manifest.screenWidth) || image.naturalWidth, screenHeight = Number(manifest.screenHeight) || image.naturalHeight;
    const sourceScaleX = image.naturalWidth / screenWidth, sourceScaleY = image.naturalHeight / screenHeight;
    const sourceX = Number(rect.x) * sourceScaleX;
    const sourceY = (screenHeight - Number(rect.y) - Number(rect.height)) * sourceScaleY;
    const sourceWidth = Number(rect.width) * sourceScaleX, sourceHeight = Number(rect.height) * sourceScaleY;
    const orthographicSize = Number(camera.orthographicSize), aspect = Number(camera.aspect) || Number(rect.width) / Number(rect.height);
    const position = camera.position || {}, rotation = camera.rotation || { z: 0, w: 1 };
    if (![sourceX, sourceY, sourceWidth, sourceHeight, orthographicSize, aspect, Number(position.x), Number(position.y)].every(Number.isFinite) || sourceWidth <= 0 || sourceHeight <= 0) continue;
    if (Math.abs(Number(rotation.x) || 0) > .02 || Math.abs(Number(rotation.y) || 0) > .02) continue;
    const angle = 2 * Math.atan2(Number(rotation.z) || 0, Number(rotation.w) || 1), cosine = Math.cos(angle), sine = Math.sin(angle);
    const pixelsPerUnitX = sourceWidth / (2 * orthographicSize * aspect), pixelsPerUnitY = sourceHeight / (2 * orthographicSize);
    const a = cosine * scale / pixelsPerUnitX, b = -sine * scale / pixelsPerUnitX;
    const c = sine * scale / pixelsPerUnitY, d = cosine * scale / pixelsPerUnitY;
    const e = originX + Number(position.x) * scale - a * sourceWidth / 2 - c * sourceHeight / 2;
    const f = originY - Number(position.y) * scale - b * sourceWidth / 2 - d * sourceHeight / 2;
    ctx.save(); ctx.globalAlpha = 1; ctx.transform(a, b, c, d, e, f);
    ctx.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, sourceWidth, sourceHeight);
    ctx.restore();
  }
}

function cameraWorldBounds(capture) {
  const camera = captureCameraRecord(capture), position = camera?.position || {}, rotation = camera?.rotation || { z: 0, w: 1 };
  if (!camera || Math.abs(Number(rotation.x) || 0) > .02 || Math.abs(Number(rotation.y) || 0) > .02) return null;
  const halfWidth = Number(camera.orthographicSize) * (Number(camera.aspect) || Number(camera.pixelRect.width) / Number(camera.pixelRect.height));
  const halfHeight = Number(camera.orthographicSize), angle = 2 * Math.atan2(Number(rotation.z) || 0, Number(rotation.w) || 1);
  const cosine = Math.cos(angle), sine = Math.sin(angle), corners = [];
  for (const x of [-halfWidth, halfWidth]) for (const y of [-halfHeight, halfHeight]) corners.push({
    x: Number(position.x) + cosine * x - sine * y,
    y: Number(position.y) + sine * x + cosine * y
  });
  if (!corners.every(point => Number.isFinite(point.x) && Number.isFinite(point.y))) return null;
  return { minX: Math.min(...corners.map(point => point.x)), maxX: Math.max(...corners.map(point => point.x)),
    minY: Math.min(...corners.map(point => point.y)), maxY: Math.max(...corners.map(point => point.y)) };
}

function unionArtworkBounds(...bounds) {
  const valid = bounds.filter(Boolean);
  return valid.length ? {
    minX: Math.min(...valid.map(bound => bound.minX)), maxX: Math.max(...valid.map(bound => bound.maxX)),
    minY: Math.min(...valid.map(bound => bound.minY)), maxY: Math.max(...valid.map(bound => bound.maxY))
  } : null;
}

function capturePixelsPerUnit(capture) {
  const camera = captureCameraRecord(capture);
  if (!camera) return 0;
  const horizontal = Number(camera.pixelRect.width) / (2 * Number(camera.orthographicSize) * (Number(camera.aspect) || Number(camera.pixelRect.width) / Number(camera.pixelRect.height)));
  const vertical = Number(camera.pixelRect.height) / (2 * Number(camera.orthographicSize));
  return Number.isFinite(horizontal) && Number.isFinite(vertical) ? Math.max(horizontal, vertical) : 0;
}

function normalizeArchitectSceneName(value) {
  return String(value || '').replace(/\\/g, '/').split('/').pop().replace(/\.architect\.json$/i, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function architectSceneForCurrentRoom() {
  const name = state.architectPreviewName || state.scene?.sceneName;
  return name ? state.architectScenes.get(normalizeArchitectSceneName(name)) || null : null;
}

function architectPlacementPosition(record) {
  const point = record?.placement?.pos;
  return point && Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y))
    ? { x: Number(point.x), y: Number(point.y), z: Number(point.z) || 0 } : null;
}

function architectPlacementStartsActive(record) {
  const value = String(record?.config?.start_active ?? '').trim().toLowerCase();
  const ownActive = ['false', '0', 'off', 'no'].includes(value) ? false : true;
  return record?.inheritedStartActive !== false && ownActive;
}

function architectPlacementListeners(record) {
  return [
    ...(record?.inheritedListeners || []).map(listener => ({ ...listener, inherited: true })),
    ...(record?.listeners || []).map(listener => ({ ...listener, inherited: false }))
  ];
}

function architectPlacementIsActive(record) {
  let active = architectPlacementStartsActive(record);
  const selectedOrder = new Map([...state.architectActiveEvents].map((name, index) => [name, index]));
  const actions = architectPlacementListeners(record).map((listener, index) => ({ listener, index,
    selectedIndex: selectedOrder.get(listener.event), sequence: Number(listener.order) }))
    .filter(item => item.selectedIndex !== undefined)
    .sort((a, b) => {
      const aSequence = Number.isFinite(a.sequence) ? a.sequence : 0;
      const bSequence = Number.isFinite(b.sequence) ? b.sequence : 0;
      return aSequence - bSequence || a.selectedIndex - b.selectedIndex || a.index - b.index;
    });
  for (const { listener } of actions) {
    const action = String(listener.action || '').toLowerCase();
    if (['enable', 'show', 'activate'].includes(action)) active = true;
    else if (['disable', 'hide', 'deactivate'].includes(action)) active = false;
  }
  return active;
}

function architectPlacementIsVisible(sceneName, record) {
  const key = architectPlacementKey(sceneName, record);
  const waveOverrideKey = `${state.architectSelectedWaveKey || 'all'}|${key}`;
  if (state.architectWaveEnemyVisibility.has(waveOverrideKey)) return state.architectWaveEnemyVisibility.get(waveOverrideKey) !== false;
  if (state.architectPlacementVisibility.has(key)) return state.architectPlacementVisibility.get(key) !== false;
  if (state.architectWaveFilterKeys && !state.architectWaveFilterKeys.has(key)) return false;
  return architectPlacementIsActive(record);
}

function architectSceneEventGroups(scene) {
  if (!scene) return [];
  const groups = new Map();
  for (const record of architectScenePlacements(scene)) {
    if (record.controllerMarker || isArchitectGauntletMarker(record)) continue;
    const placementKey = architectPlacementKey(scene.name, record);
    for (const listener of architectPlacementListeners(record)) {
      const name = String(listener.event || '').trim();
      if (!name) continue;
      if (!groups.has(name)) groups.set(name, { name, placements: new Set(), actions: new Set() });
      const group = groups.get(name);
      group.placements.add(placementKey);
      if (listener.action) group.actions.add(String(listener.action));
    }
  }
  return [...groups.values()].map(group => ({ ...group, placementCount: group.placements.size,
    actionSummary: [...group.actions].sort().join(' / ') })).sort((a, b) => a.name.localeCompare(b.name));
}

function architectEventKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function architectWaveGroups(scene) {
  const groups = architectSceneEventGroups(scene);
  const groupsByName = new Map(groups.map(group => [group.name.toLowerCase(), group]));
  const enableAction = action => /^(?:enable|show|activate)$/i.test(String(action || ''));
  const disableAction = action => /^(?:disable|hide|deactivate)$/i.test(String(action || ''));
  const waves = [];
  for (const group of groups) {
    const start = /^(.+?)([_-]?)start$/i.exec(group.name);
    if (!start || ![...group.actions].some(enableAction)) continue;
    const end = groupsByName.get(`${start[1]}${start[2]}end`.toLowerCase());
    const pairedEnd = end && [...end.actions].some(disableAction) ? end : null;
    const placementKeys = new Set(group.placements);
    if (pairedEnd) for (const key of pairedEnd.placements) placementKeys.add(key);
    const label = start[1].replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
    waves.push({
      key: `event-phase:${architectEventKey(group.name)}`,
      label: label || group.name,
      startEvent: group.name,
      endEvent: pairedEnd?.name || null,
      placementKeys,
      enemyCount: 0
    });
  }
  return waves.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }) || a.startEvent.localeCompare(b.startEvent));
}

function architectWaveEnemyRecords(scene, waves, selectedWave = null) {
  if (!scene) return [];
  const records = architectScenePlacements(scene).filter(record => {
    const identity = `${record.placement?.id || ''} ${architectPlacementLabel(record)}`;
    if (record.controllerMarker || isArchitectGauntletMarker(record) || record.depth > 0 || /enemy[\s_-]*remover|enemy[\s_-]*clear/i.test(identity) || !architectPlacementIsEnemy(record)) return false;
    const key = architectPlacementKey(scene.name, record);
    if (!selectedWave) return true;
    const linkedWaves = waves.filter(wave => wave.placementKeys.has(key));
    return linkedWaves.length === 0 || linkedWaves.some(wave => wave.key === selectedWave.key);
  });
  return [...new Map(records.map(record => [architectPlacementKey(scene.name, record), record])).values()];
}

function setArchitectPlacementFamilyVisibility(scene, record, visible) {
  const rootKey = String(record.key || record.placement?.pid || record.index);
  for (const candidate of architectScenePlacements(scene)) {
    const candidateKey = String(candidate.key || candidate.placement?.pid || candidate.index);
    if (candidate === record || candidateKey === rootKey || candidate.rootKey === rootKey || candidateKey.startsWith(`${rootKey}/`)) {
      state.architectWaveEnemyVisibility.set(`${state.architectSelectedWaveKey || 'all'}|${architectPlacementKey(scene.name, candidate)}`, visible);
    }
  }
}

function isArchitectGauntletMarker(record) {
  const id = String(record?.placement?.id || '').toLowerCase();
  return id === 'prefab_aghcontrol' || /(?:gauntlet|arena)[_-]?(?:control|marker|entrance)/i.test(id);
}

function architectEventPhaseMarkerRecords(scene) {
  if (!scene) return [];
  const groups = architectSceneEventGroups(scene);
  const groupsByName = new Map(groups.map(group => [group.name.toLowerCase(), group]));
  const markers = [];
  for (const group of groups) {
    const start = /^(.+?)([_-]?)start$/i.exec(group.name);
    if (!start || ![...group.actions].some(action => /^(?:enable|show|activate)$/i.test(action))) continue;
    const endName = `${start[1]}${start[2]}end`.toLowerCase();
    const end = groupsByName.get(endName);
    if (!end || ![...end.actions].some(action => /^(?:disable|hide|deactivate)$/i.test(action))) continue;

    const records = new Map();
    for (const record of architectScenePlacements(scene)) {
      if (record.controllerMarker || isArchitectGauntletMarker(record)) continue;
      const hasStartAction = architectPlacementListeners(record).some(listener =>
        listener.event.toLowerCase() === group.name.toLowerCase() &&
        /^(?:enable|show|activate)$/i.test(listener.action));
      if (hasStartAction && architectPlacementPosition(record))
        records.set(architectPlacementKey(scene.name, record), record);
    }
    if (!records.size) continue;

    const points = [...records.values()].map(architectPlacementPosition);
    const stem = start[1].replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
    const eventKey = architectEventKey(group.name);
    markers.push({
      key: `event-phase:${eventKey}`,
      index: -1,
      placement: {
        id: 'architect_event_phase', pid: `event-phase-${eventKey}`,
        pos: {
          x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
          y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
          z: points.reduce((sum, point) => sum + point.z, 0) / points.length
        },
        flipped: false, rotation: 0, scale: 1, layer: 0
      },
      virtualEvent: group.name,
      virtualEndEvent: end.name,
      markerLabel: `Wave · ${stem}`,
      virtualWaveKey: `event-phase:${eventKey}`,
      markerPlacementCount: records.size
    });
  }
  return markers;
}

function architectMarkerRecords(scene) {
  if (!scene) return [];
  const explicit = architectScenePlacements(scene).filter(record =>
    isArchitectGauntletMarker(record) && architectPlacementPosition(record));
  return explicit.length ? explicit : architectEventPhaseMarkerRecords(scene);
}

function architectScenePlacements(scene) {
  return scene?.expandedPlacements || scene?.placements || [];
}

function architectPlacementKey(sceneName, record) {
  return `${normalizeArchitectSceneName(sceneName)}:${record.key || record.placement?.pid || record.index}`;
}

function architectSceneBounds(scene) {
  const positions = architectScenePlacements(scene).map(architectPlacementPosition).filter(Boolean);
  const cells = (scene?.tileCells || []).filter(cell => Number.isFinite(cell.x) && Number.isFinite(cell.y));
  const pointsX = [...positions.map(point => point.x), ...cells.map(cell => cell.x)];
  const pointsY = [...positions.map(point => point.y), ...cells.map(cell => cell.y)];
  if (!pointsX.length) return null;
  return {
    minX: Math.min(...pointsX), maxX: Math.max(...positions.map(point => point.x), ...cells.map(cell => cell.x + 1)),
    minY: Math.min(...pointsY), maxY: Math.max(...positions.map(point => point.y), ...cells.map(cell => cell.y + 1))
  };
}

function expandArchitectPrefabs(scene, prefabs) {
  const expanded = [];
  const visit = (record, rootKey, depth, stack, controllerMarker) => {
    if (depth >= 8) return;
    const prefabId = String(record?.placement?.id || '').toLowerCase();
    const prefab = prefabs.get(prefabId);
    if (!prefab || stack.has(prefabId)) return;
    const parent = architectPlacementPosition(record);
    if (!parent) return;
    const parentScaleValue = Number(record.placement.scale);
    const parentScale = Number.isFinite(parentScaleValue) ? parentScaleValue : 1;
    const parentRotation = Number(record.placement.rotation) || 0;
    const radians = parentRotation * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians);
    const nextStack = new Set(stack); nextStack.add(prefabId);
    for (const child of prefab.placements || []) {
      const local = architectPlacementPosition(child);
      if (!local) continue;
      let dx = local.x - 100, dy = local.y - 100;
      if (record.placement.flipped) dx = -dx;
      dx *= parentScale; dy *= parentScale;
      const childPlacement = {
        ...child.placement,
        pos: { x: parent.x + dx * cos - dy * sin, y: parent.y + dx * sin + dy * cos, z: parent.z + local.z * parentScale },
        scale: parentScale * (Number.isFinite(Number(child.placement.scale)) ? Number(child.placement.scale) : 1),
        rotation: parentRotation + (Number(child.placement.rotation) || 0)
      };
      const key = `${rootKey}/${child.placement?.pid || child.index}`;
      const expandedChild = { ...child, placement: childPlacement, key, depth: depth + 1, rootKey,
        parentLabel: architectPlacementLabel(record),
        inheritedListeners: [...(record.inheritedListeners || []), ...(record.listeners || [])],
        inheritedStartActive: architectPlacementStartsActive(record),
        controllerMarker: controllerMarker || isArchitectGauntletMarker(record) };
      expanded.push(expandedChild);
      visit(expandedChild, rootKey, depth + 1, nextStack, expandedChild.controllerMarker);
    }
  };
  for (const record of scene.placements || []) {
    const rootKey = record.key || record.placement?.pid || record.index;
    const controller = isArchitectGauntletMarker(record);
    record.key = rootKey; record.depth = 0; record.controllerMarker = controller;
    record.inheritedListeners = []; record.inheritedStartActive = true;
    expanded.push(record);
    visit(record, rootKey, 0, new Set(), controller);
  }
  scene.expandedPlacements = expanded;
}

function architectPlacementLabel(record) {
  if (record?.markerLabel) return record.markerLabel;
  return String(record?.placement?.id || 'Architect placement').replace(/^prefab_/i, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
}

function architectPlacementIsEnemy(record) {
  if (!record || record.controllerMarker || isArchitectGauntletMarker(record)) return false;
  const id = String(record.placement?.id || ''), normalized = id.replace(/^prefab_/i, '');
  if (/enemy[\s_-]?(?:remover|clear)/i.test(id)) return false;
  const config = record.config || {};
  const hasEnemySettings = Object.keys(config).some(key => /enemy_(?:hp|health|damage|spawn|stay_dead)/i.test(key));
  return hasEnemySettings || /^prefab_g[A-Z]/.test(id) ||
    /(?:enemy|boss|spitter|trapper|hunter|hulk|bellbearer|groveller|pouncer|envoy|reed|disciple|watcher|skarr|snipper|ductsucker|charger|gargant|drifter|juror|flintflameflyer|pilgrim_03)/i.test(normalized);
}

function architectPlacementColor(record) {
  if (architectPlacementIsEnemy(record)) return '#df7569';
  const id = String(record?.placement?.id || '');
  if (/(bench|quest|flea|shop|check|collect|interaction)/i.test(id)) return '#80c9b7';
  return '#bb9cef';
}

function normalizeArchitectEnemyId(value) {
  return String(value || '').replace(/^prefab_/i, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function architectPlacementHasEnemyChild(scene, record) {
  if (!scene || !record || Number(record.depth) !== 0) return false;
  const rootKey = record.rootKey || record.key || record.placement?.pid || record.index;
  return architectScenePlacements(scene).some(candidate => Number(candidate.depth) > 0 &&
    (candidate.rootKey === rootKey || candidate.rootKey === record.key) && architectPlacementIsEnemy(candidate));
}

function architectPlacementHasEnemyTextureAnchor(scene, record) {
  return architectPlacementIsEnemy(record) && !architectPlacementHasEnemyChild(scene, record);
}

function architectEnemyTextureRecords(scene) {
  const byId = new Map();
  for (const record of architectScenePlacements(scene)) {
    if (!architectPlacementHasEnemyTextureAnchor(scene, record) || !architectPlacementPosition(record)) continue;
    const id = String(record.placement?.id || '');
    const key = normalizeArchitectEnemyId(id);
    if (key && !byId.has(key)) byId.set(key, id);
  }
  return [...byId.values()];
}

function updateArchitectArtworkStatus(scene = architectSceneForCurrentRoom()) {
  const status = byId('architectArtworkStatus');
  if (!status) return;
  const ids = architectEnemyTextureRecords(scene), keys = ids.map(normalizeArchitectEnemyId);
  const matched = keys.filter(key => state.architectEnemyArt.has(key)).length;
  const pending = keys.filter(key => state.architectEnemyArtPendingIds?.has(key)).length;
  const lookedUp = keys.filter(key => state.architectEnemyArtRequested.has(key)).length;
  const assetCount = state.architectAssetFiles?.size || 0;
  status.hidden = !(state.architectSelectedMarkerId || state.architectPreviewName);
  if (pending) status.textContent = `Reading Silksong enemy prefab textures for ${pending} placement type${pending === 1 ? '' : 's'}…`;
  else if (state.architectEnemyArtError) status.textContent = `Enemy texture lookup failed: ${state.architectEnemyArtError}`;
  else if (ids.length && lookedUp) status.textContent = `${matched} of ${ids.length} enemy types matched to real Silksong journal-atlas sprites${matched < ids.length ? ` · ${ids.length - matched} keep position markers because no matching sprite was found` : ''}.`;
  else if (ids.length) status.textContent = `${ids.length} enemy types in this arena · matching Silksong journal-atlas sprites load when available.`;
  else status.textContent = 'No enemy-prefab placements in this selected overlay.';
  if (assetCount) status.textContent += ` ${assetCount} linked Architect image${assetCount === 1 ? '' : 's'} indexed from the selected mod folder.`;
}

function architectAssetReferenceKey(value) {
  let decoded = String(value || '');
  try { decoded = decodeURIComponent(decoded); } catch { /* Local mod filenames may contain literal percent signs. */ }
  return decoded.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function loadArchitectModImage(reference) {
  const key = architectAssetReferenceKey(reference), file = state.architectAssetFiles?.get(key);
  if (!file) return null;
  let entry = state.architectAssetImages.get(key);
  if (!entry) {
    const url = URL.createObjectURL(file), image = new Image();
    state.architectObjectUrls.add(url);
    entry = { url, image }; state.architectAssetImages.set(key, entry);
    image.onload = drawScene;
    image.onerror = () => { state.architectAssetImages.delete(key); };
    image.src = url;
  }
  return entry.image;
}

async function ensureArchitectEnemyArt(scene) {
  if (!scene) return;
  const names = architectEnemyTextureRecords(scene);
  const needed = names.filter(name => {
    const key = normalizeArchitectEnemyId(name);
    return !state.architectEnemyArt.has(key) && !state.architectEnemyArtRequested.has(key) &&
      !state.architectEnemyArtPendingIds.has(key);
  });
  if (!needed.length) { updateArchitectArtworkStatus(scene); return; }
  const pendingKeys = needed.map(normalizeArchitectEnemyId);
  pendingKeys.forEach(key => state.architectEnemyArtPendingIds.add(key));
  state.architectEnemyArtError = '';
  updateArchitectArtworkStatus(scene);
  try {
    const result = await getJson('/api/enemy-artwork', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ placementIds: needed }) });
    for (const [key, artwork] of Object.entries(result.artwork || {})) state.architectEnemyArt.set(normalizeArchitectEnemyId(key), artwork);
    pendingKeys.forEach(key => state.architectEnemyArtRequested.add(key));
    state.architectEnemyArtSummary = `${result.bundlesScanned || 0} local prefab bundles scanned`;
  } catch (error) {
    state.architectEnemyArtError = error.message || 'bundle lookup failed';
  } finally {
    pendingKeys.forEach(key => state.architectEnemyArtPendingIds.delete(key));
    updateArchitectArtworkStatus(architectSceneForCurrentRoom() || scene);
    renderArchitectPanel(); drawScene();
  }
}

function architectArenaSceneNames() {
  return [...state.architectScenes.values()].filter(scene => /^(?:gh|gauntHome|gauntlet)/i.test(scene.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function architectRoomMatchMessage(scene, markers, loaded) {
  if (!loaded) return 'Choose an Architect mod folder to check whether it changes this room.';
  if (!scene) {
    if (!state.scene) return 'Open a game room to check for matching Architect data.';
    return 'No Architect scene matches "' + state.scene.sceneName + '" in the selected data folder (' +
      state.architectScenes.size.toLocaleString() + ' scenes indexed).';
  }
  const contentRecords = architectScenePlacements(scene).filter(record =>
    !record.controllerMarker && !isArchitectGauntletMarker(record) && architectPlacementPosition(record)).length;
  const visiblePlacements = architectScenePlacements(scene).filter(record =>
    !record.controllerMarker && !isArchitectGauntletMarker(record) && architectPlacementPosition(record) &&
    architectPlacementIsVisible(scene.name, record)).length;
  let message = 'Matched ' + scene.name + ': ' + markers.length + ' gauntlet marker' + (markers.length === 1 ? '' : 's') +
    ' · ' + scene.placements.length.toLocaleString() + ' saved placements · ' +
    contentRecords.toLocaleString() + ' placements including prefab contents · ' +
    visiblePlacements.toLocaleString() + ' currently shown · ' +
    scene.tileCells.length.toLocaleString() + ' tile cells · ' +
    Number(scene.scriptCount || 0).toLocaleString() + ' serialized script blocks retained.';
  if (state.architectPreviewName) return message + ' Architect arena preview is open.';
  if (!markers.length) return message + ' No controller pin or paired event-driven gauntlet phases were found in this room.';
  if (!state.architectMarkersEnabled) return message + (markers.length === 1
    ? ' The marker is hidden by default; show it to inspect the changes.'
    : ` These ${markers.length} markers are hidden by default; show them to inspect the changes.`);
  if (!state.architectSelectedMarkerId) return message + ' Click the room pin or its list entry to show the changes.';
  return message + ' The changes are shown on the room map and in the placement list.';
}

function renderArchitectPanel() {
  const scene = architectSceneForCurrentRoom(), markers = architectMarkerRecords(scene);
  const loaded = state.architectScenes.size > 0;
  const markerToggle = byId('architectMarkersToggle');
  markerToggle.disabled = !loaded;
  markerToggle.checked = state.architectMarkersEnabled;
  byId('architectRoomSummary').textContent = architectRoomMatchMessage(scene, markers, loaded);
  byId('architectEnableMarkersButton').hidden = !(scene && markers.length &&
    !state.architectMarkersEnabled && !state.architectPreviewName);
  byId('architectMarkerToggleText').textContent = markers.length
    ? 'Show gauntlet markers (' + markers.length + ')' : 'Show gauntlet markers';
  byId('architectSceneCount').textContent = loaded ? `${state.architectScenes.size} scenes · ${state.architectPrefabs.size} prefabs` : 'not loaded';
  byId('architectFolderStatus').textContent = loaded
    ? `${state.architectSource} · ${state.architectScenes.size} scenes / ${state.architectPrefabs.size} prefabs · ${[...state.architectScenes.values()].reduce((sum, item) => sum + architectScenePlacements(item).length, 0).toLocaleString()} expanded placements`
    : 'Choose a mod folder. Architect scene and prefab data are indexed; serialized scripts are retained but never executed.';

  const markerList = byId('architectMarkerList');
  if (!state.architectMarkersEnabled) markerList.innerHTML = '<span class="filter-empty">Gauntlet markers are off by default.</span>';
  else if (!scene) markerList.innerHTML = '<span class="filter-empty">This room has no matching Architect scene file.</span>';
  else if (!markers.length) markerList.innerHTML = '<span class="filter-empty">No gauntlet controller markers in this scene.</span>';
  else markerList.innerHTML = markers.map(record => {
    const key = architectPlacementKey(scene.name, record), point = architectPlacementPosition(record);
    const active = state.architectSelectedMarkerId === key;
    const label = record.markerLabel || `Gauntlet · ${scene.name}`;
    const detail = record.markerPlacementCount ? `${record.markerPlacementCount} placements` : `${point.x.toFixed(1)}, ${point.y.toFixed(1)}`;
    return `<button type="button" class="architect-marker-option ${active ? 'active' : ''}" data-architect-marker="${escapeHtml(key)}"><span class="architect-marker-glyph">G</span><span>${escapeHtml(label)}</span><span class="architect-coordinate">${escapeHtml(detail)}</span></button>`;
  }).join('');
  markerList.querySelectorAll('[data-architect-marker]').forEach(button => button.addEventListener('click', () => {
    const record = markers.find(item => architectPlacementKey(scene.name, item) === button.dataset.architectMarker);
    if (record) activateArchitectMarker(scene, record);
  }));

  const arenaSelect = byId('architectArenaSelect'), arenaScenes = architectArenaSceneNames();
  const selectedMarker = markers.find(record => architectPlacementKey(scene?.name, record) === state.architectSelectedMarkerId);
  const mayOpenArena = Boolean((selectedMarker && !selectedMarker.virtualEvent) || state.architectPreviewName);
  const arenaPrompt = state.architectPreviewName ? 'Choose another arena…' :
    selectedMarker?.virtualEvent ? 'Event phase has no linked arena' :
      selectedMarker ? 'Choose an Architect arena…' : 'Choose a room marker first';
  arenaSelect.innerHTML = `<option value="">${arenaPrompt}</option>` +
    arenaScenes.map(item => `<option value="${escapeHtml(item.name)}">${escapeHtml(item.name)} · ${item.tileCells.length.toLocaleString()} tile cells</option>`).join('');
  arenaSelect.disabled = !loaded || !mayOpenArena || !arenaScenes.length;
  arenaSelect.value = state.architectPreviewName || '';
  byId('architectReturnButton').hidden = !state.architectPreviewName;

  const hasChanges = Boolean(state.architectPreviewName || (state.architectSelectedMarkerId && scene));
  const changeRow = byId('architectChangesToggleRow');
  changeRow.hidden = !hasChanges;
  byId('architectChangesToggle').checked = state.architectPreviewName ? true : state.architectChangesVisible;
  byId('architectChangesToggle').disabled = Boolean(state.architectPreviewName);
  byId('architectEnemyArtToggleRow').hidden = !hasChanges;
  byId('architectEnemyArtToggle').checked = state.architectEnemyTexturesVisible;
  byId('architectModImagesToggleRow').hidden = !hasChanges || !(state.architectAssetFiles?.size);
  byId('architectModImagesToggle').checked = state.architectModImagesVisible;
  updateArchitectArtworkStatus(scene);
  const tileRow = byId('architectTilemapToggleRow');
  tileRow.hidden = !hasChanges || !(scene?.tileCells?.length);
  byId('architectTilemapToggle').checked = true;

  const eventGroups = architectSceneEventGroups(scene), waves = architectWaveGroups(scene);
  const selectedWave = waves.find(wave => wave.key === state.architectSelectedWaveKey) || null;
  const waveControls = byId('architectWaveControls'), waveSelect = byId('architectWaveSelect');
  const waveEnemyList = byId('architectWaveEnemyList');
  waveControls.hidden = !hasChanges || !scene;
  waveSelect.innerHTML = '<option value="all">All gauntlet changes</option>' + waves.map(wave => {
    const endLabel = wave.endEvent ? ` · ${wave.startEvent} → ${wave.endEvent}` : ` · ${wave.startEvent}`;
    return `<option value="${escapeHtml(wave.key)}">${escapeHtml(wave.label)}${escapeHtml(endLabel)}</option>`;
  }).join('');
  waveSelect.value = selectedWave?.key || 'all';
  waveSelect.disabled = !waves.length;
  const allEnemyRecords = architectWaveEnemyRecords(scene, waves);
  const waveEnemyRecords = architectWaveEnemyRecords(scene, waves, selectedWave);
  const unassignedEnemies = allEnemyRecords.filter(record => {
    const key = architectPlacementKey(scene.name, record);
    return !waves.some(wave => wave.placementKeys.has(key));
  });
  const selectedWaveEnemyCount = selectedWave ? allEnemyRecords.filter(record =>
    selectedWave.placementKeys.has(architectPlacementKey(scene.name, record))).length : allEnemyRecords.length;
  const waveChangedRootCount = selectedWave
    ? architectScenePlacements(scene).filter(record => record.depth === 0 && selectedWave.placementKeys.has(architectPlacementKey(scene.name, record))).length
    : architectScenePlacements(scene).filter(record => record.depth === 0 && waves.some(wave => wave.placementKeys.has(architectPlacementKey(scene.name, record)))).length;
  byId('architectWaveSummary').textContent = selectedWave
    ? `${waveChangedRootCount} changed room placements · ${selectedWaveEnemyCount} enemies assigned to this phase · ${unassignedEnemies.length} without a paired wave event. Start: ${selectedWave.startEvent}${selectedWave.endEvent ? ` · End: ${selectedWave.endEvent}` : ''}.`
    : waves.length
      ? `${waves.length} event-driven wave or phase groups · ${waveChangedRootCount} linked room placements · ${allEnemyRecords.length} enemy placements, ${unassignedEnemies.length} without a paired wave event.`
      : `No paired wave events found · ${allEnemyRecords.length} enemy placements have no inferred wave assignment.`;
  byId('architectWaveEnemyNote').textContent = selectedWave && unassignedEnemies.length
    ? 'Unassigned enemies have no paired Start/End listener in this scene. Toggle one to add that spawn preview to the selected wave; its exact timing is not stored here.'
    : !waves.length
      ? 'No paired Start/End events are available for wave timing. Enemy placement coordinates are still toggleable below.'
    : 'Coordinates are authored placement positions. Switching an enemy also switches its prefab visual children.';
  waveEnemyList.innerHTML = waveEnemyRecords.map(record => {
    const point = architectPlacementPosition(record), key = architectPlacementKey(scene.name, record);
    const labels = waves.filter(wave => wave.placementKeys.has(key)).map(wave => wave.label);
    const otherEvents = [...new Set(architectPlacementListeners(record).map(listener => String(listener.event || '').trim()).filter(Boolean))];
    const label = architectPlacementLabel(record);
    const waveLabel = labels.length ? `Wave · ${labels.join(', ')}` : otherEvents.length ? `Other · ${otherEvents.join(', ')}` : 'Unassigned';
    return `<label class="architect-wave-enemy-row" title="${escapeHtml(`${key} · ${waveLabel}`)}"><input type="checkbox" data-architect-enemy-placement="${escapeHtml(key)}" ${architectPlacementIsVisible(scene.name, record) ? 'checked' : ''}><span class="architect-wave-enemy-name">${escapeHtml(label)}</span><span class="architect-wave-enemy-meta">${point.x.toFixed(1)}, ${point.y.toFixed(1)} · ${escapeHtml(waveLabel)}</span></label>`;
  }).join('') || '<span class="filter-empty">No enemy placements are linked to these activation events.</span>';
  waveSelect.onchange = () => {
    const wave = waves.find(item => item.key === waveSelect.value) || null;
    state.architectSelectedWaveKey = wave?.key || null;
    state.architectWaveFilterKeys = wave?.placementKeys || null;
    state.architectActiveEvents = new Set(wave ? [wave.startEvent] : waves.map(item => item.startEvent));
    renderArchitectPanel(); drawScene();
    if (state.architectChangesVisible) void ensureArchitectEnemyArt(scene);
  };
  waveEnemyList.querySelectorAll('[data-architect-enemy-placement]').forEach(input => input.addEventListener('change', () => {
    const record = architectScenePlacements(scene).find(item => architectPlacementKey(scene.name, item) === input.dataset.architectEnemyPlacement);
    if (record) setArchitectPlacementFamilyVisibility(scene, record, input.checked);
    renderArchitectPanel(); drawScene();
  }));

  const eventControls = byId('architectEventControls'), eventList = byId('architectEventList');
  eventControls.hidden = !hasChanges || !eventGroups.length;
  eventList.innerHTML = eventGroups.map(group => {
    const checked = state.architectActiveEvents.has(group.name);
    return '<label class="architect-event-option"><input type="checkbox" data-architect-event="' +
      escapeHtml(group.name) + '"' + (checked ? ' checked' : '') + '><span class="architect-event-name">' +
      escapeHtml(group.name) + '</span><span class="architect-event-meta">' + group.placementCount +
      ' placements · ' + escapeHtml(group.actionSummary) + '</span></label>';
  }).join('');
  eventList.querySelectorAll('[data-architect-event]').forEach(input => input.addEventListener('change', () => {
    if (input.checked) state.architectActiveEvents.add(input.dataset.architectEvent);
    else state.architectActiveEvents.delete(input.dataset.architectEvent);
    state.architectPlacementVisibility = new Map();
    renderArchitectPanel(); drawScene();
  }));
  const resetEventsButton = byId('architectResetEventsButton');
  resetEventsButton.hidden = !state.architectActiveEvents.size;

  const rows = byId('architectPlacementList');
  if (!hasChanges || !scene) {
    rows.innerHTML = '<span class="filter-empty">Choose a room and enable its gauntlet markers.</span>';
    return;
  }
  const records = architectScenePlacements(scene).filter(record => {
    if (record.controllerMarker || isArchitectGauntletMarker(record) || !architectPlacementPosition(record) || architectPlacementIsEnemy(record)) return false;
    return !selectedWave || selectedWave.placementKeys.has(architectPlacementKey(scene.name, record));
  });
  if (!records.length && !scene.tileCells.length) {
    rows.innerHTML = '<span class="filter-empty">No serialized placements or tile cells in this scene.</span>';
    return;
  }
  rows.innerHTML = records.map(record => {
    const point = architectPlacementPosition(record), key = architectPlacementKey(scene.name, record);
    const checked = architectPlacementIsVisible(scene.name, record);
    const prefix = record.depth ? `${record.parentLabel} › ` : '';
    return `<label class="architect-placement-row" title="${escapeHtml(key)}"><input type="checkbox" data-architect-placement="${escapeHtml(key)}" ${checked ? 'checked' : ''}><span class="architect-placement-name">${escapeHtml(prefix + architectPlacementLabel(record))}</span><span class="architect-coordinate">${point.x.toFixed(1)}, ${point.y.toFixed(1)}</span></label>`;
  }).join('') || '<span class="filter-empty">Tile cells are shown as position-only outlines because Architect does not include their rendered textures here.</span>';
  rows.querySelectorAll('[data-architect-placement]').forEach(input => input.addEventListener('change', () => {
    state.architectPlacementVisibility.set(input.dataset.architectPlacement, input.checked);
    renderArchitectPanel(); drawScene();
  }));
}

function activateArchitectMarker(scene, record) {
  const key = architectPlacementKey(scene.name, record);
  if (state.architectSelectedMarkerId === key) {
    state.architectSelectedMarkerId = null;
    state.architectSelectedWaveKey = null;
    state.architectWaveFilterKeys = null;
    state.architectChangesVisible = false;
    state.architectActiveEvents = new Set();
    state.architectPlacementVisibility = new Map();
    state.architectWaveEnemyVisibility = new Map();
    byId('selectionContent').textContent = 'Click an object in the tree or on the map.';
  } else {
    state.architectSelectedMarkerId = key;
    state.architectChangesVisible = true;
    const waves = architectWaveGroups(scene);
    const selectedWave = waves.find(wave => wave.key === (record.virtualWaveKey || (record.virtualEvent ? `event-phase:${architectEventKey(record.virtualEvent)}` : '')));
    state.architectSelectedWaveKey = selectedWave?.key || null;
    state.architectWaveFilterKeys = selectedWave?.placementKeys || null;
    state.architectActiveEvents = new Set(selectedWave
      ? [selectedWave.startEvent]
      : record.virtualEvent ? [record.virtualEvent] : waves.map(wave => wave.startEvent));
    state.architectPlacementVisibility = new Map();
    state.architectWaveEnemyVisibility = new Map();
    state.selected = null;
    showArchitectPlacement(record, scene.name, record.virtualEvent ? 'GAUNTLET WAVE' : 'GAUNTLET CONTROLLER');
  }
  state.fitBounds = null;
  state.fitted = false;
  renderArchitectPanel();
  drawScene();
  if (state.architectChangesVisible) void ensureArchitectEnemyArt(scene);
}

function showArchitectPlacement(record, sceneName, kind = 'ARCHITECT PLACEMENT') {
  const point = architectPlacementPosition(record), config = { ...(record?.config || {}) };
  config['Current viewer state'] = architectPlacementIsVisible(sceneName, record) ? 'active' : 'inactive';
  if (record?.virtualEvent) {
    config['Activation event'] = record.virtualEvent;
    config['Paired completion event'] = record.virtualEndEvent || '—';
    config['Controlled placements'] = String(record.markerPlacementCount || 0);
  }
  const listeners = architectPlacementListeners(record);
  listeners.forEach((listener, index) => {
    config['Event listener ' + (index + 1)] = listener.event + ' → ' + listener.action + (listener.inherited ? ' (inherited)' : '');
  });
  const configRows = Object.entries(config).slice(0, 18 + listeners.length).map(([key, raw]) => {
    let value = String(raw);
    try { value = JSON.stringify(JSON.parse(value)); } catch { /* Architect stores many values as plain strings. */ }
    if (value.length > 180) value = `${value.slice(0, 177)}…`;
    return `<div class="selection-copy"><span>${escapeHtml(key)}</span><strong>${escapeHtml(value)}</strong></div>`;
  }).join('');
  byId('selectionContent').innerHTML = `<div class="selection-name">${escapeHtml(architectPlacementLabel(record))}</div><div class="selection-type" style="color:${kind === 'GAUNTLET CONTROLLER' ? '#bb9cef' : architectPlacementColor(record)}">${escapeHtml(kind)}</div><div class="selection-copy"><span>Architect scene</span><strong>${escapeHtml(sceneName)}</strong></div><div class="selection-copy"><span>World position</span><strong>${point ? `${point.x.toFixed(3)}, ${point.y.toFixed(3)}, ${point.z.toFixed(3)}` : '—'}</strong></div><div class="selection-copy"><span>Placement ID</span><strong>${escapeHtml(record?.placement?.pid || '—')}</strong></div>${configRows}`;
}

function architectCanvasMarkers(scene) {
  return state.architectMarkersEnabled ? architectMarkerRecords(scene) : [];
}

function architectMarkersEnabledForBounds(scene) {
  return Boolean(scene && (state.architectPreviewName === scene.name ||
    (state.architectChangesVisible && state.architectSelectedMarkerId)));
}

function hitArchitectMarker(scene, world) {
  if (!state.architectMarkersEnabled || !scene) return null;
  let best = null;
  for (const record of architectMarkerRecords(scene)) {
    const point = architectPlacementPosition(record), distance = Math.hypot((point.x - world.x) * state.scale, (point.y - world.y) * state.scale);
    if (distance <= 13 && (!best || distance < best.distance)) best = { record, distance };
  }
  return best?.record || null;
}

function drawArchitectEnemyArt(ctx, scene, originX, originY, width, height, scale) {
  if (!state.architectEnemyTexturesVisible) return;
  for (const record of architectScenePlacements(scene)) {
    if (!architectPlacementHasEnemyTextureAnchor(scene, record) || !architectPlacementIsVisible(scene.name, record)) continue;
    const art = state.architectEnemyArt.get(normalizeArchitectEnemyId(record.placement?.id));
    const point = architectPlacementPosition(record), sprite = art?.sprite;
    if (!point || !sprite?.imageUrl) continue;
    const image = state.images.get(sprite.imageUrl) || loadSceneImage(sprite.imageUrl);
    if (!image.complete || !image.naturalWidth) continue;
    const x = originX + (point.x + Number(art.offsetX || 0)) * scale;
    const y = originY - (point.y + Number(art.offsetY || 0)) * scale;
    if (x < -60 || x > width + 60 || y < -60 || y > height + 60) continue;
    const parentScaleValue = Number(record.placement.scale);
    const parentScale = Number.isFinite(parentScaleValue) ? parentScaleValue : 1;
    const placementRotation = Number(record.placement.rotation) || 0;
    const geometry = spriteLocalGeometry(sprite), rotated = sprite.packingRotation === 4;
    const { width: spriteWidth, height: spriteHeight } = geometry;
    const sourceY = sprite.textureHeight - sprite.rectY - sprite.rectHeight;
    const sourceWidth = rotated ? spriteHeight : spriteWidth, sourceHeight = rotated ? spriteWidth : spriteHeight;
    const matrix = spriteWorldMatrix(sprite);
    const tintR = Math.max(0, Math.min(1, (sprite.tintR ?? 1) * (sprite.materialTintR ?? 1)));
    const tintG = Math.max(0, Math.min(1, (sprite.tintG ?? 1) * (sprite.materialTintG ?? 1)));
    const tintB = Math.max(0, Math.min(1, (sprite.tintB ?? 1) * (sprite.materialTintB ?? 1)));
    ctx.save(); ctx.globalAlpha = Math.max(0, Math.min(1, (sprite.tintA ?? 1) * (sprite.materialTintA ?? 1)));
    ctx.translate(x, y); ctx.rotate(-placementRotation * Math.PI / 180);
    ctx.scale((record.placement.flipped ? -1 : 1) * parentScale * scale, parentScale * scale);
    ctx.transform(matrix.m00, -matrix.m10, matrix.m01, -matrix.m11, 0, 0);
    ctx.scale(sprite.flipX ? -1 : 1, sprite.flipY ? -1 : 1);
    ctx.translate(geometry.left + spriteWidth / 2, geometry.bottom + spriteHeight / 2);
    ctx.scale(1, -1);
    if (sprite.packingRotation === 1) ctx.scale(-1, 1);
    else if (sprite.packingRotation === 2) ctx.scale(1, -1);
    else if (sprite.packingRotation === 3) ctx.rotate(Math.PI);
    else if (rotated) ctx.rotate(-Math.PI / 2);
    ctx.drawImage(image, sprite.rectX, sourceY, sprite.rectWidth, sprite.rectHeight,
      -sourceWidth / 2, -sourceHeight / 2, sourceWidth, sourceHeight);
    ctx.restore();
  }
}

function architectConfigObject(record, key) {
  const value = record?.config?.[key];
  if (!value) return {};
  try { return JSON.parse(value); } catch { return {}; }
}

function drawArchitectModImages(ctx, scene, originX, originY, width, height, scale) {
  if (!state.architectModImagesVisible) return;
  for (const record of architectScenePlacements(scene)) {
    if (!architectPlacementIsVisible(scene.name, record) || !record.config?.png_url) continue;
    const image = loadArchitectModImage(record.config.png_url), point = architectPlacementPosition(record);
    if (!image?.complete || !image.naturalWidth || !point) continue;
    const ppu = Math.max(1, Number(record.config.png_ppu) || 100);
    const objectScale = architectConfigObject(record, 'object_scale');
    const sizeX = image.naturalWidth / ppu * (Number(objectScale.x) || 1) *
      (Number.isFinite(Number(record.placement.scale)) ? Number(record.placement.scale) : 1);
    const sizeY = image.naturalHeight / ppu * (Number(objectScale.y) || 1) *
      (Number.isFinite(Number(record.placement.scale)) ? Number(record.placement.scale) : 1);
    const x = originX + point.x * scale, y = originY - point.y * scale;
    if (x + sizeX * scale < 0 || x - sizeX * scale > width || y + sizeY * scale < 0 || y - sizeY * scale > height) continue;
    const color = architectConfigObject(record, 'png_sprite_colour');
    const alpha = Math.max(0, Math.min(1, Number(color.a ?? record.config.png_col_a) || 0));
    const tintAlpha = Number.isFinite(Number(color.a ?? record.config.png_col_a)) ? alpha : 1;
    ctx.save(); ctx.translate(x, y); ctx.rotate(-(Number(record.placement.rotation) || 0) * Math.PI / 180);
    ctx.scale(record.placement.flipped ? -1 : 1, 1); ctx.globalAlpha = tintAlpha;
    ctx.drawImage(image, -sizeX * scale / 2, -sizeY * scale / 2, sizeX * scale, sizeY * scale);
    ctx.restore();
  }
}

function drawArchitectOverlay(ctx, scene, originX, originY, width, height, scale = state.scale) {
  if (!scene) return;
  const preview = state.architectPreviewName === scene.name;
  const showChanges = preview || (state.architectChangesVisible && Boolean(state.architectSelectedMarkerId));
  if (showChanges && byId('architectTilemapToggle').checked) {
    ctx.save();
    ctx.fillStyle = '#b99be619'; ctx.strokeStyle = '#c1a3eb68'; ctx.lineWidth = Math.max(.6, Math.min(1.2, scale * .045));
    for (const cell of scene.tileCells || []) {
      const x = originX + cell.x * scale, y = originY - (cell.y + 1) * scale;
      if (x + scale < 0 || x > width || y + scale < 0 || y > height) continue;
      ctx.fillRect(x, y, scale, scale); ctx.strokeRect(x, y, scale, scale);
    }
    ctx.restore();
  }
  if (showChanges) {
    for (const record of architectScenePlacements(scene)) {
      if (record.controllerMarker || isArchitectGauntletMarker(record) || !architectPlacementIsVisible(scene.name, record)) continue;
      const point = architectPlacementPosition(record);
      if (!point) continue;
      const x = originX + point.x * scale, y = originY - point.y * scale;
      if (x < -12 || x > width + 12 || y < -12 || y > height + 12) continue;
      const size = Math.max(2.4, Math.min(5.2, scale * .13));
      ctx.save(); ctx.translate(x, y); ctx.rotate(Math.PI / 4); ctx.fillStyle = architectPlacementColor(record); ctx.globalAlpha = .9;
      ctx.fillRect(-size, -size, size * 2, size * 2); ctx.globalAlpha = 1;
      ctx.strokeStyle = '#171713'; ctx.lineWidth = 1; ctx.strokeRect(-size, -size, size * 2, size * 2); ctx.restore();
    }
    drawArchitectEnemyArt(ctx, scene, originX, originY, width, height, scale);
    drawArchitectModImages(ctx, scene, originX, originY, width, height, scale);
  }
  for (const record of architectCanvasMarkers(scene)) {
    const point = architectPlacementPosition(record), x = originX + point.x * scale, y = originY - point.y * scale;
    if (x < -18 || x > width + 18 || y < -18 || y > height + 18) continue;
    const key = architectPlacementKey(scene.name, record), selected = state.architectSelectedMarkerId === key;
    ctx.save(); ctx.translate(x, y); ctx.fillStyle = '#bb9cef'; ctx.strokeStyle = '#f0e4ff'; ctx.lineWidth = selected ? 2 : 1.2;
    ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(8, 0); ctx.lineTo(0, 8); ctx.lineTo(-8, 0); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#24182f'; ctx.font = 'bold 8px Consolas, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('G', 0, .5); ctx.restore();
  }
  if (preview) {
    ctx.save(); ctx.fillStyle = '#171713dc'; ctx.fillRect(12, 43, Math.min(width - 24, 460), 28);
    ctx.fillStyle = '#c4a7ed'; ctx.font = '9px Consolas, monospace';
    ctx.fillText('ARCHITECT PREVIEW · TILE POSITIONS AND OBJECT PLACEMENTS · RUNTIME ART NOT INCLUDED', 20, 61); ctx.restore();
  }
}

async function importArchitectFolder(fileList) {
  const files = [...fileList];
  const candidates = files.map(file => {
    const path = String(file.webkitRelativePath || file.name).replace(/\\/g, '/');
    const match = /(?:^|\/)Architect\/(Scenes|Prefabs)\/([^/]+\.architect\.json)$/i.exec(path);
    if (!match) return null;
    const markerIndex = path.toLowerCase().lastIndexOf(`/architect/${match[1].toLowerCase()}/`);
    const root = markerIndex >= 0 ? path.slice(0, markerIndex) : '';
    return { file, root, kind: match[1].toLowerCase(), itemName: match[2].replace(/\.architect\.json$/i, '') };
  }).filter(Boolean);
  const assetCandidates = files.map(file => {
    const path = String(file.webkitRelativePath || file.name).replace(/\\/g, '/');
    const match = /(?:^|\/)Architect\/Assets\/.+\.(png|jpe?g|webp)$/i.exec(path);
    if (!match || file.size <= 0 || file.size > 64 * 1024 * 1024) return null;
    const markerIndex = path.toLowerCase().lastIndexOf('/architect/assets/');
    const root = markerIndex >= 0 ? path.slice(0, markerIndex) : '';
    return { file, root };
  }).filter(Boolean);
  if (!candidates.some(candidate => candidate.kind === 'scenes')) throw new Error('No Architect/Scenes/*.architect.json files found in that folder.');
  if (candidates.length > 1000) throw new Error('This folder contains more than 1,000 Architect scene and prefab files; select one mod folder instead.');
  const totalBytes = candidates.reduce((sum, candidate) => sum + candidate.file.size, 0);
  if (totalBytes > 256 * 1024 * 1024 || candidates.some(candidate => candidate.file.size > 32 * 1024 * 1024))
    throw new Error('Architect scene data exceeds the 256 MB import limit or contains a file over 32 MB.');

  const sources = new Map(); let invalid = 0;
  const getSource = root => {
    if (!sources.has(root)) sources.set(root, { scenes: new Map(), prefabs: new Map(), assets: new Map() });
    return sources.get(root);
  };
  if (assetCandidates.length > 20000) throw new Error('This folder contains more than 20,000 Architect images; choose the mod folder you want to inspect.');
  for (const { file, root } of assetCandidates) {
    const source = getSource(root), key = architectAssetReferenceKey(file.name.replace(/\.[^.]+$/, ''));
    if (key && !source.assets.has(key)) source.assets.set(key, file);
  }
  for (let index = 0; index < candidates.length; index++) {
    const { file, root, kind, itemName } = candidates[index];
    try {
      const json = JSON.parse(await file.text());
      if (!json || !Array.isArray(json.placements) || !Array.isArray(json.tilemap || [])) { invalid++; continue; }
      const placements = json.placements.map((record, recordIndex) => ({
        placement: record?.placement || {}, config: record?.config || {},
        listeners: (Array.isArray(record?.listeners) ? record.listeners : []).map(listener => ({
          event: String(listener?.Item1 || ''), action: String(listener?.Item2 || ''),
          order: Number.isFinite(Number(listener?.Item3)) ? Number(listener.Item3) : 0
        })).filter(listener => listener.event),
        index: recordIndex
      })).filter(record => architectPlacementPosition(record));
      const tileCells = (json.tilemap || []).map(cell => {
        const x = Number(Array.isArray(cell) ? cell[0] : cell?.Item1 ?? cell?.x);
        const y = Number(Array.isArray(cell) ? cell[1] : cell?.Item2 ?? cell?.y);
        return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
      }).filter(Boolean);
      const source = getSource(root);
      const scriptNodes = Array.isArray(json.script) ? json.script : [];
      const item = { name: itemName, key: normalizeArchitectSceneName(itemName), placements, tileCells,
        scriptCount: scriptNodes.length, scriptNodes, fileName: file.name };
      if (kind === 'scenes') source.scenes.set(item.key, item);
      else source.prefabs.set(`prefab_${itemName.replace(/^Prefab_/i, '')}`.toLowerCase(), item);
    } catch { invalid++; }
    if (index % 12 === 0 || index === candidates.length - 1) {
      byId('architectFolderStatus').textContent = `Reading Architect data ${index + 1} of ${candidates.length}…`;
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  for (const source of sources.values()) for (const scene of source.scenes.values()) expandArchitectPrefabs(scene, source.prefabs);
  const usable = [...sources.values()].filter(source => source.scenes.size);
  if (!usable.length) throw new Error('Architect scene files were found, but none contained readable placement data.');
  state.architectSources = new Map([...sources.entries()].filter(([, source]) => source.scenes.size));
  const rootPaths = [...state.architectSources.keys()];
  const preferred = rootPaths.find(root => /GauntletSong/i.test(root)) || rootPaths[0];
  state.architectSource = preferred ? (preferred.split('/').filter(Boolean).pop() || 'Architect') : 'Architect';
  state.architectScenes = state.architectSources.get(preferred)?.scenes || new Map();
  state.architectPrefabs = state.architectSources.get(preferred)?.prefabs || new Map();
  for (const url of state.architectObjectUrls) URL.revokeObjectURL(url);
  state.architectObjectUrls.clear(); state.architectAssetImages = new Map();
  state.architectAssetFiles = state.architectSources.get(preferred)?.assets || new Map();
  state.architectMarkersEnabled = false;
  state.architectSelectedMarkerId = null; state.architectChangesVisible = false;
  state.architectSelectedWaveKey = null; state.architectWaveFilterKeys = null;
  state.architectPlacementVisibility = new Map(); state.architectActiveEvents = new Set(); state.architectPreviewName = null;
  state.architectWaveEnemyVisibility = new Map();
  const rootWrap = byId('architectSourceSelectWrap'), rootSelect = byId('architectSourceSelect');
  rootWrap.hidden = rootPaths.length < 2;
  rootSelect.innerHTML = rootPaths.map(root => {
    const source = state.architectSources.get(root), label = root.split('/').filter(Boolean).pop() || 'Architect';
    return `<option value="${escapeHtml(root)}">${escapeHtml(label)} · ${source.scenes.size} scenes / ${source.prefabs.size} prefabs / ${source.assets.size} images</option>`;
  }).join('');
  rootSelect.value = preferred || '';
  byId('architectFolderStatus').textContent = `${state.architectSource} · ${state.architectScenes.size} scenes, ${state.architectPrefabs.size} prefabs, and ${state.architectAssetFiles.size} linked images indexed${invalid ? ` · ${invalid} invalid or unsupported file${invalid === 1 ? '' : 's'} skipped` : ''}.`;
  if (state.scene) returnToGameRoom();
  else { renderArchitectPanel(); drawScene(); }
}

function openArchitectPreview(sceneName) {
  const scene = state.architectScenes.get(normalizeArchitectSceneName(sceneName));
  if (!scene) return;
  state.architectPreviewName = scene.name;
  state.architectSelectedMarkerId = null;
  state.architectSelectedWaveKey = null; state.architectWaveFilterKeys = null;
  state.architectChangesVisible = true;
  state.architectActiveEvents = new Set();
  state.architectPlacementVisibility = new Map();
  state.architectWaveEnemyVisibility = new Map();
  state.fitBounds = null; state.fitted = false; state.gameView = false; state.cameraLockIndex = -1;
  state.gradePreviewObjectId = null;
  renderCapturePanel();
  byId('lightingPreviewStrength').value = '0';
  byId('canvasShell').classList.remove('wide-preview'); byId('fitZonesButton').disabled = true; byId('fitZonesButton').classList.remove('active');
  byId('currentSceneTitle').textContent = `Architect · ${scene.name}`; byId('sceneKind').textContent = 'ARCHITECT';
  byId('viewStatus').textContent = `${architectScenePlacements(scene).length.toLocaleString()} PLACEMENTS · ${scene.tileCells.length.toLocaleString()} TILE CELLS`;
  byId('detailSceneName').textContent = scene.name; byId('detailObjects').textContent = architectScenePlacements(scene).length.toLocaleString();
  byId('detailBundle').textContent = scene.fileName; byId('detailBounds').textContent = architectSceneBounds(scene)
    ? `${architectSceneBounds(scene).minX.toFixed(1)}, ${architectSceneBounds(scene).minY.toFixed(1)} → ${architectSceneBounds(scene).maxX.toFixed(1)}, ${architectSceneBounds(scene).maxY.toFixed(1)}` : '—';
  byId('treeCount').textContent = '0'; byId('objectTree').innerHTML = '<div class="empty-state tree-empty">Architect scene data view. Runtime game objects are not loaded for this mod-only scene.</div>';
  renderArchitectPanel(); drawScene();
  void ensureArchitectEnemyArt(scene);
}

function returnToGameRoom() {
  state.architectPreviewName = null; state.architectSelectedMarkerId = null;
  state.architectSelectedWaveKey = null; state.architectWaveFilterKeys = null;
  state.architectChangesVisible = false; state.architectActiveEvents = new Set(); state.architectPlacementVisibility = new Map();
  state.architectWaveEnemyVisibility = new Map();
  if (!state.scene) return;
  renderCapturePanel();
  state.fitBounds = null; state.fitted = false;
  byId('currentSceneTitle').textContent = state.scene.sceneName;
  byId('sceneKind').textContent = kindLabel(state.scenes.find(item => item.candidateName === state.scene.sceneName)?.kind || 'room');
  byId('viewStatus').textContent = `ROOM ARTWORK · ${(state.scene.objects || []).flatMap(object => object.sprites || []).length.toLocaleString()} SPRITES`;
  byId('detailSceneName').textContent = state.scene.sceneName; byId('detailObjects').textContent = (state.scene.objects?.length || 0).toLocaleString();
  byId('detailBundle').textContent = String(state.scene.sourceBundle || '').split(/[\\/]/).pop();
  byId('detailBounds').textContent = sceneBounds(state.scene.objects || []);
  renderObjectTree(); refreshCameraLockAreas(); renderArchitectPanel(); drawScene();
}

function updateCameraLockButton() {
  const button = byId('fitZonesButton'), label = byId('cameraLockLabel');
  if (!button || !label) return;
  const area = state.cameraLockAreas[state.cameraLockIndex];
  label.textContent = area ? `Camera ${state.cameraLockIndex + 1}/${state.cameraLockAreas.length}` : 'Camera';
  button.title = area ? `Preview ${area.name} at (${area.centerX.toFixed(1)}, ${area.centerY.toFixed(1)}). Click to cycle authored camera areas.`
    : 'Cycle through the room’s authored CameraLockArea bounds';
}

function refreshCameraLockAreas() {
  const currentId = state.cameraLockAreas[state.cameraLockIndex]?.id;
  const previousIndex = state.cameraLockIndex;
  state.cameraLockAreas = cameraLockAreas(state.scene?.objects || []);
  if (state.gameView && state.cameraLockAreas.length) {
    const matchingIndex = currentId ? state.cameraLockAreas.findIndex(area => area.id === currentId) : -1;
    state.cameraLockIndex = matchingIndex >= 0 ? matchingIndex : Math.min(Math.max(previousIndex, 0), state.cameraLockAreas.length - 1);
    state.fitBounds = state.cameraLockAreas[state.cameraLockIndex].bounds;
    state.fitted = false;
  } else if (state.gameView) {
    state.cameraLockIndex = -1; state.gameView = false; state.fitBounds = null; state.fitted = false;
    byId('canvasShell').classList.remove('wide-preview'); byId('fitZonesButton').classList.remove('active');
  } else {
    state.cameraLockIndex = -1;
  }
  byId('fitZonesButton').disabled = !state.cameraLockAreas.length;
  updateCameraLockButton();
}

function gradeMarkerComponent(object) {
  return (object?.components || []).find(component => component.scriptName === 'GradeMarker' && component.data);
}

function selectedGradePreview() {
  if (!state.gradePreviewObjectId) return null;
  const object = state.objectById.get(state.gradePreviewObjectId), component = gradeMarkerComponent(object);
  return object && component ? { object, component } : null;
}

function renderLightingStateFilters() {
  const root = byId('lightingStateFilters');
  if (!root) return;
  const markers = (state.scene?.objects || []).map(object => ({ object, component: gradeMarkerComponent(object) }))
    .filter(item => item.component).sort((a, b) => (b.component.data.numbers?.priority || 0) - (a.component.data.numbers?.priority || 0) ||
      (a.object.name || '').localeCompare(b.object.name || ''));
  byId('lightingStateCount').textContent = markers.length ? String(markers.length) : '';
  const rows = markers.map(({ object, component }) => {
    const data = component.data, numbers = data.numbers || {}, colors = data.colors || {};
    const available = objectIsActive(object) && data.flags?.enableGrade !== false;
    const active = state.gradePreviewObjectId === object.id;
    const radii = Number.isFinite(numbers.maxIntensityRadius) && Number.isFinite(numbers.cutoffRadius)
      ? ` · ${numbers.maxIntensityRadius.toFixed(0)}–${numbers.cutoffRadius.toFixed(0)}u` : '';
    const saturation = Number.isFinite(numbers.saturation) ? ` · sat ${numbers.saturation.toFixed(2)}` : '';
    const color = colors.ambientColor;
    const ambient = color ? ` · ambient ${Math.round(color.r * 255)},${Math.round(color.g * 255)},${Math.round(color.b * 255)} @ ${(numbers.ambientIntensity ?? 1).toFixed(2)}` : '';
    const heroColor = colors.heroLightColor;
    const heroLight = heroColor ? ` · hero light ${Math.round(heroColor.r * 255)},${Math.round(heroColor.g * 255)},${Math.round(heroColor.b * 255)}` : '';
    return `<div class="grade-preview-row ${available ? '' : 'disabled'}"><label><input type="radio" name="grade-preview" data-grade-preview="${escapeHtml(object.id)}" ${active ? 'checked' : ''} ${available ? '' : 'disabled'}><span>${escapeHtml(object.name || 'GradeMarker')}</span></label><small>${available ? 'saved grade' : 'inactive in serialized scene'}${radii}${saturation}${ambient}${heroLight}</small></div>`;
  }).join('');
  const none = `<div class="grade-preview-row"><label><input type="radio" name="grade-preview" data-grade-preview="" ${state.gradePreviewObjectId ? '' : 'checked'}><span>Unmodified room</span></label><small>Do not apply a location-specific grade.</small></div>`;
  root.innerHTML = markers.length ? none + rows : '<span class="filter-empty">No serialized GradeMarker in this room.</span>';
  root.querySelectorAll('[data-grade-preview]').forEach(input => input.addEventListener('change', () => {
    if (!input.checked) return;
    state.gradePreviewObjectId = input.dataset.gradePreview || null;
    if (state.gradePreviewObjectId) byId('lightingPreviewStrength').value = '0';
    updateGradePreviewControl(); drawScene();
  }));
  updateGradePreviewControl();
}

function updateGradePreviewControl() {
  const slider = byId('lightingPreviewStrength');
  const output = byId('lightingPreviewValue');
  if (!slider || !output) return;
  const preview = selectedGradePreview();
  slider.disabled = !preview;
  const numbers = preview?.component.data.numbers || {};
  const cutoff = Math.max(0, Number(numbers.cutoffRadius) || 0);
  const inner = Math.max(0, Number(numbers.maxIntensityRadius) || 0);
  const distance = cutoff * Number(slider.value) / 100;
  const spanSquared = cutoff * cutoff - inner * inner;
  const falloff = cutoff > 0 && spanSquared > 0
    ? Math.max(0, Math.min(1, (cutoff * cutoff - distance * distance) / spanSquared))
    : (distance <= inner ? 1 : 0);
  state.gradePreviewFactor = preview ? falloff * Math.max(0, Math.min(1, Number(numbers.alpha ?? 1))) : 0;
  output.value = preview ? `${distance.toFixed(0)}u / ${cutoff.toFixed(0)}u` : '—';
}

function applyGradePreview(canvas, component, factor) {
  const data = component.data || {}, numbers = data.numbers || {}, curves = data.curves || {};
  // `factor` already includes the marker's alpha and Unity's squared-distance
  // falloff, computed from the simulated Hero radius in updateGradePreviewControl.
  const strength = Math.max(0, Math.min(1, factor));
  if (!strength) return;
  try {
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const image = context.getImageData(0, 0, canvas.width, canvas.height), pixels = image.data;
    const lookups = ['redChannel', 'greenChannel', 'blueChannel'].map(name => makeGradeLookup(curves[name] || []));
    const saturation = 1 + ((numbers.saturation ?? 1) - 1) * strength;
    for (let index = 0; index < pixels.length; index += 4) {
      let r = pixels[index] / 255, g = pixels[index + 1] / 255, b = pixels[index + 2] / 255;
      const originalR = r, originalG = g, originalB = b;
      r += (lookups[0][Math.round(r * 255)] - r) * strength;
      g += (lookups[1][Math.round(g * 255)] - g) * strength;
      b += (lookups[2][Math.round(b * 255)] - b) * strength;
      const luminance = .299 * r + .587 * g + .114 * b;
      r = luminance + (r - luminance) * saturation;
      g = luminance + (g - luminance) * saturation;
      b = luminance + (b - luminance) * saturation;
      pixels[index] = Math.round(Math.max(0, Math.min(1, r)) * 255);
      pixels[index + 1] = Math.round(Math.max(0, Math.min(1, g)) * 255);
      pixels[index + 2] = Math.round(Math.max(0, Math.min(1, b)) * 255);
      if (pixels[index + 3] === 0) { pixels[index] = originalR * 255; pixels[index + 1] = originalG * 255; pixels[index + 2] = originalB * 255; }
    }
    context.putImageData(image, 0, 0);
  } catch (error) {
    console.warn('Could not apply the saved Silksong scene grade:', error);
  }
}

function makeGradeLookup(keys) {
  const lookup = new Float32Array(256);
  if (!keys.length) { for (let i = 0; i < 256; i++) lookup[i] = i / 255; return lookup; }
  for (let sample = 0; sample < 256; sample++) {
    const x = sample / 255;
    if (x <= keys[0].time) { lookup[sample] = keys[0].value; continue; }
    if (x >= keys[keys.length - 1].time) { lookup[sample] = keys[keys.length - 1].value; continue; }
    let right = 1;
    while (right < keys.length && x > keys[right].time) right++;
    const a = keys[right - 1], b = keys[right], span = Math.max(1e-6, b.time - a.time), t = (x - a.time) / span;
    const t2 = t * t, t3 = t2 * t;
    lookup[sample] = (2 * t3 - 3 * t2 + 1) * a.value + (t3 - 2 * t2 + t) * span * a.outSlope +
      (-2 * t3 + 3 * t2) * b.value + (t3 - t2) * span * b.inSlope;
  }
  return lookup;
}

function drawGradeRange(ctx, object, component, originX, originY, scale) {
  if (!object || !component || !byId('layerLighting').checked) return;
  const numbers = component.data.numbers || {}, outer = Number(numbers.cutoffRadius), inner = Number(numbers.maxIntensityRadius);
  if (!(outer > 0)) return;
  const point = object.worldPosition || { x: 0, y: 0 }, x = originX + point.x * scale, y = originY - point.y * scale;
  const color = component.data.colors?.ambientColor || { r: .78, g: .82, b: .84 };
  const stroke = `rgba(${Math.round(color.r * 255)},${Math.round(color.g * 255)},${Math.round(color.b * 255)},.62)`;
  ctx.save(); ctx.lineWidth = 1.25; ctx.strokeStyle = stroke; ctx.setLineDash([5, 4]);
  ctx.beginPath(); ctx.arc(x, y, outer * scale, 0, Math.PI * 2); ctx.stroke();
  if (inner > 0) { ctx.setLineDash([]); ctx.beginPath(); ctx.arc(x, y, inner * scale, 0, Math.PI * 2); ctx.stroke(); }
  ctx.setLineDash([]); ctx.beginPath(); ctx.arc(x, y, 4.5, 0, Math.PI * 2); ctx.fillStyle = stroke; ctx.fill(); ctx.restore();
}

function drawScene() {
  const canvas = byId('roomCanvas'); if (!canvas) return;
  const bounds = canvas.getBoundingClientRect(), ratio = window.devicePixelRatio || 1;
  if (!bounds.width || !bounds.height) return;
  if (canvas.width !== Math.round(bounds.width * ratio) || canvas.height !== Math.round(bounds.height * ratio)) { canvas.width = Math.round(bounds.width * ratio); canvas.height = Math.round(bounds.height * ratio); }
  const ctx = canvas.getContext('2d'); ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  const width = bounds.width, height = bounds.height;
  ctx.clearRect(0, 0, width, height);
  const architectPreview = state.architectPreviewName ? state.architectScenes.get(normalizeArchitectSceneName(state.architectPreviewName)) : null;
  const objects = architectPreview ? [] : state.readerMode && !state.readerRoomName
    ? state.readerVisibleObjects || [] : state.scene?.objects || [];
  const architectScene = architectPreview || architectSceneForCurrentRoom();
  if (!objects.length && !architectPreview) { byId('zoomLevel').textContent = `${Math.round(state.scale * 100)}%`; return; }
  const artworkBounds = !architectPreview && byId('layerArtwork').checked ? visibleSpriteBounds(objects) : null;
  const baseBounds = artworkBounds || objectBounds(objects);
  const modBounds = architectMarkersEnabledForBounds(architectScene) ? architectSceneBounds(architectScene) : null;
  const combinedBounds = baseBounds && modBounds ? {
    minX: Math.min(baseBounds.minX, modBounds.minX), maxX: Math.max(baseBounds.maxX, modBounds.maxX),
    minY: Math.min(baseBounds.minY, modBounds.minY), maxY: Math.max(baseBounds.maxY, modBounds.maxY)
  } : baseBounds || modBounds;
  const boundsToFit = state.fitBounds || combinedBounds || { minX: 0, maxX: 8, minY: 0, maxY: 8 };
  const minX = boundsToFit?.minX ?? 0, maxX = boundsToFit?.maxX ?? 8;
  const minY = boundsToFit?.minY ?? 0, maxY = boundsToFit?.maxY ?? 8;
  const extentX = Math.max(8, maxX - minX), extentY = Math.max(8, maxY - minY);
  const maxAutoZoom = state.readerMode && !state.readerRoomName ? 180 : 26;
  if (!state.fitted) { state.centerX = (maxX + minX) / 2; state.centerY = (maxY + minY) / 2; state.scale = Math.min((width - 72) / extentX, (height - 96) / extentY, maxAutoZoom); state.fitted = true; }
  state.scale = Math.max(.35, Math.min(140, state.scale));
  const originX = width / 2 - state.centerX * state.scale, originY = height / 2 + state.centerY * state.scale;
  if (state.grid && state.scale >= 3) {
    const spacing = state.scale >= 12 ? 1 : 5;
    ctx.beginPath(); ctx.lineWidth = 1; ctx.strokeStyle = '#d9dbbd0a';
    const left = Math.ceil((state.centerX - width / (2 * state.scale)) / spacing) * spacing;
    const right = state.centerX + width / (2 * state.scale), bottom = state.centerY - height / (2 * state.scale), top = state.centerY + height / (2 * state.scale);
    for (let x = left; x <= right; x += spacing) { ctx.moveTo(Math.round(originX + x * state.scale) + .5, 0); ctx.lineTo(Math.round(originX + x * state.scale) + .5, height); }
    for (let y = Math.ceil(bottom / spacing) * spacing; y <= top; y += spacing) { ctx.moveTo(0, Math.round(originY - y * state.scale) + .5); ctx.lineTo(width, Math.round(originY - y * state.scale) + .5); }
    ctx.stroke();
  }
  const toCanvas = object => ({
    x: originX + (object.worldPosition?.x || 0) * state.scale,
    y: originY - (object.worldPosition?.y || 0) * state.scale
  });
  const gradePreview = selectedGradePreview();
  if (!architectPreview && byId('layerArtwork').checked) {
    if (gradePreview && byId('layerLighting').checked && state.gradePreviewFactor > 0) {
      const artworkCanvas = state.artworkCanvas || (state.artworkCanvas = document.createElement('canvas'));
      if (artworkCanvas.width !== canvas.width || artworkCanvas.height !== canvas.height) {
        artworkCanvas.width = canvas.width; artworkCanvas.height = canvas.height;
      }
      const artworkContext = artworkCanvas.getContext('2d');
      artworkContext.setTransform(ratio, 0, 0, ratio, 0, 0); artworkContext.clearRect(0, 0, width, height);
      drawRoomArtwork(artworkContext, objects, toCanvas, state.scale, byId('layerEffects').checked,
        byId('previewBackgroundBlur').checked, ratio);
      applyGradePreview(artworkCanvas, gradePreview.component, state.gradePreviewFactor);
      ctx.drawImage(artworkCanvas, 0, 0, width, height);
    } else drawRoomArtwork(ctx, objects, toCanvas, state.scale, byId('layerEffects').checked,
      byId('previewBackgroundBlur').checked, ratio);
  }
  drawGameCaptures(ctx, state.scene?.sceneName, originX, originY, width, height, state.scale);
  drawReaderLabels(ctx, originX, originY, width, height);
  if (gradePreview) drawGradeRange(ctx, gradePreview.object, gradePreview.component, originX, originY, state.scale);
  const parentIds = new Set(objects.map(object => object.parentId).filter(Boolean));
  const showObjects = byId('layerObjects').checked, showEnemies = byId('layerEnemies').checked, showSpawns = byId('layerSpawns').checked, showChecks = byId('layerChecks').checked;
  const showColliders = byId('layerColliders').checked;
  if (showColliders) {
    ctx.lineWidth = Math.max(1, Math.min(2, state.scale * .08));
    for (const object of objects) for (const collider of object.colliders || []) {
      if (manualVisibilityFor(object) === 'hide') continue;
      const points = collider.worldPoints || [];
      if (points.length < 2) continue;
      ctx.beginPath();
      points.forEach((point, index) => { const x = originX + point.x * state.scale, y = originY - point.y * state.scale; if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
      if (collider.type !== 'EdgeCollider2D' && points.length > 2) ctx.closePath();
      ctx.strokeStyle = collider.isTrigger ? '#e8b75caa' : '#df756988';
      ctx.setLineDash(collider.isTrigger ? [5, 4] : []);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }
  const visibleObjects = objects.filter(object => { const flags = classifyObject(object); return manualVisibilityFor(object) !== 'hide' && ((showEnemies && flags.enemy) || (showSpawns && flags.spawn) || (showChecks && flags.check) || (showObjects && !flags.enemy && !flags.spawn && !flags.check)); });
  for (const object of visibleObjects) {
    const point = object.worldPosition || { x: 0, y: 0 }, x = originX + point.x * state.scale, y = originY - point.y * state.scale;
    if (x < -12 || x > width + 12 || y < -12 || y > height + 12) continue;
    const flags = classifyObject(object), selected = state.selected?.id === object.id;
    const active = objectIsActive(object);
    const color = flags.enemy ? '#df7569' : flags.spawn ? '#e8b75c' : flags.check ? '#80c9b7' : active ? '#c8c6ad' : '#7b7c72';
    const radius = selected ? 6.5 : flags.enemy || flags.spawn || flags.check ? 4.4 : parentIds.has(object.id) ? 2.5 : 1.8;
    ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fillStyle = color; ctx.globalAlpha = active ? .92 : .44; ctx.fill(); ctx.globalAlpha = 1;
    if (selected) { ctx.beginPath(); ctx.arc(x, y, 10, 0, Math.PI * 2); ctx.strokeStyle = '#d2ebaa'; ctx.lineWidth = 1; ctx.stroke(); }
  }
  drawArchitectOverlay(ctx, architectScene, originX, originY, width, height);
  byId('zoomLevel').textContent = `${Math.round(state.scale / (Math.min((width - 100) / extentX, (height - 110) / maxAutoZoom)) * 100)}%`;
  const canvasPosition = canvas.getBoundingClientRect();
  const pointer = state.pointer;
  if (pointer) { const point = canvasToWorld(pointer.x - canvasPosition.left, pointer.y - canvasPosition.top, width, height); byId('coordinates').innerHTML = `X&nbsp; ${point.x.toFixed(2)} &nbsp;Y&nbsp; ${point.y.toFixed(2)}`; }
}

function renderSortingLayerFilters() {
  const layerRoot = byId('sortingLayerFilters');
  if (!layerRoot) return;
  const layers = new Map();
  for (const artwork of (state.scene?.objects || []).flatMap(object => [
    ...(object.sprites || []), ...(object.meshes || []), ...(object.sortingGroup?.enabled ? [object.sortingGroup] : [])
  ])) {
    const id = Number(artwork.sortingLayerId) || 0;
    if (!layers.has(id)) layers.set(id, {
      id, name: artwork.sortingLayerName || (id === 0 ? 'Default' : `Unknown ID ${id}`),
      known: artwork.sortingLayerKnown !== false, legacyValue: Number(artwork.legacySortingLayer) || 0,
      value: Number(artwork.sortingLayerValue) || 0
    });
  }
  const sortedLayers = [...layers.values()].sort((a, b) => a.value - b.value || a.id - b.id);
  if (!sortedLayers.length) {
    layerRoot.innerHTML = '<span class="filter-empty">No sprite layers found in this room.</span>';
    byId('artworkFilterCount').textContent = 'no layers';
    return;
  }
  layerRoot.innerHTML = sortedLayers.map(layer => {
    const label = layer.known ? `${layer.name} · ID ${layer.id}` : `Unmapped ID ${layer.id} · legacy index ${layer.legacyValue}`;
    const checked = !state.hiddenSortingLayers.has(layer.id);
    return `<label class="filter-check sorting-layer-option"><input type="checkbox" data-sorting-layer-id="${layer.id}" ${checked ? 'checked' : ''}><span>${escapeHtml(label)}</span></label>`;
  }).join('');
  layerRoot.querySelectorAll('[data-sorting-layer-id]').forEach(input => input.addEventListener('change', () => {
    const layer = Number(input.dataset.sortingLayerId);
    if (input.checked) state.hiddenSortingLayers.delete(layer); else state.hiddenSortingLayers.add(layer);
    updateArtworkFilterCount(); drawScene();
  }));
  updateArtworkFilterCount();
}

function updateArtworkFilterCount() {
  const total = byId('sortingLayerFilters')?.querySelectorAll('[data-sorting-layer-id]').length || 0;
  const shown = total - state.hiddenSortingLayers.size;
  byId('artworkFilterCount').textContent = total ? `${shown}/${total} layers` : 'no layers';
}

function drawArtworkLayer(ctx, objects, toCanvas, scale, includeScreenEffects = false, depthPass = null, gameArtworkOnly = false) {
  // Unity sorts a SortingGroup as one unit, then sorts its children internally.
  // Ungrouped renderers remain individual units in the same layer/order/depth sequence.
  const visibleDepthObjects = depthPass ? objects.filter(object => {
    const z = Number(object.worldPosition?.z) || 0;
    if (depthPass.side === 'background') return z >= depthPass.planeZ && Number(object.unityLayer) !== 5;
    return z < depthPass.planeZ;
  }) : objects;
  const renderables = visibleDepthObjects.flatMap((object, objectIndex) => [
    ...(object.sprites || []).map((sprite, rendererIndex) => ({ object, artwork: sprite, type: 'sprite', objectIndex, rendererIndex })),
    ...(object.meshes || []).map((mesh, rendererIndex) => ({ object, artwork: mesh, type: 'mesh', objectIndex, rendererIndex }))
  ]);
  const unitsById = new Map();
  for (const renderable of renderables) {
    const group = renderable.object.sortingGroup?.enabled ? renderable.object.sortingGroup : null;
    const unitId = group ? `group:${group.objectId}` : `single:${renderable.objectIndex}:${renderable.type}:${renderable.rendererIndex}`;
    let unit = unitsById.get(unitId);
    if (!unit) {
      unit = { group, items: [], layer: Number(group?.sortingLayerValue ?? renderable.artwork.sortingLayerValue) || 0,
        order: Number(group?.sortingOrder ?? renderable.artwork.sortingOrder) || 0,
        z: Number(group?.worldPosition?.z ?? renderable.object.worldPosition?.z) || 0,
        stableIndex: renderable.objectIndex };
      unitsById.set(unitId, unit);
    }
    unit.items.push(renderable);
  }
  // Unity uses each SortingGroup root's camera distance for the group as a
  // whole; descendant renderers are ordered by their layer and order only.
  const sortItems = (a, b) =>
    (Number(a.artwork.sortingLayerValue) || 0) - (Number(b.artwork.sortingLayerValue) || 0) ||
    (Number(a.artwork.sortingOrder) || 0) - (Number(b.artwork.sortingOrder) || 0) ||
    a.objectIndex - b.objectIndex || a.rendererIndex - b.rendererIndex;
  const units = [...unitsById.values()].sort((a, b) => a.layer - b.layer || a.order - b.order || b.z - a.z || a.stableIndex - b.stableIndex);
  for (const unit of units) for (const { object, artwork, type } of unit.items.sort(sortItems)) {
    if (type === 'mesh') {
      if (meshPassesFilters(object, artwork, includeScreenEffects, gameArtworkOnly)) drawTexturedMesh(ctx, object, artwork, toCanvas, scale);
      continue;
    }
    const sprite = artwork;
    // Disabled GameObjects and SpriteRenderers remain inspectable in the tree,
    // but Unity does not render them into the room.
    if (!spritePassesFilters(object, sprite, includeScreenEffects, gameArtworkOnly)) continue;
    let image = state.images.get(sprite.imageUrl);
    if (!image) {
      image = loadSceneImage(sprite.imageUrl);
    }
    if (!image.complete || !image.naturalWidth) continue;
    const point = toCanvas(object);
    const rotated = sprite.packingRotation === 4, geometry = spriteLocalGeometry(sprite);
    const { width, height } = geometry;
    const useRendererColor = gameArtworkOnly || byId('applyRendererColors').checked;
    const tintR = Math.max(0, Math.min(1, (useRendererColor ? sprite.tintR ?? 1 : 1) * (sprite.materialTintR ?? 1)));
    const tintG = Math.max(0, Math.min(1, (useRendererColor ? sprite.tintG ?? 1 : 1) * (sprite.materialTintG ?? 1)));
    const tintB = Math.max(0, Math.min(1, (useRendererColor ? sprite.tintB ?? 1 : 1) * (sprite.materialTintB ?? 1)));
    const tint = (tintR + tintG + tintB) / 3;
    const coloredTint = Math.max(tintR, tintG, tintB) - Math.min(tintR, tintG, tintB) > 0.005;
    const tintedCrop = coloredTint ? getTintedSpriteCrop(sprite, image, tintR, tintG, tintB) : null;
    ctx.save();
    ctx.globalAlpha = Math.max(0, Math.min(1, (useRendererColor ? sprite.tintA ?? 1 : 1) * (sprite.materialTintA ?? 1)));
    ctx.globalCompositeOperation = canvasBlendMode(sprite.blendMode);
    const matrix = spriteWorldMatrix(sprite);
    ctx.filter = useRendererColor && !tintedCrop ? `brightness(${tint})` : 'none'; ctx.translate(point.x, point.y);
    // Canvas Y grows down; reflect the complete Unity hierarchy matrix once here.
    ctx.transform(matrix.m00 * scale, -matrix.m10 * scale, matrix.m01 * scale, -matrix.m11 * scale, 0, 0);
    // SpriteRenderer flips mirror its mesh around the GameObject pivot, separately
    // from Transform scale. Apply them before moving to the trimmed sprite center.
    ctx.scale(sprite.flipX ? -1 : 1, sprite.flipY ? -1 : 1);
    const sourceY = sprite.textureHeight - sprite.rectY - sprite.rectHeight;
    ctx.translate(geometry.left + width / 2, geometry.bottom + height / 2);
    const meshVertices = sprite.meshVertices || [], meshIndices = sprite.meshIndices || [];
    if (meshVertices.length >= 3 && meshIndices.length >= 3) {
      ctx.beginPath();
      for (let index = 0; index + 2 < meshIndices.length; index += 3) {
        const a = meshVertices[meshIndices[index]], b = meshVertices[meshIndices[index + 1]], c = meshVertices[meshIndices[index + 2]];
        if (!a || !b || !c) continue;
        const pointX = vertex => vertex.x - (geometry.left + width / 2);
        const pointY = vertex => vertex.y - (geometry.bottom + height / 2);
        ctx.moveTo(pointX(a), pointY(a)); ctx.lineTo(pointX(b), pointY(b)); ctx.lineTo(pointX(c), pointY(c)); ctx.closePath();
      }
      ctx.clip();
    }
    // Canvas applies the last matrix call first. Flip packed atlas coordinates
    // out of their rotation, then convert top-down texture rows to Unity Y-up.
    ctx.scale(1, -1);
    if (sprite.packingRotation === 1) ctx.scale(-1, 1);
    else if (sprite.packingRotation === 2) ctx.scale(1, -1);
    else if (sprite.packingRotation === 3) ctx.rotate(Math.PI);
    else if (rotated) ctx.rotate(-Math.PI / 2);
    const sourceWidth = rotated ? height : width;
    const sourceHeight = rotated ? width : height;
    if (tintedCrop) ctx.drawImage(tintedCrop, 0, 0, tintedCrop.width, tintedCrop.height,
      -sourceWidth / 2, -sourceHeight / 2, sourceWidth, sourceHeight);
    else ctx.drawImage(image, sprite.rectX, sourceY, sprite.rectWidth, sprite.rectHeight,
      -sourceWidth / 2, -sourceHeight / 2, sourceWidth, sourceHeight);
    ctx.restore();
  }
}

function activeBlurPlaneZ(objects) {
  const planes = objects.filter(object => objectIsActive(object) &&
    (object.components || []).some(component => component.scriptName === 'BlurPlane'));
  return planes.length ? Math.min(...planes.map(object => Number(object.worldPosition?.z) || 0)) : null;
}

function drawRoomArtwork(ctx, objects, toCanvas, scale, includeScreenEffects, previewBlur, pixelRatio = 1) {
  const planeZ = previewBlur ? activeBlurPlaneZ(objects) : null;
  if (!Number.isFinite(planeZ)) {
    drawArtworkLayer(ctx, objects, toCanvas, scale, includeScreenEffects);
    return;
  }
  const bg = state.backgroundCanvas || (state.backgroundCanvas = document.createElement('canvas'));
  if (bg.width !== ctx.canvas.width || bg.height !== ctx.canvas.height) { bg.width = ctx.canvas.width; bg.height = ctx.canvas.height; }
  const logicalWidth = bg.width / pixelRatio, logicalHeight = bg.height / pixelRatio;
  const bgContext = bg.getContext('2d');
  bgContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0); bgContext.clearRect(0, 0, logicalWidth, logicalHeight);
  drawArtworkLayer(bgContext, objects, toCanvas, scale, includeScreenEffects, { side: 'background', planeZ });
  // Silksong's LightBlur applies two horizontal/vertical shader pairs to a
  // lower-resolution second camera. A small Gaussian blur is a depth-aware
  // browser approximation; every source pixel still comes from the real room.
  ctx.save(); ctx.filter = 'blur(4px)'; ctx.drawImage(bg, 0, 0, logicalWidth, logicalHeight); ctx.restore();
  drawArtworkLayer(ctx, objects, toCanvas, scale, includeScreenEffects, { side: 'foreground', planeZ });
}

function getTintedSpriteCrop(sprite, image, tintR, tintG, tintB) {
  const key = [sprite.imageUrl, sprite.rectX, sprite.rectY, sprite.rectWidth, sprite.rectHeight, tintR, tintG, tintB].join('|');
  if (state.tintedSpriteImages.has(key)) return state.tintedSpriteImages.get(key);
  try {
    const crop = document.createElement('canvas');
    crop.width = Math.max(1, Math.ceil(sprite.rectWidth)); crop.height = Math.max(1, Math.ceil(sprite.rectHeight));
    const cropContext = crop.getContext('2d', { willReadFrequently: true });
    const sourceY = sprite.textureHeight - sprite.rectY - sprite.rectHeight;
    cropContext.drawImage(image, sprite.rectX, sourceY, sprite.rectWidth, sprite.rectHeight, 0, 0, crop.width, crop.height);
    const pixels = cropContext.getImageData(0, 0, crop.width, crop.height), data = pixels.data;
    for (let index = 0; index < data.length; index += 4) {
      data[index] = Math.round(data[index] * tintR);
      data[index + 1] = Math.round(data[index + 1] * tintG);
      data[index + 2] = Math.round(data[index + 2] * tintB);
    }
    cropContext.putImageData(pixels, 0, 0);
    state.tintedSpriteImages.set(key, crop);
    return crop;
  } catch {
    state.tintedSpriteImages.set(key, null);
    return null;
  }
}

function drawTexturedMesh(ctx, object, mesh, toCanvas, scale) {
  const asset = state.meshAssets.get(mesh.meshAssetId), submesh = asset?.submeshes?.[mesh.submeshIndex];
  const image = state.images.get(mesh.imageUrl) || loadSceneImage(mesh.imageUrl);
  if (!asset || !submesh || submesh.topology !== 0 || !image.complete || !image.naturalWidth) return;
  const vertices = asset.vertices || [], indices = submesh.indices || [], point = object.worldPosition || { x: 0, y: 0 };
  const matrix = { m00: mesh.worldM00 ?? 1, m01: mesh.worldM01 ?? 0, m10: mesh.worldM10 ?? 0, m11: mesh.worldM11 ?? 1 };
  const textureWidth = mesh.textureWidth || image.naturalWidth, textureHeight = mesh.textureHeight || image.naturalHeight;
  const tintR = Number.isFinite(mesh.tintR) ? mesh.tintR : 1, tintG = Number.isFinite(mesh.tintG) ? mesh.tintG : 1;
  const tintB = Number.isFinite(mesh.tintB) ? mesh.tintB : 1, tintA = Number.isFinite(mesh.tintA) ? mesh.tintA : 1;
  const transformed = new Array(vertices.length);
  const meshPoint = index => {
    const vertex = vertices[index];
    if (!vertex) return null;
    if (!transformed[index]) {
      const world = { x: point.x + matrix.m00 * vertex.x + matrix.m01 * vertex.y,
        y: point.y + matrix.m10 * vertex.x + matrix.m11 * vertex.y };
      const screen = toCanvas({ worldPosition: world });
      transformed[index] = { x: screen.x, y: screen.y,
        u: (vertex.u * mesh.textureScaleX + mesh.textureOffsetX) * textureWidth,
        v: textureHeight - (vertex.v * mesh.textureScaleY + mesh.textureOffsetY) * textureHeight,
        r: vertex.r ?? 1, g: vertex.g ?? 1, b: vertex.b ?? 1, a: vertex.a ?? 1 };
    }
    return transformed[index];
  };
  for (let index = 0; index + 2 < indices.length; index += 3) {
    const a = meshPoint(indices[index]), b = meshPoint(indices[index + 1]), c = meshPoint(indices[index + 2]);
    if (!a || !b || !c) continue;
    const determinant = (b.u - a.u) * (c.v - a.v) - (c.u - a.u) * (b.v - a.v);
    const screenArea = (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
    if (Math.abs(determinant) < 1e-6 || Math.abs(screenArea) < 1e-6) continue;
    const sx1 = b.u - a.u, sy1 = b.v - a.v, sx2 = c.u - a.u, sy2 = c.v - a.v;
    const dx1 = b.x - a.x, dy1 = b.y - a.y, dx2 = c.x - a.x, dy2 = c.y - a.y;
    const aa = (dx1 * sy2 - dx2 * sy1) / determinant, cc = (sx1 * dx2 - sx2 * dx1) / determinant;
    const bb = (dy1 * sy2 - dy2 * sy1) / determinant, dd = (sx1 * dy2 - sx2 * dy1) / determinant;
    const ee = a.x - aa * a.u - cc * a.v, ff = a.y - bb * a.u - dd * a.v;
    const vertexTintR = Math.max(0, Math.min(2, (a.r + b.r + c.r) / 3 * tintR));
    const vertexTintG = Math.max(0, Math.min(2, (a.g + b.g + c.g) / 3 * tintG));
    const vertexTintB = Math.max(0, Math.min(2, (a.b + b.b + c.b) / 3 * tintB));
    const averageTint = (vertexTintR + vertexTintG + vertexTintB) / 3;
    ctx.save();
    ctx.globalCompositeOperation = canvasBlendMode(mesh.blendMode);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(c.x, c.y); ctx.closePath(); ctx.clip();
    ctx.globalAlpha = Math.max(0, Math.min(1, tintA * (a.a + b.a + c.a) / 3));
    ctx.filter = `brightness(${averageTint})`;
    ctx.transform(aa, bb, cc, dd, ee, ff);
    ctx.drawImage(image, 0, 0, textureWidth, textureHeight);
    ctx.restore();
  }
}

function canvasBlendMode(mode) {
  return mode === 'additive' ? 'lighter' : mode === 'multiply' ? 'multiply' : 'source-over';
}

function isScreenEffect(object, sprite) {
  const name = `${object.name || ''} ${sprite.name || ''}`.toLowerCase();
  return name.includes('black_solid') || name.includes('white_fader') || name.includes('black_fader') ||
    name.includes('vignette') || name.includes('darkness') || name.includes('mask_beam') ||
    name.includes('soft_masker') || name.includes('remasker');
}

function isLightingArtwork(object, artwork) {
  const name = `${object.name || ''} ${artwork.name || ''}`.toLowerCase();
  return name.includes('light_effect') || name.includes('white_light') || name.includes('light_beam') ||
    name.includes('water_fog') || /\b(light|fog|haze|glow)\b/.test(name);
}

function isBackgroundArtwork(object, artwork) {
  const name = `${object.name || ''} ${artwork.name || ''}`.toLowerCase();
  const z = Number(object.worldPosition?.z || 0);
  const layer = String(artwork.sortingLayerName || object.sortingGroup?.sortingLayerName || '').toLowerCase();
  return /\b(background|backdrop|parallax|far_bg|bg_layer)\b/.test(name) ||
    /\b(far|mid|immediate)\s*bg\b/.test(layer) || z >= 15;
}

function loadSceneImage(url) {
  let image = state.images.get(url);
  if (!image) {
    image = new Image(); state.images.set(url, image);
    image.onload = () => { if (!state.batchRendering) drawScene(); };
    image.onerror = () => state.images.delete(url); image.src = url;
  }
  return image;
}

function canvasToWorld(x, y, width, height) { return { x: (x - width / 2) / state.scale + state.centerX, y: (height / 2 - y) / state.scale + state.centerY }; }

function selectObject(object) {
  if (!object) return;
  state.selected = object;
  renderObjectTree();
  const flags = classifyObject(object), world = object.worldPosition || { x: 0, y: 0 };
  const label = flags.enemy ? 'ENEMY CANDIDATE' : flags.spawn ? 'SPAWN SOURCE CANDIDATE' : flags.check ? 'CHECK CANDIDATE' : 'AUTHORED OBJECT';
  const tint = flags.enemy ? '#df7569' : flags.spawn ? '#e8b75c' : flags.check ? '#80c9b7' : '#c9e699';
  const visibility = state.objectVisibilityOverrides.get(object.id) || 'auto';
  byId('selectionContent').innerHTML = `<div class="selection-name">${escapeHtml(object.name || '(unnamed)')}</div><div class="selection-type" style="color:${tint}">${label}</div><div class="selection-copy"><span>World position</span><strong>${world.x.toFixed(3)}, ${world.y.toFixed(3)}, ${world.z.toFixed(3)}</strong></div><div class="selection-copy"><span>Active on object</span><strong>${object.active ? 'YES' : 'NO'}</strong></div><div class="selection-copy"><span>Active in room</span><strong>${objectIsActive(object) ? 'YES' : 'NO'}</strong></div><label class="selection-visibility">Render override<select id="selectedVisibilityOverride"><option value="auto" ${visibility === 'auto' ? 'selected' : ''}>Auto · serialized</option><option value="show" ${visibility === 'show' ? 'selected' : ''}>Force visible</option><option value="hide" ${visibility === 'hide' ? 'selected' : ''}>Hide</option></select></label><div class="tag-list">${componentsOf(object).map(component => `<span class="tag">${escapeHtml(component.scriptName || component.type)}</span>`).join('')}</div>`;
  byId('selectedVisibilityOverride').addEventListener('change', event => {
    setObjectVisibilityOverride(object.id, event.target.value);
    refreshCameraLockAreas();
    renderStateOverrideRows(); drawScene(); selectObject(object);
  });
  drawScene();
}

async function exportSceneImage() {
  if (state.architectPreviewName) {
    showToast('Select a Silksong room to export its game textures. Architect data does not contain room artwork.');
    return;
  }
  const objects = state.scene?.objects || [];
  if (!objects.length) return;
  const exportName = state.scene.sceneName;
  const includeScreenEffects = byId('layerEffects').checked;
  const eligibleArtwork = objects.flatMap(object => [
    ...(object.sprites || []).filter(sprite => spritePassesFilters(object, sprite, includeScreenEffects, true)),
    ...(object.meshes || []).filter(mesh => meshPassesFilters(object, mesh, includeScreenEffects, true))
  ]);
  const assetUrls = [...new Set(eligibleArtwork.map(art => art.imageUrl).filter(isGameBundleTexture))];
  const includeCaptures = state.gameCapturesEnabled && byId('layerArtwork').checked;
  let captureFrames = includeCaptures ? capturesForCurrentScene() : [];
  if (state.gameCaptureView === 'latest') captureFrames = captureFrames.slice(-1);
  else if (state.gameCaptureView !== 'all') captureFrames = captureFrames.filter(capture => capture.id === state.gameCaptureView);
  await Promise.all([
    ...assetUrls.map(url => new Promise(resolve => {
      const asset = loadSceneImage(url);
      if (asset.complete) resolve(); else { asset.onload = resolve; asset.onerror = resolve; }
    })),
    ...captureFrames.map(capture => new Promise(resolve => {
      const image = captureImage(capture);
      if (!image || image.complete) resolve();
      else { image.addEventListener('load', resolve, { once: true }); image.addEventListener('error', resolve, { once: true }); }
    }))
  ]);
  captureFrames = captureFrames.filter(capture => capture.image?.naturalWidth > 0);
  const artworkBounds = visibleSpriteBounds(objects, includeScreenEffects, true);
  const captureBounds = unionArtworkBounds(...captureFrames.map(cameraWorldBounds));
  const bounds = unionArtworkBounds(artworkBounds, captureBounds);
  if (!bounds) {
    showToast('No renderable Silksong bundle textures or selected game captures were found for this room.');
    return;
  }

  const spanX = Math.max(.001, bounds.maxX - bounds.minX), spanY = Math.max(.001, bounds.maxY - bounds.minY);
  const nativePpu = Math.max(nativeArtworkPixelsPerUnit(objects, includeScreenEffects), ...captureFrames.map(capturePixelsPerUnit), 1);
  const pad = 2, ppu = nativePpu;
  const width = Math.max(1, Math.ceil(spanX * ppu)) + pad * 2;
  const height = Math.max(1, Math.ceil(spanY * ppu)) + pad * 2;
  if (width > 0x7fffffff || height > 0x7fffffff) { showToast('This room exceeds PNG dimension limits at native texture resolution.'); return; }
  const fitsSingleCanvas = width <= 32760 && height <= 32760 && width * height <= 100_000_000;
  try {
    let blob;
    if (fitsSingleCanvas) {
      const image = document.createElement('canvas'); image.width = width; image.height = height;
      const context = image.getContext('2d');
      if (!context) { showToast('The browser could not allocate a canvas for this room.'); return; }
      context.clearRect(0, 0, width, height);
      context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
      drawArtworkLayer(context, objects, object => {
        const point = object.worldPosition || { x: 0, y: 0 };
        return { x: pad + (point.x - bounds.minX) * ppu, y: pad + (bounds.maxY - point.y) * ppu };
      }, ppu, includeScreenEffects, null, true);
      if (captureFrames.length) drawGameCaptures(context, exportName, pad - bounds.minX * ppu,
        pad + bounds.maxY * ppu, width, height, ppu, false);
      blob = await new Promise(resolve => image.toBlob(resolve, 'image/png'));
      image.width = 1; image.height = 1;
    } else {
      blob = await renderBatchScenePngTiled(objects, bounds, ppu, width, height, includeScreenEffects,
        (context, x, y) => {
          if (captureFrames.length) drawGameCaptures(context, exportName, pad - bounds.minX * ppu - x,
            pad + bounds.maxY * ppu - y, width, height, ppu, false);
        }, (tile, total) => showToast(`Writing full-resolution PNG · tile ${tile.toLocaleString()} / ${total.toLocaleString()}`));
    }
    if (!blob) { showToast('Could not encode the full-resolution room PNG.'); return; }
    downloadBlob(blob, `${safeFilename(exportName)}-room.png`);
    showToast(`Clean room PNG exported · ${width.toLocaleString()} × ${height.toLocaleString()} px · native ${ppu.toFixed(1)} px/unit.`);
  } catch (error) {
    showToast(`Could not create the full-resolution room PNG: ${error?.message || error}`);
  }
}

function uniqueBatchSceneEntries() {
  const seen = new Set(), entries = [];
  for (const entry of state.scenes) {
    const key = String(entry.bundleFile || entry.candidateName || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key); entries.push(entry);
  }
  return entries;
}

function waitForDecodedImage(image) {
  if (image.complete) return Promise.resolve(image.naturalWidth > 0);
  return new Promise(resolve => {
    image.addEventListener('load', () => resolve(true), { once: true });
    image.addEventListener('error', () => resolve(false), { once: true });
  });
}

async function withBatchSceneState(scene, callback) {
  const previous = {
    scene: state.scene, objectById: state.objectById, meshAssets: state.meshAssets,
    objectVisibilityOverrides: state.objectVisibilityOverrides, hiddenSortingLayers: state.hiddenSortingLayers,
    images: state.images, tintedSpriteImages: state.tintedSpriteImages,
    architectPreviewName: state.architectPreviewName
  };
  const objects = scene.objects || [];
  state.scene = scene;
  state.images = new Map();
  state.tintedSpriteImages = new Map();
  state.objectById = new Map(objects.map(object => [object.id, object]));
  state.meshAssets = new Map((scene.meshAssets || []).map(mesh => [mesh.id, mesh]));
  state.objectVisibilityOverrides = new Map();
  state.hiddenSortingLayers = new Set();
  state.architectPreviewName = null;
  try { return await callback(objects); }
  finally {
    for (const image of state.images.values()) { image.onload = null; image.onerror = null; image.src = ''; }
    state.images.clear(); state.tintedSpriteImages.clear();
    Object.assign(state, previous);
  }
}

function encodePngChunk(type, data) {
  const typeBytes = new TextEncoder().encode(type);
  const chunk = new Uint8Array(data.length + 12), view = new DataView(chunk.buffer);
  view.setUint32(0, data.length, false); chunk.set(typeBytes, 4); chunk.set(data, 8);
  let crc = 0xffffffff;
  for (const byte of typeBytes) crc = zipCrcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  for (const byte of data) crc = zipCrcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  view.setUint32(data.length + 8, (crc ^ 0xffffffff) >>> 0, false);
  return chunk;
}

async function renderBatchScenePngTiled(objects, bounds, ppu, width, height, includeScreenEffects, drawTile = null, onProgress = null) {
  if (typeof CompressionStream !== 'function') throw new Error('This browser does not support streaming full-resolution PNG export.');
  const tileWidth = 8192, tileHeight = 512, pad = 2;
  const tileCanvas = document.createElement('canvas'), tileContext = tileCanvas.getContext('2d', { willReadFrequently: true });
  if (!tileContext) throw new Error('The browser could not allocate a tile canvas for this room.');
  const compressor = new CompressionStream('deflate'), reader = compressor.readable.getReader(), writer = compressor.writable.getWriter();
  const compressedChunks = [];
  const readCompressed = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      compressedChunks.push(value.slice());
    }
  })();
  const totalTiles = Math.ceil(width / tileWidth) * Math.ceil(height / tileHeight);
  let completedTiles = 0;
  const fullToCanvas = object => {
    const point = object.worldPosition || { x: 0, y: 0 };
    return { x: pad + (point.x - bounds.minX) * ppu, y: pad + (bounds.maxY - point.y) * ppu };
  };
  try {
    for (let y = 0; y < height; y += tileHeight) {
      const bandHeight = Math.min(tileHeight, height - y), rowBytes = width * 4 + 1;
      const band = new Uint8Array(rowBytes * bandHeight);
      for (let x = 0; x < width; x += tileWidth) {
        const currentWidth = Math.min(tileWidth, width - x);
        tileCanvas.width = currentWidth; tileCanvas.height = bandHeight;
        tileContext.clearRect(0, 0, currentWidth, bandHeight);
        tileContext.imageSmoothingEnabled = true; tileContext.imageSmoothingQuality = 'high';
        const toTileCanvas = object => { const point = fullToCanvas(object); return { x: point.x - x, y: point.y - y }; };
        drawArtworkLayer(tileContext, objects, toTileCanvas, ppu, includeScreenEffects, null, true);
        if (drawTile) drawTile(tileContext, x, y, currentWidth, bandHeight, width, height, ppu);
        const pixels = tileContext.getImageData(0, 0, currentWidth, bandHeight).data;
        for (let row = 0; row < bandHeight; row++) {
          const sourceOffset = row * currentWidth * 4;
          const targetOffset = row * rowBytes + 1 + x * 4;
          band.set(pixels.subarray(sourceOffset, sourceOffset + currentWidth * 4), targetOffset);
        }
        completedTiles++;
        if (onProgress) onProgress(completedTiles, totalTiles);
        await writer.write(band);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    await writer.close();
    await readCompressed;
  } catch (error) {
    try { await writer.abort(error); } catch { }
    try { await reader.cancel(error); } catch { }
    await readCompressed.catch(() => {});
    tileCanvas.width = 1; tileCanvas.height = 1;
    throw error;
  }
  tileCanvas.width = 1; tileCanvas.height = 1;
  const header = new Uint8Array(13), headerView = new DataView(header.buffer);
  headerView.setUint32(0, width, false); headerView.setUint32(4, height, false);
  header[8] = 8; header[9] = 6; header[10] = 0; header[11] = 0; header[12] = 0;
  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [signature, encodePngChunk('IHDR', header)];
  for (const compressed of compressedChunks) parts.push(encodePngChunk('IDAT', compressed));
  parts.push(encodePngChunk('IEND', new Uint8Array()));
  return new Blob(parts, { type: 'image/png' });
}

function spriteIntersectsWorldBounds(object, sprite, bounds) {
  const geometry = spriteLocalGeometry(sprite), matrix = spriteWorldMatrix(sprite);
  const point = object.worldPosition || { x: 0, y: 0 };
  const xs = [], ys = [];
  for (const [localX, localY] of [[geometry.left, geometry.bottom], [geometry.right, geometry.bottom], [geometry.left, geometry.top], [geometry.right, geometry.top]]) {
    xs.push(point.x + matrix.m00 * localX + matrix.m01 * localY);
    ys.push(point.y + matrix.m10 * localX + matrix.m11 * localY);
  }
  return Math.max(...xs) >= bounds.minX && Math.min(...xs) <= bounds.maxX &&
    Math.max(...ys) >= bounds.minY && Math.min(...ys) <= bounds.maxY;
}

function meshIntersectsWorldBounds(object, mesh, bounds) {
  const asset = state.meshAssets.get(mesh.meshAssetId), vertices = asset?.vertices || [];
  if (!vertices.length) return false;
  const matrix = { m00: mesh.worldM00 ?? 1, m01: mesh.worldM01 ?? 0, m10: mesh.worldM10 ?? 0, m11: mesh.worldM11 ?? 1 };
  const point = object.worldPosition || { x: 0, y: 0 }, xs = [], ys = [];
  for (const vertex of vertices) {
    xs.push(point.x + matrix.m00 * vertex.x + matrix.m01 * vertex.y);
    ys.push(point.y + matrix.m10 * vertex.x + matrix.m11 * vertex.y);
  }
  return Math.max(...xs) >= bounds.minX && Math.min(...xs) <= bounds.maxX &&
    Math.max(...ys) >= bounds.minY && Math.min(...ys) <= bounds.maxY;
}

function objectsVisibleWithinWorldBounds(objects, bounds, includeScreenEffects = false) {
  return objects.map(object => {
    if (!objectIsActive(object) || (object.sortingGroup?.enabled && object.sortingGroup.sortingLayerKnown === false)) return null;
    const sprites = (object.sprites || []).filter(sprite => spritePassesFilters(object, sprite, includeScreenEffects, true) &&
      spriteIntersectsWorldBounds(object, sprite, bounds));
    const meshes = (object.meshes || []).filter(mesh => meshPassesFilters(object, mesh, includeScreenEffects, true) &&
      meshIntersectsWorldBounds(object, mesh, bounds));
    return sprites.length || meshes.length ? { ...object, sprites, meshes } : null;
  }).filter(Boolean);
}

function batchCameraSections(objects) {
  const sections = cameraLockAreas(objects).map((area, index) => ({
    key: `camera:${area.id || index}`, name: String(area.name || `Camera area ${index + 1}`).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim(),
    bounds: area.bounds, width: area.bounds.maxX - area.bounds.minX, height: area.bounds.maxY - area.bounds.minY,
    aspect: (area.bounds.maxX - area.bounds.minX) / (area.bounds.maxY - area.bounds.minY)
  })).filter(section => section.width >= .5 && section.height >= .5);
  const counts = new Map();
  for (const section of sections) counts.set(section.name, (counts.get(section.name) || 0) + 1);
  const seen = new Map();
  for (const section of sections) if (counts.get(section.name) > 1) {
    const index = (seen.get(section.name) || 0) + 1; seen.set(section.name, index); section.name += ` · ${index}`;
  }
  return sections;
}

async function renderBatchCameraSections(objects, includeScreenEffects, outputName, target, onProgress = null) {
  const sections = batchCameraSections(objects), images = [];
  for (let index = 0; index < sections.length; index++) {
    const section = sections[index], cameraObjects = objectsVisibleWithinWorldBounds(objects, section.bounds, includeScreenEffects);
    const rendered = await renderBatchScene(cameraObjects, includeScreenEffects, onProgress, section.bounds,
      { maxEdge: 16379, maxPixels: 100_000_000 });
    if (!rendered.blob) continue;
    const file = `images/${outputName.replace(/-native$/, '')}-camera-${String(index + 1).padStart(2, '0')}.png`;
    await writeBatchFile(target, file, rendered.blob);
    images.push({ key: section.key, name: section.name, bounds: section.bounds, width: rendered.width, height: rendered.height,
      pixelsPerWorldUnit: rendered.ppu, nativePixelsPerWorldUnit: rendered.nativePpu, resolutionLimited: rendered.resolutionLimited,
      file, rendererCount: rendered.rendererCount, textureCount: rendered.textureCount,
      missingTextureSha256: rendered.missingTextures });
  }
  return images;
}

async function renderBatchScene(objects, includeScreenEffects, onProgress = null, boundsOverride = null, outputLimits = null) {
  const eligible = objects.flatMap(object => [
    ...(object.sprites || []).filter(sprite => spritePassesFilters(object, sprite, includeScreenEffects, true)),
    ...(object.meshes || []).filter(mesh => meshPassesFilters(object, mesh, includeScreenEffects, true))
  ]);
  const textureUrls = [...new Set(eligible.map(artwork => artwork.imageUrl).filter(isGameBundleTexture))];
  const textureResults = await Promise.all(textureUrls.map(async url => {
    const image = loadSceneImage(url);
    return { url, loaded: await waitForDecodedImage(image) };
  }));
  const missingTextures = textureResults.filter(result => !result.loaded).map(result => textureHashFromUrl(result.url));
  const bounds = boundsOverride || visibleSpriteBounds(objects, includeScreenEffects, true);
  if (!bounds) return { blob: null, bounds: null, width: 0, height: 0, ppu: 0,
    nativePpu: 0, resolutionLimited: false, rendererCount: 0, textureCount: textureUrls.length, missingTextures, screenEffectsIncluded: includeScreenEffects };

  const spanX = Math.max(.001, bounds.maxX - bounds.minX), spanY = Math.max(.001, bounds.maxY - bounds.minY);
  const nativePpu = Math.max(nativeArtworkPixelsPerUnit(objects, includeScreenEffects), 1);
  const pad = 2, nativeWidth = Math.max(1, Math.ceil(spanX * nativePpu)) + pad * 2;
  const nativeHeight = Math.max(1, Math.ceil(spanY * nativePpu)) + pad * 2;
  if (nativeWidth > 0x7fffffff || nativeHeight > 0x7fffffff) throw new Error('The native-resolution room exceeds PNG dimension limits.');
  const maxEdge = outputLimits?.maxEdge || 32760, previewMaxPixels = outputLimits?.maxPixels || 25_000_000;
  const previewPpu = Math.min(nativePpu, maxEdge / spanX, maxEdge / spanY, Math.sqrt(previewMaxPixels / (spanX * spanY)));
  const previewWidth = Math.max(1, Math.ceil(spanX * previewPpu)) + pad * 2;
  const previewHeight = Math.max(1, Math.ceil(spanY * previewPpu)) + pad * 2;
  const fitsSingleCanvas = nativeWidth <= maxEdge && nativeHeight <= maxEdge && nativeWidth * nativeHeight <= (outputLimits?.maxPixels || 100_000_000);
  const cappedCameraOutput = Boolean(outputLimits) && !fitsSingleCanvas;
  const width = cappedCameraOutput ? previewWidth : fitsSingleCanvas ? nativeWidth : previewWidth;
  const height = cappedCameraOutput ? previewHeight : fitsSingleCanvas ? nativeHeight : previewHeight;
  const ppu = cappedCameraOutput ? previewPpu : fitsSingleCanvas ? nativePpu : previewPpu;
  const toCanvas = object => {
    const point = object.worldPosition || { x: 0, y: 0 };
    return { x: pad + (point.x - bounds.minX) * ppu, y: pad + (bounds.maxY - point.y) * ppu };
  };
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The browser could not allocate a canvas for this room.');
  context.clearRect(0, 0, width, height);
  context.imageSmoothingEnabled = true; context.imageSmoothingQuality = 'high';
  drawArtworkLayer(context, objects, toCanvas, ppu, includeScreenEffects, null, true);
  const canvasBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  canvas.width = 1; canvas.height = 1;
  if (!canvasBlob) throw new Error(`The browser could not encode the ${fitsSingleCanvas ? 'room' : 'fast room preview'} PNG.`);
  const previewBlob = fitsSingleCanvas || cappedCameraOutput ? null : canvasBlob;
  const blob = fitsSingleCanvas || cappedCameraOutput ? canvasBlob : await renderBatchScenePngTiled(objects, bounds, nativePpu, nativeWidth, nativeHeight, includeScreenEffects, null, onProgress);
  if (!blob) throw new Error('The browser could not encode the full-resolution room PNG.');
  return { blob, previewBlob, width: cappedCameraOutput ? width : nativeWidth, height: cappedCameraOutput ? height : nativeHeight,
    ppu: cappedCameraOutput ? ppu : nativePpu, nativePpu, bounds, resolutionLimited: cappedCameraOutput,
    previewWidth: fitsSingleCanvas ? nativeWidth : previewWidth, previewHeight: fitsSingleCanvas ? nativeHeight : previewHeight,
    previewPpu: fitsSingleCanvas ? nativePpu : previewPpu,
    rendererCount: eligible.length, textureCount: textureUrls.length, missingTextures, screenEffectsIncluded: includeScreenEffects };
}

async function renderBatchWorldMapAssets(target) {
  try {
    const mapScene = await getJson('/api/world-map');
    buildReaderModel(mapScene);
    const mapImages = {};
    for (const [key, objects] of [['wide', state.readerWideObjects], ['detail', state.readerDetailObjects]]) {
      const render = await withBatchSceneState(mapScene, async () => {
        state.hiddenSortingLayers = new Set(objects.flatMap(object => [
          ...(object.sprites || []), ...(object.meshes || []), ...(object.sortingGroup?.enabled ? [object.sortingGroup] : [])
        ]).filter(artwork => artwork.sortingLayerKnown === false).map(artwork => Number(artwork.sortingLayerId) || 0));
        return await renderBatchScene(objects, false);
      });
      if (render.blob) await writeBatchFile(target, `maps/${key}.png`, render.blob);
      mapImages[key] = render.blob ? {
        file: `maps/${key}.png`, width: render.width, height: render.height,
        pixelsPerWorldUnit: render.ppu, bounds: render.bounds, rendererCount: render.rendererCount,
        textureCount: render.textureCount, missingTextureSha256: render.missingTextures
      } : null;
    }
    const navigation = {
      format: 'silksong-room-atlas-navigation', formatVersion: 1,
      maps: mapImages,
      areas: state.readerAreas.map(area => ({
        key: area.key, name: area.name, widePosition: area.widePosition,
        wideBounds: area.wideBounds, detailBounds: area.detailBounds,
        rooms: area.rooms.map(room => ({ name: room.scene.candidateName, bounds: room.bounds, center: room.center }))
      }))
    };
    await writeBatchFile(target, 'maps/navigation.json', new Blob([JSON.stringify(navigation)], { type: 'application/json' }));
    return { status: 'ready', areaCount: navigation.areas.length, maps: mapImages };
  } catch (error) {
    const message = String(error?.message || error);
    return { status: 'failed', error: message };
  }
}

async function preloadBatchArchitectEnemyArtwork() {
  const placementIds = [...new Set([...state.architectScenes.values()].flatMap(scene =>
    architectScenePlacements(scene).filter(architectPlacementIsEnemy).map(record => String(record.placement?.id || '').trim())
  ).filter(Boolean))];
  for (let offset = 0; offset < placementIds.length; offset += 150) {
    const result = await getJson('/api/enemy-artwork', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ placementIds: placementIds.slice(offset, offset + 150) })
    });
    for (const [key, artwork] of Object.entries(result.artwork || {}))
      state.architectEnemyArt.set(normalizeArchitectEnemyId(key), artwork);
  }
  return placementIds.length;
}

function textureHashFromUrl(url) {
  return typeof url === 'string' ? url.match(/^\/api\/artwork\/([a-f0-9]{64})\.png$/i)?.[1]?.toLowerCase() || null : null;
}

function portableRendererMetadata(renderer) {
  const { imageUrl, ...details } = renderer;
  return { ...details, textureSha256: textureHashFromUrl(imageUrl) };
}

function batchImagePoint(point, render) {
  if (!point || !render?.bounds || !render.ppu) return null;
  return {
    x: 2 + ((Number(point.x) || 0) - render.bounds.minX) * render.ppu,
    y: 2 + (render.bounds.maxY - (Number(point.y) || 0)) * render.ppu
  };
}

function buildBatchArchitectMetadata(scene, render) {
  if (!scene) return null;
  const sourceFolder = String(state.architectSource || '').split(/[\\/]/).pop() || null;
  try {
    const enemyIds = [...new Set(architectScenePlacements(scene).filter(architectPlacementIsEnemy)
      .map(record => String(record.placement?.id || '').trim()).filter(Boolean))];
    const enemyArtwork = Object.fromEntries(enemyIds.map(id => {
      const artwork = state.architectEnemyArt.get(normalizeArchitectEnemyId(id));
      return [normalizeArchitectEnemyId(id), artwork?.sprite
        ? { placementId: id, objectName: artwork.objectName, sourceBundle: artwork.sourceBundle,
          offsetX: artwork.offsetX || 0, offsetY: artwork.offsetY || 0, sprite: portableRendererMetadata(artwork.sprite) }
        : null];
    }).filter(([, artwork]) => artwork));
    return {
      sourceFolder, sceneName: scene.name, markersVisibleByDefault: false,
      markers: architectMarkerRecords(scene).map(record => {
        const point = architectPlacementPosition(record);
        return {
          key: record.key, label: architectPlacementLabel(record), kind: record.virtualEvent ? 'event-phase' : 'gauntlet',
          placementId: record.placement?.id || null, worldPosition: point, imagePixel: batchImagePoint(point, render),
          virtualEvent: record.virtualEvent || null, virtualEndEvent: record.virtualEndEvent || null,
          placementCount: record.markerPlacementCount || 0, placementKey: record.key
        };
      }),
      eventGroups: architectSceneEventGroups(scene).map(group => ({
        name: group.name, placementCount: group.placementCount, actions: group.actionSummary
      })),
      enemyArtwork,
      placements: architectScenePlacements(scene).map(record => {
        const point = architectPlacementPosition(record);
        return {
          key: record.key, index: record.index, depth: record.depth, rootKey: record.rootKey,
          parentLabel: record.parentLabel || null, label: architectPlacementLabel(record),
          controllerMarker: Boolean(record.controllerMarker || isArchitectGauntletMarker(record)),
          activeByDefault: architectPlacementStartsActive(record),
          placement: record.placement || {}, config: record.config || {},
          listeners: architectPlacementListeners(record), worldPosition: point, imagePixel: batchImagePoint(point, render),
          enemyCandidate: architectPlacementIsEnemy(record)
        };
      }),
      tileCells: scene.tileCells || []
    };
  } catch (error) {
    return { sourceFolder, sceneName: scene.name, markersVisibleByDefault: false,
      error: String(error?.message || error), markers: [], eventGroups: [], placements: [], tileCells: [] };
  }
}

function buildBatchRoomMetadata(scene, entry, outputName, render, status, error = null) {
  const objects = scene.objects || [];
  const architectScene = architectSceneForCurrentRoom();
  const imageFile = render?.blob ? `images/${outputName}.png` : null;
  const roomObjects = objects.map(object => {
    const { sprites = [], meshes = [], colliders = [], ...base } = object;
    const worldPosition = object.worldPosition || { x: 0, y: 0, z: 0 };
    return {
      ...base,
      worldPosition,
      activeInRoom: objectIsActive(object),
      imagePixel: batchImagePoint(worldPosition, render),
      classification: classifyObject(object),
      sprites: sprites.map(portableRendererMetadata),
      meshes: meshes.map(portableRendererMetadata),
      colliders: colliders.map(collider => ({
        ...collider,
        imagePoints: (collider.worldPoints || []).map(point => batchImagePoint(point, render))
      }))
    };
  });
  const counts = roomObjects.reduce((total, object) => {
    total.active += object.activeInRoom ? 1 : 0;
    total.enemyCandidates += object.classification.enemy ? 1 : 0;
    total.spawnCandidates += object.classification.spawn ? 1 : 0;
    total.checkCandidates += object.classification.check ? 1 : 0;
    return total;
  }, { active: 0, enemyCandidates: 0, spawnCandidates: 0, checkCandidates: 0 });
  const architect = buildBatchArchitectMetadata(architectScene, render);
  return {
    format: 'silksong-room-atlas-room', formatVersion: 1, status,
    ...(error ? { error } : {}),
    scene: {
      name: scene.sceneName || entry.candidateName,
      kind: entry.kind || 'room',
      sourceSchemaVersion: scene.schemaVersion ?? null,
      source: { bundle: String(scene.sourceBundle || entry.bundleFile || '').split(/[\\/]/).pop(), sha256: scene.sourceSha256 || null },
      diagnostics: scene.diagnostics || []
    },
    image: render?.blob ? {
      file: imageFile, mimeType: 'image/png', width: render.width, height: render.height,
      alpha: true, pixelsPerWorldUnit: render.ppu, requestedPixelsPerWorldUnit: render.nativePpu,
      resolutionLimited: render.resolutionLimited,
      bounds: render.bounds,
      worldToPixel: { x: '2 + (worldX - bounds.minX) * pixelsPerWorldUnit', y: '2 + (bounds.maxY - worldY) * pixelsPerWorldUnit' }
    } : null,
    render: {
      profile: 'active-silksong-bundle-renderers', activeRenderersOnly: true,
      gameBundleTexturesOnly: true, screenEffectsIncluded: render?.screenEffectsIncluded ?? false, viewerAnnotations: false,
      architectModAssets: false, runtimeLightingSimulation: false, eligibleRendererCount: render?.rendererCount || 0,
      textureCount: render?.textureCount || 0, missingTextureSha256: render?.missingTextures || [],
      sorting: 'Unity sorting group, layer, order, and depth sequence; unresolved layer mappings are excluded',
      excluded: ['inactive objects', 'disabled renderers', 'destination blend renderers', 'non-bundle textures']
    },
    counts: { objectCount: objects.length, ...counts },
    objects: roomObjects,
    meshAssets: scene.meshAssets || [],
    architect
  };
}

function failedBatchRoomMetadata(entry, outputName, error) {
  return {
    format: 'silksong-room-atlas-room', formatVersion: 1, status: 'failed', error,
    scene: { name: entry.candidateName, kind: entry.kind || 'room', source: { bundle: String(entry.bundleFile || '').split(/[\\/]/).pop() } },
    image: null, render: { gameBundleTexturesOnly: true, viewerAnnotations: false, architectModAssets: false },
    counts: { objectCount: 0, active: 0, enemyCandidates: 0, spawnCandidates: 0, checkCandidates: 0 }, objects: []
  };
}

function uniqueExportBasename(name, used) {
  const base = safeFilename(name) || 'room';
  let candidate = base, index = 2;
  while (used.has(candidate.toLowerCase())) candidate = `${base}-${index++}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

function exportReadme() {
  return `Silksong Room Atlas export\n\n` +
    `images/ contains clean, transparent PNG renders at native texture resolution, made from active renderers and Silksong bundle textures. ` +
    `Large rooms are rasterized in tiles and may include a smaller -preview.png for the reader; the sidecar records both paths and dimensions. ` +
    `Viewer markers, grid, captured screenshots, Architect images, and other external images are excluded from the PNGs. ` +
    `Inactive and disabled renderers, destination-blend renderers, and renderers with unresolved sorting-layer mappings are skipped. ` +
    `Lighting and background renderer textures from the bundles are included. The viewer does not execute Unity's dynamic lighting, ` +
    `event scripts, or shaders; serialized screen-effect artwork follows the viewer's Screen effects toggle.\n\n` +
    `rooms/ contains one JSON sidecar per indexed scene. Each sidecar includes Unity object hierarchy, world coordinates, ` +
    `components, collider points, enemy/spawn/check candidate flags, sprite and mesh sorting details, mesh geometry, and source texture SHA-256 references. ` +
    `When an Architect folder is loaded, JSON sidecars also include its matching placement and event metadata, with gauntlet markers marked off by default. ` +
    `Texture atlases are not duplicated; the PNG is the rendered room image.\n\n` +
    `manifest.json indexes every processed room and records failures or rooms with no renderable artwork. World coordinates use Unity units. ` +
    `PNG pixel coordinates start at the top-left; pixel centers are calculated with the worldToPixel formula recorded in each sidecar. ` +
    `Objects can lie outside the image rectangle when their serialized world positions lie outside the visible artwork.\n`;
}

async function writeBatchFile(target, path, blob) {
  if (target.mode === 'server') {
    const parts = path.split('/'), originalName = parts.pop();
    const fileName = target.retry && parts.length === 0 && originalName === 'manifest.json'
      ? (target.workerCount > 1 ? `manifest-retry-worker-${target.workerIndex}.json` : 'manifest-retry.json')
      : target.workerCount > 1 && parts.length === 0 && originalName === 'manifest.json'
        ? `manifest-worker-${target.workerIndex}.json` : originalName;
    const bucket = parts.shift() || 'root';
    const response = await fetch(`/api/preprocessed/${bucket}/${encodeURIComponent(fileName)}`, {
      method: 'PUT', headers: { 'Content-Type': blob.type || 'application/octet-stream' }, body: blob
    });
    if (!response.ok) throw new Error(`Could not save ${path}: ${response.status} ${await response.text()}`);
    return;
  }
  if (target.mode === 'zip') { target.files.push({ path, blob }); return; }
  const parts = path.split('/'), fileName = parts.pop();
  let directory = target.root;
  for (const part of parts) directory = await directory.getDirectoryHandle(part, { create: true });
  const file = await directory.getFileHandle(fileName, { create: true });
  const writable = await file.createWritable();
  await writable.write(blob);
  await writable.close();
}

const zipCrcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

async function zipCrc32(blob) {
  const reader = blob.stream().getReader(); let crc = 0xffffffff;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const byte of value) crc = zipCrcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipTimeDate(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

async function makeStoredZipBlob(files, onProgress) {
  const encoder = new TextEncoder(), dataParts = [], directoryParts = [], { time, day } = zipTimeDate();
  let offset = 0, directorySize = 0;
  if (files.length > 65535) throw new Error('The export contains too many files for the browser ZIP fallback.');
  for (let index = 0; index < files.length; index++) {
    const file = files[index], name = encoder.encode(file.path), size = file.blob.size;
    if (name.length > 65535 || size > 0xffffffff || offset + size > 0xffffffff) throw new Error('This export exceeds the 4 GB ZIP fallback limit. Use folder export in a Chromium based browser.');
    const crc = await zipCrc32(file.blob), localOffset = offset;
    const local = new Uint8Array(30 + name.length), localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true); localView.setUint16(4, 20, true); localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true); localView.setUint16(10, time, true); localView.setUint16(12, day, true);
    localView.setUint32(14, crc, true); localView.setUint32(18, size, true); localView.setUint32(22, size, true);
    localView.setUint16(26, name.length, true); localView.setUint16(28, 0, true); local.set(name, 30);
    dataParts.push(local, file.blob); offset += local.length + size;

    const central = new Uint8Array(46 + name.length), centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true); centralView.setUint16(4, 20, true); centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true); centralView.setUint16(10, 0, true);
    centralView.setUint16(12, time, true); centralView.setUint16(14, day, true);
    centralView.setUint32(16, crc, true); centralView.setUint32(20, size, true); centralView.setUint32(24, size, true);
    centralView.setUint16(28, name.length, true); centralView.setUint16(30, 0, true); centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true); centralView.setUint16(36, 0, true); centralView.setUint32(38, 0, true);
    centralView.setUint32(42, localOffset, true); central.set(name, 46);
    directoryParts.push(central); directorySize += central.length;
    if (onProgress && (index % 12 === 0 || index === files.length - 1)) {
      onProgress(index + 1, files.length, file.path);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  if (offset > 0xffffffff || directorySize > 0xffffffff) throw new Error('This export exceeds the 4 GB ZIP fallback limit. Use folder export in a Chromium based browser.');
  const end = new Uint8Array(22), endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true); endView.setUint16(4, 0, true); endView.setUint16(6, 0, true);
  endView.setUint16(8, files.length, true); endView.setUint16(10, files.length, true);
  endView.setUint32(12, directorySize, true); endView.setUint32(16, offset, true); endView.setUint16(20, 0, true);
  return new Blob([...dataParts, ...directoryParts, end], { type: 'application/zip' });
}

async function exportAllRooms(serverOutput = false) {
  if (state.bulkExporting) return;
  const allEntries = uniqueBatchSceneEntries();
  const params = new URLSearchParams(window.location.search);
  const parsedWorkerCount = Number.parseInt(params.get('batchWorkers') || '1', 10);
  const workerCount = Number.isInteger(parsedWorkerCount) ? Math.max(1, Math.min(8, parsedWorkerCount)) : 1;
  const parsedWorkerIndex = Number.parseInt(params.get('batchWorker') || '0', 10);
  const workerIndex = Number.isInteger(parsedWorkerIndex) ? Math.min(workerCount - 1, Math.max(0, parsedWorkerIndex)) : 0;
  const cameraOnly = params.get('batchCamera') === '1';
  const batchSceneNames = new Set(params.getAll('batchScene').flatMap(value => value.split(',')
    .map(name => name.trim().toLowerCase()).filter(Boolean)));
  if (cameraOnly && params.get('batchCameraLimited') === '1') {
    const requestedNames = batchSceneNames.size ? new Set(batchSceneNames) : null;
    batchSceneNames.clear();
    const response = await fetch('/atlas-data/camera-limited-scenes.txt', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Could not read the capped-room export list (${response.status}).`);
    const names = (await response.text()).split(/\r?\n/).map(name => name.replace(/^\uFEFF/, '').trim().toLowerCase()).filter(Boolean);
    for (const name of names) if (!requestedNames || requestedNames.has(name)) batchSceneNames.add(name);
  }
  const entries = allEntries.map((entry, exportOrder) => ({ ...entry, exportOrder }))
    .filter(entry => !batchSceneNames.size || batchSceneNames.has(entry.candidateName.toLowerCase()))
    .filter(entry => entry.exportOrder % workerCount === workerIndex);
  if (!entries.length) {
    showToast(batchSceneNames.size ? 'No indexed rooms matched the requested retry scene name.' : 'Connect a Silksong room bundle folder before exporting.');
    return;
  }
  state.bulkExporting = true;
  byId('exportAllButton').disabled = true;
  const releasePickerLock = () => {
    state.bulkExporting = false;
    byId('exportAllButton').disabled = state.scenes.length === 0;
    byId('prepareReaderButton').disabled = state.scenes.length === 0;
  };
  const includeScreenEffects = byId('layerEffects').checked;
  const stamp = new Date().toISOString().replace(/[.:]/g, '-');
  const folderName = `Silksong-Room-Atlas-${stamp}`;
  let target;
  if (serverOutput) target = { mode: 'server', name: 'workspace/preprocessed', workerIndex, workerCount, retry: batchSceneNames.size > 0, cameraOnly };
  else if (typeof window.showDirectoryPicker === 'function') {
    let parent;
    try { parent = await window.showDirectoryPicker({ id: 'silksong-room-atlas', startIn: 'downloads', mode: 'readwrite' }); }
    catch (error) {
      if (error?.name === 'AbortError') { releasePickerLock(); return; }
      releasePickerLock();
      showToast(`Could not open the Downloads folder picker: ${error.message || error}`); return;
    }
    try { target = { mode: 'folder', root: await parent.getDirectoryHandle(folderName, { create: true }), name: folderName }; }
    catch (error) { releasePickerLock(); showToast(`Could not create the export folder: ${error.message || error}`); return; }
  } else target = { mode: 'zip', files: [], name: folderName };

  const dialog = byId('bulkExportDialog'), progress = byId('bulkExportProgress');
  byId('bulkExportTitle').textContent = 'Rendering rooms';
  byId('bulkExportSummary').textContent = target.mode === 'server'
    ? cameraOnly
      ? `Rendering authored camera sections from Silksong bundle textures for ${entries.length.toLocaleString()} rooms${workerCount > 1 ? ` with worker ${workerIndex + 1}/${workerCount}` : ''}. Native texture density is retained when practical; extreme views are capped at 16,379 pixels per edge or 100 megapixels.`
      : `Pre-rendering ${entries.length.toLocaleString()} of ${allEntries.length.toLocaleString()} rooms${workerCount > 1 ? ` with worker ${workerIndex + 1}/${workerCount}` : ''} to the local workspace. Images contain only Silksong bundle textures; JSON sidecars include scene and optional Architect metadata.`
    : target.mode === 'folder'
    ? `Saving ${entries.length.toLocaleString()} rooms inside ${folderName}. PNGs contain only Silksong bundle art; JSON sidecars preserve room metadata.`
    : `Rendering ${entries.length.toLocaleString()} rooms. Your browser cannot grant folder access, so the completed folder will be offered as one ZIP download.`;
  byId('bulkExportStatus').textContent = 'Starting room 1…';
  progress.max = entries.length; progress.value = 0;
  byId('bulkExportDownload').hidden = true; byId('bulkExportClose').hidden = true;
  byId('bulkExportCancel').hidden = false; byId('bulkExportCancel').disabled = false;
  if (!dialog.open) dialog.showModal();

  state.bulkExportCancelled = false; state.batchRendering = true;
  byId('exportAllButton').disabled = true;
  byId('prepareReaderButton').disabled = true;
  const usedNames = new Set(), rooms = [];
  try {
    let navigation = null;
    if (serverOutput) {
      if (workerIndex === 0 && !batchSceneNames.size) {
        byId('bulkExportStatus').textContent = 'Pre-rendering the game-authored wide and detailed maps…';
        navigation = await renderBatchWorldMapAssets(target);
        byId('bulkExportStatus').textContent = navigation.status === 'ready'
          ? `Game map ready · ${navigation.areaCount} regions · loading optional enemy sprites…`
          : `Map artwork unavailable: ${navigation.error}`;
      }
      if (!target.cameraOnly) {
        try { await preloadBatchArchitectEnemyArtwork(); }
        catch (error) { byId('bulkExportStatus').textContent += ` · enemy art lookup skipped: ${error.message || error}`; }
      }
    }
    for (let index = 0; index < entries.length; index++) {
      if (state.bulkExportCancelled) break;
      const entry = entries[index], outputName = uniqueExportBasename(target.retry ? `${entry.candidateName}-native` : entry.candidateName, usedNames);
      const roomIndex = index + 1;
      byId('bulkExportStatus').textContent = `Reading ${roomIndex.toLocaleString()} / ${entries.length.toLocaleString()} · ${entry.candidateName}`;
      await new Promise(resolve => setTimeout(resolve, 0));
      let scene = null, render = null, metadata = null, status = 'failed', errorMessage = null, cameraFiles = [];
      try {
        scene = await getJson(`/api/scenes/${encodeURIComponent(entry.candidateName)}`);
        if (target.cameraOnly) {
          const result = await withBatchSceneState(scene, async () => {
            const baseName = outputName.replace(/-native$/, '');
            const baseMetadata = await getJson(`/atlas-data/rooms/${encodeURIComponent(baseName)}.json`);
            const cameraViews = await renderBatchCameraSections(scene.objects || [], includeScreenEffects, outputName, target, (tile, total) => {
              byId('bulkExportStatus').textContent = `Rendering ${entry.candidateName} camera ${tile.toLocaleString()} / ${total.toLocaleString()}`;
            });
            if (baseMetadata.image) {
              baseMetadata.image.cameraSections = cameraViews;
              baseMetadata.image.cameraSectionRenderProfile = 'active Silksong bundle renderers clipped to authored camera-lock bounds at local native texture density';
            }
            baseMetadata.cameraSectionExport = { generatedAt: new Date().toISOString(), viewCount: cameraViews.length,
              rendererCount: cameraViews.reduce((sum, view) => sum + view.rendererCount, 0), missingTextures: cameraViews.flatMap(view => view.missingTextureSha256 || []) };
            return { metadata: baseMetadata, cameraViews };
          });
          metadata = result.metadata; cameraFiles = result.cameraViews.map(view => view.file);
          status = cameraFiles.length ? 'exported' : 'no-artwork';
        } else {
          const result = await withBatchSceneState(scene, async () => {
            const rendered = await renderBatchScene(scene.objects || [], includeScreenEffects, (tile, total) => {
              byId('bulkExportStatus').textContent = `Rendering native-resolution tiles ${tile.toLocaleString()} / ${total.toLocaleString()} · ${entry.candidateName}`;
            });
            const roomStatus = rendered.blob ? 'exported' : 'no-artwork';
            return { rendered, metadata: buildBatchRoomMetadata(scene, entry, outputName, rendered, roomStatus) };
          });
          render = result.rendered; metadata = result.metadata; status = render.blob ? 'exported' : 'no-artwork';
        }
      } catch (error) {
        errorMessage = String(error?.message || error);
        status = scene ? 'render-failed' : 'failed';
        metadata = scene
          ? await withBatchSceneState(scene, () => buildBatchRoomMetadata(scene, entry, outputName, null, status, errorMessage))
          : failedBatchRoomMetadata(entry, outputName, errorMessage);
      }
      const imageFile = render?.blob ? `images/${outputName}.png` : null;
      const previewFile = render?.previewBlob ? `images/${outputName}-preview.png` : imageFile;
      metadata.status = status;
      if (render?.blob) {
        await writeBatchFile(target, imageFile, render.blob);
        if (render.previewBlob) await writeBatchFile(target, previewFile, render.previewBlob);
        if (metadata.image) {
          metadata.image.previewFile = previewFile;
          metadata.image.previewWidth = render.previewWidth;
          metadata.image.previewHeight = render.previewHeight;
          metadata.image.previewPixelsPerWorldUnit = render.previewPpu;
        }
      }
      const metadataFile = `rooms/${outputName}.json`;
      await writeBatchFile(target, metadataFile, new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
      rooms.push({ name: entry.candidateName, order: entry.exportOrder, kind: entry.kind || 'room', status, image: imageFile,
        previewImage: previewFile !== imageFile ? previewFile : undefined, metadata: metadataFile,
        objectCount: metadata.counts?.objectCount || 0, cameraViews: cameraFiles.length ? cameraFiles : undefined, error: errorMessage || undefined });
      progress.value = roomIndex;
      byId('bulkExportStatus').textContent = `${roomIndex.toLocaleString()} / ${entries.length.toLocaleString()} · ${entry.candidateName} · ${status}`;
      if (serverOutput && (roomIndex === 1 || roomIndex % 10 === 0)) {
        const partialCounts = rooms.reduce((result, room) => { result[room.status] = (result[room.status] || 0) + 1; return result; }, {});
        const partialManifest = {
          format: 'silksong-room-atlas', formatVersion: 1, createdAt: new Date().toISOString(),
          complete: false, canceled: false, workerIndex, workerCount, requestedSceneCount: allEntries.length,
          cameraSectionPass: cameraOnly,
          processedSceneCount: rooms.length, unprocessedSceneCount: allEntries.length - rooms.length,
          counts: partialCounts, sourceFolderName: String(state.source || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || null,
          renderProfile: { gameBundleTexturesOnly: true, activeRenderersOnly: true, screenEffectsIncluded: includeScreenEffects,
            backgroundArtworkIncluded: true, lightingRendererArtworkIncluded: true, runtimeLightingSimulation: false,
            viewerAnnotations: false, architectModAssets: false, architectPlacementMetadataIncluded: state.architectScenes.size > 0 },
          navigation, rooms
        };
        await writeBatchFile(target, 'manifest.json', new Blob([JSON.stringify(partialManifest)], { type: 'application/json' }));
      }
    }

    byId('bulkExportCancel').hidden = true;
    const canceled = state.bulkExportCancelled && rooms.length < entries.length;
    const counts = rooms.reduce((result, room) => { result[room.status] = (result[room.status] || 0) + 1; return result; }, {});
    const manifest = {
      format: 'silksong-room-atlas', formatVersion: 1, createdAt: new Date().toISOString(),
      complete: workerCount === 1 && !canceled && rooms.length === entries.length, canceled,
      cameraSectionPass: cameraOnly,
      workerComplete: !canceled && rooms.length === entries.length, workerIndex, workerCount,
      requestedSceneCount: allEntries.length, processedSceneCount: rooms.length, unprocessedSceneCount: allEntries.length - rooms.length,
      counts, sourceFolderName: String(state.source || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || null,
      renderProfile: { gameBundleTexturesOnly: true, activeRenderersOnly: true, screenEffectsIncluded: includeScreenEffects,
        backgroundArtworkIncluded: true, lightingRendererArtworkIncluded: true, runtimeLightingSimulation: false,
        viewerAnnotations: false, architectModAssets: false, architectPlacementMetadataIncluded: state.architectScenes.size > 0,
        png: 'transparent RGBA at native bundle texture density; oversized rooms are tiled and a smaller preview is included for the reader' },
      navigation,
      coordinateConvention: { units: 'Unity world units', imageOrigin: 'top-left', pixelFormula: 'x=2+(worldX-minX)*pixelsPerWorldUnit; y=2+(maxY-worldY)*pixelsPerWorldUnit' },
      rooms
    };
    if (!target.retry) await writeBatchFile(target, 'README.txt', new Blob([exportReadme()], { type: 'text/plain;charset=utf-8' }));
    await writeBatchFile(target, 'manifest.json', new Blob([JSON.stringify(manifest)], { type: 'application/json' }));

    if (target.mode === 'zip') {
      byId('bulkExportTitle').textContent = 'Packaging export';
      byId('bulkExportSummary').textContent = `Preparing ${target.files.length.toLocaleString()} files for download. This can take a few minutes for large room sets.`;
      byId('bulkExportStatus').textContent = 'Creating ZIP archive…';
      const zip = await makeStoredZipBlob(target.files, (done, total, path) => {
        byId('bulkExportStatus').textContent = `Packing ${done.toLocaleString()} / ${total.toLocaleString()} · ${path}`;
      });
      if (state.bulkExportZipUrl) URL.revokeObjectURL(state.bulkExportZipUrl);
      state.bulkExportZipUrl = URL.createObjectURL(zip);
      const download = byId('bulkExportDownload');
      download.href = state.bulkExportZipUrl; download.download = `${folderName}.zip`; download.hidden = false;
    }
    byId('bulkExportTitle').textContent = canceled ? 'Export stopped' : workerCount > 1 ? `Worker ${workerIndex + 1}/${workerCount} complete` : 'Export complete';
    const failures = (counts.failed || 0) + (counts['render-failed'] || 0);
    byId('bulkExportSummary').textContent = `${rooms.length.toLocaleString()} of ${entries.length.toLocaleString()} assigned scenes processed${workerCount > 1 ? ` · ${allEntries.length.toLocaleString()} total across ${workerCount} workers` : ''} · ${counts.exported || 0} PNGs · ${counts['no-artwork'] || 0} rooms without renderable art · ${failures} failures.`;
    byId('bulkExportStatus').textContent = target.mode === 'server'
      ? workerCount > 1
        ? `Worker ${workerIndex + 1}/${workerCount} saved ${rooms.length.toLocaleString()} rooms · manifest-worker-${workerIndex}.json`
        : `Preprocessed workspace ready: ${rooms.length.toLocaleString()} scenes · ${folderName}`
      : target.mode === 'folder'
      ? `${canceled ? 'Partial export saved' : 'Folder saved'}: ${folderName}`
      : `${canceled ? 'Partial ZIP ready' : 'ZIP ready'}: ${folderName}.zip`;
    byId('bulkExportCancel').hidden = true; byId('bulkExportClose').hidden = false;
  } catch (error) {
    byId('bulkExportTitle').textContent = 'Export could not finish';
    byId('bulkExportSummary').textContent = 'The export stopped because a file could not be written or the browser reached a limit.';
    byId('bulkExportStatus').textContent = String(error?.message || error);
    byId('bulkExportCancel').hidden = true; byId('bulkExportClose').hidden = false;
    showToast('The room export stopped before it could finish.');
  } finally {
    state.batchRendering = false; state.bulkExporting = false; state.bulkExportCancelled = false;
    byId('exportAllButton').disabled = state.scenes.length === 0;
    byId('prepareReaderButton').disabled = state.scenes.length === 0;
    if (state.scene) drawScene();
  }
}

function exportSceneCoordinates() {
  const objects = state.scene?.objects || [];
  if (!objects.length) return;
  const mapPoints = [...objects.map(object => object.worldPosition || { x: 0, y: 0 }), ...objects.flatMap(object => (object.colliders || []).flatMap(collider => collider.worldPoints || []))];
  const xs = mapPoints.map(point => point.x ?? 0), ys = mapPoints.map(point => point.y ?? 0);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys), pad = 54, top = 88;
  const ppu = Math.min(4, 8000 / Math.max(1, maxX - minX), 8000 / Math.max(1, maxY - minY));
  const markers = objects.map(object => { const point = object.worldPosition || { x: 0, y: 0, z: 0 }; return { id: object.id, name: object.name, parentId: object.parentId, active: object.active, components: object.components, colliders: object.colliders, sprites: object.sprites, world: point, pixel: { x: pad + (point.x - minX) * ppu, y: top + (maxY - point.y) * ppu }, classification: classifyObject(object) }; });
  const payload = { schemaVersion: state.scene.schemaVersion, scene: state.scene.sceneName, source: { bundle: state.scene.sourceBundle.split(/[\\/]/).pop(), sha256: state.scene.sourceSha256 }, image: { file: `${safeFilename(state.scene.sceneName)}-room.png`, pixelsPerWorldUnit: ppu, bounds: { minX, minY, maxX, maxY }, markers }, diagnostics: state.scene.diagnostics };
  downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), `${safeFilename(state.scene.sceneName)}-coordinates.json`);
  showToast('Room coordinates exported as JSON.');
}

function downloadBlob(blob, filename) { const url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1500); }

function safeFilename(value) { return String(value || 'silksong-room').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, ''); }
function formatBytes(value) { return value > 1024 * 1024 ? `${(value / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(value / 1024))} KB`; }

function connectControls() {
  byId('refreshButton').addEventListener('click', refreshSceneIndex);
  byId('mapReaderButton').addEventListener('click', () => { void enterMapReader(); });
  byId('readerWorldButton').addEventListener('click', showReaderWorldMap);
  byId('readerReturnToAreaButton').addEventListener('click', returnReaderToArea);
  byId('sceneSearch').addEventListener('input', renderSceneList);
  byId('objectSearch').addEventListener('input', renderObjectTree);
  byId('exportButton').addEventListener('click', exportSceneImage);
  byId('exportAllButton').addEventListener('click', () => { void exportAllRooms(); });
  byId('prepareReaderButton').addEventListener('click', () => { void exportAllRooms(true); });
  byId('bulkExportCancel').addEventListener('click', () => {
    if (!state.bulkExporting) return;
    state.bulkExportCancelled = true;
    byId('bulkExportCancel').textContent = 'Stopping after this room…';
    byId('bulkExportCancel').disabled = true;
    byId('bulkExportStatus').textContent = 'Finishing the current room, then writing a partial manifest…';
  });
  byId('bulkExportClose').addEventListener('click', () => byId('bulkExportDialog').close());
  byId('bulkExportDialog').addEventListener('cancel', event => { if (state.bulkExporting) event.preventDefault(); });
  byId('bulkExportDialog').addEventListener('close', () => {
    byId('bulkExportCancel').textContent = 'Stop after this room';
    if (state.bulkExportZipUrl) { URL.revokeObjectURL(state.bulkExportZipUrl); state.bulkExportZipUrl = null; }
  });
  byId('mapDataButton').addEventListener('click', exportSceneCoordinates);
  byId('fitButton').addEventListener('click', () => {
    state.gameView = false; state.fitBounds = null; state.fitted = false; state.cameraLockIndex = -1;
    byId('canvasShell').classList.remove('wide-preview'); byId('fitZonesButton').classList.remove('active');
    updateCameraLockButton(); drawScene();
  });
  byId('fitZonesButton').addEventListener('click', () => {
    if (!state.cameraLockAreas.length) return;
    state.cameraLockIndex = (state.cameraLockIndex + 1) % state.cameraLockAreas.length;
    state.gameView = true;
    state.fitBounds = state.cameraLockAreas[state.cameraLockIndex].bounds;
    state.fitted = false;
    byId('canvasShell').classList.add('wide-preview');
    byId('fitZonesButton').classList.add('active'); updateCameraLockButton();
    drawScene();
  });
  byId('zoomInButton').addEventListener('click', () => { state.scale *= 1.22; drawScene(); });
  byId('zoomOutButton').addEventListener('click', () => { state.scale /= 1.22; drawScene(); });
  byId('gridButton').addEventListener('click', () => { state.grid = !state.grid; byId('gridButton').classList.toggle('active', state.grid); drawScene(); });
  byId('clearSelectionButton').addEventListener('click', () => { state.selected = null; byId('selectionContent').textContent = 'Click an object in the tree or on the map.'; renderObjectTree(); drawScene(); });
  for (const id of ['layerArtwork', 'layerLighting', 'layerBackground', 'layerEffects', 'layerObjects', 'layerColliders', 'layerEnemies', 'layerSpawns', 'layerChecks', 'previewBackgroundBlur']) byId(id).addEventListener('change', drawScene);
  for (const id of ['includeInactiveSprites', 'includeDisabledSprites', 'applyRendererColors']) byId(id).addEventListener('change', drawScene);
  byId('lightingPreviewStrength').addEventListener('input', () => { updateGradePreviewControl(); drawScene(); });
  byId('stateOverrideSearch').addEventListener('input', renderStateOverrideRows);
  byId('spriteNameExclude').addEventListener('input', drawScene);
  byId('resetArtworkFilters').addEventListener('click', () => {
    state.hiddenSortingLayers = new Set((state.scene?.objects || []).flatMap(object => [
      ...(object.sprites || []), ...(object.meshes || []), ...(object.sortingGroup?.enabled ? [object.sortingGroup] : [])
    ]).filter(artwork => artwork.sortingLayerKnown === false).map(artwork => Number(artwork.sortingLayerId) || 0));
    state.objectVisibilityOverrides = new Map();
    for (const group of state.activationGroups) {
      const normalWorld = group.options.find(option => option.name.trim().toLowerCase() === 'normal world');
      if (normalWorld) setGroupOverride(group, normalWorld.id);
    }
    refreshCameraLockAreas();
    byId('includeInactiveSprites').checked = false;
    byId('includeDisabledSprites').checked = false;
    byId('applyRendererColors').checked = true;
    state.gradePreviewObjectId = null; byId('lightingPreviewStrength').value = '0';
    renderLightingStateFilters();
    byId('spriteNameExclude').value = '';
    renderSortingLayerFilters(); renderActivationFilters();
    if (state.selected) selectObject(state.selected);
    drawScene();
  });
  byId('showListButton').addEventListener('click', () => { byId('sceneListText').value = state.requested?.join('\n') || ''; byId('listDialog').showModal(); });
  byId('loadListButton').addEventListener('click', event => {
    event.preventDefault();
    const input = byId('sceneListText').value.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
    state.requested = input.length ? [...new Set(input)] : null;
    byId('listDialog').close(); renderSceneList();
    if (state.requested?.length) showToast(`${state.requested.length} scene names loaded.`);
  });
  byId('importListButton').addEventListener('click', async () => {
    const names = byId('sceneListText').value.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
    const uniqueNames = [...new Set(names)];
    if (!uniqueNames.length) { byId('importProgress').textContent = 'Add one or more scene names above.'; return; }
    byId('importProgress').textContent = `Reading objects from ${uniqueNames.length} room${uniqueNames.length === 1 ? '' : 's'}…`;
    byId('importListButton').disabled = true;
    try {
      const result = await getJson('/api/import-list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ names: uniqueNames }) });
      const successful = result.scenes.filter(scene => scene.status === 'ready').length, missing = result.scenes.filter(scene => scene.status === 'missing').length, failed = result.scenes.filter(scene => scene.status === 'failed').length;
      byId('importProgress').textContent = `Imported ${successful} room${successful === 1 ? '' : 's'} · ${Number(result.importedObjects).toLocaleString()} objects · ${missing} missing · ${failed} failed.`;
      state.requested = uniqueNames; byId('listDialog').close(); renderSceneList();
      showToast(`${successful} room object ${successful === 1 ? 'layout is' : 'layouts are'} ready.`);
    } catch (error) { byId('importProgress').textContent = error.message; }
    finally { byId('importListButton').disabled = false; }
  });
  byId('changeSourceButton').addEventListener('click', () => { byId('sourceInput').value = state.source; byId('sourceError').textContent = ''; byId('sourceDialog').showModal(); });
  byId('applySourceButton').addEventListener('click', async event => {
    event.preventDefault(); byId('sourceError').textContent = '';
    const root = byId('sourceInput').value.trim();
    try {
      await getJson('/api/source', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ root }) });
      if (state.readerMode) {
        state.readerMode = false; state.readerRoomName = null; state.readerAreaKey = null; state.readerVisibleObjects = null;
        document.body.classList.remove('reader-mode', 'reader-room-mode');
        byId('mapReaderNav').hidden = true; byId('mapReaderButton').classList.remove('active');
        byId('mapReaderButton').innerHTML = '◎ <span>Map Reader</span>'; restoreReaderLayers();
      }
      state.scene = null; state.requested = null; byId('sourceDialog').close(); byId('emptyCanvas').classList.remove('hidden'); renderCapturePanel();
      byId('currentSceneTitle').textContent = 'Choose a room'; byId('detailSceneName').textContent = 'No scene selected';
      byId('exportButton').disabled = true; await refreshSceneIndex(); showToast('Local scene folder connected.');
    } catch (error) { byId('sourceError').textContent = error.message; }
  });
  byId('selectCaptureFolderButton').addEventListener('click', () => byId('captureFolderInput').click());
  byId('captureFolderInput').addEventListener('change', async event => {
    const files = event.currentTarget.files;
    if (!files?.length) return;
    byId('selectCaptureFolderButton').disabled = true;
    try { await importCaptureFolder(files); showToast('In-game captures loaded; enable the captured view to overlay them.'); }
    catch (error) { byId('captureFolderStatus').textContent = error.message; }
    finally { byId('selectCaptureFolderButton').disabled = false; event.currentTarget.value = ''; }
  });
  byId('useGameCaptures').addEventListener('change', event => {
    state.gameCapturesEnabled = event.currentTarget.checked;
    drawScene();
  });
  byId('captureViewSelect').addEventListener('change', event => {
    state.gameCaptureView = event.currentTarget.value || 'all';
    drawScene();
  });
  byId('selectArchitectFolderButton').addEventListener('click', () => byId('architectFolderInput').click());
  byId('architectFolderInput').addEventListener('change', async event => {
    const input = event.currentTarget;
    const files = input.files;
    if (!files?.length) return;
    byId('selectArchitectFolderButton').disabled = true;
    try { await importArchitectFolder(files); showToast('Architect scene data loaded. Gauntlet markers remain off.'); }
    catch (error) { byId('architectFolderStatus').textContent = error.message; }
    finally { byId('selectArchitectFolderButton').disabled = false; input.value = ''; }
  });
  byId('architectSourceSelect').addEventListener('change', event => {
    const source = state.architectSources.get(event.currentTarget.value);
    state.architectScenes = source?.scenes || new Map();
    state.architectPrefabs = source?.prefabs || new Map();
    state.architectAssetFiles = source?.assets || new Map();
    state.architectSource = event.currentTarget.value.split('/').filter(Boolean).pop() || 'Architect';
    state.architectSelectedMarkerId = null; state.architectChangesVisible = false;
    state.architectSelectedWaveKey = null; state.architectWaveFilterKeys = null;
    state.architectActiveEvents = new Set(); state.architectPlacementVisibility = new Map(); state.architectPreviewName = null;
    state.architectWaveEnemyVisibility = new Map();
    if (state.scene) returnToGameRoom();
    else { renderArchitectPanel(); drawScene(); }
  });
  byId('architectMarkersToggle').addEventListener('change', event => {
    state.architectMarkersEnabled = event.currentTarget.checked;
    if (!state.architectMarkersEnabled) {
      state.architectSelectedMarkerId = null; state.architectChangesVisible = false;
      state.architectSelectedWaveKey = null; state.architectWaveFilterKeys = null;
      state.architectActiveEvents = new Set(); state.architectPlacementVisibility = new Map();
      state.architectWaveEnemyVisibility = new Map();
      byId('selectionContent').textContent = 'Click an object in the tree or on the map.';
    }
    renderArchitectPanel(); drawScene();
  });
  byId('architectEnableMarkersButton').addEventListener('click', () => {
    state.architectMarkersEnabled = true;
    renderArchitectPanel(); drawScene();
  });
  byId('architectChangesToggle').addEventListener('change', event => {
    state.architectChangesVisible = event.currentTarget.checked;
    renderArchitectPanel(); drawScene();
    if (state.architectChangesVisible) void ensureArchitectEnemyArt(architectSceneForCurrentRoom());
  });
  byId('architectEnemyArtToggle').addEventListener('change', event => {
    state.architectEnemyTexturesVisible = event.currentTarget.checked;
    renderArchitectPanel(); drawScene();
  });
  byId('architectModImagesToggle').addEventListener('change', event => {
    state.architectModImagesVisible = event.currentTarget.checked;
    renderArchitectPanel(); drawScene();
  });
  byId('architectResetEventsButton').addEventListener('click', () => {
    state.architectActiveEvents = new Set();
    state.architectSelectedWaveKey = null; state.architectWaveFilterKeys = null;
    state.architectPlacementVisibility = new Map();
    state.architectWaveEnemyVisibility = new Map();
    renderArchitectPanel(); drawScene();
  });
  byId('architectTilemapToggle').addEventListener('change', drawScene);
  byId('architectArenaSelect').addEventListener('change', event => {
    if (event.currentTarget.value) openArchitectPreview(event.currentTarget.value);
    else if (state.architectPreviewName) returnToGameRoom();
  });
  byId('architectReturnButton').addEventListener('click', returnToGameRoom);
  byId('roomCanvas').addEventListener('pointerdown', event => { const rect = event.currentTarget.getBoundingClientRect(); state.drag = { x: event.clientX, y: event.clientY, pan: event.button === 1 || event.altKey, moved: false, startX: event.clientX, startY: event.clientY }; event.currentTarget.setPointerCapture(event.pointerId); state.pointer = { x: event.clientX, y: event.clientY }; void rect; });
  byId('roomCanvas').addEventListener('pointermove', event => {
    state.pointer = { x: event.clientX, y: event.clientY };
    if (state.drag && event.buttons) {
      const dx = event.clientX - state.drag.x, dy = event.clientY - state.drag.y;
      if (Math.abs(event.clientX - state.drag.startX) + Math.abs(event.clientY - state.drag.startY) > 4) state.drag.moved = true;
      if (!state.drag.pan && event.button !== 1) state.drag.pan = true;
      if (state.drag.pan) { state.centerX -= dx / state.scale; state.centerY += dy / state.scale; }
      state.drag.x = event.clientX; state.drag.y = event.clientY;
    }
    drawScene();
  });
  byId('roomCanvas').addEventListener('pointerup', event => {
    if (state.drag && !state.drag.moved && state.scene) {
      const rect = event.currentTarget.getBoundingClientRect(), world = canvasToWorld(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height);
      if (state.readerMode && !state.readerRoomName) {
        if (state.readerAreaKey) {
          const room = hitReaderRoom(world);
          if (room) void openReaderRoom(room.scene.candidateName);
        } else {
          const area = hitReaderArea(world);
          if (area) showReaderArea(area.key);
        }
        state.drag = null;
        return;
      }
      const architectScene = architectSceneForCurrentRoom();
      const architectMarker = hitArchitectMarker(architectScene, world);
      if (architectMarker) {
        activateArchitectMarker(architectScene, architectMarker);
        state.drag = null;
        return;
      }
      if (state.architectChangesVisible || state.architectPreviewName) {
        let nearest = null;
        for (const record of architectScenePlacements(architectScene)) {
          if (record.controllerMarker || isArchitectGauntletMarker(record) || !architectPlacementIsVisible(architectScene.name, record)) continue;
          const point = architectPlacementPosition(record);
          if (!point) continue;
          const distance = Math.hypot((point.x - world.x) * state.scale, (point.y - world.y) * state.scale);
          if (distance <= 10 && (!nearest || distance < nearest.distance)) nearest = { record, distance };
        }
        if (nearest) {
          showArchitectPlacement(nearest.record, architectScene.name);
          state.drag = null;
          return;
        }
      }
      const candidate = (state.scene.objects || []).reduce((best, object) => { const point = object.worldPosition || { x: 0, y: 0 }, distance = Math.hypot((point.x - world.x) * state.scale, (point.y - world.y) * state.scale); return distance < best.distance ? { object, distance } : best; }, { object: null, distance: 14 });
      if (candidate.object) selectObject(candidate.object);
    }
    state.drag = null;
  });
  byId('roomCanvas').addEventListener('pointerleave', () => { state.pointer = null; drawScene(); });
  byId('roomCanvas').addEventListener('wheel', event => { event.preventDefault(); const canvas = byId('roomCanvas'), rect = canvas.getBoundingClientRect(), before = canvasToWorld(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height); state.scale *= event.deltaY < 0 ? 1.12 : 1 / 1.12; const after = canvasToWorld(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height); state.centerX += before.x - after.x; state.centerY += before.y - after.y; drawScene(); }, { passive: false });
  new ResizeObserver(drawScene).observe(byId('canvasShell'));
  document.addEventListener('keydown', event => {
    if (event.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) { event.preventDefault(); byId('sceneSearch').focus(); }
    if (event.key === 'Escape') { byId('listDialog').close(); byId('sourceDialog').close(); }
    if (event.key === '+' || event.key === '=') { state.scale *= 1.2; drawScene(); }
    if (event.key === '-' && document.activeElement.tagName !== 'TEXTAREA') { state.scale /= 1.2; drawScene(); }
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
      const current = state.scenes.findIndex(scene => scene.candidateName === state.scene?.sceneName), offset = event.key === 'ArrowDown' ? 1 : -1;
      const next = state.scenes[(current + offset + state.scenes.length) % state.scenes.length]; if (next) openScene(next.candidateName);
    }
  });
}

connectControls();
refreshSceneIndex();
