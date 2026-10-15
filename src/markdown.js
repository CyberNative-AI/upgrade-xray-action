// The pull-request comment: one section per report, a size limit and a link to the tool.

export const MARKER = '<!-- upgrade-xray-action -->';
export const COMMENT_LIMIT = 60_000; // GitHub rejects comment bodies above 65,536 characters

// Mention-like tokens outside code spans go into code spans, so "@scope/pkg" never notifies anyone.
const MENTION = /(^|[^\w`@/])@([A-Za-z0-9][\w.-]*(?:\/[\w.-]+)?)/g;
export function quoteMentions(md) {
    return md.split(/(`[^`\n]*`)/).map((part, i) => (i % 2 ? part : part.replace(MENTION, '$1`@$2`'))).join('');
}

const RANK = { review: 5, notice: 4, error: 3, incomplete: 2, clean: 1, skipped: 0 };
export function worstVerdict(verdicts) {
    return verdicts.reduce((w, v) => ((RANK[v] ?? 3) > (RANK[w] ?? 0) ? v : w), 'skipped');
}

export function storeUrl(actor) {
    return `https://apify.com/${actor.replace('~', '/')}`;
}

/**
 * sections: [{title, markdown}] in order. Each section is cut down evenly when the comment would
 * be too long; the job summary keeps the full text.
 */
export function composeComment(sections, { notes = [], actor, summaryUrl } = {}) {
    const footer = `<sub>Report by [Upgrade X-Ray](${storeUrl(actor)}): static analysis of the published files; nothing was installed or run.${summaryUrl ? ` [Full report](${summaryUrl}).` : ''}</sub>`;
    const head = [MARKER, ...notes.map((n) => `> ${n}`), notes.length ? '' : null].filter((x) => x !== null).join('\n');
    const parts = sections.map((s) => quoteMentions(s.title ? `**${s.title}**\n\n${s.markdown}` : s.markdown));
    const fixed = head.length + footer.length + 200;
    const budget = Math.floor((COMMENT_LIMIT - fixed) / Math.max(parts.length, 1));
    const body = parts.map((p) => (p.length <= budget ? p : `${cutAtLine(p, budget)}\n\n_…report shortened here; the full report is in the job summary._`));
    return quoteMentions(`${head}\n${body.join('\n\n---\n\n')}\n\n${footer}\n`);
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
