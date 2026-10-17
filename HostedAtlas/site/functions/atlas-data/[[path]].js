let releaseIndexPromise;

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }

  let key;
  try {
    key = decodeURIComponent(new URL(request.url).pathname.slice('/atlas-data/'.length));
  } catch {
    return new Response('Invalid asset path', { status: 400 });
  }
  const parts = key.split('/');
  if (!key || parts.some((part) => !part || part === '.' || part === '..') || key.includes('\\')) {
    return new Response('Invalid asset path', { status: 400 });
  }

  const compressedJson = key.toLowerCase().endsWith('.json');
  const objectKey = compressedJson ? `${key}.gz` : key;
  if (env.ATLAS_DATA) {
    const object = await env.ATLAS_DATA.get(objectKey);
    if (object) {
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set('Content-Type', contentTypeFor(key));
      headers.set('Cache-Control', 'public, max-age=86400');
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('ETag', object.httpEtag);
      const ifNoneMatch = request.headers.get('If-None-Match');
      if (ifNoneMatch === object.httpEtag) return new Response(null, { status: 304, headers });
      return new Response(request.method === 'HEAD' ? null : object.body, { headers });
    }
  }

  const index = await getReleaseIndex(env, request.url);
  const record = index.assets?.[objectKey];
  const safeFilename = typeof record?.name === 'string'
    && /^[a-z0-9][a-z0-9_.-]{0,127}\.(?:webp|png|gz)$/i.test(record.name)
    && !record.name.includes('..');
  if (!record || !/^[a-z0-9][a-z0-9-]{0,63}$/i.test(record.tag) || !safeFilename) {
    return new Response('Not found', { status: 404 });
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(index.repository || '')) {
    return new Response('Release storage is not configured.', { status: 503 });
  }

  // Metadata paths like navigation.json.gz are replaced in later releases.
  // Include the mapped release tag in the edge key so a previous release's
  // cached response cannot shadow an updated asset at the same public URL.
  const cacheUrl = new URL(request.url);
  cacheUrl.searchParams.set('__atlas_release', record.tag);
  const cacheKey = new Request(cacheUrl, { method: 'GET' });
  if (request.method === 'GET' && !request.headers.has('Range')) {
    const cached = await caches.default.match(cacheKey);
    if (cached) return cached;
  }

  const assetUrl = `https://github.com/${index.repository}/releases/download/${record.tag}/${record.name}`;
  const upstreamHeaders = new Headers();
  for (const name of ['Range', 'If-None-Match', 'If-Modified-Since']) {
    const value = request.headers.get(name);
    if (value) upstreamHeaders.set(name, value);
  }
  const upstream = await fetch(assetUrl, { method: request.method, headers: upstreamHeaders });
  if (!upstream.ok && upstream.status !== 304) {
    return new Response(`Release asset request failed (${upstream.status}).`, { status: upstream.status });
  }
  const finalHost = new URL(upstream.url || assetUrl).hostname;
  if (finalHost !== 'github.com' && !finalHost.endsWith('.githubusercontent.com')) {
    return new Response('Unexpected release asset host.', { status: 502 });
  }

  const headers = new Headers();
  headers.set('Content-Type', contentTypeFor(key));
  headers.set('Cache-Control', 'public, max-age=86400');
  headers.set('X-Content-Type-Options', 'nosniff');
  for (const name of ['Content-Length', 'Content-Range', 'ETag', 'Last-Modified', 'Accept-Ranges']) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  const body = request.method === 'HEAD' || upstream.status === 304 ? null : upstream.body;
  const response = new Response(body, { status: upstream.status, headers });
  if (request.method === 'GET' && !request.headers.has('Range') && response.status === 200) {
    context.waitUntil(caches.default.put(cacheKey, response.clone()).catch(() => {}));
  }
  return response;
}

async function getReleaseIndex(env, requestUrl) {
  if (!releaseIndexPromise) {
    const indexUrl = new URL('/release-assets.json', requestUrl);
    releaseIndexPromise = env.ASSETS.fetch(new Request(indexUrl)).then(async (response) => {
      if (!response.ok) throw new Error(`Release asset index is unavailable (${response.status}).`);
      return response.json();
    }).catch((error) => {
      releaseIndexPromise = undefined;
      throw error;
    });
  }
  try { return await releaseIndexPromise; }
  catch { return { repository: '', assets: {} }; }
}

function contentTypeFor(path) {
  const lower = path.toLowerCase();
  if (lower.endsWith('.json')) return 'application/json; charset=utf-8';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.png')) return 'image/png';
  return 'application/octet-stream';
}
