// Which changed files are lockfiles the Actor reads, and what is removed before one is sent.

export const LOCKFILE_NAMES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'uv.lock', 'poetry.lock']);
export const MAX_LOCKFILE_BYTES = 20 * 1024 * 1024; // the Actor's own input limit

const basename = (p) => p.slice(p.lastIndexOf('/') + 1);

/**
 * Changed lockfiles from a pull request's file list ({filename, status, previous_filename}).
 * Returns {checks: [{path, beforePath}], notes: [string]}.
 */
export function pickLockfiles(files, { only = [], max = 3 } = {}) {
    const notes = [];
    const wanted = (f) => (only.length ? only.includes(f.filename) : LOCKFILE_NAMES.has(basename(f.filename)));
    const checks = [];
    for (const f of files) {
        if (!wanted(f)) continue;
        if (only.length && !LOCKFILE_NAMES.has(basename(f.filename))) { notes.push(`\`${f.filename}\` is not a supported lockfile name; skipped.`); continue; }
        if (f.status === 'added') { notes.push(`\`${f.filename}\` is new in this pull request; there is no earlier version to compare.`); continue; }
        if (f.status === 'removed') continue;
        checks.push({ path: f.filename, beforePath: f.status === 'renamed' && f.previous_filename ? f.previous_filename : f.filename });
    }
    if (checks.length > max) {
        notes.push(`${checks.length} lockfiles changed; checked the first ${max} (raise \`max-lockfiles\` to check more): not checked ${checks.slice(max).map((c) => `\`${c.path}\``).join(', ')}.`);
        checks.length = max;
    }
    return { checks, notes };
}

/**
 * Remove credentials that sometimes end up in lockfile URLs: user names/passwords
 * (https://user:token@host/…) and query strings (signed URLs). The host and path stay, so the
 * Actor can still tell which entries come from the public registry.
 */
export function redactLockfile(text) {
    return text
        .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s"'@<>]+@/gi, '$1')
        .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s"'?#<>]+)\?[^\s"'#<>]*/gi, '$1');
}
