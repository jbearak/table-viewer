import { describe, it, expect, vi } from 'vitest';
import { RowLoader, type SavedCellPatches } from '../webview/row-loader';
import { PAGE_SIZE } from '../webview/grid-model';
import {
    saved_presentation_refusal,
    type SavedPresentationInput,
} from '../webview/saved-presentation';
import { create_refresh_end_notice } from '../refresh-end-notice';
import type { RenderedCell } from '../data-source/interface';
import type { CsvSaveOperation, CsvSaveWorksheetOperation, HostMessage, WebviewMessage } from '../types';

type RequestRows = Extract<WebviewMessage, { type: 'requestRows' }>;

const cell = (s: string): RenderedCell => ({ raw: s, formatted: s, bold: false, italic: false });

function loader_with_rows(pages: readonly number[], max_pages = 50) {
    const post = vi.fn();
    const on_change = vi.fn();
    const loader = new RowLoader(post, on_change, max_pages);
    loader.configure(0, PAGE_SIZE * 20, 1);
    for (const start of pages) deliver(loader, post, start, 1);
    return { loader, post, on_change };
}

function deliver(loader: RowLoader, post: ReturnType<typeof vi.fn>, start: number, generation: number): boolean {
    loader.ensure_rows(start, start);
    const request = [...post.mock.calls].reverse()
        .map((call) => call[0] as RequestRows)
        .find((candidate) => candidate.startRow === start);
    if (!request) throw new Error(`no request for ${start}`);
    return loader.on_row_data({
        type: 'rowData',
        sheetIndex: 0,
        startRow: start,
        rows: Array.from({ length: PAGE_SIZE }, (_, i) => [cell(`r${start + i}c0`), cell(`r${start + i}c1`)]),
        sourceRows: Array.from({ length: PAGE_SIZE }, (_, i) => start + i),
        requestId: request.requestId,
        generation,
    });
}

/** A patch that shows `text` and records the original it was built from. */
function saved(cells: Record<string, string>): { patches: SavedCellPatches; originals: (RenderedCell | null)[] } {
    const originals: (RenderedCell | null)[] = [];
    const patches = new Map<number, Map<number, (original: RenderedCell | null) => RenderedCell | null>>();
    for (const [key, text] of Object.entries(cells)) {
        const [row, column] = key.split(':').map(Number) as [number, number];
        let columns = patches.get(row);
        if (!columns) patches.set(row, columns = new Map());
        columns.set(column, (original) => {
            originals.push(original);
            return { ...(original ?? cell('')), raw: text, formatted: text };
        });
    }
    return { patches, originals };
}

describe('RowLoader saved cells', () => {
    it('shows saved cells to every reader and builds each from the cell it replaces', () => {
        const { loader, on_change } = loader_with_rows([0]);
        const { patches, originals } = saved({ '1:0': 'saved', '2:1': 'other' });
        on_change.mockClear();
        loader.present_saved_cells(patches);
        expect(on_change).toHaveBeenCalledTimes(1);
        expect(loader.saved_cells_active).toBe(true);
        expect(originals.map((original) => original?.raw)).toEqual(['r1c0', 'r2c1']);
        expect(loader.get_row(1)?.[0]?.formatted).toBe('saved');
        expect(loader.get_row(1)?.[1]?.formatted).toBe('r1c1');
        expect(loader.get_cell_for_source(1, 0)?.raw).toBe('saved');
        expect(loader.get_cell_raw_for_source(2, 1)).toBe('other');
        const sampled = loader.sample_loaded_rows(PAGE_SIZE).find((row) => row.source_row === 1);
        expect(sampled?.cells[0]?.formatted).toBe('saved');
    });

    it('patches a page of the same generation that arrives later', () => {
        const { loader, post } = loader_with_rows([0]);
        loader.present_saved_cells(saved({ [`${PAGE_SIZE * 3 + 4}:1`]: 'late' }).patches);
        expect(deliver(loader, post, PAGE_SIZE * 3, 1)).toBe(true);
        expect(loader.get_row(PAGE_SIZE * 3 + 4)?.[1]?.formatted).toBe('late');
    });

    it('restores the original cells in place, keeping every page resident', () => {
        const { loader, post, on_change } = loader_with_rows([0, PAGE_SIZE]);
        const resident = loader.resident_row_ranges();
        loader.present_saved_cells(saved({ '1:0': 'a', [`${PAGE_SIZE + 2}:1`]: 'b' }).patches);
        post.mockClear();
        on_change.mockClear();
        expect(loader.restore_saved_cells()).toBe(true);
        expect(on_change).toHaveBeenCalledTimes(1);
        expect(loader.saved_cells_active).toBe(false);
        expect(loader.get_row(1)?.[0]?.formatted).toBe('r1c0');
        expect(loader.get_row(PAGE_SIZE + 2)?.[1]?.formatted).toBe(`r${PAGE_SIZE + 2}c1`);
        expect(loader.resident_row_ranges()).toEqual(resident);
        expect(post).not.toHaveBeenCalled();
        expect(loader.restore_saved_cells()).toBe(false);
    });

    it('patches nothing more once restored', () => {
        const { loader, post } = loader_with_rows([0]);
        loader.present_saved_cells(saved({ [`${PAGE_SIZE * 2}:0`]: 'x' }).patches);
        loader.restore_saved_cells();
        deliver(loader, post, PAGE_SIZE * 2, 1);
        expect(loader.get_row(PAGE_SIZE * 2)?.[0]?.formatted).toBe(`r${PAGE_SIZE * 2}c0`);
    });

    it('a page evicted and delivered again shows the saved cell and restores to the file', () => {
        const { loader, post } = loader_with_rows([0], 2);
        loader.present_saved_cells(saved({ '3:0': 'x' }).patches);
        // Move the viewport away so page 0 can be evicted, then bring it back.
        deliver(loader, post, PAGE_SIZE * 5, 1);
        deliver(loader, post, PAGE_SIZE * 6, 1);
        deliver(loader, post, PAGE_SIZE * 7, 1);
        expect(loader.get_row(3)).toBeUndefined();
        deliver(loader, post, 0, 1);
        expect(loader.get_row(3)?.[0]?.formatted).toBe('x');
        loader.restore_saved_cells();
        expect(loader.get_row(3)?.[0]?.formatted).toBe('r3c0');
    });

    it('a configure that changes the rows clears the saved cells with them', () => {
        const { loader, post } = loader_with_rows([0]);
        loader.present_saved_cells(saved({ '1:0': 'x' }).patches);
        loader.configure(0, PAGE_SIZE * 20, 2);
        expect(loader.saved_cells_active).toBe(false);
        deliver(loader, post, 0, 2);
        expect(loader.get_row(1)?.[0]?.formatted).toBe('r1c0');
    });

    it('finds a saved cell by its source row wherever that row is displayed', () => {
        // A view whose display rows carry other source rows (a hidden header
        // row, an offset): the patch is keyed by source row.
        const post = vi.fn();
        const loader = new RowLoader(post, vi.fn());
        loader.configure(0, PAGE_SIZE * 2, 1);
        loader.ensure_rows(0, 0);
        const request = post.mock.calls[0][0] as RequestRows;
        loader.on_row_data({
            type: 'rowData',
            sheetIndex: 0,
            startRow: 0,
            rows: Array.from({ length: PAGE_SIZE }, (_, i) => [cell(`s${1000 + i}`)]),
            sourceRows: Array.from({ length: PAGE_SIZE }, (_, i) => 1000 + i),
            requestId: request.requestId,
            generation: 1,
        });
        loader.present_saved_cells(saved({ '1003:0': 'saved', '3:0': 'not this one' }).patches);
        expect(loader.get_row(3)?.[0]?.formatted).toBe('saved');
        expect(loader.get_cell_for_source(1003, 0)?.raw).toBe('saved');
        expect(loader.get_row(1003)).toBeUndefined();
        loader.restore_saved_cells();
        expect(loader.get_row(3)?.[0]?.formatted).toBe('s1003');
    });

    it('a second presentation replaces the first', () => {
        const { loader } = loader_with_rows([0]);
        loader.present_saved_cells(saved({ '1:0': 'first', '2:0': 'only first' }).patches);
        loader.present_saved_cells(saved({ '1:0': 'second' }).patches);
        expect(loader.get_row(1)?.[0]?.formatted).toBe('second');
        expect(loader.get_row(2)?.[0]?.formatted).toBe('r2c0');
        loader.restore_saved_cells();
        expect(loader.get_row(1)?.[0]?.formatted).toBe('r1c0');
    });
});

const worksheet = (overrides: Partial<CsvSaveWorksheetOperation> = {}): CsvSaveWorksheetOperation => ({
    sheetIndex: 0,
    sheetName: 'Sheet1',
    edits: { '3:1': 'new' },
    dirtyEdits: { '3:1': { value: 'new', base: 'old' } },
    ...overrides,
});

function input(overrides: Partial<SavedPresentationInput> = {}, sheet = worksheet()): SavedPresentationInput {
    const operation: CsvSaveOperation = {
        editSessionId: 'session',
        saveRequestId: 'save:1',
        worksheets: [sheet],
    };
    return {
        operation,
        worksheet: sheet,
        proposal: { save_request_id: 'save:1', generation: 4 },
        generation: 4,
        facts: { revision: 7, ended_revision: 0, formula_free: true, natural_view: true },
        xlsx_editing: true,
        header_source_row: undefined,
        remaining_dirty: 0,
        ...overrides,
    };
}

describe('saved_presentation_refusal', () => {
    it('admits a value-only Save of the shown worksheet', () => {
        expect(saved_presentation_refusal(input())).toBeUndefined();
    });

    it.each<[string, Partial<SavedPresentationInput>]>([
        ['not-proposed-here', { proposal: undefined }],
        ['not-proposed-here', { proposal: { save_request_id: 'save:0', generation: 4 } }],
        ['reloaded-since-proposal', { generation: 5 }],
        ['refresh-already-ended', { facts: { revision: 7, ended_revision: 7, formula_free: true, natural_view: true } }],
        ['workbook-has-formulas', { facts: { revision: 7, ended_revision: 0, formula_free: false, natural_view: true } }],
        ['permuted-view', { facts: { revision: 7, ended_revision: 0, formula_free: true, natural_view: false } }],
        ['left-dirty', { remaining_dirty: 1 }],
        ['not-this-worksheet', { worksheet: undefined }],
        ['header-row', { header_source_row: 3 }],
    ])('refuses %s', (reason, overrides) => {
        expect(saved_presentation_refusal(input(overrides))).toBe(reason);
    });

    it('refuses a Save of two worksheets', () => {
        const value = input();
        expect(saved_presentation_refusal({
            ...value,
            operation: { ...value.operation, worksheets: [worksheet(), worksheet({ sheetIndex: 1, sheetName: 'Two' })] },
        })).toBe('not-one-worksheet');
    });

    it.each<[string, Partial<CsvSaveWorksheetOperation>]>([
        ['structural', { structuralChanges: {} as never }],
        ['link', { dirtyEdits: {
            '3:1': { value: 'new', base: 'old' },
            '4:1': { value: 'x', base: 'x', link: null, baseLink: { url: 'https://example.com' } as never },
        } }],
        ['moved', { dirtyEdits: { '3:1': { value: 'new', base: 'old', movedFrom: { row: 1, column: 1 } as never } } }],
        ['formula', { dirtyEdits: { '3:1': { value: '=A1*2', base: 'old' } } }],
        ['nothing-saved', { dirtyEdits: {} }],
        ['bad-key', { dirtyEdits: { 'three:one': { value: 'new', base: 'old' } } }],
    ])('refuses %s', (reason, overrides) => {
        const sheet = worksheet(overrides);
        expect(saved_presentation_refusal(input({}, sheet))).toBe(reason);
    });

    it('a leading = is a value in a CSV', () => {
        const sheet = worksheet({ dirtyEdits: { '3:1': { value: '=A1*2', base: 'old' } } });
        expect(saved_presentation_refusal(input({ xlsx_editing: false }, sheet))).toBeUndefined();
    });
});

describe('refresh end notice', () => {
    function harness(answers: (boolean | 'pending' | 'reject')[]) {
        const posted: HostMessage[] = [];
        const timers: { callback: () => void; delay: number; cleared: boolean }[] = [];
        let epoch = 1;
        const post = vi.fn((message: HostMessage, _epoch: number) => {
            posted.push(message);
            const answer = answers.shift() ?? true;
            if (answer === 'pending') return new Promise<boolean>(() => {});
            if (answer === 'reject') return Promise.reject(new Error('gone'));
            return Promise.resolve(answer);
        });
        const notice = create_refresh_end_notice({
            post,
            receiver_epoch: () => epoch,
            scheduler: {
                setTimeout: (callback, delay) => {
                    const timer = { callback, delay, cleared: false };
                    timers.push(timer);
                    return timer;
                },
                clearTimeout: (handle) => { (handle as { cleared: boolean }).cleared = true; },
            },
        });
        const run_next = async () => {
            const timer = timers.find((candidate) => !candidate.cleared);
            if (!timer) throw new Error('no timer');
            timer.cleared = true;
            timer.callback();
            await Promise.resolve();
            await Promise.resolve();
        };
        const live = () => timers.filter((timer) => !timer.cleared).map((timer) => timer.delay);
        return { notice, posted, post, run_next, live, set_epoch: (next: number) => { epoch = next; } };
    }

    it('posts once for the Save that asked, naming its revision', async () => {
        const { notice, posted, live } = harness([true]);
        notice.save_requested(9);
        notice.ended_without_adoption();
        await Promise.resolve();
        notice.ended_without_adoption();
        expect(posted).toEqual([{ type: 'refreshEndedWithoutAdoption', revision: 9 }]);
        expect(live()).toEqual([]);
    });

    it('posts nothing with no Save waiting, or once a file was adopted', () => {
        const { notice, posted } = harness([]);
        notice.ended_without_adoption();
        notice.save_requested(3);
        notice.adopted();
        notice.ended_without_adoption();
        expect(posted).toEqual([]);
    });

    it('retries a post that was not taken, rejected, or never answered', async () => {
        const { notice, posted, run_next, live } = harness([false, 'reject', 'pending', true]);
        notice.save_requested(2);
        notice.ended_without_adoption();
        await Promise.resolve();
        await Promise.resolve();
        expect(live()).toEqual([25]);
        await run_next();
        await Promise.resolve();
        expect(live()).toEqual([50]);
        await run_next();
        // The third post never answers: its attempt timeout retries it.
        expect(live()).toEqual([1_000]);
        await run_next();
        expect(live()).toEqual([100]);
        await run_next();
        expect(posted).toHaveLength(4);
        expect(live()).toEqual([]);
    });

    it('stops for a new receiver, a disposal, or a later Save', async () => {
        const first = harness([false, true]);
        first.notice.save_requested(1);
        first.notice.ended_without_adoption();
        await Promise.resolve();
        first.set_epoch(2);
        await first.run_next();
        expect(first.posted).toHaveLength(1);
        expect(first.live()).toEqual([]);

        const second = harness([false]);
        second.notice.save_requested(1);
        second.notice.ended_without_adoption();
        await Promise.resolve();
        second.notice.dispose();
        expect(second.live()).toEqual([]);

        const third = harness([false, true]);
        third.notice.save_requested(1);
        third.notice.ended_without_adoption();
        await Promise.resolve();
        third.notice.save_requested(2);
        third.notice.ended_without_adoption();
        await Promise.resolve();
        expect(third.posted.map((message) => (message as { revision: number }).revision)).toEqual([1, 2]);
        expect(third.live()).toEqual([]);
    });
});
