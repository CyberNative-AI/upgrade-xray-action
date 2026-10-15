// Upgrade X-Ray GitHub Action. Reads the changed lockfiles of a pull request through the GitHub API
// (nothing from the pull request is checked out or run), sends them to Upgrade X-Ray in the user's
// own Apify account, and posts the report as one pull-request comment plus the job summary.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { apifyClient, APIFY_API } from './apify.js';
import { githubClient } from './github.js';
import { pickLockfiles, redactLockfile, RedactionError, MAX_LOCKFILE_BYTES } from './lockfiles.js';
import { composeComment, neutralizeMentions, code, worstVerdict, storeUrl } from './markdown.js';

const LOOPBACK = /^http:\/\/127\.0\.0\.1:\d+$/;
/** The Apify API base: always api.apify.com, except a loopback server in tests. */
export const apifyBase = (env) => (env.UPGRADE_XRAY_APIFY_API && LOOPBACK.test(env.UPGRADE_XRAY_APIFY_API) ? env.UPGRADE_XRAY_APIFY_API : APIFY_API);

export function readInputs(env) {
    const get = (name) => (env[`INPUT_${name.toUpperCase()}`] ?? '').trim();
    const list = (name) => get(name).split('\n').map((s) => s.trim()).filter(Boolean);
    const bool = (name) => get(name).toLowerCase() === 'true';
    const num = (name, def) => {
        if (get(name) === '') return def;
        const n = Number(get(name));
        if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${get(name)}"`);
        return n;
    };
    const failOn = get('fail-on') || 'never';
    if (!['never', 'review', 'notice'].includes(failOn)) throw new Error(`fail-on must be "never", "review" or "notice", got "${failOn}"`);
    const maxChargeUsd = num('max-charge-usd', 1);
    if (!(maxChargeUsd > 0)) throw new Error('max-charge-usd must be a number above 0');
    const timeoutMinutes = num('timeout-minutes', 10);
    if (!(timeoutMinutes > 0)) throw new Error('timeout-minutes must be a number above 0');
    return {
        apifyToken: get('apify-token'),
        githubToken: get('github-token'),
        packages: list('packages'),
        lockfiles: list('lockfiles'),
        maxLockfiles: Math.max(1, Math.floor(num('max-lockfiles', 3))),
        assumePublicRegistry: bool('assume-public-registry'),
        maxChargeUsd,
        comment: get('comment').toLowerCase() !== 'false',
        failOn,
        timeoutMs: timeoutMinutes * 60_000,
        actor: get('actor') || 'cybernative-ai~upgrade-xray',
    };
}

function makeLog(env, out) {
    const write = (s) => out.write(`${s}\n`);
    const appendFile = (key, text) => { if (env[key]) fs.appendFileSync(env[key], text); };
    return {
        info: write,
        notice: (s) => write(`::notice::${s.replace(/\n/g, '%0A')}`),
        warning: (s) => write(`::warning::${s.replace(/\n/g, '%0A')}`),
        mask: (s) => { if (s) write(`::add-mask::${s}`); },
        output: (name, value) => {
            const delim = `ghadelim_${Math.random().toString(36).slice(2)}`;
            appendFile('GITHUB_OUTPUT', `${name}<<${delim}\n${value}\n${delim}\n`);
        },
        summary: (md) => appendFile('GITHUB_STEP_SUMMARY', `${md}\n`),
    };
}

/** What happened to a run that gave no report, in plain words, with every known run link. */
export function notAnalysed(r) {
    const mins = r.timeoutSecs ? `${Math.ceil(r.timeoutSecs / 60)} minute(s)` : 'its timeout';
    const link = r.consoleUrl ? ` [Run ${r.runId}](${r.consoleUrl}) (in your Apify account).` : '';
    const err = r.error ? ` (${code(r.error)})` : '';
    const stopped = r.stop === 'sent' ? ` A stop request was sent; Apify reports status ${code(r.statusAfterStop)}.`
        : r.stop === 'failed' ? ` The stop request failed${r.stopError ? ` (${code(r.stopError)})` : ''}, so the run may still be running; Apify ends it after ${mins} at most.`
            : '';
    if (r.status === 'NOT-STARTED') return `Apify did not start the run${err}. Nothing was charged for it.`;
    if (r.status === 'START-UNKNOWN') return `the start request failed${err}, so it is not known whether a run started. It was not retried. Check the Actor's runs in your Apify account; a run started by this request ends after ${mins} at most.`;
    if (r.problem === 'timeout') return `the run did not finish within ${mins} (last status ${code(r.status)}).${stopped}${link}`;
    if (r.problem === 'poll-failed') return `the Action lost contact with the run${err} while its status was ${code(r.status)}.${stopped}${link}`;
    if (r.problem === 'read-failed') return `the run finished, but its report could not be read${err}.${link}`;
    return `the run ended with status ${code(r.status)}.${link}`;
}

/** Returns the process exit code. */
export async function run(env = process.env, out = process.stdout) {
    const log = makeLog(env, out);
    let inputs;
    try { inputs = readInputs(env); } catch (e) { log.info(`::error::${e.message}`); return 1; }
    log.mask(inputs.apifyToken);
    const finish = (verdict, { reportMd = '', runIds = [] } = {}) => {
        const file = path.join(env.RUNNER_TEMP || fs.mkdtempSync(path.join(env.TMPDIR || '/tmp', 'xray-')), 'upgrade-xray-report.md');
        fs.writeFileSync(file, reportMd);
        log.output('verdict', verdict);
        log.output('report-file', file);
        log.output('run-ids', runIds.join(','));
        const fail = (inputs.failOn === 'review' && verdict === 'review') || (inputs.failOn === 'notice' && ['review', 'notice'].includes(verdict));
        if (fail) log.info(`::error::Upgrade X-Ray verdict is "${verdict}" (fail-on: ${inputs.failOn}).`);
        return fail ? 1 : 0;
    };

    const event = env.GITHUB_EVENT_PATH && fs.existsSync(env.GITHUB_EVENT_PATH) ? JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) : {};
    const pr = event.pull_request || null;
    if (!inputs.apifyToken) {
        log.notice(pr && pr.head?.repo?.full_name !== pr.base?.repo?.full_name
            ? 'No Apify token: workflows triggered by pull requests from forks do not receive secrets. Skipped.'
            : 'No Apify token: set the apify-token input from a secret (for Dependabot pull requests, add it as a Dependabot secret too). Skipped.');
        return finish('skipped');
    }

    const apify = apifyClient(inputs.apifyToken, { base: apifyBase(env), sleepMs: Number(env.UPGRADE_XRAY_POLL_MS || 0) });
    const ghBase = env.GITHUB_API_URL || 'https://api.github.com';
    const gh = githubClient(inputs.githubToken, { base: ghBase, graphqlUrl: env.GITHUB_GRAPHQL_URL || `${ghBase}/graphql` });

    // Build the list of Actor runs: one package-mode run, or one lockfile report per changed lockfile.
    const jobs = [];
    const notes = [];
    if (inputs.packages.length) {
        jobs.push({ title: '', input: { packages: inputs.packages } });
    } else if (pr) {
        const baseRepo = pr.base.repo.full_name;
        const headRepo = pr.head.repo?.full_name || baseRepo;
        const files = await gh.prFiles(baseRepo, pr.number);
        const picked = pickLockfiles(files, { only: inputs.lockfiles, max: inputs.maxLockfiles });
        notes.push(...picked.notes);
        for (const c of picked.checks) {
            const before = await gh.fileAt(baseRepo, c.beforePath, pr.base.sha, { maxBytes: MAX_LOCKFILE_BYTES });
            const after = await gh.fileAt(headRepo, c.path, pr.head.sha, { maxBytes: MAX_LOCKFILE_BYTES });
            if (!before || !after) { notes.push(`${code(c.path)} could not be read at both commits; skipped.`); continue; }
            if (before.tooLarge || after.tooLarge) { notes.push(`${code(c.path)} is larger than 20 MB; skipped.`); continue; }
            if (before.text === after.text) continue;
            const lockfileName = c.path.slice(c.path.lastIndexOf('/') + 1);
            let lockfileBefore, lockfileAfter;
            try {
                lockfileBefore = redactLockfile(before.text, lockfileName);
                lockfileAfter = redactLockfile(after.text, lockfileName);
            } catch (e) {
                if (!(e instanceof RedactionError)) throw e;
                notes.push(`${code(c.path)} was not sent: ${e.message}.`);
                continue;
            }
            jobs.push({ title: code(c.path), input: { lockfileBefore, lockfileAfter, lockfileName, assumePublicRegistry: inputs.assumePublicRegistry } });
        }
        if (!jobs.length) {
            log.info(`No changed lockfile to check.${notes.length ? ` ${notes.join(' ')}` : ''}`);
            return finish('skipped');
        }
    } else {
        log.notice('Nothing to check: lockfile mode runs on pull_request events; on other events set the packages input.');
        return finish('skipped');
    }

    const sections = [];
    const verdicts = [];
    const runIds = [];
    for (const job of jobs) {
        let r;
        try {
            r = await apify.runActor(inputs.actor, job.input, { maxChargeUsd: inputs.maxChargeUsd, timeoutMs: inputs.timeoutMs });
        } catch (e) {
            r = { status: 'NOT-STARTED', error: e.message };
        }
        if (r.runId) runIds.push(r.runId);
        log.info(`Apify run ${r.runId || '(none)'}: ${r.status}${r.problem ? ` (${r.problem})` : ''}${r.verdict ? `, verdict ${r.verdict}` : ''}`);
        if (r.status !== 'SUCCEEDED' || r.problem || !r.report) {
            const text = notAnalysed(r);
            log.warning(text);
            sections.push({ title: job.title, markdown: `⚪ Not analysed: ${text}` });
            verdicts.push('error');
            continue;
        }
        sections.push({ title: job.title, markdown: r.report });
        verdicts.push(r.verdict);
    }
    const verdict = worstVerdict(verdicts);

    const fullMd = neutralizeMentions([...notes.map((n) => `> ${n}`), ...sections.map((s) => (s.title ? `**${s.title}**\n\n${s.markdown}` : s.markdown))].join('\n\n'));
    log.summary(`${fullMd}\n\n<sub>Report by [Upgrade X-Ray](${storeUrl(inputs.actor)}).</sub>`);
    if (pr && inputs.comment) {
        const summaryUrl = env.GITHUB_SERVER_URL && env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : null;
        try {
            const c = await gh.upsertComment(pr.base.repo.full_name, pr.number, composeComment(sections, { notes, actor: inputs.actor, summaryUrl }));
            log.info(`${c.updated ? 'Updated' : 'Posted'} pull-request comment ${c.id}.`);
            if (c.identityUnknown) log.info('The account behind github-token could not be determined, so a new comment was posted and earlier ones were left unchanged.');
        } catch (e) {
            log.warning(`Could not post the pull-request comment (${e.message}). The workflow needs "permissions: pull-requests: write"; the report is in the job summary.`);
        }
    }
    return finish(verdict, { reportMd: fullMd, runIds });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    run().then((code) => { process.exitCode = code; }, (e) => {
        process.stdout.write(`::error::Upgrade X-Ray: ${e.message}\n`);
        process.exitCode = 1;
    });
}
