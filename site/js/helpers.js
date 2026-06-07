// Small shared helpers used by both pages.

export const SHOW_ID_RE = /^[0-9a-f]{32}$/;

export function isShowId(s) {
  return typeof s === 'string' && SHOW_ID_RE.test(s);
}

// URL-column rendering: turn a full URL into a compact, recognizable link label.
export function urlHostLabel(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    return host;
  } catch {
    return url;
  }
}

export function formatNumber(v, opts = {}) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v !== 'number' || !Number.isFinite(v)) return String(v ?? '');
  if (Number.isInteger(v)) return v.toLocaleString();
  const digits = opts.digits ?? 2;
  return v.toFixed(digits);
}

// Column-name regex used by formatCell to skip thousand-separators on
// year-like integer columns (so 2020 renders as "2020", not "2,020").
const PLAIN_INTEGER_COLUMN_RE = /(^|_)year(s)?$/i;

export function formatCell(value, opts = {}) {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (Number.isInteger(value)) {
      if (opts.columnName && PLAIN_INTEGER_COLUMN_RE.test(opts.columnName)) {
        return String(value);
      }
      return value.toLocaleString();
    }
    return value.toFixed(3).replace(/\.?0+$/, '');
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

const SORT_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function nextSortDirection(sortState, columnIndex) {
  return sortState?.columnIndex === columnIndex && sortState.direction === 'asc' ? 'desc' : 'asc';
}

export function sortRows(rows, columnIndex, direction = 'asc') {
  const sign = direction === 'desc' ? -1 : 1;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const av = a.row[columnIndex];
      const bv = b.row[columnIndex];
      const aEmpty = isEmptySortValue(av);
      const bEmpty = isEmptySortValue(bv);
      if (aEmpty || bEmpty) {
        if (aEmpty && bEmpty) return a.index - b.index;
        return aEmpty ? 1 : -1;
      }
      const cmp = compareSortValues(av, bv);
      return cmp === 0 ? a.index - b.index : cmp * sign;
    })
    .map(({ row }) => row);
}

function isEmptySortValue(v) {
  return v == null || v === '';
}

function compareSortValues(a, b) {
  const av = sortableValue(a);
  const bv = sortableValue(b);
  if (av.kind === 'number' && bv.kind === 'number') {
    return compareNumbers(av.value, bv.value);
  }
  return SORT_COLLATOR.compare(av.value, bv.value);
}

function sortableValue(v) {
  if (v instanceof Date) return { kind: 'number', value: v.getTime() };
  if (typeof v === 'number' && Number.isFinite(v)) return { kind: 'number', value: v };
  if (typeof v === 'bigint') return { kind: 'number', value: Number(v) };
  if (typeof v === 'boolean') return { kind: 'number', value: v ? 1 : 0 };
  return { kind: 'string', value: String(v) };
}

function compareNumbers(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function sortableHeaderCell(label, sortState, columnIndex, onSort) {
  const active = sortState?.columnIndex === columnIndex;
  const direction = active ? sortState.direction : null;
  return el('th', {
    class: 'sortable',
    'aria-sort': active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none',
  },
    el('button', {
      type: 'button',
      class: 'sort-header',
      title: `Sort by ${label}`,
      onclick: onSort,
    },
      el('span', { class: 'sort-label' }, label),
      el('span', { class: 'sort-indicator', 'aria-hidden': 'true' },
        active ? (direction === 'asc' ? '▲' : '▼') : '↕'),
    ),
  );
}

export function setStatus(node, kind, message) {
  if (!node) return;
  node.className = 'status status-' + kind;
  node.textContent = message;
}

export function getQueryParam(name) {
  const params = new URLSearchParams(window.location.search);
  return params.get(name);
}

export async function fetchBuildMeta() {
  try {
    const r = await fetch('data/build-meta.json', { cache: 'no-cache' });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}
