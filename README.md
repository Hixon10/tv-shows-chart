# tv-shows-chart

Static GitHub Pages site for browsing IMDb / Kinopoisk TV-show rank snapshots, powered by
[DuckDB-WASM](https://duckdb.org/docs/api/wasm/overview.html) running entirely in the browser.

- Daily CSV snapshots live in `data/` (committed by an external process).
- A CI build merges all CSVs into a single `tvshows.duckdb` and ships it alongside the static
  site to GitHub Pages.
- Pages query the database in-browser; no server, no third-party CDN at runtime.

## Repo layout

```
data/                       # raw CSVs (one per source per day)
site/                       # handwritten HTML/CSS/JS
vendor/duckdb-wasm/         # committed DuckDB-WASM assets (no CDN at runtime)
scripts/                    # Node build & vendor-refresh scripts
.github/workflows/          # GitHub Actions
```

## Local development

```bash
npm ci
npm run build       # produces ./dist/
npm run serve       # static-serves ./dist on http://localhost:8080
npm run e2e         # headless Chrome/Edge smoke test against a running ./dist
```

Open <http://localhost:8080/> for the main page.

`npm run e2e` requires a running `npm run serve` (defaults to port 8080) and
finds Chrome/Edge in their default Windows install paths. It is dev-tooling
only; it is not part of the CI deploy pipeline.

## Refreshing vendored dependencies

`vendor/` contains the DuckDB-WASM bundles committed to git so the site has no CDN
dependencies at runtime. The browser ESM entrypoint is rebuilt with `esbuild` so that
[`apache-arrow`](https://www.npmjs.com/package/apache-arrow) — a hard dependency of
duckdb-wasm — is inlined into the same file; the runtime ends up loading exactly
one ESM file, two `.worker.js` files, and two `.wasm` files from `/vendor/duckdb-wasm/`.

To refresh after bumping `@duckdb/duckdb-wasm` (or `apache-arrow`) in `package.json`:

```bash
npm install
npm run update:vendor
git add vendor/
git commit -m "vendor: refresh duckdb-wasm"
```

## Pinned versions

`@duckdb/duckdb-wasm` and `@duckdb/node-api` are pinned to engines that share a
compatible on-disk format. As of 2026-05-30: `duckdb-wasm@1.32.0` (engine v1.4.3)
can read databases produced by `node-api@1.5.3-r.2` (engine v1.5.x); the build's
smoke test verifies this on every CI run, so bumps that break compatibility fail
immediately. Bump them together when newer releases come out.

The build, vendor, and CI scripts target the **Node.js 24 LTS** runtime
(`actions/setup-node@v4` on CI; `package.json` engines `>=24`).

## CI / deployment

Push to `main` triggers `.github/workflows/deploy.yml`:

1. `npm ci`
2. `npm run build`
3. Uploads `dist/` as a GitHub Pages artifact and deploys.

The DuckDB database is **not** committed; it's rebuilt from `data/` on every push.
