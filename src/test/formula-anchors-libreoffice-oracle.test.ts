/**
 * LibreOffice oracle for formula rendering (design: "Oracle criterion" in the
 * row and column structure spec). The fixture holds workbooks that
 * LibreOffice built, restructured through its own sheet API, and read back
 * in Excel A1 syntax; `scripts/libreoffice-formula-oracle.py` regenerates
 * it. This suite replays each case's gestures through the Worksheet Layout
 * operations and renders every formula and defined name from the result, so
 * it needs no LibreOffice at runtime.
 *
 * Every formula must render LibreOffice's text, after normalizing spelling
 * that cannot change meaning, unless the fixture classifies it:
 *
 * - `flagged`: the spec deliberately differs ("Where this differs from
 *   Excel"), so the formula must differ and `formula_divergence_flags` must
 *   flag it;
 * - `libreofficeDiffers`: LibreOffice departs from Excel's documented
 *   behavior, cited in the note, so the formula must render `excel` instead.
 *
 * A classification that no longer applies, because the texts now agree,
 * fails too, so the fixture never hides a fixed difference.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    formula_divergence_flags,
    render_formula,
    type FormulaAnchorContext,
} from '../formula-anchors';
import { formula_anchor_context, formula_anchor_workbook } from '../formula-anchor-layout';
import type { PendingRowId, RowIdentity } from '../pending-changes';
import {
    delete_columns,
    delete_rows,
    index_column_layout,
    index_row_layout,
    insert_columns,
    insert_rows,
    move_columns,
    move_rows,
    source_column_layout,
    source_row_layout,
    type ColumnIdentity,
    type ColumnLayout,
    type LayoutResult,
    type RowLayout,
} from '../worksheet-layout';

type Axis = 'Rows' | 'Columns';

/** One gesture, in 1-based physical numbers of the worksheet as it stands before the gesture. */
type OracleGesture =
    | { readonly op: `insert${Axis}`; readonly sheet: string; readonly before: number; readonly count: number }
    | { readonly op: `delete${Axis}`; readonly sheet: string; readonly first: number; readonly count: number }
    | {
        readonly op: `move${Axis}`;
        readonly sheet: string;
        readonly first: number;
        readonly count: number;
        /** Lands before this row or column; one past the last live one moves to the end. */
        readonly before: number;
    };

type OracleExpectation =
    | { readonly kind: 'flagged'; readonly note: string }
    | { readonly kind: 'libreofficeDiffers'; readonly excel: string; readonly note: string };

interface OracleFormula {
    /** Worksheet that holds the formula; defined names are workbook-scoped and omit it. */
    readonly sheet?: string;
    /** Defined name, for a `<definedName>` entry rather than a cell formula. */
    readonly name?: string;
    /** Text as authored, with a leading `=`. */
    readonly text: string;
    /** LibreOffice's text after the gestures, with a leading `=`. */
    readonly libreoffice: string;
    readonly expect?: OracleExpectation;
}

interface OracleCase {
    readonly name: string;
    /** Worksheet names, in workbook order. */
    readonly sheets: readonly string[];
    /** H: the Header Row's 1-based number, or 0 without one. */
    readonly headerRow: number;
    readonly gestures: readonly OracleGesture[];
    readonly formulas: readonly OracleFormula[];
}

interface OracleFixture {
    readonly libreoffice: string;
    /** Source extent of every worksheet: rows `1..rows`, columns `1..columns`. */
    readonly rows: number;
    readonly columns: number;
    readonly cases: readonly OracleCase[];
}

const fixture = JSON.parse(readFileSync(
    join(__dirname, 'fixtures', 'libreoffice-formula-oracle.json'),
    'utf8',
)) as OracleFixture;

// --- Replaying gestures through the layout ---------------------------------

interface SheetState {
    rows: RowLayout;
    columns: ColumnLayout;
}

function unwrap<L>(result: LayoutResult<L>): L {
    if (!result.ok) throw new Error(result.refusal.message);
    return result.layout;
}

function span(first: number, count: number): number[] {
    return Array.from({ length: count }, (_, index) => first + index);
}

class Replay {
    readonly sheets: Map<string, SheetState>;
    private next_id = 0;
    private readonly created = new Map<string, number>();

    constructor(private readonly test: OracleCase) {
        this.sheets = new Map(test.sheets.map((name) => [name, {
            rows: source_row_layout(test.headerRow, fixture.rows - test.headerRow),
            columns: source_column_layout(fixture.columns),
        }]));
    }

    private mint(count: number): string[] {
        return span(0, count).map(() => {
            const id = `p${++this.next_id}`;
            this.created.set(id, this.next_id);
            return id;
        });
    }

    private readonly created_order = (id: string): number => this.created.get(id)!;

    /** Live row at a 1-based worksheet row number. */
    private row_at(state: SheetState, number: number): RowIdentity {
        const identity = index_row_layout(state.rows).identity_at_body_index(number - this.test.headerRow);
        if (identity === undefined) throw new Error(`No live row ${number}.`);
        return identity;
    }

    private column_at(state: SheetState, number: number): ColumnIdentity {
        const identity = index_column_layout(state.columns).identity_at_body_index(number);
        if (identity === undefined) throw new Error(`No live column ${number}.`);
        return identity;
    }

    private live_rows(state: SheetState): number {
        return index_row_layout(state.rows).liveCount;
    }

    apply(gesture: OracleGesture): void {
        const state = this.sheets.get(gesture.sheet)!;
        const last_row = this.test.headerRow + this.live_rows(state);
        const last_column = index_column_layout(state.columns).liveCount;
        switch (gesture.op) {
            case 'insertRows':
                state.rows = unwrap(gesture.before > last_row
                    ? insert_rows(state.rows, this.row_at(state, last_row), 'after', this.mint(gesture.count))
                    : insert_rows(state.rows, this.row_at(state, gesture.before), 'before', this.mint(gesture.count)));
                return;
            case 'insertColumns':
                state.columns = unwrap(gesture.before > last_column
                    ? insert_columns(state.columns, this.column_at(state, last_column), 'after', this.mint(gesture.count))
                    : insert_columns(state.columns, this.column_at(state, gesture.before), 'before', this.mint(gesture.count)));
                return;
            case 'deleteRows':
                state.rows = unwrap(delete_rows(
                    state.rows,
                    span(gesture.first, gesture.count).map((number) => this.row_at(state, number)),
                    this.created_order as (id: PendingRowId) => number,
                ));
                return;
            case 'deleteColumns':
                state.columns = unwrap(delete_columns(
                    state.columns,
                    span(gesture.first, gesture.count).map((number) => this.column_at(state, number)),
                    this.created_order,
                ));
                return;
            case 'moveRows':
                state.rows = unwrap(move_rows(
                    state.rows,
                    span(gesture.first, gesture.count).map((number) => this.row_at(state, number)),
                    gesture.before > last_row ? 'end' : this.row_at(state, gesture.before),
                ));
                return;
            case 'moveColumns':
                state.columns = unwrap(move_columns(
                    state.columns,
                    span(gesture.first, gesture.count).map((number) => this.column_at(state, number)),
                    gesture.before > last_column ? 'end' : this.column_at(state, gesture.before),
                ));
                return;
        }
    }

    /** Context for a formula on `sheet`; a workbook-scoped name reads from the first worksheet, as the writer does. */
    context(sheet: string | undefined): FormulaAnchorContext {
        const workbook = formula_anchor_workbook('xlsx', this.test.sheets.map((name, index) => {
            const state = this.sheets.get(name)!;
            return {
                target: { sheetIndex: index, sheetName: name },
                name,
                bodyStart: this.test.headerRow,
                sourceRowCount: fixture.rows,
                sourceColumnCount: fixture.columns,
                changes: {
                    appendedRows: [],
                    tailRemovals: [],
                    rowLayout: state.rows,
                    columnLayout: state.columns,
                },
            };
        }));
        return formula_anchor_context(workbook, sheet === undefined ? 0 : this.test.sheets.indexOf(sheet));
    }
}

// --- Normalizing harmless spelling -----------------------------------------

/**
 * Formula text with spelling that cannot change meaning folded away. Outside
 * string literals and quoted sheet names:
 *
 * - case, and whitespace beside an operator or bracket; other whitespace runs,
 *   such as the intersection operator, become one space;
 * - quotes around a sheet name that needs none;
 * - a sheet qualifier on `#REF!`: `'My Data'!#REF!` and `#REF!` are the same
 *   error, and LibreOffice drops the qualifier where Excel keeps it;
 * - a range whose corners are the same cell, `C8:C8`, which LibreOffice
 *   writes as the cell `C8`.
 *
 * `$` flags are compared exactly. String literals and quoted names keep their
 * exact text.
 */
function normalize_formula(text: string): string {
    const quoted: string[] = [];
    let skeleton = '';
    for (let index = 0; index < text.length;) {
        const quote = text[index];
        if (quote !== '"' && quote !== "'") {
            skeleton += quote;
            index += 1;
            continue;
        }
        let end = index + 1;
        while (end < text.length) {
            if (text[end] === quote && text[end + 1] === quote) end += 2;
            else if (text[end] === quote) break;
            else end += 1;
        }
        const literal = text.slice(index, end + 1);
        const bare = literal.slice(1, -1);
        const needless = quote === "'" && /^[A-Za-z_][A-Za-z0-9_.]*$/.test(bare) && !/^[A-Za-z]{1,3}[0-9]+$/.test(bare);
        quoted.push(needless ? bare.toUpperCase() : literal);
        skeleton += `\u0000${quoted.length - 1}\u0000`;
        index = end + 1;
    }
    return skeleton
        .toUpperCase()
        .replace(/\s+/g, ' ')
        .replace(/ ?([(),:+\-*/&=<>^%;{}]) ?/g, '$1')
        .trim()
        .replace(/(?:\u0000\d+\u0000|[A-Z0-9_.]+)!#REF!/g, '#REF!')
        .replace(/(?<![A-Z0-9_.$])(\$?[A-Z]{1,3}\$?[0-9]+):\1(?![A-Z0-9_.$(])/g, '$1')
        .replace(/\u0000(\d+)\u0000/g, (_, index: string) => quoted[Number(index)]);
}

// --- The suite -------------------------------------------------------------

function render(text: string, context: FormulaAnchorContext): string {
    const result = render_formula(text, undefined, context);
    if (result.kind !== 'rendered') throw new Error(`unrenderable: ${result.issue.kind}`);
    return result.text;
}

function label(formula: OracleFormula): string {
    return formula.name === undefined ? `${formula.sheet}: ${formula.text}` : `name ${formula.name}: ${formula.text}`;
}

describe('normalize_formula', () => {
    it('folds case, whitespace, and needless sheet quotes, and keeps literals exact', () => {
        expect(normalize_formula("=sum( 'Sheet1'!b3 : B4 )")).toBe('=SUM(SHEET1!B3:B4)');
        expect(normalize_formula('=SUM(B3:D6   C4:E8)')).toBe('=SUM(B3:D6 C4:E8)');
        expect(normalize_formula(`="a  b"&'My Data'!A1`)).toBe(`="a  b"&'My Data'!A1`);
        // A name that reads as a cell reference must stay quoted.
        expect(normalize_formula("='AB12'!A1")).toBe("='AB12'!A1");
    });

    it('drops a qualifier on #REF! and collapses a one-cell range, and nothing else', () => {
        expect(normalize_formula("='My Data'!#REF!+Sheet1!#REF!")).toBe('=#REF!+#REF!');
        expect(normalize_formula("='My Data'!B4")).toBe("='My Data'!B4");
        expect(normalize_formula('=SUM(C8:C8,$D$2:$D$2)')).toBe('=SUM(C8,$D$2)');
        expect(normalize_formula('=SUM(C8:C9,$C8:C8,3:3,AC8:C8)')).toBe('=SUM(C8:C9,$C8:C8,3:3,AC8:C8)');
        expect(normalize_formula('="C8:C8"')).toBe('="C8:C8"');
    });
});

describe('LibreOffice formula oracle', () => {
    it('has the cases the oracle criterion asks for', () => {
        expect(fixture.libreoffice).toMatch(/^LibreOffice \d/);
        expect(fixture.cases.length).toBeGreaterThanOrEqual(40);
        const ops = new Set(fixture.cases.flatMap((test) => test.gestures.map((gesture) => gesture.op)));
        expect([...ops].sort()).toEqual([
            'deleteColumns', 'deleteRows', 'insertColumns', 'insertRows', 'moveColumns', 'moveRows',
        ]);
    });

    for (const test of fixture.cases) {
        it(test.name, () => {
            const replay = new Replay(test);
            for (const gesture of test.gestures) replay.apply(gesture);
            const single_insert_or_delete = test.gestures.length === 1 && !test.gestures[0].op.startsWith('move');
            for (const formula of test.formulas) {
                const context = replay.context(formula.sheet);
                const ours = render(formula.text, context);
                const agrees = normalize_formula(ours) === normalize_formula(formula.libreoffice);
                const flags = formula_divergence_flags(formula.text, undefined, context);
                switch (formula.expect?.kind) {
                    case undefined:
                        expect(normalize_formula(ours), label(formula)).toBe(normalize_formula(formula.libreoffice));
                        // One insert or delete is never in a flagged class, so the superset stays quiet.
                        if (single_insert_or_delete) expect(flags, label(formula)).toEqual([]);
                        break;
                    case 'flagged':
                        expect(agrees, `${label(formula)} now agrees; drop its classification`).toBe(false);
                        expect(flags, `${label(formula)} differs but is not flagged`).not.toEqual([]);
                        break;
                    case 'libreofficeDiffers':
                        expect(agrees, `${label(formula)} now agrees; drop its classification`).toBe(false);
                        expect(normalize_formula(ours), label(formula))
                            .toBe(normalize_formula(formula.expect.excel));
                        break;
                }
            }
        });
    }
});
