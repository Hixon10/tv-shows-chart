#!/usr/bin/env node
// Minimal zero-dependency static file server for local previewing of dist/.
// Serves with the MIME types DuckDB-WASM needs (in particular application/wasm).
//
// Usage: node scripts/serve.mjs [port] [dir]
//        npm run serve

import { createServer } from 'node:http';
import { stat, readFile } from 'node:fs/promises';
import { resolve, extname, normalize } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = new URL('.', import.meta.url).pathname;
const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..');

const port = Number(process.argv[2] ?? process.env.PORT ?? 8080);
const root = resolve(process.argv[3] ?? resolve(repoRoot, 'dist'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.wasm': 'application/wasm',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.txt':  'text/plain; charset=utf-8',
  '.map':  'application/json; charset=utf-8',
  '.duckdb': 'application/octet-stream',
};

if (!existsSync(root)) {
  console.error(`Root directory does not exist: ${root}`);
  console.error('Hint: run `npm run build` first.');
  process.exit(1);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${port}`);
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const safe = normalize(rel).replace(/^([/\\])+/, '');
    const full = resolve(root, safe);
    if (!full.startsWith(root)) {
      res.writeHead(403); res.end('forbidden'); return;
    }
    const s = await stat(full).catch(() => null);
    if (!s || !s.isFile()) {
      res.writeHead(404); res.end('not found'); return;
    }
    const body = await readFile(full);
    res.writeHead(200, {
      'content-type': MIME[extname(full).toLowerCase()] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch (err) {
    console.error(err);
    res.writeHead(500); res.end('server error');
  }
});

server.listen(port, () => {
  console.log(`Serving ${root}`);
  console.log(`Open http://localhost:${port}/`);
});
