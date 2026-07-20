import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode_mock from './mocks/vscode';
import { file_refresh_watch_identity } from '../file-refresh-watcher';
import { VscodeFileRefreshWatcherFactory } from '../vscode-file-refresh-watcher';

describe('VS Code file refresh watcher adapter', () => {
    beforeEach(() => vscode_mock.__reset());

    it('watches the exact retained directory and basename and maps all events', async () => {
        const factory = new VscodeFileRefreshWatcherFactory();
        const watcher = factory.create(file_refresh_watch_identity(
            'C:\\Data\\Mixed Case\\Book.XLSX',
            'win32',
        ));
        const listener = vi.fn();
        const subscription = watcher.on_event(listener);
        const vscode_watcher = vscode_mock.__getWatchers()[0];
        const pattern = vscode_watcher.__pattern as vscode_mock.RelativePattern;

        expect(pattern.base.fsPath).toBe('C:\\Data\\Mixed Case');
        expect(pattern.pattern).toBe('Book.XLSX');
        await vscode_watcher.__fireChange();
        await vscode_watcher.__fireCreate();
        await vscode_watcher.__fireDelete();
        await vscode_watcher.__fireChange(vscode_mock.Uri.file(
            'c:\\data\\mixed case\\book.xlsx',
        ));
        expect(listener.mock.calls.map(([kind]) => kind)).toEqual([
            'change',
            'create',
            'delete',
            'change',
        ]);

        subscription.dispose();
        await vscode_watcher.__fireChange();
        expect(listener).toHaveBeenCalledTimes(4);

        watcher.dispose();
        watcher.dispose();
        expect(vscode_watcher.__disposed).toBe(true);
        expect(vscode_mock.__getActiveWatchers()).toEqual([]);
        expect(vscode_mock.__getWatcherHistory()).toEqual([vscode_watcher]);
    });

    it('broad-watches and filters a POSIX basename containing a backslash', async () => {
        const factory = new VscodeFileRefreshWatcherFactory();
        const target_path = '/Volumes/Case/report\\final.csv';
        const watcher = factory.create(file_refresh_watch_identity(target_path, 'darwin'));
        const listener = vi.fn();
        const subscription = watcher.on_event(listener);
        const vscode_watcher = vscode_mock.__getWatchers()[0];
        const pattern = vscode_watcher.__pattern as vscode_mock.RelativePattern;

        expect(pattern.base.fsPath).toBe('/Volumes/Case');
        expect(pattern.pattern).toBe('*');
        await vscode_watcher.__fireChange(vscode_mock.Uri.file(target_path));
        await vscode_watcher.__fireCreate(vscode_mock.Uri.file(target_path));
        await vscode_watcher.__fireDelete(vscode_mock.Uri.file(target_path));
        await vscode_watcher.__fireChange(vscode_mock.Uri.file('/Volumes/Case/reportfinal.csv'));
        await vscode_watcher.__fireCreate(vscode_mock.Uri.file('/Volumes/Case/report\\other.csv'));
        await vscode_watcher.__fireDelete(vscode_mock.Uri.file('/Volumes/Case/sub/report\\final.csv'));
        await vscode_watcher.__fireChange(vscode_mock.Uri.file('/Volumes/Case/REPORT\\FINAL.CSV'));
        expect(listener.mock.calls.map(([kind]) => kind)).toEqual([
            'change',
            'create',
            'delete',
        ]);

        subscription.dispose();
        await vscode_watcher.__fireChange(vscode_mock.Uri.file(target_path));
        watcher.dispose();
        expect(listener).toHaveBeenCalledTimes(3);
        expect(vscode_watcher.__disposed).toBe(true);
    });

    it('escapes glob metacharacters in the literal basename', () => {
        const factory = new VscodeFileRefreshWatcherFactory();
        const watcher = factory.create(file_refresh_watch_identity(
            '/tmp/[draft]*?{old,new}.csv',
            'linux',
        ));
        const pattern = vscode_mock.__getWatchers()[0].__pattern as vscode_mock.RelativePattern;
        expect(pattern.base.fsPath).toBe('/tmp');
        expect(pattern.pattern).toBe('[[]draft[]][*][?][{]old,new[}].csv');
        watcher.dispose();
    });
});
