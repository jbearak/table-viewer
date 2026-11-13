/**
 * XLSX structural support: decides, per worksheet and per axis, whether the
 * structural writer can insert, delete, and move rows or columns without
 * leaving a structure in the workbook that still names the old coordinates.
 *
 * The scan is an allowlist (see "XLSX structural support" and "Allowlist" in
 * docs/superpowers/specs/2026-11-07-row-and-column-structure-design.md).
 * A worksheet is supported only when every worksheet child is one the writer
 * covers or one that holds no coordinates, it has no unreviewed extension, no
 * markup-compatibility wrapper, no related part that could name its cells, no
 * array formula or data table that touches it, and every formula that may
 * reference it can be anchored. Anything else refuses, with a reason that
 * names the offending element, part, or cell.
 *
 * The host runs this at edit grant (advisory) and the save planner runs it
 * again on the bytes it is about to rewrite (authoritative), so it reads the
 * package with the same scanners the reader and the cell writer use:
 * `worksheet_part_entries_from_package` numbers the worksheets, the
 * `ooxml-worksheet-scan` primitives locate live elements, and
 * `writable_worksheet_sheet_data` applies the cell writer's refusals.
 *
 * Cross-sheet detection is conservative. A formula may reference a worksheet
 * when it is on that worksheet, names it in a sheet qualifier, uses a 3D
 * qualifier, or uses an identifier that matches a defined name that may
 * reference it. False positives only refuse more; they never let the writer
 * shift a structure it does not understand.
 */

import { OoxmlRefusalError, type OoxmlRefusalCode } from './ooxml-refusal';
import { get_attr, decode_xml } from './ooxml-xml';
import {
    direct_child_elements,
    end_tag_after,
    find_first_element_by_local_name,
    find_tag_end,
    get_tag_attr,
    ignorable_end,
    ignorable_ranges,
    index_of_bytes,
    indexOf_live,
    is_self_closing,
    is_tag_boundary,
    opening_tag_text,
    starts_with_bytes,
    utf8_text,
    worksheet_scan_input,
    type IgnorableRangeIndex,
    type QualifiedElementSpan,
    type Span,
} from './ooxml-worksheet-scan';
import { parse_relationships, rels_path_for_part } from './ooxml-relationships';
import { parse_workbook_xml, worksheet_part_entries_from_package } from './parse-xlsx';
import { writable_worksheet_sheet_data, worksheet_sheet_data_element } from './xlsx-cell-write';
import { a1_formula_reference_at } from './xlsx-formula';
import { ZipPackage, ZipPackageError } from './zip-package';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type StructuralAxis = 'rows' | 'columns';

/** Where a formula that may reference the worksheet lives. */
export type StructuralFormulaLocation =
    | { readonly kind: 'cell'; readonly worksheet?: string; readonly cell: string }
    | { readonly kind: 'defined-name'; readonly name: string }
    | { readonly kind: 'conditional-formatting'; readonly worksheet?: string; readonly sqref: string }
    | { readonly kind: 'data-validation'; readonly worksheet?: string; readonly sqref: string }
    | { readonly kind: 'hyperlink'; readonly worksheet?: string; readonly cell: string };

/** Related-part families that refuse structural editing. */
export type UnsupportedPartKind =
    | 'table'
    | 'drawing'
    | 'legacy-drawing'
    | 'comments'
    | 'threaded-comments'
    | 'pivot-table'
    | 'pivot-cache'
    | 'slicer'
    | 'slicer-cache'
    | 'timeline'
    | 'timeline-cache'
    | 'query-table'
    | 'connections'
    | 'embedded-object'
    | 'control'
    | 'custom-property'
    | 'chart'
    | 'macro-sheet'
    | 'dialog-sheet'
    | 'volatile-dependencies'
    | 'revisions'
    | 'hyperlink'
    | 'unknown';

/**
 * Why one axis of a worksheet cannot be restructured. Every variant names
 * what refused it; `message` is the user-facing sentence for that axis.
 * Worksheet names are present only when the offending item is on another
 * worksheet.
 */
export type StructuralRefusalReason =
    | {
        /** A `<worksheet>` child this scanner has no inventory row for. */
        readonly code: 'unknown-worksheet-child';
        /** The child's qualified name as written. */
        readonly element: string;
    }
    | {
        /** An inventoried worksheet child whose coordinates the writer does not shift. */
        readonly code: 'unsupported-worksheet-child';
        readonly element: RefusedWorksheetChild;
        /** Set when the child is on another worksheet and reads this one. */
        readonly worksheet?: string;
    }
    | {
        /** An `<ext>` whose URI is not in the reviewed coordinate-free list. */
        readonly code: 'unsupported-extension';
        readonly uri: string;
        /** The worksheet child that carries the extension list. */
        readonly element: string;
        /** Set when the extension is on another worksheet and its formulas read this one. */
        readonly worksheet?: string;
    }
    | {
        /** `mc:AlternateContent` wrapping worksheet content. */
        readonly code: 'alternate-content';
        /** The worksheet child it is or sits inside. */
        readonly element: string;
    }
    | {
        readonly code: 'unsupported-part';
        readonly partKind: UnsupportedPartKind;
        /** Package path of the related part, without a leading slash. */
        readonly part: string;
        readonly relationshipType: string;
        /** `worksheet` when related to this worksheet; `workbook` otherwise. */
        readonly scope: 'worksheet' | 'workbook';
        /** For a chart or pivot cache, the sheet or chartsheet that hosts it. */
        readonly host?: string;
    }
    | {
        readonly code: 'array-formula';
        readonly cell: string;
        readonly worksheet?: string;
    }
    | {
        readonly code: 'data-table';
        readonly cell: string;
        readonly worksheet?: string;
    }
    | {
        /** A formula that may reference this worksheet but cannot be anchored. */
        readonly code: 'unanchorable-formula';
        readonly formula: string;
        /** The construct the tokenizer could not anchor, when it says. */
        readonly construct?: string;
        /** Filled in by the scanner; absent on a refusal the callback returns. */
        readonly location?: StructuralFormulaLocation;
    }
    | {
        /** A color-scale, data-bar, or icon-set threshold given as a formula. */
        readonly code: 'conditional-formatting-threshold';
        readonly sqref: string;
        readonly value: string;
        /** Set when the rule is on another worksheet and its threshold reads this one. */
        readonly worksheet?: string;
    }
    | {
        /**
         * The backstop: a part names this worksheet in a sheet qualifier
         * somewhere no specific check classifies.
         */
        readonly code: 'unclassified-reference';
        readonly part: string;
    }
    | {
        /** The backstop could not read a part, which may name any worksheet. */
        readonly code: 'unreadable-part';
        readonly part: string;
    }
    | {
        /** A range attribute the writer would have to shift but cannot read. */
        readonly code: 'invalid-range';
        readonly element: string;
        readonly value: string;
    }
    | {
        /** The worksheet part fails the cell writer's own safety checks. */
        readonly code: 'unwritable-worksheet';
        readonly ooxmlCode?: OoxmlRefusalCode;
    }
    | {
        /** A worksheet part the package names but does not contain. */
        readonly code: 'unreadable-worksheet';
        readonly worksheet?: string;
    };

export type StructuralRefusal = StructuralRefusalReason & {
    /** For example "Can't insert, delete, or move rows on this sheet: it contains an Excel table." */
    readonly message: string;
};

export type StructuralAxisSupport =
    | { readonly supported: true }
    | { readonly supported: false; readonly reason: StructuralRefusal };

export interface StructuralRelativeRule {
    readonly sqref: string;
    readonly formulas: readonly string[];
}

export interface StructuralAutoFilter {
    readonly ref: string;
    readonly filteredColumns: readonly number[];
}

export interface WorksheetStructuralSupport {
    readonly rows: StructuralAxisSupport;
    readonly columns: StructuralAxisSupport;
    /** Merged ranges, for action-time merge checks. */
    readonly merges: readonly string[];
    /**
     * The worksheet AutoFilter, for the action-time filtered-column check.
     * `filteredColumns` are 0-based worksheet column indexes (the range's
     * first column plus each `<filterColumn colId>`), ascending.
     */
    readonly autoFilter?: StructuralAutoFilter;
    /**
     * Every conditional-formatting rule (one entry per `cfRule`, with its
     * element's `sqref`) and data-validation rule, with its formula texts.
     * Consumers filter for relative references.
     */
    readonly relativeRules: readonly StructuralRelativeRule[];
}

/**
 * Rule 5's tokenizer hook: return a refusal when the formula has a construct
 * that cannot be anchored, otherwise undefined. The scanner keeps the
 * returned refusal's structured fields, sets `location` on an
 * `unanchorable-formula` refusal, and renders `message` for each axis.
 */
export type FormulaAnchorabilityCheck = (formula: string) => StructuralRefusal | undefined;

export interface XlsxStructuralSupportOptions {
    /** Defaults to treating every formula as anchorable. */
    readonly formula_is_anchorable?: FormulaAnchorabilityCheck;
}

/** Which structure operation a refusal message introduces. */
export type StructuralOperation = 'insert-or-delete' | 'move' | 'any';

// ---------------------------------------------------------------------------
// Inventory: ECMA-376 Part 1, §18.3.1.99 CT_Worksheet children
// ---------------------------------------------------------------------------

export type WorksheetChildDisposition =
    /** The structural writer rewrites its coordinates (spec "Coverage"). */
    | 'covered'
    /** It holds no cell coordinates. */
    | 'coordinate-free'
    /** It holds coordinates the writer does not shift. */
    | 'refused'
    /** `extLst`: allowed only when every `<ext>` URI is reviewed. */
    | 'extension-list';

export interface WorksheetChildInventoryRow {
    readonly element: string;
    readonly disposition: WorksheetChildDisposition;
    /** For refused children: the clause after "on this sheet:". */
    readonly refusal?: string;
}

/**
 * One row per CT_Worksheet child, in schema order. A child missing from this
 * table refuses as `unknown-worksheet-child`, and the inventory test fails if
 * the scanner meets one in a fixture.
 */
export const WORKSHEET_CHILD_INVENTORY = [
    { element: 'sheetPr', disposition: 'coordinate-free' },
    { element: 'dimension', disposition: 'covered' },
    { element: 'sheetViews', disposition: 'covered' },
    { element: 'sheetFormatPr', disposition: 'coordinate-free' },
    { element: 'cols', disposition: 'covered' },
    { element: 'sheetData', disposition: 'covered' },
    { element: 'sheetCalcPr', disposition: 'coordinate-free' },
    { element: 'sheetProtection', disposition: 'coordinate-free' },
    { element: 'protectedRanges', disposition: 'refused', refusal: 'it contains protected ranges' },
    { element: 'scenarios', disposition: 'refused', refusal: 'it contains scenarios' },
    { element: 'autoFilter', disposition: 'covered' },
    { element: 'sortState', disposition: 'covered' },
    { element: 'dataConsolidate', disposition: 'refused', refusal: 'it contains a data consolidation' },
    { element: 'customSheetViews', disposition: 'refused', refusal: 'it contains custom views' },
    { element: 'mergeCells', disposition: 'covered' },
    { element: 'phoneticPr', disposition: 'coordinate-free' },
    { element: 'conditionalFormatting', disposition: 'covered' },
    { element: 'dataValidations', disposition: 'covered' },
    { element: 'hyperlinks', disposition: 'covered' },
    { element: 'printOptions', disposition: 'coordinate-free' },
    { element: 'pageMargins', disposition: 'coordinate-free' },
    { element: 'pageSetup', disposition: 'coordinate-free' },
    { element: 'headerFooter', disposition: 'coordinate-free' },
    { element: 'rowBreaks', disposition: 'covered' },
    { element: 'colBreaks', disposition: 'covered' },
    { element: 'customProperties', disposition: 'refused', refusal: 'it contains custom properties' },
    { element: 'cellWatches', disposition: 'refused', refusal: 'it contains watched cells' },
    { element: 'ignoredErrors', disposition: 'covered' },
    { element: 'smartTags', disposition: 'refused', refusal: 'it contains smart tags' },
    { element: 'drawing', disposition: 'refused', refusal: 'it contains pictures, charts, or shapes' },
    { element: 'legacyDrawing', disposition: 'refused', refusal: 'it contains notes or legacy drawings' },
    { element: 'legacyDrawingHF', disposition: 'refused', refusal: 'it contains header or footer pictures' },
    { element: 'drawingHF', disposition: 'refused', refusal: 'it contains header or footer pictures' },
    { element: 'picture', disposition: 'refused', refusal: 'it has a background picture' },
    { element: 'oleObjects', disposition: 'refused', refusal: 'it contains embedded objects' },
    { element: 'controls', disposition: 'refused', refusal: 'it contains form controls' },
    { element: 'webPublishItems', disposition: 'refused', refusal: 'it contains web publishing items' },
    { element: 'tableParts', disposition: 'refused', refusal: 'it contains an Excel table' },
    { element: 'extLst', disposition: 'extension-list' },
] as const satisfies readonly WorksheetChildInventoryRow[];

type InventoryEntry = typeof WORKSHEET_CHILD_INVENTORY[number];
export type RefusedWorksheetChild = Extract<InventoryEntry, { disposition: 'refused' }>['element'];

const INVENTORY_BY_ELEMENT: ReadonlyMap<string, WorksheetChildInventoryRow> = new Map(
    WORKSHEET_CHILD_INVENTORY.map((row) => [row.element, row]),
);

/**
 * `<ext>` URIs reviewed as coordinate-free. Initially empty: every extension
 * refuses until someone reviews it and adds it here with a test.
 */
export const REVIEWED_COORDINATE_FREE_EXTENSION_URIS: ReadonlySet<string> = new Set<string>();

/** Friendlier names for extensions users meet most; any other URI is shown as written. */
const KNOWN_EXTENSIONS: ReadonlyMap<string, string> = new Map([
    ['{78C0D931-6437-407d-A8EE-F0AAD7539E65}', 'conditional formatting from Excel 2010 or later'],
    ['{CCE6A557-97BC-4b89-ADB6-D9C93CAAB3DF}', 'data validation from Excel 2010 or later'],
    ['{05C60535-1F16-4fd2-B633-F4F36F0B64E0}', 'sparklines'],
    ['{A8765BA9-456A-4dab-B4F3-ACF838C121DE}', 'slicers'],
    ['{3A4CF648-6AED-40f4-86FF-DC5316D8AED3}', 'slicers'],
].map(([uri, name]) => [uri.toUpperCase(), name]));

// ---------------------------------------------------------------------------
// Relationship inventory
// ---------------------------------------------------------------------------

const SPREADSHEETML_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const STRICT_SPREADSHEETML_NS = 'http://purl.oclc.org/ooxml/spreadsheetml/main';
const MARKUP_COMPATIBILITY_NS = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const OFFICE_DOCUMENT_RELATIONSHIP_BASES = [
    'http://schemas.openxmlformats.org/officeDocument/2006/relationships/',
    'http://purl.oclc.org/ooxml/officeDocument/relationships/',
] as const;

type RelationshipDisposition =
    | { readonly kind: 'allowed' }
    | { readonly kind: 'scanned' }
    | { readonly kind: 'refused'; readonly partKind: UnsupportedPartKind };

const ALLOWED: RelationshipDisposition = { kind: 'allowed' };
const SCANNED: RelationshipDisposition = { kind: 'scanned' };
const refused = (partKind: UnsupportedPartKind): RelationshipDisposition => ({ kind: 'refused', partKind });

/**
 * Relationship types from a worksheet part. `hyperlink` is rewritten by the
 * coverage table; `printerSettings` and `image` are opaque bytes that cannot
 * name a cell (a background `picture` refuses as a worksheet child instead).
 */
const WORKSHEET_RELATIONSHIPS: ReadonlyMap<string, RelationshipDisposition> = new Map([
    ['hyperlink', ALLOWED],
    ['printerSettings', ALLOWED],
    ['image', ALLOWED],
    ['table', refused('table')],
    ['drawing', refused('drawing')],
    ['vmlDrawing', refused('legacy-drawing')],
    ['comments', refused('comments')],
    ['http://schemas.microsoft.com/office/2017/10/relationships/threadedComment', refused('threaded-comments')],
    ['pivotTable', refused('pivot-table')],
    ['queryTable', refused('query-table')],
    ['http://schemas.microsoft.com/office/2007/relationships/slicer', refused('slicer')],
    ['http://schemas.microsoft.com/office/2011/relationships/timeline', refused('timeline')],
    ['oleObject', refused('embedded-object')],
    ['package', refused('embedded-object')],
    ['ctrlProp', refused('control')],
    ['control', refused('control')],
    ['customProperty', refused('custom-property')],
]);

/**
 * Relationship types from the workbook part. Worksheets and chartsheets are
 * scanned for formulas and charts, pivot caches for their source; the rest
 * are coordinate-free, cannot name this workbook's cells, or refuse every
 * worksheet.
 */
const WORKBOOK_RELATIONSHIPS: ReadonlyMap<string, RelationshipDisposition> = new Map([
    ['worksheet', SCANNED],
    ['chartsheet', SCANNED],
    ['pivotCacheDefinition', SCANNED],
    ['styles', ALLOWED],
    ['theme', ALLOWED],
    ['sharedStrings', ALLOWED],
    ['calcChain', ALLOWED],
    ['customXml', ALLOWED],
    ['externalLink', ALLOWED],
    // Cell metadata (`xl/metadata.xml`). Spelled in two pieces because the
    // protocol test forbids a removed message name that this type contains.
    [`sheet${'Metadata'}`, ALLOWED],
    ['http://schemas.microsoft.com/office/2017/10/relationships/person', ALLOWED],
    ['connections', refused('connections')],
    ['xlMacrosheet', refused('macro-sheet')],
    ['xlIntlMacrosheet', refused('macro-sheet')],
    ['dialogsheet', refused('dialog-sheet')],
    ['volatileDependencies', refused('volatile-dependencies')],
    ['revisionHeaders', refused('revisions')],
    ['usernames', refused('revisions')],
    ['http://schemas.microsoft.com/office/2007/relationships/slicerCache', refused('slicer-cache')],
    ['http://schemas.microsoft.com/office/2011/relationships/timelineCache', refused('timeline-cache')],
]);

const CHART_EX_RELATIONSHIP = 'http://schemas.microsoft.com/office/2014/relationships/chartEx';

/** Drawing relationships that cannot name a cell; anything else refuses every sheet. */
const DRAWING_RELATIONSHIPS_WITHOUT_REFERENCES: ReadonlySet<string> = new Set([
    'image',
    'diagramData',
    'diagramLayout',
    'diagramQuickStyle',
    'diagramColors',
    'http://schemas.microsoft.com/office/2007/relationships/diagramDrawing',
    'http://schemas.microsoft.com/office/2007/relationships/hdphoto',
]);

/** Chart relationships that cannot name a cell; `chartUserShapes` is scanned as a drawing. */
const CHART_RELATIONSHIPS_WITHOUT_REFERENCES: ReadonlySet<string> = new Set([
    'image',
    'themeOverride',
    'package',
    'http://schemas.microsoft.com/office/2011/relationships/chartStyle',
    'http://schemas.microsoft.com/office/2011/relationships/chartColorStyle',
]);

function relationship_key(type: string): string {
    for (const base of OFFICE_DOCUMENT_RELATIONSHIP_BASES) {
        if (type.startsWith(base)) return type.slice(base.length);
    }
    return type;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

function quoted_sheet(name: string): string {
    return /^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

function qualified(worksheet: string | undefined, cell: string): string {
    return worksheet === undefined ? cell : `${quoted_sheet(worksheet)}!${cell}`;
}

const PART_CLAUSES: Readonly<Record<UnsupportedPartKind, string>> = {
    'table': 'it contains an Excel table',
    'drawing': 'it contains pictures, charts, or shapes',
    'legacy-drawing': 'it contains notes or legacy drawings',
    'comments': 'it contains notes',
    'threaded-comments': 'it contains threaded comments',
    'pivot-table': 'it contains a PivotTable',
    'pivot-cache': 'a PivotTable uses data from this sheet',
    'slicer': 'it contains slicers',
    'slicer-cache': 'the workbook has slicers',
    'timeline': 'it contains timelines',
    'timeline-cache': 'the workbook has timelines',
    'query-table': 'it contains a query table',
    'connections': 'the workbook has data connections',
    'embedded-object': 'it contains embedded objects',
    'control': 'it contains form controls',
    'custom-property': 'it contains custom properties',
    'chart': 'a chart uses data from this sheet',
    'macro-sheet': 'the workbook contains macro sheets',
    'dialog-sheet': 'the workbook contains dialog sheets',
    'volatile-dependencies': 'the workbook has real-time data links',
    'revisions': 'the workbook tracks changes',
    'hyperlink': "it has a link Table Viewer can't adjust",
    'unknown': '',
};

/** Parts on another sheet that refuse a worksheet because they read it. */
const LINKED_PART_SUBJECTS: Partial<Record<UnsupportedPartKind, string>> = {
    'chart': 'a chart',
    'drawing': 'a shape',
    'legacy-drawing': 'a form control',
    'control': 'a form control',
    'table': 'an Excel table',
    'hyperlink': 'a link',
};

function location_text(location: StructuralFormulaLocation | undefined): string {
    if (location === undefined) return 'a formula';
    switch (location.kind) {
        case 'cell': return `the formula in cell ${qualified(location.worksheet, location.cell)}`;
        case 'defined-name': return `the name ${location.name}`;
        case 'conditional-formatting':
            return `the conditional formatting on ${qualified(location.worksheet, location.sqref)}`;
        case 'data-validation':
            return `the data validation on ${qualified(location.worksheet, location.sqref)}`;
        case 'hyperlink': return `the link in cell ${qualified(location.worksheet, location.cell)}`;
    }
}

/** The clause after "on this sheet:" for one reason. */
function refusal_clause(reason: StructuralRefusalReason): string {
    switch (reason.code) {
        case 'unknown-worksheet-child':
            return `it contains content Table Viewer doesn't recognize (<${reason.element}>)`;
        case 'unsupported-worksheet-child':
            if (reason.worksheet !== undefined) {
                const subject = reason.element === 'dataConsolidate'
                    ? 'a data consolidation'
                    : reason.element === 'controls' ? 'a form control' : `<${reason.element}>`;
                return `${subject} on ${reason.worksheet} uses data from this sheet`;
            }
            return INVENTORY_BY_ELEMENT.get(reason.element)?.refusal ?? `it contains <${reason.element}>`;
        case 'unsupported-extension': {
            const known = KNOWN_EXTENSIONS.get(reason.uri.toUpperCase());
            if (reason.worksheet !== undefined) {
                return `${known ?? 'an Excel extension'} on ${reason.worksheet} uses data from this sheet`;
            }
            return known !== undefined
                ? `it contains ${known}`
                : `it contains an Excel extension Table Viewer hasn't reviewed (${reason.uri || 'no URI'})`;
        }
        case 'alternate-content':
            return 'it contains markup-compatibility alternate content';
        case 'unsupported-part': {
            if (reason.partKind === 'unknown') {
                return reason.scope === 'worksheet'
                    ? `it has related content Table Viewer doesn't recognize (${reason.relationshipType})`
                    : `the workbook has content Table Viewer doesn't recognize (${reason.relationshipType})`;
            }
            const subject = reason.scope === 'workbook' ? LINKED_PART_SUBJECTS[reason.partKind] : undefined;
            if (subject !== undefined) {
                const predicate = reason.partKind === 'hyperlink' ? 'points into this sheet' : 'uses data from this sheet';
                return `${subject}${reason.host === undefined ? '' : ` on ${reason.host}`} ${predicate}`;
            }
            return PART_CLAUSES[reason.partKind];
        }
        case 'array-formula':
            return reason.worksheet === undefined
                ? `cell ${reason.cell} has an array formula`
                : `cell ${qualified(reason.worksheet, reason.cell)} has an array formula that uses this sheet`;
        case 'data-table':
            return reason.worksheet === undefined
                ? `cell ${reason.cell} has a data table`
                : `cell ${qualified(reason.worksheet, reason.cell)} has a data table that uses this sheet`;
        case 'unanchorable-formula':
            return `Table Viewer can't adjust ${location_text(reason.location)}`
                + (reason.construct === undefined ? '' : ` (${reason.construct})`);
        case 'conditional-formatting-threshold':
            return reason.worksheet === undefined
                ? `the conditional formatting on ${reason.sqref} has a threshold formula Table Viewer can't adjust (${reason.value})`
                : `the conditional formatting on ${qualified(reason.worksheet, reason.sqref)} has a threshold formula that uses this sheet (${reason.value})`;
        case 'unclassified-reference':
            return `${reason.part} refers to it in a way Table Viewer can't adjust`;
        case 'unreadable-part':
            return `Table Viewer can't read ${reason.part}`;
        case 'invalid-range':
            return `it has a range Table Viewer can't read in <${reason.element}> (${reason.value})`;
        case 'unwritable-worksheet':
            return "Table Viewer can't edit this sheet safely";
        case 'unreadable-worksheet':
            return reason.worksheet === undefined
                ? "Table Viewer can't read this sheet"
                : `Table Viewer can't read the sheet ${reason.worksheet}`;
    }
}

/**
 * The user-facing sentence for a refusal and an operation, in the spec's
 * style: "Can't insert or delete rows on this sheet: it contains an Excel
 * table." or "Can't move rows on this sheet: cell D2 has an array formula."
 */
export function structural_refusal_message(
    axis: StructuralAxis,
    reason: StructuralRefusalReason,
    operation: StructuralOperation = 'any',
): string {
    const verb = operation === 'insert-or-delete'
        ? 'insert or delete'
        : operation === 'move' ? 'move' : 'insert, delete, or move';
    return `Can't ${verb} ${axis} on this sheet: ${refusal_clause(reason)}.`;
}

function strip_message(refusal: StructuralRefusal): StructuralRefusalReason {
    const { message: _message, ...reason } = refusal;
    return reason as StructuralRefusalReason;
}

/** Attach the axis-specific message to a reason. */
export function structural_refusal(
    axis: StructuralAxis,
    reason: StructuralRefusalReason,
): StructuralRefusal {
    return { ...reason, message: structural_refusal_message(axis, reason) } as StructuralRefusal;
}

/** Convenience for a {@link FormulaAnchorabilityCheck}: the formula and the construct it could not anchor. */
export function unanchorable_formula_refusal(formula: string, construct?: string): StructuralRefusal {
    return structural_refusal('rows', {
        code: 'unanchorable-formula',
        formula,
        ...(construct === undefined ? {} : { construct }),
    });
}

// ---------------------------------------------------------------------------
// Formula targets: which worksheets a formula may reference
// ---------------------------------------------------------------------------

export interface FormulaTargets {
    /** Lower-cased worksheet names named in sheet qualifiers. */
    readonly sheets: ReadonlySet<string>;
    /** A 3D qualifier such as `Sheet1:Sheet3!`, which may span any worksheet. */
    readonly everySheet: boolean;
    /** Any A1 reference without a sheet qualifier. */
    readonly unqualified: boolean;
    /** Lower-cased identifiers that might be defined names. */
    readonly identifiers: ReadonlySet<string>;
}

const IDENTIFIER_START = /[\p{L}_\\]/u;
const IDENTIFIER_PART = /[\p{L}\p{N}_.\\]/u;

function identifier_end(formula: string, offset: number): number {
    if (!IDENTIFIER_START.test(formula[offset] ?? '')) return offset;
    let end = offset + 1;
    while (end < formula.length && IDENTIFIER_PART.test(formula[end])) end += 1;
    return end;
}

/**
 * End of an unquoted worksheet name. The worksheet-reference grammar is not
 * the defined-name grammar: a sheet name may begin with a digit (`2024!A1`),
 * so this accepts any identifier character in the first position too.
 */
function sheet_name_end(formula: string, offset: number): number {
    let end = offset;
    while (end < formula.length && IDENTIFIER_PART.test(formula[end])) end += 1;
    return end;
}

interface Qualifier {
    readonly names: readonly string[];
    readonly length: number;
}

/** A sheet qualifier (`Sheet1!`, `'My Sheet'!`, `Sheet1:Sheet3!`) at an exact offset. */
function qualifier_at(formula: string, offset: number): Qualifier | undefined {
    if (formula[offset] === "'") {
        for (let index = offset + 1; index < formula.length; index += 1) {
            if (formula[index] !== "'") continue;
            if (formula[index + 1] === "'") { index += 1; continue; }
            if (formula[index + 1] !== '!') return undefined;
            const text = formula.slice(offset + 1, index).replace(/''/g, "'");
            // Excel forbids `:` in sheet names, so inside quotes it is a 3D span.
            return { names: text.split(':'), length: index + 2 - offset };
        }
        return undefined;
    }
    const first_end = sheet_name_end(formula, offset);
    if (first_end === offset) return undefined;
    if (formula[first_end] === '!') {
        return { names: [formula.slice(offset, first_end)], length: first_end + 1 - offset };
    }
    if (formula[first_end] === ':') {
        const second_end = sheet_name_end(formula, first_end + 1);
        if (second_end > first_end + 1 && formula[second_end] === '!') {
            return {
                names: [formula.slice(offset, first_end), formula.slice(first_end + 1, second_end)],
                length: second_end + 1 - offset,
            };
        }
    }
    return undefined;
}

function skip_string(formula: string, offset: number): number {
    let index = offset + 1;
    while (index < formula.length) {
        if (formula[index] !== '"') { index += 1; continue; }
        if (formula[index + 1] === '"') { index += 2; continue; }
        return index + 1;
    }
    return index;
}

function skip_brackets(formula: string, offset: number): number {
    let depth = 0;
    for (let index = offset; index < formula.length; index += 1) {
        const char = formula[index];
        if (char === "'" && depth > 0) { index += 1; continue; } // structured-reference escape
        if (char === '[') depth += 1;
        else if (char === ']' && --depth === 0) return index + 1;
    }
    return formula.length;
}

/**
 * Conservatively list what a formula may refer to. Strings are skipped;
 * external-workbook references (`[1]Sheet1!A1`) are not this workbook's.
 * Everything else that could be a sheet qualifier or a defined name is kept.
 */
export function formula_targets(formula: string): FormulaTargets {
    const sheets = new Set<string>();
    const identifiers = new Set<string>();
    let every_sheet = false;
    let unqualified = false;
    let qualified_next = false;
    let index = formula.startsWith('=') ? 1 : 0;
    while (index < formula.length) {
        const char = formula[index];
        if (char === '"') { index = skip_string(formula, index); qualified_next = false; continue; }
        if (char === '[') {
            const after = skip_brackets(formula, index);
            const previous = formula[index - 1];
            const external = previous === undefined || !IDENTIFIER_PART.test(previous) && previous !== ']';
            index = after;
            if (external) {
                // `[1]Sheet1!A1` or `[Book.xlsx]Sheet1!A1`: another workbook.
                const qualifier = qualifier_at(formula, index);
                if (qualifier !== undefined) {
                    index += qualifier.length;
                    const skipped = a1_formula_reference_at(formula, index);
                    if (skipped !== undefined) index += skipped.length;
                    else index = Math.max(index, identifier_end(formula, index));
                }
            }
            qualified_next = false;
            continue;
        }
        const previous = formula[index - 1];
        if (previous !== undefined && IDENTIFIER_PART.test(previous) && char !== "'") {
            index += 1;
            continue;
        }
        const qualifier = qualifier_at(formula, index);
        if (qualifier !== undefined) {
            if (qualifier.names.length > 1) every_sheet = true;
            for (const name of qualifier.names) sheets.add(name.toLowerCase());
            index += qualifier.length;
            qualified_next = true;
            continue;
        }
        if (char === "'") { // a quoted name that is not a qualifier
            const close = formula.indexOf("'", index + 1);
            index = close === -1 ? formula.length : close + 1;
            qualified_next = false;
            continue;
        }
        const reference = a1_formula_reference_at(formula, index);
        if (reference !== undefined) {
            if (!qualified_next && reference.reference.sheetName === undefined) unqualified = true;
            index += reference.length;
            qualified_next = false;
            continue;
        }
        const end = identifier_end(formula, index);
        if (end > index) {
            identifiers.add(formula.slice(index, end).toLowerCase());
            index = end;
            qualified_next = false;
            continue;
        }
        if (char !== '$') qualified_next = false;
        index += 1;
    }
    return { sheets, everySheet: every_sheet, unqualified, identifiers };
}

// ---------------------------------------------------------------------------
// Package reading
// ---------------------------------------------------------------------------

/** The first part of each package this scan could not read. */
const UNREADABLE_PARTS = new WeakMap<ZipPackage, string>();

/**
 * The one way this module reads a part. A part that is present but can't be
 * read (encrypted, an unsupported method, past the inflate budget) returns
 * null like a missing one, and is recorded so the scan refuses every
 * worksheet instead of throwing: it may name any of them.
 */
function read_bytes(zip: ZipPackage, path: string): Uint8Array | null {
    try {
        return zip.read(`/${path}`);
    } catch (error) {
        if (!(error instanceof ZipPackageError)) throw error;
        if (!UNREADABLE_PARTS.has(zip)) UNREADABLE_PARTS.set(zip, path);
        return null;
    }
}

function read_text(zip: ZipPackage, path: string): string | null {
    const bytes = read_bytes(zip, path);
    return bytes === null ? null : Buffer.from(bytes).toString('utf8');
}

/** Resolve a relationship target against the part that owns the `.rels`. */
function resolve_target(source_part: string, target: string): string {
    const base = target.startsWith('/')
        ? []
        : source_part.split('/').slice(0, -1);
    const out = [...base];
    for (const segment of target.split('/')) {
        if (segment === '' || segment === '.') continue;
        if (segment === '..') { out.pop(); continue; }
        out.push(segment);
    }
    return out.join('/');
}

interface PartRelationship {
    readonly type: string;
    /** The target as written, for hyperlink locations such as `#Data!A1`. */
    readonly target: string;
    readonly part: string;
    readonly external: boolean;
}

function relationships_of(zip: ZipPackage, part: string): PartRelationship[] {
    const xml = read_text(zip, rels_path_for_part(part));
    if (xml === null) return [];
    return [...parse_relationships(xml).values()].map((relationship) => ({
        type: relationship.type,
        target: relationship.target,
        part: relationship.external ? relationship.target : resolve_target(part, relationship.target),
        external: relationship.external,
    }));
}

function local_name(qname: string): string {
    return qname.slice(qname.lastIndexOf(':') + 1);
}

function qname_prefix(qname: string): string {
    const colon = qname.indexOf(':');
    return colon === -1 ? '' : qname.slice(0, colon);
}

function is_spreadsheetml(namespace: string): boolean {
    return namespace === SPREADSHEETML_NS || namespace === STRICT_SPREADSHEETML_NS;
}

/** A direct worksheet child's namespace, from its own or the root's declarations. */
function child_namespace(child_qname: string, child_open: string, root_qname: string, root_open: string): string {
    const prefix = qname_prefix(child_qname);
    const attribute = prefix === '' ? 'xmlns' : `xmlns:${prefix}`;
    const declared = get_attr(child_open, attribute) ?? get_attr(root_open, attribute);
    if (declared !== null) return declared;
    // Matches the cell writer: an undeclared, unprefixed worksheet is SpreadsheetML.
    return prefix === '' && qname_prefix(root_qname) === '' ? SPREADSHEETML_NS : '';
}

/** Every live start tag in `[from, to)`, by byte offsets. */
function* start_tags(
    xml: Uint8Array,
    from: number,
    to: number,
    ranges: IgnorableRangeIndex,
): Generator<{ readonly start: number; readonly nameEnd: number; readonly tagEnd: number }> {
    let position = from;
    while (position < to) {
        const at = indexOf_live(xml, '<', position, ranges, to);
        if (at === -1) return;
        const first = xml[at + 1];
        if (first === undefined || first === 0x2f || first === 0x21 || first === 0x3f) {
            position = at + 1;
            continue;
        }
        let name_end = at + 1;
        while (name_end < to && !is_tag_boundary(xml[name_end])) name_end += 1;
        if (name_end >= to) return;
        const tag_end = find_tag_end(xml, name_end, to);
        if (tag_end === -1) return;
        yield { start: at, nameEnd: name_end, tagEnd: tag_end };
        position = tag_end + 1;
    }
}

/** Whether the qualified name in `[start + 1, name_end)` has this local part. */
function has_local_name(xml: Uint8Array, start: number, name_end: number, wanted: string): boolean {
    const local_start = name_end - wanted.length;
    if (local_start < start + 1) return false;
    if (local_start > start + 1 && xml[local_start - 1] !== 0x3a) return false; // `:`
    for (let index = 0; index < wanted.length; index += 1) {
        if (xml[local_start + index] !== wanted.charCodeAt(index)) return false;
    }
    return true;
}

/**
 * The character data an XML parser reports for `[from, to)`: text with
 * entities decoded, CDATA contents verbatim, and comments, processing
 * instructions, and any element tags dropped. Every formula or reference read
 * from element content goes through this, so `<![CDATA[Data!A1]]>` is read as
 * `Data!A1` and a comment inside `<f>` is not read as formula text.
 */
function xml_character_data(xml: Uint8Array, from: number, to: number): string {
    let out = '';
    let position = from;
    while (position < to) {
        const at = index_of_bytes(xml, '<', position, to);
        const text_end = at === -1 ? to : at;
        if (text_end > position) out += decode_xml(utf8_text(xml, position, text_end));
        if (at === -1) break;
        let close: string;
        let content_start = -1;
        if (starts_with_bytes(xml, '<![CDATA[', at)) {
            close = ']]>';
            content_start = at + 9;
        } else if (starts_with_bytes(xml, '<!--', at)) {
            close = '-->';
        } else if (starts_with_bytes(xml, '<?', at)) {
            close = '?>';
        } else {
            const tag_end = find_tag_end(xml, at, to);
            position = tag_end === -1 ? to : tag_end + 1;
            continue;
        }
        const end = index_of_bytes(xml, close, at + 2, to);
        const stop = end === -1 ? to : end;
        if (content_start !== -1 && stop > content_start) out += utf8_text(xml, content_start, stop);
        position = end === -1 ? to : end + close.length;
    }
    return out;
}

/** Character data of every live element in `[from, to)` whose local name matches. */
function* element_texts(
    xml: Uint8Array,
    from: number,
    to: number,
    ranges: IgnorableRangeIndex,
    wanted: (local: string) => boolean,
): Generator<string> {
    for (const tag of start_tags(xml, from, to, ranges)) {
        const name = utf8_text(xml, tag.start + 1, tag.nameEnd);
        if (!wanted(local_name(name)) || is_self_closing(xml, tag.start, tag.tagEnd)) continue;
        const close = end_tag_after(xml, name, tag.tagEnd + 1, ranges, to);
        if (close !== null) yield xml_character_data(xml, tag.tagEnd + 1, close[0]);
    }
}

function element_text(xml: Uint8Array, element: Span): string {
    return xml_character_data(xml, element.inner_start, element.inner_end);
}

function descendants_named(xml: Uint8Array, parent: Span, wanted: string): QualifiedElementSpan[] {
    return direct_child_elements(xml, parent).flatMap((child) => local_name(child.name) === wanted
        ? [child]
        : descendants_named(xml, child.element, wanted));
}

function children_named(xml: Uint8Array, parent: Span, wanted: string): QualifiedElementSpan[] {
    return direct_child_elements(xml, parent).filter((child) => local_name(child.name) === wanted);
}

// ---------------------------------------------------------------------------
// Worksheet scan
// ---------------------------------------------------------------------------

type FormulaKind = 'normal' | 'shared' | 'array' | 'dataTable';

interface CellFormula {
    readonly cell: string;
    readonly kind: FormulaKind;
    /** Absent for a shared follower or a data table, which carry no text. */
    readonly text?: string;
}

interface CheckedFormula {
    readonly location: StructuralFormulaLocation;
    readonly text: string;
}

interface ScannedWorksheet {
    readonly name: string;
    readonly path: string;
    readonly readable: boolean;
    /** Refusals found in the worksheet part and its own relationships, in check order. */
    readonly ownRefusal?: StructuralRefusalReason;
    readonly merges: readonly string[];
    readonly autoFilter?: StructuralAutoFilter;
    readonly relativeRules: readonly StructuralRelativeRule[];
    readonly cellFormulas: readonly CellFormula[];
    /** CF, DV, and internal hyperlink formulas (texts without the location's worksheet). */
    readonly otherFormulas: readonly { readonly location: StructuralFormulaLocation; readonly text: string }[];
    /**
     * References held in content the writer does not rewrite (formula
     * thresholds, data consolidation sources). They refuse this worksheet
     * already; each also refuses every other worksheet it may reference.
     */
    readonly foreignReferences: readonly ForeignReference[];
}

interface ForeignReference {
    readonly targets: FormulaTargets;
    /** The reason given to a referenced worksheet; `worksheet` is filled in then. */
    readonly reason: Extract<StructuralRefusalReason, {
        code: 'conditional-formatting-threshold' | 'unsupported-worksheet-child' | 'unsupported-extension';
    }>;
}

const NUMERIC_LITERAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const SQREF_RANGE_RE = /^\$?([A-Z]{1,3})\$?([1-9]\d{0,6})(?::\$?([A-Z]{1,3})\$?([1-9]\d{0,6}))?$/;

function column_number(letters: string): number {
    let value = 0;
    for (const char of letters) value = value * 26 + char.charCodeAt(0) - 64;
    return value;
}

function valid_range(text: string): boolean {
    const match = SQREF_RANGE_RE.exec(text);
    if (match === null) return false;
    const corners = [[match[1], match[2]], [match[3], match[4]]];
    return corners.every(([letters, digits]) => letters === undefined
        || (column_number(letters) <= 16_384 && Number(digits) <= 1_048_576));
}

function valid_sqref(text: string): boolean {
    const parts = text.trim().split(/\s+/);
    return parts.length > 0 && parts[0] !== '' && parts.every(valid_range);
}

interface FormulaTag {
    readonly start: number;
    readonly nameEnd: number;
    readonly tagEnd: number;
    /** The owning `<c>` opening tag, or -1 when none precedes the formula. */
    readonly cellStart: number;
    readonly cellTagEnd: number;
}

/** Every live `<f>` tag by walking every tag, for sheets that use prefixed names. */
function* formula_tags_by_walk(
    xml: Uint8Array,
    from: number,
    to: number,
    ranges: IgnorableRangeIndex,
): Generator<FormulaTag> {
    let cell_start = -1;
    let cell_tag_end = -1;
    for (const tag of start_tags(xml, from, to, ranges)) {
        if (has_local_name(xml, tag.start, tag.nameEnd, 'c')) {
            cell_start = tag.start;
            cell_tag_end = tag.tagEnd;
        } else if (has_local_name(xml, tag.start, tag.nameEnd, 'f')) {
            yield { ...tag, cellStart: cell_start, cellTagEnd: cell_tag_end };
        }
    }
}

/**
 * Every live unprefixed `<f>` tag by native search. Cells do not nest, so a
 * formula's owner is the nearest live `<c` before it.
 */
function* formula_tags_by_search(
    xml: Uint8Array,
    from: number,
    to: number,
    ranges: IgnorableRangeIndex,
): Generator<FormulaTag> {
    const bytes = Buffer.isBuffer(xml) ? xml : Buffer.from(xml.buffer, xml.byteOffset, xml.byteLength);
    let position = from;
    while (position < to) {
        const at = indexOf_live(xml, '<f', position, ranges, to);
        if (at === -1) return;
        position = at + 2;
        if (!is_tag_boundary(xml[at + 2])) continue;
        const tag_end = find_tag_end(xml, at + 2, to);
        if (tag_end === -1) return;
        let cell = bytes.lastIndexOf('<c', at - 1);
        while (cell >= from && (!is_tag_boundary(xml[cell + 2]) || ignorable_end(ranges, cell) !== undefined)) {
            cell = cell === 0 ? -1 : bytes.lastIndexOf('<c', cell - 1);
        }
        const cell_start = cell >= from ? cell : -1;
        yield {
            start: at,
            nameEnd: at + 2,
            tagEnd: tag_end,
            cellStart: cell_start,
            cellTagEnd: cell_start === -1 ? -1 : find_tag_end(xml, cell_start, to),
        };
        position = tag_end + 1;
    }
}

/** Every `<f>` in sheetData with its owning cell. */
function scan_cell_formulas(xml: Uint8Array, sheet_data: Span): CellFormula[] {
    const out: CellFormula[] = [];
    const from = sheet_data.inner_start;
    const to = sheet_data.inner_end;
    const ranges = ignorable_ranges(xml, from, to);
    // Without `:c` or `:f` anywhere in the body, no cell or formula element
    // can be prefixed, so a native search finds every formula.
    const prefixed = index_of_bytes(xml, ':c', from, to) !== -1 || index_of_bytes(xml, ':f', from, to) !== -1;
    const tags = prefixed
        ? formula_tags_by_walk(xml, from, to, ranges)
        : formula_tags_by_search(xml, from, to, ranges);
    for (const tag of tags) {
        const raw_kind = get_tag_attr(xml, tag.start, tag.tagEnd + 1, 't');
        const kind: FormulaKind = raw_kind === 'shared' || raw_kind === 'array' || raw_kind === 'dataTable'
            ? raw_kind
            : 'normal';
        const ref = get_tag_attr(xml, tag.start, tag.tagEnd + 1, 'ref');
        const cell = (tag.cellStart === -1 ? null : get_tag_attr(xml, tag.cellStart, tag.cellTagEnd + 1, 'r'))
            ?? ref?.split(':')[0]
            ?? '?';
        let text: string | undefined;
        if (!is_self_closing(xml, tag.start, tag.tagEnd)) {
            const name = utf8_text(xml, tag.start + 1, tag.nameEnd);
            const close = end_tag_after(xml, name, tag.tagEnd + 1, ranges, to);
            if (close !== null) {
                const value = xml_character_data(xml, tag.tagEnd + 1, close[0]);
                if (value !== '') text = value;
            }
        }
        out.push({ cell, kind, ...(text === undefined ? {} : { text }) });
    }
    return out;
}

/** Nested `<ext>` URIs and `AlternateContent` inside one non-sheetData child. */
function nested_extension_refusal(
    xml: Uint8Array,
    child: QualifiedElementSpan,
): StructuralRefusalReason | undefined {
    const { element } = child;
    if (element.inner_start === element.end) return undefined;
    // Neither construct can appear without one of these byte sequences, so a
    // large sheetData without them skips the per-tag walk.
    if (
        index_of_bytes(xml, 'ext', element.inner_start, element.inner_end) === -1
        && index_of_bytes(xml, 'AlternateContent', element.inner_start, element.inner_end) === -1
    ) return undefined;
    const ranges = ignorable_ranges(xml, element.inner_start, element.inner_end);
    for (const tag of start_tags(xml, element.inner_start, element.inner_end, ranges)) {
        if (has_local_name(xml, tag.start, tag.nameEnd, 'AlternateContent')) {
            return { code: 'alternate-content', element: child.name };
        }
        if (has_local_name(xml, tag.start, tag.nameEnd, 'ext')) {
            const uri = get_tag_attr(xml, tag.start, tag.tagEnd + 1, 'uri') ?? '';
            if (!REVIEWED_COORDINATE_FREE_EXTENSION_URIS.has(uri)) {
                return { code: 'unsupported-extension', uri, element: child.name };
            }
        }
    }
    return undefined;
}

/**
 * Range attributes the coverage table shifts, by element. The merge, CF, DV,
 * and AutoFilter ranges are read (and validated) where they are collected.
 */
const COVERED_RANGE_ATTRIBUTES: ReadonlyMap<string, readonly {
    readonly attribute: string;
    readonly list: boolean;
    readonly required: boolean;
}[]> = new Map([
    ['hyperlink', [{ attribute: 'ref', list: false, required: true }]],
    ['sortState', [{ attribute: 'ref', list: false, required: true }]],
    ['sortCondition', [{ attribute: 'ref', list: false, required: true }]],
    ['sheetView', [{ attribute: 'topLeftCell', list: false, required: false }]],
    ['pane', [{ attribute: 'topLeftCell', list: false, required: false }]],
    ['selection', [
        { attribute: 'activeCell', list: false, required: false },
        { attribute: 'sqref', list: true, required: false },
    ]],
    ['ignoredError', [{ attribute: 'sqref', list: true, required: true }]],
]);

/** The first covered range attribute in one worksheet child that the writer could not read. */
function covered_range_refusal(
    xml: Uint8Array,
    child: QualifiedElementSpan,
): StructuralRefusalReason | undefined {
    const { element } = child;
    const ranges = ignorable_ranges(xml, element.start, element.end);
    for (const tag of start_tags(xml, element.start, element.end, ranges)) {
        const local = local_name(utf8_text(xml, tag.start + 1, tag.nameEnd));
        for (const { attribute, list, required } of COVERED_RANGE_ATTRIBUTES.get(local) ?? []) {
            const value = get_tag_attr(xml, tag.start, tag.tagEnd + 1, attribute);
            if (value === null ? !required : list ? valid_sqref(value) : valid_range(value)) continue;
            return { code: 'invalid-range', element: local, value: value ?? '' };
        }
    }
    return undefined;
}

function worksheet_relationship_refusal(
    relationships: readonly PartRelationship[],
): StructuralRefusalReason | undefined {
    for (const relationship of relationships) {
        const disposition = WORKSHEET_RELATIONSHIPS.get(relationship_key(relationship.type));
        if (disposition?.kind === 'allowed') continue;
        return {
            code: 'unsupported-part',
            partKind: disposition?.kind === 'refused' ? disposition.partKind : 'unknown',
            part: relationship.part,
            relationshipType: relationship.type,
            scope: 'worksheet',
        };
    }
    return undefined;
}

function scan_worksheet(
    zip: ZipPackage,
    name: string,
    path: string,
): ScannedWorksheet {
    const empty = {
        name, path, merges: [], relativeRules: [], cellFormulas: [], otherFormulas: [], foreignReferences: [],
    };
    const raw = read_bytes(zip, path);
    if (raw === null) {
        return { ...empty, readable: false, ownRefusal: { code: 'unreadable-worksheet' } };
    }
    const xml = worksheet_scan_input(raw);

    let own: StructuralRefusalReason | undefined;
    const consider = (reason: StructuralRefusalReason | undefined): void => {
        if (own === undefined && reason !== undefined) own = reason;
    };

    try {
        writable_worksheet_sheet_data(xml);
    } catch (error) {
        consider({
            code: 'unwritable-worksheet',
            ...(error instanceof OoxmlRefusalError ? { ooxmlCode: error.code } : {}),
        });
    }

    consider(worksheet_relationship_refusal(relationships_of(zip, path)));

    const root = find_first_element_by_local_name(xml, 'worksheet');
    const merges: string[] = [];
    let auto_filter: StructuralAutoFilter | undefined;
    const relative_rules: StructuralRelativeRule[] = [];
    const other_formulas: { location: StructuralFormulaLocation; text: string }[] = [];
    const foreign_references: ForeignReference[] = [];
    if (root !== null) {
        const root_open = opening_tag_text(xml, root.element);
        for (const child of direct_child_elements(xml, root.element)) {
            const child_open = opening_tag_text(xml, child.element);
            const namespace = child_namespace(child.name, child_open, root.name, root_open);
            const local = local_name(child.name);
            if (namespace === MARKUP_COMPATIBILITY_NS && local === 'AlternateContent') {
                consider({ code: 'alternate-content', element: child.name });
                continue;
            }
            const row = is_spreadsheetml(namespace) ? INVENTORY_BY_ELEMENT.get(local) : undefined;
            if (row === undefined) {
                consider({ code: 'unknown-worksheet-child', element: child.name });
                continue;
            }
            if (row.disposition === 'refused') {
                const reason = { code: 'unsupported-worksheet-child', element: row.element as RefusedWorksheetChild } as const;
                consider(reason);
                if (local === 'controls') {
                    // ActiveX controls keep their cell links on `<controlPr>`.
                    for (const properties of descendants_named(xml, child.element, 'controlPr')) {
                        const open = opening_tag_text(xml, properties.element);
                        for (const attribute of ['linkedCell', 'listFillRange']) {
                            const text = get_attr(open, attribute);
                            if (text !== null && text !== '') foreign_references.push({ targets: formula_targets(text), reason });
                        }
                    }
                }
                if (local === 'dataConsolidate') {
                    // Each source names its sheet or a defined name; one without
                    // either is on this sheet, which already refuses.
                    for (const source of descendants_named(xml, child.element, 'dataRef')) {
                        const open = opening_tag_text(xml, source.element);
                        const sheet = get_attr(open, 'sheet');
                        const named = get_attr(open, 'name');
                        if (get_attr(open, 'r:id') !== null) continue; // another workbook
                        foreign_references.push({
                            targets: {
                                sheets: new Set(sheet === null ? [] : [sheet.toLowerCase()]),
                                everySheet: false,
                                unqualified: false,
                                identifiers: new Set(named === null ? [] : [named.toLowerCase()]),
                            },
                            reason,
                        });
                    }
                }
                continue;
            }
            const extension = nested_extension_refusal(xml, child);
            consider(extension);
            if (extension?.code === 'unsupported-extension') {
                // x14 conditional formatting, data validation, and sparklines
                // keep formulas in `<xm:f>`; Excel writes cross-sheet rules there.
                // Only `f` inside an `<ext>` counts, so cell formulas in
                // sheetData stay with the formula checks.
                const ranges = ignorable_ranges(xml, child.element.start, child.element.end);
                for (const tag of start_tags(xml, child.element.start, child.element.end, ranges)) {
                    if (!has_local_name(xml, tag.start, tag.nameEnd, 'ext') || is_self_closing(xml, tag.start, tag.tagEnd)) continue;
                    const name = utf8_text(xml, tag.start + 1, tag.nameEnd);
                    const close = end_tag_after(xml, name, tag.tagEnd + 1, ranges, child.element.end);
                    if (close === null) continue;
                    for (const text of element_texts(xml, tag.tagEnd + 1, close[0], ranges, (local_part) => local_part === 'f')) {
                        foreign_references.push({ targets: formula_targets(text), reason: extension });
                    }
                }
            }
            if (local === 'sheetData') continue;
            consider(covered_range_refusal(xml, child));

            if (local === 'autoFilter') {
                const ref = get_attr(child_open, 'ref') ?? '';
                const first_column = SQREF_RANGE_RE.exec(ref)?.[1];
                if (first_column === undefined || !valid_range(ref)) {
                    consider({ code: 'invalid-range', element: 'autoFilter', value: ref });
                    continue;
                }
                const columns = new Set<number>();
                for (const filter of children_named(xml, child.element, 'filterColumn')) {
                    const col_id = get_attr(opening_tag_text(xml, filter.element), 'colId') ?? '';
                    if (!/^\d{1,5}$/.test(col_id)) {
                        consider({ code: 'invalid-range', element: 'filterColumn', value: col_id });
                        continue;
                    }
                    columns.add(column_number(first_column) - 1 + Number(col_id));
                }
                auto_filter = { ref, filteredColumns: [...columns].sort((a, b) => a - b) };
            } else if (local === 'mergeCells') {
                for (const merge of children_named(xml, child.element, 'mergeCell')) {
                    const ref = get_attr(opening_tag_text(xml, merge.element), 'ref') ?? '';
                    if (!valid_range(ref)) consider({ code: 'invalid-range', element: 'mergeCell', value: ref });
                    merges.push(ref);
                }
            } else if (local === 'conditionalFormatting') {
                const sqref = get_attr(child_open, 'sqref') ?? '';
                if (!valid_sqref(sqref)) {
                    consider({ code: 'invalid-range', element: 'conditionalFormatting', value: sqref });
                }
                for (const rule of children_named(xml, child.element, 'cfRule')) {
                    // Color scales, data bars, and icon sets keep thresholds in
                    // `<cfvo val>`, which may be a formula; the writer does not
                    // rewrite those, so anything but a number refuses.
                    const ranges = ignorable_ranges(xml, rule.element.inner_start, rule.element.inner_end);
                    for (const tag of start_tags(xml, rule.element.inner_start, rule.element.inner_end, ranges)) {
                        if (!has_local_name(xml, tag.start, tag.nameEnd, 'cfvo')) continue;
                        const type = get_tag_attr(xml, tag.start, tag.tagEnd + 1, 'type');
                        const value = get_tag_attr(xml, tag.start, tag.tagEnd + 1, 'val');
                        if (type === 'formula' || (value !== null && !NUMERIC_LITERAL.test(value.trim()))) {
                            const reason = { code: 'conditional-formatting-threshold', sqref, value: value ?? '' } as const;
                            consider(reason);
                            foreign_references.push({ targets: formula_targets(value ?? ''), reason });
                        }
                    }
                    const formulas = children_named(xml, rule.element, 'formula')
                        .map((formula) => element_text(xml, formula.element));
                    relative_rules.push({ sqref, formulas });
                    for (const text of formulas) {
                        other_formulas.push({ location: { kind: 'conditional-formatting', sqref }, text });
                    }
                }
            } else if (local === 'dataValidations') {
                for (const validation of children_named(xml, child.element, 'dataValidation')) {
                    const sqref = get_attr(opening_tag_text(xml, validation.element), 'sqref') ?? '';
                    if (!valid_sqref(sqref)) {
                        consider({ code: 'invalid-range', element: 'dataValidation', value: sqref });
                    }
                    const formulas = direct_child_elements(xml, validation.element)
                        .filter((formula) => local_name(formula.name) === 'formula1'
                            || local_name(formula.name) === 'formula2')
                        .map((formula) => element_text(xml, formula.element));
                    relative_rules.push({ sqref, formulas });
                    for (const text of formulas) {
                        other_formulas.push({ location: { kind: 'data-validation', sqref }, text });
                    }
                }
            } else if (local === 'hyperlinks') {
                for (const link of children_named(xml, child.element, 'hyperlink')) {
                    const open = opening_tag_text(xml, link.element);
                    const location = get_attr(open, 'location');
                    if (location === null || location === '' || get_attr(open, 'r:id') !== null) continue;
                    other_formulas.push({
                        location: { kind: 'hyperlink', cell: get_attr(open, 'ref') ?? '?' },
                        text: location,
                    });
                }
            }
        }
    }

    const sheet_data = worksheet_sheet_data_element(xml);
    const cell_formulas = sheet_data === null ? [] : scan_cell_formulas(xml, sheet_data);
    return {
        name,
        path,
        readable: true,
        ...(own === undefined ? {} : { ownRefusal: own }),
        merges,
        ...(auto_filter === undefined ? {} : { autoFilter: auto_filter }),
        relativeRules: relative_rules,
        cellFormulas: cell_formulas,
        otherFormulas: other_formulas,
        foreignReferences: foreign_references,
    };
}

// ---------------------------------------------------------------------------
// Workbook scan
// ---------------------------------------------------------------------------

interface DefinedName {
    readonly name: string;
    readonly key: string;
    readonly text: string;
    readonly targets: FormulaTargets;
    /** Byte offset of the `<definedName>` element in `xl/workbook.xml`. */
    readonly start: number;
}

function defined_names(zip: ZipPackage): DefinedName[] {
    const raw = read_bytes(zip, 'xl/workbook.xml');
    if (raw === null) return [];
    // Only the workbook's own `<definedNames>` child: a section inside an
    // extension or alternate content is not one the writer renders, so the
    // backstop reads it instead.
    const root = find_first_element_by_local_name(raw, 'workbook');
    const section = root === null
        ? undefined
        : direct_child_elements(raw, root.element).find((child) => local_name(child.name) === 'definedNames');
    if (section === undefined) return [];
    return children_named(raw, section.element, 'definedName').flatMap((child) => {
        const name = get_attr(opening_tag_text(raw, child.element), 'name');
        if (name === null) return [];
        const text = element_text(raw, child.element);
        return [{ name, key: name.toLowerCase(), text, targets: formula_targets(text), start: child.element.start }];
    });
}

interface WorkbookRefusals {
    /** Refuses every worksheet. */
    readonly everyWorksheet?: StructuralRefusalReason;
    /** Refusals that apply to particular worksheets, by lower-cased name. */
    readonly byWorksheet: Map<string, StructuralRefusalReason>;
    /** Reasons that apply to worksheets matched through defined names, resolved later. */
    readonly byNameReference: { readonly identifiers: ReadonlySet<string>; readonly reason: StructuralRefusalReason }[];
}

function add_worksheet_refusal(
    refusals: WorkbookRefusals,
    targets: FormulaTargets,
    reason: StructuralRefusalReason,
    all_sheets: readonly string[],
): void {
    const keys = targets.everySheet || targets.unqualified ? all_sheets : [...targets.sheets];
    for (const key of keys) if (!refusals.byWorksheet.has(key)) refusals.byWorksheet.set(key, reason);
    if (targets.identifiers.size > 0) refusals.byNameReference.push({ identifiers: targets.identifiers, reason });
}

/** Workbook relationships, chart formulas, and pivot cache sources. */
function scan_workbook_parts(
    zip: ZipPackage,
    worksheets: readonly ScannedWorksheet[],
): WorkbookRefusals {
    const refusals: WorkbookRefusals = { byWorksheet: new Map(), byNameReference: [] };
    let every: StructuralRefusalReason | undefined;
    const all_sheets = worksheets.map((sheet) => sheet.name.toLowerCase());
    const chartsheet_paths: string[] = [];

    for (const relationship of relationships_of(zip, 'xl/workbook.xml')) {
        const key = relationship_key(relationship.type);
        const disposition = WORKBOOK_RELATIONSHIPS.get(key);
        if (disposition?.kind === 'allowed') continue;
        if (disposition?.kind === 'refused' || disposition === undefined) {
            every ??= {
                code: 'unsupported-part',
                partKind: disposition?.kind === 'refused' ? disposition.partKind : 'unknown',
                part: relationship.part,
                relationshipType: relationship.type,
                scope: 'workbook',
            };
            continue;
        }
        if (key === 'chartsheet') chartsheet_paths.push(relationship.part);
        if (key !== 'pivotCacheDefinition') continue;
        const reason: StructuralRefusalReason = {
            code: 'unsupported-part',
            partKind: 'pivot-cache',
            part: relationship.part,
            relationshipType: relationship.type,
            scope: 'workbook',
        };
        const raw = read_bytes(zip, relationship.part);
        const source = raw === null ? null : find_first_element_by_local_name(raw, 'cacheSource');
        if (raw === null || source === null) continue;
        const source_type = get_attr(opening_tag_text(raw, source.element), 'type') ?? 'worksheet';
        if (source_type === 'external') continue;
        const worksheet_source = find_first_element_by_local_name(raw, 'worksheetSource');
        const sheet = worksheet_source === null
            ? null
            : get_attr(opening_tag_text(raw, worksheet_source.element), 'sheet');
        const named = worksheet_source === null
            ? null
            : get_attr(opening_tag_text(raw, worksheet_source.element), 'name');
        if (source_type === 'worksheet' && sheet !== null) {
            add_worksheet_refusal(refusals, {
                sheets: new Set([sheet.toLowerCase()]), everySheet: false, unqualified: false, identifiers: new Set(),
            }, reason, all_sheets);
        } else if (source_type === 'worksheet' && named !== null) {
            // A named source is a defined name or an Excel table; tables refuse
            // their own sheet, and names resolve through the defined-name graph.
            add_worksheet_refusal(refusals, {
                sheets: new Set(), everySheet: false, unqualified: false, identifiers: new Set([named.toLowerCase()]),
            }, reason, all_sheets);
        } else {
            // Consolidation, scenario, or an unreadable source: assume any sheet.
            add_worksheet_refusal(refusals, {
                sheets: new Set(), everySheet: true, unqualified: false, identifiers: new Set(),
            }, reason, all_sheets);
        }
    }

    // Parts that refuse their own sheet can also read other sheets: charts,
    // shape text links and hyperlinks in drawings, form-control links in VML
    // and control properties, and table column formulas. Each such reference
    // refuses the sheets it names. Unqualified references name the host,
    // which already refuses, except in charts, where the older conservative
    // reading (every sheet) is kept.
    const scanned_parts = new Set<string>();
    const refuse = (
        text: string,
        reason: StructuralRefusalReason,
        host_key: string | undefined,
    ): void => {
        if (text.trim() === '') return;
        const targets = formula_targets(text);
        const scoped = host_key !== undefined && targets.unqualified && !targets.everySheet
            ? { ...targets, unqualified: false, sheets: new Set([...targets.sheets, host_key]) }
            : targets;
        add_worksheet_refusal(refusals, scoped, reason, all_sheets);
    };
    const part_reason = (
        partKind: UnsupportedPartKind,
        relationship: PartRelationship,
        host: string | undefined,
    ): StructuralRefusalReason => ({
        code: 'unsupported-part',
        partKind,
        part: relationship.part,
        relationshipType: relationship.type,
        scope: 'workbook',
        ...(host === undefined ? {} : { host }),
    });
    const refuse_unclassified = (relationship: PartRelationship): void => {
        add_worksheet_refusal(refusals, {
            sheets: new Set(), everySheet: true, unqualified: false, identifiers: new Set(),
        }, part_reason('unknown', relationship, undefined), all_sheets);
    };
    const each_element_text = (
        raw: Uint8Array,
        wanted: (local: string) => boolean,
        visit: (text: string) => void,
    ): void => {
        for (const text of element_texts(raw, 0, raw.length, ignorable_ranges(raw, 0, raw.length), wanted)) visit(text);
    };
    const scan_chart = (relationship: PartRelationship, host: string | undefined): void => {
        const raw = read_bytes(zip, relationship.part);
        if (raw === null) return;
        const reason = part_reason('chart', relationship, host);
        each_element_text(raw, (local) => local === 'f', (text) => refuse(text, reason, undefined));
        for (const child of relationships_of(zip, relationship.part)) {
            const key = relationship_key(child.type);
            if (key === 'chartUserShapes' && !child.external) scan_drawing(child, host);
            else if (!CHART_RELATIONSHIPS_WITHOUT_REFERENCES.has(key)) refuse_unclassified(child);
        }
    };
    const scan_drawing = (relationship: PartRelationship, host: string | undefined): void => {
        if (scanned_parts.has(relationship.part)) return;
        scanned_parts.add(relationship.part);
        const raw = read_bytes(zip, relationship.part);
        if (raw === null) return;
        const host_key = host?.toLowerCase();
        const reason = part_reason('drawing', relationship, host);
        const ranges = ignorable_ranges(raw, 0, raw.length);
        for (const tag of start_tags(raw, 0, raw.length, ranges)) {
            refuse(get_tag_attr(raw, tag.start, tag.tagEnd + 1, 'textlink') ?? '', reason, host_key);
        }
        for (const child of relationships_of(zip, relationship.part)) {
            const key = relationship_key(child.type);
            if (key === 'chart' || key === CHART_EX_RELATIONSHIP) {
                if (child.external || scanned_parts.has(child.part)) continue;
                scanned_parts.add(child.part);
                scan_chart(child, host);
            } else if (key === 'hyperlink') {
                // `#Data!A1` is a location in this workbook; anything else is a URI.
                if (child.target.startsWith('#')) refuse(child.target.slice(1), reason, host_key);
            } else if (!DRAWING_RELATIONSHIPS_WITHOUT_REFERENCES.has(key)) {
                refuse_unclassified(child);
            }
        }
    };

    for (const sheet of worksheets) {
        const host_key = sheet.name.toLowerCase();
        for (const relationship of relationships_of(zip, sheet.path)) {
            const key = relationship_key(relationship.type);
            if (key === 'hyperlink' && relationship.target.startsWith('#')) {
                // `#Data!A1` is a location in this workbook; the writer leaves
                // relationship targets as written.
                refuse(relationship.target.slice(1), part_reason('hyperlink', relationship, sheet.name), host_key);
                continue;
            }
            if (relationship.external) continue;
            if (key === 'drawing') {
                scan_drawing(relationship, sheet.name);
                continue;
            }
            const raw = key === 'vmlDrawing' || key === 'ctrlProp' || key === 'table'
                ? read_bytes(zip, relationship.part)
                : null;
            if (raw === null) continue;
            if (key === 'vmlDrawing') {
                // Legacy form controls: `<x:FmlaLink>`, `<x:FmlaRange>`, and kin.
                const reason = part_reason('legacy-drawing', relationship, sheet.name);
                each_element_text(raw, (local) => local.startsWith('Fmla'), (text) => refuse(text, reason, host_key));
            } else if (key === 'ctrlProp') {
                const reason = part_reason('control', relationship, sheet.name);
                const properties = find_first_element_by_local_name(raw, 'formControlPr');
                if (properties === null) continue;
                const open = opening_tag_text(raw, properties.element);
                for (const attribute of ['fmlaLink', 'fmlaRange', 'fmlaGroup', 'fmlaTxbx']) {
                    refuse(get_attr(open, attribute) ?? '', reason, host_key);
                }
            } else {
                const reason = part_reason('table', relationship, sheet.name);
                each_element_text(
                    raw,
                    (local) => local === 'calculatedColumnFormula' || local === 'totalsRowFormula',
                    (text) => refuse(text, reason, host_key),
                );
            }
        }
    }
    for (const path of chartsheet_paths) {
        for (const relationship of relationships_of(zip, path)) {
            if (!relationship.external && relationship_key(relationship.type) === 'drawing') {
                scan_drawing(relationship, undefined);
            }
        }
    }

    return every === undefined ? refusals : { ...refusals, everyWorksheet: every };
}

/** Which defined names use each identifier, built once per scan. */
function name_users(names: readonly DefinedName[]): Map<string, DefinedName[]> {
    const users = new Map<string, DefinedName[]>();
    for (const name of names) {
        for (const identifier of name.targets.identifiers) {
            const list = users.get(identifier);
            if (list === undefined) users.set(identifier, [name]);
            else list.push(name);
        }
    }
    return users;
}

/** Names that may reference one worksheet, closed over names that use names. */
function names_referencing(
    names: readonly DefinedName[],
    users: ReadonlyMap<string, readonly DefinedName[]>,
    sheet_key: string,
): Set<string> {
    const out = new Set<string>();
    const queue: string[] = [];
    for (const name of names) {
        const { targets } = name;
        if ((targets.sheets.has(sheet_key) || targets.everySheet || targets.unqualified) && !out.has(name.key)) {
            out.add(name.key);
            queue.push(name.key);
        }
    }
    while (queue.length > 0) {
        const key = queue.pop()!;
        for (const user of users.get(key) ?? []) {
            if (out.has(user.key)) continue;
            out.add(user.key);
            queue.push(user.key);
        }
    }
    return out;
}

function may_reference(
    targets: FormulaTargets,
    formula_sheet_key: string | undefined,
    sheet_key: string,
    names: ReadonlySet<string>,
): boolean {
    if (formula_sheet_key === sheet_key) return true;
    if (targets.sheets.has(sheet_key) || targets.everySheet) return true;
    for (const identifier of targets.identifiers) if (names.has(identifier)) return true;
    return false;
}

function with_worksheet(
    location: StructuralFormulaLocation,
    worksheet: string | undefined,
): StructuralFormulaLocation {
    if (worksheet === undefined || location.kind === 'defined-name') return location;
    return { ...location, worksheet };
}

// ---------------------------------------------------------------------------
// Backstop: any sheet qualifier anywhere in the package
// ---------------------------------------------------------------------------

/**
 * Relationship types whose target parts the backstop skips whole: styles,
 * shared strings (cell values), themes, and document properties. A part is
 * skipped only when every relationship that targets it has one of these types.
 */
const BACKSTOP_SKIPPED_RELATIONSHIPS: ReadonlySet<string> = new Set([
    'styles',
    'sharedStrings',
    'theme',
    'themeOverride',
    'extended-properties',
    'custom-properties',
    'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
]);

/** Relationship types whose targets are binary media, not markup. */
const BACKSTOP_BINARY_RELATIONSHIPS: ReadonlySet<string> = new Set([
    'image',
    'printerSettings',
    'oleObject',
    'package',
    'video',
    'audio',
    'http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail',
    'http://schemas.microsoft.com/office/2007/relationships/hdphoto',
    'http://schemas.microsoft.com/office/2006/relationships/vbaProject',
    'http://schemas.microsoft.com/office/2007/relationships/media',
]);
const BACKSTOP_BINARY_EXTENSION = /\.(?:png|jpe?g|jfif|gif|bmp|tiff?|emf|wmf|wdp|ico|bin|mp3|mp4|wav|avi|mov)$/i;

/**
 * The exact element paths whose text the writer rewrites or that hold cell
 * values, by document kind. Unprefixed names in the SpreadsheetML default
 * namespace only; any extension, alternate content, or other wrapper breaks
 * the path, so nothing inside one is ever exempt.
 */
const BACKSTOP_WORKSHEET_TEXT_PATHS: ReadonlySet<string> = new Set([
    'worksheet/sheetData/row/c/f',
    'worksheet/sheetData/row/c/v',
    'worksheet/sheetData/row/c/is/t',
    'worksheet/sheetData/row/c/is/r/t',
    'worksheet/sheetData/row/c/is/rPh/t',
    'worksheet/conditionalFormatting/cfRule/formula',
    'worksheet/dataValidations/dataValidation/formula1',
    'worksheet/dataValidations/dataValidation/formula2',
]);

type BackstopPartKind = 'worksheet' | 'workbook' | 'relationships' | 'other';

interface BackstopFrame {
    readonly qname: string;
    readonly start: number;
    /** Whether this element's default namespace is SpreadsheetML. */
    readonly spreadsheetml: boolean;
}

/** UTF-8 bytes of an XML part, or undefined when it is not markup. */
function backstop_xml_bytes(raw: Uint8Array): Uint8Array | undefined {
    const utf16 = (encoding: 'utf-16le' | 'utf-16be', from: number): Uint8Array =>
        Buffer.from(new TextDecoder(encoding).decode(raw.subarray(from)), 'utf8');
    if (raw[0] === 0xff && raw[1] === 0xfe) return utf16('utf-16le', 2);
    if (raw[0] === 0xfe && raw[1] === 0xff) return utf16('utf-16be', 2);
    if (raw[0] === 0x3c && raw[1] === 0x00) return utf16('utf-16le', 0);
    if (raw[0] === 0x00 && raw[1] === 0x3c) return utf16('utf-16be', 0);
    let first = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf ? 3 : 0;
    while (first < raw.length && (raw[first] === 0x20 || raw[first] === 0x09 || raw[first] === 0x0a || raw[first] === 0x0d)) first += 1;
    return raw[first] === 0x3c ? raw : undefined;
}

function qname_at(xml: Uint8Array, start: number): string {
    let end = start;
    while (end < xml.length && !is_tag_boundary(xml[end])) end += 1;
    return utf8_text(xml, start, end);
}

/** Every attribute of one opening tag, values XML-decoded. */
function decoded_attributes(tag: string): { readonly name: string; readonly value: string }[] {
    const out: { name: string; value: string }[] = [];
    const pattern = /([^\s=/<>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    for (let match = pattern.exec(tag); match !== null; match = pattern.exec(tag)) {
        // Attribute-value normalization (XML 1.0 §3.3.3): literal line breaks
        // and tabs read as spaces; ones written as character references stay.
        const raw = (match[2] ?? match[3] ?? '').replace(/\r\n|[\t\n\r]/g, ' ');
        out.push({ name: match[1], value: decode_xml(raw) });
    }
    return out;
}

/**
 * Every sheet-qualifier name list in decoded text: `Data!`, `'My Sheet'!`,
 * `First:Last!`. Unquoted names may start with a digit (`2024!`).
 */
function qualifier_names_in(text: string): string[][] {
    const out: string[][] = [];
    for (let bang = text.indexOf('!'); bang !== -1; bang = text.indexOf('!', bang + 1)) {
        const lower = Math.max(0, bang - 512);
        if (text[bang - 1] === "'") {
            let i = bang - 2;
            while (i >= lower) {
                if (text[i] !== "'") { i -= 1; continue; }
                if (text[i - 1] === "'") { i -= 2; continue; }
                break;
            }
            if (i >= lower && i < bang - 1) out.push(text.slice(i + 1, bang - 1).replace(/''/g, "'").split(':'));
            continue;
        }
        let start = bang;
        while (start > lower && /[\p{L}\p{N}_.\\:]/u.test(text[start - 1])) start -= 1;
        if (start < bang) out.push(text.slice(start, bang).split(':'));
    }
    return out;
}

/**
 * Walk one XML part as a parser would, handing each decoded attribute value
 * and each element's combined character data (adjacent text and CDATA,
 * across comments and processing instructions) that contains `!` to
 * `visit`, unless it is a node the writer rewrites. Returns false when the
 * part declares a DTD, whose entities this walk does not expand.
 */
function walk_backstop_part(
    xml: Uint8Array,
    kind: BackstopPartKind,
    defined_name_offsets: ReadonlySet<number>,
    visit: (text: string) => void,
): boolean {
    // Positions where decoded text can contain `!`: the byte itself, or a
    // character reference. Queries arrive in ascending order.
    const candidates: number[] = [];
    for (let at = index_of_bytes(xml, '!'); at !== -1; at = index_of_bytes(xml, '!', at + 1)) candidates.push(at);
    for (let at = index_of_bytes(xml, '&#'); at !== -1; at = index_of_bytes(xml, '&#', at + 2)) candidates.push(at);
    if (candidates.length === 0) return true;
    candidates.sort((left, right) => left - right);
    const declarations: number[] = [];
    for (let at = index_of_bytes(xml, 'xmlns'); at !== -1; at = index_of_bytes(xml, 'xmlns', at + 5)) declarations.push(at);
    // Monotone membership tests over sorted positions; queries only move forward.
    const cursor = (positions: readonly number[]) => {
        let pointer = 0;
        return (from: number, to: number): boolean => {
            while (pointer < positions.length && positions[pointer] < from) pointer += 1;
            return pointer < positions.length && positions[pointer] < to;
        };
    };
    const has_candidate = cursor(candidates);
    const has_declaration = cursor(declarations);

    const stack: BackstopFrame[] = [];
    let first_sheet_data = -1;
    const path = (): string => stack.map((frame) => frame.qname).join('/');
    const in_spreadsheetml = (): boolean => stack.every((frame) => frame.spreadsheetml);
    const text_exempt = (): boolean => {
        if (!in_spreadsheetml()) return false;
        if (kind === 'worksheet') {
            return BACKSTOP_WORKSHEET_TEXT_PATHS.has(path())
                && (stack[1]?.qname !== 'sheetData' || stack[1].start === first_sheet_data);
        }
        if (kind === 'workbook') {
            return path() === 'workbook/definedNames/definedName' && defined_name_offsets.has(stack[2].start);
        }
        return false;
    };

    // The current run of character data, as (start, end, cdata) triples.
    const pieces: number[] = [];
    let pieces_have_candidate = false;
    const flush = (): void => {
        if (pieces_have_candidate) {
            let text = '';
            for (let index = 0; index < pieces.length; index += 3) {
                const raw = utf8_text(xml, pieces[index], pieces[index + 1]);
                text += pieces[index + 2] === 1 ? raw : decode_xml(raw);
            }
            if (text.includes('!') && !text_exempt()) visit(text);
        }
        pieces.length = 0;
        pieces_have_candidate = false;
    };
    const add_piece = (start: number, end: number, cdata: boolean): void => {
        if (end <= start || stack.length === 0) return;
        pieces.push(start, end, cdata ? 1 : 0);
        if (has_candidate(start, end)) pieces_have_candidate = true;
    };

    let position = 0;
    while (position < xml.length) {
        const open = index_of_bytes(xml, '<', position);
        add_piece(position, open === -1 ? xml.length : open, false);
        if (open === -1) break;
        if (starts_with_bytes(xml, '<!--', open)) {
            const close = index_of_bytes(xml, '-->', open + 4);
            position = close === -1 ? xml.length : close + 3;
            continue;
        }
        if (starts_with_bytes(xml, '<![CDATA[', open)) {
            const close = index_of_bytes(xml, ']]>', open + 9);
            add_piece(open + 9, close === -1 ? xml.length : close, true);
            position = close === -1 ? xml.length : close + 3;
            continue;
        }
        if (starts_with_bytes(xml, '<?', open)) {
            const close = index_of_bytes(xml, '?>', open + 2);
            position = close === -1 ? xml.length : close + 2;
            continue;
        }
        if (xml[open + 1] === 0x21) return false; // `<!DOCTYPE`, `<!ENTITY`
        const tag_end = find_tag_end(xml, open);
        if (tag_end === -1) break;
        flush();
        if (xml[open + 1] === 0x2f) { // `</`
            stack.pop();
            position = tag_end + 1;
            continue;
        }
        const qname = qname_at(xml, open + 1);
        const tag_has_candidate = has_candidate(open, tag_end);
        const attributes = has_declaration(open, tag_end) || tag_has_candidate
            ? decoded_attributes(utf8_text(xml, open, tag_end + 1))
            : [];
        const declared = attributes.find((attribute) => attribute.name === 'xmlns')?.value;
        const inherited = stack.length === 0 ? (kind === 'worksheet' || kind === 'workbook') : stack[stack.length - 1].spreadsheetml;
        const frame: BackstopFrame = {
            qname,
            start: open,
            spreadsheetml: declared === undefined ? inherited : is_spreadsheetml(declared),
        };
        if (stack.length === 1 && qname === 'sheetData' && first_sheet_data === -1) first_sheet_data = open;
        stack.push(frame);
        const element_path = tag_has_candidate ? path() : '';
        for (const { name, value } of attributes) {
            if (!value.includes('!')) continue;
            const exempt = kind === 'worksheet'
                ? element_path === 'worksheet/hyperlinks/hyperlink' && name === 'location'
                    && in_spreadsheetml() && !attributes.some((attribute) => attribute.name === 'r:id')
                : kind === 'relationships' && element_path === 'Relationships/Relationship'
                    && (name === 'Id' || name === 'Type');
            if (!exempt) visit(value);
        }
        if (is_self_closing(xml, open, tag_end)) stack.pop();
        position = tag_end + 1;
    }
    flush();
    return true;
}

/**
 * For each worksheet index, the first package part that names it in a sheet
 * qualifier (`Data!`, `'My Sheet'!`, `#Data!` in a relationship target) at
 * a node no specific check classifies. Deliberately coarse: it may refuse a
 * sheet that is merely named in text, but it never lets one through.
 */
function unclassified_references(
    zip: ZipPackage,
    worksheets: readonly ScannedWorksheet[],
    defined_name_offsets: ReadonlySet<number>,
): Map<number, StructuralRefusalReason> {
    const found = new Map<number, StructuralRefusalReason>();
    const index_by_name = new Map(worksheets.map((sheet, index) => [sheet.name.toLowerCase(), index]));
    // Every sheet name, chartsheets included: a 3D span ending on a chartsheet
    // still covers the worksheets between its endpoints.
    const workbook_text = read_text(zip, 'xl/workbook.xml');
    const sheet_names = new Set((workbook_text === null ? [] : parse_workbook_xml(workbook_text).sheets)
        .map((sheet) => sheet.name.toLowerCase()));
    const worksheet_paths = new Set(worksheets.map((sheet) => sheet.path));
    const parts = zip.part_names();

    // Every relationship type that targets each part, from every `.rels`.
    const targeted_by = new Map<string, Set<string>>();
    for (const rels of parts) {
        const match = /^(.*?)_rels\/([^/]*)\.rels$/.exec(rels);
        if (match === null) continue;
        for (const relationship of relationships_of(zip, `${match[1]}${match[2]}`)) {
            if (relationship.external) continue;
            const types = targeted_by.get(relationship.part) ?? new Set<string>();
            types.add(relationship_key(relationship.type));
            targeted_by.set(relationship.part, types);
        }
    }
    const only = (part: string, allowed: ReadonlySet<string>): boolean => {
        const types = targeted_by.get(part);
        return types !== undefined && [...types].every((type) => allowed.has(type));
    };

    const record = (indexes: readonly number[], part: string): void => {
        for (const index of indexes) if (!found.has(index)) found.set(index, { code: 'unclassified-reference', part });
    };
    const every_index = worksheets.map((_, index) => index);
    for (const part of parts) {
        if (found.size === worksheets.length) break;
        if (only(part, BACKSTOP_SKIPPED_RELATIONSHIPS)) continue;
        if (BACKSTOP_BINARY_EXTENSION.test(part) && (targeted_by.get(part) === undefined || only(part, BACKSTOP_BINARY_RELATIONSHIPS))) continue;
        const raw = read_bytes(zip, part);
        if (raw === null) continue;
        const xml = backstop_xml_bytes(raw);
        if (xml === undefined) continue;
        const kind: BackstopPartKind = worksheet_paths.has(part)
            ? 'worksheet'
            : part === 'xl/workbook.xml' ? 'workbook' : part.endsWith('.rels') ? 'relationships' : 'other';
        const parsed = walk_backstop_part(xml, kind, kind === 'workbook' && xml === raw ? defined_name_offsets : new Set(), (text) => {
            for (const names of qualifier_names_in(text)) {
                const indexes = names
                    .map((name) => index_by_name.get(name.toLowerCase()))
                    .filter((index): index is number => index !== undefined);
                if (names.length === 2 && indexes.length === 2) {
                    // A 3D span between two worksheets covers the worksheets between them.
                    record(Array.from({ length: Math.abs(indexes[1] - indexes[0]) + 1 }, (_, k) => Math.min(...indexes) + k), part);
                } else if (names.length === 2 && names.some((name) => sheet_names.has(name.toLowerCase()))) {
                    // An endpoint that is a chartsheet or no sheet at all: the
                    // span is unknown, so it may cover any worksheet.
                    record(every_index, part);
                } else {
                    record(indexes, part);
                }
            }
        });
        if (!parsed) record(every_index, part);
    }
    return found;
}

/**
 * Scan a verified workbook package and report, per worksheet in reader order
 * (`worksheet_part_entries_from_package`), whether each axis can be
 * restructured, plus the merges and conditional-formatting/validation rules
 * the webview needs for action-time checks.
 */
export function scan_xlsx_structural_support(
    raw: Uint8Array,
    options?: XlsxStructuralSupportOptions,
): WorksheetStructuralSupport[] {
    let zip: ZipPackage;
    try {
        zip = ZipPackage.open(raw);
    } catch {
        throw new Error('Not a valid .xlsx file');
    }
    const entries = worksheet_part_entries_from_package(zip);
    const worksheets = entries.map((entry) => scan_worksheet(zip, entry.name, entry.path));
    const names = defined_names(zip);
    const users = name_users(names);
    const workbook = scan_workbook_parts(zip, worksheets);
    const check = options?.formula_is_anchorable;
    const anchorability = new Map<string, StructuralRefusal | undefined>();
    const check_formula = (text: string): StructuralRefusal | undefined => {
        if (check === undefined) return undefined;
        if (anchorability.has(text)) return anchorability.get(text);
        const result = check(text);
        anchorability.set(text, result);
        return result;
    };

    const unreadable = worksheets.find((sheet) => !sheet.readable);
    const backstop = unclassified_references(zip, worksheets, new Set(names.map((name) => name.start)));
    // Read after every scan above, so a failure anywhere refuses every sheet.
    const unreadable_part = UNREADABLE_PARTS.get(zip);
    const targets_cache = new Map<string, FormulaTargets>();
    const targets_of = (text: string): FormulaTargets => {
        let targets = targets_cache.get(text);
        if (targets === undefined) {
            targets = formula_targets(text);
            targets_cache.set(text, targets);
        }
        return targets;
    };

    return worksheets.map((sheet, sheet_index) => {
        const sheet_key = sheet.name.toLowerCase();
        const referencing_names = names_referencing(names, users, sheet_key);
        const specific = ((): StructuralRefusalReason | undefined => {
            if (sheet.ownRefusal !== undefined) return sheet.ownRefusal;
            if (unreadable !== undefined) {
                return { code: 'unreadable-worksheet', worksheet: unreadable.name };
            }
            if (workbook.everyWorksheet !== undefined) return workbook.everyWorksheet;
            const direct = workbook.byWorksheet.get(sheet_key);
            if (direct !== undefined) return direct;
            for (const { identifiers, reason: named } of workbook.byNameReference) {
                for (const identifier of identifiers) if (referencing_names.has(identifier)) return named;
            }

            for (const formula of sheet.cellFormulas) {
                if (formula.kind === 'array') return { code: 'array-formula', cell: formula.cell };
                if (formula.kind === 'dataTable') return { code: 'data-table', cell: formula.cell };
            }
            for (const other of worksheets) {
                if (other === sheet) continue;
                const other_key = other.name.toLowerCase();
                for (const formula of other.cellFormulas) {
                    if (formula.kind !== 'array' || formula.text === undefined) continue;
                    if (!may_reference(targets_of(formula.text), other_key, sheet_key, referencing_names)) continue;
                    return { code: 'array-formula', cell: formula.cell, worksheet: other.name };
                }
            }

            for (const other of worksheets) {
                if (other === sheet) continue;
                const other_key = other.name.toLowerCase();
                for (const { targets, reason: foreign } of other.foreignReferences) {
                    if (!may_reference(targets, other_key, sheet_key, referencing_names)) continue;
                    return { ...foreign, worksheet: other.name };
                }
            }

            if (check === undefined) return undefined;
            // Rule 5, in a fixed order: this sheet's formulas, defined names,
            // then other sheets' formulas that may reference this sheet.
            function* candidates(): Generator<CheckedFormula> {
                for (const owner of [sheet, ...worksheets.filter((other) => other !== sheet)]) {
                    const owner_key = owner.name.toLowerCase();
                    const worksheet = owner === sheet ? undefined : owner.name;
                    const relevant = (text: string): boolean => owner === sheet
                        || may_reference(targets_of(text), owner_key, sheet_key, referencing_names);
                    for (const formula of owner.cellFormulas) {
                        if (formula.text === undefined || !relevant(formula.text)) continue;
                        yield {
                            location: with_worksheet({ kind: 'cell', cell: formula.cell }, worksheet),
                            text: formula.text,
                        };
                    }
                    for (const formula of owner.otherFormulas) {
                        if (!relevant(formula.text)) continue;
                        yield { location: with_worksheet(formula.location, worksheet), text: formula.text };
                    }
                    if (owner !== sheet) continue;
                    for (const name of names) {
                        if (!referencing_names.has(name.key)) continue;
                        yield { location: { kind: 'defined-name', name: name.name }, text: name.text };
                    }
                }
            }
            for (const { location, text } of candidates()) {
                const refusal = check_formula(text);
                if (refusal === undefined) continue;
                const base = strip_message(refusal);
                return base.code === 'unanchorable-formula' ? { ...base, location } : base;
            }
            return undefined;
        })();
        const reason: StructuralRefusalReason | undefined = specific
            ?? (unreadable_part === undefined ? undefined : { code: 'unreadable-part', part: unreadable_part })
            ?? backstop.get(sheet_index);

        const axis = (name: StructuralAxis): StructuralAxisSupport => reason === undefined
            ? { supported: true }
            : { supported: false, reason: structural_refusal(name, reason) };
        return {
            rows: axis('rows'),
            columns: axis('columns'),
            merges: sheet.merges,
            ...(sheet.autoFilter === undefined ? {} : { autoFilter: sheet.autoFilter }),
            relativeRules: sheet.relativeRules,
        };
    });
}
