/**
 * Formula Anchors: the row and column identities a formula reference names,
 * and rendering of formula text from those identities for any Worksheet
 * Layout (design: "Formula Anchors", "Rendering formulas", and "Where this
 * differs from Excel" in the row and column structure spec).
 *
 * Source formulas, and pending formulas committed while their targets had the
 * source layout, are implicitly anchored: their text is in source coordinates.
 * A pending formula stores explicit anchors only for references to a worksheet
 * with a live layout change, or with a corner on a Pending Row or Pending
 * Column. Rendering is a function of the text, the stored anchors, and each
 * target worksheet's layout, read through {@link AnchorAxisView}, so the order
 * of gestures that produced a layout never changes a formula.
 *
 * A pure leaf: no webview or host imports. The worksheet layout module
 * adapts its index to {@link AnchorAxisView}.
 */

import type { RowIdentity } from './pending-changes';
import type { ColumnIdentity } from './worksheet-layout';
import { worksheet_target_matches, type WorksheetTarget } from './types';
import {
    a1_column_letters,
    formula_reference_tokens,
    type FormulaReferenceAxis,
    type FormulaReferenceIssue,
    type FormulaReferenceToken,
} from './xlsx-formula';

/** Last 1-based row number of an `.xlsx` worksheet. */
export const XLSX_EDGE_ROW = 1_048_576;
/** Last 1-based column number of an `.xlsx` worksheet (XFD). */
export const XLSX_EDGE_COLUMN = 16_384;

export type RowAnchor =
    | { readonly kind: 'identity'; readonly row: RowIdentity }
    /** 1-based worksheet row at or above the Header Row. */
    | { readonly kind: 'fixed'; readonly row: number }
    /** Body row N + offset, past every live row of the layout; offset ≥ 1. */
    | { readonly kind: 'trailing'; readonly offset: number }
    /** Row 1,048,576. */
    | { readonly kind: 'edge' };

export type ColumnAnchor =
    | { readonly kind: 'identity'; readonly column: ColumnIdentity }
    /** Column N + offset, past every live column; offset ≥ 1. */
    | { readonly kind: 'trailing'; readonly offset: number }
    /** Column XFD. */
    | { readonly kind: 'edge' };

export interface FormulaReferenceAnchorCorner {
    /** Absent for whole-column references. */
    readonly row?: RowAnchor;
    /** Absent for whole-row references. */
    readonly column?: ColumnAnchor;
}

export interface FormulaReferenceAnchor {
    /** UTF-16 span of the reference token in the stored formula text. */
    readonly start: number;
    readonly end: number;
    /** Target worksheet; omitted for the formula's own worksheet. */
    readonly worksheet?: WorksheetTarget;
    /** Corners in the order the author wrote them; one corner for a single cell. */
    readonly corners: readonly FormulaReferenceAnchorCorner[];
}

export interface FormulaAnchors {
    readonly references: readonly FormulaReferenceAnchor[];
}

/**
 * Everything anchoring and rendering need from one axis of one worksheet.
 *
 * Coordinates come in two kinds:
 *
 * - a **position** is 0-based in the axis's body order: positions
 *   `[0, fullCount)` are the layout's members in full order, tombstones
 *   included, and positions `[fullCount, fullCount + bandCount)` are the live
 *   Pending Appended Rows in `createdOrder`;
 * - a **number** is the 1-based worksheet row or column number that a formula
 *   writes, Header Row and the rows above it included.
 */
export interface AnchorAxisView<Identity> {
    /** H: rows fixed above the body, the 1-based Header Row number (0 without one); always 0 for columns. */
    readonly fixedCount: number;
    /** Members of the source layout: source body rows, or source columns. */
    readonly sourceCount: number;
    /** N: live members of the layout, live source plus live pending; excludes the band. */
    readonly liveCount: number;
    /** Members of the layout in full order, tombstones included; excludes the band. */
    readonly fullCount: number;
    /** Live Pending Appended Rows; always 0 for columns. */
    readonly bandCount: number;
    /** Whether the live layout differs from the source layout's: a live pending member, a removal, or a moved run. */
    readonly hasLiveChange: boolean;
    /** Whether the layout has a live Pending Inserted Row or Pending Column, or any source run out of ascending source order. */
    readonly hasInsertOrOutOfOrderRun: boolean;
    /** Position of an identity, or `undefined` if the axis no longer holds it (a discarded appended row, a dropped tombstone). */
    position_of(identity: Identity): number | undefined;
    /** Whether the member at a position is live. Band positions are always live. */
    is_live(position: number): boolean;
    /** Prospective 1-based number of a live position: H + its live index + 1 in the layout, H + N + its index + 1 in the band. */
    prospective_number(position: number): number;
    /** First live position in the inclusive interval `[first, last]`, if any. */
    first_live(first: number, last: number): number | undefined;
    /** Last live position in the inclusive interval `[first, last]`, if any. */
    last_live(first: number, last: number): number | undefined;
    /** Identity at a prospective 1-based number in `(H, H + N + bandCount]`, else `undefined`. */
    identity_at(number: number): Identity | undefined;
    /**
     * Whether the identity lies in a source run that is out of source order
     * with any other source run: one before it starts later in the source, or
     * one after it starts earlier. Pending runs are ignored.
     */
    in_displaced_run(identity: Identity): boolean;
}

/** One worksheet as anchoring and rendering see it. */
export interface AnchorWorksheet {
    readonly target: WorksheetTarget;
    /** The name formulas qualify it by. */
    readonly name: string;
    readonly rows: AnchorAxisView<RowIdentity>;
    readonly columns: AnchorAxisView<ColumnIdentity>;
}

export interface FormulaAnchorContext {
    /** Table format of the formula's worksheet. Only `.xlsx` has formulas. */
    readonly format: 'xlsx' | 'csv' | 'tsv';
    /** Every worksheet of the workbook, in workbook order. */
    readonly worksheets: readonly AnchorWorksheet[];
    /** Index into `worksheets` of the formula's own worksheet. */
    readonly formulaWorksheet: number;
}

export type AnchorFormulaResult =
    | {
        readonly kind: 'anchored';
        /** Absent when every reference stays implicitly anchored. */
        readonly anchors?: FormulaAnchors;
    }
    | { readonly kind: 'refused'; readonly reason: string };

// --- Axis descriptors -------------------------------------------------------

type AxisAnchor = RowAnchor | ColumnAnchor;

interface Axis<Identity> {
    readonly edge: number;
    identity_anchor(identity: Identity): AxisAnchor;
    identity_of(anchor: AxisAnchor): Identity | undefined;
    source_identity(number: number): Identity;
    /** 1-based number of a source identity, for the rows above the body. */
    source_number?(identity: Identity): number | undefined;
}

const ROW_AXIS: Axis<RowIdentity> = {
    edge: XLSX_EDGE_ROW,
    identity_anchor: (row) => ({ kind: 'identity', row }),
    identity_of: (anchor) => anchor.kind === 'identity' && 'row' in anchor ? anchor.row : undefined,
    source_identity: (number) => ({ kind: 'source', sourceRow: number - 1 }),
    source_number: (row) => row.kind === 'source' ? row.sourceRow + 1 : undefined,
};

const COLUMN_AXIS: Axis<ColumnIdentity> = {
    edge: XLSX_EDGE_COLUMN,
    identity_anchor: (column) => ({ kind: 'identity', column }),
    identity_of: (anchor) => anchor.kind === 'identity' && 'column' in anchor
        ? anchor.column
        : undefined,
    source_identity: (number) => ({ kind: 'source', sourceColumn: number - 1 }),
};

// --- Anchoring --------------------------------------------------------------

function resolve_name(
    names: readonly string[],
    formula_worksheet: number,
    name: string | undefined,
): number | undefined {
    if (name === undefined) return formula_worksheet;
    const index = names.findIndex((candidate) => candidate.localeCompare(
        name, undefined, { sensitivity: 'accent' },
    ) === 0);
    return index < 0 ? undefined : index;
}

function resolve_worksheet_name(
    context: FormulaAnchorContext,
    name: string | undefined,
): number | undefined {
    return resolve_name(
        context.worksheets.map((worksheet) => worksheet.name),
        context.formulaWorksheet,
        name,
    );
}

function has_live_change(worksheet: AnchorWorksheet): boolean {
    return worksheet.rows.hasLiveChange || worksheet.columns.hasLiveChange;
}

/**
 * Anchor one coordinate. The body holds `[H + 1, H + body_count]`; a
 * coordinate past it is `trailing`, counted from body row `trailing_base`.
 */
function anchor_number<Identity>(
    axis: Axis<Identity>,
    fixed_count: number,
    body_count: number,
    trailing_base: number,
    number: number,
    identity_at: (number: number) => Identity | undefined,
): AxisAnchor {
    if (number <= fixed_count) return { kind: 'fixed', row: number };
    if (number <= fixed_count + body_count) {
        const identity = identity_at(number);
        if (identity === undefined) {
            throw new Error(`Formula anchoring found no identity at ${number}.`);
        }
        return axis.identity_anchor(identity);
    }
    if (number === axis.edge) return { kind: 'edge' };
    return { kind: 'trailing', offset: number - fixed_count - trailing_base };
}

/** Anchor a coordinate written against the source layout. */
function implicit_axis_anchor<Identity>(
    axis: Axis<Identity>,
    view: AnchorAxisView<Identity>,
    number: number,
): AxisAnchor {
    return anchor_number(
        axis, view.fixedCount, view.sourceCount, view.sourceCount, number, axis.source_identity,
    );
}

/**
 * Anchor a coordinate written against the current prospective layout. A
 * coordinate on a live Pending Appended Row anchors to that row's identity;
 * only one below every live row, layout and band, is `trailing`, with its
 * offset counted from N.
 */
function committed_axis_anchor<Identity>(
    axis: Axis<Identity>,
    view: AnchorAxisView<Identity>,
    number: number,
): AxisAnchor {
    return anchor_number(
        axis,
        view.fixedCount,
        view.liveCount + view.bandCount,
        view.liveCount,
        number,
        (value) => view.identity_at(value),
    );
}

function reference_anchor(
    token: FormulaReferenceToken,
    worksheet: AnchorWorksheet,
    own: boolean,
    anchor_axis: <Identity>(
        axis: Axis<Identity>,
        view: AnchorAxisView<Identity>,
        number: number,
    ) => AxisAnchor,
): FormulaReferenceAnchor {
    return {
        start: token.start,
        end: token.end,
        ...(own ? {} : { worksheet: worksheet.target }),
        corners: token.corners.map((corner) => ({
            ...(corner.row === undefined ? {} : {
                row: anchor_axis(ROW_AXIS, worksheet.rows, corner.row.value) as RowAnchor,
            }),
            ...(corner.column === undefined ? {} : {
                column: column_anchor(anchor_axis(COLUMN_AXIS, worksheet.columns, corner.column.value)),
            }),
        })),
    };
}

function column_anchor(anchor: AxisAnchor): ColumnAnchor {
    if (anchor.kind === 'fixed') {
        throw new Error('Columns have no fixed members.');
    }
    return anchor as ColumnAnchor;
}

/** Whether a committed coordinate lands on a Pending Row or Pending Column. */
function lands_on_pending(token: FormulaReferenceToken, worksheet: AnchorWorksheet): boolean {
    return token.corners.some((corner) => {
        const row = corner.row === undefined
            ? undefined
            : worksheet.rows.identity_at(corner.row.value);
        const column = corner.column === undefined
            ? undefined
            : worksheet.columns.identity_at(corner.column.value);
        return row?.kind === 'pending' || column?.kind === 'pending';
    });
}

/**
 * Worksheets an unanchorable construct may touch. An empty list, or a 3D
 * bound that names no worksheet, could be any worksheet, so it counts as
 * every one. A range whose corners name different worksheets may be a 3D
 * reference (`S1:Sheet3!A1`), so it spans every worksheet between them.
 */
function issue_worksheets(
    workbook: StructureCheckWorkbook,
    issue: FormulaReferenceIssue,
): readonly number[] {
    const every = workbook.names.map((_, index) => index);
    if (issue.worksheets.length === 0) return every;
    const resolved = issue.worksheets.map(
        (name) => resolve_name(workbook.names, workbook.formulaWorksheet, name),
    );
    if (issue.kind === 'threeDimensional') {
        const [first, last] = resolved;
        if (first === undefined || last === undefined) return every;
        return every.slice(Math.min(first, last), Math.max(first, last) + 1);
    }
    const known = resolved.filter((index): index is number => index !== undefined);
    if (issue.kind === 'mixedSheets' && known.length > 0) {
        return every.slice(Math.min(...known), Math.max(...known) + 1);
    }
    return known;
}

/** The workbook as {@link formula_blocks_structure} sees it. */
export interface StructureCheckWorkbook {
    /** Every worksheet name, in workbook order. */
    readonly names: readonly string[];
    /** Index into `names` of the formula's own worksheet. */
    readonly formulaWorksheet: number;
    /** Whether the worksheet at an index into `names` has a live layout change. */
    has_layout_change(index: number): boolean;
}

interface BlockingIssue {
    readonly issue: FormulaReferenceIssue;
    /** A worksheet with a live layout change that the issue touches. */
    readonly worksheet: number;
}

function workbook_of(context: FormulaAnchorContext): StructureCheckWorkbook {
    return {
        names: context.worksheets.map((worksheet) => worksheet.name),
        formulaWorksheet: context.formulaWorksheet,
        has_layout_change: (index) => has_live_change(context.worksheets[index]),
    };
}

/** Every reported construct that touches a worksheet with a live layout change. */
function blocking_issues(
    issues: readonly FormulaReferenceIssue[],
    workbook: StructureCheckWorkbook,
): readonly BlockingIssue[] {
    return issues.flatMap((issue) => {
        const worksheet = issue_worksheets(workbook, issue)
            .find((index) => workbook.has_layout_change(index));
        return worksheet === undefined ? [] : [{ issue, worksheet }];
    });
}

/**
 * The first construct in a formula that a layout change could not adjust,
 * such as `INDEX(A:A,1):B5`, a 3D reference, or a spill reference, or
 * `undefined` when there is none. Rendering such a formula would shift some
 * of its references and not others.
 *
 * Without `workbook`, every reported construct counts: the formula does not
 * lex completely. With it, only a construct that touches a worksheet with a
 * live layout change counts, including one whose worksheets cannot be
 * resolved, which could be any worksheet. `text` may omit the leading `=`.
 */
export function formula_blocks_structure(
    text: string,
    workbook?: StructureCheckWorkbook,
): FormulaReferenceIssue | undefined {
    const { issues } = formula_reference_tokens(text);
    return workbook === undefined ? issues[0] : blocking_issues(issues, workbook)[0]?.issue;
}

function refusal_reason(
    context: FormulaAnchorContext,
    text: string,
    issue: FormulaReferenceIssue,
    index: number,
): string {
    const worksheet = context.worksheets[index];
    const what = worksheet.rows.hasLiveChange && worksheet.columns.hasLiveChange
        ? 'rows and columns'
        : worksheet.rows.hasLiveChange ? 'rows' : 'columns';
    const where = index === context.formulaWorksheet ? 'this sheet' : worksheet.name;
    return `Table Viewer can't adjust the reference \`${text.slice(issue.start, issue.end)}\``
        + ` while ${what} on ${where} are being inserted, deleted, or moved.`;
}

/**
 * Anchor a committed formula. Stores anchors only for references whose
 * target worksheet has a live layout change or whose corner lands on a
 * Pending Row or Pending Column; refuses a construct the tokenizer cannot
 * anchor when it names a worksheet with a live layout change. Never anchors
 * a CSV or TSV value, which is text even when it starts with `=`.
 */
export function anchor_formula(text: string, context: FormulaAnchorContext): AnchorFormulaResult {
    if (context.format !== 'xlsx' || !text.startsWith('=')) return { kind: 'anchored' };
    const lex = formula_reference_tokens(text);
    const blocking = blocking_issues(lex.issues, workbook_of(context))[0];
    if (blocking !== undefined) {
        return {
            kind: 'refused',
            reason: refusal_reason(context, text, blocking.issue, blocking.worksheet),
        };
    }
    const references: FormulaReferenceAnchor[] = [];
    for (const token of lex.references) {
        const index = resolve_worksheet_name(context, token.sheetName);
        if (index === undefined) continue;
        const worksheet = context.worksheets[index];
        if (!has_live_change(worksheet) && !lands_on_pending(token, worksheet)) continue;
        references.push(reference_anchor(
            token, worksheet, index === context.formulaWorksheet, committed_axis_anchor,
        ));
    }
    return references.length === 0 ? { kind: 'anchored' } : { kind: 'anchored', anchors: { references } };
}

/**
 * Anchors of every resolvable reference as the text names it against the
 * source layout, whether or not anchoring would store them.
 */
export function implicit_formula_anchors(
    text: string,
    context: FormulaAnchorContext,
): FormulaAnchors {
    if (context.format !== 'xlsx' || !text.startsWith('=')) return { references: [] };
    const references: FormulaReferenceAnchor[] = [];
    for (const token of formula_reference_tokens(text).references) {
        const index = resolve_worksheet_name(context, token.sheetName);
        if (index === undefined) continue;
        references.push(reference_anchor(
            token,
            context.worksheets[index],
            index === context.formulaWorksheet,
            implicit_axis_anchor,
        ));
    }
    return { references };
}

// --- Placement in the extended order ---------------------------------------

/**
 * One corner placed in the extended order: fixed rows, then the layout with
 * tombstones, then the band, then empty rows and the edge. `segment` and
 * `key` order placements; `number` is the rendered coordinate when live.
 */
type Placement =
    | { readonly kind: 'fixed'; readonly number: number }
    | { readonly kind: 'body'; readonly position: number; readonly live: boolean }
    | { readonly kind: 'past'; readonly number: number; readonly edge: boolean }
    | { readonly kind: 'unknown' };

function place<Identity>(
    axis: Axis<Identity>,
    view: AnchorAxisView<Identity>,
    anchor: AxisAnchor,
): Placement {
    switch (anchor.kind) {
        case 'fixed':
            return { kind: 'fixed', number: anchor.row };
        case 'edge':
            return { kind: 'past', number: axis.edge, edge: true };
        case 'trailing':
            return anchor.offset <= view.bandCount
                ? { kind: 'body', position: view.fullCount + anchor.offset - 1, live: true }
                : {
                    kind: 'past',
                    number: view.fixedCount + view.liveCount + anchor.offset,
                    edge: false,
                };
        case 'identity': {
            const identity = axis.identity_of(anchor);
            // A source row at or above the Header Row is a fixed row, as
            // anchoring it now would record. A draft anchored while an
            // auto-detected Header Row still read as body row 0 holds it as
            // an identity the layout doesn't have.
            const fixed = identity === undefined ? undefined : axis.source_number?.(identity);
            if (fixed !== undefined && fixed >= 1 && fixed <= view.fixedCount) {
                return { kind: 'fixed', number: fixed };
            }
            const position = identity === undefined ? undefined : view.position_of(identity);
            return position === undefined
                ? { kind: 'unknown' }
                : { kind: 'body', position, live: view.is_live(position) };
        }
    }
}

function compare_placements(left: Placement, right: Placement): number {
    const segment = (placement: Placement) => placement.kind === 'fixed'
        ? 0
        : placement.kind === 'body' ? 1 : 2;
    const key = (placement: Placement) => placement.kind === 'body'
        ? placement.position
        : placement.kind === 'unknown' ? 0 : placement.number;
    return segment(left) - segment(right) || key(left) - key(right);
}

/** Rendered number of one corner, or `undefined` for `#REF!`. */
function single_number<Identity>(
    axis: Axis<Identity>,
    view: AnchorAxisView<Identity>,
    placement: Placement,
): number | undefined {
    switch (placement.kind) {
        case 'unknown':
            return undefined;
        case 'fixed':
            return placement.number;
        case 'past':
            return placement.number <= axis.edge ? placement.number : undefined;
        case 'body':
            return placement.live ? view.prospective_number(placement.position) : undefined;
    }
}

/**
 * Smallest and largest live numbers in the extended-order interval between
 * two placements, or `undefined` when the interval has no live member.
 */
function interval_numbers<Identity>(
    axis: Axis<Identity>,
    view: AnchorAxisView<Identity>,
    low: Placement,
    high: Placement,
): readonly [number, number] | undefined {
    if (low.kind === 'unknown' || high.kind === 'unknown') return undefined;
    const body_end = view.fullCount + view.bandCount - 1;
    const first_empty = view.fixedCount + view.liveCount + view.bandCount + 1;
    let min: number | undefined;
    if (low.kind === 'fixed' || low.kind === 'past') {
        min = low.number;
    } else {
        const last = high.kind === 'body' ? high.position : body_end;
        const live = view.first_live(low.position, last);
        min = live !== undefined
            ? view.prospective_number(live)
            : high.kind === 'past' ? Math.min(first_empty, high.number) : undefined;
    }
    let max: number | undefined;
    if (high.kind === 'fixed' || high.kind === 'past') {
        max = high.number;
    } else {
        const first = low.kind === 'body' ? low.position : 0;
        const live = view.last_live(first, high.position);
        max = live !== undefined
            ? view.prospective_number(live)
            : low.kind === 'fixed' ? view.fixedCount : undefined;
    }
    if (min === undefined || max === undefined) return undefined;
    // A `trailing` corner pushed past the last row or column makes the whole
    // reference `#REF!`.
    if (max > axis.edge || min > axis.edge) return undefined;
    return [min, max];
}

interface RenderedAxis {
    /** Rendered number per corner, in authored order. */
    readonly numbers: readonly number[];
}

function render_axis<Identity>(
    axis: Axis<Identity>,
    view: AnchorAxisView<Identity>,
    anchors: readonly AxisAnchor[],
    written: readonly number[],
): RenderedAxis | undefined {
    const placements = anchors.map((anchor) => place(axis, view, anchor));
    if (placements.length === 1) {
        const number = single_number(axis, view, placements[0]);
        return number === undefined ? undefined : { numbers: [number] };
    }
    const [first, second] = placements;
    const forward = compare_placements(first, second) <= 0;
    const interval = interval_numbers(
        axis, view, forward ? first : second, forward ? second : first,
    );
    if (interval === undefined) return undefined;
    // Keep the written orientation: in `A2:A5` the first corner takes the
    // smallest number, in `A5:A2` the largest, even after a move crosses
    // the corners.
    return { numbers: written[0] <= written[1] ? interval : [interval[1], interval[0]] };
}

// --- Rendering --------------------------------------------------------------

function stored_worksheet_index(
    context: FormulaAnchorContext,
    anchor: FormulaReferenceAnchor,
): number {
    if (anchor.worksheet === undefined) return context.formulaWorksheet;
    const index = context.worksheets.findIndex(
        (worksheet) => worksheet_target_matches(anchor.worksheet!, worksheet.target),
    );
    if (index < 0) throw new Error('A formula anchor names a worksheet the workbook lacks.');
    return index;
}

interface ResolvedReference {
    readonly token: FormulaReferenceToken;
    readonly worksheet: AnchorWorksheet;
    readonly anchor: FormulaReferenceAnchor;
    readonly stored: boolean;
}

function check_stored_anchor(token: FormulaReferenceToken, anchor: FormulaReferenceAnchor): void {
    const matches = anchor.corners.length === token.corners.length
        && anchor.corners.every((corner, index) => (corner.row === undefined)
            === (token.corners[index].row === undefined)
            && (corner.column === undefined) === (token.corners[index].column === undefined));
    if (!matches) throw new Error('A formula anchor does not match its reference.');
}

/**
 * Pair every reference token with its stored anchor, or derive its implicit
 * anchor. A worksheet without a live layout change and a reference without a
 * stored anchor needs no rendering, so it is left out.
 */
function resolved_references(
    tokens: readonly FormulaReferenceToken[],
    anchors: FormulaAnchors | undefined,
    context: FormulaAnchorContext,
): readonly ResolvedReference[] {
    const stored = new Map<string, FormulaReferenceAnchor>();
    for (const anchor of anchors?.references ?? []) {
        stored.set(`${anchor.start}:${anchor.end}`, anchor);
    }
    const resolved: ResolvedReference[] = [];
    for (const token of tokens) {
        const key = `${token.start}:${token.end}`;
        const anchor = stored.get(key);
        if (anchor !== undefined) {
            stored.delete(key);
            check_stored_anchor(token, anchor);
            resolved.push({
                token,
                worksheet: context.worksheets[stored_worksheet_index(context, anchor)],
                anchor,
                stored: true,
            });
            continue;
        }
        const index = resolve_worksheet_name(context, token.sheetName);
        if (index === undefined) continue;
        const worksheet = context.worksheets[index];
        if (!has_live_change(worksheet)) continue;
        resolved.push({
            token,
            worksheet,
            anchor: reference_anchor(token, worksheet, index === context.formulaWorksheet, implicit_axis_anchor),
            stored: false,
        });
    }
    if (stored.size > 0) throw new Error('A formula anchor does not match its reference.');
    return resolved;
}

function render_reference(text: string, reference: ResolvedReference): string {
    const { token, worksheet, anchor } = reference;
    const rows = anchor.corners.every((corner) => corner.row === undefined)
        ? undefined
        : render_axis(
            ROW_AXIS,
            worksheet.rows,
            anchor.corners.map((corner) => corner.row!),
            token.corners.map((corner) => corner.row!.value),
        );
    const columns = anchor.corners.every((corner) => corner.column === undefined)
        ? undefined
        : render_axis(
            COLUMN_AXIS,
            worksheet.columns,
            anchor.corners.map((corner) => corner.column!),
            token.corners.map((corner) => corner.column!.value),
        );
    const has_rows = token.corners[0].row !== undefined;
    const has_columns = token.corners[0].column !== undefined;
    if ((has_rows && rows === undefined) || (has_columns && columns === undefined)) {
        // Keep the first qualifier, as Excel writes `Sheet2!#REF!`.
        const head = token.corners[0].sheet?.end ?? token.start;
        return text.slice(token.start, head) + '#REF!';
    }
    let out = '';
    let cursor = token.start;
    const replace = (
        axis: FormulaReferenceAxis | undefined,
        number: number | undefined,
        render: (value: number) => string,
    ) => {
        if (axis === undefined || number === undefined) return;
        out += text.slice(cursor, axis.start);
        out += number === axis.value ? text.slice(axis.start, axis.end) : render(number);
        cursor = axis.end;
    };
    token.corners.forEach((corner, index) => {
        replace(corner.column, columns?.numbers[index], a1_column_letters);
        replace(corner.row, rows?.numbers[index], String);
    });
    return out + text.slice(cursor, token.end);
}

export type RenderFormulaResult =
    | { readonly kind: 'rendered'; readonly text: string }
    /**
     * A construct that a layout change could not adjust touches a worksheet
     * with one (see {@link formula_blocks_structure}). Rendering would shift
     * some references and not others, so there is no text.
     */
    | { readonly kind: 'unrenderable'; readonly issue: FormulaReferenceIssue };

/**
 * Render stored formula text for the current layouts. Only the coordinate
 * characters inside each reference change; `$` flags, qualifiers, external
 * and structured references, and everything else stay as written. On
 * worksheets without a live layout change and without stored anchors the
 * result is the input text exactly. A formula is never partly rendered: one
 * whose unadjustable construct touches a worksheet with a live layout
 * change is `unrenderable`.
 */
export function render_formula(
    text: string,
    anchors: FormulaAnchors | undefined,
    context: FormulaAnchorContext,
): RenderFormulaResult {
    if (context.format !== 'xlsx') {
        if (anchors !== undefined && anchors.references.length > 0) {
            throw new Error('A CSV or TSV value cannot carry formula anchors.');
        }
        return { kind: 'rendered', text };
    }
    if (!text.startsWith('=')) return { kind: 'rendered', text };
    const lex = formula_reference_tokens(text);
    const blocking = blocking_issues(lex.issues, workbook_of(context))[0];
    if (blocking !== undefined) return { kind: 'unrenderable', issue: blocking.issue };
    let out = '';
    let cursor = 0;
    for (const reference of resolved_references(lex.references, anchors, context)) {
        out += text.slice(cursor, reference.token.start) + render_reference(text, reference);
        cursor = reference.token.end;
    }
    return { kind: 'rendered', text: cursor === 0 ? text : out + text.slice(cursor) };
}

// --- Divergence flags -------------------------------------------------------

/**
 * Why a range might render differently from Excel's gesture-by-gesture
 * adjustment ("Where this differs from Excel"):
 *
 * - `cornersCrossed`: the corners now appear in the opposite order from the
 *   order they had when the formula was anchored;
 * - `tombstoneCorner`: a corner is a tombstone, and the axis has a live
 *   Pending Inserted Row or Column or a run out of ascending source order;
 * - `discardedCorner`: the range renders `#REF!` because a corner names an
 *   identity the layout no longer holds, such as a discarded Pending Appended
 *   Row;
 * - `displacedCorner`: a corner lies in a source run out of source order with
 *   some other source run, so a move may have carried it;
 * - `unadjustable`: a construct no layout change can adjust, such as
 *   `INDEX(A:A,1):B5`, touches a worksheet with a live layout change on this
 *   axis, so the formula is `unrenderable`.
 */
export type FormulaDivergenceReason =
    | 'cornersCrossed'
    | 'tombstoneCorner'
    | 'discardedCorner'
    | 'displacedCorner'
    | 'unadjustable';

export interface FormulaDivergenceFlag {
    /** UTF-16 span of the range reference, or of the construct, in the stored text. */
    readonly start: number;
    readonly end: number;
    readonly axis: 'row' | 'column';
    readonly reason: FormulaDivergenceReason;
    /**
     * Indexes into the context's `worksheets` of the worksheets the flagged
     * reference or construct names: the one a range reference targets, or
     * each worksheet with a live change on `axis` that the construct touches.
     */
    readonly worksheets: readonly number[];
}

function axis_flags<Identity>(
    axis: Axis<Identity>,
    view: AnchorAxisView<Identity>,
    anchors: readonly AxisAnchor[],
    written: readonly number[],
): FormulaDivergenceReason[] {
    const reasons: FormulaDivergenceReason[] = [];
    const placements = anchors.map((anchor) => place(axis, view, anchor));
    if (placements.some((placement) => placement.kind === 'unknown')) {
        reasons.push('discardedCorner');
    } else {
        const was = Math.sign(written[0] - written[1]);
        const now = Math.sign(compare_placements(placements[0], placements[1]));
        if (was !== 0 && now !== 0 && was !== now) reasons.push('cornersCrossed');
    }
    if (
        view.hasInsertOrOutOfOrderRun
        && placements.some((placement) => placement.kind === 'body' && !placement.live)
    ) {
        reasons.push('tombstoneCorner');
    }
    if (anchors.some((anchor) => {
        const identity = axis.identity_of(anchor);
        return identity !== undefined
            && (identity as { readonly kind: string }).kind === 'source'
            && view.position_of(identity) !== undefined
            && view.in_displaced_run(identity);
    })) {
        reasons.push('displacedCorner');
    }
    return reasons;
}

/**
 * Flag every range reference that might render differently from Excel. A
 * deliberate superset, decided per range reference and per axis.
 */
export function formula_divergence_flags(
    text: string,
    anchors: FormulaAnchors | undefined,
    context: FormulaAnchorContext,
): readonly FormulaDivergenceFlag[] {
    if (context.format !== 'xlsx' || !text.startsWith('=')) return [];
    const flags: FormulaDivergenceFlag[] = [];
    const lex = formula_reference_tokens(text);
    const workbook = workbook_of(context);
    for (const { issue } of blocking_issues(lex.issues, workbook)) {
        const touched = issue_worksheets(workbook, issue);
        for (const axis of ['row', 'column'] as const) {
            const changed = touched.filter((index) => {
                const worksheet = context.worksheets[index];
                return (axis === 'row' ? worksheet.rows : worksheet.columns).hasLiveChange;
            });
            if (changed.length > 0) {
                flags.push({ start: issue.start, end: issue.end, axis, reason: 'unadjustable', worksheets: changed });
            }
        }
    }
    for (const reference of resolved_references(lex.references, anchors, context)) {
        const { token, worksheet, anchor } = reference;
        if (token.corners.length < 2) continue;
        const worksheets = [context.worksheets.indexOf(worksheet)];
        const push = (axis: 'row' | 'column', reasons: readonly FormulaDivergenceReason[]) => {
            for (const reason of reasons) {
                flags.push({ start: token.start, end: token.end, axis, reason, worksheets });
            }
        };
        if (token.corners[0].row !== undefined) {
            push('row', axis_flags(
                ROW_AXIS,
                worksheet.rows,
                anchor.corners.map((corner) => corner.row!),
                token.corners.map((corner) => corner.row!.value),
            ));
        }
        if (token.corners[0].column !== undefined) {
            push('column', axis_flags(
                COLUMN_AXIS,
                worksheet.columns,
                anchor.corners.map((corner) => corner.column!),
                token.corners.map((corner) => corner.column!.value),
            ));
        }
    }
    return flags;
}
