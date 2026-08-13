import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
    constants,
    createWriteStream,
    promises as fs,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import type { AppUpdateEngine, UpdateInfo } from './app-updates';
import {
    PORTABLE_UPDATE_HELPER_NAME,
    compare_release_versions,
    parse_portable_update_manifest,
    portable_update_channel,
    portable_update_error,
    portable_update_manifest_url,
    portable_update_transaction_id,
    sha512_file,
    type PortableUpdateInfo,
    type PortableUpdateTransaction,
} from './windows-portable-update-protocol';

interface PortableUpdateListeners {
    available: ((info: UpdateInfo) => void)[];
    unavailable: (() => void)[];
    downloaded: ((info: UpdateInfo) => void)[];
    error: ((error: unknown) => void)[];
}

export interface WindowsPortableUpdateOptions {
    readonly current_version: string;
    readonly arch: string;
    readonly portable_executable: string;
    readonly wrapper_pid: number;
    readonly user_data_dir: string;
    readonly resources_dir: string;
    readonly is_online: () => boolean | undefined;
    readonly finish_quit: () => void;
    readonly fail_quit: () => void;
    readonly fetch?: typeof fetch;
}

export function create_windows_portable_update_engine(
    options: WindowsPortableUpdateOptions,
): AppUpdateEngine {
    const listeners: PortableUpdateListeners = {
        available: [], unavailable: [], downloaded: [], error: [],
    };
    const fetch_url = options.fetch ?? fetch;
    let available: PortableUpdateInfo | undefined;
    let prepared: { transaction_path: string; helper_path: string } | undefined;

    const emit_error = (error: unknown): void => {
        for (const listener of listeners.error) listener(error);
    };

    return {
        check_for_updates: async () => {
            try {
                const manifest_url = portable_update_manifest_url(options.arch);
                const response = await fetch_url(manifest_url, { redirect: 'follow' });
                if (!response.ok) throw http_error(response.status, response.statusText, true);
                if (new URL(response.url || manifest_url).protocol !== 'https:') {
                    throw portable_update_error('ERR_UPDATER_INVALID_RELEASE_FEED', 'Portable update metadata used an insecure redirect');
                }
                const info = parse_portable_update_manifest(
                    await response.text(), manifest_url, options.arch,
                );
                if (compare_release_versions(info.version, options.current_version) <= 0) {
                    available = undefined;
                    for (const listener of listeners.unavailable) listener();
                    return;
                }
                available = info;
                for (const listener of listeners.available) listener({ version: info.version });
            } catch (error) {
                emit_error(error);
                throw error;
            }
        },
        download_update: async () => {
            try {
                if (!available) {
                    throw portable_update_error('ERR_UPDATER_INVALID_UPDATE_INFO', 'No portable update is available');
                }
                prepared = await prepare_portable_update(available, options, fetch_url);
                for (const listener of listeners.downloaded) listener({ version: available.version });
            } catch (error) {
                emit_error(error);
                throw error;
            }
        },
        quit_and_install: () => {
            if (!prepared) throw new Error('No portable update has been downloaded');
            const child = spawn(prepared.helper_path, [prepared.transaction_path], {
                detached: true,
                stdio: 'ignore',
                windowsHide: true,
            });
            let settled = false;
            child.once('error', (error) => {
                if (settled) return;
                settled = true;
                emit_error(error);
                options.fail_quit();
            });
            child.once('spawn', () => {
                if (settled) return;
                settled = true;
                child.unref();
                options.finish_quit();
            });
        },
        is_online: options.is_online,
        on_update_available: (listener) => { listeners.available.push(listener); },
        on_update_not_available: (listener) => { listeners.unavailable.push(listener); },
        on_update_downloaded: (listener) => { listeners.downloaded.push(listener); },
        on_error: (listener) => { listeners.error.push(listener); },
    };
}

async function prepare_portable_update(
    info: PortableUpdateInfo,
    options: WindowsPortableUpdateOptions,
    fetch_url: typeof fetch,
): Promise<{ transaction_path: string; helper_path: string }> {
    const transaction_id = portable_update_transaction_id();
    const transaction_dir = join(options.user_data_dir, 'portable-updates', transaction_id);
    await fs.mkdir(transaction_dir, { recursive: true });
    const partial_path = join(transaction_dir, `${info.asset}.partial`);
    const downloaded_path = join(transaction_dir, info.asset);
    let replacement_path: string | undefined;
    try {
        const response = await fetch_url(info.asset_url, { redirect: 'follow' });
        if (!response.ok) throw http_error(response.status, response.statusText, false);
        if (!response.body || new URL(response.url || info.asset_url).protocol !== 'https:') {
            throw portable_update_error('ERR_UPDATER_INVALID_RELEASE_FEED', 'Portable update download is invalid');
        }

        const digest = createHash('sha512');
        let received = 0;
        const verify = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
                received += chunk.length;
                if (received > info.size) {
                    callback(portable_update_error('ERR_CHECKSUM_MISMATCH', 'Portable update is larger than its metadata'));
                    return;
                }
                digest.update(chunk);
                callback(null, chunk);
            },
        });
        await pipeline(
            Readable.fromWeb(response.body as never),
            verify,
            createWriteStream(partial_path, { flags: 'wx' }),
        );
        if (received !== info.size || digest.digest('base64') !== info.sha512) {
            throw portable_update_error('ERR_CHECKSUM_MISMATCH', 'Portable update does not match its metadata');
        }
        await fs.rename(partial_path, downloaded_path);

        const target_path = options.portable_executable;
        const target_stat = await fs.stat(target_path);
        if (!target_stat.isFile()) throw portable_update_error('ERR_UPDATER_INVALID_UPDATE_INFO', 'Portable update target is not a file');
        await fs.access(dirname(target_path), constants.W_OK);

        replacement_path = join(
            dirname(target_path),
            `.${basename(target_path)}.update-${transaction_id}.new`,
        );
        const backup_path = join(
            dirname(target_path),
            `.${basename(target_path)}.update-${transaction_id}.old`,
        );
        await fs.copyFile(downloaded_path, replacement_path, constants.COPYFILE_EXCL);
        const replacement_stat = await fs.stat(replacement_path);
        if (replacement_stat.size !== info.size || await sha512_file(replacement_path) !== info.sha512) {
            throw portable_update_error('ERR_CHECKSUM_MISMATCH', 'Prepared portable update does not match its metadata');
        }

        const helper_source = join(options.resources_dir, PORTABLE_UPDATE_HELPER_NAME);
        const helper_path = join(transaction_dir, PORTABLE_UPDATE_HELPER_NAME);
        await fs.copyFile(helper_source, helper_path, constants.COPYFILE_EXCL);
        const acknowledgement_token = randomBytes(16).toString('hex');
        const transaction: PortableUpdateTransaction = {
            schema_version: 1,
            transaction_id,
            version: info.version,
            target_path,
            replacement_path,
            backup_path,
            expected_target_sha512: await sha512_file(target_path),
            expected_replacement_sha512: info.sha512,
            expected_replacement_size: info.size,
            wrapper_pid: options.wrapper_pid,
            acknowledgement_path: join(transaction_dir, 'acknowledged'),
            acknowledgement_token,
            result_path: join(transaction_dir, 'result.json'),
        };
        const transaction_path = join(transaction_dir, 'transaction.json');
        const temporary_transaction_path = `${transaction_path}.tmp`;
        await fs.writeFile(temporary_transaction_path, JSON.stringify(transaction), { flag: 'wx' });
        await fs.rename(temporary_transaction_path, transaction_path);
        return { transaction_path, helper_path };
    } catch (error) {
        await Promise.all([
            fs.rm(partial_path, { force: true }).catch(() => {}),
            fs.rm(downloaded_path, { force: true }).catch(() => {}),
            replacement_path
                ? fs.rm(replacement_path, { force: true }).catch(() => {})
                : Promise.resolve(),
        ]);
        await fs.rm(transaction_dir, { recursive: true, force: true }).catch(() => {});
        throw error;
    }
}

function http_error(status: number, status_text: string, metadata: boolean): Error & { code: string; statusCode: number } {
    const code = status === 404
        ? metadata ? 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' : 'ERR_UPDATER_ASSET_NOT_FOUND'
        : `HTTP_ERROR_${status}`;
    return Object.assign(new Error(`HTTP ${status}: ${status_text}`), { code, statusCode: status });
}

export async function clean_windows_portable_update_transactions(
    user_data_dir: string,
): Promise<void> {
    const updates_dir = join(user_data_dir, 'portable-updates');
    let entries: string[];
    try {
        entries = await fs.readdir(updates_dir);
    } catch {
        return;
    }
    await Promise.all(entries.map(async (entry) => {
        const transaction_dir = join(updates_dir, entry);
        try {
            const transaction = JSON.parse(await fs.readFile(
                join(transaction_dir, 'transaction.json'), 'utf8',
            )) as Partial<PortableUpdateTransaction>;
            if (typeof transaction.result_path !== 'string'
                || typeof transaction.transaction_id !== 'string') return;
            await remove_terminal_transaction(
                transaction_dir,
                transaction.result_path,
                transaction.transaction_id,
                1,
            );
        } catch {
            // Incomplete transactions are retained for their helper or diagnosis.
        }
    }));
}

export async function acknowledge_windows_portable_update(
    user_data_dir: string,
    acknowledgement_token: string | undefined,
): Promise<void> {
    if (!acknowledgement_token) return;
    const updates_dir = join(user_data_dir, 'portable-updates');
    let entries: string[];
    try {
        entries = await fs.readdir(updates_dir);
    } catch {
        return;
    }
    for (const entry of entries) {
        const transaction_dir = join(updates_dir, entry);
        const transaction_path = join(transaction_dir, 'transaction.json');
        try {
            const transaction = JSON.parse(await fs.readFile(transaction_path, 'utf8')) as Partial<PortableUpdateTransaction>;
            if (transaction.acknowledgement_token !== acknowledgement_token
                || typeof transaction.acknowledgement_path !== 'string'
                || typeof transaction.result_path !== 'string'
                || typeof transaction.transaction_id !== 'string') continue;
            const temporary_path = `${transaction.acknowledgement_path}.tmp`;
            await fs.writeFile(temporary_path, acknowledgement_token, { flag: 'wx' });
            await fs.rename(temporary_path, transaction.acknowledgement_path);
            void remove_terminal_transaction(
                transaction_dir,
                transaction.result_path,
                transaction.transaction_id,
                240,
            );
            return;
        } catch {
            // An unrelated or interrupted transaction must not block startup.
        }
    }
}

async function remove_terminal_transaction(
    transaction_dir: string,
    result_path: string,
    transaction_id: string,
    attempts: number,
): Promise<void> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
            const result = JSON.parse(await fs.readFile(result_path, 'utf8')) as Record<string, unknown>;
            if (result.transaction_id === transaction_id
                && (result.status === 'committed' || result.status === 'rolled-back'
                    || result.status === 'failed')) {
                await fs.rm(transaction_dir, { recursive: true, force: true });
                return;
            }
        } catch {
            // The helper may be between atomic result-file writes.
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
}

export { portable_update_channel };
