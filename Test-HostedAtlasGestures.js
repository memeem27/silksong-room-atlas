const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync('HostedAtlas/site/reader.js', 'utf8');
const start = source.indexOf("canvas.addEventListener('wheel'");
const end = source.indexOf("canvas.addEventListener('click'", start);
assert.ok(start >= 0 && end > start, 'Map pointer handlers must remain available for the touch interaction test.');

const listeners = new Map();
const captures = new Set();
const canvas = {
  style: {},
  classList: { add() {}, remove() {} },
  addEventListener(name, handler) { listeners.set(name, handler); },
  getBoundingClientRect() { return { left: 0, top: 0, width: 600, height: 400 }; },
  setPointerCapture(id) { captures.add(id); },
  hasPointerCapture(id) { return captures.has(id); },
  releasePointerCapture(id) { captures.delete(id); }
};
const state = {
  viewport: { key: 'world-map:test', zoom: 2, offsetX: -10, offsetY: 15 },
  drag: null, touchPointers: new Map(), touchPinch: null, suppressClickUntil: 0,
  hoverAreaKey: null, hoverRoomName: null
};
let draws = 0;
const context = {
  canvas, state, MAX_MAP_ZOOM: 64,
  currentViewport: () => state.viewport,
  zoomAt() {}, draw() { draws++; },
  performance: { now: () => 1000 }
};
vm.runInNewContext(source.slice(start, end), context, { filename: 'reader.js map gesture handlers' });

function pointer(type, pointerId, x, y, extra = {}) {
  return { pointerType: type, pointerId, clientX: x, clientY: y, button: 0,
    isPrimary: pointerId === 1, preventDefault() {}, ...extra };
}

listeners.get('pointerdown')(pointer('touch', 1, 100, 100));
listeners.get('pointerdown')(pointer('touch', 2, 200, 100, { isPrimary: false }));
listeners.get('pointermove')(pointer('touch', 2, 300, 100, { isPrimary: false }));
assert.equal(state.viewport.zoom, 4, 'Pinching apart should zoom in proportionally.');
assert.equal((200 - state.viewport.offsetX) / state.viewport.zoom, 80,
  'Pinch zoom should keep the map point beneath the moving midpoint anchored.');
assert.equal((100 - state.viewport.offsetY) / state.viewport.zoom, 42.5,
  'Pinch zoom should preserve the vertical anchor too.');
listeners.get('pointerup')(pointer('touch', 2, 300, 100, { isPrimary: false }));
listeners.get('pointermove')(pointer('touch', 1, 110, 110));
assert.equal(state.viewport.offsetX, -110, 'The remaining finger should continue as a one-finger pan after pinching.');
assert.equal(state.viewport.offsetY, -60);
listeners.get('pointerup')(pointer('touch', 1, 110, 110));
assert.equal(state.drag, null);
assert.ok(state.suppressClickUntil > 1000, 'Pinch and pan gestures should not accidentally select a room.');
assert.ok(draws >= 2, 'Pan and pinch movement should redraw the map.');

state.viewport.zoom = 1; state.viewport.offsetX = 0; state.viewport.offsetY = 0;
state.suppressClickUntil = 0;
listeners.get('pointerdown')(pointer('touch', 3, 10, 10, { isPrimary: true }));
listeners.get('pointermove')(pointer('touch', 3, 40, 25, { isPrimary: true }));
listeners.get('pointerup')(pointer('touch', 3, 40, 25, { isPrimary: true }));
assert.equal(state.viewport.offsetX, 30, 'A single finger should pan horizontally.');
assert.equal(state.viewport.offsetY, 15, 'A single finger should pan vertically.');

state.viewport.zoom = 1; state.viewport.offsetX = 0; state.viewport.offsetY = 0;
state.suppressClickUntil = 0;
listeners.get('pointerdown')(pointer('touch', 4, 50, 50, { isPrimary: true }));
listeners.get('pointerup')(pointer('touch', 4, 50, 50, { isPrimary: true }));
assert.equal(state.suppressClickUntil, 0, 'A tap without movement should remain available for map selection.');

console.log('Hosted atlas touch pinch, pan, and tap gestures passed.');
