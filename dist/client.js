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
        const data = text ? JSON.parse(text) : {};
        if (!res.ok) {
            throw new KaibaApiError(res.status, data.error ?? `${res.status} ${res.statusText}`);
        }
        return data;
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
    registryCredentials() {
        return this.request('GET', '/ci/registry-credentials');
    }
}
