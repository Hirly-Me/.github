import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { END, START, withLists } from './render-profile.mjs';

const LISTS = [
  { title: 'Cybersecurity Jobs', description: 'Open cybersecurity jobs.', repository: 'https://github.com/Hirly-Me/Cybersecurity-Jobs' },
  { title: 'AI & ML Engineer Jobs', description: 'Open AI jobs.', repository: 'https://github.com/Hirly-Me/AI-ML-Engineer-Jobs' },
];

describe('withLists', () => {
  it('replaces only what is between the markers', () => {
    const profile = `intro\n${START}\n- old\n${END}\noutro\n`;

    assert.equal(
      withLists(profile, LISTS),
      `intro\n${START}\n- [Cybersecurity Jobs](https://github.com/Hirly-Me/Cybersecurity-Jobs) — Open cybersecurity jobs.\n- [AI &amp; ML Engineer Jobs](https://github.com/Hirly-Me/AI-ML-Engineer-Jobs) — Open AI jobs.\n${END}\noutro\n`,
    );
  });

  it('is stable: rendering twice changes nothing', () => {
    const once = withLists(`a\n${START}\n${END}\nb`, LISTS);

    assert.equal(withLists(once, LISTS), once);
  });

  it('refuses to empty the section or to write without markers', () => {
    assert.throws(() => withLists(`a\n${START}\n${END}\nb`, []), /No list repository/);
    assert.throws(() => withLists('no markers here', LISTS), /markers/);
  });

  it('works on the profile in this repository', () => {
    const profile = readFileSync(new URL('../profile/README.md', import.meta.url), 'utf8');

    assert.match(withLists(profile, LISTS), /is a product of Insihts, Corp\./);
  });
});
