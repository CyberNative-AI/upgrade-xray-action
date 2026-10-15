// Which changed files are lockfiles the Actor reads, and what is removed before one is sent.
import { code } from './markdown.js';

export const LOCKFILE_NAMES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'uv.lock', 'poetry.lock']);
export const MAX_LOCKFILE_BYTES = 20 * 1024 * 1024; // the Actor's own input limit
const MAX_LISTED = 10;

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
        if (only.length && !LOCKFILE_NAMES.has(basename(f.filename))) { notes.push(`${code(f.filename)} is not a supported lockfile name; skipped.`); continue; }
        if (f.status === 'added') { notes.push(`${code(f.filename)} is new in this pull request; there is no earlier version to compare.`); continue; }
        if (f.status === 'removed') continue;
        checks.push({ path: f.filename, beforePath: f.status === 'renamed' && f.previous_filename ? f.previous_filename : f.filename });
    }
    if (checks.length > max) {
        const rest = checks.slice(max);
        const listed = rest.slice(0, MAX_LISTED).map((c) => code(c.path)).join(', ');
        notes.push(`${checks.length} lockfiles changed; checked the first ${max} (raise \`max-lockfiles\` to check more): not checked ${listed}${rest.length > MAX_LISTED ? ` and ${rest.length - MAX_LISTED} more` : ''}.`);
        checks.length = max;
    }
    return { checks, notes };
}

export class RedactionError extends Error {}

// A URL: scheme, authority (user info and host), path, then an optional query, which is dropped.
const URL_PARTS = /([a-z][a-z0-9+.-]*:\/\/)([^/?#\s"'<>\\]*)([^?#\s"'<>\\]*)(\?[^#\s"'<>\\]*)?/gi;

/** Remove user info (everything up to the last "@" of the authority) and the query from every URL in s. */
function stripUrlSecrets(s) {
    return s.replace(URL_PARTS, (m, scheme, authority, path) => scheme + authority.slice(authority.lastIndexOf('@') + 1) + path);
}

/**
 * Checks the text that is actually sent: every URL must have no user info, no query and no
 * backslash, and may only be followed by a closing quote and flow punctuation. Anything else
 * (unusual escaping or quoting) could hide a credential, so the lockfile is refused.
 */
export function unsafeUrls(text) {
    const bad = [];
    // A scheme followed by an escaped slash is a URL this check cannot read.
    for (const m of text.matchAll(/[a-z][a-z0-9+.-]*:\/?\\/gi)) bad.push(m.index);
    for (const m of text.matchAll(/[a-z][a-z0-9+.-]*:\/\/(\S*)/gi)) {
        const token = m[1];
        const q = token.search(/["']/);
        const url = q < 0 ? token : token.slice(0, q);
        const rest = q < 0 ? '' : token.slice(q);
        const authority = url.split(/[/?#]/, 1)[0];
        if (url.includes('\\') || url.includes('?') || authority.includes('@') || !/^(["'][,:\]}]*)?$/.test(rest)) bad.push(m.index);
    }
    return bad;
}

// YAML and TOML escapes that can spell URL characters. Escaped backslashes are kept as they are.
const ESCAPE = /\\(\\|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|x[0-9a-fA-F]{2}|\/)/g;
function decodeUrlEscapes(text) {
    return text.replace(ESCAPE, (m, e) => {
        if (e === '\\') return m;
        const ch = e === '/' ? '/' : String.fromCodePoint(parseInt(e.slice(1), 16));
        return /^[!#-&(-[\]-~]$/.test(ch) ? ch : m; // printable ASCII except quotes and backslash
    });
}

function mapStrings(v, f) {
    if (typeof v === 'string') return f(v);
    if (Array.isArray(v)) return v.map((x) => mapStrings(x, f));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [f(k), mapStrings(x, f)]));
    return v;
}

/**
 * Remove credentials that sometimes end up in lockfile URLs: user names/passwords
 * (https://user:token@host/…) and query strings (signed URLs). The host and path stay, so the
 * Actor can still tell which entries come from the public registry. JSON lockfiles are parsed
 * and every string is cleaned; YAML and TOML lockfiles are cleaned as text after decoding the
 * escapes that can spell URL characters. Throws RedactionError when the result cannot be shown
 * to be clean.
 */
export function redactLockfile(text, name) {
    let out;
    if (name.endsWith('.json')) {
        let doc;
        try { doc = JSON.parse(text); } catch { throw new RedactionError('it is not valid JSON'); }
        out = `${JSON.stringify(mapStrings(doc, stripUrlSecrets), null, 2)}\n`;
    } else {
        out = stripUrlSecrets(decodeUrlEscapes(text));
    }
    if (unsafeUrls(out).length) throw new RedactionError('it has URLs whose user names, passwords or query strings could not be removed with certainty');
    return out;
}
