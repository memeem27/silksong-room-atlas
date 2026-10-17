const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const root = __dirname;
const dataRoot = path.join(root, 'HostedAtlas', 'r2-data');
const readGzipJson = file => JSON.parse(zlib.gunzipSync(fs.readFileSync(file), { maxOutputLength: 1_000_000_000 }).toString('utf8'));
const manifest = readGzipJson(path.join(dataRoot, 'manifest.json.gz'));
const navigation = readGzipJson(path.join(dataRoot, 'maps', 'navigation.json.gz'));
const assetIndex = readGzipJson(path.join(dataRoot, 'asset-index.json.gz'));
assert.equal(navigation.formatVersion, 5, 'navigation format must include mesh clipping, room coverage, and transition data');

const rendered = (manifest.rooms || []).filter(room => room.image);
const renderedNames = new Set(rendered.map(room => room.name.toLowerCase()));
const areas = navigation.areas || [];
const indexedRows = areas.flatMap(area => area.rooms || []);
const indexedNames = new Set(indexedRows.map(room => room.name.toLowerCase()));
const archivedNames = new Set((navigation.unplacedRooms || []).map(room => room.name.toLowerCase()));
const missing = rendered.filter(room => !indexedNames.has(room.name.toLowerCase()) && !archivedNames.has(room.name.toLowerCase()));
assert.equal(missing.length, 0, `every rendered room must be region-mapped or archived: ${missing.map(room => room.name).join(', ')}`);
assert.equal((navigation.unplacedRooms || []).length, (areas.find(area => area.key === 'UNPLACED_SCENES')?.rooms || []).length,
  'archive index and scene archive area must contain the same rooms');

const mainAreas = areas.filter(area => !area.archive);
const positionedNames = new Set(mainAreas.flatMap(area => (area.rooms || [])
  .filter(room => room.center && room.bounds).map(room => room.name.toLowerCase())));
const positionedRenderedCount = rendered.filter(room => positionedNames.has(room.name.toLowerCase())).length;
assert.equal(positionedRenderedCount + archivedNames.size, renderedNames.size,
  'each rendered room must have one authored/shared map location or be listed as unplaced');

const boneBottomArea = areas.find(area => area.key === 'BONETOWN');
const boneBottom = boneBottomArea?.rooms.find(room => room.name.toLowerCase() === 'bone_01b');
assert.ok(boneBottom?.architect?.markerCount > 0, 'Bone Bottom needs its Architect marker on the map index');
assert.ok(boneBottomArea.rooms.filter(room => room.architect?.markerCount).length >= 5,
  'Bone Bottom gauntlet scenes should be available from the region map');
const boneBottomMeta = readGzipJson(path.join(dataRoot, 'rooms', 'bone_01b.json.gz'));
const boneBottomArtwork = Object.values(boneBottomMeta.architect?.enemyArtwork || {});
assert.ok(boneBottomArtwork.length > 0,
  'Bone Bottom Architect placements need real Silksong enemy sprites');
const textureAssets = new Set((assetIndex.images || []).map(asset => asset.file));
assert.ok(boneBottomArtwork.every(art => textureAssets.has(`artwork/${art.sprite.textureSha256}.webp`)),
  'Bone Bottom enemy sprites must resolve to atlases already packaged for hosting');
const bone01 = areas.find(area => area.key === 'PATH_OF_BONE')?.rooms.find(room => room.name === 'bone_01');
assert.ok(bone01?.architect?.markerCount >= 2, 'Bone_01 must expose its multiple GauntletSong markers on The Marrow map');
assert.ok(bone01,
  'Bone_01 gauntlet rooms must remain indexed under The Marrow');

const sprites = indexedRows.flatMap(room => room.mapSprites || [])
  .concat(areas.flatMap(area => [...(area.unmappedMapArtwork || []), ...(area.conditionalMapArtwork || [])]
    .flatMap(row => row.mapSprites || [])));
assert.ok(sprites.some(sprite => (sprite.meshVertices || []).length >= 3 && (sprite.meshIndices || []).length >= 3 &&
  sprite.meshVertices.every(vertex => Number.isFinite(vertex.x) && Number.isFinite(vertex.y))),
  'map sprites must carry authored mesh geometry so clipping preserves the original tile silhouettes');

const transitions = navigation.transitionPairs || [];
assert.ok(transitions.length > 0, 'map must expose cross-area transition links');
for (const edge of transitions) {
  const from = areas.find(area => area.key === edge.fromArea);
  const to = areas.find(area => area.key === edge.toArea);
  const fromRoom = from?.rooms.find(room => room.name === edge.fromRoom);
  assert.ok(fromRoom, `missing transition source ${edge.fromRoom}`);
  assert.ok(to?.rooms.some(room => room.name === edge.toRoom), `missing transition destination ${edge.toRoom}`);
  assert.ok(fromRoom.areaTransitions?.some(link => link.areaKey === edge.toArea && link.roomName === edge.toRoom),
    `transition room ${edge.fromRoom} must provide a button to ${edge.toRoom}`);
  assert.ok(edge.edgeGap <= 0.3 && edge.fromCenter && edge.toCenter, 'transition links must use adjacent authored room boundaries');
}

const architectRooms = [];
const architectEnemyTextures = new Set();
let architectEnemyArtworkTypes = 0;
for (const room of manifest.rooms || []) {
  if (!room.metadata) continue;
  const sidecarPath = path.join(dataRoot, `${room.metadata}.gz`);
  assert.ok(fs.existsSync(sidecarPath), `missing hosted room metadata: ${room.metadata}`);
  const metadata = readGzipJson(sidecarPath);
  if (!metadata.architect) continue;
  const artworks = Object.values(metadata.architect.enemyArtwork || {});
  architectRooms.push(room.name);
  architectEnemyArtworkTypes += artworks.length;
  for (const art of artworks) {
    const hash = String(art.sprite?.textureSha256 || '').toLowerCase();
    assert.match(hash, /^[a-f0-9]{64}$/, `${room.name} has an invalid enemy sprite texture hash`);
    const assetPath = `artwork/${hash}.webp`;
    assert.ok(textureAssets.has(assetPath), `${room.name} enemy sprite atlas is absent from the asset index: ${hash}`);
    assert.ok(fs.existsSync(path.join(dataRoot, assetPath)), `${room.name} enemy sprite atlas file is absent: ${hash}`);
    architectEnemyTextures.add(hash);
  }
}

console.log(JSON.stringify({ status: 'passed', renderedRooms: rendered.length,
  roomsWithAuthoredOrSharedPosition: positionedRenderedCount, roomsWithoutMapPosition: archivedNames.size,
  boneBottomArchitectMarkers: boneBottom.architect.markerCount,
  boneBottomEnemyArtworkTypes: boneBottomArtwork.length,
  architectRoomSidecars: architectRooms.length,
  architectEnemyArtworkTypes,
  architectEnemySpriteAtlases: architectEnemyTextures.size,
  gameMapSpritesWithMeshGeometry: sprites.filter(sprite => (sprite.meshVertices || []).length >= 3).length,
  transitionPairs: transitions.length }, null, 2));
