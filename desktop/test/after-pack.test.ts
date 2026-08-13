import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const cleanup: string[] = [];
afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })));
});

async function fixture(machine: number) {
    const root = await fs.mkdtemp(join(tmpdir(), 'table-viewer-after-pack-'));
    cleanup.push(root);
    const resources = join(root, 'resources');
    await fs.mkdir(resources);
    for (const notice of [
        'LICENSE.txt',
        'THIRD_PARTY_NOTICES.txt',
        'LICENSE.electron.txt',
        'LICENSES.chromium.html',
    ]) await fs.writeFile(join(resources, notice), notice);
    const helper = Buffer.alloc(1024);
    helper.writeUInt16LE(0x5a4d, 0);
    helper.writeUInt32LE(64, 0x3c);
    helper.writeUInt32LE(0x00004550, 64);
    helper.writeUInt16LE(machine, 68);
    helper.writeUInt16LE(1, 70);
    helper.writeUInt16LE(240, 84);
    helper.writeUInt16LE(0x20b, 88);
    helper.writeUInt32LE(512, 64 + 24 + 240 + 16);
    helper.writeUInt32LE(512, 64 + 24 + 240 + 20);
    await fs.writeFile(join(resources, 'windows-portable-update-helper.exe'), helper);
    return root;
}

async function load_after_pack() {
    return import('../after-pack.mjs');
}

describe('desktop after-pack validation', () => {
    it.each([
        ['x64', 1, 0x8664],
        ['arm64', 3, 0xaa64],
    ])('accepts an architecture-matching %s helper', async (_name, arch, machine) => {
        const root = await fixture(machine);
        const { default: after_pack } = await load_after_pack();
        await expect(after_pack({
            electronPlatformName: 'win32', appOutDir: root, arch,
            packager: { appInfo: { productFilename: 'Table Viewer' } },
        })).resolves.toBeUndefined();
    });

    it('rejects a helper built for the other Windows architecture', async () => {
        const root = await fixture(0xaa64);
        const { default: after_pack } = await load_after_pack();
        await expect(after_pack({
            electronPlatformName: 'win32', appOutDir: root, arch: 1,
            packager: { appInfo: { productFilename: 'Table Viewer' } },
        })).rejects.toThrow('expected PE machine 0x8664, found PE machine 0xaa64');
    });

    it.each([
        ['non-PE', Buffer.from('not a PE')],
        ['header-only', (() => {
            const value = Buffer.alloc(128);
            value.writeUInt16LE(0x5a4d, 0);
            value.writeUInt32LE(64, 0x3c);
            value.writeUInt32LE(0x00004550, 64);
            value.writeUInt16LE(0x8664, 68);
            return value;
        })()],
    ])('rejects a %s helper even when it is non-empty', async (_name, contents) => {
        const root = await fixture(0x8664);
        await fs.writeFile(join(root, 'resources', 'windows-portable-update-helper.exe'), contents);
        const { default: after_pack } = await load_after_pack();
        await expect(after_pack({
            electronPlatformName: 'win32', appOutDir: root, arch: 1,
            packager: { appInfo: { productFilename: 'Table Viewer' } },
        })).rejects.toThrow('found an invalid PE file');
    });
});
