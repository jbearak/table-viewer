import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { attach_viewer, profile_for } from '../viewer-controller';
import { with_in_memory_authority_transactions } from '../state-authority';
import { versioned_state_store } from './helpers/versioned-state-store';
import * as vscode_mock from './mocks/vscode';
import { fake_viewer_host } from './mocks/host-ports';

/**
 * Another program writing a workbook in place leaves it unreadable until the
 * last byte lands. A reload that reads it partway through must wait for the
 * file to stop changing instead of reporting it unreadable, and a file that is
 * unreadable and no longer changing must still be reported.
 *
 * The file is mocked: each `write` sets its bytes and stamps its mtime with the
 * (fake) clock, the way a real write does. Fake timers drive the controller's
 * retry waits, so "the writer finishes after 400 ms" is exact.
 */
const FIXTURES = path.join(__dirname, 'fixtures');
const OLD = new Uint8Array(fs.readFileSync(path.join(FIXTURES, 'basic.xlsx')));
const NEW = new Uint8Array(fs.readFileSync(path.join(FIXTURES, 'formatted.xlsx')));
const PARTIAL = NEW.slice(0, Math.floor(NEW.byteLength / 2));
const GARBAGE = new TextEncoder().encode('this is not a zip archive at all');

let bytes: Uint8Array;
let mtime: number;
let case_index = 0;
let file_path: string;

function write(next: Uint8Array): void {
    bytes = next;
    mtime = Date.now();
}

function sheet_names_of(panel: { __messages: unknown[] }): string[][] {
    return panel.__messages.flatMap((message) => {
        const candidate = message as {
            type?: string;
            snapshot?: { meta: { sheets: { name: string }[] } };
        };
        return candidate.type === 'workbookSnapshot' && candidate.snapshot
            ? [candidate.snapshot.meta.sheets.map((sheet) => sheet.name)]
            : [];
    });
}

let old_sheets: string[];
let new_sheets: string[];

function open(): { panel: ReturnType<typeof vscode_mock.window.createWebviewPanel> } {
    const panel = vscode_mock.window.createWebviewPanel('tableViewer.editor', 'table');
    const controller = attach_viewer(
        panel as unknown as Parameters<typeof attach_viewer>[0],
        vscode_mock.Uri.file(file_path) as unknown as vscode.Uri,
        with_in_memory_authority_transactions(versioned_state_store({}).store),
        profile_for(file_path),
        fake_viewer_host,
    );
    panel.onDidDispose(() => controller.dispose());
    return { panel };
}

async function advance(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
}

/** Polls an observable result under fake timers, advancing the clock between
 *  checks so retry waits elapse. */
async function until(predicate: () => boolean, max_ms: number): Promise<void> {
    for (let elapsed = 0; elapsed <= max_ms; elapsed += 10) {
        if (predicate()) return;
        await advance(10);
    }
    if (!predicate()) throw new Error(`Observable result did not arrive within ${max_ms} ms.`);
}

let error_spy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
    vscode_mock.__reset();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-11-14T12:00:00Z'));
    file_path = `/tmp/slow-writer-${++case_index}.xlsx`;
    // Saved long ago: the file has been still for as long as anyone can tell.
    bytes = OLD;
    mtime = Date.now() - 3_600_000;
    vscode_mock.__setStatImplementation(async () => ({ size: bytes.byteLength, mtime }));
    vscode_mock.__setReadFileImplementation(async () => bytes);
    error_spy = vi.spyOn(vscode_mock.window, 'showErrorMessage');
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

async function open_ready() {
    const { panel } = open();
    await panel.__receive({ type: 'ready' });
    await until(() => sheet_names_of(panel).length > 0, 1_000);
    old_sheets = sheet_names_of(panel)[0];
    return panel;
}

function shows_new_workbook(panel: { __messages: unknown[] }): boolean {
    const last = sheet_names_of(panel).at(-1);
    return JSON.stringify(last) === JSON.stringify(new_sheets);
}

describe('reloading a workbook another program is still writing', () => {
    beforeEach(async () => {
        // The new workbook's sheet names, read the same way the panel reads them.
        const probe_path = file_path;
        file_path = `/tmp/slow-writer-probe-${case_index}.xlsx`;
        bytes = NEW;
        const { panel } = open();
        await panel.__receive({ type: 'ready' });
        await until(() => sheet_names_of(panel).length > 0, 1_000);
        new_sheets = sheet_names_of(panel)[0];
        panel.dispose();
        file_path = probe_path;
        bytes = OLD;
        error_spy.mockClear();
    });

    it('reloads with no error once a slow writer finishes, when the watcher reports both writes', async () => {
        const panel = await open_ready();
        expect(old_sheets).not.toEqual(new_sheets);
        const watcher = vscode_mock.__getWatchers().at(-1)!;

        write(PARTIAL);
        await watcher.__fireChange();
        await advance(400);
        write(NEW);
        await watcher.__fireChange();

        await until(() => shows_new_workbook(panel), 5_000);
        expect(error_spy).not.toHaveBeenCalled();
    });

    it('reloads with no error once a slow writer finishes, when the watcher misses the end', async () => {
        const panel = await open_ready();
        const watcher = vscode_mock.__getWatchers().at(-1)!;

        write(PARTIAL);
        await watcher.__fireChange();
        await advance(400);
        write(NEW);

        await until(() => shows_new_workbook(panel), 5_000);
        expect(error_spy).not.toHaveBeenCalled();
    });

    it('opens with no error a workbook that is still being written', async () => {
        write(PARTIAL);
        const { panel } = open();
        await panel.__receive({ type: 'ready' });
        await advance(400);
        write(NEW);

        await until(() => shows_new_workbook(panel), 5_000);
        expect(error_spy).not.toHaveBeenCalled();
    });

    it('reports a just-written corrupt workbook once it has stopped changing', async () => {
        await open_ready();
        const watcher = vscode_mock.__getWatchers().at(-1)!;

        write(GARBAGE);
        await watcher.__fireChange();

        await until(() => error_spy.mock.calls.length > 0, 2_000);
        expect(error_spy).toHaveBeenCalledOnce();
        expect(String(error_spy.mock.calls[0][0])).toContain('Not a valid .xlsx file');
    });

    it('reports a long-unchanged corrupt workbook as promptly as before', async () => {
        await open_ready();
        const watcher = vscode_mock.__getWatchers().at(-1)!;

        bytes = GARBAGE; // An old mtime: the file has not changed in an hour.
        await watcher.__fireChange();

        await until(() => error_spy.mock.calls.length > 0, 250);
        expect(String(error_spy.mock.calls[0][0])).toContain('Not a valid .xlsx file');
    });

    it('still reports a workbook that never stops changing', async () => {
        await open_ready();
        const watcher = vscode_mock.__getWatchers().at(-1)!;
        let writes = 0;
        vscode_mock.__setStatImplementation(async () => {
            // Every look finds a new, still-incomplete write.
            writes += 1;
            write(PARTIAL.slice(0, PARTIAL.byteLength - (writes % 7)));
            return { size: bytes.byteLength, mtime };
        });

        await watcher.__fireChange();

        await until(() => error_spy.mock.calls.length > 0, 60_000);
        expect(error_spy).toHaveBeenCalledOnce();
    });
});
