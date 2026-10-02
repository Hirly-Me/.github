// node --test scripts/
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  LIVE_MARKER,
  Skipped,
  cell,
  locationCell,
  parseArgs,
  postedCell,
  renderReadme,
  run,
  validateIndex,
  validateList,
} from './render-job-list.mjs';

const SLUG = 'new-grad-software-engineer-jobs';
const CAMPAIGN = `utm_source=github&utm_medium=joblist&utm_campaign=${SLUG}`;

function job(overrides = {}) {
  return {
    title: 'Software Engineer, New Grad',
    company: 'Valley Health',
    location: 'Winchester, VA',
    more_locations: 0,
    country: 'US',
    work_mode: null,
    posted_on: '2026-10-02',
    posted_on_source: 'employer',
    url: `https://hirly.me/jobs/software-engineer-new-grad-at-valleyhealth-0b7c2a4e-5d1f-4a8e-9c3b-2f6e8d9a1b0c?${CAMPAIGN}`,
    ...overrides,
  };
}

function list(overrides = {}) {
  return {
    slug: SLUG,
    title: 'New Grad Software Engineer Jobs',
    description: 'Open software engineering jobs whose title asks for a new graduate.',
    url: `https://hirly.me/api/job-lists/${SLUG}.json`,
    repository: 'https://github.com/Hirly-Me/New-Grad-Software-Engineer-Jobs',
    generated_at: '2026-10-02T16:57:49.898Z',
    total: 926,
    count: 2,
    source: 'Open postings from company career pages hirly reads directly.',
    more_url: `https://hirly.me/jobs?${CAMPAIGN}`,
    jobs: [job(), job({ title: 'Junior Developer', posted_on_source: 'first_seen' })],
    ...overrides,
  };
}

const INDEX = {
  source: 'x',
  lists: [
    {
      slug: SLUG,
      title: 'New Grad Software Engineer Jobs',
      description: 'Open new grad jobs.',
      url: `https://hirly.me/api/job-lists/${SLUG}.json`,
      repository: 'https://github.com/Hirly-Me/New-Grad-Software-Engineer-Jobs',
    },
    {
      slug: 'cybersecurity-jobs',
      title: 'Cybersecurity Jobs',
      description: 'Open cybersecurity jobs.',
      url: 'https://hirly.me/api/job-lists/cybersecurity-jobs.json',
      repository: 'https://github.com/Hirly-Me/Cybersecurity-Jobs',
    },
  ],
};

describe('parseArgs', () => {
  it('needs a well-formed slug', () => {
    assert.throws(() => parseArgs([]), /--slug/);
    assert.throws(() => parseArgs(['--slug', '../x']), /--slug/);
    assert.equal(parseArgs(['--slug', SLUG]).endpoint, 'https://hirly.me');
  });

  it('refuses an argument it does not know', () => {
    assert.throws(() => parseArgs(['--slug', SLUG, '--force']), /Unknown argument/);
  });
});

describe('validateList', () => {
  it('accepts a well-formed list', () => {
    assert.equal(validateList(list(), SLUG).total, 926);
  });

  const broken = {
    'another list': list({ slug: 'cybersecurity-jobs' }),
    'no jobs': list({ jobs: [] }),
    'a zero total': list({ total: 0 }),
    'more jobs than its total': list({ total: 1 }),
    'an error body': { error: 'Temporarily unavailable' },
    'a job linking off hirly.me': list({ jobs: [job({ url: 'https://evil.example/jobs/x' })] }),
    'a job linking over http': list({ jobs: [job({ url: 'http://hirly.me/jobs/x' })] }),
    'a javascript link': list({ jobs: [job({ url: 'javascript:alert(1)' })] }),
    'a job without a company': list({ jobs: [job({ company: ' ' })] }),
    'an unreadable posted date': list({ jobs: [job({ posted_on: 'yesterday' })] }),
    'a board link off hirly.me': list({ more_url: 'https://example.com/jobs' }),
  };

  for (const [name, payload] of Object.entries(broken)) {
    it(`refuses ${name}`, () => {
      assert.throws(() => validateList(payload, SLUG));
    });
  }
});

describe('validateIndex', () => {
  it('accepts the index and refuses a repository outside the organisation', () => {
    assert.equal(validateIndex(INDEX).length, 2);
    assert.throws(() =>
      validateIndex({
        lists: [{ ...INDEX.lists[0], repository: 'https://github.com/someone/else' }],
      }),
    );
    assert.throws(() => validateIndex({ error: 'x' }));
  });
});

describe('table cells', () => {
  it('neutralises Markdown and HTML in posting text', () => {
    assert.equal(cell('Engineer | AI & <b>Security</b>'), 'Engineer \\| AI &amp; &lt;b&gt;Security&lt;/b&gt;');
    assert.equal(cell('[x](https://evil.example) `code` *bold*'), '\\[x\\](https://evil.example) \\`code\\` \\*bold\\*');
    assert.equal(cell('two\nlines\t here'), 'two lines here');
  });

  it('cuts an overlong title', () => {
    assert.ok(cell('x'.repeat(400)).length <= 110);
  });

  it('names the place, how many more, and the country', () => {
    assert.equal(locationCell(job()), 'Winchester, VA · United States');
    assert.equal(locationCell(job({ more_locations: 3 })), 'Winchester, VA +3 · United States');
    assert.equal(locationCell(job({ location: '', country: 'IN' })), 'India');
    assert.equal(locationCell(job({ location: 'Remote', work_mode: 'remote', country: 'CA' })), 'Remote · Canada');
    assert.equal(locationCell(job({ location: 'Ontario', work_mode: 'remote', country: 'CA' })), 'Remote · Ontario · Canada');
    assert.equal(locationCell(job({ location: '', country: null })), '—');
  });

  it('marks a date that is a first sighting, not a posting date', () => {
    assert.equal(postedCell(job()), '2026-10-02');
    assert.equal(postedCell(job({ posted_on_source: 'first_seen' })), '2026-10-02\\*');
  });
});

describe('renderReadme', () => {
  it('states the total, what is shown and when it was rendered', () => {
    const readme = renderReadme(list());

    assert.match(readme, /^# New Grad Software Engineer Jobs$/m);
    assert.match(readme, /\*\*926 open jobs\*\* match this list today; the newest 2 are below/);
    assert.match(readme, /Last updated Oct 2, 2026\./);
    assert.match(readme, /Looking for the other 924\?/);
  });

  it('prints one row per job, linking to its hirly page with the campaign', () => {
    const readme = renderReadme(list());
    const rows = readme.split('\n').filter((line) => line.startsWith('| ') && line.includes('[Apply]('));

    assert.equal(rows.length, 2);
    assert.ok(rows.every((row) => row.includes(CAMPAIGN)));
    assert.match(rows[0], /^\| Valley Health \| Software Engineer, New Grad \| Winchester, VA · United States \| 2026-10-02 \|/);
  });

  it('explains the asterisk only when a date needs it', () => {
    assert.match(renderReadme(list()), /gives no posting date/);
    assert.doesNotMatch(renderReadme(list({ jobs: [job()] })), /gives no posting date/);
  });

  it('says "updated daily" only when the scheduled Action renders it', () => {
    const local = renderReadme(list());
    const scheduled = renderReadme(list(), { scheduled: true });

    assert.doesNotMatch(local, /once a day/);
    assert.doesNotMatch(local, new RegExp(LIVE_MARKER));
    assert.match(scheduled, /re-renders this README once a day/);
    assert.match(scheduled, new RegExp(LIVE_MARKER));
  });

  it('links only the sibling lists it is given', () => {
    assert.doesNotMatch(renderReadme(list()), /More job lists/);

    const readme = renderReadme(list(), { siblings: [INDEX.lists[1]] });

    assert.match(readme, /## More job lists/);
    assert.match(readme, /\[Cybersecurity Jobs\]\(https:\/\/github\.com\/Hirly-Me\/Cybersecurity-Jobs\)/);
  });

  it('states the source, the licence and the operator', () => {
    const readme = renderReadme(list());

    assert.match(readme, /company career pages hirly reads directly/);
    assert.match(readme, /MIT licensed/);
    assert.match(readme, /belong to the employers who published them/);
    assert.match(readme, /is a product of Insihts, Corp\./);
  });
});

describe('run', () => {
  let dir;
  let server;
  let endpoint;
  let routes;
  const quiet = { log() {} };

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'job-list-test-'));
    routes = {};
    server = createServer((request, response) => {
      const route = routes[request.url];

      if (!route) {
        response.writeHead(404).end('{"error":"Not found"}');
        return;
      }

      response.writeHead(route.status ?? 200, { 'content-type': 'application/json' });
      response.end(typeof route.body === 'string' ? route.body : JSON.stringify(route.body));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function args(out, extra = []) {
    return ['--slug', SLUG, '--endpoint', endpoint, '--out', out, '--siblings', '', ...extra];
  }

  it('skips, leaving the README alone, while the endpoint has not launched', async () => {
    const out = join(dir, 'prelaunch.md');

    writeFileSync(out, 'rendered locally');
    routes = {};

    await assert.rejects(run(args(out), quiet), Skipped);
    assert.equal(readFileSync(out, 'utf8'), 'rendered locally');
  });

  it('fails, rather than skips, when a live endpoint disappears', async () => {
    const out = join(dir, 'was-live.md');

    writeFileSync(out, `old table\n${LIVE_MARKER}\n`);
    routes = {};

    await assert.rejects(run(args(out), quiet), (error) => !(error instanceof Skipped));
    assert.match(readFileSync(out, 'utf8'), /old table/);
  });

  it('fails and leaves the README alone when the list is unavailable', async () => {
    const out = join(dir, 'unavailable.md');

    writeFileSync(out, 'old table');
    routes = {
      '/api/job-lists.json': { body: INDEX },
      [`/api/job-lists/${SLUG}.json`]: { status: 503, body: { error: 'Temporarily unavailable' } },
    };

    await assert.rejects(run(args(out), quiet), /answered 503/);
    assert.equal(readFileSync(out, 'utf8'), 'old table');
  });

  it('fails on an empty or malformed list instead of writing an empty table', async () => {
    const out = join(dir, 'empty.md');

    writeFileSync(out, 'old table');
    routes = {
      '/api/job-lists.json': { body: INDEX },
      [`/api/job-lists/${SLUG}.json`]: { body: list({ jobs: [] }) },
    };

    await assert.rejects(run(args(out), quiet), /no jobs/);

    routes[`/api/job-lists/${SLUG}.json`] = { body: '<html>oops' };

    await assert.rejects(run(args(out), quiet), /did not answer with JSON/);
    assert.equal(readFileSync(out, 'utf8'), 'old table');
  });

  it('fails when the index is down or does not name the list', async () => {
    const out = join(dir, 'index.md');

    routes = { '/api/job-lists.json': { status: 500, body: {} } };
    await assert.rejects(run(args(out), quiet), /answered 500/);

    routes = { '/api/job-lists.json': { body: { lists: [INDEX.lists[1]] } } };
    await assert.rejects(run(args(out), quiet), /not a published list/);
  });

  it('writes the README, then reports no change for the same list', async () => {
    const out = join(dir, 'ok.md');

    routes = {
      '/api/job-lists.json': { body: INDEX },
      [`/api/job-lists/${SLUG}.json`]: { body: list() },
    };

    const first = await run(args(out, ['--scheduled']), quiet);
    const second = await run(args(out, ['--scheduled']), quiet);

    assert.deepEqual(first, { changed: true, total: 926, shown: 2 });
    assert.equal(second.changed, false);
    assert.match(readFileSync(out, 'utf8'), /once a day/);
  });

  it('links a sibling list only when its repository exists', async () => {
    const out = join(dir, 'siblings.md');

    routes = {
      '/api/job-lists.json': { body: INDEX },
      [`/api/job-lists/${SLUG}.json`]: { body: list() },
    };

    await run(['--slug', SLUG, '--endpoint', endpoint, '--out', out, '--siblings', 'Cybersecurity-Jobs'], quiet);
    assert.match(readFileSync(out, 'utf8'), /Hirly-Me\/Cybersecurity-Jobs/);

    await run(args(out), quiet);
    assert.doesNotMatch(readFileSync(out, 'utf8'), /More job lists/);
  });
});
