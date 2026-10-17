---
name: review-dependency-update
description: Review an npm or PyPI dependency update (Dependabot or Renovate pull request, lockfile change, or "bump X from A to B") by running Upgrade X-Ray on the published files and reading its REPORT. Use before approving or merging a dependency update instead of running `npm diff` or reading tarballs by hand.
---

# Review a dependency update with Upgrade X-Ray

Upgrade X-Ray compares the published npm or PyPI files of the old and new version without installing or running them. It reports new install scripts, new network, shell or eval calls, high-risk indicators (obfuscation, credential reads, token theft, self-publishing), removed functions and new dependencies. It is an Apify Actor (`cybernative-ai/upgrade-xray`) and is paid per call in the user's Apify account: $0.02 per package, $0.25 per lockfile report.

## When to use it

- A pull request changes `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`, `uv.lock`, `poetry.lock` or a pip requirements file (`requirements*.txt`; exact `==` pins are compared).
- Someone asks whether updating a package from version A to B is safe or what it changes.

Ask before the first paid call in a session if the user has not already agreed to Apify charges.

## Call it

**Through the Apify MCP server** (`https://mcp.apify.com`, with the Actor `cybernative-ai/upgrade-xray` added): call the Upgrade X-Ray tool with one of these inputs:

- Package mode: `{"packages": ["npm:axios@1.7.9..1.8.0", "pypi:requests@2.31.0..2.32.0"]}`
- Lockfile mode: `{"lockfileBefore": "<old lockfile text>", "lockfileAfter": "<new lockfile text>"}`. Get the old text with `git show <base>:<path>`.

**Through the API**, with the user's token in `APIFY_TOKEN`:

```sh
curl -sS -X POST "https://api.apify.com/v2/acts/cybernative-ai~upgrade-xray/run-sync?maxTotalChargeUsd=1" \
  -H "Authorization: Bearer $APIFY_TOKEN" -H "Content-Type: application/json" \
  -d '{"packages": ["npm:axios@1.7.9..1.8.0"]}'
```

The response is the run's `OUTPUT`: `verdict`, `complete`, `coverage`, `counts` and `markdown` (the full report).

Before sending a lockfile, remove credentials and signed URLs from it. Never send a lockfile that the user is not allowed to share with their own Apify account. Leave `assumePublicRegistry` off unless the user confirms that every package comes from the public npm registry or PyPI.

## Read the result

- `verdict: "review"` (🔴): do not approve. Quote the findings, with their files and lines, to the user.
- `"notice"` (🟡): read the listed changes and say what they are.
- `"clean"` (🟢): nothing new was found in the files that were analysed in full. Do not call the update safe. Say that this is a static check of the published files.
- `"incomplete"` or `"error"` (⚪): some changes were not analysed. Say which ones (see `coverage`) and do not treat the update as checked.

When you post the report in a pull request, paste `markdown` as it is. It already quotes package scopes so that they do not notify GitHub accounts.
