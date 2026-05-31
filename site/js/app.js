// Main page: SQL editor + auto-run default query + results table with
// link-aware rendering. `show_id` is hidden when present and used to build
// per-show drill-down links on title columns. URL columns are turned into
// host-labeled links.

import { runQuery } from './duckdb-bootstrap.js';
import {
  el, clear, urlHostLabel, formatCell, setStatus, fetchBuildMeta, isShowId,
} from './helpers.js';

const DEFAULT_QUERY = `-- Top 50 shows by days in rating. Run any DuckDB SQL here.
-- Include show_id in your SELECT to enable per-show drill-down links.
SELECT show_id, assumed_title, title_ru, release_year,
       days_in_rating, best_rank, avg_rank, avg_score,
       imdb_url, kinopoisk_url
FROM shows
ORDER BY days_in_rating DESC, avg_rank ASC
LIMIT 50;`;

const sqlBox    = document.getElementById('sql');
const runBtn    = document.getElementById('run');
const statusBox = document.getElementById('status');
const table     = document.getElementById('results');
const hint      = document.getElementById('results-hint');

sqlBox.value = DEFAULT_QUERY;

runBtn.addEventListener('click', () => runCurrent());
sqlBox.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    runCurrent();
  }
});

// Header build-meta.
fetchBuildMeta().then((m) => {
  const headerMeta = document.getElementById('build-meta');
  if (!headerMeta) return;
  if (!m) { headerMeta.textContent = ''; return; }
  const dt = m.built_at ? new Date(m.built_at).toISOString().slice(0, 19).replace('T', ' ') + ' UTC' : '';
  const parts = [
    dt && `built ${dt}`,
    typeof m.shows === 'number' && `${m.shows.toLocaleString()} shows`,
    typeof m.snapshots === 'number' && `${m.snapshots.toLocaleString()} snapshots`,
    typeof m.csv_files === 'number' && `${m.csv_files} CSV files`,
  ].filter(Boolean);
  headerMeta.textContent = parts.join(' · ');
});

// Auto-run on load.
runCurrent();

async function runCurrent() {
  const sql = sqlBox.value.trim();
  if (!sql) return;
  setStatus(statusBox, 'info', 'Running query…');
  runBtn.disabled = true;
  const t0 = performance.now();
  try {
    const { columns, rows } = await runQuery(sql);
    const ms = Math.round(performance.now() - t0);
    renderTable(columns, rows);
    setStatus(statusBox, 'info', `${rows.length} row${rows.length === 1 ? '' : 's'} in ${ms} ms`);
  } catch (err) {
    console.error(err);
    setStatus(statusBox, 'error', String(err && err.message ? err.message : err));
    clear(table);
  } finally {
    runBtn.disabled = false;
  }
}

function renderTable(columns, rows) {
  clear(table);
  const showIdIdx = columns.indexOf('show_id');
  const visibleColumns = columns
    .map((name, i) => ({ name, i }))
    .filter((c) => c.name !== 'show_id');

  // header
  const thead = el('thead', {},
    el('tr', {}, ...visibleColumns.map((c) => el('th', {}, c.name)))
  );
  table.appendChild(thead);

  // body
  const tbody = el('tbody');
  if (rows.length === 0) {
    tbody.appendChild(el('tr', {},
      el('td', { class: 'empty', colspan: String(visibleColumns.length || 1) }, '(no rows)')
    ));
  }
  for (const row of rows) {
    const showId = showIdIdx >= 0 ? row[showIdIdx] : null;
    const tr = el('tr');
    for (const c of visibleColumns) {
      tr.appendChild(renderCell(c.name, row[c.i], showId));
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  // hint about show links
  if (showIdIdx === -1) {
    hint.textContent = 'Hint: include `show_id` in your SELECT to enable per-show drill-down links on title columns.';
  } else {
    hint.textContent = '';
  }
}

const TITLE_COLUMNS = new Set(['assumed_title', 'title', 'title_ru', 'kp_title']);

function renderCell(colName, value, showId) {
  if (value == null || value === '') {
    return el('td', { class: 'empty' }, '');
  }

  const isUrl = colName.endsWith('_url') && typeof value === 'string';
  if (isUrl) {
    return el('td', {},
      el('a', { href: value, target: '_blank', rel: 'noopener noreferrer' },
        urlHostLabel(value))
    );
  }

  const isTitle = TITLE_COLUMNS.has(colName) && typeof value === 'string';
  if (isTitle && isShowId(showId)) {
    return el('td', {},
      el('a', { href: `show.html?id=${encodeURIComponent(showId)}` }, value)
    );
  }

  const isNumeric = typeof value === 'number' || typeof value === 'bigint';
  return el('td', { class: isNumeric ? 'num' : null }, formatCell(value));
}
