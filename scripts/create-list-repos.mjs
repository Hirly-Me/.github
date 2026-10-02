#!/usr/bin/env node
// Creates the public job-list repositories in the Hirly-Me organisation —
// one per list published at https://hirly.me/api/job-lists.json that does not
// have a repository yet. Safe to re-run: an existing repository is skipped.
//
//   node scripts/create-list-repos.mjs                 # every missing list
//   node scripts/create-list-repos.mjs --only <slug>   # one list
//   node scripts/create-list-repos.mjs --dry-run       # say what would happen
//
// Each repository gets: a README rendered from the list's JSON (the same
// renderer the daily Action uses), the workflow that re-renders it, the
// banner and social-preview images, an MIT LICENSE, and its description,
// homepage and topics.
//
// Needs: Node 20+, git, the GitHub CLI (`gh`) signed in as an owner of the
// organisation, and Google Chrome for the images. A local tool — it is not
// run by any Action.
//
// Before the endpoint is live, a list can be created from a saved copy of its
// JSON: --only <slug> --input <list.json> --index-input <index.json>.

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_ENDPOINT, GITHUB_ORG, Skipped, run as renderList, validateIndex } from './render-job-list.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SETTINGS = JSON.parse(readFileSync(join(ROOT, 'lists.json'), 'utf8'));
const BANNER_SUBTITLE = 'Open jobs from company career pages, newest first.';
const MAX_DESCRIPTION = 350;

function parseArgs(argv) {
  const args = { endpoint: DEFAULT_ENDPOINT, dryRun: false };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = () => {
      index += 1;
      if (argv[index] === undefined) throw new Error(`${flag} needs a value`);
      return argv[index];
    };

    if (flag === '--only') args.only = value();
    else if (flag === '--endpoint') args.endpoint = value().replace(/\/+$/, '');
    else if (flag === '--input') args.input = value();
    else if (flag === '--index-input') args.indexInput = value();
    else if (flag === '--dry-run') args.dryRun = true;
    else throw new Error(`Unknown argument: ${flag}`);
  }

  if (args.input && !args.only) throw new Error('--input needs --only <slug>');

  return args;
}

function sh(command, commandArgs, options = {}) {
  return execFileSync(command, commandArgs, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options }).trim();
}

function existingRepositories() {
  return new Set(
    sh('gh', ['api', '--paginate', `orgs/${GITHUB_ORG}/repos?type=public&per_page=100`, '--jq', '.[].name'])
      .split('\n')
      .filter(Boolean),
  );
}

async function readIndex(args) {
  if (args.indexInput) return validateIndex(JSON.parse(readFileSync(args.indexInput, 'utf8')));

  const response = await fetch(`${args.endpoint}/api/job-lists.json`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(60_000),
  });

  if (response.status === 404) {
    throw new Skipped(`${args.endpoint}/api/job-lists.json is not live yet (404). Nothing was created.`);
  }
  if (!response.ok) throw new Error(`${args.endpoint}/api/job-lists.json answered ${response.status}`);

  return validateIndex(await response.json());
}

function description(list) {
  const text = `${list.description} Newest first, from company career pages. By hirly.me.`;

  if (text.length > MAX_DESCRIPTION) throw new Error(`The description of ${list.slug} is too long`);

  return text;
}

/**
 * The commit identity: the signed-in GitHub user's no-reply address, so a
 * personal email from the local git config never lands in a public repository.
 */
function commitAuthor() {
  const [id, login] = sh('gh', ['api', 'user', '--jq', '"\\(.id) \\(.login)"']).split(' ');

  return { name: login, email: `${id}+${login}@users.noreply.github.com` };
}

async function createRepository(list, args, existing, author) {
  const repo = list.repository.split('/').pop();
  const settings = SETTINGS.lists[list.slug];

  if (!settings) throw new Error(`lists.json has no entry for ${list.slug}`);

  const work = mkdtempSync(join(tmpdir(), `${repo}-`));

  try {
    // The workflow that re-renders the README, and the licence.
    cpSync(join(ROOT, 'templates/list-repo'), work, { recursive: true });

    const workflow = join(work, '.github/workflows/update.yml');

    writeFileSync(
      workflow,
      readFileSync(workflow, 'utf8').replace('__CRON__', settings.cron).replace('__SLUG__', list.slug),
    );

    // The images the README and the repository's social preview use.
    mkdirSync(join(work, 'assets'));
    execFileSync(
      process.execPath,
      [
        join(ROOT, 'scripts/brand/make-banners.mjs'),
        '--out', join(work, 'assets'),
        '--title', list.title,
        '--subtitle', BANNER_SUBTITLE,
        '--caption', `github.com/${GITHUB_ORG}/${repo}`,
      ],
      { stdio: 'inherit' },
    );

    // The README, from the same renderer the Action uses.
    const siblings = [...existing].join(',');

    await renderList([
      '--slug', list.slug,
      '--endpoint', args.endpoint,
      '--out', join(work, 'README.md'),
      '--siblings', siblings,
      ...(args.input ? ['--input', args.input] : []),
      ...(args.indexInput ? ['--index-input', args.indexInput] : []),
    ]);

    const trailer = process.env.COMMIT_TRAILER ? `\n\n${process.env.COMMIT_TRAILER}` : '';
    const git = (...gitArgs) =>
      sh('git', ['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`, ...gitArgs], { cwd: work });

    git('init', '--quiet', '--initial-branch', 'main');
    git('add', '--all');
    git('commit', '--quiet', '--message', `feat: ${list.title} job list${trailer}`);

    sh('gh', [
      'repo', 'create', `${GITHUB_ORG}/${repo}`,
      '--public',
      '--source', work,
      '--remote', 'origin',
      '--push',
      '--description', description(list),
      '--homepage', SETTINGS.homepage,
      '--disable-wiki',
    ]);
    sh('gh', [
      'repo', 'edit', `${GITHUB_ORG}/${repo}`,
      '--enable-projects=false',
      ...[...SETTINGS.commonTopics, ...settings.topics].flatMap((topic) => ['--add-topic', topic]),
    ]);

    console.log(`created https://github.com/${GITHUB_ORG}/${repo}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const index = await readIndex(args);
  const wanted = args.only ? index.filter((list) => list.slug === args.only) : index;

  if (wanted.length === 0) throw new Error(`"${args.only}" is not a published list`);

  const existing = existingRepositories();
  const author = commitAuthor();

  for (const list of wanted) {
    const repo = list.repository.split('/').pop();

    if (existing.has(repo)) {
      console.log(`exists  https://github.com/${GITHUB_ORG}/${repo}`);
    } else if (args.dryRun) {
      console.log(`would create https://github.com/${GITHUB_ORG}/${repo} (${SETTINGS.lists[list.slug]?.cron ?? 'no cron in lists.json'})`);
    } else {
      await createRepository(list, args, existing, author);
      existing.add(repo);
    }
  }

  console.log(
    'Sibling links appear in each README at its next daily run. To set a social preview, upload assets/social-preview.png under each repository’s Settings → Social preview (GitHub has no API for it).',
  );
}

main().catch((error) => {
  console.error(error instanceof Skipped ? error.message : `Failed: ${error.message}`);
  process.exitCode = 1;
});
