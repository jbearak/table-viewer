// @vitest-environment jsdom

import React, { act, useMemo } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prospective_row_count } from '../formula-anchor-layout';
import { create_edit_session_registry, type EditSessionRegistry } from '../webview/edit-session-registry';
import type { AnchorSheetMeta } from '../webview/formula-anchor-model';
import * as formula_anchor_model from '../webview/formula-anchor-model';
import {
    create_pending_snapshots,
    use_pending_snapshot,
    type PendingSnapshotWorkbook,
} from '../webview/pending-snapshot';

vi.mock('../webview/formula-anchor-model', async (import_original) => {
    const actual = await import_original<typeof import('../webview/formula-anchor-model')>();
    return {
        ...actual,
        webview_anchor_inputs: vi.fn(actual.webview_anchor_inputs),
        webview_formula_workbook: vi.fn(actual.webview_formula_workbook),
    };
});

const SESSION = 'session';

function sheets(): AnchorSheetMeta[] {
    return [
        { name: 'Data', sourceRowCount: 4, columnCount: 3 },
        { name: 'Other', sourceRowCount: 2, columnCount: 2 },
    ];
}

function setup() {
    const registry = create_edit_session_registry(() => SESSION);
    const workbook: PendingSnapshotWorkbook = { sheets: sheets(), xlsx: true };
    return { registry, workbook, snapshots: create_pending_snapshots(registry) };
}

function append_row(registry: EditSessionRegistry, sheet_index: number, id: string, order: number) {
    registry.pending_rows_for_sheet(sheet_index).append_rows(
        SESSION,
        [id],
        { id: 'plain', format: { kind: 'none' } },
        order,
    );
}

const LINK_ONLY = {
    value: 'same',
    base: 'same',
    link: { kind: 'external', target: 'https://example.com' },
    baseLink: null,
} as const;

beforeEach(() => {
    vi.mocked(formula_anchor_model.webview_formula_workbook).mockClear();
    vi.mocked(formula_anchor_model.webview_anchor_inputs).mockClear();
});

describe('pending snapshots', () => {
    it('hands out the same snapshot for the same revision and workbook', () => {
        const { registry, workbook, snapshots } = setup();
        registry.for_sheet(0).commit(SESSION, '1:0', { value: 'new', base: 'old' });

        const first = snapshots.read(workbook);
        const second = snapshots.read({ ...workbook });

        expect(second).toBe(first);
        expect(first.revision).toBe(registry.revision());
        expect(Object.isFrozen(first)).toBe(true);
    });

    it('hands out a new snapshot, tagged with the new revision, after any registry change', () => {
        const { registry, workbook, snapshots } = setup();
        const seen = [snapshots.read(workbook)];

        registry.for_sheet(0).commit(SESSION, '1:0', { value: 'new', base: 'old' });
        seen.push(snapshots.read(workbook));
        append_row(registry, 1, 'pending-1', 1);
        seen.push(snapshots.read(workbook));
        registry.for_sheet(0).commit(SESSION, '2:0', LINK_ONLY);
        seen.push(snapshots.read(workbook));

        expect(new Set(seen).size).toBe(seen.length);
        expect(seen.map((snapshot) => snapshot.revision)).toEqual([0, 1, 2, 3]);
    });

    it('carries a link-only write that moves no formula revision', () => {
        const { registry, workbook, snapshots } = setup();
        registry.for_sheet(0).commit(SESSION, '1:0', { value: 'new', base: 'old' });
        const before = snapshots.read(workbook);
        const projection_before = registry.formula_projection();

        registry.for_sheet(0).commit(SESSION, '2:0', LINK_ONLY);
        const after = snapshots.read(workbook);
        const projection_after = registry.formula_projection();

        // The keys the Save description memo used before #349 stand still...
        expect(projection_after.calculationRevision).toBe(projection_before.calculationRevision);
        expect(projection_after.structuralRevision).toBe(projection_before.structuralRevision);
        // ...while the snapshot and its cells move.
        expect(after.revision).toBeGreaterThan(before.revision);
        expect(after.cells).not.toBe(before.cells);
        expect([...after.cells.cells_for(0).keys()]).toEqual(['1:0', '2:0']);
        expect(after.cells.cells_for(0).get('2:0')?.link).toEqual(LINK_ONLY.link);
        expect(after.structure).toBe(before.structure);
    });

    it('rebuilds the structure and its derived workbook when the structure of a worksheet changes', () => {
        const { registry, workbook, snapshots } = setup();
        registry.for_sheet(0).commit(SESSION, '1:0', { value: 'new', base: 'old' });
        const before = snapshots.read(workbook);
        const workbook_before = before.structure.formula_workbook();
        expect(prospective_row_count(workbook_before.worksheets[1]!)).toBe(2);

        append_row(registry, 1, 'pending-1', 1);
        const after = snapshots.read(workbook);

        expect(after.structure).not.toBe(before.structure);
        expect(after.cells).toBe(before.cells);
        expect(after.structure.changes_for(1)?.appendedRows?.map((row) => row.id)).toEqual(['pending-1']);
        expect([...after.structure.by_sheet.keys()]).toEqual([1]);
        const workbook_after = after.structure.formula_workbook();
        expect(workbook_after).not.toBe(workbook_before);
        expect(prospective_row_count(workbook_after.worksheets[1]!)).toBe(3);
        expect(after.structure.anchor_inputs()[1]?.changes).toBe(after.structure.changes_for(1));
    });

    it('rebuilds the structure for another workbook at the same revision', () => {
        const { workbook, snapshots } = setup();
        const before = snapshots.read(workbook);

        const csv = snapshots.read({ ...workbook, xlsx: false });
        expect(csv).not.toBe(before);
        expect(csv.revision).toBe(before.revision);
        expect(csv.structure.formula_workbook().format).toBe('csv');

        const renamed = snapshots.read({ sheets: [{ ...workbook.sheets[0]!, name: 'Renamed' }], xlsx: false });
        expect(renamed.structure.formula_workbook().worksheets.map((sheet) => sheet.name)).toEqual(['Renamed']);
        expect(renamed.cells).toBe(before.cells);
    });

    it('derives the workbook and anchor inputs on first use, once per structure', () => {
        const { registry, workbook, snapshots } = setup();
        const workbook_built = vi.mocked(formula_anchor_model.webview_formula_workbook);
        const inputs_built = vi.mocked(formula_anchor_model.webview_anchor_inputs);

        const snapshot = snapshots.read(workbook);
        expect(workbook_built).not.toHaveBeenCalled();
        expect(inputs_built).not.toHaveBeenCalled();

        const built = snapshot.structure.formula_workbook();
        expect(snapshot.structure.formula_workbook()).toBe(built);
        expect(workbook_built).toHaveBeenCalledTimes(1);

        // A cell edit keeps the structure, so the workbook is not built again.
        registry.for_sheet(0).commit(SESSION, '1:0', { value: 'new', base: 'old' });
        expect(snapshots.read(workbook).structure.formula_workbook()).toBe(built);
        expect(workbook_built).toHaveBeenCalledTimes(1);

        const inputs = snapshot.structure.anchor_inputs();
        expect(snapshot.structure.anchor_inputs()).toBe(inputs);
        expect(inputs_built).toHaveBeenCalledTimes(1);
    });
});

describe('use_pending_snapshot', () => {
    let container: HTMLDivElement | undefined;
    let root: Root | undefined;

    afterEach(() => {
        act(() => root?.unmount());
        container?.remove();
        root = undefined;
        container = undefined;
    });

    /**
     * Renders the count of edited cells on the first worksheet, memoized on
     * the snapshot's cells as App's Save description is, with a render count.
     */
    function render_counter(registry: EditSessionRegistry, workbook_sheets: readonly AnchorSheetMeta[]) {
        const renders = { count: 0 };
        function Counter() {
            renders.count += 1;
            const { cells } = use_pending_snapshot(registry, workbook_sheets, true);
            const edited = useMemo(() => cells.cells_for(0).size, [cells]);
            return React.createElement('output', null, String(edited));
        }
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        act(() => root!.render(React.createElement(Counter)));
        return renders;
    }

    it('re-renders a memo keyed on the cells after a link-only write', () => {
        const registry = create_edit_session_registry(() => SESSION);
        const workbook_sheets = sheets();
        registry.for_sheet(0).commit(SESSION, '1:0', { value: 'new', base: 'old' });
        render_counter(registry, workbook_sheets);
        expect(container!.textContent).toBe('1');

        act(() => registry.for_sheet(0).commit(SESSION, '2:0', LINK_ONLY));

        expect(container!.textContent).toBe('2');
    });

    it('renders once per registry change and not again without one', () => {
        const registry = create_edit_session_registry(() => SESSION);
        const renders = render_counter(registry, sheets());
        expect(renders.count).toBe(1);

        act(() => registry.for_sheet(0).commit(SESSION, '1:0', { value: 'new', base: 'old' }));
        expect(renders.count).toBe(2);

        act(() => append_row(registry, 0, 'pending-1', 1));
        expect(renders.count).toBe(3);
    });
});
