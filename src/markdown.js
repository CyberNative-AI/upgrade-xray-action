// The pull-request comment: one section per report, a size limit and a link to the tool.

export const MARKER = '<!-- upgrade-xray-action -->';
export const COMMENT_LIMIT = 60_000; // GitHub rejects comment bodies above 65,536 characters
const MAX_NOTE = 600;
const MAX_NOTES = 4_000;

const ZWSP = '\u200B';

/**
 * npm scopes look like GitHub mentions: "@solana/web3.js" in a comment would notify the "solana"
 * account. The report is Markdown from elsewhere, so code spans cannot be relied on (an unmatched
 * backtick changes which text is code). Instead every "@", including "@" written as an HTML
 * entity, is followed by an invisible zero-width space, which no GitHub mention can contain.
 * Idempotent.
 */
export function neutralizeMentions(md) {
    return md.replace(/&(?:#0*64(?!\d)|#x0*40(?![\da-f])|commat);?/gi, '@').replace(/@(?!\u200B)/g, `@${ZWSP}`);
}

/** A file name or other untrusted value as a code span: no backticks or line breaks inside. */
export const code = (s) => `\`${String(s).replace(/`/g, "'").replace(/\s+/g, ' ').slice(0, 200)}\``;

const RANK = { review: 5, notice: 4, error: 3, incomplete: 2, clean: 1, skipped: 0 };
export function worstVerdict(verdicts) {
    return verdicts.reduce((w, v) => ((RANK[v] ?? 3) > (RANK[w] ?? 0) ? v : w), 'skipped');
}

export function storeUrl(actor) {
    return `https://apify.com/${actor.replace('~', '/')}`;
}

function capNotes(notes) {
    const out = [];
    let used = 0;
    for (const [i, n] of notes.entries()) {
        const note = n.length > MAX_NOTE ? `${n.slice(0, MAX_NOTE)}…` : n;
        if (used + note.length > MAX_NOTES) { out.push(`…and ${notes.length - i} more note(s) in the job summary.`); break; }
        out.push(note);
        used += note.length;
    }
    return out;
}

/**
 * sections: [{title, markdown}] in order. Each section is cut down evenly when the comment would
 * be too long; the job summary keeps the full text. The returned string is never longer than
 * COMMENT_LIMIT.
 */
export function composeComment(sections, { notes = [], actor, summaryUrl } = {}) {
    const footer = `<sub>Report by [Upgrade X-Ray](${storeUrl(actor)}): static analysis of the published files; nothing was installed or run.${summaryUrl ? ` [Full report](${summaryUrl}).` : ''}</sub>`;
    const shown = capNotes(notes);
    const head = [MARKER, ...shown.map((n) => `> ${n}`), shown.length ? '' : null].filter((x) => x !== null).join('\n');
    const parts = sections.map((s) => (s.title ? `**${s.title}**\n\n${s.markdown}` : s.markdown));
    const build = (budget) => neutralizeMentions(`${head}\n${parts.map((p) => (p.length <= budget ? p : `${cutAtLine(p, budget)}\n\n_…report shortened here; the full report is in the job summary._`)).join('\n\n---\n\n')}\n\n${footer}\n`);
    // Escaping adds characters, so measure the finished comment and cut further until it fits.
    let budget = Math.floor((COMMENT_LIMIT - head.length - footer.length - 200) / Math.max(parts.length, 1));
    for (; budget >= 500; budget = Math.floor(budget * 0.8)) {
        const body = build(budget);
        if (body.length <= COMMENT_LIMIT) return body;
    }
    return neutralizeMentions(`${MARKER}\nThe report is too long for a pull-request comment; it is in the job summary.\n\n${footer}\n`);
}

function cutAtLine(text, n) {
    const cut = text.slice(0, n);
    const nl = cut.lastIndexOf('\n');
    let out = nl > n / 2 ? cut.slice(0, nl) : cut;
    // Close an open <details> block so the rest of the comment still renders.
    const opened = (out.match(/<details>/g) || []).length - (out.match(/<\/details>/g) || []).length;
    for (let i = 0; i < opened; i++) out += '\n\n</details>';
    return out;
}
