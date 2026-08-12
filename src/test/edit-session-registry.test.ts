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
