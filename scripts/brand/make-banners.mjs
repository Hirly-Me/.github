#!/usr/bin/env node
// Renders the brand images for the Hirly-Me repositories from HTML with
// headless Chrome: a README banner (1760×400) and a social preview
// (1280×640) per repository.
//
//   node scripts/brand/make-banners.mjs --out <dir> --title "…" --subtitle "…" --caption "…"
//
// A local tool, not part of the daily Action: it needs Google Chrome and a
// network connection (IBM Plex is loaded from Google Fonts). Set CHROME to
// the browser binary if it is not in the default macOS location.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHROME =
  process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const SIZES = [
  { file: 'banner.png', width: 1760, height: 400, scale: 1 },
  { file: 'social-preview.png', width: 1280, height: 640, scale: 1.45 },
];

function parseArgs(argv) {
  const args = {};

  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];

    if (!['--out', '--title', '--subtitle', '--caption'].includes(flag) || value === undefined) {
      throw new Error(`Usage: --out <dir> --title <text> --subtitle <text> --caption <text>`);
    }

    args[flag.slice(2)] = value;
  }

  for (const name of ['out', 'title', 'subtitle', 'caption']) {
    if (!args[name]) throw new Error(`--${name} is required`);
  }

  return args;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function page({ title, subtitle, caption }, size) {
  const mark = readFileSync(join(HERE, 'hirly-mark.png')).toString('base64');

  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=block" rel="stylesheet">
<style>
  :root { --bg: #f7f7f2; --fg: #0a0c0f; --muted: #4e5a5f; --line: #dce0e5; --blue: #155cff; }
  * { box-sizing: border-box; margin: 0; }
  html, body { width: ${size.width}px; height: ${size.height}px; }
  body {
    background: var(--bg); color: var(--fg);
    font-family: 'IBM Plex Sans', system-ui, sans-serif;
    font-size: ${16 * size.scale}px;
    display: flex; flex-direction: column; justify-content: space-between;
    padding: 3.25em 4.5em; border-bottom: 0.5em solid var(--blue);
  }
  .brand { display: flex; align-items: center; gap: 0.7em; }
  .brand img { width: 2.6em; height: 2.6em; border-radius: 0.55em; }
  .brand span { font-size: 1.75em; font-weight: 500; letter-spacing: -0.035em; }
  h1 { font-size: 4.1em; line-height: 1.04; font-weight: 600; letter-spacing: -0.035em; max-width: 18em; }
  p { font-size: 1.5em; color: var(--muted); margin-top: 0.55em; max-width: 34em; line-height: 1.3; }
  footer {
    font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 1.15em; color: var(--muted);
    display: flex; align-items: center; gap: 0.8em;
  }
  footer i { width: 0.6em; height: 0.6em; background: var(--blue); display: inline-block; }
</style>
<body>
  <div class="brand"><img src="data:image/png;base64,${mark}" alt=""><span>hirly</span></div>
  <main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p></main>
  <footer><i></i>${escapeHtml(caption)}</footer>
</body>
</html>`;
}

const args = parseArgs(process.argv.slice(2));
const out = resolve(args.out);
const work = mkdtempSync(join(tmpdir(), 'hirly-banner-'));

mkdirSync(out, { recursive: true });

try {
  for (const size of SIZES) {
    const html = join(work, `${size.file}.html`);

    writeFileSync(html, page(args, size));
    execFileSync(
      CHROME,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        `--window-size=${size.width},${size.height}`,
        '--virtual-time-budget=8000',
        `--screenshot=${join(out, size.file)}`,
        pathToFileURL(html).href,
      ],
      { stdio: 'ignore', timeout: 60_000 },
    );
    console.log(`wrote ${join(out, size.file)}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
