#!/usr/bin/env node
// Renders one hirly job list into a README.md.
//
// Reads https://hirly.me/api/job-lists/<slug>.json (or a local copy of it),
// checks it, and writes the README. It never writes an empty or partial
// table: when the list cannot be read, the README is left as it is and the
// process exits non-zero — except while the endpoint has not launched yet
// (the index itself answers 404), which is reported as "skipped".
//
// Node 20+, no dependencies.

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const DEFAULT_ENDPOINT = 'https://hirly.me';
export const GITHUB_ORG = 'Hirly-Me';
const SITE_HOST = 'hirly.me';
const FETCH_TIMEOUT_MS = 60_000;
const MAX_CELL_LENGTH = 110;
const UTM = { utm_source: 'github', utm_medium: 'joblist' };

/**
 * Left at the foot of a README rendered by the scheduled Action. A README
 * that carries it has been rendered from the live endpoint before, so the
 * endpoint going missing afterwards is a failure, not "not launched yet".
 */
export const LIVE_MARKER = '<!-- job-list: rendered from the live endpoint -->';

/** The run ended without a README change, and that is not a failure. */
export class Skipped extends Error {}

// ---------------------------------------------------------------- arguments

export function parseArgs(argv) {
  const args = { endpoint: DEFAULT_ENDPOINT, out: 'README.md', scheduled: false };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      index += 1;
      if (argv[index] === undefined) throw new Error(`${flag} needs a value`);
      return argv[index];
    };

    if (flag === '--slug') args.slug = value();
    else if (flag === '--endpoint') args.endpoint = value().replace(/\/+$/, '');
    else if (flag === '--out') args.out = value();
    else if (flag === '--input') args.input = value();
    else if (flag === '--index-input') args.indexInput = value();
    else if (flag === '--siblings') args.siblings = value();
    else if (flag === '--scheduled') args.scheduled = true;
    else throw new Error(`Unknown argument: ${flag}`);
  }

  if (!args.slug || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(args.slug)) {
    throw new Error('--slug <list-slug> is required (lower-case, hyphenated)');
  }

  return args;
}

// --------------------------------------------------------------- validation

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isHirlyUrl(value, pathPrefix) {
  if (typeof value !== 'string') return false;

  try {
    const url = new URL(value);

    return (
      url.protocol === 'https:' &&
      url.hostname === SITE_HOST &&
      url.pathname.startsWith(pathPrefix)
    );
  } catch {
    return false;
  }
}

function isDay(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function isJob(job) {
  return (
    isRecord(job) &&
    typeof job.title === 'string' &&
    job.title.trim() !== '' &&
    typeof job.company === 'string' &&
    job.company.trim() !== '' &&
    typeof job.location === 'string' &&
    (job.country === null || /^[A-Z]{2}$/.test(job.country)) &&
    (job.work_mode === null || job.work_mode === 'remote') &&
    isDay(job.posted_on) &&
    (job.posted_on_source === 'employer' || job.posted_on_source === 'first_seen') &&
    isHirlyUrl(job.url, '/jobs/')
  );
}

/** The list payload, or an Error naming what is wrong with it. */
export function validateList(payload, slug) {
  if (!isRecord(payload)) throw new Error('The list is not a JSON object');
  if (payload.slug !== slug) throw new Error(`The list is for "${payload.slug}", not "${slug}"`);

  for (const field of ['title', 'description', 'source', 'generated_at']) {
    if (typeof payload[field] !== 'string' || payload[field].trim() === '') {
      throw new Error(`The list has no ${field}`);
    }
  }

  if (Number.isNaN(Date.parse(payload.generated_at))) {
    throw new Error('The list has an unreadable generated_at');
  }
  if (!Number.isSafeInteger(payload.total) || payload.total <= 0) {
    throw new Error('The list has no total');
  }
  if (!Array.isArray(payload.jobs) || payload.jobs.length === 0) {
    throw new Error('The list has no jobs');
  }
  if (payload.total < payload.jobs.length) {
    throw new Error('The list shows more jobs than its total');
  }
  if (!isHirlyUrl(payload.more_url, '/jobs')) {
    throw new Error('The list has no link to the hirly job board');
  }

  const bad = payload.jobs.findIndex((job) => !isJob(job));

  if (bad !== -1) throw new Error(`Job ${bad + 1} of the list is malformed`);

  return payload;
}

/** The index payload's lists, or an Error. */
export function validateIndex(payload) {
  if (!isRecord(payload) || !Array.isArray(payload.lists)) {
    throw new Error('The list index is malformed');
  }

  const lists = payload.lists.filter(
    (list) =>
      isRecord(list) &&
      typeof list.slug === 'string' &&
      typeof list.title === 'string' &&
      typeof list.description === 'string' &&
      typeof list.repository === 'string' &&
      list.repository.startsWith(`https://github.com/${GITHUB_ORG}/`),
  );

  if (lists.length !== payload.lists.length) {
    throw new Error('The list index has a malformed entry');
  }

  return lists;
}

// ----------------------------------------------------------------- markdown

/** Text for a table cell: one line, nothing Markdown or HTML can act on. */
export function cell(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  const cut =
    flat.length > MAX_CELL_LENGTH
      ? `${flat.slice(0, MAX_CELL_LENGTH - 1).trimEnd()}…`
      : flat;

  return cut
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_[\]|~])/g, '\\$1');
}

const COUNTRY_NAMES = new Intl.DisplayNames(['en'], { type: 'region' });

function countryName(code) {
  if (!code) return '';

  try {
    return COUNTRY_NAMES.of(code) ?? code;
  } catch {
    return code;
  }
}

/** "Seattle, WA · United States", "Remote · Canada", "India". */
export function locationCell(job) {
  const country = countryName(job.country);
  const place = job.location.trim();
  const more = job.more_locations > 0 ? ` +${job.more_locations}` : '';
  const remote = job.work_mode === 'remote' && !/remote/i.test(place) ? 'Remote' : '';
  const parts = [remote, place ? `${place}${more}` : '', country].filter(Boolean);

  return cell(parts.join(' · ')) || '—';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-10-02" — and with `*` when it is the first sighting, not a posted date. */
export function postedCell(job) {
  return job.posted_on_source === 'first_seen' ? `${job.posted_on}\\*` : job.posted_on;
}

function withCampaign(url, slug, content) {
  const tagged = new URL(url);

  for (const [key, value] of Object.entries(UTM)) tagged.searchParams.set(key, value);
  tagged.searchParams.set('utm_campaign', slug);
  if (content) tagged.searchParams.set('utm_content', content);

  return tagged.toString();
}

function number(value) {
  return value.toLocaleString('en-US');
}

function row(job) {
  return `| ${cell(job.company)} | ${cell(job.title)} | ${locationCell(job)} | ${postedCell(job)} | [Apply](${job.url}) |`;
}

/**
 * The README. `siblings` are the other lists whose repositories exist;
 * `scheduled` is true only when a scheduled GitHub Action is rendering, which
 * is the only time the README may say it is updated daily.
 */
export function renderReadme(list, { siblings = [], scheduled = false, endpoint = DEFAULT_ENDPOINT } = {}) {
  const updated = list.generated_at.slice(0, 10);
  const [year, month, day] = updated.split('-').map(Number);
  const updatedText = `${MONTHS[month - 1]} ${day}, ${year}`;
  const anyFirstSeen = list.jobs.some((job) => job.posted_on_source === 'first_seen');
  const home = withCampaign(`https://${SITE_HOST}/`, list.slug, 'cta');
  const board = withCampaign(list.more_url, list.slug, 'more');
  const shown =
    list.total > list.jobs.length
      ? `the newest ${number(list.jobs.length)} are below`
      : 'all of them are below';

  const lines = [
    `<a href="${withCampaign(`https://${SITE_HOST}/`, list.slug, 'banner')}"><img src="assets/banner.png" alt="${cell(list.title)} — a job list by hirly" width="100%"></a>`,
    '',
    `# ${cell(list.title)}`,
    '',
    `${cell(list.description)}`,
    '',
    `**${number(list.total)} open jobs** match this list today; ${shown}, newest first. Last updated ${updatedText}.`,
    '',
    `> **Get matched to these jobs.** Upload your resume on [hirly](${home}) to see how it matches roles like these.`,
    '',
    '| Company | Role | Location | Posted | Apply |',
    '| --- | --- | --- | --- | --- |',
    ...list.jobs.map(row),
    '',
  ];

  if (anyFirstSeen) {
    lines.push(
      '\\* The employer’s page gives no posting date; this is the day hirly first saw the job.',
      '',
    );
  }

  if (list.total > list.jobs.length) {
    lines.push(
      `Looking for the other ${number(list.total - list.jobs.length)}? [Search every open job on hirly](${board}).`,
      '',
    );
  }

  lines.push(
    '## How this list is built',
    '',
    `- **Source.** ${cell(list.source)}`,
    '- **Open jobs only.** Every job here was open when the list was rendered; one that has closed since is dropped at the next render.',
    '- **No repeats, no flooding.** The same role in the same place is listed once, and one employer gets at most ten rows.',
    '- **Links.** “Apply” opens the job’s page on hirly.me, which shows the posting and links to the employer’s own application page.',
    scheduled
      ? `- **Updates.** A GitHub Action re-renders this README once a day from [the list’s JSON](${endpoint}/api/job-lists/${list.slug}.json).`
      : '- **Updates.** This README is generated from hirly’s job data; the date above is when it was last rendered.',
    '',
  );

  if (siblings.length > 0) {
    lines.push(
      '## More job lists',
      '',
      ...siblings.map(
        (sibling) => `- [${cell(sibling.title)}](${sibling.repository}) — ${cell(sibling.description)}`,
      ),
      '',
    );
  }

  lines.push(
    '## License',
    '',
    `The list format and the code that renders it are MIT licensed (see [LICENSE](LICENSE) and [${GITHUB_ORG}/.github](https://github.com/${GITHUB_ORG}/.github)). The job postings belong to the employers who published them.`,
    '',
    `[hirly](${withCampaign(`https://${SITE_HOST}/`, list.slug, 'footer')}) is a product of Insihts, Corp.`,
    '',
  );

  if (scheduled) lines.push(LIVE_MARKER, '');

  return lines.join('\n');
}

// ------------------------------------------------------------------ reading

async function fetchJson(url, headers = {}) {
  let response;

  try {
    response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'Hirly-Me-job-lists', ...headers },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'error',
    });
  } catch (error) {
    throw new Error(`${url} could not be reached: ${error instanceof Error ? error.message : error}`);
  }

  if (!response.ok) {
    const failure = new Error(`${url} answered ${response.status}`);

    failure.status = response.status;
    throw failure;
  }

  try {
    return await response.json();
  } catch {
    throw new Error(`${url} did not answer with JSON`);
  }
}

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

async function readIndex(args) {
  if (args.indexInput) return validateIndex(readJsonFile(args.indexInput));

  try {
    return validateIndex(await fetchJson(`${args.endpoint}/api/job-lists.json`));
  } catch (error) {
    // The index itself is missing: the endpoint has not launched. Anything
    // else — a 5xx, a timeout, a malformed index — is a failure.
    const wasLive =
      existsSync(args.out) && readFileSync(args.out, 'utf8').includes(LIVE_MARKER);

    if (error.status === 404 && !wasLive) {
      throw new Skipped(
        `${args.endpoint}/api/job-lists.json is not live yet (404). The README was left as it is.`,
      );
    }

    throw error;
  }
}

/** Names of the organisation's public repositories. */
async function existingRepositories(args) {
  if (args.siblings !== undefined) {
    return new Set(args.siblings.split(',').map((name) => name.trim()).filter(Boolean));
  }

  const token = process.env.GITHUB_TOKEN;
  const repositories = await fetchJson(
    `https://api.github.com/orgs/${GITHUB_ORG}/repos?type=public&per_page=100`,
    {
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  );

  if (!Array.isArray(repositories)) throw new Error('GitHub did not list the repositories');

  return new Set(repositories.map((repository) => repository.name));
}

export async function run(argv, log = console) {
  const args = parseArgs(argv);
  const index = await readIndex(args);
  const entry = index.find((list) => list.slug === args.slug);

  if (!entry) throw new Error(`"${args.slug}" is not a published list`);

  const list = validateList(
    args.input
      ? readJsonFile(args.input)
      : await fetchJson(`${args.endpoint}/api/job-lists/${args.slug}.json`),
    args.slug,
  );
  const existing = await existingRepositories(args);
  const siblings = index.filter(
    (other) =>
      other.slug !== args.slug && existing.has(other.repository.split('/').pop()),
  );
  const readme = renderReadme(list, { siblings, scheduled: args.scheduled, endpoint: args.endpoint });
  const changed = !existsSync(args.out) || readFileSync(args.out, 'utf8') !== readme;

  if (changed) writeFileSync(args.out, readme);

  log.log(
    `${args.slug}: ${list.jobs.length} of ${list.total} jobs, generated ${list.generated_at} — ${changed ? 'README written' : 'README unchanged'}`,
  );

  return { changed, total: list.total, shown: list.jobs.length };
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).then(
    (result) => {
      setOutput('status', result.changed ? 'changed' : 'unchanged');
      setOutput('total', result.total);
    },
    (error) => {
      if (error instanceof Skipped) {
        console.log(`::notice title=Job list skipped::${error.message}`);
        setOutput('status', 'skipped');
        return;
      }

      console.error(`::error title=Job list not updated::${error.message}`);
      process.exitCode = 1;
    },
  );
}
