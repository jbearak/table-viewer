import { beforeEach, describe, expect, it, vi } from 'vitest';
import { vscode_host_ui_port } from '../vscode-host-ports';
import * as vscode_mock from './mocks/vscode';

beforeEach(() => {
    vi.restoreAllMocks();
    vscode_mock.__reset();
});

describe('VS Code host UI port', () => {
    it('maps the oversized-file warning actions', async () => {
        const warning = vi.spyOn(vscode_mock.window, 'showWarningMessage')
            .mockResolvedValue('Open Anyway' as never);

        await expect(vscode_host_ui_port.show_file_size_limit_dialog({
            actualBytes: 784.9 * 1024 * 1024,
            limitBytes: 256 * 1024 * 1024,
        })).resolves.toBe('openAnyway');

        expect(warning).toHaveBeenCalledWith(
            'This file exceeds the configured file-size threshold.',
            {
                modal: true,
                detail: 'The file is 784.9 MiB. Table Viewer is configured to ask before opening files larger than 256 MiB. Opening it may use significant memory or take some time, depending on your computer and the file.',
            },
            'Open Anyway',
            'Change Limit',
        );

        warning.mockResolvedValue('Change Limit' as never);
        await expect(vscode_host_ui_port.show_file_size_limit_dialog({
            actualBytes: 2,
            limitBytes: 1,
        })).resolves.toBe('configure');

        warning.mockResolvedValue(undefined as never);
        await expect(vscode_host_ui_port.show_file_size_limit_dialog({
            actualBytes: 2,
            limitBytes: 1,
        })).resolves.toBe('cancel');
    });

    it.each([
        ['maxFileSizeMiB', '@id:tableViewer.maxFileSizeMiB'],
        ['csvMaxRows', '@id:tableViewer.csvMaxRows'],
    ] as const)('opens the exact %s setting', async (target, query) => {
        const execute = vi.spyOn(vscode_mock.commands, 'executeCommand');

        await vscode_host_ui_port.open_setting(target);

        expect(execute).toHaveBeenCalledWith(
            'workbench.action.openSettings',
            query,
        );
    });
});
