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
const releaseIndex = JSON.parse(fs.readFileSync(path.join(root, 'HostedAtlas', 'site', 'release-assets.json'), 'utf8'));

assert.equal(catalog.format, 'silksong-gauntletsong-catalog');
assert.equal(catalog.formatVersion, 2);
assert.equal(catalog.coverage.hubEntrances, 14, 'all Architect portal entries should be indexed');
assert.equal(catalog.coverage.routeCount, 30, 'hub returns must not be counted as gauntlet routes');
assert.equal(catalog.coverage.uniqueBaseRooms, 23);
assert.equal(catalog.coverage.roomsWithMappedPosition, 23);
assert.equal(catalog.coverage.roomsWithPreprocessedSidecar, 23);
assert.equal(catalog.coverage.arenaScenes, 14, 'every portal must have its own lazy-loaded Architect scene sidecar');
assert.ok(Buffer.byteLength(JSON.stringify(catalog)) < 200_000, 'catalog should stay a compact index');
assert.ok(Array.isArray(catalog.hub.tileCells) && catalog.hub.tileCells.length === catalog.hub.tileCellCount,
  'hub tile footprint must match Architect source occupancy coordinates');
assert.match(catalog.rendering.customArenaImageStatus, /no game tile textures or compiled scene bundles/i,
  'unavailable custom arena artwork must be stated instead of replaced with synthetic terrain');
assert.equal(catalog.enemyArtworkAliases.flintbeetle?.sprite?.name, 'RR_antic0003',
  'Flintbeetle must use the upright Rock Roller sprite frame matching the in-game reference');
assert.equal(catalog.enemyArtworkAliases.flintbeetle?.objectName, 'RR_antic0003');
assert.equal(catalog.enemyArtworkAliases.flintbeetle?.sourceBundle, 'animations_assets_areabone.bundle');
assert.equal(catalog.enemyArtworkAliases.flintbeetle?.sprite?.textureSha256,
  '35a6422836598c9d829eb9d893bece96e62771d83193d1eccb54e0019565b0c4');
const rockRollerIdle = catalog.enemyArtworkAliases.flintbeetle.idleAnimation;
assert.equal(rockRollerIdle?.sourceBundle, 'tk2danimations_assets_areabone.bundle');
assert.equal(rockRollerIdle?.sourceCollection, 'Rock Roller Cln');
assert.equal(rockRollerIdle?.clip, 'Idle');
assert.equal(rockRollerIdle?.framesPerSecond, 12);
assert.deepEqual(rockRollerIdle?.frames.map(frame => frame.name),
  ['RR_idle0001','RR_idle0002','RR_idle0003','RR_idle0004'],
  'idle frame order must come from the serialized game animation clip');
const flintbeetleFacts = catalog.enemyFacts?.flintbeetle;
assert.equal(flintbeetleFacts?.health,95,'the Flintbeetle entry should include sourced base-game health');
assert.deepEqual(flintbeetleFacts?.needleDamageModifiers,[1,0.8,0.8,0.7,0.7]);
assert.ok(flintbeetleFacts?.sources?.some(source=>source.url==='https://hollowknight.wiki/w/Flintbeetle'));
assert.ok(catalog.enemyArtworkAliases.flintbeetle.sprite.meshVertices.length >= 3 &&
  catalog.enemyArtworkAliases.flintbeetle.sprite.meshIndices.length >= 3,
  'Flintbeetle marker must retain the game sprite mesh needed to clip atlas bleed');
const packagedCatalog = readGzipJson(path.join(hostedDataRoot, 'maps', 'gauntlet-song.json.gz'));
assert.deepEqual(packagedCatalog.coverage, catalog.coverage, 'hosted gzip catalog must match the generated local index');
assert.equal(packagedCatalog.enemyArtworkAliases?.flintbeetle?.sprite?.textureSha256,
  catalog.enemyArtworkAliases.flintbeetle.sprite.textureSha256, 'hosted catalog must carry the verified Flintbeetle alias');
assert.deepEqual(packagedCatalog.enemyArtworkAliases?.flintbeetle?.idleAnimation?.frames?.map(frame => frame.textureSha256),
  rockRollerIdle.frames.map(frame => frame.textureSha256), 'hosted catalog must preserve all verified idle-frame references');
assert.deepEqual(packagedCatalog.enemyFacts?.flintbeetle,flintbeetleFacts,
  'the hosted catalog must carry the sourced Flintbeetle facts used by its guide page');
assert.ok(delta.changedFiles.includes('maps/gauntlet-song.json.gz'), 'delta should publish the portal index');
assert.ok(!delta.changedFiles.some(file => file.startsWith('images/')), 'portal-only package must not re-upload or replace room images');

const gauntletKeys = new Set();
const routeScenes = new Set();
for (const gauntlet of catalog.gauntlets) {
  assert.ok(gauntlet.hubPosition && Number.isFinite(gauntlet.hubPosition.x) && Number.isFinite(gauntlet.hubPosition.y), `${gauntlet.name} needs its authored hub position`);
  assert.ok(!Object.hasOwn(gauntlet, 'placements') && !Object.hasOwn(gauntlet, 'tilemap'), 'portal index must not inline scene placements or raw tilemaps');
  const arenaRoute = `maps/gauntlet-scenes/${gauntlet.key}.json`;
  assert.equal(gauntlet.arenaData, arenaRoute, `${gauntlet.name} must point to its safe lazy arena route`);
  const arenaPath = path.join(root, 'workspace', 'gauntlet-song', 'export', 'arenas', `${gauntlet.key}.json`);
  const arenaData = JSON.parse(fs.readFileSync(arenaPath, 'utf8'));
  assert.equal(arenaData.format, 'silksong-architect-arena-layout');
  assert.equal(arenaData.scene, gauntlet.scene);
  assert.equal(arenaData.key, gauntlet.key);
  assert.equal(arenaData.tileCellCount, arenaData.tileCells.length);
  assert.equal(arenaData.placementCount, arenaData.placements.length);
  assert.equal(arenaData.rendering.terrainWasFabricated, false, 'arena sidecars must not contain generated terrain');
  assert.ok(delta.changedFiles.includes(`${arenaRoute}.gz`), `${gauntlet.name} source layout must be published with the data delta`);
  const hostedArena = readGzipJson(path.join(hostedDataRoot, arenaRoute.replaceAll('/', path.sep) + '.gz'));
  assert.deepEqual(hostedArena, arenaData, `${gauntlet.name} hosted arena sidecar must match its Architect source data`);
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
for (const frame of rockRollerIdle.frames) {
  const png = path.join(root, 'workspace', 'scenes', 'artwork', `${frame.textureSha256}.png`);
  assert.equal(require('node:crypto').createHash('sha256').update(fs.readFileSync(png)).digest('hex'), frame.textureSha256,
    `${frame.name} source pixels must match their extracted frame hash`);
  const relative = `artwork/${frame.textureSha256}.webp`;
  assert.ok(artwork.has(relative), `${frame.name} must be indexed for the hosted animation`);
  if (!releaseIndex.assets?.[relative]) {
    assert.ok(delta.changedFiles.includes('asset-index.json.gz'), 'new authentic enemy artwork must update the hosted asset index');
    assert.ok(delta.changedFiles.includes(relative), `${frame.name} must be in the unpublished data delta`);
  }
}
assert.ok(artwork.has(`artwork/${catalog.enemyArtworkAliases.flintbeetle.sprite.textureSha256}.webp`),
  'the real Flintbeetle sprite atlas used by the updated catalog must already be available on the host');
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

for (const id of ['gauntletMapButton','gauntletMapPanel','gauntletMapSummary','gauntletMapRoutes','gauntletGuidePage','openGauntletGuide',
  'gauntletArenaPanel','openGauntletArena','backToGauntletMap','arenaChoiceSelect','toggleArenaTileCells','toggleArenaEnemyPlacements',
  'toggleArenaOtherPlacements','arenaEnemyPlacements','arenaPlacementDetails','arenaRouteList']) assert.match(html, new RegExp(`id="${id}"`));
for (const token of ["'gauntlet-map'", "'gauntlet-arena'", "loadJson('maps/gauntlet-song.json')", 'loadGauntletArena', 'drawGauntletMap', 'drawGauntletArena', 'arenaPlacementAt', 'openGauntletArena', 'openArenaRoute', 'arenaChoicePlacementKeys', 'openGauntletRoute', 'openGauntletGuide', 'data-guide-enemy-key', 'returnToGauntletMap', 'returnToGauntletArena', 'data-enemy-article', 'showEnemyArticle', 'drawEnemyArticleSprite', 'enemyFactsForRecord', 'enemy-wiki-stats']) {
  assert.ok(reader.includes(token), `reader should include GauntletSong map integration: ${token}`);
}
assert.match(reader, /tile occupancy \+ portal coordinates · no hub texture included/i,
  'viewer should disclose that hub artwork is absent');
const arenaChoiceData = { scriptChoices: [{ blockId: 'choice-yes', triggerEvents: ['arenaEnable'] },
  { blockId: 'choice-unlinked', triggerEvents: ['notConnected'] }], placements: [
    { key: 'enemy-linked', enemyCandidate: true, listeners: [{ event: 'arenaEnable', action: 'enable' }] },
    { key: 'object-linked', enemyCandidate: false, listeners: [{ event: 'arenaEnable', action: 'enable' }] },
    { key: 'enemy-other-event', enemyCandidate: true, listeners: [{ event: 'otherEvent', action: 'enable' }] },
    { key: 'enemy-no-listener', enemyCandidate: true, listeners: [] }
  ] };
const arenaControls = { toggleArenaEnemyPlacements: { checked: true }, toggleArenaOtherPlacements: { checked: true } };
const arenaChoiceContext = vm.createContext({ state: { arenaData: arenaChoiceData, selectedArenaChoiceId: 'choice-yes', hiddenArenaPlacementKeys: new Set() }, $: id => arenaControls[id] });
vm.runInContext(`${extractFunction(reader,'arenaChoicePlacementKeys')};${extractFunction(reader,'visibleArenaPlacements')};globalThis.api={arenaChoicePlacementKeys,visibleArenaPlacements};`, arenaChoiceContext);
assert.deepEqual(Array.from(arenaChoiceContext.api.visibleArenaPlacements(), record => record.key).sort(), ['enemy-linked','object-linked'],
  'a challenge choice must show only placements with an exact saved listener for the emitted event');
arenaChoiceContext.state.selectedArenaChoiceId = 'choice-unlinked';
assert.deepEqual(Array.from(arenaChoiceContext.api.visibleArenaPlacements(), record => record.key).sort(),
  ['enemy-linked','enemy-no-listener','enemy-other-event','object-linked'],
  'a choice without matching placement listeners must preserve the full source layout instead of inventing wave changes');
const boneSidecar = JSON.parse(fs.readFileSync(path.join(root, 'workspace', 'preprocessed', 'rooms', 'bone_01.json'), 'utf8'));
const boneRoller = boneSidecar.architect.placements.find(record => record.enemyCandidate && record.placement?.id === 'bone_roller');
const spriteContext = vm.createContext({ state: { roomMeta: boneSidecar, gauntletCatalog: catalog } });
vm.runInContext(`${extractFunction(reader,'enemyArtworkForRecord')};${extractFunction(reader,'enemyFactsForRecord')};${extractFunction(reader,'enemyAnimationFrame')};${extractFunction(reader,'enemySpriteForRecord')};globalThis.api={enemyArtworkForRecord,enemyFactsForRecord,enemySpriteForRecord};`, spriteContext);
const rollerArtwork = spriteContext.api.enemyArtworkForRecord(boneRoller);
assert.equal(rollerArtwork?.sprite?.name, 'RR_idle0000', 'enemy article must resolve the real Rock Roller idle sprite');
assert.equal(rollerArtwork?.sourceBundle, 'animations_assets_areabone.bundle', 'enemy article must identify the game sprite source bundle');
assert.equal(spriteContext.api.enemySpriteForRecord(boneRoller)?.textureSha256, '29d0651e26a837a9cd34318b25b213f7f9a8ea022cbd89556236dd0b1f5d3aab');
spriteContext.state.roomMeta = { architect: { enemyArtwork: {} } };
const flintbeetleRecord = { enemyCandidate:true, placement: { id: 'prefab_gFlintbeetle' }, label: 'gFlintbeetle' };
const flintbeetleArtwork = spriteContext.api.enemyArtworkForRecord(flintbeetleRecord);
assert.equal(spriteContext.api.enemyFactsForRecord(flintbeetleRecord)?.displayName,'Flintbeetle',
  'prefixed Gauntlet enemy IDs should resolve to the sourced bestiary entry');
assert.equal(flintbeetleArtwork?.sprite?.name, 'RR_antic0003', 'Gauntlet Flintbeetle must resolve through the verified upright game sprite alias');
assert.equal(spriteContext.api.enemySpriteForRecord(flintbeetleRecord)?.textureSha256,
  '35a6422836598c9d829eb9d893bece96e62771d83193d1eccb54e0019565b0c4');
const rockRollerRecord = { enemyCandidate:true, placement: { id: 'prefab_gRockRoller' }, label: 'gRockRoller' };
assert.equal(spriteContext.api.enemyFactsForRecord(rockRollerRecord)?.displayName, 'Flintbeetle',
  'Gauntlet placements using the game-internal Rock Roller name should resolve to the sourced Flintbeetle entry');
assert.equal(spriteContext.api.enemyArtworkForRecord(rockRollerRecord)?.sprite?.name, 'RR_antic0003',
  'Gauntlet Rock Roller names should resolve to the verified upright Rock Roller sprite');
spriteContext.state.animateEnemySprites = true;
assert.equal(spriteContext.api.enemySpriteForRecord(flintbeetleRecord,0)?.name,'RR_idle0001');
assert.equal(spriteContext.api.enemySpriteForRecord(flintbeetleRecord,84)?.name,'RR_idle0002');
assert.equal(spriteContext.api.enemySpriteForRecord(flintbeetleRecord,167)?.name,'RR_idle0003');
assert.equal(spriteContext.api.enemySpriteForRecord(flintbeetleRecord,250)?.name,'RR_idle0004');
assert.equal(spriteContext.api.enemySpriteForRecord(flintbeetleRecord,334)?.name,'RR_idle0001',
  'the source-authored Flintbeetle idle clip should loop in the overlay');
spriteContext.state.animateEnemySprites = false;
assert.equal(spriteContext.api.enemySpriteForRecord(flintbeetleRecord)?.name,'RR_antic0003',
  'the matching upright reference sprite remains the non-animated overlay state');
const animationControls={toggleGauntlets:{checked:true},toggleArenaChanges:{checked:true},toggleEnemyTextures:{checked:true}};
const animationGateContext=vm.createContext({
  state:{mode:'room',selectedGauntlet:{key:'boss9'},visiblePlacements:new Map(),roomMeta:{architect:{placements:[flintbeetleRecord]}}},
  $:id=>animationControls[id],canonicalArchitectPlacements:records=>records,placementsForWave:()=>[flintbeetleRecord],
  isPlacementEnabled:()=>true,enemyArtworkForRecord:()=>flintbeetleArtwork
});
vm.runInContext(`${extractFunction(reader,'hasVisibleAnimatedEnemy')};globalThis.api={hasVisibleAnimatedEnemy};`,animationGateContext);
assert.equal(animationGateContext.api.hasVisibleAnimatedEnemy(),true,
  'animation should run for visible animated enemies in a selected gauntlet overlay');
animationControls.toggleEnemyTextures.checked=false;
assert.equal(animationGateContext.api.hasVisibleAnimatedEnemy(),false,
  'disabling enemy textures should stop the animation loop');
animationControls.toggleEnemyTextures.checked=true;animationControls.toggleGauntlets.checked=false;
assert.equal(animationGateContext.api.hasVisibleAnimatedEnemy(),false,
  'the animation loop must remain off when the gauntlet layer is hidden');
animationControls.toggleGauntlets.checked=true;animationGateContext.state.mode='area';
assert.equal(animationGateContext.api.hasVisibleAnimatedEnemy(),false,
  'the animation loop must remain off outside room view');
const articleRecord={...flintbeetleRecord,key:'article-flintbeetle',worldPosition:{x:12.5,y:4.25,z:0.006},activeByDefault:true,config:{enemy_hp_scale:'True'},listeners:[]};
const articleElements={enemyArticle:{hidden:true,innerHTML:'',scrollIntoView(){}},enemyArticleClose:{addEventListener(){}}};
const articleContext=vm.createContext({state:{roomMeta:{architect:{placements:[articleRecord]}},gauntletCatalog:catalog},
  $:id=>articleElements[id],esc:value=>String(value??''),labelCase:value=>String(value),fileBase:()=> 'Bone_07',
  enemySpriteForRecord:()=>flintbeetleArtwork.sprite,enemyArtworkForRecord:()=>flintbeetleArtwork,
  enemyFactsForRecord:spriteContext.api.enemyFactsForRecord,isPlacementEnabled:()=>true,drawEnemyArticleSprite(){}});
vm.runInContext(`${extractFunction(reader,'showEnemyArticle')};globalThis.api={showEnemyArticle};`,articleContext);
articleContext.api.showEnemyArticle(articleRecord.key);
assert.match(articleElements.enemyArticle.innerHTML,/<article class="enemy-wiki-page">/);
assert.match(articleElements.enemyArticle.innerHTML,/>95<\/span>/);
assert.match(articleElements.enemyArticle.innerHTML,/Flintgem/);
assert.match(articleElements.enemyArticle.innerHTML,/100% · 80% · 80% · 70% · 70%/);
assert.match(articleElements.enemyArticle.innerHTML,/Selected Gauntlet placement/);
assert.match(articleElements.enemyArticle.innerHTML,/https:\/\/hollowknight\.wiki\/w\/Flintbeetle/);
const flintbeetleRooms = catalog.mappedRooms.filter(room => room.architect?.enemies?.some(enemy => /flintbeetle/i.test(enemy.id)));
assert.ok(flintbeetleRooms.length >= 3, 'Gauntlet catalog should include each routed Flintbeetle room');
assert.ok(flintbeetleRooms.every(room => room.architect.enemies.filter(enemy => /flintbeetle/i.test(enemy.id)).every(enemy => enemy.sprite?.textureSha256 === flintbeetleArtwork.sprite.textureSha256)),
  'Flintbeetle sprite coverage must be reflected in portal metadata');

const spriteClipContext = vm.createContext({});
vm.runInContext(`${extractFunction(reader,'spriteGeometry')};${extractFunction(reader,'clipSpriteMesh')};globalThis.api={spriteGeometry,clipSpriteMesh};`, spriteClipContext);
const clipCalls = [], clipContext = {beginPath:()=>clipCalls.push('begin'),moveTo:()=>clipCalls.push('move'),lineTo:()=>clipCalls.push('line'),closePath:()=>clipCalls.push('close'),clip:()=>clipCalls.push('clip')};
const flintSprite = catalog.enemyArtworkAliases.flintbeetle.sprite;
assert.equal(spriteClipContext.api.clipSpriteMesh(clipContext,flintSprite,spriteClipContext.api.spriteGeometry(flintSprite)),true,
  'enemy sprite renderer must clip the atlas crop to the source SpriteRenderer mesh');
assert.equal(clipCalls.filter(call=>call==='close').length,flintSprite.meshIndices.length/3,
  'the clipped texture must preserve every authored triangle in the game sprite mesh');
assert.equal(clipCalls.at(-1),'clip');
assert.ok(reader.includes('clipSpriteMesh(context,sprite,geometry)')&&reader.includes('clipSpriteMesh(target,sprite,geo)'),
  'both gauntlet placements and enemy detail artwork must use the mesh-clipped sprite renderer');

const guideContext = vm.createContext({});
vm.runInContext(`${extractFunction(reader,'labelCase')};${extractFunction(reader,'waveGroups')};${extractFunction(reader,'eventActionState')};${extractFunction(reader,'canonicalGuidePlacements')};${extractFunction(reader,'placementsForGuidePhase')};${extractFunction(reader,'guidePlacementEnabled')};globalThis.api={waveGroups,canonicalGuidePlacements,placementsForGuidePhase,guidePlacementEnabled};`, guideContext);
const guideArchitect = {
  eventGroups: [{name:'wave1Start',actions:'enable'},{name:'wave1End',actions:'disable'},{name:'wave2Start',actions:'enable'}],
  placements: [
    {key:'a',enemyCandidate:true,activeByDefault:false,listeners:[{event:'wave1Start',action:'enable'},{event:'wave1End',action:'disable'}]},
    {key:'b',enemyCandidate:true,activeByDefault:true,listeners:[]},
    {key:'c',enemyCandidate:false,activeByDefault:false,listeners:[{event:'wave1Start',action:'enable'}]},
    {key:'d',enemyCandidate:true,activeByDefault:false,listeners:[{event:'wave2Start',action:'enable'}]},
    {key:'parent',enemyCandidate:true,activeByDefault:false,listeners:[{event:'wave1Start',action:'enable'}]},
    {key:'parent/child',enemyCandidate:true,activeByDefault:false,listeners:[{event:'wave1Start',action:'enable'}]}
  ]
};
const phases = guideContext.api.waveGroups(guideArchitect);
assert.deepEqual(Array.from(phases,phase=>phase.startEvent), ['wave1Start','wave2Start']);
const firstPhase = guideContext.api.placementsForGuidePhase(guideArchitect,phases[0]);
assert.deepEqual(Array.from(firstPhase,record=>record.key).sort(), ['a','b','c','parent/child']);
assert.equal(guideContext.api.guidePlacementEnabled(firstPhase.find(record=>record.key==='a'),phases[0]), true,
  'an authored phase start action should determine the guide state for linked enemies');
assert.equal(guideContext.api.guidePlacementEnabled(firstPhase.find(record=>record.key==='b'),phases[0]), true,
  'a listener-free enemy should retain its serialized active state across phases');
assert.ok(!firstPhase.some(record=>record.key==='d'), 'the guide must not list a different wave’s listener as present in this phase');

const directEventArchitect = {
  eventGroups: [
    {name:'bossStart',actions:'enable'},{name:'bossEnd',actions:'disable / enable'},
    {name:'boss9',actions:'display_text / enable'}
  ],
  placements: [{key:'flintbeetle-spawn',enemyCandidate:true,activeByDefault:false,
    listeners:[{event:'boss9',action:'enable'}]}]
};
const eventContext = vm.createContext({
  state: {roomMeta:{architect:directEventArchitect},selectedWave:'boss9',visiblePlacements:new Map()},
  $: () => ({checked:true})
});
vm.runInContext(`${extractFunction(reader,'labelCase')};${extractFunction(reader,'waveGroups')};${extractFunction(reader,'selectedWaveData')};${extractFunction(reader,'placementsForWave')};${extractFunction(reader,'eventActionState')};${extractFunction(reader,'applySelectedWaveState')};${extractFunction(reader,'isPlacementEnabled')};globalThis.api={waveGroups,selectedWaveData,placementsForWave,applySelectedWaveState,isPlacementEnabled};`, eventContext);
const directPhases = eventContext.api.waveGroups(directEventArchitect);
assert.ok(directPhases.some(phase=>phase.startEvent==='boss9'&&phase.label==='Boss 9'),
  'standalone activation events such as boss9 must be selectable even without Start/End suffixes');
assert.equal(eventContext.api.selectedWaveData().startEvent,'boss9');
assert.deepEqual(Array.from(eventContext.api.placementsForWave(),record=>record.key),['flintbeetle-spawn']);
eventContext.api.applySelectedWaveState({virtualEvent:'bossStart',virtualEndEvent:'bossEnd'});
assert.equal(eventContext.api.isPlacementEnabled(directEventArchitect.placements[0]),true,
  'selecting an event phase should reveal its initially inactive Flintbeetle placement');

const bone15Sidecar=readGzipJson(path.join(hostedDataRoot,'rooms','bone_15.json.gz'));
const bone15Flintbeetles=bone15Sidecar.architect.placements.filter(record=>record.enemyCandidate&&record.placement?.id==='flintbeetle');
assert.equal(bone15Flintbeetles.length,5,'Bone 15 should preserve the five event-activated Flintbeetle placements');
eventContext.state.roomMeta=bone15Sidecar;
eventContext.state.selectedWave='boss9';
assert.ok(eventContext.api.waveGroups(bone15Sidecar.architect).some(phase=>phase.startEvent==='boss9'&&phase.label==='Boss 9'),
  'Bone 15 boss9 must be exposed as a selectable activation phase');
assert.equal(Array.from(eventContext.api.placementsForWave()).filter(record=>record.placement?.id==='flintbeetle').length,5,
  'the boss9 phase must include all five Flintbeetles');
eventContext.api.applySelectedWaveState(bone15Sidecar.architect.markers[0]);
assert.ok(bone15Flintbeetles.every(record=>eventContext.api.isPlacementEnabled(record)),
  'the boss9 phase must turn on each saved inactive Flintbeetle placement');
spriteContext.state.roomMeta=bone15Sidecar;
assert.ok(bone15Flintbeetles.every(record=>spriteContext.api.enemySpriteForRecord(record)?.name==='RR_antic0003'),
  'all Bone 15 Flintbeetles must resolve to their authentic upright game sprite');

console.log(`GauntletSong map: ${catalog.coverage.hubEntrances} portals, ${catalog.coverage.routeCount} room routes, ${routeScenes.size} linked rooms, ${catalog.coverage.enemyTypes} enemy types; ${positions.length} independently clickable markers tested.`);
