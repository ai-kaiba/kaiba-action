/**
 * HTTP client for the Kaiba CI surface (`/ci/*` on the hub). Authenticates with
 * a scoped deploy token via `x-api-key`. Uses only the Node 18+ global `fetch`,
 * so the CLI ships with no runtime dependencies.
 */
export class KaibaApiError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
        this.name = 'KaibaApiError';
    }
}
export class KaibaClient {
    base;
    token;
    constructor(opts) {
        this.base = opts.hubUrl.replace(/\/$/, '');
        this.token = opts.token;
    }
    async request(method, path, body) {
        const res = await fetch(`${this.base}${path}`, {
            method,
            headers: {
                'x-api-key': this.token,
                ...(body ? { 'content-type': 'application/json' } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
        });
        const text = await res.text();
        // Error bodies from the hub are often plain text (Hono HTTPException), so a
        // bare JSON.parse would crash on them. Parse when possible; keep the parse
        // outcome so a non-JSON body never masquerades as a typed success payload.
        let parsed;
        let parseFailed = false;
        if (text) {
            try {
                parsed = JSON.parse(text);
            }
            catch {
                parseFailed = true;
            }
        }
        if (!res.ok) {
            const message = (!parseFailed && parsed?.error) || text || `${res.status} ${res.statusText}`;
            throw new KaibaApiError(res.status, message);
        }
        if (parseFailed) {
            throw new KaibaApiError(res.status, `unexpected non-JSON response: ${text.slice(0, 200)}`);
        }
        return (parsed ?? {});
    }
    startBuild(req) {
        return this.request('POST', '/ci/builds', req);
    }
    getBuild(buildId, clusterId) {
        return this.request('GET', `/ci/builds/${encodeURIComponent(buildId)}?clusterId=${encodeURIComponent(clusterId)}`);
    }
    getBuildLogs(buildId, clusterId) {
        return this.request('GET', `/ci/builds/${encodeURIComponent(buildId)}/logs?clusterId=${encodeURIComponent(clusterId)}`);
    }
    deploy(service, image) {
        return this.request('POST', '/ci/deploy', { service, image });
    }
    status() {
        return this.request('GET', '/ci/status');
    }
    jobs() {
        return this.request('GET', '/ci/jobs');
    }
    logs(service, tail = 200, kind = 'service') {
        return this.request('GET', `/ci/logs?service=${encodeURIComponent(service)}&tail=${tail}&kind=${kind}`);
    }
    registryCredentials() {
        return this.request('GET', '/ci/registry-credentials');
    }
}
