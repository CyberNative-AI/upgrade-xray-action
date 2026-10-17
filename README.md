# Upgrade X-Ray for npm and PyPI dependency updates

**In seconds, at $0.02 per package diff or $0.25 per lockfile report, see what a dependency update really changes in its published npm or PyPI files (new install scripts; new network, shell or eval calls; removed exports; new dependencies) without installing it.**

When a pull request changes a lockfile or a pip requirements file (a Dependabot or Renovate update, or your own), this Action sends the old and new lockfile to [Upgrade X-Ray](https://apify.com/cybernative-ai/upgrade-xray) on Apify and posts the result as one pull-request comment. For every package that changed, the comment shows:

- **new install-time code**: new `preinstall`/`postinstall` scripts, `setup.py` hooks, `.pth` start-up files;
- **new network, shell or eval calls**, and high-risk signs such as obfuscation, credential-file reads, token theft or self-publishing;
- **removed functions** and other API changes;
- **new dependencies**, with their age and whether they share an owner with the package.

Nothing is installed or run, either in your workflow or in the analysis. The Action does not check out the pull request. It reads the two lockfile versions through the GitHub API.

Example reports for two compromised 2025 releases: [`@ctrl/tinycolor` 4.1.1](https://github.com/CyberNative-AI/upgrade-xray/blob/main/examples/ctrl-tinycolor-4.1.1.md) (a self-spreading worm) and [`debug` 4.4.2](https://github.com/CyberNative-AI/upgrade-xray/blob/main/examples/debug-4.4.2.md) (a wallet drainer).

## Setup

1. Create an [Apify](https://apify.com) account and copy your API token (*Settings → API & Integrations*).
2. Add it to the repository as an Actions secret named `APIFY_TOKEN`. For Dependabot pull requests, also add it as a **Dependabot** secret with the same name, because Dependabot runs only receive Dependabot secrets.
3. Add `.github/workflows/upgrade-xray.yml`:

```yaml
name: Upgrade X-Ray
on:
  pull_request:
    paths:
      - '**/package-lock.json'
      - '**/npm-shrinkwrap.json'
      - '**/pnpm-lock.yaml'
      - '**/yarn.lock'
      - '**/bun.lock'
      - '**/uv.lock'
      - '**/poetry.lock'
      - '**/requirements*.txt'
      - '**/requirements/*.txt'
permissions:
  contents: read
  pull-requests: write
jobs:
  xray:
    runs-on: ubuntu-latest
    steps:
      - uses: CyberNative-AI/upgrade-xray-action@v1
        with:
          apify-token: ${{ secrets.APIFY_TOKEN }}
          # pnpm, Yarn 2+, bun, Poetry and most requirements files do not record where packages
          # come from, so those packages are listed but not checked. If this
          # repository installs only from the public npm registry or PyPI,
          # uncomment the next line:
          # assume-public-registry: true
```

Use `pull_request`, not `pull_request_target`. Pull requests from forks then get no secrets and the Action skips them with a notice. With `pull_request_target`, anyone who opens a pull request could start paid runs in your Apify account.

## Cost

The analysis runs in **your** Apify account and is charged there, per event:

| Event | Price |
|---|---|
| Lockfile report (one per changed lockfile) | $0.25 |
| Package diff (`packages` input) | $0.02 per package |

`max-charge-usd` caps each run (default $1) and `max-lockfiles` caps the reports per workflow run (default 3).

## Inputs

| Input | Default | |
|---|---|---|
| `apify-token` | (required) | Your Apify API token, from a secret. |
| `github-token` | `${{ github.token }}` | Reads the lockfiles and posts the comment. Needs `contents: read` and `pull-requests: write`. |
| `lockfiles` | all changed | Only check these lockfile paths (one per line). |
| `max-lockfiles` | `3` | At most this many lockfile reports per workflow run. |
| `assume-public-registry` | `false` | pnpm, Yarn 2 and later, bun, Poetry, requirements files without an `--index-url` line and some npm lockfiles do not record where a package came from. Such entries are listed but not looked up unless you set this to `true`. Leave it off if you use a private registry or mirror. |
| `packages` | | Package mode instead: one update per line, e.g. `npm:axios@1.7.9..1.8.0` or `pypi:requests@2.31.0..2.32.0`. Works on any event. |
| `fail-on` | `never` | Fail the step on `review` (red) or `notice` (yellow or red) verdicts. |
| `comment` | `true` | Set `false` to write only the job summary. |
| `max-charge-usd` | `1` | Maximum charge per Apify run. |
| `timeout-minutes` | `10` | The Apify run gets this as its own timeout, so it ends by itself even if the workflow is cancelled. If it has not finished by then, the Action asks Apify to stop it and reports the lockfile as not analysed, with the run link and whether the stop request worked. |
| `actor` | `cybernative-ai~upgrade-xray` | Only change this if you run your own copy of the Actor. |

**Outputs:** `verdict` (`review`, `notice`, `incomplete`, `clean`, `error` or `skipped`), `report-file` (the markdown report on the runner) and `run-ids`.

## What leaves your repository

- **To Apify (your own account):** the old and new content of each changed lockfile, with user names, passwords and query strings removed from every URL in it. The Action parses each lockfile with the same JSON, YAML and TOML parsers the analysis uses, cleans every key and value, and sends the data re-serialized. A requirements file is sent as its requirement and option lines only, as pip reads them (so a comment continued by a backslash is removed with the line after it), each word cleaned; a file with a line the analysis would not read the same way, or with an option set from an environment variable (`${VAR}`, which pip may expand into another package source), is not sent. Comments and the original formatting are therefore not sent; a requirement longer than 16,384 characters (one with many hashes) is sent as continued lines, as pip-compile writes it. It then parses the result again and checks every value, also with the same URL parser the analysis uses, so unusual URL spellings such as `https:user:token@host` are caught too. A lockfile over 20 MB is skipped. If a lockfile does not parse (this includes a line longer than 16,384 characters in a Yarn 1 `yarn.lock` or a requirements file), or cannot be shown to be clean, it is not sent, and the comment says so. The run's input, log and results stay in your Apify account under your retention settings. The publisher cannot see them unless you share the run.
- **To the public npm registry and PyPI (from the Actor):** names and versions of packages whose lockfile entry shows they come from that registry. Packages from private registries, git or local paths are listed in the report but not looked up, and their names are not sent anywhere.
- **To the pull request:** the report as a comment, visible to everyone who can see the pull request. It contains package names and versions, and the sources of entries that were not looked up. Every `@` in the comment, the job summary and the report file is followed by an invisible zero-width space, so npm scopes such as `@types/node` never notify GitHub users. If you copy a package name from the comment, delete that character. The comment is shortened to fit GitHub's size limit; the job summary has the full report.
- **Which comment is updated:** the Action asks GitHub which account the token belongs to and updates only that account's earlier report. If GitHub does not say, the Action posts a new comment and changes no existing one.

Nothing is sent to the publisher. There is no telemetry.

## Use it from an AI agent

[`skills/review-dependency-update/SKILL.md`](skills/review-dependency-update/SKILL.md) tells coding agents how to review a dependency update with Upgrade X-Ray through the Apify MCP server or API. Install it with:

```sh
npx skills add CyberNative-AI/upgrade-xray-action
```

## Limits

A finding is a change worth reading, not proof of malware, and an empty report does not prove a package is safe. The Actor's README gives the measured hit and false-alarm rates and names the attacks it missed: <https://github.com/CyberNative-AI/upgrade-xray#measured-accuracy>.

## About

The Action has two dependencies, the YAML and TOML parsers `yaml` 2.9.1 and `smol-toml` 1.9.1. They are committed in `node_modules/` exactly as published on npm; `package-lock.json` records their checksums.

Built and maintained by **CyberNative AI LLC**, an AI-run company. The Action, the analysis and this README were written by AI agents. Report problems as issues on this repository, using public packages or synthetic lockfiles only. Never post tokens, private lockfiles or Apify run links. Apache License 2.0.
