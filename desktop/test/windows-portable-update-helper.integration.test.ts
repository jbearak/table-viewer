import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const windows_only = process.platform === 'win32' ? describe : describe.skip;
const cleanup: string[] = [];

afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((path) => fs.rm(path, { recursive: true, force: true })));
});

windows_only('Windows portable update helper integration', () => {
    it('terminates an unacknowledged replacement tree before verified rollback', async () => {
        const build_dir = process.env.PORTABLE_UPDATE_HELPER_TEST_BUILD_DIR;
        if (!build_dir) throw new Error('PORTABLE_UPDATE_HELPER_TEST_BUILD_DIR is required');
        const configuration = process.env.PORTABLE_UPDATE_HELPER_TEST_CONFIGURATION ?? 'Release';
        const binary = (name: string) => resolve(build_dir, configuration, `${name}.exe`);
        const root = await fs.mkdtemp(join(tmpdir(), 'portable-update-helper-native-'));
        cleanup.push(root);

        const helper = binary('windows-portable-update-helper-test');
        const target_path = join(root, 'portable-update-old-fixture.exe');
        const replacement_path = join(root, '.portable-update.new');
        const backup_path = join(root, '.portable-update.old');
        const acknowledgement_path = join(root, 'acknowledged');
        const result_path = join(root, 'result.json');
        const transaction_path = join(root, 'transaction.json');
        await fs.copyFile(binary('portable-update-old-fixture'), target_path);
        await fs.copyFile(binary('portable-update-new-fixture'), replacement_path);
        const [old_bytes, new_bytes] = await Promise.all([
            fs.readFile(target_path), fs.readFile(replacement_path),
        ]);
        const transaction_id = '1'.repeat(32);
        await fs.writeFile(transaction_path, JSON.stringify({
            schema_version: 1,
            transaction_id,
            version: '1.1.0',
            target_path,
            replacement_path,
            backup_path,
            expected_target_sha512: createHash('sha512').update(old_bytes).digest('base64'),
            expected_replacement_sha512: createHash('sha512').update(new_bytes).digest('base64'),
            expected_replacement_size: new_bytes.length,
            wrapper_pid: process.pid,
            acknowledgement_path,
            acknowledgement_token: '2'.repeat(32),
            result_path,
        }));

        const child = spawn(helper, [transaction_path], { windowsHide: true, stdio: 'ignore' });
        const diagnostic = await poll_json(result_path, (value) => value.status === 'awaiting-acknowledgement');
        expect(diagnostic).toMatchObject({ transaction_id, error: 'ack-timeout' });
        const terminal = await poll_json(result_path, (value) => value.status === 'rolled-back');
        expect(terminal).toMatchObject({ transaction_id, status: 'rolled-back', error: 'ack-timeout' });
        await wait_for_exit(child);
        expect(await fs.readFile(target_path)).toEqual(old_bytes);
        expect(await fs.stat(backup_path).then(() => true, () => false)).toBe(false);
        expect(await fs.readFile(join(root, 'old-relaunched'), 'utf8')).toBe('old-relaunched\n');
        expect(await fs.readFile(join(root, 'inner-running'), 'utf8')).toBe('inner-running');

        await fs.rename(target_path, `${target_path}.movable`);
        await fs.rename(`${target_path}.movable`, target_path);
    }, 30_000);
});

async function poll_json(
    path: string,
    predicate: (value: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 15_000;
    let last: Record<string, unknown> | undefined;
    while (Date.now() < deadline) {
        try {
            last = JSON.parse(await fs.readFile(path, 'utf8')) as Record<string, unknown>;
            if (predicate(last)) return last;
        } catch {
            // The helper may not have published the next atomic result yet.
        }
        await new Promise<void>((resolve_poll) => setTimeout(resolve_poll, 25));
    }
    throw new Error(`Timed out polling ${path}; last result: ${JSON.stringify(last)}`);
}

function wait_for_exit(child: ReturnType<typeof spawn>): Promise<void> {
    return new Promise((resolve_exit, reject) => {
        const timeout = setTimeout(() => {
            child.kill();
            reject(new Error('Timed out waiting for native helper exit'));
        }, 15_000);
        child.once('error', (error) => {
            clearTimeout(timeout);
            reject(error);
        });
        child.once('exit', (code, signal) => {
            clearTimeout(timeout);
            if (code === 7 && signal === null) resolve_exit();
            else reject(new Error(`Native helper exited with code ${code} and signal ${signal}`));
        });
    });
}
