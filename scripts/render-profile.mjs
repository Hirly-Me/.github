#!/usr/bin/env node
// Keeps the "Job lists" section of the organisation profile
// (profile/README.md) in step with the list repositories that exist.
//
// Between the `lists:start` and `lists:end` markers it writes one line per
// list that is both published at hirly.me/api/job-lists.json AND has a public
// repository in the organisation — so the profile never links a repository
// that is not there. Everything outside the markers is left as written.
//
// Node 20+, no dependencies. Run by .github/workflows/update-profile.yml.

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { DEFAULT_ENDPOINT, GITHUB_ORG, Skipped, cell, validateIndex } from './render-job-list.mjs';

export const START = '<!-- lists:start -->';
export const END = '<!-- lists:end -->';

/** The profile with its list section replaced; throws without both markers. */
export function withLists(profile, lists) {
  const start = profile.indexOf(START);
  const end = profile.indexOf(END);

  if (start === -1 || end === -1 || end < start) {
    throw new Error('profile/README.md has lost its lists:start / lists:end markers');
  }
  if (lists.length === 0) throw new Error('No list repository exists; the profile was left as it is');

  const lines = lists.map((list) => `- [${cell(list.title)}](${list.repository}) — ${cell(list.description)}`);

  return `${profile.slice(0, start)}${START}\n${lines.join('\n')}\n${profile.slice(end)}`;
}

async function fetchJson(url, headers = {}) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'Hirly-Me-job-lists', ...headers },
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    const failure = new Error(`${url} answered ${response.status}`);

    failure.status = response.status;
    throw failure;
  }

  return response.json();
}

export async function run({ endpoint = DEFAULT_ENDPOINT, path = 'profile/README.md' } = {}) {
  let index;

  try {
    index = validateIndex(await fetchJson(`${endpoint}/api/job-lists.json`));
  } catch (error) {
    if (error.status === 404) {
      throw new Skipped(`${endpoint}/api/job-lists.json is not live yet (404). The profile was left as it is.`);
    }

    throw error;
  }

  const token = process.env.GITHUB_TOKEN;
  const repositories = await fetchJson(
    `https://api.github.com/orgs/${GITHUB_ORG}/repos?type=public&per_page=100`,
    token ? { Authorization: `Bearer ${token}` } : {},
  );
  const existing = new Set(repositories.map((repository) => repository.name));
  const profile = readFileSync(path, 'utf8');
  const next = withLists(
    profile,
    index.filter((list) => existing.has(list.repository.split('/').pop())),
  );

  if (next !== profile) writeFileSync(path, next);

  return { changed: next !== profile };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const output = (value) => {
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `status=${value}\n`);
  };

  run().then(
    (result) => {
      console.log(result.changed ? 'profile updated' : 'profile unchanged');
      output(result.changed ? 'changed' : 'unchanged');
    },
    (error) => {
      if (error instanceof Skipped) {
        console.log(`::notice title=Profile skipped::${error.message}`);
        output('skipped');
        return;
      }

      console.error(`::error title=Profile not updated::${error.message}`);
      process.exitCode = 1;
    },
  );
}
