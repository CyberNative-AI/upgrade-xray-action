import test from 'node:test';
import assert from 'node:assert/strict';
import { run, apifyBase } from '../src/main.js';
import { MARKER, COMMENT_LIMIT } from '../src/markdown.js';
import { fakeServer, stepEnv, captureStdout, TOKEN, GH_TOKEN, PR } from './fake.js';

const LOCK_BEFORE = JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/@solana/web3.js': { version: '1.95.6', resolved: 'https://registry.npmjs.org/@solana/web3.js/-/web3.js-1.95.6.tgz' }, 'node_modules/priv': { version: '1.0.0', resolved: 'https://deploy:s3cretpass@npm.example.com/priv/-/priv-1.0.0.tgz?X-Amz-Signature=abcdef' } } });
const LOCK_AFTER = LOCK_BEFORE.replace(/1\.95\.6/g, '1.95.7');
const lockfilePr = (extra = {}) => ({
    prFiles: [
        { filename: 'README.md', status: 'modified' },
        { filename: 'web/package-lock.json', status: 'modified' },
        { filename: 'svc/uv.lock', status: 'added' },
    ],
    files: { 'acme/app@BASESHA:web/package-lock.json': LOCK_BEFORE, 'acme/app@HEADSHA:web/package-lock.json': LOCK_AFTER },
    ...extra,
});

async function go(cfg, inputs, opts) {
    const srv = await fakeServer(cfg);
    const step = stepEnv(srv.base, inputs, opts);
    const out = captureStdout();
    try {
        const code = await run(step.env, out.stream);
        return { code, st: srv.st, stdout: out.text(), outputs: step.outputs(), summary: step.summary() };
    } finally { await srv.close(); }
}

test('lockfile PR: one Apify run with redacted lockfiles, one comment, outputs set', async () => {
    const r = await go(lockfilePr());
    assert.equal(r.code, 0);
    const start = r.st.requests.find((q) => q.method === 'POST' && q.path.startsWith('/v2/acts/'));
    assert.equal(start.path, '/v2/acts/cybernative-ai~upgrade-xray/runs');
    assert.equal(start.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(start.query.maxTotalChargeUsd, '1');
    const input = JSON.parse(start.body);
    assert.equal(input.lockfileName, 'package-lock.json');
    assert.equal(input.assumePublicRegistry, false);
    for (const k of ['lockfileBefore', 'lockfileAfter']) {
        assert.ok(!input[k].includes('s3cretpass') && !input[k].includes('X-Amz-Signature'), `${k} still carries credentials`);
        assert.match(input[k], /https:\/\/npm\.example\.com\/priv\/-\/priv-1\.0\.0\.tgz"/);
        assert.match(input[k], /registry\.npmjs\.org\/@solana\/web3\.js/);
    }
    assert.match(input.lockfileAfter, /1\.95\.7/);
    // GitHub reads used the GitHub token, never the Apify token.
    for (const q of r.st.requests.filter((x) => !x.path.startsWith('/v2/'))) assert.equal(q.headers.authorization, `Bearer ${GH_TOKEN}`);
    assert.equal(r.st.comments.length, 1);
    const body = r.st.comments[0].body;
    assert.ok(body.startsWith(MARKER));
    assert.match(body, /\*\*`web\/package-lock\.json`\*\*/);
    assert.match(body, /`@solana\/web3\.js`/);
    assert.doesNotMatch(body, /[^`]@solana/);
    assert.match(body, /`svc\/uv\.lock` is new in this pull request/);
    assert.match(body, /Report by \[Upgrade X-Ray\]\(https:\/\/apify\.com\/cybernative-ai\/upgrade-xray\)/);
    assert.match(body, /\[Full report\]\(https:\/\/github\.com\/acme\/app\/actions\/runs\/42\)/);
    assert.equal(r.outputs.verdict, 'review');
    assert.equal(r.outputs['run-ids'], 'RUN1');
    assert.match(r.summary, /REVIEW BEFORE MERGE/);
    // The token appears in the log only in the mask command.
    assert.equal(r.stdout.split(TOKEN).length - 1, 1);
    assert.match(r.stdout, new RegExp(`::add-mask::${TOKEN}`));
});

test('fail-on review fails the step on a review verdict; notice level does not fail on clean', async () => {
    assert.equal((await go(lockfilePr(), { 'INPUT_FAIL-ON': 'review' })).code, 1);
    assert.equal((await go(lockfilePr({ output: { verdict: 'clean' } }), { 'INPUT_FAIL-ON': 'notice' })).code, 0);
    assert.equal((await go(lockfilePr({ output: { verdict: 'notice' } }), { 'INPUT_FAIL-ON': 'notice' })).code, 1);
});

test('a second run updates its own comment and leaves a look-alike from someone else alone', async () => {
    const comments = [
        { id: 1, user: { login: 'mallory' }, body: `${MARKER}\nnot ours` },
        { id: 2, user: { login: 'github-actions[bot]' }, body: `${MARKER}\nold report` },
    ];
    const r = await go(lockfilePr({ comments }));
    assert.equal(r.st.comments.length, 2);
    assert.equal(r.st.comments[0].body, `${MARKER}\nnot ours`);
    assert.match(r.st.comments[1].body, /REVIEW BEFORE MERGE/);
    assert.ok(r.st.requests.some((q) => q.method === 'PATCH' && q.path === '/repos/acme/app/issues/comments/2'));
});

test('with a personal token the comment owner is the token user', async () => {
    const comments = [{ id: 5, user: { login: 'github-actions[bot]' }, body: `${MARKER}\nbot` }, { id: 6, user: { login: 'dev1' }, body: `${MARKER}\nmine` }];
    const r = await go(lockfilePr({ comments, userLogin: 'dev1' }));
    assert.ok(r.st.requests.some((q) => q.method === 'PATCH' && q.path === '/repos/acme/app/issues/comments/6'));
    assert.equal(r.st.comments[0].body, `${MARKER}\nbot`);
});

test('fork pull request without secrets: skipped with a notice, no API calls', async () => {
    const fork = { ...PR, head: { sha: 'HEADSHA', repo: { full_name: 'someone/app' } } };
    const r = await go(lockfilePr(), { 'INPUT_APIFY-TOKEN': '' }, { event: { pull_request: fork } });
    assert.equal(r.code, 0);
    assert.equal(r.st.requests.length, 0);
    assert.match(r.stdout, /::notice::No Apify token: workflows triggered by pull requests from forks/);
    assert.equal(r.outputs.verdict, 'skipped');
});

test('fork pull request with secrets reads the new lockfile from the fork', async () => {
    const fork = { ...PR, head: { sha: 'HEADSHA', repo: { full_name: 'someone/app' } } };
    const r = await go(lockfilePr({ files: { 'acme/app@BASESHA:web/package-lock.json': LOCK_BEFORE, 'someone/app@HEADSHA:web/package-lock.json': LOCK_AFTER } }), {}, { event: { pull_request: fork } });
    assert.equal(r.outputs.verdict, 'review');
    assert.ok(r.st.requests.some((q) => q.path === '/repos/someone/app/contents/web/package-lock.json'));
});

test('no lockfile changed: no Apify run, verdict skipped', async () => {
    const r = await go({ prFiles: [{ filename: 'src/a.js', status: 'modified' }] });
    assert.equal(r.st.posts, 0);
    assert.equal(r.outputs.verdict, 'skipped');
    assert.equal(r.st.comments.length, 0);
});

test('a lockfile listed as changed but identical at both commits starts no run', async () => {
    const r = await go(lockfilePr({ files: { 'acme/app@BASESHA:web/package-lock.json': LOCK_BEFORE, 'acme/app@HEADSHA:web/package-lock.json': LOCK_BEFORE } }));
    assert.equal(r.st.posts, 0);
    assert.equal(r.outputs.verdict, 'skipped');
});

test('package mode on a push event: one run, summary only', async () => {
    const r = await go({ report: '## Upgrade X-Ray\n\n**Overall: 🟢 Nothing new found in any change**\n', output: { verdict: 'clean' } }, { INPUT_PACKAGES: 'npm:chalk@5.6.0..5.6.1\n\npypi:requests@2.31.0..2.32.0\n' }, { event: { ref: 'refs/heads/main' } });
    assert.equal(r.code, 0);
    const start = r.st.requests.find((q) => q.path.startsWith('/v2/acts/'));
    assert.deepEqual(JSON.parse(start.body), { packages: ['npm:chalk@5.6.0..5.6.1', 'pypi:requests@2.31.0..2.32.0'] });
    assert.equal(r.st.requests.filter((q) => !q.path.startsWith('/v2/')).length, 0);
    assert.equal(r.outputs.verdict, 'clean');
    assert.match(r.summary, /Nothing new found/);
});

test('a run that does not finish in time is aborted and reported as not analysed', async () => {
    const r = await go(lockfilePr({ pollsUntilDone: 1e9 }), { 'INPUT_TIMEOUT-MINUTES': '0.0002', UPGRADE_XRAY_POLL_MS: '5' });
    assert.equal(r.st.aborted, true);
    assert.equal(r.outputs.verdict, 'error');
    assert.match(r.st.comments[0].body, /ended with status TIMED-OUT/);
});

test('a failed start is not retried (no double charge) and is reported', async () => {
    const r = await go(lockfilePr({ startStatus: 500 }));
    assert.equal(r.st.posts, 1);
    assert.equal(r.outputs.verdict, 'error');
    assert.match(r.st.comments[0].body, /could not be started/);
});

test('a huge report is shortened to fit a GitHub comment, with details blocks closed', async () => {
    const big = `## Upgrade X-Ray\n\n<details><summary>x</summary>\n\n${'- @scope/pkg 1.0.0 → 1.0.1 line\n'.repeat(5000)}</details>\n`;
    const r = await go(lockfilePr({ report: big }));
    const body = r.st.comments[0].body;
    assert.ok(body.length <= 65536 && body.length <= COMMENT_LIMIT + 1000, `comment is ${body.length} chars`);
    assert.equal((body.match(/<details>/g) || []).length, (body.match(/<\/details>/g) || []).length);
    assert.match(body, /report shortened here/);
    assert.ok(r.summary.length > body.length, 'job summary keeps the full report');
});

test('comment permission missing: warning, report still in summary, step not failed', async () => {
    const r = await go(lockfilePr({ commentStatus: 403 }));
    assert.equal(r.code, 0);
    assert.match(r.stdout, /::warning::Could not post the pull-request comment/);
    assert.match(r.summary, /REVIEW BEFORE MERGE/);
});

test('bad inputs are refused before any request', async () => {
    for (const inputs of [{ 'INPUT_MAX-CHARGE-USD': '0' }, { 'INPUT_FAIL-ON': 'always' }]) {
        const r = await go(lockfilePr(), inputs);
        assert.equal(r.code, 1);
        assert.equal(r.st.requests.length, 0);
    }
    const r = await go(lockfilePr(), { INPUT_ACTOR: '../../v2/users/me' });
    assert.equal(r.st.posts, 0);
    assert.equal(r.outputs.verdict, 'error');
});

test('the Apify API base can only be redirected to loopback', () => {
    assert.equal(apifyBase({ UPGRADE_XRAY_APIFY_API: 'http://127.0.0.1:8080' }), 'http://127.0.0.1:8080');
    for (const v of [undefined, 'http://evil.example.com:80', 'https://127.0.0.1:1', 'http://127.0.0.1:1@evil.example', 'http://127.0.0.1:1/x']) {
        assert.equal(apifyBase({ UPGRADE_XRAY_APIFY_API: v }), 'https://api.apify.com', String(v));
    }
});
