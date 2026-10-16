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
  const object = await env.ATLAS_DATA.get(objectKey);
  if (!object) return new Response('Not found', { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('Content-Type', contentTypeFor(key));
  headers.set('Cache-Control', 'public, max-age=86400');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('ETag', object.httpEtag);
  if (compressedJson) headers.set('Content-Encoding', 'gzip');

  const ifNoneMatch = request.headers.get('If-None-Match');
  if (ifNoneMatch === object.httpEtag) return new Response(null, { status: 304, headers });
  return new Response(request.method === 'HEAD' ? null : object.body, { headers });
}

function contentTypeFor(path) {
  const lower = path.toLowerCase();
  if (lower.endsWith('.json')) return 'application/json; charset=utf-8';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.png')) return 'image/png';
  return 'application/octet-stream';
}
