import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import yaml from 'js-yaml';
import { REPOSITORY_URL } from './about-links';

export const PORTABLE_UPDATE_HELPER_NAME = 'windows-portable-update-helper.exe';
export const PORTABLE_UPDATE_ACK_PREFIX = '--portable-update-ack=';

export interface PortableUpdateInfo {
    readonly version: string;
    readonly asset: string;
    readonly size: number;
    readonly sha512: string;
    readonly manifest_url: string;
    readonly asset_url: string;
}

export interface PortableUpdateTransaction {
    readonly schema_version: 1;
    readonly transaction_id: string;
    readonly version: string;
    readonly target_path: string;
    readonly replacement_path: string;
    readonly backup_path: string;
    readonly expected_target_sha512: string;
    readonly expected_replacement_sha512: string;
    readonly expected_replacement_size: number;
    readonly wrapper_pid: number;
    readonly acknowledgement_path: string;
    readonly acknowledgement_token: string;
    readonly result_path: string;
}

export function portable_update_channel(arch: string): string {
    if (arch === 'x64') return 'latest-portable';
    if (arch === 'arm64') return 'latest-portable-arm64';
    throw portable_update_error('ERR_UPDATER_INVALID_UPDATE_INFO', `Unsupported Windows architecture: ${arch}`);
}

export function expected_portable_asset(version: string, arch: string): string {
    if (!is_release_version(version)) {
        throw portable_update_error('ERR_UPDATER_INVALID_VERSION', 'Portable update version is invalid');
    }
    if (arch !== 'x64' && arch !== 'arm64') {
        throw portable_update_error('ERR_UPDATER_INVALID_UPDATE_INFO', 'Portable update architecture is invalid');
    }
    return `table-viewer-${version}-${arch}-portable.exe`;
}

export function portable_update_manifest_url(arch: string): string {
    return `${REPOSITORY_URL}/releases/latest/download/${portable_update_channel(arch)}.yml`;
}

export function parse_portable_update_manifest(
    document: string,
    manifest_url: string,
    arch: string,
): PortableUpdateInfo {
    let value: unknown;
    try {
        value = yaml.load(document);
    } catch {
        throw portable_update_error('ERR_UPDATER_INVALID_UPDATE_INFO', 'Portable update metadata is not valid YAML');
    }
    if (!is_record(value) || !is_release_version(value.version) || !Array.isArray(value.files)
        || value.files.length !== 1 || !is_record(value.files[0])) {
        throw portable_update_error('ERR_UPDATER_INVALID_UPDATE_INFO', 'Portable update metadata has an invalid shape');
    }
    const file = value.files[0];
    const expected_asset = expected_portable_asset(value.version, arch);
    if (file.url !== expected_asset || value.path !== expected_asset || basename(expected_asset) !== expected_asset) {
        throw portable_update_error('ERR_UPDATER_INVALID_UPDATE_INFO', 'Portable update metadata names the wrong artifact');
    }
    if (!Number.isSafeInteger(file.size) || (file.size as number) <= 0) {
        throw portable_update_error('ERR_UPDATER_INVALID_UPDATE_INFO', 'Portable update metadata has an invalid size');
    }
    validate_sha512(file.sha512);
    if (value.sha512 !== file.sha512) {
        throw portable_update_error('ERR_UPDATER_INVALID_UPDATE_INFO', 'Portable update metadata digests disagree');
    }
    const parsed_manifest = new URL(manifest_url);
    if (parsed_manifest.protocol !== 'https:' || parsed_manifest.hostname !== 'github.com') {
        throw portable_update_error('ERR_UPDATER_INVALID_RELEASE_FEED', 'Portable update metadata came from an unexpected host');
    }
    return {
        version: value.version,
        asset: expected_asset,
        size: file.size as number,
        sha512: file.sha512 as string,
        manifest_url,
        asset_url: `${REPOSITORY_URL}/releases/download/v${value.version}/${expected_asset}`,
    };
}

export function compare_release_versions(left: string, right: string): number {
    if (!is_release_version(left) || !is_release_version(right)) {
        throw portable_update_error('ERR_UPDATER_INVALID_VERSION', 'Portable update version is invalid');
    }
    const a = left.split('.').map(Number);
    const b = right.split('.').map(Number);
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
        const difference = (a[index] ?? 0) - (b[index] ?? 0);
        if (difference !== 0) return Math.sign(difference);
    }
    return 0;
}

export function portable_update_transaction_id(): string {
    return randomBytes(16).toString('hex');
}

export function portable_update_acknowledgement(argv: readonly string[]): string | undefined {
    const values = argv
        .filter((arg) => arg.startsWith(PORTABLE_UPDATE_ACK_PREFIX))
        .map((arg) => arg.slice(PORTABLE_UPDATE_ACK_PREFIX.length));
    return values.length === 1 && /^[a-f0-9]{32}$/.test(values[0]) ? values[0] : undefined;
}

export function without_portable_update_arguments(argv: readonly string[]): string[] {
    return argv.filter((arg) => !arg.startsWith(PORTABLE_UPDATE_ACK_PREFIX));
}

export async function sha512_file(file_path: string): Promise<string> {
    const digest = createHash('sha512');
    for await (const chunk of createReadStream(file_path)) digest.update(chunk);
    return digest.digest('base64');
}

export function portable_update_error(code: string, message: string): Error & { code: string } {
    return Object.assign(new Error(message), { code });
}

function validate_sha512(value: unknown): asserts value is string {
    if (typeof value !== 'string') {
        throw portable_update_error('ERR_UPDATER_NO_CHECKSUM', 'Portable update metadata has no SHA-512 digest');
    }
    const decoded = Buffer.from(value, 'base64');
    if (decoded.length !== 64 || decoded.toString('base64') !== value) {
        throw portable_update_error('ERR_UPDATER_INVALID_UPDATE_INFO', 'Portable update metadata has an invalid SHA-512 digest');
    }
}

function is_release_version(value: unknown): value is string {
    return typeof value === 'string' && /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){2}$/.test(value);
}

function is_record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
