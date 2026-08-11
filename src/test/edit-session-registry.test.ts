import { describe, expect, it } from 'vitest';
import { create_edit_session_registry } from '../webview/edit-session-registry';

describe('edit session registry', () => {
    it('returns the same store for the same sheet across calls', () => {
        const registry = create_edit_session_registry();
        registry.set_session('session');

        const first = registry.for_sheet(0);
        first.commit('session', '0:0', { value: 'typed', base: 'A' });

        // Memoization is the hoisting guarantee: if a re-render (or a
        // generation-keyed remount) got a fresh store, the edits would be gone.
        expect(registry.for_sheet(0)).toBe(first);
        expect(registry.for_sheet(0).get('0:0'))
            .toEqual({ value: 'typed', base: 'A' });
    });

    it('gives each sheet its own store and key space', () => {
        const registry = create_edit_session_registry();
        registry.set_session('s');

        registry.for_sheet(0).commit('s', '0:0', { value: 'people', base: 'A' });
        registry.for_sheet(1).commit('s', '0:0', { value: 'stock', base: 'B' });

        // Same `row:col` key, different sheets — the whole point of the registry
        // is that these never alias.
        expect(registry.for_sheet(0).get('0:0'))
            .toEqual({ value: 'people', base: 'A' });
        expect(registry.for_sheet(1).get('0:0'))
            .toEqual({ value: 'stock', base: 'B' });
    });

    it('stamps a store with the session it was created under', () => {
        const registry = create_edit_session_registry();
        registry.set_session('live-session');

        const store = registry.for_sheet(2);

        expect(store.identity()).toEqual({ session_id: 'live-session' });
        // The stamp is a write fence, so it must hold from the first render on.
        store.commit('some-other-writer', '0:0', { value: 'x', base: 'y' });
        expect(store.size()).toBe(0);
    });

    it('set_session moves the stamp for new stores only', () => {
        const registry = create_edit_session_registry();
        registry.set_session('old');
        const before = registry.for_sheet(0);

        registry.set_session('new');

        // The existing store keeps its stamp until adopt_session: until the
        // render under the new id commits, the on-screen grid is still the old
        // session's, and its unmount-time folds must still land.
        expect(before.identity()).toEqual({ session_id: 'old' });
        before.commit('old', '0:0', { value: 'late fold', base: 'a' });
        expect(before.size()).toBe(1);
        // A store built after the move is fenced onto the new session at once.
        expect(registry.for_sheet(1).identity()).toEqual({ session_id: 'new' });
    });

    it('adopt_session re-stamps every existing store, including clean ones', () => {
        const registry = create_edit_session_registry();
        registry.set_session('old');
        const dirty = registry.for_sheet(0);
        dirty.commit('old', '0:0', { value: 'x', base: 'a' });
        const clean = registry.for_sheet(1);

        registry.set_session('new');
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
