#!/usr/bin/env node
/**
 * kaiba — build and deploy your apps from CI or a terminal.
 *
 *   kaiba build  --repo <url> --branch <ref> --image <name> [--tag <t>] [--deploy-service <svc>]
 *   kaiba deploy --service <name> --image <ref>
 *   kaiba status
 *
 * Auth: set KAIBA_API_TOKEN to a scoped deploy token. The hub URL defaults to
 * https://cloud.kaiba.ai and is overridden with KAIBA_HUB_URL or --hub-url.
 */
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { KaibaClient, KaibaApiError } from './client.js';
const DEFAULT_HUB_URL = 'https://cloud.kaiba.ai';
const POLL_INTERVAL_MS = 5000;
const BUILD_TIMEOUT_MS = 30 * 60 * 1000;
// A cold dev-environment can take 5–10 min to spin its cluster from scratch, so
// wait patiently before giving up on readiness, the roll, or a migration.
const CLUSTER_READY_TIMEOUT_MS = 15 * 60 * 1000;
const SERVICE_TIMEOUT_MS = 15 * 60 * 1000;
const JOB_TIMEOUT_MS = 20 * 60 * 1000;
function parseFlags(argv) {
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith('--'))
            continue;
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('--')) {
            flags[key] = true;
        }
        else {
            flags[key] = next;
            i++;
        }
    }
    return flags;
}
function required(flags, name) {
    const v = flags[name];
    if (typeof v !== 'string' || v.length === 0) {
        fail(`Missing required flag --${name}`);
    }
    return v;
}
function fail(message) {
    process.stderr.write(`✗ ${message}\n`);
    process.exit(1);
}
function log(message) {
    process.stdout.write(`${message}\n`);
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function makeClient(flags) {
    const token = process.env.KAIBA_API_TOKEN;
    if (!token)
        fail('KAIBA_API_TOKEN is not set — provide a scoped deploy token');
    // `||` not `??` — the Action passes KAIBA_HUB_URL="" when hub-url is unset, and
    // an empty string must fall through to the default, not become the base URL.
    const flagHub = typeof flags['hub-url'] === 'string' ? flags['hub-url'] : '';
    const hubUrl = flagHub || process.env.KAIBA_HUB_URL || DEFAULT_HUB_URL;
    return new KaibaClient({ hubUrl, token });
}
const TERMINAL_BUILD = new Set(['succeeded', 'failed', 'cancelled']);
const TERMINAL_SERVICE_FAIL = new Set(['ErrImagePull', 'ImagePullBackOff', 'CrashLoopBackOff', 'error', 'failed']);
/** 5xx responses during a poll are infrastructure hiccups, not terminal state. */
function isTransient(status) {
    return status >= 500;
}
async function runBuild(client, flags) {
    const started = await client.startBuild({
        repoUrl: required(flags, 'repo'),
        branch: required(flags, 'branch'),
        imageName: required(flags, 'image'),
        tag: typeof flags['tag'] === 'string' ? flags['tag'] : undefined,
        dockerfilePath: typeof flags['dockerfile'] === 'string' ? flags['dockerfile'] : undefined,
        context: typeof flags['context'] === 'string' ? flags['context'] : undefined,
        gitToken: typeof flags['git-token'] === 'string' ? flags['git-token'] : undefined,
    });
    log(`◐ build ${started.buildId} started → ${started.imageRef}`);
    const deadline = Date.now() + BUILD_TIMEOUT_MS;
    let last = '';
    while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);
        let s;
        try {
            s = await client.getBuild(started.buildId, started.clusterId);
        }
        catch (err) {
            // A transient poll failure (cluster briefly offline, backend blip) must not
            // fail a build that is still running. Only a terminal build status ends it.
            if (err instanceof KaibaApiError && isTransient(err.status))
                continue;
            throw err;
        }
        if (s.status !== last) {
            log(`◐ build ${s.status}`);
            last = s.status;
        }
        if (TERMINAL_BUILD.has(s.status)) {
            if (s.status === 'succeeded') {
                log(`✓ build succeeded → ${started.imageRef}`);
                return started.imageRef;
            }
            const reason = s.deadlineExceeded ? ' (deadline exceeded)' : s.oomKilled ? ' (out of memory)' : '';
            await dumpBuildLogs(client, started.buildId, started.clusterId);
            fail(`build ${s.status}${reason}${s.error ? `: ${s.error}` : ''}`);
        }
    }
    fail('build timed out');
}
async function dumpBuildLogs(client, buildId, clusterId) {
    try {
        const { logs } = await client.getBuildLogs(buildId, clusterId);
        if (logs)
            process.stderr.write(`\n--- build logs ---\n${logs}\n------------------\n`);
    }
    catch {
        // logs are best-effort on failure
    }
}
async function dumpServiceLogs(client, service, kind = 'service') {
    try {
        const { logs } = await client.logs(service, 200, kind);
        if (logs)
            process.stderr.write(`\n--- ${service} logs ---\n${logs}\n${'-'.repeat(service.length + 12)}\n`);
        else
            process.stderr.write(`\n(no logs available for ${service})\n`);
    }
    catch (err) {
        // Say WHY logs are missing (e.g. cluster offline) rather than swallowing it.
        const reason = err instanceof KaibaApiError ? err.message : (err instanceof Error ? err.message : String(err));
        process.stderr.write(`\n(could not fetch ${service} logs: ${reason})\n`);
    }
}
/**
 * Wait for the environment's cluster to be ready. A stopped env is woken by the
 * status call; a cold cluster can take 5–10 min to provision, so this is patient
 * and reports progress instead of wedging silently.
 */
async function waitForEnvReady(client) {
    const deadline = Date.now() + CLUSTER_READY_TIMEOUT_MS;
    let last = '';
    while (Date.now() < deadline) {
        let env;
        try {
            env = await client.status();
        }
        catch (err) {
            if (err instanceof KaibaApiError && isTransient(err.status)) {
                if (last !== 'waiting') {
                    log('◐ waiting for the environment cluster…');
                    last = 'waiting';
                }
                await sleep(POLL_INTERVAL_MS);
                continue;
            }
            throw err;
        }
        if (env.status !== last) {
            log(`◐ environment: ${env.status}`);
            last = env.status;
        }
        if (env.status === 'running')
            return;
        // Fail fast on a terminal env error instead of spinning the full timeout.
        if (env.status === 'error')
            fail('the environment is in an error state — check the dev environment in the console');
        await sleep(POLL_INTERVAL_MS);
    }
    fail('the environment cluster did not become ready in time (cold start took too long)');
}
async function waitForService(client, service) {
    const deadline = Date.now() + SERVICE_TIMEOUT_MS;
    let last = '';
    while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);
        let env;
        try {
            env = await client.status();
        }
        catch (err) {
            if (err instanceof KaibaApiError && isTransient(err.status))
                continue;
            throw err;
        }
        const svc = env.services.find((s) => s.name === service);
        if (!svc)
            continue;
        // `running` alone is not enough: a rolling update keeps the OLD pod running
        // while the new image comes up. Wait for the rollout to complete. `rolledOut`
        // is undefined against an older hub/CP — then fall back to `running`.
        const rolledOut = svc.rolledOut !== false;
        const phase = svc.status === 'running' && !rolledOut ? 'rolling out' : svc.status;
        if (phase !== last) {
            log(`◐ ${service}: ${phase}`);
            last = phase;
        }
        if (svc.status === 'running' && rolledOut) {
            log(`✓ ${service} running the new image`);
            return;
        }
        if (TERMINAL_SERVICE_FAIL.has(svc.status)) {
            await dumpServiceLogs(client, service);
            fail(`${service} failed to start: ${svc.status}${svc.error ? ` (${svc.error})` : ''}`);
        }
    }
    await dumpServiceLogs(client, service);
    fail(`${service} did not become ready within ${Math.round(SERVICE_TIMEOUT_MS / 60000)} min`);
}
/**
 * Wait for a re-run one-shot job to complete, kubectl-style — report each state,
 * print logs on failure, exit clean on success. The deploy re-ran the Job
 * (delete + recreate) BEFORE returning, and the control plane reports only the
 * LATEST Job per service, so what we poll here is this run — no client-vs-cluster
 * clock comparison, which would misfire on skew.
 */
async function waitForJob(client, service) {
    const deadline = Date.now() + JOB_TIMEOUT_MS;
    let last = '';
    while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);
        let jobs;
        try {
            jobs = (await client.jobs()).jobs;
        }
        catch (err) {
            if (err instanceof KaibaApiError && isTransient(err.status))
                continue;
            throw err;
        }
        const job = jobs.find((j) => j.name === service);
        if (!job)
            continue;
        if (job.status !== last) {
            log(`◐ job ${service}: ${job.status}`);
            last = job.status;
        }
        if (job.status === 'succeeded') {
            log(`✓ ${service} completed`);
            return;
        }
        // `failed` and `blocked` (unmet dependency) are both terminal — fail fast
        // with the reason and logs rather than spinning to timeout.
        if (job.status === 'failed' || job.status === 'blocked') {
            await dumpServiceLogs(client, service, 'job');
            fail(`${service} ${job.status}${job.error ? `: ${job.error}` : ''}`);
        }
    }
    await dumpServiceLogs(client, service, 'job');
    fail(`${service} did not complete within ${Math.round(JOB_TIMEOUT_MS / 60000)} min`);
}
async function runDeploy(client, service, image) {
    await waitForEnvReady(client);
    const result = await client.deploy(service, image);
    log(`◐ deploy dispatched: ${service} → ${image}`);
    if (result.job) {
        await waitForJob(client, service);
        return;
    }
    await waitForService(client, service);
}
/** Explicit whole-env deploy — re-rolls EVERY service. Deliberate opt-in. */
async function runDeployAll(client) {
    await waitForEnvReady(client);
    await client.deployAll();
    log('◐ deploy dispatched: ALL services');
    printStatus(await client.status());
    log('Run `kaiba status` to watch the services come up.');
}
function dockerLogin(registry, username, password) {
    return new Promise((resolve, reject) => {
        const proc = spawn('docker', ['login', registry, '--username', username, '--password-stdin'], { stdio: ['pipe', 'inherit', 'inherit'] });
        proc.on('error', (err) => reject(new Error(`could not run docker (is it installed?): ${err.message}`)));
        proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`docker login failed (exit ${code})`))));
        proc.stdin?.end(password);
    });
}
/** Expose values as GitHub Actions step outputs when running in a workflow. */
function emitGithubOutput(pairs) {
    const file = process.env.GITHUB_OUTPUT;
    if (!file)
        return;
    appendFileSync(file, Object.entries(pairs).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
}
async function runRegistryLogin(client) {
    const creds = await client.registryCredentials();
    await dockerLogin(creds.registry, creds.username, creds.password);
    log(`✓ logged in to ${creds.registry}`);
    log(`  push prefix: ${creds.registryUrl}`);
    // So a workflow references ${{ steps.<id>.outputs.registry-url }} instead of
    // ever hardcoding the registry path.
    emitGithubOutput({ registry: creds.registry, 'registry-url': creds.registryUrl });
}
function printStatus(env) {
    log(`● ${env.name} (${env.status})`);
    for (const s of env.services) {
        const mark = s.status === 'running' ? '✓' : TERMINAL_SERVICE_FAIL.has(s.status) ? '✗' : '◐';
        log(`  ${mark} ${s.name} — ${s.status}${s.error ? ` (${s.error})` : ''}`);
    }
}
async function main() {
    const [command, ...rest] = process.argv.slice(2);
    const flags = parseFlags(rest);
    if (!command || command === 'help' || flags['help']) {
        log('Usage:');
        log('  kaiba build  --repo <url> --branch <ref> --image <name> [--tag <t>] [--dockerfile <p>] [--context <d>] [--deploy-service <svc>]');
        log('  kaiba deploy --service <name> --image <ref>   # rolls ONLY that service');
        log('  kaiba deploy --all                            # explicitly re-roll every service');
        log('  kaiba registry-login          # docker login to your Kaiba registry (build your own image)');
        log('  kaiba status');
        log('');
        log('Auth: set KAIBA_API_TOKEN. Hub: KAIBA_HUB_URL or --hub-url (default https://cloud.kaiba.ai).');
        process.exit(command ? 0 : 1);
    }
    const client = makeClient(flags);
    try {
        switch (command) {
            case 'build': {
                const imageRef = await runBuild(client, flags);
                const deployService = typeof flags['deploy-service'] === 'string' ? flags['deploy-service'] : undefined;
                if (deployService)
                    await runDeploy(client, deployService, imageRef);
                return;
            }
            case 'deploy': {
                if (flags['all'] === true) {
                    await runDeployAll(client);
                    return;
                }
                await runDeploy(client, required(flags, 'service'), required(flags, 'image'));
                return;
            }
            case 'registry-login': {
                await runRegistryLogin(client);
                return;
            }
            case 'status': {
                printStatus(await client.status());
                return;
            }
            default:
                fail(`Unknown command '${command}'. Run 'kaiba help'.`);
        }
    }
    catch (err) {
        if (err instanceof KaibaApiError)
            fail(`${err.message} (HTTP ${err.status})`);
        fail(err instanceof Error ? err.message : String(err));
    }
}
void main();
