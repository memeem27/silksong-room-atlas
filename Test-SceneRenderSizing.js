const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('src/SilksongSceneViewer/wwwroot/app.js', 'utf8');
const densityStart = source.indexOf('function nativeArtworkPixelsPerUnit(');
const densityEnd = source.indexOf('function spriteLocalGeometry(', densityStart);
const effectStart = source.indexOf('function isScreenEffect(');
const effectEnd = source.indexOf('function isBackgroundArtwork(', effectStart);
const exportStateStart = source.indexOf('function batchRenderInactiveEnabled(');
const exportStateEnd = source.indexOf('function objectIsActive(', exportStateStart);
const spriteFilterStart = source.indexOf('function spritePassesFilters(');
const spriteFilterEnd = source.indexOf('function visibleSpriteBounds(', spriteFilterStart);
assert.ok(densityStart >= 0 && densityEnd > densityStart, 'Room density estimator must be present.');
assert.ok(effectStart >= 0 && effectEnd > effectStart, 'Screen-effect filter must be present.');
assert.ok(exportStateStart >= 0 && exportStateEnd > exportStateStart, 'Room export state filters must be present.');
assert.ok(spriteFilterStart >= 0 && spriteFilterEnd > spriteFilterStart, 'Sprite export filter must be present.');

const state = { batchRendering: true, meshAssets: new Map() };
const context = {
  state,
  URLSearchParams,
  window: { location: { search: '' } },
  batchRenderInactiveEnabled: () => true,
  batchIncludeDisabledRenderersEnabled: () => new URLSearchParams(context.window.location.search).get('batchIncludeDisabledRenderers') === '1',
  objectIsActive: object => object.active === true,
  spritePassesFilters: () => true,
  spriteWorldMatrix: sprite => ({ m00: sprite.scaleX ?? 1, m01: 0, m10: 0, m11: sprite.scaleY ?? 1 }),
  meshPassesFilters: () => true,
  manualVisibilityFor: () => 'auto',
  isSceneBorderArtwork: () => false,
  isScreenEffect: () => false,
  isLightingArtwork: () => false,
  isGameBundleTexture: () => true
};
vm.runInNewContext(source.slice(densityStart, densityEnd), context, { filename: 'app.js density estimator' });
vm.runInNewContext(source.slice(effectStart, effectEnd), context, { filename: 'app.js screen-effect filter' });
vm.runInNewContext(source.slice(exportStateStart, exportStateEnd), context, { filename: 'app.js export state filters' });
vm.runInNewContext(source.slice(spriteFilterStart, spriteFilterEnd), context, { filename: 'app.js sprite export filter' });

const roomObjects = [
  { active: true, sprites: [{ pixelsPerUnit: 64, imageUrl: '/api/artwork/' + 'a'.repeat(64) + '.png', rectWidth: 16, rectHeight: 16 }], meshes: [] },
  { active: false, sprites: [{ pixelsPerUnit: 50_000, imageUrl: '/api/artwork/' + 'a'.repeat(64) + '.png', rectWidth: 16, rectHeight: 16 }], meshes: [] },
  { active: true, sprites: [{ pixelsPerUnit: 100_000, rendererEnabled: false, imageUrl: '/api/artwork/' + 'a'.repeat(64) + '.png', rectWidth: 16, rectHeight: 16 }], meshes: [] }
];
assert.equal(context.nativeArtworkPixelsPerUnit(roomObjects), 64,
  'The all-room batch should size images from active room art, not hidden VFX or disabled renderers.');
state.batchRendering = false;
assert.equal(context.nativeArtworkPixelsPerUnit(roomObjects), 50_000,
  'A manual single-room PNG export should retain density from enabled inactive art while excluding disabled renderers.');

assert.equal(context.isScreenEffect({ name: 'Tracking Trail (1)' }, { materialName: 'tracking_line_dots' }), true,
  'Enemy tracking-trail VFX must not be baked into the static room image.');
assert.equal(context.isScreenEffect({ name: 'hornet_fader (2)' }, { name: 'hornet_fader' }), true,
  'Serialized underscores in the Hornet fader name must still identify it as a screen effect.');
assert.equal(context.isLightingArtwork({ name: 'standard_fog (3)' }, { name: 'town_layered_0027_10' }), true,
  'Serialized underscores in standard_fog must still identify it as a lighting/fog effect.');
assert.equal(context.isScreenEffect({ name: 'moss wall' }, { name: 'moss__0022_stalacmoss' }), false,
  'Normal room textures must remain renderable.');
const disabledSprite = { imageUrl: '/api/artwork/' + 'a'.repeat(64) + '.png', rectWidth: 16, rectHeight: 16, rendererEnabled: false };
const enabledSprite = { ...disabledSprite, rendererEnabled: true };
assert.equal(context.spritePassesFilters({ active: false }, disabledSprite, false, true), false,
  'Progression-hidden art must not implicitly turn on disabled renderer components.');
assert.equal(context.spritePassesFilters({ active: false }, enabledSprite, false, true), true,
  'Progression-hidden but enabled room art must remain renderable.');
context.window.location.search = '?batchIncludeDisabledRenderers=1';
assert.equal(context.spritePassesFilters({ active: false }, disabledSprite, false, true), true,
  'Disabled renderers should be available only through the explicit export override.');

console.log('Room render sizing, transient-effect filters, and disabled-renderer handling passed.');
