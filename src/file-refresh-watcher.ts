import type { ResourceIdentity } from './resource-identity';

export type FileRefreshWatcherEventKind = 'change' | 'create' | 'delete';

export interface FileRefreshWatcher {
    on_event(listener: (kind: FileRefreshWatcherEventKind) => void): { dispose(): void };
    dispose(): void;
}

export interface FileRefreshWatcherFactory {
    create(identity: ResourceIdentity): FileRefreshWatcher;
}

export {
    canonical_file_key,
    create_resource_identity as file_refresh_watch_identity,
} from './resource-identity';
export type { ResourceIdentity as FileRefreshWatchIdentity } from './resource-identity';
