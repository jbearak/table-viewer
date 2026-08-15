import { describe, it, expect } from 'vitest';
import {
    DEFAULT_ROW_HEIGHT_PX,
    MAX_ROW_HEIGHT_LAYERS,
    MAX_ROW_HEIGHT_PX,
    MIN_ROW_HEIGHT_PX,
    clamp_row_height,
    mapped_row_height_overlays,
    natural_row_height,
    resolved_row_height,
    retained_row_height_overlay,
    row_height,
    row_height_layers_for_delivery,
    row_height_layers_with,
    set_row_height,
    span_height,
    type RowHeightLayer,
} from '../webview/row-heights';
import { MAX_PERSISTED_ROW_HEIGHTS } from '../types';

describe('row-heights', () => {
    it('row_height returns the override when present, default otherwise', () => {
        expect(row_height({}, 5)).toBe(DEFAULT_ROW_HEIGHT_PX);
        expect(row_height({ 5: 60 }, 5)).toBe(60);
        expect(row_height({ 5: 60 }, 6)).toBe(DEFAULT_ROW_HEIGHT_PX);
    });

    it('row_height honors a caller-supplied default', () => {
        expect(row_height({}, 0, 30)).toBe(30);
        expect(row_height({ 0: 50 }, 0, 30)).toBe(50);
    });

    it('span_height sums inclusive row heights with mixed overrides', () => {
        // rows 2,3,4 — row 3 overridden to 40, others default (24).
        expect(span_height({ 3: 40 }, 2, 4)).toBe(24 + 40 + 24);
    });

    it('span_height of a single row equals that row height', () => {
        expect(span_height({ 7: 33 }, 7, 7)).toBe(33);
        expect(span_height({}, 7, 7)).toBe(DEFAULT_ROW_HEIGHT_PX);
    });

    it('clamp_row_height enforces the minimum', () => {
        expect(clamp_row_height(5)).toBe(MIN_ROW_HEIGHT_PX);
        expect(clamp_row_height(MIN_ROW_HEIGHT_PX)).toBe(MIN_ROW_HEIGHT_PX);
        expect(clamp_row_height(100)).toBe(100);
    });

    it('clamp_row_height enforces the maximum', () => {
        // The ceiling is not symmetry with the floor: without it a row can be grown past
        // any viewport that could show its bottom edge, which leaves the boundary needed to
        // drag it back unreachable — the same dead end the floor exists to prevent, from
        // the other direction. Reachable by accident rather than only by a malformed
        // message: `natural_row_height` grows with the number of hard newlines in a cell
        // and is unbounded, which is why the auto-grow path clamps through here too.
        expect(clamp_row_height(MAX_ROW_HEIGHT_PX + 1)).toBe(MAX_ROW_HEIGHT_PX);
        expect(clamp_row_height(MAX_ROW_HEIGHT_PX)).toBe(MAX_ROW_HEIGHT_PX);
        expect(clamp_row_height(1e300)).toBe(MAX_ROW_HEIGHT_PX);
        expect(clamp_row_height(MAX_ROW_HEIGHT_PX - 1)).toBe(MAX_ROW_HEIGHT_PX - 1);
    });

    it('clamps an unbounded multiline natural height into the persistable range', () => {
        // The realistic route to the ceiling, end to end: a cell with far more hard
        // newlines than any row can show. `natural_row_height` answers honestly and
        // unboundedly; the clamp is what stops that answer reaching durable state.
        const many_lines = 'x\n'.repeat(5_000);
        expect(natural_row_height(many_lines, 18, 6)).toBeGreaterThan(MAX_ROW_HEIGHT_PX);
        expect(clamp_row_height(natural_row_height(many_lines, 18, 6)))
            .toBe(MAX_ROW_HEIGHT_PX);
    });

    it('set_row_height returns a new record, clamped, without mutating input', () => {
        const before = { 1: 30 };
        const after = set_row_height(before, 2, 8);
        expect(after).toEqual({ 1: 30, 2: MIN_ROW_HEIGHT_PX });
        expect(before).toEqual({ 1: 30 }); // unchanged
    });

    it('set_row_height overwrites an existing override', () => {
        expect(set_row_height({ 4: 30 }, 4, 80)).toEqual({ 4: 80 });
    });

    describe('natural_row_height', () => {
        it('returns the default height for single-line text', () => {
            expect(natural_row_height('hello', 18, 6)).toBe(DEFAULT_ROW_HEIGHT_PX);
        });

        it('treats empty text as a single line', () => {
            expect(natural_row_height('', 18, 6)).toBe(DEFAULT_ROW_HEIGHT_PX);
        });

        it('grows with each explicit newline', () => {
            expect(natural_row_height('a\nb', 18, 6)).toBe(2 * 18 + 6);
            expect(natural_row_height('a\nb\nc', 18, 6)).toBe(3 * 18 + 6);
        });

        it('counts a trailing newline as an extra line', () => {
            expect(natural_row_height('a\n', 18, 6)).toBe(2 * 18 + 6);
        });

        it('grows identically for LF, CRLF, and bare CR breaks (#202)', () => {
            expect(natural_row_height('a\r\nb', 18, 6)).toBe(2 * 18 + 6);
            expect(natural_row_height('a\rb', 18, 6)).toBe(2 * 18 + 6);
            expect(natural_row_height('a\rb\nc\r\nd', 18, 6)).toBe(4 * 18 + 6);
        });

        it('honors custom line height and padding', () => {
            expect(natural_row_height('a\nb', 30, 10)).toBe(2 * 30 + 10);
        });

        it('never returns below the default height', () => {
            // Tiny line metrics still clamp up to the default single-row height.
            expect(natural_row_height('a\nb', 5, 0)).toBe(DEFAULT_ROW_HEIGHT_PX);
        });
    });
});

/**
 * The optimistic overlay that sits over the host's delivered, display-keyed projection
 * while a `setRowHeights` is in flight. Every assertion below was checked against the
 * inverse of the production line it pins.
 */
describe('the optimistic row-height overlay', () => {
    const layer = (
        rows: readonly { start: number; end: number }[],
        height: number,
    ): RowHeightLayer => ({ rows, height });

    /**
     * A select-all interval that reports on how it was read.
     *
     * The claim being pinned is that these helpers cost O(intervals) and O(projection),
     * never O(rows) — the reason a layer is held as intervals at all, since a resize
     * commits the user's whole row selection and a sheet can hold millions of rows.
     * A wall-clock assertion would be a CI flake, and an unbounded interval would make
     * a row-walking implementation hang rather than fail. So the bound is counted
     * instead: any loop over the rows re-reads `end` on every iteration (it is the loop
     * condition), while an interval-arithmetic implementation reads it a handful of
     * times. The budget throws, so the mutant fails on an error at the exact call.
     */
    const READ_BUDGET = 64;
    function select_all_rows(height_rows: number): { start: number; end: number }[] {
        let reads = 0;
        return [{
            start: 0,
            get end(): number {
                reads += 1;
                if (reads > READ_BUDGET) {
                    throw new Error(
                        `interval.end read ${reads} times for a ${height_rows}-row `
                        + 'interval: the implementation is walking rows',
                    );
                }
                return height_rows - 1;
            },
        }];
    }

    /**
     * A scattered selection that reports how many of its intervals were *looked at*.
     *
     * The sibling of `select_all_rows`, for the other axis of the same claim. That one
     * pins cost against the sheet's row count with one enormous interval; this one pins
     * cost against the *interval count* with many small ones, which is the case a
     * scattered multi-row selection produces — `selected_display_row_intervals` coalesces
     * one interval per contiguous run, so the count is bounded only by
     * `MAX_PERSISTED_ROW_HEIGHTS`, the cap the webview checks before layering.
     *
     * Counted through an index proxy rather than a getter, because what matters here is
     * how many *intervals* the search touches, not how often one interval is re-read. A
     * linear scan touches every one; a binary search touches about log2 of them.
     */
    function counted_scattered_rows(count: number): {
        rows: readonly { start: number; end: number }[];
        touched: () => number;
    } {
        let touched = 0;
        // Row `2 * i` for each i, so odd rows fall between intervals and a lookup for one
        // is the worst case: it can stop early at no interval.
        const backing = Array.from({ length: count }, (_, i) => ({
            start: i * 2,
            end: i * 2,
        }));
        const rows = new Proxy(backing, {
            get(target, property, receiver) {
                if (typeof property === 'string' && /^\d+$/.test(property)) touched += 1;
                return Reflect.get(target, property, receiver);
            },
        });
        return { rows, touched: () => touched };
    }

    describe('resolved_row_height', () => {
        it('prefers the newest layer that names the row', () => {
            const layers = [layer([{ start: 0, end: 4 }], 40), layer([{ start: 0, end: 0 }], 60)];
            // Row 0 is named by both; the later commit is the one the user just made.
            expect(resolved_row_height({}, layers, 0)).toBe(60);
            // Row 1 is named only by the older layer, which is still in force.
            expect(resolved_row_height({}, layers, 1)).toBe(40);
        });

        it('falls through the layers to the projection, then to the default', () => {
            const layers = [layer([{ start: 2, end: 3 }], 50)];
            expect(resolved_row_height({ 7: 31 }, layers, 7)).toBe(31);
            expect(resolved_row_height({ 7: 31 }, layers, 8)).toBe(DEFAULT_ROW_HEIGHT_PX);
            expect(resolved_row_height({}, undefined, 8)).toBe(DEFAULT_ROW_HEIGHT_PX);
            expect(resolved_row_height({}, undefined, 8, 33)).toBe(33);
            // A layer beats the projection even where the projection has an entry.
            expect(resolved_row_height({ 2: 31 }, layers, 2)).toBe(50);
        });

        it('respects interval bounds inclusively at both ends', () => {
            const layers = [layer([{ start: 3, end: 5 }], 44)];
            expect(resolved_row_height({}, layers, 2)).toBe(DEFAULT_ROW_HEIGHT_PX);
            expect(resolved_row_height({}, layers, 3)).toBe(44);
            expect(resolved_row_height({}, layers, 5)).toBe(44);
            expect(resolved_row_height({}, layers, 6)).toBe(DEFAULT_ROW_HEIGHT_PX);
        });

        it('answers a select-all layer without walking its rows', () => {
            const select_all = [layer(select_all_rows(10_000_000), 72)];
            // The last row of the sheet: the worst case for anything that scans.
            expect(resolved_row_height({}, select_all, 9_999_999)).toBe(72);
            expect(resolved_row_height({}, select_all, 0)).toBe(72);
        });

        it('answers a scattered layer without walking its intervals', () => {
            // The other axis of the same claim, and this one is on the frame path: Glide
            // calls `rowHeight` once per painted row per frame, so a scan linear in the
            // interval count costs about 8ms per viewport at the cap — half a frame,
            // spent deciding that no layer names the row.
            //
            // A scattered selection is what produces those intervals: coalescing yields
            // one per contiguous run, bounded only by `MAX_PERSISTED_ROW_HEIGHTS`. The
            // budget is generous — log2(10,000) is about 14 per layer, and this asks only
            // that the answer come from a search rather than a sweep.
            const scattered = counted_scattered_rows(MAX_PERSISTED_ROW_HEIGHTS);
            const layers = [layer(scattered.rows, 72)];

            // A row no interval names: the worst case, since a hit can stop early.
            expect(resolved_row_height({}, layers, 1)).toBe(DEFAULT_ROW_HEIGHT_PX);
            // And one that is named, to prove the search is answering correctly rather
            // than cheaply — a stub that touched nothing would satisfy the bound alone.
            expect(resolved_row_height({}, layers, 19_998)).toBe(72);

            expect(scattered.touched()).toBeLessThan(64);
        });
    });

    describe('row_height_layers_with', () => {
        it('appends newest last', () => {
            const first = layer([{ start: 0, end: 0 }], 40);
            const second = layer([{ start: 0, end: 0 }], 60);
            const layers = row_height_layers_with([first], second);
            expect(layers).toEqual([first, second]);
            expect(resolved_row_height({}, layers, 0)).toBe(60);
        });

        it('evicts the oldest past the layer cap', () => {
            let layers: readonly RowHeightLayer[] = [];
            // One layer per row, so which layers survived is readable off the resolver.
            for (let index = 0; index <= MAX_ROW_HEIGHT_LAYERS; index += 1) {
                layers = row_height_layers_with(
                    layers,
                    layer([{ start: index, end: index }], 40 + index),
                );
            }
            expect(layers).toHaveLength(MAX_ROW_HEIGHT_LAYERS);
            // The oldest is gone, so its row falls back to the projection underneath.
            expect(resolved_row_height({ 0: 25 }, layers, 0)).toBe(25);
            // Everything after it is still masked, newest included.
            expect(resolved_row_height({ 1: 25 }, layers, 1)).toBe(41);
            expect(
                resolved_row_height({}, layers, MAX_ROW_HEIGHT_LAYERS),
            ).toBe(40 + MAX_ROW_HEIGHT_LAYERS);
        });
    });

    describe('row_height_layers_for_delivery', () => {
        it('drops a layer the delivered projection agrees with in full', () => {
            const layers = [layer([{ start: 0, end: 2 }], 40)];
            expect(row_height_layers_for_delivery(layers, { 0: 40, 1: 40, 2: 40 }))
                .toEqual([]);
        });

        it('keeps a layer the projection agrees with only in part', () => {
            // The delivery answering *some* of the rows means the write is still in
            // flight for the rest; dropping here would flicker those rows back to the
            // projection's default before their height lands.
            const layers = [layer([{ start: 0, end: 2 }], 40)];
            expect(row_height_layers_for_delivery(layers, { 0: 40, 1: 40 }))
                .toBe(layers);
            expect(row_height_layers_for_delivery(layers, { 0: 40 })).toBe(layers);
            expect(row_height_layers_for_delivery(layers, {})).toBe(layers);
        });

        it('does not count projection entries at another height', () => {
            const layers = [layer([{ start: 0, end: 2 }], 40)];
            expect(row_height_layers_for_delivery(layers, { 0: 40, 1: 40, 2: 99 }))
                .toBe(layers);
        });

        it('does not count projection entries outside the layer', () => {
            // Counting from the projection's side is what keeps this O(projection); the
            // price is that a same-height entry elsewhere must not be mistaken for one
            // of the layer's own rows.
            const layers = [layer([{ start: 0, end: 2 }], 40)];
            expect(row_height_layers_for_delivery(layers, { 0: 40, 1: 40, 9: 40 }))
                .toBe(layers);
        });

        it('drops the answered layer and returns the same array otherwise', () => {
            const answered = layer([{ start: 0, end: 0 }], 40);
            const outstanding = layer([{ start: 5, end: 5 }], 60);
            const layers = [answered, outstanding];
            expect(row_height_layers_for_delivery(layers, { 0: 40 }))
                .toEqual([outstanding]);
            // Identity when nothing was answered: App compares by reference to decide
            // whether the overlay state needs replacing at all.
            expect(row_height_layers_for_delivery(layers, { 4: 40 })).toBe(layers);
        });

        it('retires an older overlapping layer the delivery cannot agree with', () => {
            // The failure this rule exists for. The older layer is a resize the host
            // refused on the accumulated-map bound, so no delivery will ever agree with
            // it; the newer one overlaps it and *was* persisted. Asking the question of
            // each layer independently drops the newer, agreed layer and keeps the older
            // refused one — which `resolved_row_height` then resolves first, painting a
            // height no file holds over the one just written.
            const refused = layer([{ start: 0, end: 2 }], 99);
            const persisted = layer([{ start: 1, end: 1 }], 40);
            const layers = [refused, persisted];
            const delivered = { 1: 40 };
            expect(row_height_layers_for_delivery(layers, delivered)).toEqual([]);
            // The observable end of it: the delivered height is what the row shows.
            expect(resolved_row_height(
                delivered,
                row_height_layers_for_delivery(layers, delivered),
                1,
            )).toBe(40);
        });

        it('retires older layers that do not overlap the answered one', () => {
            // Not overlap-only, because the licence is ordering, not geometry: resize
            // writes are serialized on one host tail in post order, so a delivery that
            // answers this layer was read after every older request had been processed —
            // each of those is already either persisted (and carried here) or refused.
            const older = layer([{ start: 0, end: 0 }], 99);
            const answered = layer([{ start: 5, end: 5 }], 40);
            expect(row_height_layers_for_delivery([older, answered], { 5: 40 }))
                .toEqual([]);
            // Row 0 falls back to the projection, which does not name it: the default.
            expect(resolved_row_height(
                { 5: 40 },
                row_height_layers_for_delivery([older, answered], { 5: 40 }),
                0,
            )).toBe(DEFAULT_ROW_HEIGHT_PX);
        });

        it('cuts at the newest agreement, not the first one it finds', () => {
            // Scanning oldest-first satisfies every other assertion here and still leaves
            // the original bug reachable: it cuts at the *oldest* agreement, so a refused
            // layer newer than that one survives, and it is then the newest layer naming
            // its rows. Here the refused layer overlaps a persisted height that an older
            // delivery already answered.
            const answered_older = layer([{ start: 0, end: 0 }], 30);
            const refused = layer([{ start: 0, end: 0 }], 99);
            const answered_newest = layer([{ start: 7, end: 7 }], 40);
            const layers = [answered_older, refused, answered_newest];
            const delivered = { 0: 30, 7: 40 };
            expect(row_height_layers_for_delivery(layers, delivered)).toEqual([]);
            expect(resolved_row_height(
                delivered,
                row_height_layers_for_delivery(layers, delivered),
                0,
            )).toBe(30);
        });

        it('keeps layers newer than the answered one', () => {
            // The other half: only what is *older* is dead. A layer posted after the
            // answered one is still in flight and must keep painting.
            const answered = layer([{ start: 0, end: 0 }], 40);
            const newer = layer([{ start: 1, end: 1 }], 60);
            expect(row_height_layers_for_delivery([answered, newer], { 0: 40 }))
                .toEqual([newer]);
        });

        it('retires an older select-all layer without walking its rows', () => {
            // The scan stops at the newest agreeing layer, so the select-all beneath it is
            // never inspected at all — and the interval read budget is watching in case a
            // future rewrite decides to inspect it row by row.
            const layers = [
                layer(select_all_rows(10_000_000), 72),
                layer([{ start: 3, end: 3 }], 40),
            ];
            expect(row_height_layers_for_delivery(layers, { 3: 40 })).toEqual([]);
        });

        it('reconciles a scattered layer without walking its intervals per entry', () => {
            // Off the frame path, but the cliff here is a *product*: the walk is over
            // projection entries (bounded by `MAX_PERSISTED_ROW_HEIGHTS`) and each
            // membership test was linear in the interval count (bounded the same way).
            // A few hundred entries against a full-cap layer was already millions of
            // comparisons on a delivery.
            const scattered = counted_scattered_rows(MAX_PERSISTED_ROW_HEIGHTS);
            const layers = [layer(scattered.rows, 72)];
            // 200 delivered entries at the layer's height, all inside it. Nowhere near
            // covering the layer, so this does not agree and the layer is kept — the
            // point is what the *decision* cost.
            const delivered: Record<number, number> = {};
            for (let i = 0; i < 200; i += 1) delivered[i * 2] = 72;

            expect(row_height_layers_for_delivery(layers, delivered)).toBe(layers);

            // One unavoidable pass over the intervals — `layer_row_count` has to total
            // them, which is O(intervals) and is not what this is about — plus one search
            // of ~14 steps per delivered entry. The budget is that sum with room to
            // spare. A linear membership test would be 200 × 10,000 = two million.
            expect(scattered.touched())
                .toBeLessThan(MAX_PERSISTED_ROW_HEIGHTS + 200 * 32);
        });

        it('never agrees with a select-all layer a sparse projection cannot answer', () => {
            // Counting from the *layer's* side rather than the projection's would walk
            // every row here — the interval's read budget is what catches it.
            const layers = [layer(select_all_rows(10_000_000), 72)];
            expect(row_height_layers_for_delivery(layers, { 0: 72, 1: 72 })).toBe(layers);
        });
    });

    /**
     * The one predicate both sides of the protocol use to decide whether a display-keyed
     * overlay is still meaningful. The host's form is
     * `msg.generation >= core.mapping_generation(sheet)`; this is the same comparison from
     * the other end, fed by `WorkbookSnapshot.mappingGenerations`.
     */
    describe('retained_row_height_overlay', () => {
        const overlay = {
            generation: 4,
            layers: [layer([{ start: 3, end: 3 }], 50)],
        };

        it('retains an overlay whose sheet has not moved, rebased onto the new generation', () => {
            // The whole point of delivering per-sheet mapping generations: the core-wide
            // generation moved to 5 because *another* sheet was reconciled, and sheet 0's
            // mapping still dates from 4. The host accepts this overlay's queued write for
            // exactly that reason, so discarding it here would spring the row back and
            // then have the height silently reappear when the write is delivered.
            //
            // Rebased rather than merely kept, because the render site paints only an
            // overlay whose generation is the current one — retaining without rebasing is
            // indistinguishable from discarding, on screen.
            expect(retained_row_height_overlay(overlay, 5, 4))
                .toEqual({ ...overlay, generation: 5 });
        });

        it('discards an overlay whose own sheet moved', () => {
            // The other direction, and the one that must not be traded away for the first:
            // this sheet's rows were rearranged after the overlay's display keys were read
            // off them, so those keys now name other source rows. Painting them would put
            // the user's height on whichever rows moved into those positions.
            expect(retained_row_height_overlay(overlay, 5, 5)).toBeUndefined();
        });

        it('discards an overlay for a sheet the delivery does not describe', () => {
            // A missing entry means the workbook no longer has that sheet, so nothing
            // vouches for the keys. Distinct from the comparison above rather than a
            // rewording of it: `undefined > 4` is false, so a rule that only compared
            // would *keep* this one.
            expect(retained_row_height_overlay(overlay, 5, undefined)).toBeUndefined();
        });

        it('returns the same object when the generation has not moved', () => {
            // Identity, not just equality: App decides whether to replace overlay state at
            // all by comparing references, so a fresh object here would re-render on every
            // delivery that changed nothing.
            expect(retained_row_height_overlay(overlay, 4, 4)).toBe(overlay);
        });

        it('has nothing to retain when there is no overlay', () => {
            expect(retained_row_height_overlay(undefined, 5, 4)).toBeUndefined();
        });
    });

    describe('mapped_row_height_overlays', () => {
        const overlay = (generation: number) => ({
            generation,
            layers: [layer([{ start: 3, end: 3 }], 50)],
        });

        it('passes each sheet its own index and keeps every other slot', () => {
            const first = overlay(4);
            const third = overlay(6);
            const seen: number[] = [];

            const next = mapped_row_height_overlays(
                [first, undefined, third],
                (entry, sheet_index) => {
                    seen.push(sheet_index);
                    return sheet_index === 2 ? undefined : entry;
                },
            );

            // The empty slot is skipped rather than handed over as `undefined`, so a caller
            // cannot invent an overlay for a sheet with no resize in flight.
            expect(seen).toEqual([0, 2]);
            expect(next).toEqual([first, undefined, undefined]);
            // Positional, so the surviving entry stays under its own sheet's index — a
            // compacting map would slide sheet 2's verdict onto sheet 0.
            expect(next[0]).toBe(first);
        });

        it('returns the same array when no verdict changed anything', () => {
            // Identity, not just equality: this runs on every delivery and every install
            // ack, and App holds the result in React state, so a fresh array would re-render
            // the grid on events that changed nothing.
            const previous = [overlay(4), undefined];
            expect(mapped_row_height_overlays(previous, (entry) => entry)).toBe(previous);
        });
    });
});
