/**
 * Splitting conditional-formatting and data-validation rules by meaning
 * (design: "Anchor-relative formulas" in the row and column structure spec).
 *
 * A rule's formulas are relative to the top-left cell of its `sqref`: each
 * covered cell evaluates them shifted by its offset from that cell. After a
 * layout change one relative formula may no longer give every cell its old
 * meaning, so each covered cell's formula is taken as it evaluated it in the
 * source, rendered through the layouts, and re-expressed relative to the
 * cell's new position. Cells whose re-expressed formulas agree form one rule.
 *
 * The work runs per piece, not per cell. Each axis of the rule is cut at the
 * live-segment boundaries of the rule's own worksheet (where a covered cell's
 * new position stops moving with its old one) and, for every relative
 * reference with offset `d`, at the live-segment boundaries of the referenced
 * worksheet shifted back by `d` (where the referenced cell's rendering stops
 * moving with the covered cell). Within a piece each rendered coordinate
 * either moves with the cell, which keeps its relative offset, or stays put,
 * which changes the offset at every step, so comparing a piece's two ends
 * decides whether the whole piece shares one formula.
 *
 * A reference's row rendering never depends on its columns and vice versa,
 * except that either axis rendering `#REF!` turns the whole reference into
 * `#REF!`. So each axis is classified on its own, and a cell's formula is the
 * combination of its row class and its column class.
 *
 * Relative references wrap around the sheet edge, as Excel evaluates them in
 * conditional formatting and data validation, so a whole-column rule such as
 * `A2<>A1` keeps one formula on every row.
 *
 * {@link relative_rule_split_count} (the webview's warning before Save) and
 * {@link split_relative_rule} (the XLSX writer) share {@link analyze_rule}, so
 * the count the user is warned about is the count the writer would write.
 *
 * A pure leaf: no webview or host imports.
 */

import {
    render_formula,
    XLSX_EDGE_COLUMN,
    XLSX_EDGE_ROW,
    type AnchorAxisView,
    type AnchorWorksheet,
} from './formula-anchors';
import {
    formula_anchor_context,
    formula_anchor_workbook,
    type AnchorWorksheetInput,
    type FormulaAnchorWorkbook,
} from './formula-anchor-layout';
import type { RowIdentity } from './pending-changes';
import { index_column_layout, index_row_layout, type ColumnIdentity } from './worksheet-layout';
import {
    a1_column_letters,
    formula_reference_tokens,
    type FormulaReferenceAxis,
    type FormulaReferenceIssue,
    type FormulaReferenceToken,
} from './xlsx-formula';

/** One rule may split into at most this many rules; beyond it Save is refused. */
export const MAX_RULE_SPLIT = 64;

/**
 * Coordinates evaluated one by one, per axis of one rule, where a piece's
 * formula changes at every step. Past this the rule is reported as splitting
 * into more than {@link MAX_RULE_SPLIT} rules: that many cells each needing
 * its own formula could only collapse if every reference they vary in were
 * `#REF!` on every column (or row) of the rule.
 */
const MAX_EXPANDED_COORDINATES = 100_000;

/** An inclusive, 0-based cell rectangle. */
export interface RuleCellRange {
    readonly firstRow: number;
    readonly firstColumn: number;
    readonly lastRow: number;
    readonly lastColumn: number;
}

/** A conditional-formatting element or data-validation rule, in source coordinates. */
export interface RelativeRule {
    /** Index into the workbook's worksheets of the worksheet holding the rule. */
    readonly worksheet: number;
    /** The rule's source `sqref`. */
    readonly cells: readonly RuleCellRange[];
    /** Every formula of the rule, without a leading `=`. */
    readonly formulas: readonly string[];
}

// ---------------------------------------------------------------------------
// sqref text
// ---------------------------------------------------------------------------

const SQREF_CELL_RE = /^\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6})$/;

function column_number(letters: string): number {
    let value = 0;
    for (const char of letters.toUpperCase()) value = value * 26 + char.charCodeAt(0) - 64;
    return value;
}

function parse_sqref_cell(text: string): { row: number; column: number } | undefined {
    const match = SQREF_CELL_RE.exec(text);
    if (match === null) return undefined;
    const column = column_number(match[1]);
    const row = Number(match[2]);
    if (column > XLSX_EDGE_COLUMN || row > XLSX_EDGE_ROW) return undefined;
    return { row: row - 1, column: column - 1 };
}

/** Parse a space-separated `sqref`, or `undefined` when any range is unreadable. */
export function parse_rule_sqref(text: string): RuleCellRange[] | undefined {
    const parts = text.trim().split(/\s+/).filter((part) => part !== '');
    if (parts.length === 0) return undefined;
    const ranges: RuleCellRange[] = [];
    for (const part of parts) {
        const [first_text, last_text, extra] = part.split(':');
        if (extra !== undefined) return undefined;
        const first = parse_sqref_cell(first_text);
        const last = last_text === undefined ? first : parse_sqref_cell(last_text);
        if (first === undefined || last === undefined) return undefined;
        ranges.push({
            firstRow: Math.min(first.row, last.row),
            firstColumn: Math.min(first.column, last.column),
            lastRow: Math.max(first.row, last.row),
            lastColumn: Math.max(first.column, last.column),
        });
    }
    return ranges;
}

function cell_text(row: number, column: number): string {
    return `${a1_column_letters(column + 1)}${row + 1}`;
}

/** A1 text of one range: `B2`, or `B2:C5`. */
export function rule_range_text(range: RuleCellRange): string {
    const first = cell_text(range.firstRow, range.firstColumn);
    return range.firstRow === range.lastRow && range.firstColumn === range.lastColumn
        ? first
        : `${first}:${cell_text(range.lastRow, range.lastColumn)}`;
}

/** A1 text of a space-separated `sqref`. */
export function rule_sqref_text(ranges: readonly RuleCellRange[]): string {
    return ranges.map(rule_range_text).join(' ');
}

// ---------------------------------------------------------------------------
// The workbook: rendering views plus each axis's cut points
// ---------------------------------------------------------------------------

type AxisName = 'rows' | 'columns';

/**
 * One axis of one worksheet as the split sees it. Coordinates are 0-based
 * physical rows or columns. `old_to_new` and `new_to_old` follow cell-set
 * semantics as the worksheet restructure stage applies it to a `sqref`:
 * fixed rows stay, body members follow the layout, members past the body
 * shift by its change in size, and the last row or column of the sheet is
 * pinned.
 */
interface SplitAxis {
    readonly size: number;
    /** Whether the axis has a live layout change; without one every map is the identity. */
    readonly changed: boolean;
    /** Sorted, unique coordinates in `[0, size]` where the axis's maps or renderings may change behavior. */
    readonly cuts: readonly number[];
    old_to_new(old: number): number | null;
    /** The old coordinate of a new one, or null for a Pending Row or Column, or a vacated one. */
    new_to_old(position: number): number | null;
}

function sorted_unique(values: readonly number[]): number[] {
    return [...new Set(values)].sort((left, right) => left - right);
}

function identity_axis(size: number): SplitAxis {
    return {
        size,
        changed: false,
        cuts: [],
        old_to_new: (old) => old >= 0 && old < size ? old : null,
        new_to_old: (position) => position >= 0 && position < size ? position : null,
    };
}

function split_axis<I>(
    view: AnchorAxisView<I>,
    size: number,
    boundaries: readonly number[],
    source_identity: (source: number) => I,
    source_of: (identity: I) => number | undefined,
): SplitAxis {
    if (!view.hasLiveChange) return identity_axis(size);
    const fixed = view.fixedCount;
    const source_end = fixed + view.sourceCount;
    const live_end = fixed + view.liveCount;
    const edge = source_end <= size - 1 && live_end <= size - 1;
    const shift = live_end - source_end;
    const cuts = sorted_unique([
        0,
        fixed,
        source_end,
        size - 1,
        size,
        ...boundaries,
        // A trailing reference renders `#REF!` once it passes the last row.
        size - shift,
        // A trailing cell drops out of a cell set once it reaches the pinned edge.
        size - 1 - shift,
    ].filter((cut) => Number.isSafeInteger(cut) && cut >= 0 && cut <= size));
    return {
        size,
        changed: true,
        cuts,
        old_to_new: (old) => {
            if (!Number.isSafeInteger(old) || old < 0 || old >= size) return null;
            if (old < fixed) return old;
            if (old < source_end) {
                const position = view.position_of(source_identity(old));
                return position !== undefined && view.is_live(position)
                    ? view.prospective_number(position) - 1
                    : null;
            }
            if (!edge) return null;
            if (old === size - 1) return size - 1;
            const next = old + shift;
            return next < size - 1 ? next : null;
        },
        new_to_old: (position) => {
            if (!Number.isSafeInteger(position) || position < 0 || position >= size) return null;
            if (position < fixed) return position;
            if (position < live_end) {
                const identity = view.identity_at(position + 1);
                return identity === undefined ? null : source_of(identity) ?? null;
            }
            if (!edge) return null;
            if (position === size - 1) return size - 1;
            const old = position - shift;
            return old < size - 1 ? old : null;
        },
    };
}

/** Everything the split needs about a workbook, built once per layout state. */
export interface RuleSplitWorkbook {
    readonly anchors: FormulaAnchorWorkbook;
    /** @internal */
    readonly axes: readonly { readonly rows: SplitAxis; readonly columns: SplitAxis }[];
}

function source_boundaries(segments: readonly { readonly kind: string; readonly start?: number; readonly count: number }[]): number[] {
    const out: number[] = [];
    for (const segment of segments) {
        if (segment.kind !== 'source' || segment.start === undefined) continue;
        out.push(segment.start, segment.start + segment.count);
    }
    return out;
}

/**
 * The split's view of a workbook: its anchor views (the same ones
 * `render_formula` reads) and, per worksheet axis, the cut points of its
 * live-segment partition.
 */
export function rule_split_workbook(inputs: readonly AnchorWorksheetInput[]): RuleSplitWorkbook {
    const anchors = formula_anchor_workbook('xlsx', inputs);
    const axes = inputs.map((input, index) => {
        const worksheet: AnchorWorksheet = anchors.worksheets[index];
        const row_layout = input.changes?.rowLayout;
        const column_layout = input.changes?.columnLayout;
        return {
            rows: split_axis<RowIdentity>(
                worksheet.rows,
                XLSX_EDGE_ROW,
                row_layout === undefined ? [] : source_boundaries(index_row_layout(row_layout).segments),
                (sourceRow) => ({ kind: 'source', sourceRow }),
                (identity) => identity.kind === 'source' ? identity.sourceRow : undefined,
            ),
            columns: split_axis<ColumnIdentity>(
                worksheet.columns,
                XLSX_EDGE_COLUMN,
                column_layout === undefined ? [] : source_boundaries(index_column_layout(column_layout).segments),
                (sourceColumn) => ({ kind: 'source', sourceColumn }),
                (identity) => identity.kind === 'source' ? identity.sourceColumn : undefined,
            ),
        };
    });
    return { anchors, axes };
}

// ---------------------------------------------------------------------------
// Translation with wraparound
// ---------------------------------------------------------------------------

function wrap(value: number, size: number): number {
    return ((((value - 1) % size) + size) % size) + 1;
}

function modulo(value: number, size: number): number {
    return ((value % size) + size) % size;
}

function axis_text(axis: AxisName, value: number): string {
    return axis === 'rows' ? String(value) : a1_column_letters(value);
}

/**
 * Shift the relative coordinates of every reference token by `(rows,
 * columns)`, wrapping around the sheet edge. Relative coordinates are always
 * written in canonical form (upper-case column letters); absolute ones and
 * everything outside reference tokens are copied unchanged. `text` starts
 * with `=`.
 */
export function wrap_translate_formula(text: string, rows: number, columns: number): string {
    let out = '';
    let cursor = 0;
    const replace = (axis: FormulaReferenceAxis | undefined, name: AxisName, delta: number): void => {
        if (axis === undefined || axis.absolute) return;
        const size = name === 'rows' ? XLSX_EDGE_ROW : XLSX_EDGE_COLUMN;
        out += text.slice(cursor, axis.start) + axis_text(name, wrap(axis.value + delta, size));
        cursor = axis.end;
    };
    for (const token of formula_reference_tokens(text).references) {
        for (const corner of token.corners) {
            replace(corner.column, 'columns', columns);
            replace(corner.row, 'rows', rows);
        }
    }
    return out + text.slice(cursor);
}

// ---------------------------------------------------------------------------
// Rule analysis
// ---------------------------------------------------------------------------

interface PreparedToken {
    readonly formula: number;
    readonly token: FormulaReferenceToken;
    /** Index of the referenced worksheet, or undefined for one the workbook lacks. */
    readonly target: number | undefined;
}

interface PreparedRule {
    readonly worksheet: number;
    /** Old top-left of the rule's `sqref`, 0-based. */
    readonly base: { readonly rows: number; readonly columns: number };
    /** Each formula with its leading `=`. */
    readonly texts: readonly string[];
    readonly tokens: readonly PreparedToken[];
    readonly issues: readonly FormulaReferenceIssue[];
}

/** A class: one part per token, `''` when the token has no coordinate on the axis. */
type AxisClass = readonly string[];

/** A stretch of old coordinates that all map, and the class of each. */
interface AxisInterval {
    readonly old: number;
    readonly length: number;
    readonly neu: number;
    /** One class id for the whole stretch, or one per coordinate. */
    readonly ids: readonly number[];
}

interface AxisAnalysis {
    readonly intervals: readonly AxisInterval[];
    readonly classes: readonly AxisClass[];
    /** First old and new coordinate of each class. */
    readonly representatives: readonly { readonly old: number; readonly neu: number }[];
}

interface RuleAnalysis {
    readonly rule: PreparedRule;
    readonly rows: AxisAnalysis;
    readonly columns: AxisAnalysis;
}

type AnalysisResult =
    | { readonly kind: 'analyzed'; readonly analysis: RuleAnalysis }
    | { readonly kind: 'unrenderable'; readonly issue: FormulaReferenceIssue }
    | { readonly kind: 'tooMany' };

function resolve_worksheet(workbook: RuleSplitWorkbook, own: number, name: string | undefined): number | undefined {
    if (name === undefined) return own;
    const index = workbook.anchors.worksheets.findIndex((worksheet) => worksheet.name.localeCompare(
        name, undefined, { sensitivity: 'accent' },
    ) === 0);
    return index < 0 ? undefined : index;
}

function prepare_rule(workbook: RuleSplitWorkbook, rule: RelativeRule): PreparedRule {
    let rows = Infinity;
    let columns = Infinity;
    for (const range of rule.cells) {
        rows = Math.min(rows, range.firstRow);
        columns = Math.min(columns, range.firstColumn);
    }
    const texts = rule.formulas.map((formula) => `=${formula}`);
    const tokens: PreparedToken[] = [];
    const issues: FormulaReferenceIssue[] = [];
    texts.forEach((text, formula) => {
        const lex = formula_reference_tokens(text);
        issues.push(...lex.issues);
        for (const token of lex.references) {
            tokens.push({ formula, token, target: resolve_worksheet(workbook, rule.worksheet, token.sheetName) });
        }
    });
    return { worksheet: rule.worksheet, base: { rows, columns }, texts, tokens, issues };
}

function quoted_name(name: string): string {
    return `'${name.replace(/'/g, "''")}'!`;
}

function corner_axis(token: FormulaReferenceToken, axis: AxisName): FormulaReferenceAxis[] | undefined {
    const values = token.corners.map((corner) => axis === 'rows' ? corner.row : corner.column);
    return values.every((value) => value !== undefined) ? values as FormulaReferenceAxis[] : undefined;
}

/** Renders one axis of a reference through the target worksheet's layout. */
class AxisRenderer {
    private readonly cache = new Map<string, readonly number[] | null>();

    constructor(private readonly workbook: RuleSplitWorkbook) {}

    /** Rendered numbers per corner, or null for `#REF!`. */
    render(target: number | undefined, axis: AxisName, values: readonly number[]): readonly number[] | null {
        if (target === undefined || !this.workbook.axes[target][axis].changed) return values;
        const first = values[0];
        const last = values[values.length - 1];
        const key = `${target}:${axis}:${first}:${last}`;
        if (this.cache.has(key)) {
            const cached = this.cache.get(key)!;
            return cached === null ? null : cached.slice(0, values.length);
        }
        // The axis alone, as a whole-row or whole-column reference: rendering
        // treats each axis of a reference independently, and a single corner
        // renders like a range of one.
        const prefix = `=${quoted_name(this.workbook.anchors.worksheets[target].name)}`;
        const text = `${prefix}${axis_text(axis, first)}:${axis_text(axis, last)}`;
        const result = render_formula(text, undefined, formula_anchor_context(this.workbook.anchors, target));
        if (result.kind !== 'rendered') throw new Error('An axis reference could not be rendered.');
        const rest = result.text.slice(prefix.length);
        let rendered: readonly number[] | null = null;
        if (rest !== '#REF!') {
            const [low, high] = rest.split(':');
            rendered = axis === 'rows' ? [Number(low), Number(high)] : [column_number(low), column_number(high)];
            if (rendered.some((value) => !Number.isSafeInteger(value) || value < 1)) {
                throw new Error('An axis reference rendered unreadable text.');
            }
        }
        this.cache.set(key, rendered);
        return rendered === null ? null : rendered.slice(0, values.length);
    }
}

/**
 * The class of one old coordinate whose new coordinate is `neu`: per token,
 * `R` for `#REF!`, otherwise each corner as `$n` (absolute, rendered) or
 * `@o` (relative, offset from the cell's new coordinate).
 */
function class_at(
    rule: PreparedRule,
    axis: AxisName,
    renderer: AxisRenderer,
    old: number,
    neu: number,
): AxisClass {
    const size = axis === 'rows' ? XLSX_EDGE_ROW : XLSX_EDGE_COLUMN;
    const delta = old - rule.base[axis];
    return rule.tokens.map(({ token, target }) => {
        const values = corner_axis(token, axis);
        if (values === undefined) return '';
        const translated = values.map((value) => value.absolute ? value.value : wrap(value.value + delta, size));
        const rendered = renderer.render(target, axis, translated);
        if (rendered === null) return 'R';
        return values.map((value, index) => value.absolute
            ? `$${rendered[index]}`
            : `@${modulo(rendered[index] - (neu + 1), size)}`).join(',');
    });
}

/** Covered old coordinates of one axis, as sorted, disjoint half-open spans. */
function covered_spans(cells: readonly RuleCellRange[], axis: AxisName): { start: number; end: number }[] {
    const spans = cells
        .map((range) => axis === 'rows'
            ? { start: range.firstRow, end: range.lastRow + 1 }
            : { start: range.firstColumn, end: range.lastColumn + 1 })
        .sort((left, right) => left.start - right.start);
    const out: { start: number; end: number }[] = [];
    for (const span of spans) {
        const last = out[out.length - 1];
        if (last !== undefined && span.start <= last.end) last.end = Math.max(last.end, span.end);
        else out.push({ ...span });
    }
    return out;
}

/** Cuts in `[low, high)`, from a sorted list shifted by `-shift` modulo `size`. */
function shifted_cuts(cuts: readonly number[], shift: number, low: number, high: number, size: number, out: number[]): void {
    // Old coordinate c is cut where the target t = c + shift (mod size) is a cut.
    const take = (from: number, to: number, offset: number): void => {
        // Target cuts in [from, to) map to from - offset ...
        let lo = 0;
        let hi = cuts.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (cuts[mid] < from) lo = mid + 1;
            else hi = mid;
        }
        for (let at = lo; at < cuts.length && cuts[at] < to; at++) out.push(cuts[at] - offset);
    };
    const start = modulo(low + shift, size);
    const length = high - low;
    if (start + length <= size) {
        take(start, start + length, start - low);
    } else {
        take(start, size, start - low);
        take(0, start + length - size, start - low - size);
    }
}

const WRAP_CUTS: readonly number[] = [0];

function analyze_axis(
    workbook: RuleSplitWorkbook,
    rule: PreparedRule,
    cells: readonly RuleCellRange[],
    axis: AxisName,
    renderer: AxisRenderer,
): AxisAnalysis | 'tooMany' {
    const own = workbook.axes[rule.worksheet][axis];
    const size = own.size;
    const classes: AxisClass[] = [];
    const representatives: { old: number; neu: number }[] = [];
    const ids = new Map<string, number>();
    const intern = (value: AxisClass, old: number, neu: number): number => {
        const key = value.join('\u0000');
        let id = ids.get(key);
        if (id === undefined) {
            id = classes.length;
            ids.set(key, id);
            classes.push(value);
            representatives.push({ old, neu });
        }
        return id;
    };
    // Relative corners whose target axis can cut the rule.
    const shifts: { readonly shift: number; readonly cuts: readonly number[] }[] = [];
    for (const { token, target } of rule.tokens) {
        for (const value of corner_axis(token, axis) ?? []) {
            if (value.absolute) continue;
            const target_axis = target === undefined ? undefined : workbook.axes[target][axis];
            // A changed axis's cuts include 0, where a wrapped reference crosses the edge.
            const cuts = target_axis?.changed === true ? target_axis.cuts : WRAP_CUTS;
            shifts.push({ shift: value.value - 1 - rule.base[axis], cuts });
        }
    }
    const intervals: AxisInterval[] = [];
    let expanded = 0;
    for (const span of covered_spans(cells, axis)) {
        const found: number[] = [span.start, span.end];
        shifted_cuts(own.cuts, 0, span.start, span.end, size, found);
        for (const { shift, cuts } of shifts) shifted_cuts(cuts, shift, span.start, span.end, size, found);
        const points = sorted_unique(found.filter((cut) => cut >= span.start && cut <= span.end));
        for (let at = 0; at + 1 < points.length; at++) {
            const old = points[at];
            const length = points[at + 1] - old;
            const neu = own.old_to_new(old);
            if (neu === null) continue;
            const first = class_at(rule, axis, renderer, old, neu);
            const last = length === 1 ? first : class_at(rule, axis, renderer, old + length - 1, neu + length - 1);
            if (first.join('\u0000') === last.join('\u0000')) {
                intervals.push({ old, length, neu, ids: [intern(first, old, neu)] });
                continue;
            }
            expanded += length;
            if (expanded > MAX_EXPANDED_COORDINATES) return 'tooMany';
            const per: number[] = [];
            for (let offset = 0; offset < length; offset++) {
                per.push(intern(class_at(rule, axis, renderer, old + offset, neu + offset), old + offset, neu + offset));
            }
            intervals.push({ old, length, neu, ids: per });
        }
    }
    return { intervals, classes, representatives };
}

function analyze_rule(workbook: RuleSplitWorkbook, rule: RelativeRule): AnalysisResult {
    const prepared = prepare_rule(workbook, rule);
    const context = formula_anchor_context(workbook.anchors, rule.worksheet);
    for (const text of prepared.texts) {
        const rendered = render_formula(text, undefined, context);
        if (rendered.kind === 'unrenderable') return { kind: 'unrenderable', issue: rendered.issue };
    }
    const renderer = new AxisRenderer(workbook);
    const rows = analyze_axis(workbook, prepared, rule.cells, 'rows', renderer);
    if (rows === 'tooMany') return { kind: 'tooMany' };
    const columns = analyze_axis(workbook, prepared, rule.cells, 'columns', renderer);
    if (columns === 'tooMany') return { kind: 'tooMany' };
    return { kind: 'analyzed', analysis: { rule: prepared, rows, columns } };
}

/** The combined key of a row class and a column class: per token, `R` when either axis is `#REF!`. */
function combined_key(row: AxisClass, column: AxisClass): string {
    return row.map((part, index) => {
        const other = column[index];
        if (part === 'R' || other === 'R') return 'R';
        return `${part}|${other}`;
    }).join('\u0000');
}

/** Distinct class ids of the intervals overlapping `[first, last]`. */
function ids_within(analysis: AxisAnalysis, first: number, last: number): Set<number> {
    const out = new Set<number>();
    for (const interval of analysis.intervals) {
        const low = Math.max(first, interval.old);
        const high = Math.min(last, interval.old + interval.length - 1);
        if (low > high) continue;
        if (interval.ids.length === 1) {
            out.add(interval.ids[0]);
            continue;
        }
        for (let at = low; at <= high; at++) out.add(interval.ids[at - interval.old]);
    }
    return out;
}

function count_groups(analysis: RuleAnalysis, cells: readonly RuleCellRange[], limit: number): number {
    const keys = new Set<string>();
    for (const range of cells) {
        const rows = ids_within(analysis.rows, range.firstRow, range.lastRow);
        const columns = ids_within(analysis.columns, range.firstColumn, range.lastColumn);
        for (const row of rows) {
            for (const column of columns) {
                keys.add(combined_key(analysis.rows.classes[row], analysis.columns.classes[column]));
                if (keys.size > limit) return keys.size;
            }
        }
    }
    return keys.size;
}

export type RuleSplitCount =
    /** How many rules the rule becomes: 0 when every covered cell is removed, or `MAX_RULE_SPLIT + 1` for more than the cap. */
    | { readonly kind: 'count'; readonly count: number }
    /** A formula has a construct that cannot be adjusted for the layout. */
    | { readonly kind: 'unrenderable'; readonly issue: FormulaReferenceIssue };

/**
 * How many rules one conditional-formatting element or data-validation rule
 * splits into for the current layouts. The count stops at
 * `MAX_RULE_SPLIT + 1`; anything above `MAX_RULE_SPLIT` refuses Save.
 *
 * Pass every formula of the element: the formulas of all its `cfRule`s split
 * together, because they share one `sqref`.
 */
export function relative_rule_split_count(workbook: RuleSplitWorkbook, rule: RelativeRule): RuleSplitCount {
    const result = analyze_rule(workbook, rule);
    if (result.kind === 'unrenderable') return result;
    if (result.kind === 'tooMany') return { kind: 'count', count: MAX_RULE_SPLIT + 1 };
    return { kind: 'count', count: count_groups(result.analysis, rule.cells, MAX_RULE_SPLIT) };
}

// ---------------------------------------------------------------------------
// The writer's split
// ---------------------------------------------------------------------------

/** One rule after the split. */
export interface RuleSplitGroup {
    /** Each formula, without a leading `=`, relative to the top-left of `cells`. */
    readonly formulas: readonly string[];
    /** The group's cells in new coordinates, as row bands in row-major order. */
    readonly cells: readonly RuleCellRange[];
}

export type RuleSplitResult =
    /** In order of each group's first cell, row-major; the first keeps the original element. */
    | { readonly kind: 'split'; readonly groups: readonly RuleSplitGroup[] }
    | { readonly kind: 'tooMany'; readonly count: number }
    | { readonly kind: 'unrenderable'; readonly issue: FormulaReferenceIssue };

interface ClassRun {
    readonly start: number;
    readonly end: number;
    readonly id: number;
}

/**
 * Class runs over new coordinates `[low, high]`. A new coordinate with no old
 * one, a Pending Row or Column or a vacated one, takes the class of the
 * coordinate before it: the rule is filled into it.
 */
function new_class_runs(analysis: AxisAnalysis, low: number, high: number): ClassRun[] {
    const images = analysis.intervals
        .map((interval) => ({ start: interval.neu, end: interval.neu + interval.length, interval }))
        .sort((left, right) => left.start - right.start);
    const runs: ClassRun[] = [];
    const push = (start: number, end: number, id: number): void => {
        if (start >= end) return;
        const last = runs[runs.length - 1];
        if (last !== undefined && last.end === start && last.id === id) runs[runs.length - 1] = { start: last.start, end, id };
        else runs.push({ start, end, id });
    };
    let cursor = low;
    let previous: number | undefined;
    for (const { start, end, interval } of images) {
        if (end <= cursor) {
            previous = interval.ids[interval.ids.length - 1];
            continue;
        }
        if (start > high) break;
        if (start > cursor) {
            if (previous === undefined) throw new Error('A rule cell has no covered cell before it.');
            push(cursor, Math.min(start, high + 1), previous);
        }
        const from = Math.max(start, cursor);
        const to = Math.min(end, high + 1);
        if (interval.ids.length === 1) {
            push(from, to, interval.ids[0]);
        } else {
            for (let at = from; at < to; at++) push(at, at + 1, interval.ids[at - start]);
        }
        previous = interval.ids[interval.ids.length - 1];
        cursor = to;
        if (cursor > high) break;
    }
    if (cursor <= high) {
        if (previous === undefined) throw new Error('A rule cell has no covered cell before it.');
        push(cursor, high + 1, previous);
    }
    return runs;
}

interface Band {
    readonly start: number;
    readonly end: number;
    columns: { start: number; end: number }[];
}

function canonical_columns(spans: readonly { start: number; end: number }[]): { start: number; end: number }[] {
    const sorted = [...spans].sort((left, right) => left.start - right.start);
    const out: { start: number; end: number }[] = [];
    for (const span of sorted) {
        const last = out[out.length - 1];
        if (last !== undefined && span.start <= last.end) last.end = Math.max(last.end, span.end);
        else out.push({ ...span });
    }
    return out;
}

function bands_to_ranges(bands: readonly Band[]): RuleCellRange[] {
    const sorted = [...bands].sort((left, right) => left.start - right.start);
    const merged: Band[] = [];
    for (const band of sorted) {
        const columns = canonical_columns(band.columns);
        const last = merged[merged.length - 1];
        if (last !== undefined && last.start === band.start && last.end === band.end) {
            last.columns = canonical_columns([...last.columns, ...columns]);
            continue;
        }
        if (last !== undefined && last.end === band.start && last.columns.length === columns.length
            && last.columns.every((span, index) => span.start === columns[index].start && span.end === columns[index].end)) {
            merged[merged.length - 1] = { start: last.start, end: band.end, columns: last.columns };
            continue;
        }
        merged.push({ start: band.start, end: band.end, columns });
    }
    return merged.flatMap((band) => band.columns.map((span) => ({
        firstRow: band.start,
        firstColumn: span.start,
        lastRow: band.end - 1,
        lastColumn: span.end - 1,
    })));
}

/** One formula of a group, written relative to the group's top-left `(row, column)`. */
function group_formula(
    rule: PreparedRule,
    formula: number,
    parts: readonly string[],
    row: number,
    column: number,
): string {
    const text = rule.texts[formula];
    let out = '';
    let cursor = 0;
    rule.tokens.forEach(({ formula: owner, token }, index) => {
        if (owner !== formula) return;
        const part = parts[index];
        out += text.slice(cursor, token.start);
        if (part === 'R') {
            const head = token.corners[0].sheet?.end ?? token.start;
            out += text.slice(token.start, head) + '#REF!';
            cursor = token.end;
            return;
        }
        const [row_part, column_part] = part.split('|');
        const decode = (encoded: string | undefined): string[] => encoded === undefined || encoded === '' ? [] : encoded.split(',');
        const rows = decode(row_part);
        const columns = decode(column_part);
        let inner = token.start;
        let piece = '';
        const replace = (axis: FormulaReferenceAxis | undefined, encoded: string | undefined, name: AxisName, base: number): void => {
            if (axis === undefined || encoded === undefined) return;
            const size = name === 'rows' ? XLSX_EDGE_ROW : XLSX_EDGE_COLUMN;
            piece += text.slice(inner, axis.start);
            if (encoded.startsWith('$')) {
                const value = Number(encoded.slice(1));
                piece += value === axis.value ? text.slice(axis.start, axis.end) : axis_text(name, value);
            } else {
                piece += axis_text(name, wrap(base + 1 + Number(encoded.slice(1)), size));
            }
            inner = axis.end;
        };
        token.corners.forEach((corner, at) => {
            replace(corner.column, columns[at], 'columns', column);
            replace(corner.row, rows[at], 'rows', row);
        });
        out += piece + text.slice(inner, token.end);
        cursor = token.end;
    });
    return (out + text.slice(cursor)).slice(1);
}

/**
 * Split one rule by meaning for the current layouts.
 *
 * `new_cells` is the rule's `sqref` after cell-set semantics, as the
 * worksheet restructure stage wrote it (for a worksheet without a layout
 * change, its source `sqref`). A new cell with no old one takes the formula
 * of the covered cell before it, on the row axis first.
 *
 * Every group's formulas are checked against `render_formula` at one cell
 * per distinct pair of row and column classes, so a disagreement with the
 * renderer throws rather than writing a rule with a different meaning.
 */
export function split_relative_rule(
    workbook: RuleSplitWorkbook,
    rule: RelativeRule,
    new_cells: readonly RuleCellRange[],
): RuleSplitResult {
    const result = analyze_rule(workbook, rule);
    if (result.kind === 'unrenderable') return result;
    if (result.kind === 'tooMany') return { kind: 'tooMany', count: MAX_RULE_SPLIT + 1 };
    const { analysis } = result;
    const count = count_groups(analysis, rule.cells, MAX_RULE_SPLIT);
    if (count > MAX_RULE_SPLIT) return { kind: 'tooMany', count };
    if (new_cells.length === 0) return { kind: 'split', groups: [] };

    let low_row = Infinity;
    let high_row = -1;
    let low_column = Infinity;
    let high_column = -1;
    for (const range of new_cells) {
        low_row = Math.min(low_row, range.firstRow);
        high_row = Math.max(high_row, range.lastRow);
        low_column = Math.min(low_column, range.firstColumn);
        high_column = Math.max(high_column, range.lastColumn);
    }
    const row_runs = new_class_runs(analysis.rows, low_row, high_row);
    const column_runs = new_class_runs(analysis.columns, low_column, high_column);
    const runs_within = (runs: readonly ClassRun[], first: number, last: number): ClassRun[] => runs
        .filter((run) => run.end > first && run.start <= last)
        .map((run) => ({ start: Math.max(run.start, first), end: Math.min(run.end, last + 1), id: run.id }));

    interface Group {
        readonly key: string;
        readonly row: number;
        readonly column: number;
        readonly bands: Band[];
        readonly pairs: Set<string>;
    }
    const groups = new Map<string, Group>();
    for (const range of new_cells) {
        const columns = runs_within(column_runs, range.firstColumn, range.lastColumn);
        for (const row_run of runs_within(row_runs, range.firstRow, range.lastRow)) {
            for (const column_run of columns) {
                const key = combined_key(analysis.rows.classes[row_run.id], analysis.columns.classes[column_run.id]);
                let group = groups.get(key);
                if (group === undefined) {
                    group = { key, row: Infinity, column: Infinity, bands: [], pairs: new Set() };
                    groups.set(key, group);
                }
                group.bands.push({
                    start: row_run.start,
                    end: row_run.end,
                    columns: [{ start: column_run.start, end: column_run.end }],
                });
                group.pairs.add(`${row_run.id}:${column_run.id}`);
            }
        }
    }
    if (groups.size > MAX_RULE_SPLIT) return { kind: 'tooMany', count: groups.size };

    const context = formula_anchor_context(workbook.anchors, rule.worksheet);
    const out: (RuleSplitGroup & { readonly first: RuleCellRange })[] = [];
    for (const group of groups.values()) {
        const cells = bands_to_ranges(group.bands);
        const top = Math.min(...cells.map((range) => range.firstRow));
        const left = Math.min(...cells.map((range) => range.firstColumn));
        const parts = group.key.split('\u0000');
        const formulas = analysis.rule.texts.map((_, formula) => group_formula(analysis.rule, formula, parts, top, left));
        for (const pair of group.pairs) {
            const [row_id, column_id] = pair.split(':').map(Number);
            const row = analysis.rows.representatives[row_id];
            const column = analysis.columns.representatives[column_id];
            analysis.rule.texts.forEach((text, formula) => {
                const evaluated = render_formula(
                    wrap_translate_formula(text, row.old - analysis.rule.base.rows, column.old - analysis.rule.base.columns),
                    undefined,
                    context,
                );
                const expected = wrap_translate_formula(`=${formulas[formula]}`, row.neu - top, column.neu - left);
                if (evaluated.kind !== 'rendered' || evaluated.text !== expected) {
                    throw new Error('A split rule formula disagrees with the formula renderer.');
                }
            });
        }
        out.push({ formulas, cells, first: cells[0] });
    }
    out.sort((left, right) => left.first.firstRow - right.first.firstRow || left.first.firstColumn - right.first.firstColumn);
    return { kind: 'split', groups: out.map(({ formulas, cells }) => ({ formulas, cells })) };
}

/**
 * Whether `rule` has a construct the tokenizer cannot adjust. Such a rule may
 * keep its text only while its cells and formulas stay exactly as they were.
 */
export function relative_rule_issues(rule: RelativeRule): readonly FormulaReferenceIssue[] {
    return rule.formulas.flatMap((formula) => formula_reference_tokens(`=${formula}`).issues);
}
