import { describe, expect, it } from 'vitest';
import {
    anchor_formula,
    formula_divergence_flags,
    implicit_formula_anchors,
    render_formula,
    type FormulaAnchors,
} from '../formula-anchors';
import {
    anchor_context,
    append,
    axis_model,
    delete_member,
    insert_before,
    layout_key,
    move_before,
    sheet,
    type AxisModel,
    type SheetModel,
} from './helpers/array-anchor-axis';

/** Render `text` with no stored anchors on a one-sheet workbook. */
function render_rows(text: string, rows: AxisModel, columns?: AxisModel): string {
    return render_formula(text, undefined, anchor_context([sheet('Sheet1', rows, columns)]));
}

/** Commit `text` against `before`, then render it against `after`. */
function committed(text: string, before: readonly SheetModel[], after: readonly SheetModel[]): string {
    const result = anchor_formula(text, anchor_context(before));
    if (result.kind !== 'anchored') throw new Error(result.reason);
    return render_formula(text, result.anchors, anchor_context(after));
}

function anchors_of(text: string, sheets: readonly SheetModel[]): FormulaAnchors | undefined {
    const result = anchor_formula(text, anchor_context(sheets));
    if (result.kind !== 'anchored') throw new Error(result.reason);
    return result.anchors;
}

const four = axis_model(0, 4);
const six = axis_model(0, 6);

describe('rendering implicit anchors', () => {
    it('returns the text exactly when no worksheet has a live layout change', () => {
        const text = "=SUM(a1:$B$3)+Sheet2!c7+[Revenue]+[1]Other!A1+\"A1\"+A1#+INDEX(A:A,1):B5";
        const context = anchor_context([
            sheet('Sheet1', append(axis_model(1, 10), 'x')),
            sheet('Sheet2', axis_model(0, 3, { order: [1, 2, 3, 'gone'], tombstones: ['gone'] })),
        ]);
        expect(render_formula(text, undefined, context)).toBe(text);
    });

    it('reproduces the reviewed row-move sequences', () => {
        // Rows [1,2,3,4] with A1:A3: move row 1 after row 4, then delete it.
        const moved = move_before(four, 1, undefined);
        expect(render_rows('=SUM(A1:A3)', moved)).toBe('=SUM(A2:A4)');
        expect(render_rows('=SUM(A1:A3)', delete_member(moved, 1))).toBe('=SUM(A2:A3)');
        // SUM(A2:A5) over six rows: move row 5 to the top, then delete it.
        const top = move_before(six, 5, 1);
        expect(render_rows('=SUM(A2:A5)', top)).toBe('=SUM(A1:A3)');
        expect(render_rows('=SUM(A2:A5)', delete_member(top, 5))).toBe('=SUM(A1:A2)');
    });

    it('expands, shifts, and shrinks ranges as Excel does for inserts and deletes', () => {
        const text = '=SUM(A2:A5)';
        expect(render_rows(text, insert_before(six, 3, ['p']))).toBe('=SUM(A2:A6)');
        expect(render_rows(text, insert_before(six, 1, ['p']))).toBe('=SUM(A3:A6)');
        expect(render_rows(text, insert_before(six, 6, ['p']))).toBe('=SUM(A2:A5)');
        expect(render_rows(text, delete_member(six, 2))).toBe('=SUM(A2:A4)');
        expect(render_rows(text, delete_member(six, 5))).toBe('=SUM(A2:A4)');
        const whole = [2, 3, 4, 5].reduce(delete_member, six);
        expect(render_rows(text, whole)).toBe('=SUM(#REF!)');
    });

    it('renders a single tombstone corner as #REF! and keeps the qualifier', () => {
        const rows = delete_member(four, 2);
        expect(render_rows('=A2+Sheet1!B2+A3', rows)).toBe('=#REF!+Sheet1!#REF!+A2');
    });

    it('preserves $ flags without pinning, and keeps the spelling of unchanged coordinates', () => {
        const rows = insert_before(six, 1, ['p']);
        expect(render_rows('=$a$2+a$1:$b2+SUM($A$1:$A$3)', rows))
            .toBe('=$a$3+a$2:$b3+SUM($A$2:$A$4)');
    });

    it('renders whole-row and whole-column references', () => {
        const rows = insert_before(six, 3, ['p']);
        expect(render_rows('=SUM(2:4)+SUM(A:B)', rows)).toBe('=SUM(2:5)+SUM(A:B)');
        // Column A moves to the end, so A:C now spans the old B..E, as flagged.
        const columns = move_before(axis_model(0, 5), 1, undefined);
        expect(render_rows('=SUM(A:C)+SUM(B2:D2)+E1', six, columns))
            .toBe('=SUM(B:E)+SUM(A2:C2)+D1');
    });

    it('renders fixed rows above the Header Row unchanged', () => {
        // Header Row 2; body rows 3..6.
        const rows = move_before(axis_model(2, 4), 6, 3);
        expect(render_rows('=A1+A2+SUM(A1:A3)+A6', rows)).toBe('=A1+A2+SUM(A1:A4)+A3');
    });

    it('leaves external and structured references unchanged', () => {
        const rows = insert_before(four, 1, ['p']);
        expect(render_rows("=[1]Sheet1!A1+'[Book.xlsx]Data'!A1+[Revenue]+Sheet1![@Cost]+A1", rows))
            .toBe("=[1]Sheet1!A1+'[Book.xlsx]Data'!A1+[Revenue]+Sheet1![@Cost]+A2");
    });

    it('renders per-corner qualified and cross-sheet references against their target', () => {
        const context = anchor_context([
            sheet('Sheet1', four),
            sheet('Data', insert_before(four, 1, ['p'])),
        ]);
        expect(render_formula('=Data!A1:Data!A2+data!B3+A1', undefined, context))
            .toBe('=Data!A2:Data!A3+data!B4+A1');
        expect(render_formula('=Missing!A1+A1', undefined, context)).toBe('=Missing!A1+A1');
    });

    it('never renders a CSV or TSV value', () => {
        const rows = insert_before(four, 1, ['p']);
        for (const format of ['csv', 'tsv'] as const) {
            const context = anchor_context([sheet('Sheet1', rows)], 0, format);
            expect(render_formula('=A1', undefined, context)).toBe('=A1');
            expect(anchor_formula('=A1', context)).toEqual({ kind: 'anchored' });
            expect(() => render_formula('=A1', {
                references: [{ start: 1, end: 3, corners: [{ row: { kind: 'edge' } }] }],
            }, context)).toThrow(/CSV or TSV/);
        }
    });

    it('derives implicit anchors from source coordinates', () => {
        const context = anchor_context([sheet('Sheet1', axis_model(1, 4), axis_model(0, 3))]);
        expect(implicit_formula_anchors('=A1:C5+D6+XFD1048576', context).references).toEqual([
            {
                start: 1,
                end: 6,
                corners: [
                    { row: { kind: 'fixed', row: 1 }, column: { kind: 'identity', column: { kind: 'source', sourceColumn: 0 } } },
                    { row: { kind: 'identity', row: { kind: 'source', sourceRow: 4 } }, column: { kind: 'identity', column: { kind: 'source', sourceColumn: 2 } } },
                ],
            },
            {
                start: 7,
                end: 9,
                corners: [{ row: { kind: 'trailing', offset: 1 }, column: { kind: 'trailing', offset: 1 } }],
            },
            {
                start: 10,
                end: 20,
                corners: [{ row: { kind: 'edge' }, column: { kind: 'edge' } }],
            },
        ]);
    });
});

describe('trailing and edge anchors', () => {
    const ten = axis_model(0, 10);

    it('keeps SUM(A2:A11) over a 10-row body when two rows are appended', () => {
        expect(render_rows('=SUM(A2:A11)', ten)).toBe('=SUM(A2:A11)');
        const appended = append(append(ten, 'a1'), 'a2');
        expect(render_rows('=SUM(A2:A11)', appended)).toBe('=SUM(A2:A11)');
        // With a live layout change too, A11 still names the first appended
        // row; row 10, moved to the top, leaves the range.
        const moved = move_before(appended, 10, 1);
        expect(render_rows('=SUM(A2:A11)+A11', moved)).toBe('=SUM(A3:A11)+A11');
    });

    it('shifts trailing references by inserts and deletes on either side of the body end', () => {
        const text = '=A12+SUM(A5:A15)';
        expect(render_rows(text, insert_before(ten, 3, ['p']))).toBe('=A13+SUM(A6:A16)');
        expect(render_rows(text, insert_before(ten, undefined, ['p', 'q']))).toBe('=A14+SUM(A5:A17)');
        expect(render_rows(text, delete_member(ten, 2))).toBe('=A11+SUM(A4:A14)');
        expect(render_rows(text, delete_member(ten, 10))).toBe('=A11+SUM(A5:A14)');
        // Moving within the body changes neither.
        expect(render_rows(text, move_before(ten, 10, 1))).toBe('=A12+SUM(A6:A15)');
    });

    it('leaves trailing references in place when an appended row is discarded', () => {
        const appended = append(append(append(ten, 'a1'), 'a2'), 'a3');
        const changed = move_before(appended, 2, 1);
        expect(render_rows('=A12', changed)).toBe('=A12');
        expect(render_rows('=A12', delete_member(changed, 'a1'))).toBe('=A12');
    });

    it('renders #REF! past row 1,048,576 and keeps the edge', () => {
        const rows = insert_before(ten, 1, ['p', 'q']);
        expect(render_rows('=A1048576+A1048575+A1048574+SUM(A2:A1048576)+SUM(A5:A1048575)', rows))
            .toBe('=A1048576+#REF!+A1048576+SUM(A4:A1048576)+SUM(#REF!)');
        const columns = insert_before(axis_model(0, 3), 1, ['c', 'd']);
        expect(render_rows('=XFC1+XFD1+B1', ten, columns)).toBe('=#REF!+XFD1+D1');
    });
});

describe('anchoring at commit time', () => {
    it('stores nothing when every target keeps its source layout', () => {
        expect(anchor_formula('=SUM(A1:B5)+Data!C3', anchor_context([
            sheet('Sheet1', four),
            sheet('Data', axis_model(0, 3, { order: [1, 2, 3, 'x'], tombstones: ['x'] })),
        ]))).toEqual({ kind: 'anchored' });
        expect(anchor_formula('A1', anchor_context([sheet('Sheet1', move_before(four, 1, undefined))])))
            .toEqual({ kind: 'anchored' });
    });

    it('stores only references to a worksheet with a live layout change', () => {
        const before = [sheet('Sheet1', four), sheet('Data', insert_before(four, 1, ['p']))];
        const anchors = anchors_of('=A1+Data!A1+Data!A2', before);
        expect(anchors?.references.map((reference) => [reference.start, reference.end, reference.worksheet]))
            .toEqual([[4, 11, { sheetIndex: 1, sheetName: 'Data' }], [12, 19, { sheetIndex: 1, sheetName: 'Data' }]]);
        expect(anchors?.references[0].corners[0].row).toEqual({
            kind: 'identity', row: { kind: 'pending', pendingRowId: 'p' },
        });
    });

    it('anchors a corner on a Pending Appended Row, which follows it and becomes #REF! on discard', () => {
        const ten = append(append(axis_model(0, 10), 'a1'), 'a2');
        const before = [sheet('Sheet1', ten)];
        expect(anchors_of('=A11', before)?.references[0].corners[0].row)
            .toEqual({ kind: 'identity', row: { kind: 'pending', pendingRowId: 'a1' } });
        expect(anchors_of('=A13', before)).toBeUndefined();
        expect(committed('=A12', before, [sheet('Sheet1', delete_member(ten, 'a1'))])).toBe('=A11');
        expect(committed('=A11', before, [sheet('Sheet1', delete_member(ten, 'a1'))])).toBe('=#REF!');
        // Excel would shrink this range; a discarded appended corner leaves no tombstone.
        expect(committed('=SUM(A2:A11)', before, [sheet('Sheet1', delete_member(ten, 'a1'))]))
            .toBe('=SUM(#REF!)');
    });

    it('anchors below the band as trailing, counted from N', () => {
        const rows = append(insert_before(axis_model(0, 10), 1, ['p']), 'a1');
        const anchors = anchors_of('=A14', [sheet('Sheet1', rows)]);
        expect(anchors?.references[0].corners[0].row).toEqual({ kind: 'trailing', offset: 3 });
        expect(committed('=A14', [sheet('Sheet1', rows)], [sheet('Sheet1', delete_member(rows, 'p'))]))
            .toBe('=A13');
    });

    it('follows a Pending Inserted Row through moves and renders #REF! once it is discarded', () => {
        const inserted = insert_before(four, 3, ['p']);
        const before = [sheet('Sheet1', inserted)];
        expect(committed('=A3', before, before)).toBe('=A3');
        const moved = move_before(inserted, 'p', 1);
        expect(committed('=A3', before, [sheet('Sheet1', moved)])).toBe('=A1');
        expect(committed('=A3+A4', before, [sheet('Sheet1', delete_member(moved, 'p'))]))
            .toBe('=#REF!+A3');
    });

    it('anchors against the current prospective layout, not the source', () => {
        const moved = move_before(four, 4, 1);
        const before = [sheet('Sheet1', moved)];
        // Prospective row 1 is source row 4.
        expect(committed('=A1', before, before)).toBe('=A1');
        expect(committed('=A1', before, [sheet('Sheet1', move_before(moved, 4, undefined))])).toBe('=A4');
    });

    it('refuses an unanchorable reference to a worksheet with a live layout change', () => {
        const before = [sheet('Sheet1', move_before(four, 4, 1)), sheet('Data', four)];
        expect(anchor_formula('=SUM(INDEX(A:A,1):B5)', anchor_context(before))).toEqual({
            kind: 'refused',
            reason: "Table Viewer can't adjust the reference `INDEX(A:A,1):B5` while rows on "
                + 'this sheet are being inserted, deleted, or moved.',
        });
        expect(anchor_formula('=Data!A1#+Data!R1C1+SUM(Data!A1:B2:Data!C3)', anchor_context(before)))
            .toEqual({ kind: 'anchored' });
        // A function operand names the changed sheet even when the range's
        // reference operand does not.
        const data_changed = [sheet('Sheet1', four), sheet('Data', move_before(four, 4, 1))];
        for (const text of [
            '=SUM(INDEX(Data!A:A,1):B5)',
            '=SUM(B5:INDEX(Data!A:A,2))',
            '=INDEX(Data!A:A,MATCH("(",A:A,0)):B5',
            "=INDEX(Data!A:A,MATCH(1,'Da(ta'!A:A,0)):B5",
        ]) {
            expect(anchor_formula(text, anchor_context(data_changed)).kind).toBe('refused');
        }
        const columns = [sheet('Sheet1', four), sheet('Data', four, insert_before(axis_model(0, 3), 1, ['c']))];
        expect(anchor_formula('=SUM(Sheet1:Data!A1)', anchor_context(columns))).toEqual({
            kind: 'refused',
            reason: "Table Viewer can't adjust the reference `Sheet1:Data!A1` while columns on "
                + 'Data are being inserted, deleted, or moved.',
        });
    });
});

describe('path independence', () => {
    /** Deterministic PRNG so failures reproduce. */
    function random(seed: number): () => number {
        let state = seed;
        return () => {
            state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
            return state / 2_147_483_648;
        };
    }

    function step(rows: AxisModel, next: () => number, counter: { value: number }): AxisModel {
        const live = rows.order.filter((member) => !rows.tombstones.has(member));
        const pick = <T>(values: readonly T[]) => values[Math.floor(next() * values.length)];
        const choice = next();
        if (choice < 0.3 && live.length > 0) return delete_member(rows, pick(live));
        if (choice < 0.5) return insert_before(rows, pick([...live, undefined]), [`n${counter.value++}`]);
        if (choice < 0.6) return append(rows, `a${counter.value++}`);
        if (live.length > 1) {
            const member = pick(live);
            return move_before(rows, member, pick([...live.filter((entry) => entry !== member), undefined]));
        }
        return rows;
    }

    it('renders equal text for operation sequences that reach the same full layout', () => {
        const text = '=SUM(A2:A4)+A1+A5+$A$3:A2+SUM(2:3)+A6';
        // Stored anchors committed at a shared starting point.
        const start = insert_before(axis_model(0, 4), 3, ['s']);
        const stored = anchors_of('=A3+SUM(A2:A4)', [sheet('Sheet1', start)]);
        const seen = new Map<string, string>();
        let collisions = 0;
        for (let seed = 1; seed <= 400; seed++) {
            const next = random(seed);
            const counter = { value: 0 };
            let rows = start;
            const steps = 1 + Math.floor(next() * 4);
            for (let index = 0; index < steps; index++) rows = step(rows, next, counter);
            const context = anchor_context([sheet('Sheet1', rows)]);
            const rendered = render_formula(text, undefined, context)
                + render_formula('=A3+SUM(A2:A4)', stored, context);
            const key = layout_key(rows);
            const previous = seen.get(key);
            if (previous !== undefined) {
                collisions += 1;
                expect(rendered).toBe(previous);
            }
            seen.set(key, rendered);
        }
        expect(collisions).toBeGreaterThan(20);
    });

    it('agrees for two hand-picked orders of the same gestures', () => {
        // Insert after row 4, then move row 1 to the end; and the reverse.
        const first = move_before(insert_before(six, 5, ['p']), 1, undefined);
        const second = insert_before(move_before(six, 1, undefined), 5, ['p']);
        expect(layout_key(first)).toBe(layout_key(second));
        expect(render_rows('=SUM(A1:A5)+A6', first)).toBe(render_rows('=SUM(A1:A5)+A6', second));
    });
});

describe('divergence flags', () => {
    const flags = (text: string, rows: AxisModel, anchors?: FormulaAnchors, columns?: AxisModel) =>
        formula_divergence_flags(text, anchors, anchor_context([sheet('Sheet1', rows, columns)]))
            .map((flag) => `${text.slice(flag.start, flag.end)} ${flag.axis} ${flag.reason}`);

    it('flags nothing for inserts and deletes Excel adjusts the same way', () => {
        expect(flags('=SUM(A2:A5)', insert_before(six, 3, ['p']))).toEqual([]);
        expect(flags('=SUM(A2:A5)', delete_member(six, 2))).toEqual([]);
        expect(flags('=A2', move_before(six, 2, undefined))).toEqual([]);
        expect(flags('=SUM(A2:A5)', axis_model(0, 6, { band: ['a'] }))).toEqual([]);
    });

    it('flags corners that a move crossed', () => {
        // Rows [1..4]: move row 1 after row 4 crosses A1 past A3.
        expect(flags('=SUM(A1:A3)', move_before(four, 1, undefined)))
            .toEqual(['A1:A3 row cornersCrossed', 'A1:A3 row displacedCorner']);
        const columns = move_before(axis_model(0, 4), 1, undefined);
        expect(flags('=SUM(A1:C1)', six, undefined, columns))
            .toEqual(['A1:C1 column cornersCrossed', 'A1:C1 column displacedCorner']);
    });

    it('flags a tombstone corner only when the axis has an insert or an out-of-order run', () => {
        const deleted = delete_member(six, 2);
        expect(flags('=SUM(A2:A5)', deleted)).toEqual([]);
        // The gap after row 1's tombstone glue is refilled by an insert.
        expect(flags('=SUM(A2:A5)', insert_before(deleted, 3, ['p'])))
            .toEqual(['A2:A5 row tombstoneCorner']);
        // Moving row 6 to the top displaces both source runs, so the live
        // corner is flagged too.
        expect(flags('=SUM(A2:A5)', move_before(deleted, 6, 1)))
            .toEqual(['A2:A5 row tombstoneCorner', 'A2:A5 row displacedCorner']);
    });

    it('flags a multi-tombstone corner gap refilled by an insert, rendered from the glue', () => {
        // Delete rows 2 and 3 of SUM(A2:A5), then insert above row 4. The
        // tombstones stay glued to row 1, so the new row lands inside the
        // range; Excel, having already shrunk the range, would shift it.
        const rows = insert_before(delete_member(delete_member(six, 2), 3), 4, ['p']);
        expect(render_rows('=SUM(A2:A5)', rows)).toBe('=SUM(A2:A4)');
        expect(flags('=SUM(A2:A5)', rows)).toEqual(['A2:A5 row tombstoneCorner']);
    });

    it('flags a range that renders #REF! because a corner was discarded', () => {
        const ten = append(axis_model(0, 10), 'a1');
        const anchors = anchors_of('=SUM(A2:A11)', [sheet('Sheet1', ten)]);
        expect(flags('=SUM(A2:A11)', delete_member(ten, 'a1'), anchors))
            .toEqual(['A2:A11 row discardedCorner']);
    });

    it('flags a corner in a displaced source run, whether or not the tint marks it', () => {
        // Moving rows 3..5 below row 6 tints row 6, yet row 3 is in a moved run too.
        const moved = move_before(move_before(move_before(six, 3, undefined), 4, undefined), 5, undefined);
        expect(flags('=SUM(A1:A3)', moved)).toEqual(['A1:A3 row displacedCorner']);
        expect(flags('=SUM(A1:A2)', moved)).toEqual([]);
        // A pending run between two ascending source runs displaces neither.
        expect(flags('=SUM(A1:A3)', insert_before(six, 3, ['p']))).toEqual([]);
    });
});

/**
 * Oracle fixtures. Hand-written from Excel's documented reference adjustment
 * for inserting and deleting rows and columns ("Insert or delete rows and
 * columns", Microsoft Support): references below or right of an insertion
 * shift; an insertion at or inside a range below its first row expands it;
 * an insertion after its last row leaves it alone; deleting rows inside a
 * range shrinks it; deleting every row of a reference makes it #REF!. Move
 * cases are not oracle-checked yet and rely on the divergence flags.
 */
describe('Excel oracle fixtures (hand-written)', () => {
    interface OracleCase {
        readonly name: string;
        readonly formula: string;
        readonly rows?: (rows: AxisModel) => AxisModel;
        readonly columns?: (columns: AxisModel) => AxisModel;
        readonly excel: string;
    }
    const body = axis_model(1, 9); // Header Row 1; body rows 2..10.
    const columns = axis_model(0, 6); // A..F.
    const cases: readonly OracleCase[] = [
        { name: 'insert above a range', formula: '=SUM(B3:B6)', rows: (r) => insert_before(r, 2, ['p']), excel: '=SUM(B4:B7)' },
        { name: 'insert at a range\'s first row', formula: '=SUM(B3:B6)', rows: (r) => insert_before(r, 3, ['p']), excel: '=SUM(B4:B7)' },
        { name: 'insert inside a range', formula: '=SUM(B3:B6)', rows: (r) => insert_before(r, 5, ['p', 'q']), excel: '=SUM(B3:B8)' },
        { name: 'insert at a range\'s last row', formula: '=SUM(B3:B6)', rows: (r) => insert_before(r, 6, ['p']), excel: '=SUM(B3:B7)' },
        { name: 'insert after a range', formula: '=SUM(B3:B6)', rows: (r) => insert_before(r, 7, ['p']), excel: '=SUM(B3:B6)' },
        { name: 'insert at the end of the body', formula: '=SUM(B3:B10)+B11', rows: (r) => insert_before(r, undefined, ['p']), excel: '=SUM(B3:B10)+B12' },
        { name: 'insert above a single cell', formula: '=B5+$B$5', rows: (r) => insert_before(r, 4, ['p']), excel: '=B6+$B$6' },
        { name: 'insert below the Header Row', formula: '=B1+B2', rows: (r) => insert_before(r, 2, ['p']), excel: '=B1+B3' },
        { name: 'delete a range\'s first row', formula: '=SUM(B3:B6)', rows: (r) => delete_member(r, 3), excel: '=SUM(B3:B5)' },
        { name: 'delete a range\'s middle rows', formula: '=SUM(B3:B6)', rows: (r) => delete_member(delete_member(r, 4), 5), excel: '=SUM(B3:B4)' },
        { name: 'delete a range\'s last row', formula: '=SUM(B3:B6)', rows: (r) => delete_member(r, 6), excel: '=SUM(B3:B5)' },
        { name: 'delete every row of a range', formula: '=SUM(B3:B4)', rows: (r) => delete_member(delete_member(r, 3), 4), excel: '=SUM(#REF!)' },
        { name: 'delete rows above a range', formula: '=SUM(B5:B6)', rows: (r) => delete_member(r, 2), excel: '=SUM(B4:B5)' },
        { name: 'delete a referenced cell\'s row', formula: '=B5*2', rows: (r) => delete_member(r, 5), excel: '=#REF!*2' },
        { name: 'whole rows across an insert', formula: '=SUM(3:5)', rows: (r) => insert_before(r, 4, ['p']), excel: '=SUM(3:6)' },
        { name: 'whole rows across a delete', formula: '=SUM(3:5)', rows: (r) => delete_member(r, 3), excel: '=SUM(3:4)' },
        { name: 'insert a column inside a range', formula: '=SUM(B2:D2)', columns: (c) => insert_before(c, 3, ['c']), excel: '=SUM(B2:E2)' },
        { name: 'insert a column left of a range', formula: '=SUM(B2:D2)+$C$1', columns: (c) => insert_before(c, 1, ['c']), excel: '=SUM(C2:E2)+$D$1' },
        { name: 'delete a column inside a range', formula: '=SUM(B2:D2)', columns: (c) => delete_member(c, 3), excel: '=SUM(B2:C2)' },
        { name: 'whole columns across a delete', formula: '=SUM(B:D)+E:E', columns: (c) => delete_member(c, 2), excel: '=SUM(B:C)+D:D' },
        { name: 'delete a referenced column', formula: '=C1+D1', columns: (c) => delete_member(c, 3), excel: '=#REF!+C1' },
    ];
    for (const fixture of cases) {
        it(fixture.name, () => {
            expect(render_rows(
                fixture.formula,
                fixture.rows?.(body) ?? body,
                fixture.columns?.(columns) ?? columns,
            )).toBe(fixture.excel);
            expect(formula_divergence_flags(fixture.formula, undefined, anchor_context([
                sheet('Sheet1', fixture.rows?.(body) ?? body, fixture.columns?.(columns) ?? columns),
            ]))).toEqual([]);
        });
    }
});
