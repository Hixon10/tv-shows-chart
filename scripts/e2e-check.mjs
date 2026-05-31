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
    const headers = [...document.querySelectorAll('#results thead th')].map(h => h.textContent);
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

  console.log('\nAll end-to-end checks passed.');
} catch (e) {
  console.error('\nE2E FAILED:', e.message);
  exitCode = 1;
} finally {
  await browser.close();
}
process.exit(exitCode);
