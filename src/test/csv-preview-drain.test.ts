import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { AuthorityFileStateStore } from '../state';
import * as vscode_mock from './mocks/vscode';

const seams = vi.hoisted(() => ({
    controller: undefined as {
        dispose: ReturnType<typeof vi.fn>;
        drain: ReturnType<typeof vi.fn>;
    } | undefined,
}));

vi.mock('../viewer-controller', () => ({
    attach_viewer: () => seams.controller,
    csv_source_builder: () => vi.fn(),
}));

import {
    dispose_csv_preview,
    drain_csv_previews,
    show_csv_preview,
} from '../csv-preview';

beforeEach(async () => {
    dispose_csv_preview();
    await drain_csv_previews();
    vscode_mock.__reset();
    seams.controller = undefined;
});

describe('CSV preview teardown', () => {
    it('tracks a failed controller drain and retries it later', async () => {
        const dispose = vi.fn();
        const drain = vi.fn()
            .mockRejectedValueOnce(new Error('preview persistence failed'))
            .mockResolvedValueOnce(undefined);
        seams.controller = { dispose, drain };

        show_csv_preview(
            vscode_mock.Uri.file('/tmp/data.csv') as unknown as vscode.Uri,
            vscode_mock.Uri.file('/extension') as unknown as vscode.Uri,
            {} as AuthorityFileStateStore,
            vscode_mock.ViewColumn.Active as vscode.ViewColumn,
        );
        dispose_csv_preview();

        expect(dispose).toHaveBeenCalledOnce();
        await expect(drain_csv_previews()).rejects.toThrow('preview persistence failed');
        expect(drain).toHaveBeenCalledOnce();

        await expect(drain_csv_previews()).resolves.toBeUndefined();
        expect(drain).toHaveBeenCalledTimes(2);
    });
});
