import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    acknowledge_windows_portable_update,
    create_windows_portable_update_engine,
} from '../main/windows-portable-app-updates';

const cleanup: string[] = [];
afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })));
});

async function fixture() {
    const root = await fs.mkdtemp(join(tmpdir(), 'table-viewer-portable-update-'));
    cleanup.push(root);
    const portable = join(root, 'Table Viewer Portable.exe');
    const resources = join(root, 'resources');
    const user_data = join(root, 'user-data');
    await fs.mkdir(resources);
    await fs.writeFile(portable, 'old');
    await fs.writeFile(join(resources, 'windows-portable-update-helper.exe'), 'helper');
    return { root, portable, resources, user_data };
}

function response(body: string | Uint8Array): Response {
    const value = typeof body === 'string'
        ? body
        : body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
    return new Response(value, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
}

function update_fetcher(payload: Buffer, declared_size = payload.length, sha512?: string) {
    const manifest_url = 'https://github.com/jbearak/table-viewer/releases/latest/download/latest-portable.yml';
    const digest = sha512 ?? createHash('sha512').update(payload).digest('base64');
    return vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
        const value = String(url);
        const result = value === manifest_url
            ? response(JSON.stringify({
                version: '1.1.0',
                files: [{ url: 'table-viewer-1.1.0-x64-portable.exe', sha512: digest, size: declared_size }],
                path: 'table-viewer-1.1.0-x64-portable.exe', sha512: digest,
            }))
            : response(payload);
        Object.defineProperty(result, 'url', { value });
        return result;
    });
}

describe('Windows portable update engine', () => {
    it('checks, verifies, and stages a portable update beside its target', async () => {
        const files = await fixture();
        const payload = Buffer.from('new portable executable');
        const sha512 = await import('node:crypto').then(({ createHash }) => createHash('sha512').update(payload).digest('base64'));
        const manifest_url = 'https://github.com/jbearak/table-viewer/releases/latest/download/latest-portable.yml';
        const asset_url = 'https://github.com/jbearak/table-viewer/releases/download/v1.1.0/table-viewer-1.1.0-x64-portable.exe';
        const fetcher = vi.fn(async (url: string | URL | Request) => {
            const value = String(url);
            if (value === manifest_url) {
                const result = response(JSON.stringify({
                    version: '1.1.0',
                    files: [{ url: 'table-viewer-1.1.0-x64-portable.exe', sha512, size: payload.length }],
                    path: 'table-viewer-1.1.0-x64-portable.exe', sha512,
                }));
                Object.defineProperty(result, 'url', { value: manifest_url });
                return result;
            }
            expect(value).toBe(asset_url);
            const result = response(payload);
            Object.defineProperty(result, 'url', { value: asset_url });
            return result;
        });
        const available = vi.fn();
        const downloaded = vi.fn();
        const engine = create_windows_portable_update_engine({
            current_version: '1.0.0', arch: 'x64', portable_executable: files.portable,
            wrapper_pid: 42, user_data_dir: files.user_data, resources_dir: files.resources,
            is_online: () => true, finish_quit: vi.fn(), fail_quit: vi.fn(), fetch: fetcher as typeof fetch,
        });
        engine.on_update_available(available);
        engine.on_update_downloaded(downloaded);

        await engine.check_for_updates();
        await engine.download_update();

        expect(available).toHaveBeenCalledWith({ version: '1.1.0' });
        expect(downloaded).toHaveBeenCalledWith({ version: '1.1.0' });
        expect((await fs.readdir(files.root)).some((name) => name.endsWith('.new'))).toBe(true);
        const transactions = await fs.readdir(join(files.user_data, 'portable-updates'));
        expect(transactions).toHaveLength(1);
        const transaction = JSON.parse(await fs.readFile(
            join(files.user_data, 'portable-updates', transactions[0], 'transaction.json'), 'utf8',
        ));
        expect(transaction).toMatchObject({ version: '1.1.0', target_path: files.portable, wrapper_pid: 42 });
    });

    it('rejects a payload whose digest differs from metadata', async () => {
        const files = await fixture();
        const payload = Buffer.from('wrong');
        const engine = create_windows_portable_update_engine({
            current_version: '1.0.0', arch: 'x64', portable_executable: files.portable,
            wrapper_pid: 42, user_data_dir: files.user_data, resources_dir: files.resources,
            is_online: () => true, finish_quit: vi.fn(), fail_quit: vi.fn(),
            fetch: update_fetcher(payload, payload.length, Buffer.alloc(64, 7).toString('base64')) as typeof fetch,
        });
        engine.on_error(() => {});
        await engine.check_for_updates();
        await expect(engine.download_update()).rejects.toMatchObject({ code: 'ERR_CHECKSUM_MISMATCH' });
    });

    it('rejects a payload whose size differs from metadata', async () => {
        const files = await fixture();
        const payload = Buffer.from('too large');
        const engine = create_windows_portable_update_engine({
            current_version: '1.0.0', arch: 'x64', portable_executable: files.portable,
            wrapper_pid: 42, user_data_dir: files.user_data, resources_dir: files.resources,
            is_online: () => true, finish_quit: vi.fn(), fail_quit: vi.fn(),
            fetch: update_fetcher(payload, payload.length - 1) as typeof fetch,
        });
        engine.on_error(() => {});
        await engine.check_for_updates();
        await expect(engine.download_update()).rejects.toMatchObject({ code: 'ERR_CHECKSUM_MISMATCH' });
    });

    it.each(['1.0.0', '0.9.9'])('reports version %s as unavailable', async (version) => {
        const files = await fixture();
        const payload = Buffer.from('payload');
        const fetcher = update_fetcher(payload);
        const original = fetcher.getMockImplementation()!;
        fetcher.mockImplementation(async (url, init) => {
            const result = await original(url, init);
            if (String(url).endsWith('latest-portable.yml')) {
                const document = await result.json() as Record<string, unknown>;
                document.version = version;
                const asset = `table-viewer-${version}-x64-portable.exe`;
                document.files = [{ url: asset, sha512: createHash('sha512').update(payload).digest('base64'), size: payload.length }];
                document.path = asset;
                const replacement = response(JSON.stringify(document));
                Object.defineProperty(replacement, 'url', { value: String(url) });
                return replacement;
            }
            return result;
        });
        const unavailable = vi.fn();
        const engine = create_windows_portable_update_engine({
            current_version: '1.0.0', arch: 'x64', portable_executable: files.portable,
            wrapper_pid: 42, user_data_dir: files.user_data, resources_dir: files.resources,
            is_online: () => true, finish_quit: vi.fn(), fail_quit: vi.fn(), fetch: fetcher as typeof fetch,
        });
        engine.on_update_not_available(unavailable);
        await engine.check_for_updates();
        expect(unavailable).toHaveBeenCalledOnce();
        await expect(engine.download_update()).rejects.toThrow('No portable update is available');
    });

    it('passes bounded timeout signals to metadata and payload requests', async () => {
        const files = await fixture();
        const fetcher = update_fetcher(Buffer.from('payload'));
        const engine = create_windows_portable_update_engine({
            current_version: '1.0.0', arch: 'x64', portable_executable: files.portable,
            wrapper_pid: 42, user_data_dir: files.user_data, resources_dir: files.resources,
            is_online: () => true, finish_quit: vi.fn(), fail_quit: vi.fn(), fetch: fetcher as typeof fetch,
        });
        await engine.check_for_updates();
        await engine.download_update();
        expect(fetcher).toHaveBeenCalledTimes(2);
        for (const [, init] of fetcher.mock.calls) expect(init?.signal).toBeInstanceOf(AbortSignal);
    });

    it('does not collide with a stale acknowledgement temporary file', async () => {
        const files = await fixture();
        const transaction_dir = join(files.user_data, 'portable-updates', 'transaction');
        await fs.mkdir(transaction_dir, { recursive: true });
        const token = 'a'.repeat(32);
        const acknowledgement_path = join(transaction_dir, 'acknowledged');
        await fs.writeFile(`${acknowledgement_path}.tmp`, 'stale');
        await fs.writeFile(join(transaction_dir, 'transaction.json'), JSON.stringify({
            transaction_id: 'b'.repeat(32), acknowledgement_token: token,
            acknowledgement_path, result_path: join(transaction_dir, 'result.json'),
        }));

        await acknowledge_windows_portable_update(files.user_data, token);

        expect(await fs.readFile(acknowledgement_path, 'utf8')).toBe(token);
        expect(await fs.readFile(`${acknowledgement_path}.tmp`, 'utf8')).toBe('stale');
        await fs.writeFile(join(transaction_dir, 'result.json'), JSON.stringify({
            transaction_id: 'b'.repeat(32), status: 'committed',
        }));
        while (await fs.stat(transaction_dir).then(() => true, () => false)) {
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
    });
});
