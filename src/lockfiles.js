// Which changed files are lockfiles the Actor reads, and what is removed before one is sent.
import YAML from 'yaml';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import { code } from './markdown.js';

const basename = (p) => p.slice(p.lastIndexOf('/') + 1);

export const LOCKFILE_NAMES = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'uv.lock', 'poetry.lock']);
// pip requirements files as Dependabot and Renovate update them: requirements.txt,
// requirements-dev.txt, requirements_test.txt, requirements/base.txt.
const REQUIREMENTS_NAME = /^requirements(?:[-_.][\w.-]+)?\.txt$/i;
export const isLockfilePath = (p) => LOCKFILE_NAMES.has(basename(p)) || REQUIREMENTS_NAME.test(basename(p)) || /(^|\/)requirements\/[^/]+\.txt$/i.test(p);
export const MAX_LOCKFILE_BYTES = 20 * 1024 * 1024; // the Actor's own input limit
const MAX_LISTED = 10;


/**
 * Changed lockfiles from a pull request's file list ({filename, status, previous_filename}).
 * Returns {checks: [{path, beforePath}], notes: [string]}.
 */
export function pickLockfiles(files, { only = [], max = 3 } = {}) {
    const notes = [];
    const wanted = (f) => (only.length ? only.includes(f.filename) : isLockfilePath(f.filename) || basename(f.filename) === 'bun.lockb');
    const checks = [];
    for (const f of files) {
        if (!wanted(f)) continue;
        if (only.length && !isLockfilePath(f.filename)) { notes.push(`${code(f.filename)} is not a supported lockfile name; skipped.`); continue; }
        if (f.status === 'added') { notes.push(`${code(f.filename)} is new in this pull request; there is no earlier version to compare.`); continue; }
        if (f.status === 'removed') continue;
        if (basename(f.filename) === 'bun.lockb' && !only.length) {
            if (!files.some((g) => g.filename === `${f.filename.slice(0, -1)}`)) notes.push(`${code(f.filename)} is a binary lockfile and is not read; bun 1.2 and later can write a text \`bun.lock\` instead.`);
            continue;
        }
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
    // pip requirements: the Actor's logical lines (comments removed, continuations joined), one per line.
    // Yarn 1 lockfiles: the Actor's own reader; written back with every key and value quoted.
    yarn: { label: 'Yarn lockfile', parse: parseYarnV1, stringify: stringifyYarnV1 },
    // bun.lock is JSON with trailing commas; it is sent as plain JSON.
    jsonc: { label: 'bun.lock', parse: parseBunText, stringify: (d) => `${JSON.stringify(d, null, 2)}\n` },
    lines: { label: 'requirements file', invalid: 'it has a line that is not a requirement, an option spelled in full or a comment', parse: requirementFile, clean: cleanWords, stringify: (lines) => lines.map((l) => `${continuedLine(l)}\n`).join('') },
};
// The Actor's requirements grammar and line reading, copied from its src/lockfile.js. A line outside
// it is never sent: the Actor would refuse the file anyway, and a line this check cannot read could
// hold a split or unusual credential, or a source the Actor would not see.
// Line breaks other than \n and \r\n, and white space other than space and tab: pip (Python) and
// JavaScript split and trim these differently.
const REQ_ODD_CHAR = /[\0-\x08\x0b\x0c\x0e-\x1f\x7f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]|\r(?!\n)/;

// A physical line longer than this is refused before any pattern reads it. pip-compile writes
// lines of a few hundred characters at most: a requirement with many hashes is continued over
// many short lines.
const REQ_MAX_LINE = 16384;

/**
 * Logical lines, as pip's preprocess makes them: a line ending in a backslash is joined to the
 * next with the backslashes at both of its ends removed, unless it is a comment line; then a
 * comment ("#" at the start or after white space) is removed from the joined line, so a comment
 * continued by a backslash also removes the line after it. Every step is linear in the line's
 * length: a joined line can be as long as the file.
 */
function requirementLines(text) {
    const body = text.replace(/^\ufeff/, '');
    if (REQ_ODD_CHAR.test(body)) throw new Error('requirements file: it has a control character, an unusual line break or an unusual space');
    const joined = [];
    let cur = null;
    for (const line of body.split(/\r?\n/)) {
        if (line.length > REQ_MAX_LINE) throw new Error(`requirements file: it has a line longer than ${REQ_MAX_LINE} characters`);
        const comment = /^\s*#/.test(line);
        if (line.endsWith('\\') && !comment) { cur = (cur ?? '') + trimBackslashes(line); continue; }
        joined.push((cur ?? '') + (comment ? ` ${line}` : line));
        cur = null;
    }
    if (cur !== null) joined.push(cur);
    return joined.map((l) => removeComment(l).trim()).filter(Boolean);
}

// The Actor refuses a line longer than REQ_MAX_LINE, but a joined line can be longer (a requirement
// with many hashes). Such a line is sent split at spaces into continued lines, as pip-compile writes
// it; pip joins them back into the same line. A line with no space to split at is left as it is,
// and the check that parses the result then refuses the file.
function continuedLine(line) {
    const out = [];
    let at = 0;
    while (line.length - at > REQ_MAX_LINE) {
        const cut = line.lastIndexOf(' ', at + REQ_MAX_LINE - 2);
        if (cut <= at) break;
        out.push(`${line.slice(at, cut + 1)}\\`);
        at = cut + 1;
    }
    out.push(line.slice(at));
    return out.join('\n');
}

// line.replace(/^\\+|\\+$/g, ''), without the retry at every backslash of a run inside the line.
function trimBackslashes(line) {
    let a = 0; let b = line.length;
    while (a < b && line[a] === '\\') a++;
    while (b > a && line[b - 1] === '\\') b--;
    return line.slice(a, b);
}

// line.replace(/(^|\s+)#.*$/, ''), which retries at every space of a run: the first "#" at the
// start of the line or after white space ends it, with that white space.
function removeComment(line) {
    for (let i = line.indexOf('#'); i >= 0; i = line.indexOf('#', i + 1)) {
        if (i === 0) return '';
        let j = i;
        while (j > 0 && /\s/.test(line[j - 1])) j--;
        if (j < i) return line.slice(0, j);
    }
    return line;
}

// The options pip reads in a requirements file, spelled in full. pip also takes abbreviations
// (--extra-index-u) and a few other options; a file with one of those is refused.
const REQ_OPTIONS = new Map([
    ['-i', 'index'], ['--index-url', 'index'], ['--extra-index-url', 'extra'], ['-f', 'extra'], ['--find-links', 'extra'],
    ['--no-index', 'no-index'], ['-r', 'include'], ['--requirement', 'include'], ['-c', 'include'], ['--constraint', 'include'],
    ['-e', 'editable'], ['--editable', 'editable'], ['--no-binary', 'other'], ['--only-binary', 'other'],
    ['--trusted-host', 'other'], ['--use-feature', 'other'], ['--pre', 'flag'], ['--prefer-binary', 'flag'], ['--require-hashes', 'flag'],
]);
const REQ_FLAGS = new Set(['no-index', 'flag']);
const REQ_OP = String.raw`(?:===?|~=|!=|<=?|>=?)\s*[^\s;,]+`;
// name [extras] [version specifiers | @ url] [; marker]
const REQ_ARGS = new RegExp(String.raw`^[A-Za-z0-9][A-Za-z0-9._-]*\s*(?:\[[^\]]*\])?\s*(?:${REQ_OP}(?:\s*,\s*${REQ_OP})*|@\s*\S+)?\s*(?:;.*)?$`);

/** Options as [kind, value] pairs; null for anything else (pip splits these with shlex, so quotes and backslashes are refused). */
function requirementOptions(text) {
    if (/["'\\]/.test(text)) return null;
    const tokens = text.split(/[ \t]+/).filter(Boolean);
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
        const eq = tokens[i].startsWith('--') ? tokens[i].indexOf('=') : -1;
        const kind = REQ_OPTIONS.get(eq < 0 ? tokens[i] : tokens[i].slice(0, eq));
        if (!kind) return null;
        if (REQ_FLAGS.has(kind)) { if (eq >= 0) return null; out.push([kind, '']); continue; }
        const value = eq < 0 ? tokens[++i] : tokens[i].slice(eq + 1);
        if (!value) return null;
        out.push([kind, value]);
    }
    return out;
}

/**
 * One logical line: { options } for an option line, { requirement } for a requirement (its
 * --hash options checked and dropped), or null when it is outside this grammar. As in pip, a
 * line's options start at its first space-separated word that starts with "-".
 */
function readRequirementLine(line) {
    if (line.includes('\\')) return null;
    const words = line.split(' ');
    const at = words.findIndex((w) => w.startsWith('-'));
    if (at === 0) {
        const options = requirementOptions(line);
        // pip ignores the other options of an editable line; reading them could make a file public.
        if (!options || (options.length > 1 && options.some(([k]) => k === 'editable'))) return null;
        return { options };
    }
    const requirement = (at < 0 ? words : words.slice(0, at)).join(' ');
    // REQ_ARGS reads a run of white space the same as one space. Its adjacent \s* would otherwise
    // try every way of sharing a long run between them.
    if (!REQ_ARGS.test(requirement.replace(/\s+/g, ' '))) return null;
    if (at > 0) {
        const opts = words.slice(at).join(' ');
        if (/["'\\]/.test(opts)) return null;
        const tokens = opts.split(/[ \t]+/).filter(Boolean);
        for (let i = 0; i < tokens.length; i++) {
            if (/^--hash=\S/.test(tokens[i])) continue;
            if (tokens[i] === '--hash' && tokens[i + 1]) { i++; continue; }
            return null;
        }
    }
    return { requirement };
}

function requirementFile(text) {
    const lines = requirementLines(text);
    const read = lines.map(readRequirementLine);
    if (!read.every(Boolean)) throw new Error('not a requirements line');
    // pip replaces ${VAR} before it splits an option line, so the line may add any index, even in a
    // value pip otherwise ignores. The Actor makes such a file private, but cleaning could remove the
    // ${VAR} with a URL's query or user name, so the file is never sent.
    if (read.some((r, i) => r.options && lines[i].includes('${'))) throw new RedactionError('it has an option set from an environment variable (${...}), which may add a package source');
    return lines;
}
// Each word of a line is cleaned on its own, as pip splits it: a URL's query is removed up to the
// end of its word, never into the options after it.
function cleanWords(line) {
    return line.split(/([ \t]+)/).map((w, i) => (i % 2 ? w : cleanString(w))).join('');
}
// The Actor's Yarn 1 and bun.lock readers, copied from its src/lockfile.js, so what is checked here is
// what the Actor reads. Anything outside them is refused and never sent.
const YARN_BARE = /^[A-Za-z][^\s:,"\\[\]]*/;
const YARN_QUOTED = /^"[^"\\\0-\x1f\x7f]*"/;
// Yarn writes lines of a few hundred characters; a longer line is refused before it is scanned.
const YARN_MAX_LINE = 16384;

function yarnToken(rest) {
    const m = rest.match(YARN_QUOTED) || rest.match(YARN_BARE);
    if (!m) return null;
    const raw = m[0];
    if (raw[0] !== '"' && /^(true|false)/.test(raw)) return raw === 'true' || raw === 'false' ? { value: raw === 'true', len: raw.length } : null;
    return { value: raw[0] === '"' ? raw.slice(1, -1) : raw, len: raw.length };
}

function parseYarnV1(text) {
    if (/\r(?!\n)/.test(text)) throw new Error('yarn.lock: it has a line break this tool does not read');
    const entries = [];
    const stack = [];
    const seenKeys = new Set();
    for (const [i, line0] of text.split(/\r?\n/).entries()) {
        const bad = (why) => new Error(`yarn.lock line ${i + 1}: ${why}`);
        if (line0.length > YARN_MAX_LINE) throw bad(`it is longer than ${YARN_MAX_LINE} characters`);
        // Trailing spaces are dropped by a loop: a regex such as / +$/ retries at every space of a run.
        let end = line0.length;
        while (end > 0 && line0.charCodeAt(end - 1) === 32) end--;
        const line = line0.slice(0, end);
        if (!line || /^ *#/.test(line)) continue;
        const indent = line.match(/^ */)[0].length;
        if (indent % 2 || /^ *\t/.test(line)) throw bad('indentation is not a multiple of two spaces');
        const level = indent / 2;
        if (level > stack.length || level > 4) throw bad('unexpected indentation');
        stack.length = level;
        let rest = line.slice(indent);
        const tokens = [];
        let opens = false;
        for (;;) {
            const t = yarnToken(rest);
            if (!t || typeof t.value !== 'string') throw bad('not a key this tool reads');
            tokens.push(t.value);
            rest = rest.slice(t.len);
            if (rest === ':') { opens = true; break; }
            if (rest.startsWith(', ')) { rest = rest.slice(2); continue; }
            break;
        }
        if (opens) {
            const obj = {};
            if (level === 0) {
                for (const k of tokens) { if (seenKeys.has(k)) throw bad('a key appears twice'); seenKeys.add(k); }
                entries.push({ keys: tokens, fields: obj });
            } else {
                if (tokens.length !== 1) throw bad('a field has more than one name');
                if (Object.hasOwn(stack[level - 1], tokens[0])) throw bad('a field appears twice');
                stack[level - 1][tokens[0]] = obj;
            }
            stack.push(obj);
            continue;
        }
        if (level === 0 || tokens.length !== 1 || !rest.startsWith(' ')) throw bad('not a field this tool reads');
        const v = yarnToken(rest.slice(1));
        if (!v || rest.length !== 1 + v.len) throw bad('not a value this tool reads');
        if (Object.hasOwn(stack[level - 1], tokens[0])) throw bad('a field appears twice');
        stack[level - 1][tokens[0]] = v.value;
    }
    return entries;
}

function stringifyYarnV1(entries) {
    const q = (s) => JSON.stringify(s);
    const fields = (obj, depth) => Object.entries(obj).map(([k, v]) => {
        const pad = '  '.repeat(depth);
        if (typeof v === 'boolean') return `${pad}${q(k)} ${v}\n`;
        if (typeof v === 'string') return `${pad}${q(k)} ${q(v)}\n`;
        return `${pad}${q(k)}:\n${fields(v, depth + 1)}`;
    }).join('');
    return `# yarn lockfile v1\n${entries.map((e) => `\n${e.keys.map(q).join(', ')}:\n${fields(e.fields, 1)}`).join('')}`;
}

// A comment ("/" outside a string) is left in and makes the result invalid JSON, so it is refused.
function parseBunText(text) {
    let out = ''; let inStr = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inStr) {
            out += c;
            if (c === '\\') out += text[++i] ?? '';
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') { inStr = true; out += c; continue; }
        if (c === ',') {
            let j = i + 1;
            while (j < text.length && ' \t\n\r'.includes(text[j])) j++;
            if (text[j] === '}' || text[j] === ']') continue;
        }
        out += c;
    }
    return JSON.parse(out);
}

function yamlDocuments(text) {
    const docs = YAML.parseAllDocuments(text);
    if (!Array.isArray(docs)) return [];
    for (const d of docs) if (d.errors.length) throw d.errors[0];
    return docs.map((d) => d.toJS({ maxAliasCount: 10000 }));
}
// yarn.lock is YAML from Yarn 2 on (it starts with "__metadata:", which Yarn 1 syntax cannot have).
const formatOf = (name, text) => FORMATS[name === 'yarn.lock' ? (/^__metadata:/m.test(text) ? 'yaml' : 'yarn')
    : name === 'bun.lock' ? 'jsonc' : name.endsWith('.json') ? 'json' : name.endsWith('.yaml') ? 'yaml' : name.endsWith('.txt') ? 'lines' : 'toml'];

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
    const fmt = formatOf(name, text);
    let doc;
    try { doc = fmt.parse(text); } catch (e) { throw e instanceof RedactionError ? e : new RedactionError(fmt.invalid || `it is not valid ${fmt.label}`); }
    const out = fmt.stringify(mapStrings(doc, fmt.clean || cleanString));
    let check;
    try { check = fmt.parse(out); } catch { throw new RedactionError(`it could not be re-serialized as valid ${fmt.label}`); }
    if (someString(check, (x) => unsafeString(x) || parserFindsSecret(x)) || unsafeUrls(out).length) throw new RedactionError('it has URLs whose user names, passwords or query strings could not be removed with certainty');
    if (Buffer.byteLength(out) > MAX_LOCKFILE_BYTES) throw new RedactionError('it is larger than 20 MB once re-serialized');
    return out;
}
