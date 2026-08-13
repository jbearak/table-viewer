import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { create_windows_portable_update_engine } from '../main/windows-portable-app-updates';

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

    it('rejects a payload whose size or digest differs from metadata', async () => {
        const files = await fixture();
        const manifest_url = 'https://github.com/jbearak/table-viewer/releases/latest/download/latest-portable.yml';
        const digest = Buffer.alloc(64, 7).toString('base64');
        const fetcher = vi.fn(async (url: string | URL | Request) => {
            const value = String(url);
            const result = value === manifest_url
                ? response(JSON.stringify({
                    version: '1.1.0',
                    files: [{ url: 'table-viewer-1.1.0-x64-portable.exe', sha512: digest, size: 3 }],
                    path: 'table-viewer-1.1.0-x64-portable.exe', sha512: digest,
                }))
                : response('wrong');
            Object.defineProperty(result, 'url', { value });
            return result;
        });
        const engine = create_windows_portable_update_engine({
            current_version: '1.0.0', arch: 'x64', portable_executable: files.portable,
            wrapper_pid: 42, user_data_dir: files.user_data, resources_dir: files.resources,
            is_online: () => true, finish_quit: vi.fn(), fail_quit: vi.fn(), fetch: fetcher as typeof fetch,
        });
        engine.on_error(() => {});
        await engine.check_for_updates();
        await expect(engine.download_update()).rejects.toMatchObject({ code: 'ERR_CHECKSUM_MISMATCH' });
    });
});
