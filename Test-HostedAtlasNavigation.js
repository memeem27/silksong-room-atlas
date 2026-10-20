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

const containsBounds = (outer, inner, label) => {
  assert.ok(outer && inner, `${label} must have both room geometry and fit bounds`);
  const epsilon = 0.03;
  assert.ok(inner.minX >= outer.minX - epsilon && inner.maxX <= outer.maxX + epsilon &&
    inner.minY >= outer.minY - epsilon && inner.maxY <= outer.maxY + epsilon,
  `${label} must stay inside its section fit bounds`);
};
const meshBounds = sprites => {
  const points = (sprites || []).flatMap(sprite => (sprite.meshVertices || []).map(vertex => ({
    x: sprite.worldPosition.x + (sprite.worldM00 ?? 1) * vertex.x + (sprite.worldM01 ?? 0) * vertex.y,
    y: sprite.worldPosition.y + (sprite.worldM10 ?? 0) * vertex.x + (sprite.worldM11 ?? 1) * vertex.y
  })));
  if (!points.length) return null;
  return { minX: Math.min(...points.map(point => point.x)), maxX: Math.max(...points.map(point => point.x)),
    minY: Math.min(...points.map(point => point.y)), maxY: Math.max(...points.map(point => point.y)) };
};
let fittedSectionCount = 0;
const areasWithoutDetailBounds = mainAreas.filter(area => !area.detailBounds);
for (const area of areasWithoutDetailBounds) {
  assert.ok(area.wideBounds || area.widePosition, `${area.key} without room-map bounds should retain its world-map location`);
  assert.equal((area.rooms || []).filter(room => room.mapSprites?.length || room.mapAnchor).length, 0,
    `${area.key} should not claim room geometry without section fit bounds`);
  assert.equal((area.unmappedMapArtwork || []).length, 0, `${area.key} should not contain loose map art without section fit bounds`);
  assert.equal((area.conditionalMapArtwork || []).length, 0, `${area.key} should not contain conditional map art without section fit bounds`);
}
for (const area of mainAreas) {
  if (!area.detailBounds) continue;
  fittedSectionCount++;
  for (const room of area.rooms || []) {
    if (room.conditionalMapState) continue;
    if (room.bounds && (room.mapSprites?.length || room.mapAnchor)) containsBounds(area.detailBounds, room.bounds, `${area.key}/${room.name}`);
    const geometry = meshBounds(room.mapSprites);
    if (geometry) containsBounds(area.detailBounds, geometry, `${area.key}/${room.name} sprite mesh`);
  }
  for (const row of area.unmappedMapArtwork || []) {
    if (row.bounds) containsBounds(area.detailBounds, row.bounds, `${area.key}/${row.mapObjectName || row.name} extra map art`);
    const geometry = meshBounds(row.mapSprites);
    if (geometry) containsBounds(area.detailBounds, geometry, `${area.key}/${row.mapObjectName || row.name} sprite mesh`);
  }
  const conditionalBounds = area.detailBoundsWithConditional || area.detailBounds;
  for (const row of area.conditionalMapArtwork || []) {
    if (row.bounds) containsBounds(conditionalBounds, row.bounds, `${area.key}/${row.mapObjectName || row.name} conditional map art`);
    const geometry = meshBounds(row.mapSprites);
    if (geometry) containsBounds(conditionalBounds, geometry, `${area.key}/${row.mapObjectName || row.name} conditional sprite mesh`);
  }
  for (const room of area.rooms || []) if (room.conditionalMapState) {
    if (room.bounds) containsBounds(conditionalBounds, room.bounds, `${area.key}/${room.name} conditional map room`);
    const geometry = meshBounds(room.mapSprites);
    if (geometry) containsBounds(conditionalBounds, geometry, `${area.key}/${room.name} conditional sprite mesh`);
  }
}
assert.ok(fittedSectionCount >= 24, 'every authored section with room geometry must have a fitted map extent');

const peakArea = areas.find(area => area.key === 'PEAK');
const peakRows = peakArea?.unmappedMapArtwork || [];
const peakRoomKeys = new Set((peakArea?.rooms || []).filter(room => renderedNames.has(room.name.toLowerCase()))
  .flatMap(room => [room.name, room.mapObjectName].filter(Boolean).map(name => name.toLowerCase().replace(/[^a-z0-9]/g, ''))));
const peakUnlinked = peakRows.filter(row => {
  const parts = String(row.mapObjectName || row.name).split(/[_\s-]+/).filter(Boolean);
  return !parts.some((_, index) => peakRoomKeys.has(parts.slice(0, index + 1).join('').toLowerCase()));
});
assert.equal(peakUnlinked.length, 0, `every Mount Fay extra map piece should link to an exported room: ${peakUnlinked.map(row => row.mapObjectName || row.name).join(', ')}`);

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
const bone01Meta = readGzipJson(path.join(dataRoot, 'rooms', 'bone_01.json.gz'));
const boneRollerArt = bone01Meta.architect?.enemyArtwork?.boneroller;
assert.equal(boneRollerArt?.sprite?.name, 'RR_idle0000',
  'Hosted Bone 01 must use the real Rock Roller idle sprite instead of its journal portrait');
assert.equal(boneRollerArt?.sourceBundle, 'animations_assets_areabone.bundle',
  'Hosted Bone 01 Rock Roller artwork must come from the Silksong animation bundle');
assert.ok(textureAssets.has(`artwork/${boneRollerArt.sprite.textureSha256}.webp`),
  'Hosted Bone 01 Rock Roller marker must reference its packaged real-game texture');
const tutorialRoom = rendered.find(room => room.name.toLowerCase() === 'tut_01');
assert.ok(tutorialRoom?.metadata, 'The tutorial room must retain its rendered sidecar');
const tutorialMetadata = readGzipJson(path.join(dataRoot, `${tutorialRoom.metadata}.gz`));
const tutorialFiltered = tutorialMetadata.render?.filteredEffectRenderers;
assert.ok(tutorialFiltered?.screenEffectRendererCount > 0,
  'Tut_01 must exclude its serialized black/fader mask layers that cover undiscovered room art');
assert.ok(tutorialFiltered.examples.some(row => /fader|mask|black.?solid/i.test(`${row.objectName} ${row.artworkName}`)),
  'Tut_01 sidecar must record the mask renderer removed from its image');
const boneEast07Room = manifest.rooms.find(room => room.name.toLowerCase() === 'bone_east_07');
assert.ok(boneEast07Room?.metadata, 'Bone East 07 must retain its room sidecar');
const boneEast07Metadata = readGzipJson(path.join(dataRoot, `${boneEast07Room.metadata}.gz`));
const boneEast07Filtered = boneEast07Metadata.render?.filteredEffectRenderers;
assert.ok(boneEast07Filtered?.screenEffectRendererCount > 0,
  'Bone East 07 must exclude its serialized fader overlay from the room image');
assert.ok(boneEast07Filtered?.lightingFogRendererCount > 0,
  'Bone East 07 must exclude its serialized fog and lighting sprites from the room image');
const boneEast07Objects = boneEast07Metadata.objects || [];
assert.ok(boneEast07Objects.some(object => /standard_fog/i.test(object.name) && object.sprites?.length),
  'Bone East 07 sidecar must retain its game-textured standard_fog renderers');
assert.ok(boneEast07Objects.some(object => /hornet_fader/i.test(object.name) && object.sprites?.length),
  'Bone East 07 sidecar must retain its game-textured hornet_fader renderer');

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
let verifiedMaskFilteredRooms = 0;
for (const room of manifest.rooms || []) {
  if (!room.metadata) continue;
  const sidecarPath = path.join(dataRoot, `${room.metadata}.gz`);
  assert.ok(fs.existsSync(sidecarPath), `missing hosted room metadata: ${room.metadata}`);
  const metadata = readGzipJson(sidecarPath);
  if (room.image) {
    assert.equal(metadata.render?.gameBundleTexturesOnly, true, `${room.name} must use only Silksong bundle textures`);
    assert.deepEqual(metadata.render?.missingTextureSha256 || [], [], `${room.name} has missing game textures`);
    assert.equal(metadata.render?.screenEffectsIncluded, false, `${room.name} must exclude gameplay screen masks`);
    assert.equal(metadata.render?.shaderDrivenMaskArtworkIncluded, false, `${room.name} must not bake shader mask overlays`);
    assert.equal(metadata.render?.inactiveRenderersIncluded, true,
      `${room.name} must include progression-hidden room art so undiscovered areas are not blacked out`);
    assert.equal(metadata.render?.inactiveArtworkClippedToActiveBounds, true,
      `${room.name} must keep progression-hidden art inside the authored room bounds`);
    assert.ok(metadata.render?.excluded?.includes('shader-driven mask/light/fog effects'),
      `${room.name} must exclude screen-bound shader masks that obscure undiscovered room art`);
    verifiedMaskFilteredRooms++;
  }
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
assert.equal(Boolean(manifest.renderProfile?.architectPlacementMetadataIncluded), architectRooms.length > 0,
  'top-level render profile must continue to advertise retained Architect placement metadata');

console.log(JSON.stringify({ status: 'passed', renderedRooms: rendered.length,
  roomsWithAuthoredOrSharedPosition: positionedRenderedCount, roomsWithoutMapPosition: archivedNames.size,
  sectionsWithFitBounds: fittedSectionCount, mountFayClickableExtraMapPieces: peakRows.length - peakUnlinked.length,
  locationsWithoutRoomMap: areasWithoutDetailBounds.map(area => area.key),
  maskFilteredRooms: verifiedMaskFilteredRooms,
  boneBottomArchitectMarkers: boneBottom.architect.markerCount,
  boneBottomEnemyArtworkTypes: boneBottomArtwork.length,
  architectRoomSidecars: architectRooms.length,
  architectEnemyArtworkTypes,
  architectEnemySpriteAtlases: architectEnemyTextures.size,
  gameMapSpritesWithMeshGeometry: sprites.filter(sprite => (sprite.meshVertices || []).length >= 3).length,
  transitionPairs: transitions.length }, null, 2));
