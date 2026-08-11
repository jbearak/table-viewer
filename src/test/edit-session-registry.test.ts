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

    it('retarget in place drops every other store and keeps the pointer store', () => {
        const { registry } = make_session_ref('s');
        const kept = registry.for_sheet(1);
        kept.commit('s', '0:0', { value: 'kept', base: 'a' });
        registry.for_sheet(0).commit('s', '0:0', { value: 'stale', base: 'b' });
        registry.for_sheet(2).commit('s', '0:0', { value: 'stale', base: 'c' });

        registry.retarget(1, 1);

        // The kept store keeps its identity — install notifies through it.
        expect(registry.for_sheet(1)).toBe(kept);
        expect(kept.get('0:0')).toEqual({ value: 'kept', base: 'a' });
        // The dropped sheets get fresh, empty stores on next use.
        expect(registry.for_sheet(0).size()).toBe(0);
        expect(registry.for_sheet(2).size()).toBe(0);
    });

    it('retarget carries the pointer store to its new index', () => {
        const { registry } = make_session_ref('s');
        const session_store = registry.for_sheet(1);
        session_store.commit('s', '0:0', { value: 'moving', base: 'a' });

        // The session's sheet was reordered from index 1 to index 0.
        registry.retarget(1, 0);

        // Same store object at the new index, edits intact — a reorder with no
        // install behind it (a refresh that advances the session id skips the
        // install) must not lose the user's unsaved edits.
        expect(registry.for_sheet(0)).toBe(session_store);
        expect(registry.for_sheet(0).get('0:0'))
            .toEqual({ value: 'moving', base: 'a' });
        // And nothing stale remains at the old index.
        expect(registry.for_sheet(1).size()).toBe(0);
    });

    it('retarget from a sheet with no store empties the registry', () => {
        const { registry } = make_session_ref('s');
        registry.for_sheet(0).commit('s', '0:0', { value: 'stale', base: 'a' });

        registry.retarget(3, 3);

        expect(registry.for_sheet(0).size()).toBe(0);
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
