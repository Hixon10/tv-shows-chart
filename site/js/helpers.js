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
