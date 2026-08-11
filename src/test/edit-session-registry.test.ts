import { describe, expect, it } from 'vitest';
import { create_edit_session_registry } from '../webview/edit-session-registry';

describe('edit session registry', () => {
    it('returns the same store for the same sheet across calls', () => {
        const registry = create_edit_session_registry();

        const first = registry.for_sheet(0, 'session');
        first.commit('session', '0:0', { value: 'typed', base: 'A' });

        // Memoization is the hoisting guarantee: if a re-render (or a
        // generation-keyed remount) got a fresh store, the edits would be gone.
        expect(registry.for_sheet(0, 'session')).toBe(first);
        expect(registry.for_sheet(0, 'session').get('0:0'))
            .toEqual({ value: 'typed', base: 'A' });
    });

    it('gives each sheet its own store and key space', () => {
        const registry = create_edit_session_registry();

        registry.for_sheet(0, 's').commit('s', '0:0', { value: 'people', base: 'A' });
        registry.for_sheet(1, 's').commit('s', '0:0', { value: 'stock', base: 'B' });

        // Same `row:col` key, different sheets — the whole point of the registry
        // is that these never alias.
        expect(registry.for_sheet(0, 's').get('0:0'))
            .toEqual({ value: 'people', base: 'A' });
        expect(registry.for_sheet(1, 's').get('0:0'))
            .toEqual({ value: 'stock', base: 'B' });
    });

    it('stamps a store with the session it was created under', () => {
        const registry = create_edit_session_registry();

        const store = registry.for_sheet(2, 'live-session');

        expect(store.identity()).toEqual({ session_id: 'live-session' });
        // The stamp is a write fence, so it must hold from the first render on.
        store.commit('some-other-writer', '0:0', { value: 'x', base: 'y' });
        expect(store.size()).toBe(0);
    });

    it('lists entries and dirty sheets in ascending sheet order', () => {
        const registry = create_edit_session_registry();

        // Visit out of order — a save must not depend on visit order.
        registry.for_sheet(3, 's').commit('s', '0:0', { value: 'x', base: 'a' });
        registry.for_sheet(0, 's');
        registry.for_sheet(1, 's').commit('s', '2:2', { value: 'y', base: 'b' });

        expect(registry.entries().map(([sheet_index]) => sheet_index))
            .toEqual([0, 1, 3]);
        // Sheet 0 exists but is clean, so it is not dirty.
        expect(registry.dirty_sheets()).toEqual([1, 3]);
    });

    it('sums dirty cells across every sheet', () => {
        const registry = create_edit_session_registry();

        registry.for_sheet(0, 's').commit('s', '0:0', { value: 'x', base: 'a' });
        registry.for_sheet(0, 's').commit('s', '1:1', { value: 'y', base: 'b' });
        registry.for_sheet(2, 's').commit('s', '0:0', { value: 'z', base: 'c' });

        expect(registry.size()).toBe(3);
    });

    it('adopt_session re-stamps every store, including clean ones', () => {
        const registry = create_edit_session_registry();

        registry.for_sheet(0, 'old').commit('old', '0:0', { value: 'x', base: 'a' });
        const clean = registry.for_sheet(1, 'old');

        registry.adopt_session('new');

        // The clean store matters most: it was never written to under the old
        // session, but leaving it stamped 'old' would fence off the first write
        // it does receive under 'new'.
        expect(clean.identity()).toEqual({ session_id: 'new' });
        clean.commit('new', '0:0', { value: 'now writable', base: 'b' });
        expect(clean.size()).toBe(1);
        // And the dirty store's edits survive the re-stamp.
        expect(registry.for_sheet(0, 'new').get('0:0'))
            .toEqual({ value: 'x', base: 'a' });
    });

    it('reset drops every store so the next for_sheet builds fresh', () => {
        const registry = create_edit_session_registry();

        const before = registry.for_sheet(0, 'old');
        before.commit('old', '0:0', { value: 'x', base: 'a' });

        registry.reset();

        expect(registry.peek(0)).toBeUndefined();
        expect(registry.size()).toBe(0);
        const after = registry.for_sheet(0, 'new');
        expect(after).not.toBe(before);
        expect(after.size()).toBe(0);
        expect(after.identity()).toEqual({ session_id: 'new' });
    });

    it('peek does not create a store', () => {
        const registry = create_edit_session_registry();

        expect(registry.peek(5)).toBeUndefined();
        expect(registry.entries()).toEqual([]);
    });
});
