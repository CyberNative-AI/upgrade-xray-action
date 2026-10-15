// Start an Upgrade X-Ray run in the user's Apify account, wait for it and read its REPORT and OUTPUT.
import { request } from './http.js';

export const APIFY_API = 'https://api.apify.com';
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED']);
const ACTOR_ID = /^[A-Za-z0-9._-]+~[A-Za-z0-9._-]+$/;

export function apifyClient(token, { base = APIFY_API, sleepMs = 0 } = {}) {
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const call = (path, opts = {}) => request(`${base}${path}`, { headers, ...opts });

    /** Run the Actor and return {runId, status, verdict, report, output, consoleUrl}. Aborts the run on timeout. */
    async function runActor(actor, input, { maxChargeUsd, timeoutMs }) {
        if (!ACTOR_ID.test(actor)) throw new Error(`actor must look like "username~actor-name", got ${JSON.stringify(actor)}`);
        const q = new URLSearchParams({ waitForFinish: '60', maxTotalChargeUsd: String(maxChargeUsd) });
        const deadline = Date.now() + timeoutMs;
        let run = (await call(`/v2/acts/${actor}/runs?${q}`, { method: 'POST', body: input, retries: 0 })).body.data;
        while (!TERMINAL.has(run.status)) {
            if (Date.now() > deadline) {
                await call(`/v2/actor-runs/${run.id}/abort`, { method: 'POST', as: 'none' }).catch(() => {});
                return { runId: run.id, status: 'TIMED-OUT', consoleUrl: consoleUrl(run.id) };
            }
            if (sleepMs) await new Promise((r) => setTimeout(r, sleepMs));
            run = (await call(`/v2/actor-runs/${run.id}?waitForFinish=60`)).body.data;
        }
        const out = { runId: run.id, status: run.status, consoleUrl: consoleUrl(run.id) };
        if (run.status !== 'SUCCEEDED') return out;
        const store = `/v2/key-value-stores/${run.defaultKeyValueStoreId}/records`;
        out.report = (await call(`${store}/REPORT`, { as: 'text' })).body;
        out.output = (await call(`${store}/OUTPUT`)).body;
        out.verdict = out.output?.verdict || 'error';
        return out;
    }
    return { runActor };
}

export const consoleUrl = (runId) => `https://console.apify.com/view/runs/${runId}`;
