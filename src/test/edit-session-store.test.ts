import { describe, expect, it } from 'vitest';
import { create_edit_session_store } from '../webview/edit-session-store';

// Models the paged cache: a row absent from `rows` is a page that is NOT
// resident and yields undefined, distinct from a loaded-but-blank cell ('').
function make_get_cell_raw(rows: Record<number, string[]>) {
    return (r: number, c: number): string | undefined => {
        const row = rows[r];
        if (row === undefined) return undefined;
        return row[c] ?? '';
    };
}

function count_notifications(store: ReturnType<typeof create_edit_session_store>) {
    const counter = { n: 0 };
    store.subscribe(() => { counter.n += 1; });
    return counter;
}

describe('edit session store', () => {
    it('install replaces the map and stamps the identity', () => {
        const store = create_edit_session_store(
            { session_id: 'first' },
            { '0:0': { value: 'a', base: 'A' } },
        );

        store.install({ session_id: 'second' }, { '1:1': { value: 'b', base: 'B' } });

        expect(store.identity()).toEqual({ session_id: 'second' });
        expect(Object.fromEntries(store.snapshot())).toEqual({
            '1:1': { value: 'b', base: 'B' },
        });
    });

    it('normalizes an old-format string entry to base_pending and sets the flag', () => {
        const store = create_edit_session_store({ session_id: 's' }, { '0:0': 'typed' });

        expect(store.get('0:0')).toEqual({ value: 'typed', base: '', base_pending: true });
        expect(store.has_pending_base()).toBe(true);
    });

    it('drops a mutator whose session does not match the stamp', () => {
        const store = create_edit_session_store(
            { session_id: 'current' },
            { '0:0': { value: 'a', base: 'A' } },
        );
        const notifications = count_notifications(store);

        store.commit('stale', '9:9', { value: 'x', base: 'y' });
        store.remove('stale', '0:0');
        store.clear('stale');
        store.replace('stale', {});
        store.retain('stale', () => false);
        store.remove_keys('stale', new Set(['0:0']));
        store.clear_saved('stale', { '0:0': 'a' });

        expect(Object.fromEntries(store.snapshot())).toEqual({
            '0:0': { value: 'a', base: 'A' },
        });
        expect(store.identity()).toEqual({ session_id: 'current' });
        expect(notifications.n).toBe(0);
    });

    it('treats an undefined session as a distinct value in both directions', () => {
        const granted = create_edit_session_store({ session_id: 'granted' });
        granted.commit(undefined, '0:0', { value: 'x', base: '' });
        expect(granted.size()).toBe(0);

        const ungranted = create_edit_session_store({ session_id: undefined });
        ungranted.commit('granted', '0:0', { value: 'x', base: '' });
        expect(ungranted.size()).toBe(0);
        ungranted.commit(undefined, '0:0', { value: 'x', base: '' });
        expect(ungranted.size()).toBe(1);
    });

    it('accepts any writer before an identity has ever been stamped', () => {
        const store = create_edit_session_store();
        expect(store.identity()).toBeNull();
        store.commit('anything', '0:0', { value: 'x', base: '' });
        expect(store.size()).toBe(1);
    });

    // This is the useSyncExternalStore getSnapshot contract; pin it here rather
    // than in a React test, where a violation surfaces as an infinite loop.
    it('returns an identical snapshot reference until a mutation, and a new one after', () => {
        const store = create_edit_session_store({ session_id: 's' });

        expect(store.snapshot()).toBe(store.snapshot());

        const before = store.snapshot();
        store.commit('s', '0:0', { value: 'x', base: '' });
        const after = store.snapshot();
        expect(after).not.toBe(before);
        expect(store.snapshot()).toBe(after);
    });

    it('resolve_pending_bases stays silent until the page is resident, then notifies once', () => {
        const store = create_edit_session_store({ session_id: 's' }, { '1:0': 'D' });
        const notifications = count_notifications(store);

        // Row 1 not resident: nothing to capture, so nothing to notify about —
        // get_cell_raw rebinds on every page load, so a notification here would
        // re-render on every scroll.
        store.resolve_pending_bases('s', make_get_cell_raw({ 0: ['a'] }));
        expect(notifications.n).toBe(0);
        expect(store.has_pending_base()).toBe(true);

        store.resolve_pending_bases('s', make_get_cell_raw({ 0: ['a'], 1: ['d'] }));
        expect(notifications.n).toBe(1);
        expect(store.has_pending_base()).toBe(false);
        expect(store.get('1:0')).toEqual({ value: 'D', base: 'd' });

        // Nothing pending left: a further call must not notify.
        store.resolve_pending_bases('s', make_get_cell_raw({ 0: ['a'], 1: ['d'] }));
        expect(notifications.n).toBe(1);
    });

    it('replace clears the pending-base flag', () => {
        const store = create_edit_session_store({ session_id: 's' }, { '1:0': 'D' });
        expect(store.has_pending_base()).toBe(true);

        store.replace('s', { '1:0': { value: 'D', base: 'd' } });

        expect(store.has_pending_base()).toBe(false);
        expect(store.get('1:0')).toEqual({ value: 'D', base: 'd' });
    });

    it('replace carries a still-pending entry rather than promoting its placeholder base', () => {
        // The save-lifecycle restore path reads the live map, filters it through
        // resolve_csv_save_hydration (which preserves entry objects) and hands it
        // straight back to replace. A base_pending entry's `base` is the '' set at
        // normalize time, so clearing the flag here would promote that placeholder
        // to a real base: conflict detection would compare against '' and
        // collect_exact_dirty_edits would admit the save instead of holding it.
        const store = create_edit_session_store({ session_id: 's' }, { '1:0': 'D' });
        const pending = store.get('1:0');
        expect(pending).toEqual({ value: 'D', base: '', base_pending: true });

        store.replace('s', { '5:0': { value: 'E', base: 'e' }, '1:0': pending! });

        expect(store.has_pending_base()).toBe(true);
        expect(store.get('1:0')).toEqual({ value: 'D', base: '', base_pending: true });
        expect(store.get('5:0')).toEqual({ value: 'E', base: 'e' });
    });

    it('clears the pending-base flag once the last pending entry is dropped', () => {
        // The dropping mutators used to carry the old flag forward, leaving it
        // stuck true for the rest of the session. Nothing reads the flag as
        // authority (the save gate checks per-entry base_pending), so it was
        // self-healing rather than wrong — but a stale true defeats the hot-path
        // guard in use-editing's base-capture effect, which then rescans on every
        // page load and every keystroke.
        const store = create_edit_session_store({ session_id: 's' }, {
            '1:0': 'D',
            '2:0': 'E',
        });
        expect(store.has_pending_base()).toBe(true);

        store.remove('s', '1:0');
        expect(store.has_pending_base()).toBe(true);

        store.remove('s', '2:0');
        expect(store.has_pending_base()).toBe(false);
    });

    it('clear and retain recompute the pending-base flag', () => {
        const store = create_edit_session_store({ session_id: 's' }, { '1:0': 'D' });
        store.retain('s', () => true);
        expect(store.has_pending_base()).toBe(true);

        store.retain('s', () => false);
        expect(store.has_pending_base()).toBe(false);

        store.install({ session_id: 's' }, { '1:0': 'D' });
        expect(store.has_pending_base()).toBe(true);
        store.clear('s');
        expect(store.has_pending_base()).toBe(false);
    });

    it('install carries the pending-base flag across a hydration boundary', () => {
        const store = create_edit_session_store({ session_id: 's' });
        expect(store.has_pending_base()).toBe(false);

        store.install({ session_id: 't' }, { '2:0': 'X' });
        expect(store.has_pending_base()).toBe(true);

        // A still-unresolved entry round-tripping back through the prop keeps
        // its flag; the entry itself already records base_pending.
        store.install({ session_id: 't' }, Object.fromEntries(store.snapshot()));
        expect(store.has_pending_base()).toBe(true);
    });

    it('subscribe returns a working unsubscribe', () => {
        const store = create_edit_session_store({ session_id: 's' });
        let calls = 0;
        const unsubscribe = store.subscribe(() => { calls += 1; });

        store.commit('s', '0:0', { value: 'x', base: '' });
        expect(calls).toBe(1);

        unsubscribe();
        store.commit('s', '0:1', { value: 'y', base: '' });
        expect(calls).toBe(1);
    });

    it('adopt_session re-stamps without notifying or changing contents', () => {
        const store = create_edit_session_store({ session_id: 'old' }, { '1:0': 'D' });
        const notifications = count_notifications(store);
        const before = store.snapshot();

        store.adopt_session('new');

        expect(store.identity()).toEqual({ session_id: 'new' });
        expect(store.snapshot()).toBe(before);
        expect(store.has_pending_base()).toBe(true);
        expect(notifications.n).toBe(0);

        // The adopted session is now the one that may write.
        store.commit('new', '0:0', { value: 'x', base: '' });
        expect(store.get('0:0')).toEqual({ value: 'x', base: '' });
        store.commit('old', '0:1', { value: 'y', base: '' });
        expect(store.get('0:1')).toBeUndefined();
    });

    it('clear_saved drops a saved entry and rebases one changed since', () => {
        const store = create_edit_session_store({ session_id: 's' }, {
            '0:0': { value: 'newer', base: 'a' },
            '0:1': { value: 'saved', base: 'b' },
        });

        store.clear_saved('s', { '0:0': 'sent', '0:1': 'saved' });

        expect(store.get('0:0')).toEqual({ value: 'newer', base: 'sent' });
        expect(store.get('0:1')).toBeUndefined();
    });

    it('retain filters by the caller predicate', () => {
        const store = create_edit_session_store({ session_id: 's' }, {
            '0:0': { value: 'a', base: 'A' },
            '0:1': { value: 'b', base: 'B' },
        });

        store.retain('s', (key) => key !== '0:0');

        expect(Object.fromEntries(store.snapshot())).toEqual({
            '0:1': { value: 'b', base: 'B' },
        });
    });
});
