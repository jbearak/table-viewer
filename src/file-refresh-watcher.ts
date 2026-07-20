import * as path from 'path';

export type FileRefreshWatcherEventKind = 'change' | 'create' | 'delete';

/**
 * Stable coordinator identity plus the first physical spelling used to watch it.
 * The physical fields intentionally preserve path casing on Windows.
 */
export interface FileRefreshWatchIdentity {
    readonly fileKey: string;
    readonly platform: NodeJS.Platform;
    readonly filePath: string;
    readonly directory: string;
    readonly basename: string;
}

export interface FileRefreshWatcher {
    on_event(listener: (kind: FileRefreshWatcherEventKind) => void): { dispose(): void };
    dispose(): void;
}

export interface FileRefreshWatcherFactory {
    create(identity: FileRefreshWatchIdentity): FileRefreshWatcher;
}

export function canonical_file_key(
    file_path: string,
    platform: NodeJS.Platform = process.platform,
): string {
    return platform === 'win32'
        ? path.win32.normalize(path.win32.resolve(file_path)).toLowerCase()
        : path.posix.normalize(path.posix.resolve(file_path));
}

export function file_refresh_watch_identity(
    file_path: string,
    platform: NodeJS.Platform = process.platform,
): FileRefreshWatchIdentity {
    const path_api = platform === 'win32' ? path.win32 : path.posix;
    const physical_path = path_api.normalize(path_api.resolve(file_path));
    return Object.freeze({
        fileKey: canonical_file_key(file_path, platform),
        platform,
        filePath: physical_path,
        directory: path_api.dirname(physical_path),
        basename: path_api.basename(physical_path),
    });
}
