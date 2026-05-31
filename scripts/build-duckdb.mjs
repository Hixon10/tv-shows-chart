#!/usr/bin/env node
// Builds a single tvshows.duckdb from all CSV files in data/.
//
// Pipeline:
//   1. Read all imdb-*.csv and kinopoisk-*.csv with filename capture.
//   2. Normalize into per-source tables. scrape_date comes from the FILENAME,
//      not scraped_at (whose timezone offset would shift the date under CI/UTC).
//   3. Extract stable source-entity IDs from URLs (tt\d+ for IMDb,
//      /series/<id>/ for Kinopoisk) and build source_shows (one row per show
//      per source, latest values).
//   4. Cross-source identity:
//        Stage 1: exact match on (title_normalized, release_year).
//        Stage 2: jaro_winkler_similarity >= 0.92 with |year diff| <= 1.
//      show_id = md5 hex of a deterministic key built from source IDs, so URLs
//      are stable across builds.
//   5. Build snapshots (one row per source/date/rank) and a `shows` view with
//      per-show aggregates.
//   6. Persist table macros (scrape_date_between, hot_in, rank_history,
//      find_show) into the .duckdb catalog so they're available in-browser.
//   7. CHECKPOINT and close.

import { DuckDBInstance } from '@duckdb/node-api';
import { existsSync, statSync } from 'node:fs';
import { mkdir, rm, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR
  ? resolve(process.env.DATA_DIR)
  : resolve(repoRoot, 'data');
const OUT_PATH = process.env.OUT_PATH
  ? resolve(process.env.OUT_PATH)
  : resolve(repoRoot, 'dist', 'data', 'tvshows.duckdb');

// DuckDB's read_csv glob wants forward slashes even on Windows.
const posix = (p) => p.replaceAll('\\', '/');
const IMDB_GLOB = posix(resolve(DATA_DIR, 'imdb-*.csv'));
const KP_GLOB = posix(resolve(DATA_DIR, 'kinopoisk-*.csv'));

async function main() {
  if (!existsSync(DATA_DIR)) {
    throw new Error(`Data directory not found: ${DATA_DIR}`);
  }
  const files = await readdir(DATA_DIR);
  const imdbCount = files.filter((f) => /^imdb-\d{4}-\d{2}-\d{2}\.csv$/.test(f)).length;
  const kpCount = files.filter((f) => /^kinopoisk-\d{4}-\d{2}-\d{2}\.csv$/.test(f)).length;
  console.log(`Found ${imdbCount} imdb CSV(s) and ${kpCount} kinopoisk CSV(s) in ${DATA_DIR}`);
  if (imdbCount === 0 && kpCount === 0) {
    throw new Error('No input CSV files. Aborting.');
  }

  // Ensure parent dir exists and remove any stale db at the target path.
  await mkdir(dirname(OUT_PATH), { recursive: true });
  if (existsSync(OUT_PATH)) await rm(OUT_PATH, { force: true });
  const walPath = OUT_PATH + '.wal';
  if (existsSync(walPath)) await rm(walPath, { force: true });

  const instance = await DuckDBInstance.create(OUT_PATH);
  const conn = await instance.connect();

  try {
    await buildSchema(conn, { imdbCount, kpCount });
    console.log('CHECKPOINT...');
    await conn.run('CHECKPOINT');
  } finally {
    conn.closeSync();
    instance.closeSync();
  }

  const size = statSync(OUT_PATH).size;
  console.log(`Wrote ${OUT_PATH} (${(size / 1024 / 1024).toFixed(2)} MiB)`);
}

async function buildSchema(conn, { imdbCount, kpCount }) {
  // ---------- 1. raw CSV ingestion ----------
  if (imdbCount > 0) {
    await conn.run(`
      CREATE TABLE imdb_raw AS
      SELECT *
      FROM read_csv_auto(
        '${IMDB_GLOB}',
        filename = true,
        union_by_name = true,
        header = true
      )
    `);
  } else {
    await conn.run(`
      CREATE TABLE imdb_raw (
        rank INTEGER, title VARCHAR, url VARCHAR, score DOUBLE, votes BIGINT,
        release_year INTEGER, scraped_at TIMESTAMPTZ, filename VARCHAR
      )
    `);
  }

  if (kpCount > 0) {
    await conn.run(`
      CREATE TABLE kp_raw AS
      SELECT *
      FROM read_csv_auto(
        '${KP_GLOB}',
        filename = true,
        union_by_name = true,
        header = true
      )
    `);
  } else {
    await conn.run(`
      CREATE TABLE kp_raw (
        rank INTEGER, title_ru VARCHAR, title VARCHAR, url VARCHAR, score DOUBLE,
        votes BIGINT, release_year INTEGER, scraped_at TIMESTAMPTZ, filename VARCHAR
      )
    `);
  }

  // ---------- 2. per-source normalized snapshot rows ----------
  // Note: scrape_date comes from filename. The scraped_at timestamp is timezone-
  // aware and CI runs in UTC, which would otherwise shift the day boundary.
  await conn.run(`
    CREATE OR REPLACE TABLE imdb_norm AS
    SELECT
      'imdb'::VARCHAR                                            AS source,
      TRUE                                                       AS is_imdb,
      FALSE                                                      AS is_kinopoisk,
      regexp_extract(filename, '(\\d{4}-\\d{2}-\\d{2})', 1)::DATE AS scrape_date,
      CAST(rank AS INTEGER)                                      AS rank,
      title,
      NULL::VARCHAR                                              AS title_ru,
      url,
      regexp_extract(url, '(tt\\d+)', 1)                          AS source_id,
      TRY_CAST(score AS DOUBLE)                                  AS score,
      TRY_CAST(votes AS BIGINT)                                  AS votes,
      TRY_CAST(release_year AS INTEGER)                          AS release_year,
      CAST(scraped_at AS TIMESTAMPTZ)                            AS scraped_at,
      lower(regexp_replace(strip_accents(COALESCE(title, '')), '[^a-zA-Z0-9]', '', 'g'))
                                                                 AS title_normalized
    FROM imdb_raw
    WHERE url IS NOT NULL AND regexp_extract(url, '(tt\\d+)', 1) <> ''
  `);

  await conn.run(`
    CREATE OR REPLACE TABLE kp_norm AS
    SELECT
      'kinopoisk'::VARCHAR                                       AS source,
      FALSE                                                      AS is_imdb,
      TRUE                                                       AS is_kinopoisk,
      regexp_extract(filename, '(\\d{4}-\\d{2}-\\d{2})', 1)::DATE AS scrape_date,
      CAST(rank AS INTEGER)                                      AS rank,
      title,
      title_ru,
      url,
      regexp_extract(url, 'series/(\\d+)', 1)                     AS source_id,
      TRY_CAST(score AS DOUBLE)                                  AS score,
      TRY_CAST(votes AS BIGINT)                                  AS votes,
      TRY_CAST(release_year AS INTEGER)                          AS release_year,
      CAST(scraped_at AS TIMESTAMPTZ)                            AS scraped_at,
      lower(regexp_replace(strip_accents(COALESCE(title, '')), '[^a-zA-Z0-9]', '', 'g'))
                                                                 AS title_normalized
    FROM kp_raw
    WHERE url IS NOT NULL AND regexp_extract(url, 'series/(\\d+)', 1) <> ''
  `);

  // ---------- 3. source_shows (one row per source entity) ----------
  await conn.run(`
    CREATE OR REPLACE TABLE source_shows AS
    SELECT
      source,
      source_id,
      arg_max(title,            scraped_at) AS title,
      arg_max(title_ru,         scraped_at) AS title_ru,
      arg_max(release_year,     scraped_at) AS release_year,
      arg_max(url,              scraped_at) AS url,
      arg_max(title_normalized, scraped_at) AS title_normalized
    FROM (
      SELECT source, source_id, title, title_ru, release_year, url, title_normalized, scraped_at
      FROM imdb_norm
      UNION ALL
      SELECT source, source_id, title, title_ru, release_year, url, title_normalized, scraped_at
      FROM kp_norm
    )
    GROUP BY source, source_id
  `);

  const sourceCount = (await conn.runAndReadAll('SELECT COUNT(*) AS n FROM source_shows'))
    .getRowObjectsJson()[0].n;
  console.log(`source_shows: ${sourceCount} entities`);

  // ---------- 4a. Stage 1: exact normalized match ----------
  await conn.run(`
    CREATE OR REPLACE TABLE identity_exact AS
    WITH candidates AS (
      SELECT i.source_id AS imdb_id, k.source_id AS kp_id
      FROM source_shows i
      JOIN source_shows k
        ON i.title_normalized = k.title_normalized
       AND i.release_year IS NOT DISTINCT FROM k.release_year
      WHERE i.source = 'imdb'
        AND k.source = 'kinopoisk'
        AND length(i.title_normalized) >= 2
    ),
    pick_kp_per_imdb AS (
      SELECT imdb_id, kp_id,
             ROW_NUMBER() OVER (PARTITION BY imdb_id ORDER BY kp_id) AS rn
      FROM candidates
    ),
    pick_imdb_per_kp AS (
      SELECT imdb_id, kp_id,
             ROW_NUMBER() OVER (PARTITION BY kp_id ORDER BY imdb_id) AS rn
      FROM pick_kp_per_imdb
      WHERE rn = 1
    )
    SELECT imdb_id, kp_id FROM pick_imdb_per_kp WHERE rn = 1
  `);

  // ---------- 4b. Stage 2: fuzzy match for remaining unmatched ----------
  await conn.run(`
    CREATE OR REPLACE TABLE identity_fuzzy AS
    WITH unmatched_i AS (
      SELECT * FROM source_shows
      WHERE source = 'imdb'
        AND length(title_normalized) >= 2
        AND source_id NOT IN (SELECT imdb_id FROM identity_exact)
    ),
    unmatched_k AS (
      SELECT * FROM source_shows
      WHERE source = 'kinopoisk'
        AND length(title_normalized) >= 2
        AND source_id NOT IN (SELECT kp_id FROM identity_exact)
    ),
    scored AS (
      SELECT i.source_id AS imdb_id,
             k.source_id AS kp_id,
             jaro_winkler_similarity(i.title_normalized, k.title_normalized) AS sim
      FROM unmatched_i i
      CROSS JOIN unmatched_k k
      WHERE ABS(COALESCE(i.release_year, 0) - COALESCE(k.release_year, 0)) <= 1
    ),
    filtered AS (
      SELECT * FROM scored WHERE sim >= 0.92
    ),
    pick_kp_per_imdb AS (
      SELECT imdb_id, kp_id, sim,
             ROW_NUMBER() OVER (PARTITION BY imdb_id ORDER BY sim DESC, kp_id) AS rn
      FROM filtered
    ),
    pick_imdb_per_kp AS (
      SELECT imdb_id, kp_id, sim,
             ROW_NUMBER() OVER (PARTITION BY kp_id ORDER BY sim DESC, imdb_id) AS rn
      FROM pick_kp_per_imdb
      WHERE rn = 1
    )
    SELECT imdb_id, kp_id FROM pick_imdb_per_kp WHERE rn = 1
  `);

  // ---------- 4c. show_identity: pairs + singletons, deterministic show_id ----------
  await conn.run(`
    CREATE OR REPLACE TABLE show_identity AS
    WITH matches AS (
      SELECT imdb_id, kp_id FROM identity_exact
      UNION ALL
      SELECT imdb_id, kp_id FROM identity_fuzzy
    ),
    matched_imdb AS (SELECT DISTINCT imdb_id FROM matches),
    matched_kp   AS (SELECT DISTINCT kp_id   FROM matches),
    all_entities AS (
      SELECT imdb_id, kp_id FROM matches
      UNION ALL
      SELECT source_id AS imdb_id, NULL::VARCHAR AS kp_id
      FROM source_shows
      WHERE source = 'imdb'
        AND source_id NOT IN (SELECT imdb_id FROM matched_imdb)
      UNION ALL
      SELECT NULL::VARCHAR AS imdb_id, source_id AS kp_id
      FROM source_shows
      WHERE source = 'kinopoisk'
        AND source_id NOT IN (SELECT kp_id FROM matched_kp)
    )
    SELECT
      md5(
        CASE
          WHEN imdb_id IS NOT NULL AND kp_id IS NOT NULL
            THEN 'imdb:' || imdb_id || '|kp:' || kp_id
          WHEN imdb_id IS NOT NULL
            THEN 'imdb:' || imdb_id
          ELSE 'kp:' || kp_id
        END
      ) AS show_id,
      imdb_id,
      kp_id
    FROM all_entities
  `);

  const idStats = (await conn.runAndReadAll(`
    SELECT
      (SELECT COUNT(*) FROM identity_exact)                                     AS exact_matches,
      (SELECT COUNT(*) FROM identity_fuzzy)                                     AS fuzzy_matches,
      (SELECT COUNT(*) FROM show_identity WHERE imdb_id IS NULL)                AS kp_only,
      (SELECT COUNT(*) FROM show_identity WHERE kp_id   IS NULL)                AS imdb_only,
      (SELECT COUNT(*) FROM show_identity WHERE imdb_id IS NOT NULL
                                             AND kp_id   IS NOT NULL)            AS paired,
      (SELECT COUNT(*) FROM show_identity)                                       AS total_shows
  `)).getRowObjectsJson()[0];
  console.log(
    `identity: ${idStats.exact_matches} exact + ${idStats.fuzzy_matches} fuzzy = ` +
      `${idStats.paired} paired; ${idStats.imdb_only} imdb-only; ${idStats.kp_only} kp-only; ` +
      `${idStats.total_shows} total shows`,
  );

  // ---------- 5. snapshots (one row per source/date/rank) ----------
  await conn.run(`
    CREATE OR REPLACE TABLE snapshots AS
    WITH all_norm AS (
      SELECT * FROM imdb_norm
      UNION ALL BY NAME
      SELECT * FROM kp_norm
    )
    SELECT
      si.show_id,
      n.source,
      n.is_imdb,
      n.is_kinopoisk,
      n.scrape_date,
      n.rank,
      n.title,
      n.title_ru,
      n.url,
      n.source_id,
      n.score,
      n.votes,
      n.release_year,
      n.scraped_at
    FROM all_norm n
    JOIN show_identity si
      ON (n.source = 'imdb'      AND si.imdb_id = n.source_id)
      OR (n.source = 'kinopoisk' AND si.kp_id   = n.source_id)
  `);

  const snapStats = (await conn.runAndReadAll(`
    SELECT COUNT(*) AS rows, COUNT(DISTINCT scrape_date) AS dates,
           MIN(scrape_date) AS first_date, MAX(scrape_date) AS last_date
    FROM snapshots
  `)).getRowObjectsJson()[0];
  console.log(
    `snapshots: ${snapStats.rows} rows across ${snapStats.dates} day(s) ` +
      `(${snapStats.first_date} → ${snapStats.last_date})`,
  );

  // ---------- 6. analytics view ----------
  await conn.run(`
    CREATE OR REPLACE VIEW shows AS
    WITH stats AS (
      SELECT
        show_id,
        COUNT(DISTINCT scrape_date)                          AS days_in_rating,
        MIN(scrape_date)                                     AS first_seen,
        MAX(scrape_date)                                     AS last_seen,
        AVG(rank)                                            AS avg_rank,
        MIN(rank)                                            AS best_rank,
        MAX(rank)                                            AS worst_rank,
        AVG(score)                                           AS avg_score,
        COUNT(*) FILTER (WHERE source = 'imdb')      > 0     AS present_on_imdb,
        COUNT(*) FILTER (WHERE source = 'kinopoisk') > 0     AS present_on_kinopoisk
      FROM snapshots
      GROUP BY show_id
    ),
    latest_imdb AS (
      SELECT show_id, title AS imdb_title, url AS imdb_url, release_year AS imdb_year,
             score AS latest_score, votes AS latest_votes
      FROM (
        SELECT *,
               ROW_NUMBER() OVER (PARTITION BY show_id ORDER BY scraped_at DESC, rank) AS rn
        FROM snapshots WHERE source = 'imdb'
      )
      WHERE rn = 1
    ),
    latest_kp AS (
      SELECT show_id, title AS kp_title, title_ru AS kp_title_ru,
             url AS kinopoisk_url, release_year AS kp_year
      FROM (
        SELECT *,
               ROW_NUMBER() OVER (PARTITION BY show_id ORDER BY scraped_at DESC, rank) AS rn
        FROM snapshots WHERE source = 'kinopoisk'
      )
      WHERE rn = 1
    )
    SELECT
      s.show_id,
      COALESCE(li.imdb_title, NULLIF(lk.kp_title, ''), lk.kp_title_ru) AS assumed_title,
      lk.kp_title_ru                                                   AS title_ru,
      COALESCE(li.imdb_year, lk.kp_year)                               AS release_year,
      li.imdb_url,
      lk.kinopoisk_url,
      s.days_in_rating,
      s.first_seen,
      s.last_seen,
      s.avg_rank,
      s.best_rank,
      s.worst_rank,
      s.avg_score,
      li.latest_score,
      li.latest_votes,
      s.present_on_imdb,
      s.present_on_kinopoisk
    FROM stats s
    LEFT JOIN latest_imdb li USING (show_id)
    LEFT JOIN latest_kp   lk USING (show_id)
  `);

  // ---------- 7. persistent table macros ----------
  await conn.run(`
    CREATE OR REPLACE MACRO scrape_date_between(d1, d2) AS TABLE
      SELECT DISTINCT show_id
      FROM snapshots
      WHERE scrape_date BETWEEN CAST(d1 AS DATE) AND CAST(d2 AS DATE)
  `);

  await conn.run(`
    CREATE OR REPLACE MACRO hot_in(d1, d2) AS TABLE
      SELECT
        sh.show_id,
        sh.assumed_title,
        sh.title_ru,
        sh.release_year,
        COUNT(DISTINCT n.scrape_date)            AS days_in_window,
        AVG(n.rank)                              AS avg_rank_in_window,
        MIN(n.rank)                              AS best_rank_in_window,
        AVG(n.score)                             AS avg_score_in_window,
        sh.imdb_url,
        sh.kinopoisk_url
      FROM snapshots n
      JOIN shows sh USING (show_id)
      WHERE n.scrape_date BETWEEN CAST(d1 AS DATE) AND CAST(d2 AS DATE)
      GROUP BY sh.show_id, sh.assumed_title, sh.title_ru, sh.release_year,
               sh.imdb_url, sh.kinopoisk_url
      ORDER BY avg_rank_in_window
  `);

  await conn.run(`
    CREATE OR REPLACE MACRO rank_history(sid) AS TABLE
      SELECT scrape_date, source, rank, score, votes
      FROM snapshots
      WHERE show_id = CAST(sid AS VARCHAR)
      ORDER BY scrape_date, source
  `);

  await conn.run(`
    CREATE OR REPLACE MACRO find_show(q) AS TABLE
      SELECT show_id, assumed_title, title_ru, release_year,
             imdb_url, kinopoisk_url, days_in_rating
      FROM shows
      WHERE assumed_title ILIKE '%' || CAST(q AS VARCHAR) || '%'
         OR COALESCE(title_ru, '') ILIKE '%' || CAST(q AS VARCHAR) || '%'
      ORDER BY days_in_rating DESC
  `);

  // ---------- 8. drop intermediate tables to keep the deployed db lean ----------
  for (const t of ['imdb_raw', 'kp_raw', 'imdb_norm', 'kp_norm',
                   'identity_exact', 'identity_fuzzy']) {
    await conn.run(`DROP TABLE IF EXISTS ${t}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
