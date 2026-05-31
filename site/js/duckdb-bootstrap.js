// DuckDB-WASM bootstrap. Loads the vendored MVP/EH bundles (no CDN, no coi/SAB).
// Lazy-initializes a single shared connection to the deployed tvshows.duckdb file.

import * as duckdb from '../vendor/duckdb-wasm/duckdb-browser.mjs';

const VENDOR = 'vendor/duckdb-wasm/';
const DB_FILE = 'data/tvshows.duckdb';

let _dbPromise = null;
let _connPromise = null;

function buildBundles() {
  // Build absolute URLs relative to the current page so this works under a
  // GitHub Pages project subpath (`/<repo>/`), local dev (`http://localhost`),
  // or any other base. Avoids relying on `import.meta.url`, which would point
  // inside `js/` and require one more `..` hop.
  const base = new URL('.', window.location.href);
  return {
    mvp: {
      mainModule: new URL(VENDOR + 'duckdb-mvp.wasm', base).toString(),
      mainWorker: new URL(VENDOR + 'duckdb-browser-mvp.worker.js', base).toString(),
    },
    eh: {
      mainModule: new URL(VENDOR + 'duckdb-eh.wasm', base).toString(),
      mainWorker: new URL(VENDOR + 'duckdb-browser-eh.worker.js', base).toString(),
    },
  };
}

async function instantiateDb() {
  const bundle = await duckdb.selectBundle(buildBundles());
  const worker = new Worker(bundle.mainWorker);
  const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
  const db = new duckdb.AsyncDuckDB(logger, worker);
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);

  // Fetch the prebuilt database file and register it as a virtual file inside
  // duckdb-wasm, then reopen the engine pointed at that file in read-only mode.
  const base = new URL('.', window.location.href);
  const dbUrl = new URL(DB_FILE, base).toString();
  const resp = await fetch(dbUrl, { cache: 'no-cache' });
  if (!resp.ok) {
    throw new Error(`Failed to fetch ${DB_FILE}: HTTP ${resp.status}`);
  }
  const buf = new Uint8Array(await resp.arrayBuffer());
  await db.registerFileBuffer('tvshows.duckdb', buf);
  await db.open({
    path: 'tvshows.duckdb',
    accessMode: duckdb.DuckDBAccessMode.READ_ONLY,
    query: { castBigIntToDouble: false, castTimestampToDate: false },
  });
  return db;
}

export function getDb() {
  if (!_dbPromise) _dbPromise = instantiateDb();
  return _dbPromise;
}

export async function getConnection() {
  if (!_connPromise) {
    _connPromise = getDb().then((db) => db.connect());
  }
  return _connPromise;
}

// Helper: run a SQL query and return { columns: string[], rows: any[][] }.
// Converts BigInt/Date/Arrow values to plain JS so renderers can use them
// directly. Throws Error with .message on SQL failure.
export async function runQuery(sql, params = null) {
  const conn = await getConnection();
  let table;
  if (params && params.length > 0) {
    const stmt = await conn.prepare(sql);
    try {
      table = await stmt.query(...params);
    } finally {
      await stmt.close();
    }
  } else {
    table = await conn.query(sql);
  }
  return arrowTableToRows(table);
}

function arrowTableToRows(table) {
  const columns = table.schema.fields.map((f) => f.name);
  const converters = table.schema.fields.map(buildColumnConverter);
  const rows = [];
  for (let i = 0; i < table.numRows; i++) {
    const row = new Array(columns.length);
    for (let j = 0; j < columns.length; j++) {
      const raw = table.getChildAt(j)?.get(i);
      row[j] = converters[j](raw);
    }
    rows.push(row);
  }
  return { columns, rows };
}

// Arrow type IDs (apache-arrow 17): 8=Date, 9=Time, 10=Timestamp.
// duckdb-wasm returns Date/Timestamp values as raw numbers (ms since epoch)
// rather than Date objects, so we coerce them here using the column schema.
function buildColumnConverter(field) {
  const typeId = field.type?.typeId;
  if (typeId === 8 || typeId === 10) {
    return (v) => {
      if (v == null) return null;
      const n = typeof v === 'bigint' ? Number(v) : v;
      if (typeof n !== 'number' || !Number.isFinite(n)) return jsValue(v);
      return new Date(n);
    };
  }
  return jsValue;
}

function jsValue(v) {
  if (v == null) return null;
  if (typeof v === 'bigint') {
    return v <= BigInt(Number.MAX_SAFE_INTEGER) && v >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(v)
      : v.toString();
  }
  if (v instanceof Date) return v;
  if (typeof v === 'object' && typeof v.toJSON === 'function' && !Array.isArray(v)) {
    return v.toJSON();
  }
  return v;
}
