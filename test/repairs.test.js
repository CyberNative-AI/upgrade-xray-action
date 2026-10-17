// Credential removal per lockfile format, paid-run cleanup, comment size, mentions and comment owner,
// each checked on what is actually sent to Apify or posted to GitHub.
import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/main.js';
import YAML from 'yaml';
import { parse as parseToml } from 'smol-toml';
import { redactLockfile, RedactionError, parserFindsSecret } from '../src/lockfiles.js';
import { composeComment, COMMENT_LIMIT, MARKER } from '../src/markdown.js';
import { fakeServer, stepEnv, captureStdout } from './fake.js';

async function go(cfg, inputs, opts) {
    const srv = await fakeServer(cfg);
    const step = stepEnv(srv.base, inputs, opts);
    const out = captureStdout();
    try {
        const code = await run(step.env, out.stream);
        return { code, st: srv.st, stdout: out.text(), outputs: step.outputs(), summary: step.summary() };
    } finally { await srv.close(); }
}

const prWith = (path, before, after, extra = {}) => ({
    prFiles: [{ filename: path, status: 'modified' }],
    files: { [`acme/app@BASESHA:${path}`]: before, [`acme/app@HEADSHA:${path}`]: after },
    ...extra,
});
const startOf = (st) => st.requests.find((q) => q.method === 'POST' && q.path.startsWith('/v2/acts/'));
// No @ in a comment may be followed by anything but the zero-width space, and no entity may spell one.
const mentionable = (md) => [...(md.match(/@(?!​)/g) || []), ...(md.match(/&(#0*64|#x0*40|commat)/gi) || [])];

// Each fixture spells the URL separators with that format's escapes; the secret words stay literal,
// so their absence from the transmitted bytes proves they were removed.
const SECRETS = ['SECRET', 'SIGNATURE', 'PASSWORD'];
const FORMATS = {
    'package-lock.json': {
        before: String.raw`{"lockfileVersion":3,"packages":{"node_modules/pkg":{"version":"1","resolved":"https:\/\/deploy:SECRET@registry.example\/pkg.tgz?sig=SIGNATURE"},"node_modules/two":{"version":"1","resolved":"https://me:PASS@WORD@registry.example/two.tgz?sig=SIGNATURE"},"node_modules/pub":{"version":"1","resolved":"https://registry.npmjs.org/@scope/pub/-/pub-1.tgz"}}}`,
        kept: ['https://registry.example/pkg.tgz', 'https://registry.example/two.tgz', 'https://registry.npmjs.org/@scope/pub/-/pub-1.tgz'],
    },
    'pnpm-lock.yaml': {
        before: [
            "lockfileVersion: '9.0'",
            'packages:',
            '  pkg@1:',
            '    resolution: {tarball: "https:\\/\\/deploy:SECRET\\x40npm.corp.example/pkg.tgz?sig=SIGNATURE"}',
            '  two@1:',
            '    resolution: {tarball: https://me:PASS@WORD@npm.corp.example/two.tgz?X-Sig=SIGNATURE}',
            '  three@1:',
            "    resolution: {tarball: 'https://deploy:SECRET@npm.corp.example/three.tgz'}",
            '',
        ].join('\n'),
        kept: ['https://npm.corp.example/pkg.tgz', 'https://npm.corp.example/two.tgz', 'https://npm.corp.example/three.tgz'],
    },
    'uv.lock': {
        before: [
            'version = 1',
            '[[package]]',
            'name = "pkg"',
            'version = "1"',
            'source = { registry = "https://__token__:SECRET\\u0040pypi.corp.example/simple" }',
            'sdist = { url = "https://__token__:PASS\\U00000040WORD@pypi.corp.example/pkg-1.tar.gz?Signature=SIGNATURE#sha256=abc" }',
            '',
        ].join('\n'),
        kept: ['https://pypi.corp.example/simple', 'https://pypi.corp.example/pkg-1.tar.gz#sha256=abc'],
    },
    'poetry.lock': {
        before: [
            '[[package]]',
            'name = "pkg"',
            'version = "1"',
            '[package.source]',
            'type = "legacy"',
            'url = "https://deploy:PASS@WORD@pypi.corp.example/simple?token=SIGNATURE"',
            'reference = "corp"',
            '',
        ].join('\n'),
        kept: ['https://pypi.corp.example/simple"'],
    },
};

for (const [name, f] of Object.entries(FORMATS)) {
    test(`${name}: escaped and many-@ credentials never reach Apify, hosts and paths do`, async () => {
        const after = f.before.replace(/version = "1"|"version":"1"|@1:/g, (m) => m.replace('1', '2'));
        const r = await go(prWith(`app/${name}`, f.before, after));
        const start = startOf(r.st);
        assert.ok(start, 'the lockfile was sent');
        for (const s of SECRETS) assert.ok(!start.body.includes(s), `${s} in the start request body`);
        const input = JSON.parse(start.body);
        for (const k of ['lockfileBefore', 'lockfileAfter']) for (const u of f.kept) assert.ok(input[k].includes(u), `${k} keeps ${u}`);
        if (name.endsWith('.json')) assert.equal(JSON.parse(input.lockfileAfter).packages['node_modules/pkg'].version, '2');
    });
}

// Scalars where a URL does not end at whitespace, a quote or a line break: each must reach Apify
// without its secret, checked on the transmitted body. WS is a URL with whitespace in its user info.
const WS = 'https://deploy:before SPACE_SECRET@registry.example/pkg.tgz?sig=SIGNATURE';
const npmLock = (url) => JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/pkg': { version: '1', resolved: url } } });
const pnpm = (scalar) => `lockfileVersion: '9.0'\npackages:\n  pkg@1:\n    resolution:\n      tarball: ${scalar}\n`;
const toml3 = (q) => `version = 1\n[[package]]\nname = "pkg"\nversion = "1"\nsource = { registry = ${q}https://deploy:before\nSPACE_SECRET@registry.example/simple?sig=SIGNATURE${q} }\n`;
const SCALARS = {
    'package-lock.json': [npmLock(WS), npmLock('https://u:a"b\\c\tSECRET@registry.example/x.tgz?x=SIGNATURE')],
    'npm-shrinkwrap.json': [npmLock(WS)],
    'pnpm-lock.yaml': [
        `lockfileVersion: '9.0'\npackages:\n  pkg@1:\n    resolution: {tarball: "${WS}"}\n`,
        pnpm(WS),
        pnpm('https://deploy:before\n        SPACE_SECRET@registry.example/pkg.tgz?sig=SIGNATURE'),
        pnpm('|\n        https://deploy:before SPACE_SECRET@registry.example/pkg.tgz?sig=SIGNATURE'),
        pnpm('>-\n        https://deploy:before\n        SPACE_SECRET@registry.example/pkg.tgz?sig=SIGNATURE'),
        pnpm('"https://deploy:before\n        SPACE_SECRET@registry.example/pkg.tgz?sig=SIGNATURE"'),
        pnpm("'https://deploy:before''SPACE_SECRET@registry.example/pkg.tgz?sig=SIGNATURE'"),
        pnpm('"https://deploy:before\\x20SPACE_SECRET\\u00a0x\\t@registry.example/pkg.tgz?sig=SIGNATURE"'),
        `---\nlockfileVersion: '9.0'\npackages:\n  pnpm@11.0.0:\n    resolution: {tarball: "${WS}"}\n---\nlockfileVersion: '9.0'\npackages:\n  pkg@1:\n    resolution: {integrity: sha512-x}\n`,
        `lockfileVersion: '9.0'\n# https://deploy:SPACE_SECRET@registry.example/?sig=SIGNATURE\npackages:\n  pkg@1:\n    resolution: {integrity: sha512-x} # SECRET\n`,
        `lockfileVersion: '9.0'\n# https://deploy:SPACE_SECRET@registry.example/?sig=SIGNATURE\npackages:\n  'pkg@https://u:SPACE_SECRET@registry.example/p.tgz?sig=SIGNATURE':\n    resolution: {tarball: x} # SPACE_SECRET\n`,
    ],
    'uv.lock': [
        `version = 1\n[[package]]\nname = "pkg"\nversion = "1"\nsource = { registry = "${WS}" }\n`,
        `# https://deploy:SPACE_SECRET@pypi.corp.example/simple?sig=SIGNATURE\nversion = 1\n[[package]]\nname = "pkg"\nversion = "1"\nsource = { registry = "https://pypi.org/simple" } # SECRET\n`,
        toml3('"""'),
        toml3("'''"),
        `version = 1\n[[package]]\nname = "pkg"\nversion = "1"\nsource = { registry = '''https://deploy:before'' SPACE_SECRET@registry.example/simple?sig=SIGNATURE''' }\n# SPACE_SECRET\n`,
    ],
    'poetry.lock': [
        `[[package]]\nname = "pkg"\nversion = "1"\n[package.source]\ntype = "legacy"\nurl = "${WS}"\n`,
        `[[package]]\nname = "pkg"\nversion = "1"\n[package.source]\ntype = "legacy"\nurl = 'https://deploy:before\tSPACE_SECRET@registry.example/simple?sig=SIGNATURE'\n`,
    ],
};

for (const [name, cases] of Object.entries(SCALARS)) {
    test(`${name}: URLs with whitespace, line breaks, block scalars, doubled quotes or comments never send their secret`, async () => {
        for (const before of cases) {
            const after = before.replace(/"1"|pkg@1|tarball: x/, (m) => m.replace(/1|x/, '2'));
            assert.notEqual(after, before);
            const r = await go(prWith(`app/${name}`, before, after));
            const start = startOf(r.st);
            assert.ok(start, `sent: ${before}`);
            assert.equal(r.st.posts, 1);
            for (const s of ['SECRET', 'SIGNATURE', 'deploy']) assert.ok(!start.body.includes(s), `${s} sent for ${before}\n${start.body}`);
        }
    });
}

test('lockfiles that do not parse, or that a cleaned URL would make ambiguous, are not sent, and the comment says so', async () => {
    const cases = {
        'pnpm-lock.yaml': ['packages: {a: "x', /is not valid YAML/],
        'uv.lock': ['source = "https://h/x', /is not valid TOML/],
        'package-lock.json': ['{not json', /is not valid JSON/],
        // Both keys become "a@https://h/p.tgz" once cleaned.
        'npm-shrinkwrap.json': [JSON.stringify({ packages: { 'a@https://u:SECRET@h/p.tgz': {}, 'a@https://h/p.tgz': {} } }), /has two keys that are the same/],
        // A backslash in a URL is never sent, even when the parsed value is clean.
        'poetry.lock': ['url = "https://h/a\\\\SECRET"\n', /could not be removed with certainty/],
    };
    for (const [name, [text, why]] of Object.entries(cases)) {
        assert.throws(() => redactLockfile(text, name), (e) => e instanceof RedactionError && why.test(e.message), name);
        const r = await go(prWith(`app/${name}`, text, `${text}\n`));
        assert.equal(r.st.posts, 0, `${name} was sent`);
        assert.match(r.st.comments[0]?.body ?? r.stdout, new RegExp(`was not sent: it [^.]*${why.source}`));
    }
});

// URL spellings the Actor's parser (WHATWG URL) reads as credentialed URLs although they lack a
// literal "://": a line break inside the scheme, one or no slash, backslashes. Refused, never sent.
const NORM = 'deploy:SECRET@registry.example/p.tgz?sig=SIGNATURE';
const lockWith = (name, url) => (name.endsWith('.json')
    ? JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/pkg': { version: '1', resolved: url } } })
    : name.endsWith('.yaml')
        ? YAML.stringify({ lockfileVersion: '9.0', packages: { 'pkg@1': { resolution: { tarball: url } } } })
        : name.endsWith('.txt')
            ? `-i ${url}\npkg==1\n`
            : `[[package]]\nname = "pkg"\nversion = "1"\n[package.source]\ntype = "legacy"\nurl = ${JSON.stringify(url)}\n`);

test('URL spellings the Actor\'s URL parser accepts without "://" are refused, never sent, in every format', async () => {
    const urls = [`https:\n//${NORM}`, `https\n://${NORM}`, `https:/${NORM}`, `https:${NORM}`, `HTTPS:\\\\${NORM}`,
        `ht\ttps:/\r/${NORM}`, `ws:${NORM}`, `git+https:${NORM}`, `pkg@https:${NORM}`, 'https:registry.example/p.tgz?sig=SIGNATURE',
        `https: //${NORM}`];
    for (const url of urls) {
        for (const name of ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'uv.lock', 'poetry.lock', 'requirements.txt']) {
            const before = lockWith(name, url);
            assert.throws(() => redactLockfile(before, name), RedactionError, `${name}: ${JSON.stringify(url)}`);
            const r = await go(prWith(name, before, before.replace(/"1"|pkg@1|pkg==1/, (m) => m.replace('1', '2'))));
            assert.equal(r.st.posts, 0, `${name} sent: ${JSON.stringify(url)}`);
            for (const q of r.st.requests) for (const w of ['SECRET', 'SIGNATURE']) assert.ok(!(q.body ?? '').includes(w), `${w} left in a request`);
            assert.match(r.st.comments[0]?.body ?? r.stdout, name.endsWith('.txt')
                ? /was not sent: it (has URLs whose user names, passwords or query strings could not be removed with certainty|has a line that is not a requirement, an option spelled in full or a comment)/
                : /was not sent: it has URLs whose user names, passwords or query strings could not be removed with certainty/);
        }
    }
});

test('a requirements file with an option set from an environment variable is never sent, and the comment says why', async () => {
    const file = (v) => `--index-url https://pypi.org/simple?source=\${OPTS}\nreview-private-name==${v}\n`;
    for (const assume of ['false', 'true']) {
        const r = await go(prWith('requirements.txt', file('1.0'), file('1.1')), { 'INPUT_ASSUME-PUBLIC-REGISTRY': assume });
        assert.equal(r.st.posts, 0, `sent with assume-public-registry ${assume}`);
        for (const q of r.st.requests) assert.ok(!(q.body ?? '').includes('review-private-name'), 'name left in a request');
        assert.match(r.st.comments[0]?.body ?? r.stdout, /was not sent: it has an option set from an environment variable/);
    }
});

test('the URL parser check keeps ordinary lockfile values that are not credentialed URLs', () => {
    const fine = ['npm:@scope/p@^1.0.0', 'sha256:ab', 'file:../a@b', 'link:../x', 'workspace:*', 'github:o/r#abc',
        'git+ssh://github.com/o/r.git#abc', 'Q: why? Because it is fast', 'https://registry.npmjs.org/@s/p/-/p-1.tgz#sha512',
        'https://files.pythonhosted.org/packages/ab/x-1-py3-none-any.whl#sha256=ab'];
    for (const v of fine) assert.ok(!parserFindsSecret(v), v);
    for (const v of [`https:${NORM}`, `https:/\n/${NORM}`, 'https:h/x?sig=1', 'wss:u@h', `https: //${NORM}`]) assert.ok(parserFindsSecret(v), v);
});

test('URL checks take linear time, so a crafted lockfile cannot stall the runner', () => {
    for (const unit of ['a.', 'ws:', 'a:', 'https:x/', 'https://h/', 'git+https://a.b/']) {
        const value = unit.repeat(Math.ceil(500_000 / unit.length));
        const t0 = performance.now();
        try { redactLockfile(JSON.stringify({ v: value }), 'package-lock.json'); } catch (e) { assert.ok(e instanceof RedactionError, e); }
        assert.ok(performance.now() - t0 < 1500, `${unit} x ${value.length}: ${performance.now() - t0} ms`);
    }
    // One long run of scheme characters before a single ":" (each "." could start a scheme).
    for (const value of ['a.'.repeat(250_000) + 'a:', 'a.'.repeat(250_000) + 'a:x@y', 'x-'.repeat(250_000) + 'https:h?q', 'a+'.repeat(250_000) + 'a://h@']) {
        const t0 = performance.now();
        parserFindsSecret(value);
        try { redactLockfile(JSON.stringify({ v: value }), 'package-lock.json'); } catch (e) { assert.ok(e instanceof RedactionError, e); }
        assert.ok(performance.now() - t0 < 1500, `${value.slice(-8)} x ${value.length}: ${performance.now() - t0} ms`);
    }
    assert.ok(parserFindsSecret('x-'.repeat(1000) + 'https:u:p@h'));
    // Too many URL starts in one value to parse each: refused, not slowly checked.
    assert.ok(parserFindsSecret(`${'https:h/ '.repeat(65)}@`));
    assert.ok(!parserFindsSecret(`${'https:h/ '.repeat(64)}@`));
    // Without an "@" or "?" no URL can hold user info or a query, so nothing needs parsing.
    assert.ok(!parserFindsSecret('https:h/ '.repeat(65)));
});

test('ordinary public lockfiles keep their meaning', () => {
    const yaml = "lockfileVersion: '9.0'\npackages:\n  '@scope/a@https://codeload.github.com/o/r/tar.gz/abc':\n    resolution: {tarball: https://codeload.github.com/o/r/tar.gz/abc}\n  b@1.0.0:\n    resolution: {integrity: sha512-AA==}\n    engines: {node: '>=18'}\n";
    assert.deepEqual(YAML.parse(redactLockfile(yaml, 'pnpm-lock.yaml')), YAML.parse(yaml));
    const stream = `---\n${yaml}\n---\n${yaml.replace('b@1.0.0', 'c@2.0.0')}`;
    const docs = (t) => YAML.parseAllDocuments(t).map((d) => d.toJS());
    assert.deepEqual(docs(redactLockfile(stream, 'pnpm-lock.yaml')), docs(stream));
    assert.equal(docs(stream).length, 2);
    const toml = 'version = 1\nrevision = 2\n[[package]]\nname = "a"\nversion = "1.0"\nsource = { registry = "https://pypi.org/simple" }\nwheels = [{ url = "https://files.pythonhosted.org/x-1-py3-none-any.whl", hash = "sha256:ab", size = 12 }]\n';
    assert.deepEqual(parseToml(redactLockfile(toml, 'uv.lock')), parseToml(toml));
    const json = npmLock('https://registry.npmjs.org/@scope/pub/-/pub-1.tgz');
    assert.deepEqual(JSON.parse(redactLockfile(json, 'package-lock.json')), JSON.parse(json));
});

test('start request carries Apify\'s own timeout for the requested duration', async () => {
    const r = await go(prWith('package-lock.json', '{"a":1}', '{"a":2}'), { 'INPUT_TIMEOUT-MINUTES': '7' });
    assert.equal(startOf(r.st).query.timeout, '420');
    assert.equal(startOf(r.st).query.maxTotalChargeUsd, '1');
});

test('poll failure: the known run is stopped, its ID and link are reported, not "could not be started"', async () => {
    const r = await go(prWith('package-lock.json', '{"a":1}', '{"a":2}', { pollsUntilDone: 2, pollStatus: 403 }));
    assert.equal(r.st.posts, 1);
    assert.equal(r.st.aborts, 1);
    assert.equal(r.outputs['run-ids'], 'RUN1');
    assert.equal(r.outputs.verdict, 'error');
    const body = r.st.comments[0].body;
    assert.match(body, /lost contact with the run .*poll denied.* while its status was `RUNNING`\. A stop request was sent; Apify reports status `ABORTING`\. \[Run RUN1\]/);
    assert.doesNotMatch(body, /could not be started|TIMED-OUT/);
});

test('timeout with a denied stop: reported as possibly still running, never as a finished TIMED-OUT', async () => {
    const r = await go(prWith('package-lock.json', '{"a":1}', '{"a":2}', { pollsUntilDone: 1e9, abortStatus: 403 }), { 'INPUT_TIMEOUT-MINUTES': '0.0002', UPGRADE_XRAY_POLL_MS: '5' });
    assert.equal(r.st.aborts, 1, 'a 403 refusal is final');
    assert.equal(r.outputs['run-ids'], 'RUN1');
    const body = r.st.comments[0].body;
    assert.match(body, /did not finish within 1 minute\(s\) \(last status `RUNNING`\)\. The stop request failed \(.*abort denied.*\), so the run may still be running; Apify ends it after 1 minute\(s\) at most\. \[Run RUN1\]/);
    assert.doesNotMatch(body, /TIMED-OUT/);
});

test('lost start response: the paid start is not retried and the unknown state is reported', async () => {
    const r = await go(prWith('package-lock.json', '{"a":1}', '{"a":2}', { startDrop: true }));
    assert.equal(r.st.posts, 1);
    assert.equal(r.outputs.verdict, 'error');
    assert.match(r.st.comments[0].body, /the start request failed .*network error.*, so it is not known whether a run started\. It was not retried\. .*ends after 10 minute\(s\) at most/);
});

test('a refused start (4xx) says no run was started', async () => {
    const r = await go(prWith('package-lock.json', '{"a":1}', '{"a":2}', { startStatus: 403 }));
    assert.equal(r.st.posts, 1);
    assert.match(r.st.comments[0].body, /Apify did not start the run .*boom.*\. Nothing was charged for it\./);
});

test('a finished run whose report cannot be read keeps its ID and link', async () => {
    const r = await go(prWith('package-lock.json', '{"a":1}', '{"a":2}', { readStatus: 403 }));
    assert.equal(r.outputs['run-ids'], 'RUN1');
    assert.match(r.st.comments[0].body, /the run finished, but its report could not be read .*record denied.*\[Run RUN1\]/);
});

test('the complete comment stays within the limit with thousands of file notes and many details blocks', async () => {
    // A review probe: one note listing 2,997 long file names.
    const notes = [`not checked ${Array.from({ length: 2997 }, (_, i) => `\`${'d'.repeat(100)}/${i}/package-lock.json\``).join(', ')}`];
    const probe = composeComment([{ title: '', markdown: 'REVIEW' }], { notes, actor: 'cybernative-ai~upgrade-xray' });
    assert.ok(probe.length <= COMMENT_LIMIT, `${probe.length}`);
    assert.match(probe, /REVIEW/);

    // Through the Action: 3,000 changed lockfiles (GitHub's file-list limit), long names, a report of
    // many details blocks full of @-scopes (each one grows by the zero-width space).
    const prFiles = Array.from({ length: 3000 }, (_, i) => ({ filename: `${'p'.repeat(180)}/${i}/package-lock.json`, status: i % 2 ? 'added' : 'modified' }));
    const block = `<details><summary>@s/p</summary>\n\n${'- @scope/pkg @x/y @z/w 1.0.0 → 1.0.1\n'.repeat(40)}\n</details>\n`;
    const report = `## Upgrade X-Ray\n\n${block.repeat(400)}`;
    const files = { [`acme/app@BASESHA:${prFiles[0].filename}`]: '{"a":1}', [`acme/app@HEADSHA:${prFiles[0].filename}`]: '{"a":2}' };
    const r = await go({ prFiles, files, report }, { 'INPUT_MAX-LOCKFILES': '1' });
    const body = r.st.comments[0].body;
    assert.ok(body.length <= COMMENT_LIMIT, `comment is ${body.length} chars`);
    assert.equal((body.match(/<details>/g) || []).length, (body.match(/<\/details>/g) || []).length);
    assert.match(body, /report shortened here/);
    assert.match(body, /more note\(s\) in the job summary|and \d+ more/);
    assert.deepEqual(mentionable(body), []);
    assert.ok(r.summary.length > 1_000_000, 'job summary keeps the full report');
});

test('mentions: unmatched backticks, entities and escapes in a report or file name never leave an @ open', async () => {
    const report = [
        'Could not analyse: malformed archive `@victim',
        '``@a`` ` @b `@c` \\`@d` &#64;e &#x40;f &commat;g &#064h @<!-- -->i [x](y`) @j',
        '<details><summary>@k/l</summary>\n\n```\n@m\n```\n</details>',
    ].join('\n\n');
    const path = 'x`@n/`/package-lock.json';
    const r = await go({ ...prWith(path, '{"a":1}', '{"a":2}'), prFiles: [{ filename: path, status: 'modified' }, { filename: 'q`@o/uv.lock', status: 'added' }], report });
    const body = r.st.comments[0].body;
    assert.deepEqual(mentionable(body), [], body);
    assert.deepEqual(mentionable(r.summary), []);
    assert.match(body, /malformed archive `@​victim/);
});

test('comment owner unknown: a new comment is posted and every existing comment is left unchanged', async () => {
    const comments = [
        { id: 7, user: { login: 'github-actions[bot]' }, body: `${MARKER}\nowned by another integration` },
        { id: 8, user: { login: 'other-app[bot]' }, body: `${MARKER}\nalso not ours` },
    ];
    const r = await go(prWith('package-lock.json', '{"a":1}', '{"a":2}', { comments, viewerLogin: null, postAs: 'custom-app[bot]' }));
    assert.equal(r.st.requests.filter((q) => q.method === 'PATCH').length, 0);
    assert.equal(r.st.comments.length, 3);
    assert.equal(r.st.comments[0].body, `${MARKER}\nowned by another integration`);
    assert.equal(r.st.comments[1].body, `${MARKER}\nalso not ours`);
    assert.match(r.st.comments[2].body, /REVIEW BEFORE MERGE/);
    assert.match(r.stdout, /could not be determined, so a new comment was posted/);
});

test('an installation token is identified through GraphQL and updates only its own comment', async () => {
    const comments = [
        { id: 7, user: { login: 'github-actions[bot]' }, body: `${MARKER}\nnot ours` },
        { id: 8, user: { login: 'custom-app[bot]' }, body: `${MARKER}\nours` },
    ];
    const r = await go(prWith('package-lock.json', '{"a":1}', '{"a":2}', { comments, viewerLogin: 'custom-app[bot]' }));
    const patches = r.st.requests.filter((q) => q.method === 'PATCH');
    assert.deepEqual(patches.map((q) => q.path), ['/repos/acme/app/issues/comments/8']);
    assert.equal(r.st.comments[0].body, `${MARKER}\nnot ours`);
    const gql = r.st.requests.find((q) => q.path === '/graphql');
    assert.equal(gql.headers.authorization, 'Bearer ghs_githubSECRET456');
});

test('non-numeric charge and timeout inputs are refused before any request', async () => {
    for (const inputs of [{ 'INPUT_MAX-CHARGE-USD': 'Infinity' }, { 'INPUT_MAX-CHARGE-USD': 'abc' }, { 'INPUT_TIMEOUT-MINUTES': '0' }, { 'INPUT_TIMEOUT-MINUTES': 'NaN' }]) {
        const r = await go(prWith('package-lock.json', '{"a":1}', '{"a":2}'), inputs);
        assert.equal(r.code, 1, JSON.stringify(inputs));
        assert.equal(r.st.requests.length, 0);
    }
});

test('requirements: long space runs are read in linear time; a line over 16384 characters is refused', () => {
    // A space run that does not end in "#": the comment pattern retried at every space of it.
    const run = ' '.repeat(16000);
    const text = Array.from({ length: 64 }, (_, i) => `p${i}==1${run}; os_name == "posix"`).join('\n');
    const start = process.hrtime.bigint();
    assert.equal(redactLockfile(text, 'requirements.txt').split('\n').filter(Boolean).length, 64);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    assert.ok(ms < 2000, `took ${ms} ms`);
    assert.throws(() => redactLockfile(`p==1${' '.repeat(65536)}; os_name == "posix"\n`, 'requirements.txt'), RedactionError);
    // A requirement with many hashes is many short lines joined into one long line; it is still sent.
    const hashes = Array.from({ length: 300 }, (_, i) => `    --hash=sha256:${String(i).padStart(64, '0')}`).join(' \\\n');
    // It is longer than the Actor's line limit, so it is sent as continued lines that pip joins back.
    const text2 = `numpy==2.0.0 \\\n${hashes}\n`;
    const sent = redactLockfile(text2, 'requirements.txt');
    assert.ok(text2.replace(/\\\n/g, '').length > 16384);
    assert.ok(sent.split('\n').length > 2 && sent.split('\n').every((l) => l.length <= 16384));
    assert.equal(sent.replace(/\\\n/g, ''), text2.replace(/\\\n/g, ''));
    // A space just at the limit: the split before it would make a line one character too long.
    const head = 'numpy==2.0.0 --hash=sha256:';
    const atLimit = `${head.slice(0, 13)}\\\n${head.slice(13)}${'a'.repeat(16383 - head.length)} \\\n--hash=sha256:b\n`;
    assert.equal(redactLockfile(atLimit, 'requirements.txt').replace(/\\\n/g, ''), atLimit.replace(/\\\n/g, ''));
    // pip removes the backslashes at both ends of a continued line (pip 24: "django==1.0.1").
    assert.equal(redactLockfile('django==1.\\\n\\0.\\\n1\n', 'requirements.txt'), 'django==1.0.1\n');
});
