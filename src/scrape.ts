// src/scrape.ts
import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const BASE = 'https://doc.sis.columbia.edu';
const LIST_URL = `${BASE}/#sel/COMS_Fall2025.html`;
// 20253 == Fall 2025 term code on detail pages like /subj/COMS/W4701-20253-001/
const TERM_CODE = '20253';

type CourseRow = Record<string, string>;
type CourseItem = {
  url: string;
  title?: string | null;
  rows?: CourseRow[];
};

const outDir = path.resolve('data');
const rawDir = path.join(outDir, 'raw');
const shotsDir = path.join(outDir, 'screenshots');

async function ensureDirs() {
  for (const d of [outDir, rawDir, shotsDir]) {
    if (!existsSync(d)) await mkdir(d, { recursive: true });
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Collect course links from a page or any child frames. */
async function discoverCourseLinks(page: import('playwright').Page, termCode: string) {
  // helper to extract + normalize inside a given execution context
  const grab = async (ctx: import('playwright').Page | import('playwright').Frame) => {
    return await ctx.evaluate((tCode) => {
      const anchors = Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[];
      const urls = anchors
        .map((a) => a.getAttribute('href') || '')
        .filter((href) => href.includes('/subj/COMS/') && href.includes(`-${tCode}-`));
      const set = new Set(
        urls
          .map((href) => {
            try {
              return new URL(href, location.origin).toString().split('#')[0];
            } catch {
              return '';
            }
          })
          .filter(Boolean),
      );
      return Array.from(set);
    }, termCode);
  };

  const fromMain = await grab(page).catch(() => []);
  const frameUrls: string[] = [];
  // allow the SPA/iframe to attach
  await page.waitForLoadState('networkidle').catch(() => {});
  await sleep(800);

  // Try to force-load the subject “pane” if the site relies on the hash.
  await page.evaluate(() => {
    if (!location.hash || !location.hash.includes('COMS_Fall2025.html')) {
      location.hash = '#sel/COMS_Fall2025.html';
    }
  }).catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});
  await sleep(800);

  // Gather from all frames (the subject list often lives inside one).
  const frames = page.frames();
  const fromFramesArrays = await Promise.all(
    frames.map(async (f) => {
      const u = f.url();
      frameUrls.push(u);
      try {
        return await grab(f);
      } catch {
        return [];
      }
    }),
  );
  const fromFrames = fromFramesArrays.flat();

  // Debug output
  console.log(`Frame count: ${frames.length}`);
  frameUrls.slice(0, 5).forEach((u, i) => console.log(`  [frame ${i}] ${u}`));

  const all = Array.from(new Set([...fromMain, ...fromFrames]));
  return all;
}

async function scrape() {
  await ensureDirs();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 900 },
  });
  const page = await context.newPage();

  console.log('Navigating to list:', LIST_URL);
  await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle').catch(() => {});
  await sleep(1000);

  await page.screenshot({ path: path.join(shotsDir, 'list.png'), fullPage: true });

  const courseLinks = await discoverCourseLinks(page, TERM_CODE);

  console.log(`Discovered ${courseLinks.length} course links.`);
  if (courseLinks.length === 0) {
    console.warn('No links found from main/frames. Trying direct subject page as a fallback…');
    try {
      await page.goto(`${BASE}/sel/COMS_Fall2025.html`, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      await page.waitForLoadState('networkidle').catch(() => {});
      await sleep(800);
      const retry = await discoverCourseLinks(page, TERM_CODE);
      console.log(`Fallback discovered ${retry.length} course links.`);
      courseLinks.push(...retry);
    } catch (e) {
      console.warn('Fallback navigation failed:', e);
    }
  }

  const results: CourseItem[] = [];
  for (let i = 0; i < courseLinks.length; i++) {
    const url = courseLinks[i];
    console.log(`[${i + 1}/${courseLinks.length}] Fetching`, url);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle').catch(() => {});
    await sleep(350); // be polite

    const html = await page.content();
    const slug = url.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(-180);
    await writeFile(path.join(rawDir, `${slug}.html`), html, 'utf8');

    const title = await page.locator('h1, h2').first().textContent().catch(() => null);

    let rows: CourseRow[] | undefined = undefined;
    const tableCount = await page.locator('table').first().count();

    if (tableCount > 0) {
      const table = page.locator('table').first();
      const matrix: string[][] = await table.evaluate((t) => {
        const rows = Array.from(t.querySelectorAll('tr'));
        return rows.map((r) =>
          Array.from(r.querySelectorAll('th,td')).map((el) =>
            (el.textContent || '').trim().replace(/\s+/g, ' ')
          )
        );
      });

      // Defensive: drop empty trailing columns and normalize row lengths
      const colCount = Math.max(...matrix.map((r) => r.length));
      const norm = matrix.map((r) => {
        const copy = r.slice(0, colCount);
        while (copy.length < colCount) copy.push('');
        return copy;
      });

      rows = [];

      if (colCount === 2) {
        // Common DOC layout: 2 columns, right column is the label, left is the value.
        // First row often looks like: [ "<callNumber>", "Call Number" ]
        const firstRow = norm[0] || [];
        const leftTop = firstRow[0] || '';
        const rightTop = (firstRow[1] || '').toLowerCase();

        // If the top-right cell is "Call Number", add it explicitly
        if (rightTop.includes('call number') && leftTop) {
          rows.push({ 'Call Number': leftTop });
        }

        // For each subsequent row, flip to { [label]: value }
        for (let i = 1; i < norm.length; i++) {
          const value = norm[i][1] || '';
          const label = norm[i][0] || '';
          if (label) {
            rows.push({ [label]: value });
          }
        }
      } else if (norm.length >= 2) {
        // Fallback for true header tables (3+ columns)
        const headers = norm[0].map((h, idx) => h || `col_${idx + 1}`);
        for (let i = 1; i < norm.length; i++) {
          const r = norm[i];
          const obj: CourseRow = {};
          headers.forEach((h, idx) => (obj[h] = r[idx] || ''));
          rows.push(obj);
        }
      }
    }

    results.push({ url, title, rows });
  }

  const outPath = path.join(outDir, 'courses.json');
  await writeFile(outPath, JSON.stringify(results, null, 2), 'utf8');
  console.log('Wrote', outPath);

  await browser.close();
}

scrape().catch((err) => {
  console.error(err);
  process.exit(1);
});
