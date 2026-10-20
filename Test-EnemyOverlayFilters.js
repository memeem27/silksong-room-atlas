const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = __dirname;

function extractFunction(source, name) {
  const match = new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{`).exec(source);
  assert.ok(match, `could not find ${name}`);
  const start = match.index;
  let cursor = source.indexOf('{', match.index), depth = 0, quote = '', lineComment = false, blockComment = false, escaped = false;
  for (; cursor < source.length; cursor++) {
    const ch = source[cursor], next = source[cursor + 1];
    if (lineComment) { if (ch === '\n') lineComment = false; continue; }
    if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; cursor++; } continue; }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; cursor++; continue; }
    if (ch === '/' && next === '*') { blockComment = true; cursor++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return source.slice(start, cursor + 1);
  }
  throw new Error(`unterminated function: ${name}`);
}

const rendererPath = path.join(root, 'src', 'SilksongSceneViewer', 'wwwroot', 'app.js');
const rendererSource = fs.readFileSync(rendererPath, 'utf8');
const rendererFunctions = [
  'normalizeSceneArtworkName', 'isKnownEnemyActorName', 'isKnownEnemyArtworkName',
  'isEnemyArtworkObject', 'classifyObject', 'spritePassesFilters', 'meshPassesFilters'
].map(name => extractFunction(rendererSource, name)).join('\n');
const state = { batchRendering: true, objectById: new Map(), objectVisibilityOverrides: new Map() };
const context = vm.createContext({
  state,
  componentTerms: { enemy: [], spawn: [], check: [] },
  matchComponents: () => false,
  manualVisibilityFor: () => 'auto',
  batchRenderInactiveEnabled: () => false,
  batchIncludeDisabledRenderersEnabled: () => false,
  objectIsActive: () => true,
  isSceneBorderArtwork: () => false,
  isScreenEffect: () => false,
  isLightingArtwork: () => false,
  isGameBundleTexture: () => true,
  isGeneratedCollisionTileMesh: () => false
});
vm.runInContext(`${rendererFunctions}\nglobalThis.filters = { isEnemyArtworkObject, classifyObject, spritePassesFilters, meshPassesFilters };`, context);

const enemyRoot = { id: 'enemy', parentId: null, classification: { enemy: true } };
const enemyChild = { id: 'enemy-renderer', parentId: enemyRoot.id, classification: { enemy: false } };
const roomProp = { id: 'prop', parentId: null, classification: { enemy: false } };
state.objectById = new Map([[enemyRoot.id, enemyRoot], [enemyChild.id, enemyChild], [roomProp.id, roomProp]]);
const sprite = { blendMode: 'normal', sortingLayerKnown: true, rendererEnabled: true, imageUrl: 'game-atlas', rectWidth: 8, rectHeight: 8 };
const mesh = { imageUrl: 'game-atlas', blendMode: 'normal', sortingLayerKnown: true, rendererEnabled: true };
assert.equal(context.filters.spritePassesFilters(enemyChild, sprite, false, true), false,
  'enemy child sprites must be omitted from clean batch room images');
assert.equal(context.filters.meshPassesFilters(enemyChild, mesh, false, true), false,
  'enemy child meshes must be omitted from clean batch room images');
assert.equal(context.filters.spritePassesFilters(roomProp, sprite, false, true), true,
  'ordinary room artwork must remain in clean batch room images');

const missedBoneGoomba = { id: 'unclassified-goomba', name: 'Bone_Goomba_Large0013', parentId: null,
  classification: { enemy: false }, sprites: [{ name: 'Bone_Goomba_Large0013' }] };
const goombaDeathEffect = { id: 'goomba-effect', name: 'bone_goomba_skull_break', parentId: null,
  classification: { enemy: false }, sprites: [{ name: 'BG_appear_burst0000' }] };
const boneDecoration = { id: 'bone-decoration', name: 'Bone_Skull_pile', parentId: null,
  classification: { enemy: false }, sprites: [{ name: 'Bone_Skull_pile' }] };
state.objectById = new Map([[missedBoneGoomba.id, missedBoneGoomba], [goombaDeathEffect.id, goombaDeathEffect],
  [boneDecoration.id, boneDecoration]]);
assert.equal(context.filters.spritePassesFilters(missedBoneGoomba, sprite, false, true), false,
  'unclassified enemy actors must not be baked into clean room images');
assert.equal(context.filters.spritePassesFilters(goombaDeathEffect, sprite, false, true), false,
  'enemy-specific animation effects must not be baked into clean room images');
assert.equal(context.filters.spritePassesFilters(boneDecoration, sprite, false, true), true,
  'enemy-themed bone scenery must remain in clean room images');
assert.equal(context.filters.classifyObject(missedBoneGoomba).enemy, true,
  'known enemy actors must receive enemy marker classification even without enemy components');
const silhouetteParent = { id: 'silhouettes-parent', name: 'Silhouettes Parent', parentId: null,
  classification: { enemy: false } };
const silhouettedRockRoller = { id: 'silhouetted-rock-roller', name: 'Silhoutte (1)', parentId: silhouetteParent.id,
  classification: { enemy: false }, sprites: [{ name: 'RR_idle0003' }] };
state.objectById = new Map([[silhouetteParent.id, silhouetteParent], [silhouettedRockRoller.id, silhouettedRockRoller]]);
assert.equal(context.filters.spritePassesFilters(silhouettedRockRoller, sprite, false, true), false,
  'silhouette actor sprites must not be baked into clean room images');
assert.equal(context.filters.classifyObject(silhouettedRockRoller).enemy, true,
  'Silhoutte actor objects must receive an enemy marker classification');
assert.equal(context.filters.isEnemyArtworkObject({ id: 'rr-frame', name: 'Animation Frame', parentId: null,
  classification: { enemy: false }, sprites: [{ name: 'RR_idle0003' }] }), true,
  'Rock Roller animation frames must be excluded even when their object names are generic');
state.batchRendering = false;
assert.equal(context.filters.spritePassesFilters(enemyChild, sprite, false, true), true,
  'the filter must not alter the interactive scene renderer');

const bone01 = JSON.parse(fs.readFileSync(path.join(root, 'workspace', 'preprocessed', 'rooms', 'bone_01.json'), 'utf8'));
const boneObjects = bone01.objects || [], boneById = new Map(boneObjects.map(object => [object.id, object]));
const hasEnemyAncestor = object => {
  const seen = new Set(); let current = object;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.classification?.enemy === true) return true;
    current = boneById.get(current.parentId);
  }
  return false;
};
const bakedEnemyRenderers = boneObjects.filter(object => hasEnemyAncestor(object) &&
  ((object.sprites || []).length || (object.meshes || []).length));
assert.ok(bakedEnemyRenderers.length > 0,
  'Bone 01 fixture must include enemy descendant renderers to guard against baked enemy sprites');
assert.ok(bakedEnemyRenderers.every(hasEnemyAncestor), 'all selected Bone 01 enemy renderers must be within enemy object trees');
assert.equal(bone01.render?.enemyArtworkInBaseImage, false,
  'refreshed Bone 01 metadata must identify its clean base image as enemy-free');
assert.ok((bone01.render?.excluded || []).includes('enemy object subtrees'),
  'refreshed Bone 01 metadata must document the excluded enemy subtree renderers');
const missedBoneGoombaFixture = boneObjects.find(object => object.name === 'Bone_Goomba_Large0013');
assert.ok(missedBoneGoombaFixture?.sprites?.length,
  'Bone 01 fixture must retain the unclassified scene-bundle Goomba renderer for this regression');
state.batchRendering = true;
state.objectById = new Map(boneObjects.map(object => [object.id, object]));
assert.equal(context.filters.spritePassesFilters(missedBoneGoombaFixture, missedBoneGoombaFixture.sprites[0], false, true), false,
  'the real Bone 01 Rock Roller enemy sprite must not be baked into the clean image');
assert.equal(context.filters.classifyObject(missedBoneGoombaFixture).enemy, true,
  'the real Bone 01 Rock Roller enemy must have an enemy marker classification');
const missedSilhouetteFixture = boneObjects.find(object => object.name === 'Silhoutte (1)' &&
  object.sprites?.some(sprite => sprite.name === 'RR_idle0003'));
assert.ok(missedSilhouetteFixture,
  'Bone 01 fixture must contain the missed disguised Rock Roller sprite from Silhouettes Parent');
assert.equal(context.filters.spritePassesFilters(missedSilhouetteFixture, missedSilhouetteFixture.sprites[0], false, true), false,
  'the real Bone 01 disguised Rock Roller sprite must not be baked into the clean image');
assert.equal(context.filters.classifyObject(missedSilhouetteFixture).enemy, true,
  'the real Bone 01 disguised Rock Roller must have an enemy marker classification');

const readerPath = path.join(root, 'HostedAtlas', 'site', 'reader.js');
const readerSource = fs.readFileSync(readerPath, 'utf8');
const placementFunction = extractFunction(readerSource, 'canonicalArchitectPlacements');
const placements = [
  { key: 'group', enemyCandidate: true },
  { key: 'group/body', enemyCandidate: true },
  { key: 'group/wing', enemyCandidate: true },
  { key: 'single', enemyCandidate: true },
  { key: 'arena-wall', enemyCandidate: false }
];
const placementContext = vm.createContext({ state: { roomMeta: { architect: { placements } } }, Set });
vm.runInContext(`${placementFunction}\nglobalThis.select = canonicalArchitectPlacements;`, placementContext);
assert.deepEqual(Array.from(placementContext.select(placements), record => record.key),
  ['group/body', 'group/wing', 'single', 'arena-wall'],
  'Gauntlet markers should collapse wrapper/root duplicates while preserving sibling enemies');

const spriteFunction = extractFunction(readerSource, 'enemySpriteForRecord');
const realEnemyHash = 'a'.repeat(64);
const boneRollerArt = bone01.architect?.enemyArtwork?.boneroller;
assert.ok(boneRollerArt?.sprite?.textureSha256 && boneRollerArt?.sprite?.name === 'RR_idle0000',
  'Bone Roller must use the real Rock Roller idle frame, not the journal portrait');
assert.equal(boneRollerArt.sourceBundle, 'animations_assets_areabone.bundle',
  'Bone Roller artwork must come from the game animation bundle');
const spriteContext = vm.createContext({ state: { roomMeta: { architect: { enemyArtwork: {
  gbeastfly: { sprite: { textureSha256: realEnemyHash } },
  boneroller: boneRollerArt
} } } } });
vm.runInContext(`${spriteFunction}\nglobalThis.matchSprite = enemySpriteForRecord;`, spriteContext);
assert.equal(spriteContext.matchSprite({ placement: { id: 'prefab_gBeastfly' }, label: 'g Beastfly' }).textureSha256,
  realEnemyHash, 'matched gauntlet enemy placements must use their Silksong atlas sprite');
assert.equal(spriteContext.matchSprite({ placement: { id: 'bone_roller' }, label: 'Bone Roller' }).name,
  'RR_idle0000', 'Bone Roller placements must display the real animated Rock Roller frame');
assert.equal(spriteContext.matchSprite({ placement: { id: 'unknown_enemy' }, label: 'unknown enemy' }), null,
  'unmatched enemy types must not be assigned invented or unrelated textures');

console.log(JSON.stringify({
  status: 'passed',
  bone01EnemyRendererObjects: bakedEnemyRenderers.length,
  verified: ['batch enemy sprites omitted', 'batch enemy meshes omitted', 'room props retained',
    'interactive renderer unchanged', 'unclassified Goomba sprites and effects omitted',
    'Bone 01 enemy marker classification repaired', 'disguised silhouette/Rock Roller art omitted and marked',
    'Bone Roller maps to the native RR_idle0000 game frame',
    'gauntlet wrapper candidates deduplicated',
    'authentic enemy atlas match required', 'unmatched enemy art receives no substitute texture']
}, null, 2));
