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

const SCHEME_CHAR = /[a-z0-9+.-]/i;
const LETTER = /[a-z]/i;
const AUTHORITY_END = /[/?#]/g;
const WHITESPACE = /\s/g;

/**
 * Every "scheme:" from position `from` on, left to right: for each ":", the first letter of the run
 * of scheme characters just before it, which is where a regular expression's leftmost match would
 * start. Runs never overlap, so this is linear in the string's length; a backtracking expression
 * is quadratic on a crafted value such as "a.a.a.a…" and would stall the runner.
 */
function* schemes(s, from = 0) {
    for (let colon = s.indexOf(':', from); colon >= 0; colon = s.indexOf(':', colon + 1)) {
        let i = colon;
        while (i > from && SCHEME_CHAR.test(s[i - 1])) i--;
        while (i < colon && !LETTER.test(s[i])) i++;
        if (i < colon) yield { start: i, colon };
    }
}

/** The first "scheme://" at or after `from`, or null. */
function nextUrl(s, from) {
    for (const m of schemes(s, from)) if (s.startsWith('//', m.colon + 1)) return m;
    return null;
}

function authorityEnd(s, from) {
    AUTHORITY_END.lastIndex = from;
    const m = AUTHORITY_END.exec(s);
    return m ? m.index : s.length;
}

/**
 * Remove user info and query strings from every URL in one decoded string. As for a URL parser,
 * a URL runs to the end of the string: whitespace, quotes and backslashes do not end it. The
 * authority runs to the first "/", "?" or "#" and loses everything up to its last "@"; every
 * "?" part (the query, and any "?" in the fragment) runs to the next "#" and is dropped.
 */
export function cleanString(s) {
    const first = nextUrl(s, 0);
    if (!first) return s;
    let end = authorityEnd(s, first.colon + 3);
    let auth = s.slice(first.colon + 3, end);
    let out = s.slice(0, first.colon + 3) + auth.slice(auth.lastIndexOf('@') + 1);
    // Everything after the first URL's authority loses its "?" parts, later URLs included.
    const rest = s.slice(end).replace(/\?[^#]*/g, '');
    let pos = 0;
    for (let m = nextUrl(rest, 0); m; m = nextUrl(rest, pos)) {
        end = authorityEnd(rest, m.colon + 3);
        auth = rest.slice(m.colon + 3, end);
        out += rest.slice(pos, m.colon + 3) + auth.slice(auth.lastIndexOf('@') + 1);
        pos = end;
    }
    return out + rest.slice(pos);
}

/** True when a decoded string still has a URL with user info or a query string. */
export function unsafeString(s) {
    const first = nextUrl(s, 0);
    if (!first) return false;
    if (s.includes('?', first.colon + 3)) return true;
    for (let m = first; m; m = nextUrl(s, m.colon + 3)) {
        if (s.slice(m.colon + 3, authorityEnd(s, m.colon + 3)).includes('@')) return true;
    }
    return false;
}

const SPECIAL_SCHEMES = new Set(['http', 'https', 'ws', 'wss', 'ftp', 'file']);
const MAX_SPECIAL_LENGTH = Math.max(...[...SPECIAL_SCHEMES].map((x) => x.length));
const MAX_URL_PARSES = 64; // per string; real lockfile values hold one or two URLs

/**
 * Independent check with the URL parser the Actor itself uses (WHATWG `URL`), which drops tabs
 * and line breaks anywhere and also reads "https:host", "https:/host" and "https:\\host" as
 * "https://host". Every place in the string where such a URL could start (a special scheme, or any
 * scheme followed by "//", also after a "+", "." or "-" as in "git+https:") is parsed the way the
 * Actor would parse it. True when one of them gives user info, or a query (or a "?" in the
 * fragment) on a URL with a host, when a special-scheme URL holding "@" or "?" does not parse, or
 * when the string has too many such places to check.
 */
export function parserFindsSecret(s) {
    const w = s.replace(/[\t\n\r]/g, '');
    // User info needs an "@" and a query a "?": a URL starting after the last of them has neither.
    const last = Math.max(w.lastIndexOf('@'), w.lastIndexOf('?'));
    let parses = 0;
    for (const { start, colon } of schemes(w)) {
        if (colon > last) break;
        for (let i = start; i < colon; i++) {
            if (i > start && !('+.-'.includes(w[i - 1]) && LETTER.test(w[i]))) continue;
            // Only short names can be special, so a long run of scheme characters is not copied.
            const special = colon - i <= MAX_SPECIAL_LENGTH && SPECIAL_SCHEMES.has(w.slice(i, colon).toLowerCase());
            if (!special && !w.startsWith('//', colon + 1)) continue;
            if (++parses > MAX_URL_PARSES) return true;
            const rest = w.slice(i);
            let u;
            try {
                u = new URL(rest);
            } catch {
                if (special && /[@?]/.test(rest)) return true;
                continue;
            }
            if (u.username || u.password || (u.host && (u.search || u.hash.includes('?')))) return true;
        }
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
    let resume = 0;
    for (const { start, colon } of schemes(text)) {
        if (text[colon + 1] === '\\' || (text[colon + 1] === '/' && text[colon + 2] === '\\')) bad.push(start);
        if (start < resume || !text.startsWith('//', colon + 1)) continue;
        WHITESPACE.lastIndex = colon + 3;
        resume = WHITESPACE.exec(text)?.index ?? text.length;
        const token = text.slice(colon + 3, resume);
        const q = token.search(/["']/);
        const url = q < 0 ? token : token.slice(0, q);
        const rest = q < 0 ? '' : token.slice(q);
        const authority = url.split(/[/?#]/, 1)[0];
        if (url.includes('\\') || url.includes('?') || authority.includes('@') || !/^(["'][,:\]}]*)?$/.test(rest)) bad.push(start);
    }
    return bad;
}

/**
 * Remove credentials that sometimes end up in lockfile URLs: user names/passwords
 * (https://user:token@host/…) and query strings (signed URLs). The lockfile is parsed with the
 * Actor's parser, every key and string is cleaned, and the data is sent re-serialized, so
 * comments and the original quoting and escapes are not sent. The result is parsed again and
 * every string checked, also with the Actor's own URL parser, so URL spellings the cleaner does
 * not recognize are refused. Throws RedactionError when the lockfile does not parse or the result
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
    if (someString(check, (x) => unsafeString(x) || parserFindsSecret(x)) || unsafeUrls(out).length) throw new RedactionError('it has URLs whose user names, passwords or query strings could not be removed with certainty');
    if (Buffer.byteLength(out) > MAX_LOCKFILE_BYTES) throw new RedactionError('it is larger than 20 MB once re-serialized');
    return out;
}
