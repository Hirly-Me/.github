# Hirly-Me/.github

The organisation profile for [hirly](https://hirly.me), and the tooling behind the public job-list repositories in this organisation.

## What is here

| Path | What it is |
| --- | --- |
| `profile/README.md` | The profile shown at [github.com/Hirly-Me](https://github.com/Hirly-Me). |
| `.github/workflows/update-job-list.yml` | Reusable workflow. Each list repository calls it once a day to re-render its README. |
| `scripts/render-job-list.mjs` | Renders one list's JSON into a README. Node 20+, no dependencies. |
| `scripts/render-profile.mjs` | Keeps the profile's list of repositories in step with the ones that exist. |
| `scripts/create-list-repos.mjs` | Creates the list repositories (local tool; needs `gh`, git and Chrome). |
| `scripts/brand/` | Generates the banner and social-preview images from HTML. |
| `templates/list-repo/` | The files every list repository starts with. |
| `lists.json` | Per-repository settings: the time of each daily run, and topics. |

## How a list is built

1. hirly publishes each curated list as JSON at `https://hirly.me/api/job-lists/<slug>.json`, and the index at `https://hirly.me/api/job-lists.json`. Which jobs a list contains is decided there, not here.
2. Once a day, a list repository's workflow calls `update-job-list.yml`, which fetches that JSON, checks it, and renders `README.md`.
3. If the README changed, the workflow commits it with the repository's own `GITHUB_TOKEN`. There are no secrets.

If the JSON cannot be read, or is empty or malformed, the README is left as it is and the run fails, so a stale list shows up in the Actions tab instead of an empty table being published.

## Where the jobs come from

Open postings from company career pages that hirly reads directly. Listings that reach hirly through job boards or aggregators are not included. Every row links to the job's page on hirly.me, which shows the posting and links to the employer's own application page.

## Running it yourself

```sh
node --test scripts/render-job-list.test.mjs scripts/render-profile.test.mjs

# Render a list into a file
node scripts/render-job-list.mjs --slug new-grad-software-engineer-jobs --out /tmp/README.md

# Create every list repository that does not exist yet
node scripts/create-list-repos.mjs --dry-run
node scripts/create-list-repos.mjs
```

## License

MIT — see [LICENSE](LICENSE). The job postings in the lists belong to the employers who published them.

hirly is a product of Insihts, Corp.
