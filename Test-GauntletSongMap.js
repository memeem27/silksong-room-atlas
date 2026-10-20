const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

const root = __dirname;
execFileSync(process.execPath, [path.join(root, 'Build-GauntletSongCatalog.js')], { cwd: root, stdio: 'pipe' });
const catalogPath = path.join(root, 'workspace', 'gauntlet-song', 'export', 'gauntlet-catalog.json');
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
const readerPath = path.join(root, 'HostedAtlas', 'site', 'reader.js');
const reader = fs.readFileSync(readerPath, 'utf8');
const html = fs.readFileSync(path.join(root, 'HostedAtlas', 'site', 'index.html'), 'utf8');
const hostedDataRoot = path.join(root, 'HostedAtlas', 'r2-data');
const readGzipJson = file => JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
const delta = JSON.parse(fs.readFileSync(path.join(root, 'HostedAtlas', 'delta-assets.json'), 'utf8'));

assert.equal(catalog.format, 'silksong-gauntletsong-catalog');
assert.equal(catalog.formatVersion, 2);
assert.equal(catalog.coverage.hubEntrances, 14, 'all Architect portal entries should be indexed');
assert.equal(catalog.coverage.routeCount, 30, 'hub returns must not be counted as gauntlet routes');
assert.equal(catalog.coverage.uniqueBaseRooms, 23);
assert.equal(catalog.coverage.roomsWithMappedPosition, 23);
assert.equal(catalog.coverage.roomsWithPreprocessedSidecar, 23);
assert.ok(Buffer.byteLength(JSON.stringify(catalog)) < 200_000, 'catalog should stay a compact index');
assert.ok(Array.isArray(catalog.hub.tileCells) && catalog.hub.tileCells.length === catalog.hub.tileCellCount,
  'hub tile footprint must match Architect source occupancy coordinates');
assert.match(catalog.rendering.customArenaImageStatus, /no game tile textures or compiled scene bundles/i,
  'unavailable custom arena artwork must be stated instead of replaced with synthetic terrain');
const packagedCatalog = readGzipJson(path.join(hostedDataRoot, 'maps', 'gauntlet-song.json.gz'));
assert.deepEqual(packagedCatalog.coverage, catalog.coverage, 'hosted gzip catalog must match the generated local index');
assert.ok(delta.changedFiles.includes('maps/gauntlet-song.json.gz'), 'delta should publish the portal index');
assert.ok(!delta.changedFiles.some(file => file.startsWith('images/')), 'portal-only package must not re-upload or replace room images');

const gauntletKeys = new Set();
const routeScenes = new Set();
for (const gauntlet of catalog.gauntlets) {
  assert.ok(gauntlet.hubPosition && Number.isFinite(gauntlet.hubPosition.x) && Number.isFinite(gauntlet.hubPosition.y), `${gauntlet.name} needs its authored hub position`);
  assert.ok(!Object.hasOwn(gauntlet, 'placements') && !Object.hasOwn(gauntlet, 'tilemap'), 'portal index must not inline scene placements or raw tilemaps');
  assert.ok(!gauntletKeys.has(gauntlet.key), `duplicate portal key ${gauntlet.key}`);gauntletKeys.add(gauntlet.key);
  for (const route of gauntlet.routes) {
    assert.equal(route.targetType, 'base-room', `${gauntlet.name} route ${route.targetScene} must not be guessed as compiled arena data`);
    assert.ok(route.position && Number.isFinite(route.position.x) && Number.isFinite(route.position.y), `${gauntlet.name}/${route.targetScene} needs its authored gate position`);
    assert.equal(route.roomHasSidecar, true, `${route.targetScene} needs a loadable room sidecar`);
    assert.ok(route.roomImage, `${route.targetScene} needs its real pre-rendered room image`);
    routeScenes.add(route.roomScene.toLowerCase());
  }
}
assert.equal(routeScenes.size, 23);
assert.ok(catalog.mappedRooms.every(room => !Object.hasOwn(room, 'placements') && !Object.hasOwn(room, 'tilemap')),
  'per-instance data must remain in lazy-loaded room sidecars');
assert.equal(catalog.coverage.enemyTypes, new Set(catalog.mappedRooms.flatMap(room => room.architect?.enemies?.map(enemy => enemy.key) || [])).size);

const manifest = readGzipJson(path.join(hostedDataRoot, 'manifest.json.gz'));
const hostedRooms = new Map(manifest.rooms.map(room => [room.name.toLowerCase(), room]));
const assetIndex = readGzipJson(path.join(hostedDataRoot, 'asset-index.json.gz'));
const artwork = new Set((assetIndex.images || []).map(item => item.file));
for (const room of catalog.mappedRooms) {
  const exported = hostedRooms.get(room.scene.toLowerCase());
  assert.ok(exported?.image && exported.metadata, `${room.scene} must resolve to hosted game art and metadata`);
  for (const enemy of room.architect?.enemies || []) if (enemy.sprite?.textureSha256) {
    assert.ok(artwork.has(`artwork/${enemy.sprite.textureSha256}.webp`), `${room.scene}/${enemy.id} sprite atlas must already be packaged`);
  }
}

function extractFunction(source, name) {
  const match = new RegExp(`function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(match, `could not find ${name}`);
  const start = match.index, open = source.indexOf('{', match.index);
  let depth = 0, quote = '', lineComment = false, blockComment = false, escaped = false;
  for (let cursor = open; cursor < source.length; cursor++) {
    const ch = source[cursor], next = source[cursor + 1];
    if (lineComment) { if (ch === '\n') lineComment = false; continue; }
    if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; cursor++; } continue; }
    if (quote) { if (escaped) { escaped = false; continue; } if (ch === '\\') { escaped = true; continue; } if (ch === quote) quote = ''; continue; }
    if (ch === '/' && next === '/') { lineComment = true; cursor++; continue; }
    if (ch === '/' && next === '*') { blockComment = true; cursor++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return source.slice(start, cursor + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

const context = vm.createContext({ state: { gauntletCatalog: catalog },
  screenPoint: (point, transform) => ({ x: transform.x + point.x * transform.scale, y: transform.y - point.y * transform.scale }),
  mapTransform: () => ({ x: 0, y: 0, scale: 5 }), canvasSize: () => ({ width: 1200, height: 700 }),
  fitTransform: () => ({ x: 0, y: 0, scale: 5 }), mapBoundsForMode: () => catalog.hub.tileBounds,
  currentViewport: () => context.viewport, viewport: { key: '', zoom: 1, offsetX: 0, offsetY: 0 } });
vm.runInContext(`${extractFunction(reader,'gauntletPortalMarkerPositions')};${extractFunction(reader,'gauntletPortalAt')};${extractFunction(reader,'focusGauntletPortal')};globalThis.api={gauntletPortalMarkerPositions,gauntletPortalAt,focusGauntletPortal};`, context);
const viewport = { key: '', zoom: 1, offsetX: 0, offsetY: 0 };
context.state.selectedGauntletMapKey = null;
const positions = context.api.gauntletPortalMarkerPositions({ x: 0, y: 0, scale: 5 });
assert.equal(positions.length, 14, 'every portal gets one map marker');
assert.equal(new Set(positions.map(item => item.item.key)).size, 14);
assert.equal(new Set(positions.map(item => `${item.marker.x.toFixed(2)},${item.marker.y.toFixed(2)}`)).size, 14,
  'overlapping authored portal positions must be fanned out into distinct clickable handles');
for (const portal of positions) {
  const hit = context.api.gauntletPortalAt(portal.marker, { x: 0, y: 0, scale: 5 });
  assert.equal(hit?.key, portal.item.key, `${portal.item.name} marker should be individually selectable`);
}
context.viewport = viewport;
const focused = catalog.gauntlets[0];
context.api.focusGauntletPortal(focused);
const anchor = context.screenPoint(focused.hubPosition, context.fitTransform());
assert.equal(viewport.zoom, 3.2);
assert.ok(Number.isFinite(viewport.offsetX) && Number.isFinite(viewport.offsetY));
assert.ok(Math.abs(anchor.x*viewport.zoom+viewport.offsetX-600)<1e-7 && Math.abs(anchor.y*viewport.zoom+viewport.offsetY-350)<1e-7,
  'selected portal should zoom to the map canvas center');

for (const id of ['gauntletMapButton','gauntletMapPanel','gauntletMapSummary','gauntletMapRoutes']) assert.match(html, new RegExp(`id="${id}"`));
for (const token of ["'gauntlet-map'", "loadJson('maps/gauntlet-song.json')", 'drawGauntletMap', 'openGauntletRoute', 'returnToGauntletMap', 'data-enemy-article', 'showEnemyArticle', 'drawEnemyArticleSprite']) {
  assert.ok(reader.includes(token), `reader should include GauntletSong map integration: ${token}`);
}
assert.match(reader, /tile occupancy \+ portal coordinates · no hub texture included/i,
  'viewer should disclose that hub artwork is absent');
const boneSidecar = JSON.parse(fs.readFileSync(path.join(root, 'workspace', 'preprocessed', 'rooms', 'bone_01.json'), 'utf8'));
const boneRoller = boneSidecar.architect.placements.find(record => record.enemyCandidate && record.placement?.id === 'bone_roller');
const spriteContext = vm.createContext({ state: { roomMeta: boneSidecar } });
vm.runInContext(`${extractFunction(reader,'enemyArtworkForRecord')};${extractFunction(reader,'enemySpriteForRecord')};globalThis.api={enemyArtworkForRecord,enemySpriteForRecord};`, spriteContext);
const rollerArtwork = spriteContext.api.enemyArtworkForRecord(boneRoller);
assert.equal(rollerArtwork?.sprite?.name, 'RR_idle0000', 'enemy article must resolve the real Rock Roller idle sprite');
assert.equal(rollerArtwork?.sourceBundle, 'animations_assets_areabone.bundle', 'enemy article must identify the game sprite source bundle');
assert.equal(spriteContext.api.enemySpriteForRecord(boneRoller)?.textureSha256, '29d0651e26a837a9cd34318b25b213f7f9a8ea022cbd89556236dd0b1f5d3aab');

console.log(`GauntletSong map: ${catalog.coverage.hubEntrances} portals, ${catalog.coverage.routeCount} room routes, ${routeScenes.size} linked rooms, ${catalog.coverage.enemyTypes} enemy types; ${positions.length} independently clickable markers tested.`);
