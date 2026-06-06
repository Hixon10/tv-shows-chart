// One-off end-to-end check: drive system Chrome via puppeteer-core against
// the dist/ site that scripts/serve.mjs is hosting. NOT shipped — devtool
// only, invoked from the local-verify task.
import puppeteer from 'puppeteer-core';

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];
const { existsSync } = await import('node:fs');
const execPath = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!execPath) throw new Error('No system Chrome/Edge found');

const BASE = process.argv[2] || 'http://localhost:8123';

async function assertSortableNumericColumn(page, tableSelector, columnName) {
  const columnIndex = await page.evaluate(({ tableSelector, columnName }) => {
    const headers = [...document.querySelectorAll(`${tableSelector} thead th`)];
    return headers.findIndex((h) =>
      (h.querySelector('.sort-label')?.textContent ?? h.textContent).trim() === columnName);
  }, { tableSelector, columnName });
  if (columnIndex < 0) throw new Error(`${tableSelector} missing sortable column ${columnName}`);
  const buttonSelector = `${tableSelector} thead th:nth-child(${columnIndex + 1}) button.sort-header`;

  await page.click(buttonSelector);
  let summary = await sortableSummary(page, tableSelector, columnIndex);
  if (summary.ariaSort !== 'ascending') {
    throw new Error(`${tableSelector} ${columnName} did not switch to ascending sort`);
  }
  if (!summary.sortedAscending) {
    throw new Error(`${tableSelector} ${columnName} values are not ascending after sort`);
  }

  await page.click(buttonSelector);
  summary = await sortableSummary(page, tableSelector, columnIndex);
  if (summary.ariaSort !== 'descending') {
    throw new Error(`${tableSelector} ${columnName} did not switch to descending sort`);
  }
  if (!summary.sortedDescending) {
    throw new Error(`${tableSelector} ${columnName} values are not descending after sort`);
  }

  async function sortableSummary(page, tableSelector, columnIndex) {
    return page.evaluate(({ tableSelector, columnIndex }) => {
      const values = [...document.querySelectorAll(`${tableSelector} tbody tr`)]
        .map((tr) => tr.children[columnIndex]?.textContent.trim() ?? '')
        .filter((v) => v !== '' && v !== '(no rows)')
        .map((v) => Number(v.replace(/,/g, '')));
      const sortedAscending = values.every((v, i) => i === 0 || values[i - 1] <= v);
      const sortedDescending = values.every((v, i) => i === 0 || values[i - 1] >= v);
      const ariaSort = document
        .querySelector(`${tableSelector} thead th:nth-child(${columnIndex + 1})`)
        ?.getAttribute('aria-sort');
      return { values, sortedAscending, sortedDescending, ariaSort };
    }, { tableSelector, columnIndex });
  }
}

const browser = await puppeteer.launch({
  executablePath: execPath,
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
let exitCode = 0;
try {
  const page = await browser.newPage();
  page.on('console', (msg) => console.log(`[browser ${msg.type()}]`, msg.text()));
  page.on('pageerror', (err) => console.error('[browser pageerror]', err.message));
  page.on('requestfailed', (req) =>
    console.error('[browser reqfail]', req.url(), req.failure()?.errorText));
  page.on('response', (resp) => {
    if (resp.status() >= 400) {
      console.error('[browser http', resp.status() + ']', resp.url());
    }
  });

  // ---- index.html ----
  console.log('--- visit', BASE + '/');
  await page.goto(BASE + '/', { waitUntil: 'load', timeout: 30000 });

  // Wait until the default query result table is populated (>= 1 data row).
  try {
    await page.waitForFunction(
      () => document.querySelectorAll('#results tbody tr').length > 0,
      { timeout: 60000 }
    );
  } catch (e) {
    const html = await page.evaluate(() => document.body.innerHTML);
    console.error('--- page body on timeout (first 3000 chars) ---');
    console.error(html.substring(0, 3000));
    throw e;
  }
  const summary = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#results tbody tr')];
    const headers = [...document.querySelectorAll('#results thead th')]
      .map(h => h.querySelector('.sort-label')?.textContent ?? h.textContent);
    const firstRowLinks = rows[0]
      ? [...rows[0].querySelectorAll('a')].map(a => ({ text: a.textContent, href: a.getAttribute('href') }))
      : [];
    return {
      headerCount: headers.length,
      headers,
      rowCount: rows.length,
      firstRowLinks,
    };
  });
  console.log('main page summary:', JSON.stringify(summary, null, 2));
  if (summary.rowCount === 0) throw new Error('main page produced 0 rows');
  if (!summary.firstRowLinks.some((l) => l.href?.startsWith('show.html?id='))) {
    throw new Error('main page first row missing per-show link');
  }
  const defaultQueryWindow = await page.evaluate(async () => {
    const meta = await fetch('data/build-meta.json', { cache: 'no-cache' }).then((r) => r.json());
    const builtAt = new Date(meta.built_at);
    const buildDate = new Date(Date.UTC(
      builtAt.getUTCFullYear(),
      builtAt.getUTCMonth(),
      builtAt.getUTCDate(),
    ));
    const startDate = new Date(buildDate);
    startDate.setUTCDate(startDate.getUTCDate() - 30);
    const fmt = (dt) =>
      `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
    return {
      expectedStart: fmt(startDate),
      expectedBuild: fmt(buildDate),
      sql: document.querySelector('#sql')?.value ?? '',
    };
  });
  if (!defaultQueryWindow.sql.includes(`DATE '${defaultQueryWindow.expectedStart}'`)) {
    throw new Error(`default query missing 30-day start literal ${defaultQueryWindow.expectedStart}`);
  }
  if (!defaultQueryWindow.sql.includes(`DATE '${defaultQueryWindow.expectedBuild}'`)) {
    throw new Error(`default query missing build-day literal ${defaultQueryWindow.expectedBuild}`);
  }
  await assertSortableNumericColumn(page, '#results', 'max_score_in_window');

  // Grab a show_id from the first title link to test the show page.
  const showHref = summary.firstRowLinks.find((l) => l.href.startsWith('show.html?id='))?.href;
  if (!showHref) throw new Error('no show.html link found in first row');

  // ---- show.html ----
  const showUrl = BASE + '/' + showHref;
  console.log('--- visit', showUrl);
  await page.goto(showUrl, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(
    () => document.querySelectorAll('#history tbody tr').length > 0
       || document.querySelector('#status.error')?.textContent,
    { timeout: 60000 }
  );
  const showSummary = await page.evaluate(() => {
    const title = document.querySelector('#title-h1')?.textContent;
    const statCards = [...document.querySelectorAll('#stat-grid .stat-card')].map((el) => ({
      label: el.querySelector('.label')?.textContent,
      value: el.querySelector('.value')?.textContent,
    }));
    const historyRows = document.querySelectorAll('#history tbody tr').length;
    const err = document.querySelector('#status.error')?.textContent;
    return { title, statCards, historyRows, error: err };
  });
  console.log('show page summary:', JSON.stringify(showSummary, null, 2));
  if (showSummary.error) throw new Error('show page rendered error: ' + showSummary.error);
  if (showSummary.historyRows === 0) throw new Error('show page produced 0 history rows');
  await assertSortableNumericColumn(page, '#history', 'score');

  console.log('\nAll end-to-end checks passed.');
} catch (e) {
  console.error('\nE2E FAILED:', e.message);
  exitCode = 1;
} finally {
  await browser.close();
}
process.exit(exitCode);
