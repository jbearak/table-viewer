import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { save_open_window_paths, take_open_window_paths } from '../main/window-restoration';

describe('open window restoration', () => {
    let directory: string | undefined;

    afterEach(() => {
        if (directory) fs.rmSync(directory, { recursive: true, force: true });
        directory = undefined;
    });

    function user_data_dir(): string {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'table-viewer-windows-'));
        return directory;
    }

    it('restores each still-usable path once', () => {
        const user_data = user_data_dir();
        const first = path.join(user_data, 'first.csv');
        const second = path.join(user_data, 'second.xlsx');
        fs.writeFileSync(first, 'a\n1\n');
        fs.writeFileSync(second, 'workbook');
        save_open_window_paths(user_data, [first, second]);

        expect(take_open_window_paths(user_data, fs.existsSync)).toEqual([first, second]);
        expect(take_open_window_paths(user_data, fs.existsSync)).toEqual([]);
    });

    it('skips files that disappeared after quit', () => {
        const user_data = user_data_dir();
        const existing = path.join(user_data, 'existing.csv');
        const missing = path.join(user_data, 'missing.csv');
        fs.writeFileSync(existing, 'a\n1\n');
        save_open_window_paths(user_data, [existing, missing]);

        expect(take_open_window_paths(user_data, fs.existsSync)).toEqual([existing]);
    });

    it('clears a previous session when quitting with no viewer windows', () => {
        const user_data = user_data_dir();
        save_open_window_paths(user_data, ['/tmp/previous.csv']);
        save_open_window_paths(user_data, []);

        expect(take_open_window_paths(user_data, () => true)).toEqual([]);
    });

    it('consumes an invalid session without restoring anything', () => {
        const user_data = user_data_dir();
        fs.writeFileSync(path.join(user_data, 'open-windows.json'), '{not json');

        expect(take_open_window_paths(user_data, () => true)).toEqual([]);
        expect(take_open_window_paths(user_data, () => true)).toEqual([]);
    });
});
