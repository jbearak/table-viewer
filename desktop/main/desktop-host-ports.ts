// Desktop implementations of the shared host ports (src/host-ports.ts).
// The FileSystemPort is pure Node; the HostUiPort takes injected dialog
// callbacks so tabs.ts can back them with electron `dialog` while tests use
// fakes. This module deliberately does not import `electron`.
import * as fs from 'fs';
import type {
    FileSizeLimitDialogChoice,
    FileSizeLimitDialogDetails,
    FileSystemPort,
    HostUiPort,
    SaveDialogChoice,
} from '../../src/host-ports';
import type { ResourceUriLike } from '../../src/resource-identity';

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

export interface DesktopUiDialogs {
    show_warning(message: string): void;
    show_error(message: string): void;
    show_save_discard_dialog(): Promise<SaveDialogChoice>;
    show_file_size_limit_dialog(
        details: FileSizeLimitDialogDetails,
    ): Promise<FileSizeLimitDialogChoice>;
    open_file_size_limit_setting(): Promise<void>;
}

export function create_desktop_ui_port(dialogs: DesktopUiDialogs): HostUiPort {
    return {
        show_warning: (message) => dialogs.show_warning(message),
        show_error: (message) => dialogs.show_error(message),
        show_save_discard_dialog: () => dialogs.show_save_discard_dialog(),
        show_file_size_limit_dialog: (details) =>
            dialogs.show_file_size_limit_dialog(details),
        open_file_size_limit_setting: () => dialogs.open_file_size_limit_setting(),
    };
}
