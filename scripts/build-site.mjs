#!/usr/bin/env node
// Top-level build: produces ./dist/ ready for GitHub Pages.
//
// Steps:
//   1. Clean dist/ and copy site/ + vendor/ into it.
//   2. Run build-duckdb.mjs to produce dist/data/tvshows.duckdb.
//   3. Write dist/data/build-meta.json (counts + timestamps).
//   4. Size guard (fail build if outputs exceed safety thresholds).
//   5. Smoke-test: load the freshly built .duckdb with the *same* duckdb-wasm
//      package the site will use (Node bundle, but identical engine version),
//      and run a handful of queries that hit tables, macros and the view.
//      Catches storage-format / macro-resolution mismatches before deploy.

import { spawn } from 'node:child_process';
import { cp, mkdir, rm, writeFile, stat, readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const SITE_DIR   = resolve(repoRoot, 'site');
const VENDOR_DIR = resolve(repoRoot, 'vendor');
const DATA_DIR   = resolve(repoRoot, 'data');
const DIST_DIR   = resolve(repoRoot, 'dist');
const DIST_DATA  = resolve(DIST_DIR, 'data');
const DB_PATH    = resolve(DIST_DATA, 'tvshows.duckdb');

const MAX_DIST_BYTES = Number(process.env.MAX_DIST_BYTES ?? 500 * 1024 * 1024);
const MAX_DB_BYTES   = Number(process.env.MAX_DB_BYTES   ?? 200 * 1024 * 1024);

async function main() {
  await cleanDist();
  await copyTree(SITE_DIR,   DIST_DIR);
  await copyTree(VENDOR_DIR, resolve(DIST_DIR, 'vendor'));
  await mkdir(DIST_DATA, { recursive: true });

  await runNode(resolve(__dirname, 'build-duckdb.mjs'));

  await writeBuildMeta();

  await sizeGuard();

  await smokeTest();

  console.log('\nBuild succeeded. dist/ is ready to deploy.');
}

async function cleanDist() {
  if (existsSync(DIST_DIR)) {
    await rm(DIST_DIR, { recursive: true, force: true });
  }
  await mkdir(DIST_DIR, { recursive: true });
}

async function copyTree(src, dst) {
  if (!existsSync(src)) {
    throw new Error(`Missing source directory: ${src}`);
  }
  await cp(src, dst, { recursive: true, errorOnExist: false });
}

function runNode(script, extraEnv = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [script], {
      stdio: 'inherit',
      env: { ...process.env, ...extraEnv },
    });
    child.on('exit', (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${relative(repoRoot, script)} exited with code ${code}`));
    });
    child.on('error', rejectPromise);
  });
}

async function writeBuildMeta() {
  // Count CSV inputs.
  let csvFiles = 0;
  if (existsSync(DATA_DIR)) {
    csvFiles = (await readdir(DATA_DIR))
      .filter((f) => /^(imdb|kinopoisk)-\d{4}-\d{2}-\d{2}\.csv$/.test(f)).length;
  }

  // Pull row counts straight from the just-built db.
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const instance = await DuckDBInstance.create(DB_PATH);
  const conn = await instance.connect();
  let shows, snapshots, dates, firstDate, lastDate;
  try {
    const r1 = await conn.runAndReadAll('SELECT COUNT(*) AS n FROM shows');
    shows = Number(r1.getRowObjectsJson()[0].n);
    const r2 = await conn.runAndReadAll(
      'SELECT COUNT(*) AS n, COUNT(DISTINCT scrape_date) AS d, MIN(scrape_date) AS lo, MAX(scrape_date) AS hi FROM snapshots');
    const r = r2.getRowObjectsJson()[0];
    snapshots = Number(r.n);
    dates = Number(r.d);
    firstDate = r.lo;
    lastDate = r.hi;
  } finally {
    conn.closeSync();
    instance.closeSync();
  }

  const dbSize = (await stat(DB_PATH)).size;

  const meta = {
    built_at: new Date().toISOString(),
    csv_files: csvFiles,
    shows,
    snapshots,
    distinct_scrape_dates: dates,
    first_scrape_date: firstDate,
    last_scrape_date: lastDate,
    duckdb_bytes: dbSize,
  };
  await writeFile(resolve(DIST_DATA, 'build-meta.json'),
    JSON.stringify(meta, null, 2) + '\n', 'utf8');
  console.log('build-meta.json:', meta);
}

async function dirSize(dir) {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) total += await dirSize(p);
    else if (ent.isFile()) total += (await stat(p)).size;
  }
  return total;
}

async function sizeGuard() {
  const dbBytes = (await stat(DB_PATH)).size;
  const distBytes = await dirSize(DIST_DIR);
  const mib = (n) => (n / 1024 / 1024).toFixed(2) + ' MiB';
  console.log(`size: tvshows.duckdb = ${mib(dbBytes)}; dist/ total = ${mib(distBytes)}`);
  if (dbBytes > MAX_DB_BYTES) {
    throw new Error(`tvshows.duckdb (${mib(dbBytes)}) exceeds MAX_DB_BYTES (${mib(MAX_DB_BYTES)})`);
  }
  if (distBytes > MAX_DIST_BYTES) {
    throw new Error(`dist/ (${mib(distBytes)}) exceeds MAX_DIST_BYTES (${mib(MAX_DIST_BYTES)})`);
  }
}

async function smokeTest() {
  // Validate that the .duckdb file written by @duckdb/node-api can be opened
  // by @duckdb/duckdb-wasm at the version pinned in package.json. We load the
  // package's AsyncDuckDB *Node* bundle (same engine and async API as the
  // browser bundle), backed by a Node worker_threads.Worker that we wrap with
  // a tiny shim so it behaves like a browser Worker. The .wasm we point it at
  // is the *vendored* file the site actually serves — so any mismatch between
  // the storage format produced by node-api and the engine compiled into the
  // vendored .wasm fails the build before we deploy.
  console.log('\nSmoke test (wasm engine on built database)...');

  const wasmPkgRoot = resolve(repoRoot, 'node_modules', '@duckdb', 'duckdb-wasm');
  const requireFromHere = createRequire(import.meta.url);
  const duckdb = requireFromHere(resolve(wasmPkgRoot, 'dist', 'duckdb-node.cjs'));
  const arrow = requireFromHere(resolve(repoRoot, 'node_modules', 'apache-arrow'));

  const bundles = {
    mvp: {
      mainModule: resolve(repoRoot, 'vendor', 'duckdb-wasm', 'duckdb-mvp.wasm'),
      mainWorker: resolve(wasmPkgRoot, 'dist', 'duckdb-node-mvp.worker.cjs'),
    },
    eh: {
      mainModule: resolve(repoRoot, 'vendor', 'duckdb-wasm', 'duckdb-eh.wasm'),
      mainWorker: resolve(wasmPkgRoot, 'dist', 'duckdb-node-eh.worker.cjs'),
    },
  };
  const bundle = await duckdb.selectBundle(bundles);

  const worker = new BrowserLikeWorker(bundle.mainWorker);
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);

  const buf = await readFile(DB_PATH);
  await db.registerFileBuffer('tvshows.duckdb', new Uint8Array(buf));
  await db.open({
    path: 'tvshows.duckdb',
    accessMode: duckdb.DuckDBAccessMode.READ_ONLY,
  });
  const conn = await db.connect();

  const scalar = async (sql) => {
    const t = await conn.query(sql);
    const v = t.getChildAt(0)?.get(0);
    return typeof v === 'bigint' ? Number(v) : v;
  };

  const checks = [
    { sql: 'SELECT 1',                                                                  desc: 'basic SELECT' },
    { sql: 'SELECT COUNT(*) FROM shows',                                                desc: 'shows view' },
    { sql: 'SELECT COUNT(*) FROM snapshots',                                            desc: 'snapshots table' },
    { sql: "SELECT COUNT(*) FROM scrape_date_between('1900-01-01','2999-12-31')",       desc: 'macro scrape_date_between' },
    { sql: "SELECT COUNT(*) FROM hot_in('1900-01-01','2999-12-31')",                    desc: 'macro hot_in' },
    { sql: "SELECT COUNT(*) FROM rank_history((SELECT show_id FROM shows LIMIT 1))",    desc: 'macro rank_history' },
    { sql: "SELECT COUNT(*) FROM find_show('a')",                                       desc: 'macro find_show' },
  ];
  for (const c of checks) {
    const v = await scalar(c.sql);
    if (v == null || (typeof v === 'number' && Number.isNaN(v))) {
      throw new Error(`Smoke check failed: ${c.desc} returned ${v}`);
    }
    console.log(`  OK ${c.desc.padEnd(28)} -> ${v}`);
  }

  // arrow is loaded only to ensure the parser is wired up; queries above
  // already exercise it through duckdb-wasm's Connection.query().
  void arrow;

  await conn.close();
  await db.terminate();
}

// Bootstrap script (run inside the spawned worker_threads.Worker) that
// polyfills the browser Worker globals (postMessage / onmessage) on top of
// Node's parentPort, then loads the real duckdb-wasm worker bundle. The
// duckdb-wasm worker code calls globalThis.postMessage(...) and assigns
// globalThis.onmessage, both of which are missing in worker_threads by
// default — without this shim the worker silently exits and the host hangs
// forever on instantiate().
const WORKER_BOOTSTRAP = `
const { parentPort, workerData } = require('node:worker_threads');
globalThis.postMessage = (msg, transfer) => parentPort.postMessage(msg, transfer);
parentPort.on('message', (data) => {
  if (typeof globalThis.onmessage === 'function') {
    globalThis.onmessage({ data });
  }
});
require(workerData.workerPath);
`;

class BrowserLikeWorker {
  constructor(workerPath) {
    this._w = new Worker(WORKER_BOOTSTRAP, { eval: true, workerData: { workerPath } });
    this._listeners = new Map();
  }
  addEventListener(type, cb) {
    const wrap = type === 'message' ? (data) => cb({ data }) : (err) => cb(err);
    this._listeners.set(cb, wrap);
    this._w.on(type, wrap);
  }
  removeEventListener(type, cb) {
    const wrap = this._listeners.get(cb);
    if (!wrap) return;
    this._w.off(type, wrap);
    this._listeners.delete(cb);
  }
  postMessage(msg, transfer) { this._w.postMessage(msg, transfer); }
  terminate() { return this._w.terminate(); }
}

main().catch((err) => {
  console.error('\nBUILD FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
