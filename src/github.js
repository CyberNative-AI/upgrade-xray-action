// The few GitHub REST calls the Action needs: changed files, file contents at a commit, one comment.
import { request, HttpError } from './http.js';
import { MARKER } from './markdown.js';

export function githubClient(token, { base = 'https://api.github.com' } = {}) {
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'upgrade-xray-action' };
    const call = (path, opts = {}) => request(`${base}${path}`, { ...opts, headers: { ...headers, ...opts.headers } });
    const enc = (p) => p.split('/').map(encodeURIComponent).join('/');

    async function paged(path, maxPages) {
        const all = [];
        for (let page = 1; page <= maxPages; page++) {
            const sep = path.includes('?') ? '&' : '?';
            const { body } = await call(`${path}${sep}per_page=100&page=${page}`);
            all.push(...body);
            if (body.length < 100) break;
        }
        return all;
    }

    return {
        /** Files changed by a pull request (GitHub lists at most 3,000). */
        prFiles: (repo, number) => paged(`/repos/${repo}/pulls/${number}/files`, 30),

        /** Raw file text at a commit, or null when the file does not exist there. */
        async fileAt(repo, path, ref, { maxBytes }) {
            try {
                const { body } = await call(`/repos/${repo}/contents/${enc(path)}?ref=${encodeURIComponent(ref)}`, { as: 'text', headers: { Accept: 'application/vnd.github.raw+json' } });
                if (Buffer.byteLength(body) > maxBytes) return { tooLarge: true };
                return { text: body };
            } catch (e) {
                if (e instanceof HttpError && e.status === 404) return null;
                throw e;
            }
        },

        /** Create the Action's comment, or update the one this token's account posted before. */
        async upsertComment(repo, number, body) {
            let me = 'github-actions[bot]';
            try { me = (await call('/user', { retries: 0 })).body.login; } catch { /* GITHUB_TOKEN cannot read /user */ }
            const comments = await paged(`/repos/${repo}/issues/${number}/comments`, 20);
            const mine = comments.find((c) => c.user?.login === me && c.body?.startsWith(MARKER));
            if (mine) {
                await call(`/repos/${repo}/issues/comments/${mine.id}`, { method: 'PATCH', body: { body } });
                return { id: mine.id, updated: true };
            }
            const { body: created } = await call(`/repos/${repo}/issues/${number}/comments`, { method: 'POST', body: { body } });
            return { id: created.id, updated: false };
        },
    };
}
