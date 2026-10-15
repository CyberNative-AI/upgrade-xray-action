import test from 'node:test';
import assert from 'node:assert/strict';
import { pickLockfiles, redactLockfile } from '../src/lockfiles.js';
import { quoteMentions, worstVerdict } from '../src/markdown.js';

test('pickLockfiles: supported names only, renames compare the old path, added files noted, max applied', () => {
    const files = [
        { filename: 'a/package-lock.json', status: 'modified' },
        { filename: 'b/pnpm-lock.yaml', status: 'renamed', previous_filename: 'old/pnpm-lock.yaml' },
        { filename: 'c/uv.lock', status: 'added' },
        { filename: 'd/poetry.lock', status: 'removed' },
        { filename: 'e/yarn.lock', status: 'modified' },
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
    const only = pickLockfiles(files, { only: ['g/poetry.lock', 'e/yarn.lock'] });
    assert.deepEqual(only.checks.map((c) => c.path), ['g/poetry.lock']);
    assert.ok(only.notes.some((n) => n.includes('`e/yarn.lock` is not a supported')));
});

test('redactLockfile strips user info and query strings and keeps host and path', () => {
    const t = [
        '"resolved": "https://user:tok@npm.corp.example/x/-/x-1.0.0.tgz?sig=1&exp=2",',
        'url = "https://__token__:pypi-AgEN@pypi.corp.example/simple/x/x-1.0-py3-none-any.whl?Signature=z#sha256=abc"',
        "  tarball: https://glpat-xyz@gitlab.example.com/api/v4/x.tgz",
        '"resolved": "git+ssh://git@github.com/o/r.git#deadbeef",',
        '"resolved": "https://registry.npmjs.org/a/-/a-1.0.0.tgz", "integrity": "sha512-AAA=="',
    ].join('\n');
    const r = redactLockfile(t);
    for (const secret of ['tok@', 'sig=1', 'pypi-AgEN', 'Signature=z', 'glpat-xyz', 'git@']) assert.ok(!r.includes(secret), secret);
    assert.match(r, /"https:\/\/npm\.corp\.example\/x\/-\/x-1\.0\.0\.tgz",/);
    assert.match(r, /pypi\.corp\.example\/simple\/x\/x-1\.0-py3-none-any\.whl#sha256=abc"/);
    assert.match(r, /git\+ssh:\/\/github\.com\/o\/r\.git#deadbeef/);
    assert.match(r, /"https:\/\/registry\.npmjs\.org\/a\/-\/a-1\.0\.0\.tgz", "integrity": "sha512-AAA=="/);
});

test('quoteMentions and worstVerdict', () => {
    assert.equal(quoteMentions('see @a/b, `@c/d` and x@y.z'), 'see `@a/b`, `@c/d` and x@y.z');
    assert.equal(worstVerdict(['clean', 'incomplete']), 'incomplete');
    assert.equal(worstVerdict(['clean', 'error', 'notice']), 'notice');
    assert.equal(worstVerdict([]), 'skipped');
});
