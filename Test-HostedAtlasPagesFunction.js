const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  const releaseIndex = JSON.parse(fs.readFileSync(path.join(__dirname, 'HostedAtlas', 'site', 'release-assets.json'), 'utf8'));
  const navigationAsset = releaseIndex.assets['maps/navigation.json.gz'];
  assert.equal(navigationAsset?.name, 'navigation.json.gz');
  assert.match(navigationAsset?.tag || '', /^silksong-atlas-data-/,
    'navigation should resolve through the current published data release');
  const functionPath = path.join(__dirname, 'HostedAtlas', 'site', 'functions', 'atlas-data', '[[path]].js');
  const source = fs.readFileSync(functionPath, 'utf8');
  const pagesFunction = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const fetches = [];
  const cacheReads = [];
  const cacheWrites = [];
  globalThis.caches = { default: {
    async match(request) {
      cacheReads.push(request);
      const url = new URL(request.url);
      if (url.pathname === '/atlas-data/maps/navigation.json' && !url.search) {
        return new Response('stale cached map', { status: 200 });
      }
      return undefined;
    },
    async put(request, response) { cacheWrites.push({ request, response }); }
  } };
  globalThis.fetch = async (url, options = {}) => {
    fetches.push({ url: String(url), method: options.method || 'GET', headers: options.headers });
    return new Response(Buffer.from('webp'), { status: 200, headers: { 'Content-Length': '4', ETag: '"sample"' } });
  };

  try {
    const imageName = `${'a'.repeat(64)}.webp`;
    const jsonName = 'bone_01.json.gz';
    const manifestName = 'manifest.json.gz';
    const map = {
      repository: 'atlas-owner/atlas-repo',
      assets: {
        'images/sample.webp': { tag: 'silksong-atlas-data-001', name: imageName },
        'rooms/sample.json.gz': { tag: 'silksong-atlas-data-002', name: jsonName },
        'manifest.json.gz': { tag: 'silksong-atlas-data-002', name: manifestName },
        'maps/navigation.json.gz': { tag: 'silksong-atlas-data-007', name: 'navigation.json.gz' },
        'rooms/unsafe.json.gz': { tag: 'silksong-atlas-data-002', name: '../unsafe.json.gz' }
      }
    };
    const env = { ASSETS: { async fetch(request) {
      assert.equal(new URL(request.url).pathname, '/release-assets.json');
      return new Response(JSON.stringify(map), { headers: { 'Content-Type': 'application/json' } });
    } } };
    const waits = [];
    const context = { env, waitUntil(promise) { waits.push(promise); } };

    const imageResponse = await pagesFunction.onRequest({
      ...context,
      request: new Request('https://atlas.example/atlas-data/images/sample.webp')
    });
    assert.equal(imageResponse.status, 200);
    assert.equal(imageResponse.headers.get('Content-Type'), 'image/webp');
    assert.equal(imageResponse.headers.get('Cache-Control'), 'public, max-age=86400');
    assert.equal(await imageResponse.text(), 'webp');
    assert.equal(fetches[0].url, `https://github.com/atlas-owner/atlas-repo/releases/download/silksong-atlas-data-001/${imageName}`);
    assert.equal(cacheWrites.length, 1);

    const jsonResponse = await pagesFunction.onRequest({
      ...context,
      request: new Request('https://atlas.example/atlas-data/rooms/sample.json')
    });
    assert.equal(jsonResponse.status, 200);
    assert.equal(jsonResponse.headers.get('Content-Type'), 'application/json; charset=utf-8');
    assert.equal(jsonResponse.headers.get('Content-Encoding'), null);
    assert.equal(fetches[1].url, `https://github.com/atlas-owner/atlas-repo/releases/download/silksong-atlas-data-002/${jsonName}`);

    const manifestResponse = await pagesFunction.onRequest({
      ...context,
      request: new Request('https://atlas.example/atlas-data/manifest.json')
    });
    assert.equal(manifestResponse.status, 200);
    assert.equal(manifestResponse.headers.get('Content-Encoding'), null);
    assert.equal(fetches[2].url, `https://github.com/atlas-owner/atlas-repo/releases/download/silksong-atlas-data-002/${manifestName}`);

    const mapResponse = await pagesFunction.onRequest({
      ...context,
      request: new Request('https://atlas.example/atlas-data/maps/navigation.json')
    });
    assert.equal(mapResponse.status, 200);
    assert.equal(fetches[3].url, 'https://github.com/atlas-owner/atlas-repo/releases/download/silksong-atlas-data-007/navigation.json.gz');
    const mapCacheKey = cacheWrites[3].request.url;
    assert.equal(new URL(mapCacheKey).searchParams.get('__atlas_release'), 'silksong-atlas-data-007');
    assert.equal(new URL(cacheReads[3].url).search, '?__atlas_release=silksong-atlas-data-007');
    assert.notEqual(await mapResponse.text(), 'stale cached map');

    const unsafeFilenameResponse = await pagesFunction.onRequest({
      ...context,
      request: new Request('https://atlas.example/atlas-data/rooms/unsafe.json')
    });
    assert.equal(unsafeFilenameResponse.status, 404);
    assert.equal(fetches.length, 4);

    const invalidResponse = await pagesFunction.onRequest({
      ...context,
      request: new Request('https://atlas.example/atlas-data/%2E%2E%2Fsecret')
    });
    assert.equal(invalidResponse.status, 400);
    await Promise.all(waits);
    console.log('Hosted Pages function tests passed: GitHub release images, raw gzip JSON for browser decompression, caching, and path validation.');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
