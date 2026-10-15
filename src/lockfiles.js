// Which changed files are lockfiles the Actor reads, and what is removed before one is sent.
import YAML from 'yaml';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
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

// The same parsers, versions and limits as the Actor, so the strings checked here are the ones
// the Actor reads.
const FORMATS = {
    json: { label: 'JSON', parse: (t) => JSON.parse(t), stringify: (d) => `${JSON.stringify(d, null, 2)}\n` },
    // A YAML stream may hold several documents (pnpm 11 and later write two); each is kept.
    yaml: { label: 'YAML', parse: yamlDocuments, stringify: (docs) => docs.map((d) => `---\n${YAML.stringify(d, { lineWidth: 0 })}`).join('') },
    toml: { label: 'TOML', parse: (t) => parseToml(t), stringify: (d) => stringifyToml(d) },
};
function yamlDocuments(text) {
    const docs = YAML.parseAllDocuments(text);
    if (!Array.isArray(docs)) return [];
    for (const d of docs) if (d.errors.length) throw d.errors[0];
    return docs.map((d) => d.toJS({ maxAliasCount: 10000 }));
}
const formatOf = (name) => FORMATS[name.endsWith('.json') ? 'json' : name.endsWith('.yaml') ? 'yaml' : 'toml'];

const SCHEME = /[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Remove user info and query strings from every URL in one decoded string. As for a URL parser,
 * a URL runs to the end of the string: whitespace, quotes and backslashes do not end it. The
 * authority runs to the first "/", "?" or "#" and loses everything up to its last "@"; every
 * "?" part (the query, and any "?" in the fragment) runs to the next "#" and is dropped.
 */
export function cleanString(s) {
    const m = SCHEME.exec(s);
    if (!m) return s;
    const head = s.slice(0, m.index + m[0].length);
    const tail = s.slice(head.length);
    const end = tail.search(/[/?#]/);
    const authority = end < 0 ? tail : tail.slice(0, end);
    const rest = end < 0 ? '' : tail.slice(end).replace(/\?[^#]*/g, '');
    return head + authority.slice(authority.lastIndexOf('@') + 1) + cleanString(rest);
}

/** True when a decoded string still has a URL with user info or a query string. */
export function unsafeString(s) {
    for (let i = s.search(SCHEME); i >= 0; ) {
        const tail = s.slice(i).replace(SCHEME, '');
        const end = tail.search(/[/?#]/);
        if ((end < 0 ? tail : tail.slice(0, end)).includes('@') || tail.includes('?')) return true;
        const next = tail.search(SCHEME);
        i = next < 0 ? -1 : s.length - tail.length + next;
    }
    return false;
}

// Plain objects; the TOML parser makes them without a prototype. Dates are values, not tables.
const isTable = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));

function mapStrings(v, f) {
    if (typeof v === 'string') return f(v);
    if (Array.isArray(v)) return v.map((x) => mapStrings(x, f));
    if (isTable(v)) {
        const out = {};
        for (const [k, x] of Object.entries(v)) {
            const key = f(k);
            if (Object.hasOwn(out, key)) throw new RedactionError('it has two keys that are the same once their URLs are cleaned');
            out[key] = mapStrings(x, f);
        }
        return out;
    }
    return v; // numbers, booleans, null and TOML dates
}

function someString(v, f) {
    if (typeof v === 'string') return f(v);
    if (Array.isArray(v)) return v.some((x) => someString(x, f));
    if (isTable(v)) return Object.entries(v).some(([k, x]) => f(k) || someString(x, f));
    if (v && typeof v === 'object' && !(v instanceof Date)) throw new RedactionError('it has a value of an unexpected type');
    return false;
}

/**
 * Text check of what is sent, as a second line of defence: in the text, no URL may show user info,
 * a query, a backslash, or quoting this check cannot read.
 */
export function unsafeUrls(text) {
    const bad = [];
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

/**
 * Remove credentials that sometimes end up in lockfile URLs: user names/passwords
 * (https://user:token@host/…) and query strings (signed URLs). The lockfile is parsed with the
 * Actor's parser, every key and string is cleaned, and the data is sent re-serialized, so
 * comments and the original quoting and escapes are not sent. The result is parsed again and
 * every string checked. Throws RedactionError when the lockfile does not parse or the result
 * cannot be shown to be clean. Hosts and paths stay, so the Actor can still tell which entries
 * come from the public registry.
 */
export function redactLockfile(text, name) {
    const fmt = formatOf(name);
    let doc;
    try { doc = fmt.parse(text); } catch { throw new RedactionError(`it is not valid ${fmt.label}`); }
    const out = fmt.stringify(mapStrings(doc, cleanString));
    let check;
    try { check = fmt.parse(out); } catch { throw new RedactionError(`it could not be re-serialized as valid ${fmt.label}`); }
    if (someString(check, unsafeString) || unsafeUrls(out).length) throw new RedactionError('it has URLs whose user names, passwords or query strings could not be removed with certainty');
    if (Buffer.byteLength(out) > MAX_LOCKFILE_BYTES) throw new RedactionError('it is larger than 20 MB once re-serialized');
    return out;
}
