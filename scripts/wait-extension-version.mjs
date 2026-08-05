#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_INTERVAL_MS = 5_000;

class TerminalRegistryResponseError extends Error {}

function indexing_deadline_error(publisher, name, version, registry) {
    return new Error(`${publisher}.${name}@${version} was not visible in ${registry} before the indexing deadline.`);
}

function marketplace_request(publisher, name) {
    return {
        url: 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery?api-version=7.2-preview.1',
        init: {
            method: 'POST',
            headers: {
                Accept: 'application/json;api-version=7.2-preview.1',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                filters: [{
                    criteria: [
                        { filterType: 7, value: `${publisher}.${name}` },
                    ],
                    pageNumber: 1,
                    pageSize: 1,
                    sortBy: 0,
                    sortOrder: 0,
                }],
                assetTypes: [],
                flags: 0x1,
            }),
        },
    };
}

function open_vsx_request(publisher, name, version) {
    return {
        url: `https://open-vsx.org/api/${encodeURIComponent(publisher)}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
        init: { headers: { Accept: 'application/json' } },
    };
}

async function complete_before_deadline(operation, timeoutMs, schedule, cancel) {
    const controller = new AbortController();
    let timer;
    const timedOut = new Promise((_, reject) => {
        timer = schedule(() => {
            controller.abort();
            reject(new Error('Registry metadata request timed out.'));
        }, timeoutMs);
    });
    try {
        return await Promise.race([operation(controller.signal), timedOut]);
    } finally {
        if (timer !== undefined) cancel(timer);
    }
}

async function probe_marketplace(fetchImpl, publisher, name, version, signal) {
    const request = marketplace_request(publisher, name);
    const response = await fetchImpl(request.url, { ...request.init, signal });
    if (response.status === 404) return false;
    if (response.status === 429 || response.status >= 500) return false;
    if (!response.ok) throw new TerminalRegistryResponseError(`Marketplace metadata request failed with HTTP ${response.status}.`);
    const payload = await response.json();
    const extensions = payload?.results?.flatMap((result) => result.extensions ?? []) ?? [];
    return extensions.some((extension) => extension.publisher?.publisherName === publisher
        && extension.extensionName === name
        && (extension.versions ?? []).some((candidate) => candidate.version === version));
}

async function probe_open_vsx(fetchImpl, publisher, name, version, signal) {
    const request = open_vsx_request(publisher, name, version);
    const response = await fetchImpl(request.url, { ...request.init, signal });
    if (response.status === 404 || response.status === 429 || response.status >= 500) return false;
    if (!response.ok) throw new TerminalRegistryResponseError(`Open VSX metadata request failed with HTTP ${response.status}.`);
    const payload = await response.json();
    return payload?.namespace === publisher && payload?.name === name && payload?.version === version;
}

export async function wait_for_extension_version({
    registry,
    publisher,
    name,
    version,
    fetchImpl = globalThis.fetch,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    schedule = (callback, milliseconds) => setTimeout(callback, milliseconds),
    cancel = (timer) => clearTimeout(timer),
    now = () => Date.now(),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    intervalMs = DEFAULT_INTERVAL_MS,
}) {
    if (!['marketplace', 'open-vsx'].includes(registry)) throw new Error(`Unsupported registry: ${registry}`);
    for (const [label, value] of Object.entries({ publisher, name, version })) {
        if (typeof value !== 'string' || value.length === 0) throw new Error(`Missing ${label}.`);
    }
    const deadline = now() + timeoutMs;
    while (true) {
        const requestBudget = deadline - now();
        if (requestBudget <= 0) throw indexing_deadline_error(publisher, name, version, registry);
        let visible = false;
        try {
            visible = await complete_before_deadline(
                (signal) => registry === 'marketplace'
                    ? probe_marketplace(fetchImpl, publisher, name, version, signal)
                    : probe_open_vsx(fetchImpl, publisher, name, version, signal),
                requestBudget,
                schedule,
                cancel,
            );
        } catch (error) {
            if (error instanceof TerminalRegistryResponseError) throw error;
            // DNS, TLS, connection resets, malformed transient responses, and
            // deadline aborts are retried only within the original polling window.
        }
        if (visible) return;
        const remaining = deadline - now();
        if (remaining <= 0) throw indexing_deadline_error(publisher, name, version, registry);
        await sleep(Math.min(intervalMs, remaining));
    }
}

async function main() {
    const [registry, publisher, name, version] = process.argv.slice(2);
    await wait_for_extension_version({ registry, publisher, name, version });
    process.stdout.write(`${publisher}.${name}@${version} is visible in ${registry}.\n`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
    });
}
