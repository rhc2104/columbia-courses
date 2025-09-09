# Columbia COMS Fall 2025 Scraper (Playwright + TypeScript)

This starter project navigates to **https://doc.sis.columbia.edu/#sel/COMS_Fall2025.html**, gathers links to individual COMS course pages for **Fall 2025** (term code `20253`), and saves basic structured data. It also drops raw HTML and screenshots so you can quickly refine selectors.

## Quickstart

1) **Install dependencies**
```bash
npm i
npx playwright install --with-deps chromium
```

2) **Run the scraper (dev / TS directly)**
```bash
npm run dev
```

Data will be written to `data/`:
- `data/screenshots/list.png` — the list page screenshot
- `data/raw/*.html` — raw course pages
- `data/courses.json` — aggregated structured data (best-effort, may need selector tweaks)

## Claude Code (optional but recommended)

If you're using **Claude Code** for in-IDE help:
- Open your IDE (VS Code, Cursor, Windsurf, etc.), open the **integrated terminal**, and run:
  ```bash
  claude
  ```
- Follow the prompts to connect your IDE. Then you can ask Claude to refine selectors, extract more fields, or add tests.

## Notes

- This starter uses conservative navigation (`networkidle` + selector checks) because the DOC pages may render content dynamically.
- If the list page doesn't expose course links, the script will still leave you raw HTML and a screenshot so you can quickly adjust.
- Please follow the site's Terms of Use and be gentle (low concurrency / delay).

## Common tweaks you can ask Claude to make
- Improve selectors to pull `Times/Location`, `Instructor`, `Points`, `Enrollment`
- Parallelize fetches with a small pool (avoid hammering the site)
- Add CSV export
- Split JSON by course number
- Add retries/backoff and error reporting
