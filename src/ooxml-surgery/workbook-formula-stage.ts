// XLSX workbook formula stage: the workbook-wide pass of delivery step 9 of
// the row and column structure design ("Physical write", "Coverage", and
// "Rendering formulas").
//
// It runs after `restructure_worksheet` has rewritten every worksheet with a
// live layout change into prospective coordinates, and renders every formula
// in the workbook that the layouts can change:
//
//   - cell formulas on every worksheet, from the implicit anchors of their
//     source text. A shared formula group whose cells all shifted together,
//     whose rendered text is unchanged, keeps its sharing and only has its
//     master's `ref` re-rendered by cell-set semantics; any other affected
//     group is unshared, each follower written explicitly as the formula it
//     evaluated (`translate_a1_formula`) rendered for the layouts. Unsharing
//     is capped per save;
//   - defined names in `workbook.xml`, print areas and titles included;
//   - internal hyperlink `location`s on every worksheet;
//   - conditional-formatting and data-validation formulas, split by meaning
//     (`formula-rule-split.ts`), with priorities kept unique;
//   - pending formulas: from their stored anchors when they have them,
//     otherwise from implicit anchors.
//
// A formula that cannot be rendered is refused, never written stale, and a
// result with any refusal carries no parts. The stage is pure: it reads the
// bytes it is given and returns new part texts, the rendered pending formula
// texts, and the formula cells whose cached values must be invalidated, in
// prospective coordinates.
//
// Coordinates are 0-based and physical, as in worksheet-structure.ts.
import type { FormulaAnchors } from '../formula-anchors';
import {
    unrenderable_formula_reason,
    type AnchorWorksheetInput,
} from '../formula-anchor-layout';
import { render_formula } from '../formula-anchors';
import {
    MAX_RULE_SPLIT,
    parse_rule_sqref,
    relative_rule_cells_unchanged,
    relative_rule_issues,
    rule_split_workbook,
    rule_sqref_text,
    rule_range_text,
    split_relative_rule,
    wrap_translate_formula,
    type RuleCellRange,
    type RuleSplitWorkbook,
} from '../formula-rule-split';
import { formula_anchor_context } from '../formula-anchor-layout';
import {
    direct_child_elements,
    find_first_element_by_local_name,
    get_tag_attr,
    index_of_bytes,
    opening_tag_text,
    scan_rows,
    utf8_text,
    type QualifiedElementSpan,
    type Span,
} from '../ooxml-worksheet-scan';
import { decode_xml, get_attr, remove_attr, replace_attr_value } from '../ooxml-xml';
import { parse_workbook_xml } from '../parse-xlsx';
import { appended_rows } from '../pending-changes';
import { source_column_layout, source_row_layout } from '../worksheet-layout';
import { apply_utf8_splices, encode_xml } from '../xlsx-cell-write';
import { formula_reference_tokens, translate_a1_formula, type FormulaReferenceIssue } from '../xlsx-formula';
import type { XlsxFormulaCacheAddress } from '../xlsx-package';
import { formula_targets, type FormulaTargets, type StructuralFormulaLocation } from '../xlsx-structural-support';
import { worksheet_cell_set_map, type WorksheetRestructureResult } from './worksheet-structure';

/** Unsharing may write at most this many follower formulas per save. */
export const MAX_UNSHARED_FOLLOWER_FORMULAS = 1_000_000;
/** Unsharing may write at most this many UTF-8 bytes of follower formula text per save. */
export const MAX_UNSHARED_FORMULA_BYTES = 64 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One worksheet of the workbook, in workbook order. */
export interface WorkbookFormulaStageWorksheet extends AnchorWorksheetInput {
    /** Package path of the worksheet part, without a leading slash. */
    readonly part: string;
    /** The worksheet part as the Structural Basis has it. */
    readonly source_xml: Uint8Array;
    /**
     * `restructure_worksheet`'s result for this worksheet's layout: present
     * exactly when the worksheet has a live layout change.
     */
    readonly restructured?: WorksheetRestructureResult;
}

/** A pending formula: a cell edit, a Pending Row cell, or a Pending Column cell. */
export interface WorkbookFormulaStagePendingFormula {
    /** The caller's key for the formula, echoed in the result. */
    readonly key: string;
    readonly sheetIndex: number;
    /** Prospective 0-based cell, for refusals. */
    readonly row: number;
    readonly column: number;
    /** Stored text, with its leading `=`. */
    readonly text: string;
    readonly anchors?: FormulaAnchors;
}

export interface WorkbookFormulaStageRequest {
    /** Package path of the workbook part, without a leading slash. */
    readonly workbook_part: string;
    readonly workbook_xml: Uint8Array;
    /** Every worksheet, in workbook order: `sheetIndex` indexes this list. */
    readonly worksheets: readonly WorkbookFormulaStageWorksheet[];
    readonly pending_formulas?: readonly WorkbookFormulaStagePendingFormula[];
    /** The unsharing caps; the spec's limits unless a test lowers them. */
    readonly unshare_limits?: { readonly followers: number; readonly bytes: number };
}

export interface WorkbookFormulaStagePart {
    /** Package path, without a leading slash. */
    readonly part: string;
    readonly newText: string;
}

export type WorkbookFormulaRefusalCode =
    /** A formula has a construct no layout change can adjust, such as a spill reference. */
    | 'unrenderable-formula'
    /** An array formula or data table whose references the layouts change. */
    | 'grouped-formula'
    /** A workbook-scoped name with a reference that names no worksheet. */
    | 'ambiguous-defined-name'
    /** Unsharing would write more formulas than one save allows. */
    | 'unshare-limit'
    /** A conditional-formatting or data-validation rule would split into too many rules. */
    | 'rule-split-limit'
    /** A color-scale, data-bar, or icon-set threshold formula the layouts would change. */
    | 'conditional-formatting-threshold'
    /** A split rule's priorities cannot be renumbered on this worksheet. */
    | 'conditional-formatting-priority';

export type WorkbookFormulaLocation =
    | StructuralFormulaLocation
    | { readonly kind: 'pending-cell'; readonly worksheet?: string; readonly cell: string }
    | { readonly kind: 'worksheet'; readonly worksheet: string };

/** A save the stage refuses; the save planner raises it as an `unsupportedStructure` conflict. */
export interface WorkbookFormulaRefusal {
    readonly reason: 'unsupportedStructure';
    readonly code: WorkbookFormulaRefusalCode;
    /** The worksheet the refused formula lives on; absent for a workbook-scoped name. */
    readonly sheetIndex?: number;
    readonly location: WorkbookFormulaLocation;
    readonly issue?: FormulaReferenceIssue;
    readonly message: string;
}

export interface WorkbookFormulaStageResult {
    /**
     * Final text of every part to write: each restructured worksheet, each
     * other worksheet whose formulas changed, and `workbook.xml` when a
     * defined name changed. Empty whenever `refusals` is not.
     */
    readonly parts: readonly WorkbookFormulaStagePart[];
    /** Rendered text of each pending formula, by key. Empty whenever `refusals` is not. */
    readonly pending_formulas: ReadonlyMap<string, string>;
    readonly refusals: readonly WorkbookFormulaRefusal[];
    /** Formula cells whose cached `<v>` is stale, in prospective coordinates. */
    readonly invalidations: readonly XlsxFormulaCacheAddress[];
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function sheet_prefix(worksheet: string | undefined): string {
    if (worksheet === undefined) return '';
    return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(worksheet) ? `${worksheet}!` : `'${worksheet.replace(/'/g, "''")}'!`;
}

function location_text(location: WorkbookFormulaLocation): string {
    switch (location.kind) {
        case 'cell':
        case 'pending-cell':
            return `the formula in cell ${sheet_prefix(location.worksheet)}${location.cell}`;
        case 'defined-name':
            return `the name ${location.name}`;
        case 'conditional-formatting':
            return `the conditional formatting on ${sheet_prefix(location.worksheet)}${location.sqref}`;
        case 'data-validation':
            return `the data validation on ${sheet_prefix(location.worksheet)}${location.sqref}`;
        case 'hyperlink':
            return `the link in cell ${sheet_prefix(location.worksheet)}${location.cell}`;
        case 'worksheet':
            return location.worksheet;
    }
}

function refusal_message(
    code: WorkbookFormulaRefusalCode,
    location: WorkbookFormulaLocation,
    issue?: FormulaReferenceIssue,
): string {
    const lead = "Can't save these row and column changes: ";
    switch (code) {
        case 'unrenderable-formula':
            return `${lead}Table Viewer can't adjust ${location_text(location)}`
                + `${issue === undefined ? '' : ` (${unrenderable_formula_reason(issue)})`}.`;
        case 'grouped-formula':
            return `${lead}${location_text(location)} is an array formula or a data table that refers to rows or columns being changed.`;
        case 'ambiguous-defined-name':
            return `${lead}${location_text(location)} refers to cells without naming their sheet, so Table Viewer can't tell which sheet it means.`;
        case 'unshare-limit':
            return `${lead}rewriting the shared formulas on ${location_text(location)} would write more than `
                + `${MAX_UNSHARED_FOLLOWER_FORMULAS.toLocaleString('en-US')} formulas or 64 MiB of formula text.`;
        case 'rule-split-limit':
            return `${lead}they would split ${location_text(location)} into more than ${MAX_RULE_SPLIT} rules.`;
        case 'conditional-formatting-threshold':
            return `${lead}${location_text(location)} has a threshold formula Table Viewer can't adjust.`;
        case 'conditional-formatting-priority':
            return `${lead}${location_text(location)} would have to be split, and its sheet has rule priorities Table Viewer can't renumber.`;
    }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

interface Splice {
    readonly start: number;
    readonly end: number;
    readonly text: string;
}

function local_name(qname: string): string {
    const colon = qname.indexOf(':');
    return colon === -1 ? qname : qname.slice(colon + 1);
}

function element_inner(xml: Uint8Array, element: Span): string {
    return decode_xml(utf8_text(xml, element.inner_start, element.inner_end));
}

function children(xml: Uint8Array, parent: Span, name: string): QualifiedElementSpan[] {
    if (parent.inner_start === parent.end) return [];
    return direct_child_elements(xml, parent).filter((child) => local_name(child.name) === name);
}

function cell_label(row: number, column: number): string {
    return rule_range_text({ firstRow: row, firstColumn: column, lastRow: row, lastColumn: column });
}

/** Text of `element` with `edits` (absolute byte offsets inside it) applied. */
function rewrite_element(xml: Uint8Array, element: Span, edits: readonly Splice[]): string {
    const ordered = [...edits].sort((left, right) => left.start - right.start);
    let out = '';
    let cursor = element.start;
    for (const edit of ordered) {
        out += utf8_text(xml, cursor, edit.start) + edit.text;
        cursor = edit.end;
    }
    return out + utf8_text(xml, cursor, element.end);
}

/** An element's opening tag rewritten as a start tag for content, keeping its name and attributes. */
function as_start_tag(open: string): string {
    return open.replace(/\s*\/\s*>$/, '>');
}

function same_ranges(left: readonly RuleCellRange[], right: readonly RuleCellRange[]): boolean {
    return rule_sqref_text(left) === rule_sqref_text(right);
}

// ---------------------------------------------------------------------------
// The stage
// ---------------------------------------------------------------------------

interface FormulaCell {
    readonly row: number;
    readonly column: number;
    readonly f: QualifiedElementSpan;
    readonly type: string | null;
    readonly si: string | null;
    readonly ref: string | null;
    readonly text: string;
}

function scan_formula_cells(xml: Uint8Array): FormulaCell[] {
    const root = find_first_element_by_local_name(xml, 'worksheet');
    if (root === null) throw new Error('Worksheet has no worksheet element');
    const sheet_data = children(xml, root.element, 'sheetData')[0];
    if (sheet_data === undefined || sheet_data.element.inner_start === sheet_data.element.end) return [];
    const { element } = sheet_data;
    if (index_of_bytes(xml, 'f', element.inner_start, element.inner_end) === -1) return [];
    const cells: FormulaCell[] = [];
    scan_rows(xml, element.inner_start, element.inner_end, {
        on_cell: (row, column, cell) => {
            if (index_of_bytes(xml, 'f', cell.inner_start, cell.inner_end) === -1) return;
            const f = find_first_element_by_local_name(xml, 'f', cell.inner_start, cell.inner_end);
            if (f === null) return;
            const at = f.element;
            cells.push({
                row,
                column,
                f,
                type: get_tag_attr(xml, at.start, at.inner_start, 't'),
                si: get_tag_attr(xml, at.start, at.inner_start, 'si'),
                ref: get_tag_attr(xml, at.start, at.inner_start, 'ref'),
                text: element_inner(xml, at),
            });
        },
    });
    return cells;
}

interface Budget {
    followers: number;
    bytes: number;
    exceeded: boolean;
}

class Stage {
    readonly refusals: WorkbookFormulaRefusal[] = [];
    readonly invalidations: XlsxFormulaCacheAddress[] = [];
    readonly split: RuleSplitWorkbook;
    readonly any_live_change: boolean;
    readonly budget: Budget = { followers: 0, bytes: 0, exceeded: false };

    constructor(readonly request: WorkbookFormulaStageRequest) {
        this.split = rule_split_workbook(request.worksheets);
        this.any_live_change = this.split.anchors.worksheets.some((worksheet) =>
            worksheet.rows.hasLiveChange || worksheet.columns.hasLiveChange);
        this.split.anchors.worksheets.forEach((worksheet, index) => {
            const live = worksheet.rows.hasLiveChange || worksheet.columns.hasLiveChange;
            const restructured = request.worksheets[index].restructured;
            if (live !== (restructured !== undefined)) {
                throw new Error(`Worksheet ${index} must be restructured exactly when its layout changes.`);
            }
            if (restructured !== undefined && (
                restructured.coordinates.rowCount
                    !== worksheet.rows.fixedCount + worksheet.rows.liveCount + worksheet.rows.bandCount
                || restructured.coordinates.columnCount !== worksheet.columns.liveCount
            )) {
                throw new Error(`Worksheet ${index} was restructured with a different layout.`);
            }
        });
    }

    name(index: number): string {
        return this.request.worksheets[index].name;
    }

    refuse(
        code: WorkbookFormulaRefusalCode,
        sheet_index: number | undefined,
        location: WorkbookFormulaLocation,
        issue?: FormulaReferenceIssue,
    ): void {
        this.refusals.push(Object.freeze({
            reason: 'unsupportedStructure' as const,
            code,
            ...(sheet_index === undefined ? {} : { sheetIndex: sheet_index }),
            location,
            ...(issue === undefined ? {} : { issue }),
            message: refusal_message(code, location, issue),
        }));
    }

    /** Render `text` (with `=`) on a worksheet; undefined after refusing. */
    render(
        text: string,
        sheet_index: number,
        location: WorkbookFormulaLocation,
        anchors?: FormulaAnchors,
    ): string | undefined {
        const result = render_formula(text, anchors, formula_anchor_context(this.split.anchors, sheet_index));
        if (result.kind === 'rendered') return result.text;
        this.refuse('unrenderable-formula', sheet_index, location, result.issue);
        return undefined;
    }

    current_xml(index: number): Uint8Array {
        const worksheet = this.request.worksheets[index];
        return worksheet.restructured?.worksheet_xml ?? worksheet.source_xml;
    }

    // --- Cell formulas -------------------------------------------------------

    cell_formulas(index: number, xml: Uint8Array, cells: readonly FormulaCell[], splices: Splice[]): void {
        const worksheet = this.request.worksheets[index];
        const name = worksheet.name;
        const where = (row: number, column: number): WorkbookFormulaLocation =>
            ({ kind: 'cell', worksheet: name, cell: cell_label(row, column) });
        const shared = new Map<string, FormulaCell[]>();
        for (const cell of cells) {
            if (cell.type === 'shared') {
                if (cell.si === null) continue;
                const group = shared.get(cell.si) ?? [];
                group.push(cell);
                shared.set(cell.si, group);
                continue;
            }
            if (cell.text === '') continue;
            const rendered = this.render(`=${cell.text}`, index, where(cell.row, cell.column));
            if (rendered === undefined || rendered === `=${cell.text}`) continue;
            if (cell.type === 'array' || cell.type === 'dataTable') {
                this.refuse('grouped-formula', index, where(cell.row, cell.column));
                continue;
            }
            splices.push({ start: cell.f.element.inner_start, end: cell.f.element.inner_end, text: encode_xml(rendered.slice(1)) });
        }
        if (shared.size > 0) this.shared_groups(index, xml, shared, splices);
    }

    shared_groups(index: number, xml: Uint8Array, groups: ReadonlyMap<string, FormulaCell[]>, splices: Splice[]): void {
        const worksheet = this.request.worksheets[index];
        const restructured = worksheet.restructured;
        const name = worksheet.name;
        // Masters as the source has them: a removed master still defines its followers.
        const masters = new Map<string, { row: number; column: number; text: string }>();
        for (const cell of restructured === undefined ? [...groups.values()].flat() : scan_formula_cells(worksheet.source_xml)) {
            if (cell.type === 'shared' && cell.si !== null && cell.ref !== null && cell.text !== '') {
                masters.set(cell.si, { row: cell.row, column: cell.column, text: cell.text });
            }
        }
        const reports = new Map((restructured?.shared_formula_groups ?? []).map((group) => [group.sharedIndex, group]));
        const cell_set = restructured === undefined ? undefined : worksheet_cell_set_map({
            bodyStart: worksheet.bodyStart,
            rowLayout: worksheet.changes?.rowLayout
                ?? source_row_layout(worksheet.bodyStart, Math.max(0, worksheet.sourceRowCount - worksheet.bodyStart)),
            columnLayout: worksheet.changes?.columnLayout ?? source_column_layout(worksheet.sourceColumnCount),
        }, worksheet.changes === undefined ? 0 : appended_rows(worksheet.changes).length);

        for (const [si, cells] of groups) {
            const master = masters.get(si);
            if (master === undefined) continue; // followers without a master evaluate nothing
            const report = reports.get(si);
            const old_of = new Map<string, { row: number; column: number }>();
            for (const move of report?.cells ?? []) {
                if (move.to !== null) old_of.set(`${move.to.row}:${move.to.column}`, { row: move.row, column: move.column });
            }
            const old_position = (cell: FormulaCell) => old_of.get(`${cell.row}:${cell.column}`) ?? { row: cell.row, column: cell.column };
            const where = (cell: FormulaCell): WorkbookFormulaLocation =>
                ({ kind: 'cell', worksheet: name, cell: cell_label(cell.row, cell.column) });

            // What each surviving cell evaluated, and its rendering.
            const evaluated: { cell: FormulaCell; text: string; rendered: string }[] = [];
            let renderable = true;
            for (const cell of cells) {
                const old = old_position(cell);
                const is_master = cell.ref !== null && old.row === master.row && old.column === master.column;
                const text = is_master
                    ? master.text
                    : translate_a1_formula(master.text, old.row - master.row, old.column - master.column);
                const rendered = this.render(`=${text}`, index, where(cell));
                if (rendered === undefined) {
                    renderable = false;
                    continue;
                }
                evaluated.push({ cell, text, rendered: rendered.slice(1) });
            }
            if (!renderable) continue;
            const positions_kept = report === undefined || report.relativePositionsKept;
            const unchanged = evaluated.every((entry) => entry.rendered === entry.text);
            if (positions_kept && unchanged) {
                // Kept: only the master's `ref` follows its cells.
                if (cell_set === undefined) continue;
                const master_cell = cells.find((cell) => cell.ref !== null);
                const ranges = master_cell?.ref === undefined || master_cell.ref === null
                    ? undefined
                    : parse_rule_sqref(master_cell.ref);
                if (master_cell === undefined || ranges === undefined || ranges.length !== 1) continue;
                const mapped = cell_set(ranges);
                if (mapped.length === 0) continue;
                const bounds: RuleCellRange = {
                    firstRow: Math.min(...mapped.map((range) => range.firstRow)),
                    firstColumn: Math.min(...mapped.map((range) => range.firstColumn)),
                    lastRow: Math.max(...mapped.map((range) => range.lastRow)),
                    lastColumn: Math.max(...mapped.map((range) => range.lastColumn)),
                };
                const next = rule_range_text(bounds);
                if (next === rule_range_text(ranges[0])) continue;
                const open = opening_tag_text(xml, master_cell.f.element);
                splices.push({
                    start: master_cell.f.element.start,
                    end: master_cell.f.element.inner_start,
                    text: replace_attr_value(open, 'ref', next),
                });
                continue;
            }
            // Unshare: every surviving cell gets its own formula.
            if (this.budget.exceeded) continue;
            const pending: Splice[] = [];
            for (const { cell, rendered } of evaluated) {
                const encoded = encode_xml(rendered);
                const is_master = cell.ref !== null;
                if (!is_master) {
                    this.budget.followers += 1;
                    this.budget.bytes += Buffer.byteLength(encoded, 'utf8');
                    const limits = this.request.unshare_limits;
                    if (this.budget.followers > (limits?.followers ?? MAX_UNSHARED_FOLLOWER_FORMULAS)
                        || this.budget.bytes > (limits?.bytes ?? MAX_UNSHARED_FORMULA_BYTES)) {
                        this.budget.exceeded = true;
                        this.refuse('unshare-limit', index, { kind: 'worksheet', worksheet: name });
                        return;
                    }
                }
                const open = ['t', 'si', 'ref'].reduce(
                    (tag, attribute) => remove_attr(tag, attribute),
                    opening_tag_text(xml, cell.f.element),
                );
                pending.push({
                    start: cell.f.element.start,
                    end: cell.f.element.end,
                    text: `${as_start_tag(open)}${encoded}</${cell.f.name}>`,
                });
            }
            splices.push(...pending);
        }
    }

    // --- Hyperlink locations -------------------------------------------------

    hyperlinks(index: number, xml: Uint8Array, root: Span, splices: Splice[]): void {
        const name = this.name(index);
        for (const section of children(xml, root, 'hyperlinks')) {
            for (const link of children(xml, section.element, 'hyperlink')) {
                const open = opening_tag_text(xml, link.element);
                const location = get_attr(open, 'location');
                if (location === null || location === '' || get_attr(open, 'r:id') !== null) continue;
                const rendered = this.render(`=${location}`, index, {
                    kind: 'hyperlink',
                    worksheet: name,
                    cell: get_attr(open, 'ref') ?? '?',
                });
                if (rendered === undefined || rendered === `=${location}`) continue;
                splices.push({
                    start: link.element.start,
                    end: link.element.inner_start,
                    text: replace_attr_value(open, 'location', rendered.slice(1)),
                });
            }
        }
    }

    // --- Conditional formatting and data validation --------------------------

    rules(index: number, xml: Uint8Array, root_children: readonly QualifiedElementSpan[], splices: Splice[]): void {
        const worksheet = this.request.worksheets[index];
        const name = worksheet.name;
        const changed = worksheet.restructured !== undefined;
        const reported = (kind: 'conditionalFormatting' | 'dataValidation') =>
            (worksheet.restructured?.rule_ranges ?? []).filter((rule) => rule.kind === kind && rule.newCells.length > 0);
        const cf_reports = reported('conditionalFormatting');
        const dv_reports = reported('dataValidation');

        interface RuleFormula {
            readonly element: Span;
            readonly text: string;
        }
        interface PlannedRule {
            readonly kind: 'conditionalFormatting' | 'dataValidation';
            readonly element: QualifiedElementSpan;
            readonly sqref: string;
            readonly formulas: readonly RuleFormula[];
            /** cfRule elements, with their formula indexes into `formulas`. */
            readonly cf_rules: readonly { readonly element: Span; readonly formulas: readonly number[] }[];
            groups?: readonly { readonly formulas: readonly string[]; readonly cells: readonly RuleCellRange[] }[];
        }
        const planned: PlannedRule[] = [];
        const threshold_refused = new Set<QualifiedElementSpan>();
        let cf_index = 0;
        let dv_index = 0;
        const plan = (
            kind: 'conditionalFormatting' | 'dataValidation',
            element: QualifiedElementSpan,
            formulas: RuleFormula[],
            cf_rules: PlannedRule['cf_rules'],
        ): void => {
            const open = opening_tag_text(xml, element.element);
            const sqref = get_attr(open, 'sqref') ?? '';
            const location: WorkbookFormulaLocation = kind === 'conditionalFormatting'
                ? { kind: 'conditional-formatting', worksheet: name, sqref }
                : { kind: 'data-validation', worksheet: name, sqref };
            const now = parse_rule_sqref(sqref);
            const report = changed ? (kind === 'conditionalFormatting' ? cf_reports[cf_index++] : dv_reports[dv_index++]) : undefined;
            if (now === undefined) throw new Error(`Unreadable sqref on worksheet ${index}.`);
            if (changed && (report === undefined || !same_ranges(report.newCells, now))) {
                throw new Error(`The restructured rules on worksheet ${index} do not match the report.`);
            }
            if (formulas.length === 0 || threshold_refused.has(element)) return;
            const rule = { worksheet: index, cells: report?.oldCells ?? now, formulas: formulas.map((entry) => entry.text) };
            const result = split_relative_rule(this.split, rule, now);
            if (result.kind === 'unrenderable') {
                this.refuse('unrenderable-formula', index, location, result.issue);
                return;
            }
            if (result.kind === 'tooMany') {
                this.refuse('rule-split-limit', index, location);
                return;
            }
            const groups = result.groups;
            const untouched = groups.length === 1 && groups[0].formulas.every((formula, at) =>
                formula === wrap_translate_formula(`=${rule.formulas[at]}`, 0, 0).slice(1));
            // A construct the tokenizer cannot adjust is relative to the rule's
            // top-left like any reference, so the rule may keep its text only
            // while every covered cell, and so its top-left, stays put.
            const issues = relative_rule_issues(rule);
            if (issues.length > 0) {
                if (untouched && relative_rule_cells_unchanged(this.split, rule, now)) return;
                this.refuse('unrenderable-formula', index, location, issues[0]);
                return;
            }
            if (untouched) return;
            planned.push({ kind, element, sqref, formulas, cf_rules, groups });
        };

        for (const child of root_children) {
            const local = local_name(child.name);
            if (local === 'conditionalFormatting') {
                const formulas: RuleFormula[] = [];
                const cf_rules: { element: Span; formulas: number[] }[] = [];
                for (const rule of children(xml, child.element, 'cfRule')) {
                    const indexes: number[] = [];
                    for (const part of direct_child_elements(xml, rule.element)) {
                        const part_name = local_name(part.name);
                        if (part_name === 'formula') {
                            indexes.push(formulas.length);
                            formulas.push({ element: part.element, text: element_inner(xml, part.element) });
                        }
                        if (part_name === 'colorScale' || part_name === 'dataBar' || part_name === 'iconSet') {
                            this.thresholds(index, xml, child, part.element, changed, threshold_refused);
                        }
                    }
                    cf_rules.push({ element: rule.element, formulas: indexes });
                }
                plan('conditionalFormatting', child, formulas, cf_rules);
            } else if (local === 'dataValidations') {
                for (const validation of children(xml, child.element, 'dataValidation')) {
                    const formulas: RuleFormula[] = direct_child_elements(xml, validation.element)
                        .filter((part) => local_name(part.name) === 'formula1' || local_name(part.name) === 'formula2')
                        .map((part) => ({ element: part.element, text: element_inner(xml, part.element) }));
                    plan('dataValidation', validation, formulas, []);
                }
            }
        }
        if (changed && (cf_index !== cf_reports.length || dv_index !== dv_reports.length)) {
            throw new Error(`The restructured rules on worksheet ${index} do not match the report.`);
        }
        if (planned.length === 0) return;

        // Priorities: each extra copy of a cfRule takes the priority right after
        // its original, and every later priority shifts to stay unique.
        const copies = new Map<number, number>(); // cfRule start → extra copies
        for (const rule of planned) {
            if (rule.kind !== 'conditionalFormatting') continue;
            for (const cf_rule of rule.cf_rules) copies.set(cf_rule.element.start, rule.groups!.length - 1);
        }
        const all_cf_rules = root_children
            .filter((child) => local_name(child.name) === 'conditionalFormatting')
            .flatMap((child) => children(xml, child.element, 'cfRule'));
        const splitting = [...copies.values()].some((count) => count > 0);
        const priority = new Map<number, number>(); // cfRule start → new priority
        if (splitting) {
            const ranked: { start: number; priority: number; order: number }[] = [];
            let valid = true;
            all_cf_rules.forEach((rule, order) => {
                const value = get_attr(opening_tag_text(xml, rule.element), 'priority');
                const number = value === null ? NaN : Number(value);
                if (!Number.isSafeInteger(number) || number < 1) valid = false;
                ranked.push({ start: rule.element.start, priority: number, order });
            });
            const extension = root_children.some((child) => local_name(child.name) === 'extLst');
            if (!valid || extension) {
                const first = planned.find((rule) => rule.kind === 'conditionalFormatting' && rule.groups!.length > 1);
                if (first !== undefined) {
                    this.refuse('conditional-formatting-priority', index,
                        { kind: 'conditional-formatting', worksheet: name, sqref: first.sqref });
                    return;
                }
            } else {
                ranked.sort((left, right) => left.priority - right.priority || left.order - right.order);
                let offset = 0;
                for (const entry of ranked) {
                    priority.set(entry.start, entry.priority + offset);
                    offset += copies.get(entry.start) ?? 0;
                }
            }
        }
        for (const rule of all_cf_rules) {
            const next = priority.get(rule.element.start);
            const open = opening_tag_text(xml, rule.element);
            if (next === undefined || String(next) === get_attr(open, 'priority')) continue;
            // Rules of planned elements are rewritten with their element below.
            const owner = planned.find((entry) => entry.cf_rules.some((cf) => cf.element.start === rule.element.start));
            if (owner !== undefined) continue;
            splices.push({ start: rule.element.start, end: rule.element.inner_start, text: replace_attr_value(open, 'priority', String(next)) });
        }

        for (const rule of planned) {
            const groups = rule.groups!;
            const texts = groups.map((group, copy) => {
                const edits: Splice[] = [];
                const open = opening_tag_text(xml, rule.element.element);
                if (groups.length > 1) {
                    edits.push({
                        start: rule.element.element.start,
                        end: rule.element.element.inner_start,
                        text: replace_attr_value(open, 'sqref', rule_sqref_text(group.cells)),
                    });
                }
                rule.formulas.forEach((formula, at) => {
                    if (group.formulas[at] === formula.text) return;
                    edits.push({ start: formula.element.inner_start, end: formula.element.inner_end, text: encode_xml(group.formulas[at]) });
                });
                for (const cf_rule of rule.cf_rules) {
                    const base = priority.get(cf_rule.element.start);
                    if (base === undefined) continue;
                    const cf_open = opening_tag_text(xml, cf_rule.element);
                    const value = String(base + copy);
                    if (value === get_attr(cf_open, 'priority')) continue;
                    edits.push({ start: cf_rule.element.start, end: cf_rule.element.inner_start, text: replace_attr_value(cf_open, 'priority', value) });
                }
                return rewrite_element(xml, rule.element.element, edits);
            });
            splices.push({ start: rule.element.element.start, end: rule.element.element.end, text: texts.join('') });
        }

        // A dataValidations section that gained rules updates its count.
        for (const child of root_children) {
            if (local_name(child.name) !== 'dataValidations') continue;
            const extra = planned
                .filter((rule) => rule.kind === 'dataValidation'
                    && rule.element.element.start >= child.element.start && rule.element.element.end <= child.element.end)
                .reduce((sum, rule) => sum + rule.groups!.length - 1, 0);
            if (extra === 0) continue;
            const open = opening_tag_text(xml, child.element);
            const count = get_attr(open, 'count');
            if (count === null) continue;
            const total = children(xml, child.element, 'dataValidation').length + extra;
            splices.push({ start: child.element.start, end: child.element.inner_start, text: replace_attr_value(open, 'count', String(total)) });
        }
    }

    /** Refuse a threshold formula the layouts would change. */
    thresholds(
        index: number,
        xml: Uint8Array,
        element: QualifiedElementSpan,
        scale: Span,
        changed: boolean,
        refused: Set<QualifiedElementSpan>,
    ): void {
        if (refused.has(element)) return;
        for (const value of direct_child_elements(xml, scale)) {
            if (local_name(value.name) !== 'cfvo') continue;
            const open = opening_tag_text(xml, value.element);
            const formula = get_attr(open, 'val');
            if (get_attr(open, 'type') !== 'formula' || formula === null) continue;
            const lex = formula_reference_tokens(`=${formula}`);
            if (lex.references.length === 0 && lex.issues.length === 0) continue;
            const rendered = render_formula(`=${formula}`, undefined, formula_anchor_context(this.split.anchors, index));
            if (!changed && rendered.kind === 'rendered' && rendered.text === `=${formula}`) continue;
            refused.add(element);
            this.refuse('conditional-formatting-threshold', index, {
                kind: 'conditional-formatting',
                worksheet: this.name(index),
                sqref: get_attr(opening_tag_text(xml, element.element), 'sqref') ?? '',
            });
            return;
        }
    }

    // --- Worksheets ------------------------------------------------------------

    worksheet(index: number): { part?: WorkbookFormulaStagePart; formulas: readonly FormulaCell[] } {
        const worksheet = this.request.worksheets[index];
        const xml = this.current_xml(index);
        const root = find_first_element_by_local_name(xml, 'worksheet');
        if (root === null) throw new Error('Worksheet has no worksheet element');
        const root_children = direct_child_elements(xml, root.element);
        const formulas = scan_formula_cells(xml);
        const splices: Splice[] = [];
        if (this.any_live_change) {
            this.cell_formulas(index, xml, formulas, splices);
            this.hyperlinks(index, xml, root.element, splices);
            this.rules(index, xml, root_children, splices);
        }
        if (splices.length === 0 && worksheet.restructured === undefined) return { formulas };
        const bytes = apply_utf8_splices(xml, splices);
        return { part: { part: worksheet.part, newText: utf8_text(bytes) }, formulas };
    }

    // --- Defined names -----------------------------------------------------------

    defined_names(): { part?: WorkbookFormulaStagePart; names: readonly { name: string; text: string }[] } {
        const xml = this.request.workbook_xml;
        const root = find_first_element_by_local_name(xml, 'workbook');
        if (root === null) throw new Error('Workbook has no workbook element');
        const section = children(xml, root.element, 'definedNames')[0];
        if (section === undefined) return { names: [] };
        const sheets = parse_workbook_xml(utf8_text(xml)).sheets;
        const names: { name: string; text: string }[] = [];
        const splices: Splice[] = [];
        for (const child of children(xml, section.element, 'definedName')) {
            const open = opening_tag_text(xml, child.element);
            const name = get_attr(open, 'name') ?? '';
            const text = element_inner(xml, child.element);
            names.push({ name, text });
            if (!this.any_live_change || text === '') continue;
            const local = get_attr(open, 'localSheetId');
            const local_name_text = local === null || !/^\d+$/.test(local) ? undefined : sheets[Number(local)]?.name;
            const local_index = local_name_text === undefined
                ? -1
                : this.request.worksheets.findIndex((worksheet) => worksheet.name.localeCompare(
                    local_name_text, undefined, { sensitivity: 'accent' }) === 0);
            const location: WorkbookFormulaLocation = { kind: 'defined-name', name };
            if (local_index < 0) {
                const lex = formula_reference_tokens(`=${text}`);
                const unqualified = lex.references.some((token) => token.sheetName === undefined)
                    || lex.issues.some((issue) => issue.worksheets.some((worksheet) => worksheet === undefined));
                if (unqualified) {
                    this.refuse('ambiguous-defined-name', undefined, location);
                    continue;
                }
            }
            const result = render_formula(
                `=${text}`,
                undefined,
                formula_anchor_context(this.split.anchors, Math.max(0, local_index)),
            );
            if (result.kind === 'unrenderable') {
                this.refuse('unrenderable-formula', local_index < 0 ? undefined : local_index, location, result.issue);
                continue;
            }
            if (result.text === `=${text}`) continue;
            splices.push({ start: child.element.inner_start, end: child.element.inner_end, text: encode_xml(result.text.slice(1)) });
        }
        if (splices.length === 0) return { names };
        return {
            part: { part: this.request.workbook_part, newText: utf8_text(apply_utf8_splices(xml, splices)) },
            names,
        };
    }

    // --- Cache invalidation --------------------------------------------------------

    /**
     * Every formula cell on a worksheet whose values the layouts may change: a
     * restructured worksheet, and, to a fixed point, any worksheet with a
     * formula that may read one of those, directly, through a defined name, or
     * through `INDIRECT`.
     */
    invalidate(
        formulas: readonly (readonly FormulaCell[])[],
        names: readonly { name: string; text: string }[],
    ): void {
        const worksheets = this.request.worksheets;
        const affected = new Set<number>();
        worksheets.forEach((worksheet, index) => {
            if (worksheet.restructured !== undefined) affected.add(index);
        });
        if (affected.size === 0) return;
        const name_targets = names.map((name) => ({ key: name.name.toLowerCase(), targets: formula_targets(name.text) }));
        const summaries = formulas.map((cells) => {
            const sheets = new Set<string>();
            const identifiers = new Set<string>();
            let every = false;
            for (const cell of cells) {
                if (cell.text === '') continue;
                const targets: FormulaTargets = formula_targets(cell.text);
                if (targets.everySheet) every = true;
                for (const sheet of targets.sheets) sheets.add(sheet);
                for (const identifier of targets.identifiers) identifiers.add(identifier);
            }
            return { sheets, identifiers, every };
        });
        for (;;) {
            const affected_names = new Set([...affected].map((index) => worksheets[index].name.toLowerCase()));
            // Names that may read an affected worksheet, closed over names that use them.
            const reading = new Set<string>();
            for (const { key, targets } of name_targets) {
                if (targets.everySheet || targets.unqualified || targets.identifiers.has('indirect')
                    || [...targets.sheets].some((sheet) => affected_names.has(sheet))) reading.add(key);
            }
            for (let grew = true; grew;) {
                grew = false;
                for (const { key, targets } of name_targets) {
                    if (reading.has(key)) continue;
                    if ([...targets.identifiers].some((identifier) => reading.has(identifier))) {
                        reading.add(key);
                        grew = true;
                    }
                }
            }
            let grew = false;
            summaries.forEach((summary, index) => {
                if (affected.has(index)) return;
                if (summary.every
                    || summary.identifiers.has('indirect')
                    || [...summary.sheets].some((sheet) => affected_names.has(sheet))
                    || [...summary.identifiers].some((identifier) => reading.has(identifier))) {
                    affected.add(index);
                    grew = true;
                }
            });
            if (!grew) break;
        }
        for (const index of [...affected].sort((left, right) => left - right)) {
            for (const cell of formulas[index]) {
                this.invalidations.push(Object.freeze({ sheetIndex: index, row: cell.row, column: cell.column }));
            }
        }
    }

    // --- Pending formulas ------------------------------------------------------------

    pending(): Map<string, string> {
        const out = new Map<string, string>();
        for (const formula of this.request.pending_formulas ?? []) {
            if (!Number.isSafeInteger(formula.sheetIndex) || formula.sheetIndex < 0
                || formula.sheetIndex >= this.request.worksheets.length) {
                throw new Error('A pending formula names a worksheet the workbook lacks.');
            }
            if (out.has(formula.key)) throw new Error(`Duplicate pending formula key ${formula.key}.`);
            const rendered = this.render(formula.text, formula.sheetIndex, {
                kind: 'pending-cell',
                worksheet: this.name(formula.sheetIndex),
                cell: cell_label(formula.row, formula.column),
            }, formula.anchors);
            if (rendered !== undefined) out.set(formula.key, rendered);
        }
        return out;
    }
}

/**
 * Render every formula in the workbook for the worksheets' layouts. See the
 * file comment for what it covers; `request.worksheets[i].restructured` must
 * be `restructure_worksheet`'s result for exactly the worksheets with a live
 * layout change.
 */
export function run_workbook_formula_stage(request: WorkbookFormulaStageRequest): WorkbookFormulaStageResult {
    const stage = new Stage(request);
    const parts: WorkbookFormulaStagePart[] = [];
    const formulas: (readonly FormulaCell[])[] = [];
    request.worksheets.forEach((_, index) => {
        const result = stage.worksheet(index);
        formulas.push(result.formulas);
        if (result.part !== undefined) parts.push(result.part);
    });
    const names = stage.defined_names();
    if (names.part !== undefined) parts.push(names.part);
    const pending = stage.pending();
    stage.invalidate(formulas, names.names);
    if (stage.refusals.length > 0) {
        return Object.freeze({
            parts: Object.freeze([]),
            pending_formulas: new Map(),
            refusals: Object.freeze([...stage.refusals]),
            invalidations: Object.freeze([...stage.invalidations]),
        });
    }
    return Object.freeze({
        parts: Object.freeze(parts.map((part) => Object.freeze(part))),
        pending_formulas: pending,
        refusals: Object.freeze([]),
        invalidations: Object.freeze([...stage.invalidations]),
    });
}
