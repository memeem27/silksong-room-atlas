const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const atlasRoot = path.join(__dirname, 'HostedAtlas');
const siteRoot = path.join(atlasRoot, 'site');
const dataRoot = path.join(atlasRoot, 'r2-data');
const port = Number(process.env.SILKSONG_ATLAS_PORT || 5181);

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'], ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'], ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'], ['.webp', 'image/webp'], ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'], ['.txt', 'text/plain; charset=utf-8']
]);

function safeResolve(root, relativePath) {
  const normalized = relativePath.replace(/\\/g, '/');
  if (!normalized || normalized.split('/').some(part => !part || part === '.' || part === '..')) return null;
  const resolved = path.resolve(root, ...normalized.split('/'));
  return resolved.startsWith(root + path.sep) ? resolved : null;
}

function sendFile(request, response, root, relativePath, options = {}) {
  const filePath = safeResolve(root, relativePath);
  if (!filePath) { response.writeHead(400).end('Invalid path'); return; }
  fs.stat(filePath, (statError, stat) => {
    if (statError || !stat.isFile()) { response.writeHead(404).end('Not found'); return; }
    const etag = `W/"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
    const headers = {
      'Content-Type': options.contentType || mimeTypes.get(path.extname(relativePath).toLowerCase()) || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': options.cacheControl || 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      ETag: etag
    };
    if (options.gzip) headers['Content-Encoding'] = 'gzip';
    if (request.headers['if-none-match'] === etag) { response.writeHead(304, headers).end(); return; }
    response.writeHead(200, headers);
    if (request.method === 'HEAD') { response.end(); return; }
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => { if (!response.headersSent) response.writeHead(500); response.end('Read error'); });
    stream.pipe(response);
  });
}

const server = http.createServer((request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end('Method not allowed');
    return;
  }
  let pathname;
  try { pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname); }
  catch { response.writeHead(400).end('Invalid URL'); return; }

  if (pathname.startsWith('/atlas-data/')) {
    const key = pathname.slice('/atlas-data/'.length);
    const normalized = key.replace(/\\/g, '/');
    if (!normalized || normalized.split('/').some(part => !part || part === '.' || part === '..')) {
      response.writeHead(400).end('Invalid asset path');
      return;
    }
    const isJson = normalized.toLowerCase().endsWith('.json');
    sendFile(request, response, dataRoot, isJson ? `${normalized}.gz` : normalized, {
      gzip: isJson,
      contentType: isJson ? 'application/json; charset=utf-8' : undefined,
      cacheControl: isJson ? 'no-cache' : undefined
    });
    return;
  }

  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  sendFile(request, response, siteRoot, relativePath, { cacheControl: 'no-cache' });
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`Silksong hosted atlas preview: http://127.0.0.1:${port}/\n`);
});
server.on('error', error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
