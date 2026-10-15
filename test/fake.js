// One loopback server that plays both the GitHub REST API and the Apify API, and records requests.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TOKEN = 'apify_api_SECRETtoken123';
export const GH_TOKEN = 'ghs_githubSECRET456';

export async function fakeServer(cfg = {}) {
    const st = {
        requests: [], comments: cfg.comments ? [...cfg.comments] : [], runPolls: 0, aborted: false, posts: 0,
        files: cfg.files || {}, // "repo@sha:path" -> text
        prFiles: cfg.prFiles || [],
        report: cfg.report ?? '## Upgrade X-Ray — lockfile report\n\n**Overall: 🔴 Review before merge**\n\n### 🔴 REVIEW BEFORE MERGE — @solana/web3.js 1.95.6 → 1.95.7 (npm)\n',
        output: cfg.output ?? { verdict: 'review' },
        pollsUntilDone: cfg.pollsUntilDone ?? 1,
        startStatus: cfg.startStatus ?? 200,
        aborts: 0,
    };
    const server = http.createServer(async (req, res) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = Buffer.concat(chunks).toString();
        const url = new URL(req.url, 'http://x');
        st.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
        const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
        let m;
        // GitHub
        if ((m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/files$/))) {
            const page = Number(url.searchParams.get('page'));
            return json(200, st.prFiles.slice((page - 1) * 100, page * 100));
        }
        if ((m = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/contents\/(.+)$/))) {
            const key = `${m[1]}@${url.searchParams.get('ref')}:${decodeURIComponent(m[2])}`;
            if (!(key in st.files)) return json(404, { message: 'Not Found' });
            res.writeHead(200, { 'content-type': 'application/vnd.github.raw' });
            return res.end(st.files[key]);
        }
        if (url.pathname === '/user') return cfg.userLogin ? json(200, { login: cfg.userLogin }) : json(403, { message: 'Resource not accessible by integration' });
        // An installation token can ask GraphQL who it is; viewerLogin: null plays a token that cannot.
        if (url.pathname === '/graphql' && req.method === 'POST') {
            const login = cfg.userLogin || (cfg.viewerLogin === undefined ? 'github-actions[bot]' : cfg.viewerLogin);
            return login ? json(200, { data: { viewer: { login } } }) : json(403, { message: 'Resource not accessible by integration' });
        }
        if ((m = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/))) {
            if (req.method === 'GET') return json(200, Number(url.searchParams.get('page')) === 1 ? st.comments : []);
            if (cfg.commentStatus) return json(cfg.commentStatus, { message: 'Resource not accessible by integration' });
            const c = { id: 1000 + st.comments.length, user: { login: cfg.userLogin || cfg.postAs || 'github-actions[bot]' }, body: JSON.parse(body).body };
            st.comments.push(c);
            return json(201, c);
        }
        if ((m = url.pathname.match(/^\/repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)$/)) && req.method === 'PATCH') {
            const c = st.comments.find((x) => String(x.id) === m[1]);
            c.body = JSON.parse(body).body;
            return json(200, c);
        }
        // Apify
        if (url.pathname.match(/^\/v2\/acts\/[^/]+\/runs$/) && req.method === 'POST') {
            st.posts++;
            if (cfg.startDrop) return req.socket.destroy(); // the run may have been created, but the answer is lost
            if (st.startStatus !== 200) return json(st.startStatus, { error: { message: 'boom' } });
            return json(201, { data: { id: 'RUN1', status: 'RUNNING', defaultKeyValueStoreId: 'KV1' } });
        }
        if (url.pathname === '/v2/actor-runs/RUN1') {
            st.runPolls++;
            if (cfg.pollStatus) return json(cfg.pollStatus, { error: { message: 'poll denied' } });
            return json(200, { data: { id: 'RUN1', status: st.runPolls >= st.pollsUntilDone ? 'SUCCEEDED' : 'RUNNING', defaultKeyValueStoreId: 'KV1' } });
        }
        if (url.pathname === '/v2/actor-runs/RUN1/abort') {
            st.aborts++;
            if (cfg.abortStatus) return json(cfg.abortStatus, { error: { message: 'abort denied' } });
            st.aborted = true;
            return json(200, { data: { id: 'RUN1', status: 'ABORTING' } });
        }
        if (cfg.readStatus && url.pathname.startsWith('/v2/key-value-stores/')) return json(cfg.readStatus, { error: { message: 'record denied' } });
        if (url.pathname === '/v2/key-value-stores/KV1/records/REPORT') { res.writeHead(200, { 'content-type': 'text/markdown' }); return res.end(st.report); }
        if (url.pathname === '/v2/key-value-stores/KV1/records/OUTPUT') return json(200, st.output);
        return json(599, { message: `unexpected ${req.method} ${url.pathname}` });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    return { st, base, close: () => new Promise((r) => server.close(r)) };
}

export const PR = {
    number: 7,
    base: { sha: 'BASESHA', repo: { full_name: 'acme/app' } },
    head: { sha: 'HEADSHA', repo: { full_name: 'acme/app' } },
};

/** Environment of a workflow step, with temp files for the event, outputs and summary. */
export function stepEnv(base, inputs = {}, { event = { pull_request: PR } } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xray-action-'));
    const env = {
        GITHUB_API_URL: base, UPGRADE_XRAY_APIFY_API: base,
        GITHUB_EVENT_PATH: path.join(dir, 'event.json'), GITHUB_OUTPUT: path.join(dir, 'out'), GITHUB_STEP_SUMMARY: path.join(dir, 'summary'),
        RUNNER_TEMP: dir, GITHUB_SERVER_URL: 'https://github.com', GITHUB_REPOSITORY: 'acme/app', GITHUB_RUN_ID: '42',
        'INPUT_APIFY-TOKEN': TOKEN, 'INPUT_GITHUB-TOKEN': GH_TOKEN, 'INPUT_MAX-LOCKFILES': '3', 'INPUT_MAX-CHARGE-USD': '1',
        INPUT_COMMENT: 'true', 'INPUT_FAIL-ON': 'never', 'INPUT_TIMEOUT-MINUTES': '10', INPUT_ACTOR: 'cybernative-ai~upgrade-xray',
        ...inputs,
    };
    fs.writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify(event));
    for (const f of [env.GITHUB_OUTPUT, env.GITHUB_STEP_SUMMARY]) fs.writeFileSync(f, '');
    return { env, dir, outputs: () => parseOutputs(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8')), summary: () => fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8') };
}

function parseOutputs(text) {
    const out = {};
    const re = /^([\w-]+)<<(\S+)\n([\s\S]*?)\n\2$/gm;
    let m;
    while ((m = re.exec(text))) out[m[1]] = m[3];
    return out;
}

export function captureStdout() {
    let text = '';
    return { stream: { write: (s) => { text += s; } }, text: () => text };
}
