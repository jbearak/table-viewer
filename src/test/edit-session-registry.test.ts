import { describe, expect, it } from 'vitest';
import { create_edit_session_registry } from '../webview/edit-session-registry';

// Stands in for App's session id ref: one mutable authoritative value the
// registry reads through the injected getter, exactly as production does.
function make_session_ref(initial?: string) {
    const ref = { current: initial as string | undefined };
    return {
        ref,
        registry: create_edit_session_registry(() => ref.current),
    };
}

describe('edit session registry', () => {
    it('publishes mutations from inactive worksheet stores through one revision', () => {
        const { registry } = make_session_ref('session');
        const revisions: number[] = [];
        const unsubscribe = registry.subscribe(() => revisions.push(registry.revision()));

        registry.for_sheet(1).commit('session', '4:2', { value: 'changed', base: 'old' });
        registry.for_sheet(0).commit('session', '0:0', { value: 'front', base: 'back' });
        unsubscribe();

        expect(revisions).toEqual([1, 2]);
    });

    it('projects ordered move provenance across worksheet stores', () => {
        const { registry } = make_session_ref('session');
        registry.for_sheet(1).commit('session', '2:3', {
            value: 'moved',
            base: 'old',
            movedFrom: { row: 0, col: 1, order: 7 },
            valueEditOrder: 7,
        });

        expect(registry.formula_projection().moves).toEqual([{
            sheetIndex: 1,
            sourceRow: 0,
            sourceColumn: 1,
            destinationRow: 2,
            destinationColumn: 3,
            order: 7,
        }]);
    });

    it('caches move projections until a store changes', () => {
        const { registry } = make_session_ref('session');
        const empty = registry.formula_projection().moves;
        expect(registry.formula_projection().moves).toBe(empty);

        registry.for_sheet(0).commit('session', '2:3', {
            value: 'moved',
            base: 'old',
            movedFrom: { row: 0, col: 1, order: 7 },
        });
        const moved = registry.formula_projection().moves;

        expect(moved).not.toBe(empty);
        expect(registry.formula_projection().moves).toBe(moved);
        expect(moved).toHaveLength(1);
    });

    it('refreshes cached moves when only move provenance changes', () => {
        const { registry } = make_session_ref('session');
        const store = registry.for_sheet(0);

        store.commit('session', '2:3', {
            value: 'same',
            base: 'same',
            movedFrom: { row: 0, col: 1, order: 7 },
            valueEditOrder: 7,
        });
        expect(registry.formula_projection().moves).toEqual([{
            sheetIndex: 0,
            sourceRow: 0,
            sourceColumn: 1,
            destinationRow: 2,
            destinationColumn: 3,
            order: 7,
        }]);

        store.commit('session', '2:3', { value: 'same', base: 'same' });
        expect(registry.formula_projection().moves).toEqual([]);
    });

    it('updates formula inputs incrementally without revisiting unchanged dirty cells', () => {
        const { registry } = make_session_ref('session');
        const store = registry.for_sheet(0);
        store.commit('session', '4:2', { value: 'first', base: 'old' });
        const first = registry.formula_projection();

        expect(first.edits).toEqual([{
            sheetIndex: 0,
            row: 4,
            column: 2,
            value: 'first',
            writesFormula: false,
        }]);
        store.commit('session', '4:2', { value: '=1', base: 'old' });
        const second = registry.formula_projection();

        expect(second.edits).not.toBe(first.edits);
        expect(second.coordinateRevision).toBe(first.coordinateRevision);
        expect(second.calculationRevision).toBeGreaterThan(first.calculationRevision);
        expect(second.hasFormulaEdits).toBe(true);
        expect(second.edits).toEqual([{
            sheetIndex: 0,
            row: 4,
            column: 2,
            value: '=1',
            writesFormula: true,
        }]);
    });

    it('keeps an earlier formula projection stable after a later edit', () => {
        const { registry } = make_session_ref('session');
        const store = registry.for_sheet(0);
        store.commit('session', '4:2', { value: 'first', base: 'old' });
        const first = registry.formula_projection();

        store.commit('session', '4:2', { value: 'second', base: 'old' });

        expect(first.edits).toEqual([{
            sheetIndex: 0,
            row: 4,
            column: 2,
            value: 'first',
            writesFormula: false,
        }]);
    });

    it('classifies formula-shaped rich text by the eventual writer rule', () => {
        const { registry } = make_session_ref('session');
        registry.for_sheet(0).commit('session', '0:0', {
            value: '=1+1',
            base: 'old',
            valueRuns: { runs: [{ text: '=1+1', style: { bold: true } }] },
        });

        expect(registry.formula_projection()).toMatchObject({
            hasFormulaEdits: false,
            edits: [{ value: '=1+1', writesFormula: false }],
        });
    });

    it('advances rich value inputs but ignores hyperlink-only writes', () => {
        const { registry } = make_session_ref('session');
        const store = registry.for_sheet(0);
        store.commit('session', '0:0', { value: 'changed', base: 'old' });
        const before = registry.formula_projection();

        store.commit('session', '1:0', {
            value: 'same',
            base: 'same',
            valueRuns: { runs: [{ text: 'same', style: { bold: true } }] },
        });
        const after_runs = registry.formula_projection();
        expect(after_runs.coordinateRevision).toBeGreaterThan(before.coordinateRevision);
        expect(after_runs.calculationRevision).toBeGreaterThan(before.calculationRevision);
        expect(after_runs.edits[1]).toMatchObject({
            sheetIndex: 0,
            row: 1,
            column: 0,
            value: 'same',
            runs: [{ text: 'same', style: { bold: true } }],
        });

        store.commit('session', '2:0', {
            value: 'same',
            base: 'same',
            link: { kind: 'external', target: 'https://example.com' },
            baseLink: null,
        });
        const after = registry.formula_projection();

        expect(after.coordinateRevision).toBe(after_runs.coordinateRevision);
        expect(after.calculationRevision).toBe(after_runs.calculationRevision);
        expect(after.edits).toEqual(after_runs.edits);
    });

    it('returns the same store for the same sheet across calls', () => {
        const { registry } = make_session_ref('session');

        const first = registry.for_sheet(0);
        first.commit('session', '0:0', { value: 'typed', base: 'A' });

        // Memoization is the hoisting guarantee: if a re-render (or a
        // generation-keyed remount) got a fresh store, the edits would be gone.
        expect(registry.for_sheet(0)).toBe(first);
        expect(registry.for_sheet(0).get('0:0'))
            .toEqual({ value: 'typed', base: 'A' });
    });

    it('gives each sheet its own store and key space', () => {
        const { registry } = make_session_ref('s');

        registry.for_sheet(0).commit('s', '0:0', { value: 'people', base: 'A' });
        registry.for_sheet(1).commit('s', '0:0', { value: 'stock', base: 'B' });

        // Same `row:col` key, different sheets — the whole point of the registry
        // is that these never alias.
        expect(registry.for_sheet(0).get('0:0'))
            .toEqual({ value: 'people', base: 'A' });
        expect(registry.for_sheet(1).get('0:0'))
            .toEqual({ value: 'stock', base: 'B' });
    });

    it('stamps a store with the session current at its creation', () => {
        const { registry } = make_session_ref('live-session');

        const store = registry.for_sheet(2);

        expect(store.identity()).toEqual({ session_id: 'live-session' });
        // The stamp is a write fence, so it must hold from the first render on.
        store.commit('some-other-writer', '0:0', { value: 'x', base: 'y' });
        expect(store.size()).toBe(0);
    });

    it('a session move re-stamps new stores only, until adopt_session', () => {
        const { ref, registry } = make_session_ref('old');
        const before = registry.for_sheet(0);

        ref.current = 'new';

        // The existing store keeps its stamp until adopt_session: until the
        // render under the new id commits, the on-screen grid is still the old
        // session's, and its unmount-time folds must still land.
        expect(before.identity()).toEqual({ session_id: 'old' });
        before.commit('old', '0:0', { value: 'late fold', base: 'a' });
        expect(before.size()).toBe(1);
        // A store built after the move is fenced onto the new session at once.
        expect(registry.for_sheet(1).identity()).toEqual({ session_id: 'new' });
    });

    it('reconcile_sheets carries every store to where its sheet went, dropping unretained deletions', () => {
        const { registry } = make_session_ref('s');
        const people = registry.for_sheet(0);
        people.commit('s', '0:0', { value: 'people', base: 'a' });
        const stock = registry.for_sheet(1);
        stock.commit('s', '0:0', { value: 'stock', base: 'b' });
        registry.for_sheet(2).commit('s', '0:0', { value: 'gone', base: 'c' });

        // A reorder swapped sheets 0 and 1 and deleted sheet 2.
        registry.reconcile_sheets(
            [
                { name: 'People', worksheetId: '1' },
                { name: 'Stock', worksheetId: '2' },
                { name: 'Gone', worksheetId: '3' },
            ],
            [
                { name: 'Stock', worksheetId: '2' },
                { name: 'People', worksheetId: '1' },
            ],
            () => false,
        );

        // Same store objects at their new indices, edits intact — the session is
        // workbook-scoped, so *every* sheet's edits must follow their sheet, not
        // just the pointer sheet's. Object identity survives the move: install
        // notifies through it.
        expect(registry.for_sheet(1)).toBe(people);
        expect(registry.for_sheet(1).get('0:0'))
            .toEqual({ value: 'people', base: 'a' });
        expect(registry.for_sheet(0)).toBe(stock);
        expect(registry.for_sheet(0).get('0:0'))
            .toEqual({ value: 'stock', base: 'b' });
        // The deleted sheet's store went with it.
        expect(registry.for_sheet(2).size()).toBe(0);
    });

    it('retains and republishes live stores that follow a worksheet reorder', () => {
        const { registry } = make_session_ref('s');
        const people = registry.for_sheet(0);
        people.commit('s', '0:0', { value: 'draft', base: 'a' });

        const result = registry.reconcile_sheets(
            [
                { name: 'People', worksheetId: '1' },
                { name: 'Stock', worksheetId: '2' },
            ],
            [
                { name: 'Stock', worksheetId: '2' },
                { name: 'People', worksheetId: '1' },
            ],
            (_target, store) => store.size() > 0,
        );

        expect(registry.for_sheet(1)).toBe(people);
        expect(result.locallyRetainedIndices).toEqual(new Set([1]));
        expect(result.retryPublications).toEqual([{
            target: { sheetIndex: 1, sheetName: 'People', worksheetId: '1' },
            store: people,
        }]);
    });

    it('uses the shared first-match policy when worksheet IDs collide', () => {
        const { registry } = make_session_ref('s');
        const store = registry.for_sheet(0);
        store.commit('s', '0:0', { value: 'draft', base: 'a' });

        registry.reconcile_sheets(
            [{ name: 'Original', worksheetId: 'duplicate' }],
            [
                { name: 'First', worksheetId: 'duplicate' },
                { name: 'Second', worksheetId: 'duplicate' },
            ],
            () => true,
        );

        expect(registry.for_sheet(0)).toBe(store);
        expect(registry.for_sheet(1)).not.toBe(store);
    });

    it('parks rather than drops a store that collides with a reattached store', () => {
        const { registry } = make_session_ref('s');
        const parked = registry.for_sheet(0);
        parked.commit('s', '0:0', { value: 'old', base: 'a' });
        registry.reconcile_sheets([{ name: 'Data' }], [], () => true);

        const live = registry.for_sheet(0);
        live.commit('s', '0:0', { value: 'new', base: 'a' });
        registry.reconcile_sheets(
            [{ name: 'Data' }],
            [{ name: 'Data' }],
            () => true,
        );

        const publications = [...registry.publication_entries([{ name: 'Data' }])];
        expect(publications).toHaveLength(2);
        expect(publications.map(({ store }) => store)).toContain(parked);
        expect(publications.map(({ store }) => store)).toContain(live);
        expect(publications.filter(({ parked }) => parked)).toHaveLength(1);
    });

    it('preflights immutable dirty live worksheet payloads deterministically', () => {
        const { registry } = make_session_ref('s');
        const later = registry.for_sheet(2);
        later.commit('s', '2:0', { value: 'live two', base: 'old two' });
        const live = registry.for_sheet(0);
        live.commit('s', '1:1', { value: 'live zero', base: 'live old' });
        registry.for_sheet(1); // clean stores are excluded

        const collected = registry.collect_dirty_worksheets([
            { name: 'Live Zero', worksheetId: 'live-0' },
            { name: 'Clean' },
            { name: 'Live Two' },
        ]);

        expect(collected).toEqual({
            status: 'ready',
            worksheets: [
                {
                    target: { sheetIndex: 0, sheetName: 'Live Zero', worksheetId: 'live-0' },
                    edits: { '1:1': 'live zero' },
                    dirtyEdits: { '1:1': { value: 'live zero', base: 'live old' } },
                },
                {
                    target: { sheetIndex: 2, sheetName: 'Live Two' },
                    edits: { '2:0': 'live two' },
                    dirtyEdits: { '2:0': { value: 'live two', base: 'old two' } },
                },
            ],
        });
        expect(Object.isFrozen(collected)).toBe(true);
        expect(collected.status).toBe('ready');
        if (collected.status !== 'ready') throw new Error('expected ready');
        expect(Object.isFrozen(collected.worksheets)).toBe(true);
        expect(Object.isFrozen(collected.worksheets[0])).toBe(true);
        expect(Object.isFrozen(collected.worksheets[0].target)).toBe(true);
        expect(Object.isFrozen(collected.worksheets[0].edits)).toBe(true);
        expect(Object.isFrozen(collected.worksheets[0].dirtyEdits)).toBe(true);
        expect(Object.isFrozen(collected.worksheets[0].dirtyEdits['1:1'])).toBe(true);

        live.commit('s', '1:1', { value: 'changed later', base: 'live old' });
        expect(collected.worksheets[0].edits['1:1']).toBe('live zero');
        expect(collected.worksheets[0].dirtyEdits['1:1'].value).toBe('live zero');
    });

    it('blocks the whole save when any dirty live worksheet has unresolved bases', () => {
        const { registry } = make_session_ref('s');
        registry.for_sheet(0).commit('s', '0:0', { value: 'ready', base: 'old' });
        registry.for_sheet(1).replace('s', {
            '1:0': { value: 'pending', base: '', base_pending: true },
        });

        expect(registry.collect_dirty_worksheets([
            { name: 'Ready' },
            { name: 'Pending', worksheetId: 'pending-id' },
        ])).toEqual({
            status: 'blocked',
            reason: 'unresolvedBases',
            targets: [{ sheetIndex: 1, sheetName: 'Pending', worksheetId: 'pending-id' }],
        });
    });

    it('blocks the whole save when a removed worksheet still has dirty parked edits', () => {
        const { registry } = make_session_ref('s');
        registry.for_sheet(0).commit('s', '0:0', { value: 'parked', base: 'old' });
        registry.reconcile_sheets([{ name: 'Removed', worksheetId: 'gone' }], [], () => true);
        registry.for_sheet(0).commit('s', '1:0', { value: 'live', base: 'old' });

        expect(registry.collect_dirty_worksheets([{ name: 'Live' }])).toEqual({
            status: 'blocked',
            reason: 'parkedEdits',
            targets: [{ sheetIndex: 0, sheetName: 'Removed', worksheetId: 'gone' }],
        });
    });

    it('reports dirty state across live and parked worksheet stores', () => {
        const { registry } = make_session_ref('s');
        expect(registry.has_dirty_entries()).toBe(false);

        const live = registry.for_sheet(0);
        live.commit('s', '0:0', { value: 'live', base: 'old' });
        expect(registry.has_dirty_entries()).toBe(true);

        live.clear('s');
        expect(registry.has_dirty_entries()).toBe(false);
        live.commit('s', '0:0', { value: 'parked', base: 'old' });
        registry.reconcile_sheets([{ name: 'Removed' }], [], () => true);
        expect(registry.has_dirty_entries()).toBe(true);

        registry.retire_parked();
        expect(registry.has_dirty_entries()).toBe(false);
    });

    it('replace_document drops every store', () => {
        const { registry } = make_session_ref('s');
        registry.for_sheet(0).commit('s', '0:0', { value: 'old file', base: 'a' });
        registry.for_sheet(1).commit('s', '0:0', { value: 'old file', base: 'b' });

        registry.replace_document();

        // A different document replaced this one; a surviving store would be
        // another file's edits waiting to leak through an index collision.
        expect(registry.for_sheet(0).size()).toBe(0);
        expect(registry.for_sheet(1).size()).toBe(0);
    });

    it('clear_all empties every store but keeps their identities', () => {
        const { registry } = make_session_ref('s');
        const first = registry.for_sheet(0);
        first.commit('s', '0:0', { value: 'x', base: 'a' });
        const second = registry.for_sheet(1);
        second.commit('s', '0:0', { value: 'y', base: 'b' });

        registry.clear_all('s');

        // A discard ends the workbook-scoped session: every sheet's local edits
        // go at once, but the store objects survive — mounted grids subscribe
        // through them.
        expect(registry.for_sheet(0)).toBe(first);
        expect(registry.for_sheet(1)).toBe(second);
        expect(first.size()).toBe(0);
        expect(second.size()).toBe(0);
    });

    describe('stage_discard', () => {
        const SHEETS = [
            { name: 'People', worksheetId: '1' },
            { name: 'Stock', worksheetId: '2' },
        ];

        it('snapshots every sheet\'s edits and empties them at the commit', () => {
            const { registry } = make_session_ref('s');
            registry.for_sheet(0).commit('s', '0:0', { value: 'x', base: 'a' });
            registry.for_sheet(1).commit('s', '3:4', { value: 'y', base: 'b' });

            const staged = registry.stage_discard('s', SHEETS)!;
            // Nothing has moved: the caller still has the history recording to
            // stage and validate.
            expect(registry.for_sheet(0).size()).toBe(1);

            expect(staged.worksheets.map((sheet) => [
                sheet.target.sheetName,
                [...sheet.entries.keys()],
            ])).toEqual([['People', ['0:0']], ['Stock', ['3:4']]]);

            for (const mutation of staged.mutations) mutation.commit();
            expect(registry.for_sheet(0).size()).toBe(0);
            expect(registry.for_sheet(1).size()).toBe(0);
        });

        it('omits a clean sheet from the snapshot but still stages it', () => {
            const { registry } = make_session_ref('s');
            registry.for_sheet(0).commit('s', '0:0', { value: 'x', base: 'a' });
            registry.for_sheet(1);

            const staged = registry.stage_discard('s', SHEETS)!;

            expect(staged.worksheets).toHaveLength(1);
            expect(staged.mutations).toHaveLength(2);
        });

        it('records the whole worksheet target, never a bare index', () => {
            const { registry } = make_session_ref('s');
            registry.for_sheet(1).commit('s', '0:0', { value: 'y', base: 'b' });

            const staged = registry.stage_discard('s', SHEETS)!;

            expect(staged.worksheets[0].target)
                .toEqual({ sheetIndex: 1, sheetName: 'Stock', worksheetId: '2' });
        });

        it('empties a store whose sheet is gone without naming it in history', () => {
            // A discard empties everything, but a store with no sheet left has no
            // identity an undo could be authorized against.
            const { registry } = make_session_ref('s');
            registry.for_sheet(0).commit('s', '0:0', { value: 'x', base: 'a' });
            registry.for_sheet(5).commit('s', '0:0', { value: 'orphan', base: 'b' });

            const staged = registry.stage_discard('s', SHEETS)!;

            expect(staged.worksheets.map((sheet) => sheet.target.sheetName)).toEqual(['People']);
            for (const mutation of staged.mutations) mutation.commit();
            expect(registry.for_sheet(5).size()).toBe(0);
        });

        it('stages nothing at all when a store refuses', () => {
            // One gesture: emptying the sheets that would still take it leaves
            // half a session.
            const { registry } = make_session_ref('s');
            const store = registry.for_sheet(0);
            store.commit('s', '0:0', { value: 'x', base: 'a' });

            expect(registry.stage_discard('stale', SHEETS)).toBeUndefined();
            expect(store.size()).toBe(1);
        });

        it('hands back a snapshot the commit cannot empty under it', () => {
            // `snapshot()` returns the store's own map by reference, so this holds
            // only because every mutator REPLACES the map rather than mutating it.
            // If one ever cleared in place, the discard would record an empty
            // gesture and the edits would be unrecoverable.
            const { registry } = make_session_ref('s');
            registry.for_sheet(0).commit('s', '0:0', { value: 'x', base: 'a' });

            const staged = registry.stage_discard('s', SHEETS)!;
            for (const mutation of staged.mutations) mutation.commit();

            expect([...staged.worksheets[0].entries.entries()])
                .toEqual([['0:0', { value: 'x', base: 'a' }]]);
        });

        it('reports a snapshot taken at the instant it fixed the state', () => {
            // The reason snapshot and stage are one call. A keystroke landing
            // between them would be missing from the recorded action, so undoing
            // the discard would restore everything except the user's last edit —
            // and the store's own valid() could not catch it, having been taken
            // against a state that already included it.
            const { registry } = make_session_ref('s');
            const store = registry.for_sheet(0);
            store.commit('s', '0:0', { value: 'x', base: 'a' });

            const staged = registry.stage_discard('s', SHEETS)!;
            store.commit('s', '9:9', { value: 'meanwhile', base: 'c' });

            expect([...staged.worksheets[0].entries.keys()]).toEqual(['0:0']);
            // And the staging is invalid, so the caller abandons rather than
            // discarding an edit it never recorded.
            expect(staged.mutations.every((mutation) => mutation.valid())).toBe(false);
        });
    });

    it('clear_all respects the session fence', () => {
        const { registry } = make_session_ref('s');
        const store = registry.for_sheet(0);
        store.commit('s', '0:0', { value: 'x', base: 'a' });

        registry.clear_all('someone-else');

        // A clear from a stale writer is dropped by each store's own fence.
        expect(store.size()).toBe(1);
    });

    it('adopt_session re-stamps every existing store, including clean ones', () => {
        const { ref, registry } = make_session_ref('old');
        const dirty = registry.for_sheet(0);
        dirty.commit('old', '0:0', { value: 'x', base: 'a' });
        const clean = registry.for_sheet(1);

        ref.current = 'new';
        registry.adopt_session();

        // The clean store matters most: it was never written to under the old
        // session, but leaving it stamped 'old' would fence off the first write
        // it does receive under 'new'.
        expect(clean.identity()).toEqual({ session_id: 'new' });
        clean.commit('new', '0:0', { value: 'now writable', base: 'b' });
        expect(clean.size()).toBe(1);
        // And the dirty store's edits survive the re-stamp.
        expect(dirty.get('0:0')).toEqual({ value: 'x', base: 'a' });
    });
});
