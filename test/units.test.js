import test from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import { parse as parseToml } from 'smol-toml';
import { pickLockfiles, cleanString, unsafeString, redactLockfile, RedactionError } from '../src/lockfiles.js';
import { neutralizeMentions, worstVerdict } from '../src/markdown.js';

test('pickLockfiles: supported names only, renames compare the old path, added files noted, max applied', () => {
    const files = [
        { filename: 'a/package-lock.json', status: 'modified' },
        { filename: 'b/pnpm-lock.yaml', status: 'renamed', previous_filename: 'old/pnpm-lock.yaml' },
        { filename: 'c/uv.lock', status: 'added' },
        { filename: 'd/poetry.lock', status: 'removed' },
        { filename: 'e/Pipfile.lock', status: 'modified' },
        { filename: 'f/npm-shrinkwrap.json', status: 'modified' },
        { filename: 'g/poetry.lock', status: 'modified' },
    ];
    const { checks, notes } = pickLockfiles(files, { max: 3 });
    assert.deepEqual(checks, [
        { path: 'a/package-lock.json', beforePath: 'a/package-lock.json' },
        { path: 'b/pnpm-lock.yaml', beforePath: 'old/pnpm-lock.yaml' },
        { path: 'f/npm-shrinkwrap.json', beforePath: 'f/npm-shrinkwrap.json' },
    ]);
    assert.ok(notes.some((n) => n.includes('`c/uv.lock` is new')));
    assert.ok(notes.some((n) => n.includes('not checked `g/poetry.lock`')));
    const only = pickLockfiles(files, { only: ['g/poetry.lock', 'e/Pipfile.lock'] });
    assert.deepEqual(only.checks.map((c) => c.path), ['g/poetry.lock']);
    assert.ok(only.notes.some((n) => n.includes('`e/Pipfile.lock` is not a supported')));
});

test('redactLockfile strips user info and query strings and keeps host and path', () => {
    const t = [
        "lockfileVersion: '9.0'",
        'packages:',
        '  a@1:',
        '    resolution: {tarball: "https://user:tok@npm.corp.example/x/-/x-1.0.0.tgz?sig=1&exp=2"}',
        '  b@1:',
        '    resolution: {tarball: https://glpat-xyz@gitlab.example.com/api/v4/x.tgz}',
        '  c@1:',
        '    resolution: {repo: "git+ssh://git@github.com/o/r.git#deadbeef"}',
        '  d@1:',
        '    resolution: {integrity: sha512-AAA==, tarball: "https://registry.npmjs.org/a/-/a-1.0.0.tgz"}',
        '',
    ].join('\n');
    const r = redactLockfile(t, 'pnpm-lock.yaml');
    for (const secret of ['tok@', 'sig=1', 'glpat-xyz', 'git@']) assert.ok(!r.includes(secret), secret);
    const p = YAML.parse(r).packages;
    assert.equal(p['a@1'].resolution.tarball, 'https://npm.corp.example/x/-/x-1.0.0.tgz');
    assert.equal(p['b@1'].resolution.tarball, 'https://gitlab.example.com/api/v4/x.tgz');
    assert.equal(p['c@1'].resolution.repo, 'git+ssh://github.com/o/r.git#deadbeef');
    assert.deepEqual(p['d@1'].resolution, { integrity: 'sha512-AAA==', tarball: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz' });
    const u = redactLockfile('url = "https://__token__:pypi-AgEN@pypi.corp.example/simple/x/x-1.0-py3-none-any.whl?Signature=z#sha256=abc"\n', 'uv.lock');
    assert.equal(parseToml(u).url, 'https://pypi.corp.example/simple/x/x-1.0-py3-none-any.whl#sha256=abc');
});

test('cleanString: a URL runs to the end of the decoded string, as for a URL parser', () => {
    assert.equal(cleanString('https://deploy:before SPACE@registry.example/p.tgz?sig=S'), 'https://registry.example/p.tgz');
    assert.equal(cleanString('https://u:a"b\'c\\d@h/p?q#f?g'), 'https://h/p#f');
    assert.equal(cleanString('see https://foo.org/docs and https://u:p@bar.org/x?y=1 too'), 'see https://foo.org/docs and https://bar.org/x');
    assert.equal(cleanString('@scope/a@https://codeload.github.com/o/r/tar.gz/abc'), '@scope/a@https://codeload.github.com/o/r/tar.gz/abc');
    assert.equal(cleanString('no url @ here?'), 'no url @ here?');
    for (const s of ['https://a b@h', 'x https://h/p?q', 'https://h/https://u:p@i/']) assert.ok(unsafeString(s), s);
    assert.ok(!unsafeString('https://registry.npmjs.org/@s/p/-/p-1.tgz#sha512'));
});

test('neutralizeMentions and worstVerdict', () => {
    const z = '\u200B';
    const once = neutralizeMentions('see @a/b, `@c/d`, &#64;e, &#x40;f, &commat;g and x@y.z');
    assert.equal(once, `see @${z}a/b, \`@${z}c/d\`, @${z}e, @${z}f, @${z}g and x@${z}y.z`);
    assert.equal(neutralizeMentions(once), once);
    assert.equal(worstVerdict(['clean', 'incomplete']), 'incomplete');
    assert.equal(worstVerdict(['clean', 'error', 'notice']), 'notice');
    assert.equal(worstVerdict([]), 'skipped');
});

test('pickLockfiles: pip requirements files as Dependabot and Renovate name them', () => {
    const names = ['requirements.txt', 'api/requirements-dev.txt', 'requirements_test.txt', 'requirements/base.txt', 'svc/requirements/prod.txt',
        'notes.txt', 'docs/requirements.md', 'requirements.in', 'my-requirements.txt'];
    const { checks } = pickLockfiles(names.map((filename) => ({ filename, status: 'modified' })), { max: 20 });
    assert.deepEqual(checks.map((c) => c.path), names.slice(0, 5));
});

test('redactLockfile: requirements files lose comments and credentials; pins, hashes and hosts stay', () => {
    const text = [
        '# token for the mirror: s3cr3t-comment',
        '-i https://build:s3cr3t-idx@pypi.corp.example/simple?token=s3cr3t-q',
        '--extra-index-url=https://__token__:s3cr3t-extra@pkgs.example/simple',
        'Django==6.1.2 \\',
        '    --hash=sha256:aaaa \\',
        '    --hash=sha256:bbbb  # pinned',
        'corp-lib @ https://dl:s3cr3t-url@files.corp.example/corp_lib-1.0.whl?sig=s3cr3t-sig',
        '-e git+https://s3cr3t-git@github.com/o/r.git@v1#egg=editable-lib',
        'uvicorn[standard]>=0.30 ; python_version >= "3.10"',
        '',
    ].join('\r\n');
    const out = redactLockfile(text, 'requirements.txt');
    for (const s of ['s3cr3t', 'token=', 'sig=', '#', '\r']) assert.ok(!out.replace('#egg=', '').includes(s), `${s} left in:\n${out}`);
    assert.equal(out, [
        '-i https://pypi.corp.example/simple',
        '--extra-index-url=https://pkgs.example/simple',
        'Django==6.1.2     --hash=sha256:aaaa     --hash=sha256:bbbb',
        'corp-lib @ https://files.corp.example/corp_lib-1.0.whl',
        '-e git+https://github.com/o/r.git@v1#egg=editable-lib',
        'uvicorn[standard]>=0.30 ; python_version >= "3.10"',
        '',
    ].join('\n'));
    assert.throws(() => redactLockfile('django==1\n//deploy:SECRET@h/x\n', 'requirements.txt'), /not a requirement/);
    assert.throws(() => redactLockfile('django==1\npkg @ https://h/a\\SECRET\n', 'requirements.txt'), /not a requirement/);
});

test('redactLockfile: requirements options are cleaned word by word and never dropped', () => {
    const out = redactLockfile('-i https://u:p@pypi.org/simple?t=SECRET --extra-index-url https://private.example/simple\npkg==1\n', 'requirements.txt');
    assert.equal(out, '-i https://pypi.org/simple --extra-index-url https://private.example/simple\npkg==1\n');
});

test('redactLockfile: requirements options pip could read differently refuse the file', () => {
    for (const opt of ['--extra-index-u https://private.example/simple', '--not-a-pip-option x', '-ihttps://private.example/simple',
        '--index-url "https://pypi.org/simple"', '--pre django==1.0', '-e . -i https://pypi.org/simple', 'django==1.0 --extra-index-url https://p.example/s']) {
        assert.throws(() => redactLockfile(`${opt}\npkg==1\n`, 'requirements.txt'), /an option spelled in full/, opt);
    }
});

test('redactLockfile: a requirements option set from an environment variable refuses the file before its URLs are cleaned', () => {
    // pip replaces ${VAR} first, so each of these may add an index the cleaned file would not show.
    for (const opt of ['--index-url https://pypi.org/simple?source=${OPTS}', '--trusted-host https://example.invalid/?source=${OPTS}',
        '--extra-index-url https://${TOKEN}@private.example/simple', '-i https://pypi.org/simple --trusted-host h${OPTS}', '-e git+https://${TOKEN}@github.com/o/r#egg=lib']) {
        assert.throws(() => redactLockfile(`-i https://pypi.org/simple\n${opt}\npkg==1\n`, 'requirements.txt'),
            (e) => e instanceof RedactionError && /set from an environment variable/.test(e.message), opt);
    }
    // A requirement line never changes pip's sources, and a static query is only cleaned.
    assert.equal(redactLockfile('-i https://pypi.org/simple\nlib @ https://h.example/lib.whl?t=${TOKEN}\npkg==1\n', 'requirements.txt'),
        '-i https://pypi.org/simple\nlib @ https://h.example/lib.whl\npkg==1\n');
    assert.equal(redactLockfile('--index-url https://pypi.org/simple?source=STATIC\npkg==1\n', 'requirements.txt'), '--index-url https://pypi.org/simple\npkg==1\n');
});

test('redactLockfile: a comment continued by a backslash removes the next line, as in pip', () => {
    const out = redactLockfile('django==1.0 # private note \\\nCOMMENT_CANARY\nflask==2.0\n# note \\\nrequests==2.0\n', 'requirements.txt');
    assert.equal(out, 'django==1.0\nflask==2.0\nrequests==2.0\n');
    for (const t of ['django==1.0\rCANARY==1\n', 'django==1.0\u2028CANARY==1\n', 'django==1.0\fCANARY==1\n', 'django==1.0\x1f#SECRET\n']) {
        assert.throws(() => redactLockfile(t, 'requirements.txt'), RedactionError, JSON.stringify(t));
    }
});
