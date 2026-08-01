// Desktop implementations of the shared host ports (src/host-ports.ts).
// The FileSystemPort is pure Node; the HostUiPort takes injected dialog
// callbacks so tabs.ts can back them with electron `dialog` while tests use
// fakes. This module deliberately does not import `electron`.
import * as fs from 'fs';
import type {
    FileSystemPort,
    HostUiPort,
    PhysicalCoordinationPort,
    SaveDialogChoice,
} from '../../src/host-ports';
import type { ResourceUriLike } from '../../src/resource-identity';
import { prepare_physical_install } from '../../src/prepared-physical-install';
import {
    native_physical_edit_eligibility,
    PhysicalResourceLockManager,
} from '../../src/physical-resource-lock';

function file_path_of(resource: ResourceUriLike): string {
    if (resource.scheme.toLowerCase() !== 'file') {
        throw new Error(`Unsupported resource scheme: ${resource.scheme}`);
    }
    return resource.fsPath;
}

export const node_file_system_port: FileSystemPort = {
    async stat(resource) {
        const stat = await fs.promises.stat(file_path_of(resource));
        return { size: stat.size, mtime: stat.mtimeMs };
    },
    read_file(resource) {
        return fs.promises.readFile(file_path_of(resource));
    },
    async write_file(resource, content) {
        await fs.promises.writeFile(file_path_of(resource), content);
    },
};

const physical_lock_managers = new Map<string, PhysicalResourceLockManager>();

function desktop_physical_eligibility(resource: ResourceUriLike) {
    return native_physical_edit_eligibility({
        scheme: resource.scheme,
        filePath: resource.fsPath,
    });
}

export const desktop_physical_coordination_port: PhysicalCoordinationPort = {
    availability(resource) {
        const eligibility = desktop_physical_eligibility(resource);
        if (!eligibility.eligible) return { type: 'viewOnly', reason: eligibility.reason };
        // No packaged desktop platform has yet proven an exact displaced-version
        // conditional installation primitive. Direct write/rename is forbidden.
        return { type: 'viewOnly', reason: 'conditional-install-unsupported' };
    },
    async acquire(resource) {
        const availability = this.availability(resource);
        if (availability.type === 'viewOnly') return availability;
        const eligibility = desktop_physical_eligibility(resource);
        if (!eligibility.eligible) return { type: 'viewOnly', reason: eligibility.reason };
        let manager = physical_lock_managers.get(eligibility.lockRoot);
        if (!manager) {
            manager = new PhysicalResourceLockManager({ lockRoot: eligibility.lockRoot });
            physical_lock_managers.set(eligibility.lockRoot, manager);
        }
        const lock = await manager.acquire(resource.fsPath);
        return lock ? { type: 'acquired', lock } : { type: 'busy' };
    },
    prepare(resource, expectedOriginal, intended, lock) {
        return prepare_physical_install({
            targetPath: resource.fsPath,
            expectedOriginal,
            intended,
            hostLock: lock,
        });
    },
};

export interface DesktopUiDialogs {
    show_warning(message: string): void;
    show_error(message: string): void;
    show_save_discard_dialog(): Promise<SaveDialogChoice>;
}

export function create_desktop_ui_port(dialogs: DesktopUiDialogs): HostUiPort {
    return {
        show_warning: (message) => dialogs.show_warning(message),
        show_error: (message) => dialogs.show_error(message),
        show_save_discard_dialog: () => dialogs.show_save_discard_dialog(),
    };
}
