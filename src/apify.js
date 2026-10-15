// Start an Upgrade X-Ray run in the user's Apify account, wait for it and read its REPORT and OUTPUT.
import { request, HttpError } from './http.js';

export const APIFY_API = 'https://api.apify.com';
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED']);
const ACTOR_ID = /^[A-Za-z0-9._-]+~[A-Za-z0-9._-]+$/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function apifyClient(token, { base = APIFY_API, sleepMs = 0, now = Date.now } = {}) {
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const call = (path, opts = {}) => request(`${base}${path}`, { headers, ...opts });

    /** Ask Apify to stop a run. Returns what is known afterwards; never throws. */
    async function stop(runId) {
        try {
            const r = await call(`/v2/actor-runs/${runId}/abort`, { method: 'POST', retries: 1, timeoutMs: 20_000 });
            return { stop: 'sent', statusAfterStop: r.body?.data?.status || 'unknown' };
        } catch (e) {
            return { stop: 'failed', stopError: e.message };
        }
    }

    /**
     * Run the Actor and return {status, runId?, consoleUrl?, verdict?, report?, output?, problem?, error?, stop?}.
     * status is the last status Apify reported, or NOT-STARTED / START-UNKNOWN when there is no run ID.
     * problem is set when the Action stopped waiting: "timeout", "poll-failed" or "read-failed".
     * The run gets Apify's own timeout of timeoutMs, so it ends by itself even if this process cannot stop it.
     * The start request is never retried: a repeated start would be a second paid run.
     */
    async function runActor(actor, input, { maxChargeUsd, timeoutMs }) {
        if (!ACTOR_ID.test(actor)) throw new Error(`actor must look like "username~actor-name", got ${JSON.stringify(actor)}`);
        const timeoutSecs = Math.max(1, Math.ceil(timeoutMs / 1000));
        const q = new URLSearchParams({ timeout: String(timeoutSecs), waitForFinish: String(Math.min(60, timeoutSecs)), maxTotalChargeUsd: String(maxChargeUsd) });
        const deadline = now() + timeoutMs;
        let run;
        try {
            run = (await call(`/v2/acts/${actor}/runs?${q}`, { method: 'POST', body: input, retries: 0, timeoutMs: 90_000 })).body?.data;
        } catch (e) {
            // A 4xx answer means Apify refused the start. A network error, timeout or 5xx may come after the run was created.
            const refused = e instanceof HttpError && typeof e.status === 'number' && e.status < 500;
            return { status: refused ? 'NOT-STARTED' : 'START-UNKNOWN', error: e.message, timeoutSecs };
        }
        if (!run?.id) return { status: 'START-UNKNOWN', error: 'the start response had no run ID', timeoutSecs };
        const known = { runId: run.id, consoleUrl: consoleUrl(run.id), timeoutSecs };
        try {
            while (!TERMINAL.has(run.status)) {
                const left = deadline - now();
                if (left <= 0) return { ...known, status: run.status, problem: 'timeout', ...(await stop(run.id)) };
                if (sleepMs) await sleep(sleepMs);
                const wait = Math.max(1, Math.min(60, Math.ceil(left / 1000)));
                run = { ...run, ...(await call(`/v2/actor-runs/${run.id}?waitForFinish=${wait}`, { retries: 2, timeoutMs: (wait + 20) * 1000 })).body.data };
            }
        } catch (e) {
            return { ...known, status: run.status, problem: 'poll-failed', error: e.message, ...(await stop(run.id)) };
        }
        const out = { ...known, status: run.status };
        if (run.status !== 'SUCCEEDED') return out;
        try {
            const store = `/v2/key-value-stores/${run.defaultKeyValueStoreId}/records`;
            out.report = (await call(`${store}/REPORT`, { as: 'text' })).body;
            out.output = (await call(`${store}/OUTPUT`)).body;
            out.verdict = out.output?.verdict || 'error';
        } catch (e) {
            return { ...known, status: run.status, problem: 'read-failed', error: e.message };
        }
        return out;
    }
    return { runActor };
}

export const consoleUrl = (runId) => `https://console.apify.com/view/runs/${runId}`;
