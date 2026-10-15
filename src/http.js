// Small fetch wrapper: JSON or text bodies, timeouts, a few retries on 429/5xx and network errors.
// Error messages carry the method, the URL path and the API's own message, never request headers.

export class HttpError extends Error {
    constructor(method, url, status, detail) {
        super(`${method} ${new URL(url).pathname} → ${status}${detail ? `: ${detail}` : ''}`);
        this.status = status;
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function request(url, { method = 'GET', headers = {}, body, as = 'json', timeoutMs = 90_000, retries = 3, retryDelayMs = 2000, okStatuses = [] } = {}) {
    for (let attempt = 0; ; attempt++) {
        let res;
        try {
            res = await fetch(url, {
                method, headers, redirect: 'error',
                body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
                signal: AbortSignal.timeout(timeoutMs),
            });
        } catch (e) {
            if (attempt < retries) { await sleep(retryDelayMs * 2 ** attempt); continue; }
            throw new HttpError(method, url, 'network error', e.cause?.code || e.name);
        }
        if (res.ok || okStatuses.includes(res.status)) {
            if (as === 'text') return { status: res.status, body: await res.text() };
            if (as === 'none') { await res.body?.cancel(); return { status: res.status }; }
            const text = await res.text();
            return { status: res.status, body: text ? JSON.parse(text) : null };
        }
        const text = await res.text().catch(() => '');
        if ((res.status === 429 || res.status >= 500) && attempt < retries) { await sleep(retryDelayMs * 2 ** attempt); continue; }
        let detail = '';
        try { const j = JSON.parse(text); detail = j.error?.message || j.message || ''; } catch { detail = ''; }
        throw new HttpError(method, url, res.status, String(detail).slice(0, 200));
    }
}
