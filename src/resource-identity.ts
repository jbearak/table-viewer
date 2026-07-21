import * as path from 'path';

const PROVIDER_KEY_PREFIX = 'tableViewer.resource.v1:';

export interface ResourceUriLike {
    readonly scheme: string;
    readonly authority: string;
    readonly path: string;
    readonly query: string;
    readonly fragment: string;
    readonly fsPath: string;
}

export interface ResourceIdentity {
    readonly kind: 'file' | 'provider';
    readonly key: string;
    readonly fileKey: string;
    readonly stateKey: string;
    readonly platform: NodeJS.Platform;
    readonly uri: ResourceUriLike;
    readonly filePath: string;
    readonly directory: string;
    readonly basename: string;
    readonly registrationKey: string;
}

export function canonical_file_key(
    file_path: string,
    platform: NodeJS.Platform = process.platform,
): string {
    return platform === 'win32'
        ? path.win32.normalize(path.win32.resolve(file_path)).toLowerCase()
        : path.posix.normalize(path.posix.resolve(file_path));
}

function provider_key(uri: ResourceUriLike): string {
    return `${PROVIDER_KEY_PREFIX}${JSON.stringify([
        uri.scheme.toLowerCase(),
        uri.authority,
        uri.path,
        uri.query,
    ])}`;
}

function synthetic_file_uri(file_path: string): ResourceUriLike {
    return {
        scheme: 'file',
        authority: '',
        path: file_path,
        query: '',
        fragment: '',
        fsPath: file_path,
    };
}

export function create_resource_identity(
    resource: ResourceUriLike | string,
    platform: NodeJS.Platform = process.platform,
): ResourceIdentity {
    const uri = typeof resource === 'string' ? synthetic_file_uri(resource) : resource;
    if (uri.scheme.toLowerCase() === 'file') {
        const path_api = platform === 'win32' ? path.win32 : path.posix;
        const physical_path = path_api.normalize(path_api.resolve(uri.fsPath));
        const key = canonical_file_key(uri.fsPath, platform);
        return Object.freeze({
            kind: 'file' as const,
            key,
            fileKey: key,
            stateKey: key,
            platform,
            uri,
            filePath: physical_path,
            directory: path_api.dirname(physical_path),
            basename: path_api.basename(physical_path),
            registrationKey: uri.fsPath,
        });
    }
    const key = provider_key(uri);
    return Object.freeze({
        kind: 'provider' as const,
        key,
        fileKey: key,
        stateKey: key,
        platform,
        uri,
        filePath: uri.path,
        directory: path.posix.dirname(uri.path),
        basename: path.posix.basename(uri.path),
        registrationKey: key,
    });
}

export function resource_identity_matches(
    identity: ResourceIdentity,
    candidate: ResourceUriLike,
): boolean {
    return create_resource_identity(candidate, identity.platform).key === identity.key;
}

export function is_provider_state_key(key: string): boolean {
    return key.startsWith(PROVIDER_KEY_PREFIX);
}
