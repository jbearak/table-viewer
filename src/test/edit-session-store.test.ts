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
        // collect_save_payload would admit the save instead of holding it.
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

    // A mutation that changes nothing must not notify. Downstream a notification
    // is not cheap or side-effect-free: a React re-render via
    // useSyncExternalStore, two Object.fromEntries over the whole dirty map in
    // grid-shell, a postMessage, a host-side structuredClone and an async
    // workspace-state write — and the host's pendingEditsChanged handler clears
    // the failed-save tombstone and retires the save lifecycle, so a no-op post
    // is not purely wasted work. These tests pin the store's half of that: the
    // notification does not fire. The other half now lives elsewhere — a failed
    // save still re-installs and install force-notifies, but grid-shell dedupes
    // against the last payload it posted and the host's handler only clears the
    // tombstone for a post that genuinely supersedes the failed operation.
    describe('suppresses no-op mutations', () => {
        it('commit with an identical value and base', () => {
            const store = create_edit_session_store({ session_id: 's' }, {
                '0:0': { value: 'a', base: 'A' },
            });
            const notifications = count_notifications(store);

            store.commit('s', '0:0', { value: 'a', base: 'A' });

            expect(notifications.n).toBe(0);
            expect(Object.fromEntries(store.snapshot())).toEqual({
                '0:0': { value: 'a', base: 'A' },
            });
            expect(store.has_pending_base()).toBe(false);
        });

        it('clear on an already-empty map', () => {
            const store = create_edit_session_store({ session_id: 's' });
            const notifications = count_notifications(store);

            store.clear('s');

            expect(notifications.n).toBe(0);
            expect(store.size()).toBe(0);
            expect(store.has_pending_base()).toBe(false);
        });

        it('remove_keys matching no keys', () => {
            const store = create_edit_session_store({ session_id: 's' }, {
                '0:0': { value: 'a', base: 'A' },
            });
            const notifications = count_notifications(store);

            store.remove_keys('s', new Set(['9:9', '8:8']));

            expect(notifications.n).toBe(0);
            expect(Object.fromEntries(store.snapshot())).toEqual({
                '0:0': { value: 'a', base: 'A' },
            });
            expect(store.has_pending_base()).toBe(false);
        });

        it('retain with a predicate that keeps everything', () => {
            const store = create_edit_session_store({ session_id: 's' }, {
                '0:0': { value: 'a', base: 'A' },
                '0:1': { value: 'b', base: 'B' },
            });
            const notifications = count_notifications(store);

            store.retain('s', () => true);

            expect(notifications.n).toBe(0);
            expect(Object.fromEntries(store.snapshot())).toEqual({
                '0:0': { value: 'a', base: 'A' },
                '0:1': { value: 'b', base: 'B' },
            });
            expect(store.has_pending_base()).toBe(false);
        });

        it('clear_saved matching nothing', () => {
            const store = create_edit_session_store({ session_id: 's' }, {
                '0:0': { value: 'a', base: 'A' },
            });
            const notifications = count_notifications(store);

            store.clear_saved('s', { '9:9': 'whatever' });

            expect(notifications.n).toBe(0);
            expect(Object.fromEntries(store.snapshot())).toEqual({
                '0:0': { value: 'a', base: 'A' },
            });
            expect(store.has_pending_base()).toBe(false);
        });

        it('replace with the same contents', () => {
            const store = create_edit_session_store({ session_id: 's' }, {
                '0:0': { value: 'a', base: 'A' },
            });
            const notifications = count_notifications(store);

            store.replace('s', { '0:0': { value: 'a', base: 'A' } });

            expect(notifications.n).toBe(0);
            expect(store.has_pending_base()).toBe(false);
        });

        // base_pending is written only when true by the mutators, but `normalize`
        // stores a restored object verbatim, so an explicit `base_pending: false`
        // really can be sitting in the map while the entry a mutator builds omits
        // the field. Absent, undefined and false are the same entry, so the
        // comparison normalizes to a boolean; an === on the raw field would read
        // `false !== undefined` and notify on a rewrite that changed nothing.
        it('an entry rewritten without the explicit base_pending: false it was stored with', () => {
            const store = create_edit_session_store({ session_id: 's' }, {
                '0:0': { value: 'a', base: 'A', base_pending: false },
            });
            expect(store.get('0:0')).toEqual({ value: 'a', base: 'A', base_pending: false });
            expect(store.has_pending_base()).toBe(false);
            const notifications = count_notifications(store);

            // commit builds `{value, base}` with no flag at all.
            store.commit('s', '0:0', { value: 'a', base: 'A' });
            // ...and replace omits it for a non-pending entry, in both directions.
            store.replace('s', { '0:0': { value: 'a', base: 'A', base_pending: false } });

            expect(notifications.n).toBe(0);
            expect(store.has_pending_base()).toBe(false);
        });

        // The getSnapshot contract again, from the other side: a suppressed
        // mutation must not hand out a churning reference. The guard keeps the
        // *existing* map rather than swapping in the equal candidate, so the
        // reference is not merely stable from here on — it is the same one a
        // subscriber already read. A new-but-equal map would be tolerable (no
        // notify, so React never re-reads immediately) but it would then look like
        // a change at the next unrelated render; identity is strictly better.
        it('without churning the snapshot reference', () => {
            const store = create_edit_session_store({ session_id: 's' }, {
                '0:0': { value: 'a', base: 'A' },
            });
            const before = store.snapshot();

            store.commit('s', '0:0', { value: 'a', base: 'A' });
            store.retain('s', () => true);
            store.remove_keys('s', new Set(['9:9']));
            store.clear_saved('s', {});

            expect(store.snapshot()).toBe(before);
            expect(store.snapshot()).toBe(store.snapshot());
        });
    });

    // The other side of the guard: every real change must still notify exactly
    // once. These pass with or without the guard by design — they are the
    // regression fence that keeps a future tightening of the comparison from
    // swallowing a genuine mutation.
    describe('still notifies once for a real change', () => {
        it('commit of a new key', () => {
            const store = create_edit_session_store({ session_id: 's' });
            const notifications = count_notifications(store);

            store.commit('s', '0:0', { value: 'a', base: 'A' });

            expect(notifications.n).toBe(1);
        });

        it('commit that changes only the value', () => {
            const store = create_edit_session_store({ session_id: 's' }, {
                '0:0': { value: 'a', base: 'A' },
            });
            const notifications = count_notifications(store);

            store.commit('s', '0:0', { value: 'a2', base: 'A' });

            expect(notifications.n).toBe(1);
            expect(store.get('0:0')).toEqual({ value: 'a2', base: 'A' });
        });

        // `base` drives conflict detection (is_entry_conflicted compares the
        // current cell against it), so a base-only rebase is a real change even
        // though the displayed value is identical. An equality check that only
        // looked at `value` would suppress this and leave conflict detection
        // judging against a stale base.
        it('commit that changes only the base', () => {
            const store = create_edit_session_store({ session_id: 's' }, {
                '0:0': { value: 'a', base: 'A' },
            });
            const notifications = count_notifications(store);

            store.commit('s', '0:0', { value: 'a', base: 'A2' });

            expect(notifications.n).toBe(1);
            expect(store.get('0:0')).toEqual({ value: 'a', base: 'A2' });
        });

        it('clear on a non-empty map', () => {
            const store = create_edit_session_store({ session_id: 's' }, {
                '0:0': { value: 'a', base: 'A' },
            });
            const notifications = count_notifications(store);

            store.clear('s');

            expect(notifications.n).toBe(1);
            expect(store.size()).toBe(0);
        });

        it('remove_keys matching one of two keys', () => {
            const store = create_edit_session_store({ session_id: 's' }, {
                '0:0': { value: 'a', base: 'A' },
                '0:1': { value: 'b', base: 'B' },
            });
            const notifications = count_notifications(store);

            store.remove_keys('s', new Set(['0:0', '9:9']));

            expect(notifications.n).toBe(1);
            expect(Object.fromEntries(store.snapshot())).toEqual({
                '0:1': { value: 'b', base: 'B' },
            });
        });

        it('retain that drops one of two entries', () => {
            const store = create_edit_session_store({ session_id: 's' }, {
                '0:0': { value: 'a', base: 'A' },
                '0:1': { value: 'b', base: 'B' },
            });
            const notifications = count_notifications(store);

            store.retain('s', (key) => key !== '0:0');

            expect(notifications.n).toBe(1);
            expect(Object.fromEntries(store.snapshot())).toEqual({
                '0:1': { value: 'b', base: 'B' },
            });
        });

        it('clear_saved that rebases an entry changed since the send', () => {
            const store = create_edit_session_store({ session_id: 's' }, {
                '0:0': { value: 'newer', base: 'a' },
            });
            const notifications = count_notifications(store);

            store.clear_saved('s', { '0:0': 'sent' });

            expect(notifications.n).toBe(1);
            expect(store.get('0:0')).toEqual({ value: 'newer', base: 'sent' });
        });

        it('clear_saved that drops a saved entry', () => {
            const store = create_edit_session_store({ session_id: 's' }, {
                '0:0': { value: 'saved', base: 'a' },
            });
            const notifications = count_notifications(store);

            store.clear_saved('s', { '0:0': 'saved' });

            expect(notifications.n).toBe(1);
            expect(store.size()).toBe(0);
        });

        // Equal sizes with a different key set: the single forward pass has to
        // catch this, and does — a key of `prev` missing from `next` forces some
        // key of `next` to be missing from `prev`.
        it('a same-size replace that swaps which key is dirty', () => {
            const store = create_edit_session_store({ session_id: 's' }, {
                '0:0': { value: 'a', base: 'A' },
            });
            const notifications = count_notifications(store);

            store.replace('s', { '0:1': { value: 'a', base: 'A' } });

            expect(notifications.n).toBe(1);
            expect(Object.fromEntries(store.snapshot())).toEqual({
                '0:1': { value: 'a', base: 'A' },
            });
        });

        // Contents identical, base_pending flipped: the flag gates the base-capture
        // effect's hot-path guard and the save gate, so it is part of the state the
        // guard compares, not just a derived hint.
        it('a replace that only sets base_pending', () => {
            const store = create_edit_session_store({ session_id: 's' }, {
                '0:0': { value: 'a', base: 'A' },
            });
            const notifications = count_notifications(store);

            store.replace('s', { '0:0': { value: 'a', base: 'A', base_pending: true } });

            expect(notifications.n).toBe(1);
            expect(store.has_pending_base()).toBe(true);
        });

        // install crosses a hydration boundary and re-stamps the session, so it
        // notifies unconditionally — it runs once per grant or restore, never on a
        // keystroke, and a silently-swallowed install is the kind of bug that
        // surfaces as a grid that never re-reads.
        it('install with an identical map', () => {
            const store = create_edit_session_store({ session_id: 's' }, {
                '0:0': { value: 'a', base: 'A' },
            });
            const notifications = count_notifications(store);

            store.install({ session_id: 't' }, { '0:0': { value: 'a', base: 'A' } });

            expect(notifications.n).toBe(1);
            expect(store.identity()).toEqual({ session_id: 't' });
        });
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
