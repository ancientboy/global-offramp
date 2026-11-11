import { Miniflare } from 'miniflare';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const root = resolve(process.env.APP_ROOT || '../..');
const origin = process.env.PUBLIC_ORIGIN || 'https://bhcbtc.club';
const publicMode = process.env.PUBLIC_DEMO === 'true';
const auth = publicMode ? null : JSON.parse(await readFile(process.env.AUTH_FILE, 'utf8'));
const owner = auth?.ownerId || 'bhcbtc-public-synthetic-demo';
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.wasm': 'application/wasm', '.gz': 'application/gzip' };
const assets = resolve(root, 'sites-dist/client');
async function asset(request) {
  if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
  let pathname;
  try { pathname = decodeURIComponent(new URL(request.url).pathname); }
  catch { return new Response(null, { status: 400 }); }
  const path = resolve(assets, '.' + pathname);
  if (path !== assets && !path.startsWith(assets + sep)) return new Response(null, { status: 403 });
  for (const candidate of [path, path + '.html', resolve(path, 'index.html')]) {
    try {
      if (!(await stat(candidate)).isFile()) continue;
      return new Response(request.method === 'HEAD' ? null : await readFile(candidate), {
        headers: { 'content-type': mime[extname(candidate)] || 'application/octet-stream', 'cache-control': 'private, max-age=0, must-revalidate' }
      });
    } catch {}
  }
  return new Response('Not found', { status: 404 });
}
const data = resolve(process.env.DATA_DIR || '/var/lib/global-offramp');
const mf = new Miniflare({
  rootPath: root, modulesRoot: root,
  modules: true, scriptPath: resolve(root, 'sites-dist/server/index.js'),
  compatibilityDate: '2026-07-01', host: '127.0.0.1', port: 0,
  d1Databases: { DB: 'global-offramp-v1' }, d1Persist: resolve(data, 'd1'),
  r2Buckets: { BUCKET: 'global-offramp-receipts-v1' }, r2Persist: resolve(data, 'r2'),
  serviceBindings: { ASSETS: asset }, cf: false,
});
const db = await mf.getD1Database('DB');
await db.prepare('CREATE TABLE IF NOT EXISTS offramp_mock_state (owner_id text PRIMARY KEY NOT NULL, revision integer DEFAULT 0 NOT NULL, document text NOT NULL)').run();
const failures = new Map();
function authorized(req) {
  if (publicMode) return true;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const value = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const split = value.indexOf(':');
  const hash = createHash('sha256').update(value.slice(split + 1)).digest();
  const expected = Buffer.from(auth.passwordHash, 'hex');
  return split > 0 && value.slice(0, split) === auth.username && expected.length === hash.length && timingSafeEqual(hash, expected);
}
const server = createServer(async (req, res) => {
  try {
    const ip = req.socket.remoteAddress;
    const now = Date.now();
    for (const [key, value] of failures) if (value.until < now) failures.delete(key);
    if ((failures.get(ip)?.count || 0) >= 20) {
      res.writeHead(429, { 'retry-after': '60', 'cache-control': 'no-store' }); res.end('Please retry later.'); return;
    }
    if (!authorized(req)) {
      if (failures.size < 10000) failures.set(ip, { count: (failures.get(ip)?.count || 0) + 1, until: now + 60000 });
      res.writeHead(401, { 'www-authenticate': 'Basic realm="Huitu private demo", charset="UTF-8"', 'cache-control': 'no-store' }); res.end('Authentication required'); return;
    }
    failures.delete(ip);
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) { res.writeHead(400); res.end(); return; }
    const url = new URL(req.url, origin);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (['authorization', 'host', 'connection', 'transfer-encoding', 'content-length', 'oai-authenticated-user-id', 'x-forwarded-host', 'x-forwarded-proto'].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(item => headers.append(key, item));
      else if (value !== undefined) headers.set(key, value);
    }
    // Identity is assigned only after this gateway authenticates the request.
    headers.set('oai-authenticated-user-id', owner);
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 3 * 1024 * 1024) { res.writeHead(413); res.end(); return; }
      chunks.push(chunk);
    }
    const response = await mf.dispatchFetch(url, { method: req.method, headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
    const outputHeaders = Object.fromEntries(response.headers);
    if (response.headers.getSetCookie().length) outputHeaders['set-cookie'] = response.headers.getSetCookie();
    outputHeaders['x-content-type-options'] = 'nosniff';
    outputHeaders['referrer-policy'] = 'same-origin';
    outputHeaders['x-frame-options'] = 'DENY';
    res.writeHead(response.status, outputHeaders);
    if (response.body) await pipeline(Readable.fromWeb(response.body), res); else res.end();
  } catch (error) {
    console.error('Gateway request failed:', error.name);
    if (!res.headersSent) res.writeHead(500, { 'cache-control': 'no-store' });
    res.end('Internal server error');
  }
});
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.listen(Number(process.env.PORT || 4181), process.env.HOST || '127.0.0.1', () => console.log('Huitu MOCK gateway ready'));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
  server.close(); await mf.dispose(); process.exit(0);
});
