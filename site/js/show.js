// Show details page. Reads ?id=<show_id> from the URL, validates it strictly
// against the md5-hex format, and runs prepared queries bound by parameter to
// avoid SQL injection from URL contents.

import { runQuery } from './duckdb-bootstrap.js';
import {
  el, clear, urlHostLabel, formatCell, setStatus,
  fetchBuildMeta, getQueryParam, isShowId,
  nextSortDirection, sortRows, sortableHeaderCell,
} from './helpers.js';

const statusBox = document.getElementById('status');
const titleH1   = document.getElementById('title-h1');
const subtitle  = document.getElementById('subtitle');
const linksBox  = document.getElementById('links');
const statGrid  = document.getElementById('stat-grid');
const histTable = document.getElementById('history');
let historyColumns = [];
let historyRows = [];
let historySort = null;

fetchBuildMeta().then((m) => {
  const headerMeta = document.getElementById('build-meta');
  if (!headerMeta || !m?.built_at) return;
  headerMeta.textContent =
    'built ' + new Date(m.built_at).toISOString().slice(0, 19).replace('T', ' ') + ' UTC';
});

main().catch((err) => {
  console.error(err);
  setStatus(statusBox, 'error', String(err && err.message ? err.message : err));
});

async function main() {
  const id = getQueryParam('id');
  if (!isShowId(id)) {
    titleH1.textContent = 'Invalid show id';
    setStatus(statusBox, 'error',
      'The id parameter must be a 32-character hex string. Go back to the main page and pick a show.');
    return;
  }

  setStatus(statusBox, 'info', 'Loading…');

  // Per-show metadata. Parameter binding ($1) keeps the (already-validated)
  // id out of the SQL text.
  const showQ = await runQuery(
    `SELECT show_id, assumed_title, title_ru, release_year,
            imdb_url, kinopoisk_url,
            days_in_rating, first_seen, last_seen,
            best_rank, worst_rank, avg_rank, avg_score,
            latest_score, latest_votes,
            present_on_imdb, present_on_kinopoisk
     FROM shows WHERE show_id = $1`,
    [id],
  );
  if (showQ.rows.length === 0) {
    titleH1.textContent = 'Show not found';
    setStatus(statusBox, 'error', `No show with id ${id}.`);
    return;
  }
  const row = Object.fromEntries(showQ.columns.map((c, i) => [c, showQ.rows[0][i]]));
  renderHeader(row);
  renderStats(row);

  // Rank history via the persistent table macro. Parameter is bound to a
  // VARCHAR placeholder so URL contents never end up in the SQL text.
  const histQ = await runQuery(
    `SELECT scrape_date, source, rank, score, votes
     FROM rank_history(CAST($1 AS VARCHAR))
     ORDER BY scrape_date DESC, source`,
    [id],
  );
  historyColumns = histQ.columns;
  historyRows = histQ.rows;
  historySort = null;
  renderHistory();

  setStatus(statusBox, 'info',
    `${histQ.rows.length} daily rank record${histQ.rows.length === 1 ? '' : 's'}`);
}

function renderHeader(r) {
  const title = r.assumed_title ?? '(no title)';
  document.title = `${title} — TV Shows Chart`;
  titleH1.textContent = title;

  const subParts = [];
  if (r.title_ru && r.title_ru !== r.assumed_title) subParts.push(r.title_ru);
  if (r.release_year != null) subParts.push(`(${r.release_year})`);
  subtitle.textContent = subParts.join(' ');

  clear(linksBox);
  if (r.imdb_url) {
    linksBox.appendChild(el('a',
      { href: r.imdb_url, target: '_blank', rel: 'noopener noreferrer' },
      urlHostLabel(r.imdb_url) + ' →'));
    linksBox.appendChild(document.createTextNode('  '));
  }
  if (r.kinopoisk_url) {
    linksBox.appendChild(el('a',
      { href: r.kinopoisk_url, target: '_blank', rel: 'noopener noreferrer' },
      urlHostLabel(r.kinopoisk_url) + ' →'));
  }
  if (!r.imdb_url && !r.kinopoisk_url) {
    linksBox.textContent = '(no source links)';
  }
}

function renderStats(r) {
  clear(statGrid);
  const stats = [
    ['Days in rating', r.days_in_rating],
    ['First seen',     r.first_seen],
    ['Last seen',      r.last_seen],
    ['Best rank',      r.best_rank],
    ['Worst rank',     r.worst_rank],
    ['Avg rank',       r.avg_rank != null ? Number(r.avg_rank).toFixed(2) : null],
    ['Avg score',      r.avg_score != null ? Number(r.avg_score).toFixed(2) : null],
    ['Latest score',   r.latest_score],
    ['Latest votes',   r.latest_votes],
    ['On IMDb',        r.present_on_imdb],
    ['On Kinopoisk',   r.present_on_kinopoisk],
  ];
  for (const [label, value] of stats) {
    const text = value == null ? '—' : formatCell(value);
    statGrid.appendChild(
      el('div', { class: 'stat-card' },
        el('div', { class: 'label' }, label),
        el('div', { class: 'value' }, text),
      ),
    );
  }
}

function sortHistoryByColumn(columnIndex) {
  historySort = {
    columnIndex,
    direction: nextSortDirection(historySort, columnIndex),
  };
  renderHistory();
}

function renderHistory() {
  clear(histTable);
  const columns = historyColumns;
  const rows = historySort
    ? sortRows(historyRows, historySort.columnIndex, historySort.direction)
    : historyRows;
  histTable.appendChild(
    el('thead', {}, el('tr', {}, ...columns.map((c, i) =>
      sortableHeaderCell(c, historySort, i, () => sortHistoryByColumn(i))))),
  );
  const tbody = el('tbody');
  if (rows.length === 0) {
    tbody.appendChild(
      el('tr', {}, el('td', { class: 'empty', colspan: String(columns.length || 1) }, '(no rows)')),
    );
  }
  for (const row of rows) {
    const tr = el('tr');
    for (let i = 0; i < columns.length; i++) {
      const v = row[i];
      const isNumeric = typeof v === 'number' || typeof v === 'bigint';
      tr.appendChild(el('td', { class: isNumeric ? 'num' : null }, formatCell(v, { columnName: columns[i] })));
    }
    tbody.appendChild(tr);
  }
  histTable.appendChild(tbody);
}
