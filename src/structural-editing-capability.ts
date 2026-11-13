/**
 * What the host tells the webview about restructuring a workbook's worksheets:
 * per worksheet and per axis, whether Insert, Delete, Restore, and Move are
 * available, and the Structural Basis a first layout change records.
 *
 * Kept apart from the controller so the snapshot projection, publication, and
 * the save path all read one definition of the current file's basis. The
 * basis is the file the host already verifies saves against: for CSV and
 * TSV, its digest and byte length as observed when the source was built; for
 * `.xlsx`, the digests of the parts a structural save reads (the worksheet
 * part, `sharedStrings.xml`, `styles.xml`, and `workbook.xml`), taken from
 * the same bytes. Both carry the worksheet's canonical row and column counts.
 *
 * `.xlsx` support per worksheet and axis is the structural support scan's
 * answer for the same bytes (`observation.xlsxStructure`), shipped with the
 * merges, AutoFilter, and conditional-formatting and validation rules the
 * webview's action-time checks and split warning read.
 */

import type { SheetMeta } from './data-source/interface';
import type { StructuralBasis } from './pending-changes';
import { MAX_SHEET_COLUMNS } from './spreadsheet-safety';
import type { TableFormatId } from './table-format';
import type {
    StructuralAxisSupport,
    StructuralEditingCapability,
    WorksheetStructuralSupport,
} from './viewer-snapshot';
import { header_body_start, TOO_WIDE_TO_RESTRUCTURE_MESSAGE } from './worksheet-layout';
import type { XlsxStructuralObservation } from './xlsx-structural-observation';
import {
    structural_refusal_message,
    type StructuralAxis,
    type StructuralAxisSupport as ScannedAxisSupport,
    type WorksheetStructuralSupport as ScannedWorksheetSupport,
} from './xlsx-structural-support';

/**
 * A worksheet whose source cannot be restructured at all (a format without a
 * structural writer, or an observation that lacks what its basis needs)
 * reports both axes unsupported with this reason.
 */
export const STRUCTURE_NOT_AVAILABLE_YET = 'Not available yet';

/** An `.xlsx` package whose structure the host could not read. */
export const XLSX_STRUCTURE_UNREADABLE_MESSAGE =
    "Can't insert, delete, or move rows or columns: Table Viewer couldn't read this workbook's structure.";

/** The physical observation a basis is computed from: what save verification checks. */
export interface StructuralBasisObservation {
    readonly digest: string;
    /** Byte length of the bytes `digest` covers; absent when the observation predates it. */
    readonly byteLength?: number;
    /** `.xlsx` only: the per-part digests and support scan for the same bytes. */
    readonly xlsxStructure?: XlsxStructuralObservation;
}

/**
 * The current file's Structural Basis for one worksheet, or undefined when the
 * format cannot be restructured or the observation lacks what the basis
 * needs. Delimited files are one worksheet, so their basis is the whole file;
 * an `.xlsx` worksheet's is the digests of the parts its save reads, found by
 * `sheet_index` in reader order.
 */
export function current_structural_basis(
    format: TableFormatId,
    observation: StructuralBasisObservation | undefined,
    sheet: Pick<SheetMeta, 'sourceRowCount' | 'columnCount' | 'excelFirstRowHeader'> | undefined,
    sheet_index: number,
): StructuralBasis | undefined {
    if (observation === undefined || sheet === undefined) return undefined;
    if (format === 'xlsx') {
        const parts = observation.xlsxStructure?.parts;
        const worksheetPartDigest = parts?.worksheetPartDigests[sheet_index];
        if (parts === undefined || worksheetPartDigest === undefined || worksheetPartDigest === null) {
            return undefined;
        }
        return Object.freeze({
            kind: 'xlsx',
            worksheetPartDigest,
            sharedStringsDigest: parts.sharedStringsDigest,
            stylesDigest: parts.stylesDigest,
            workbookDigest: parts.workbookDigest,
            sourceRowCount: sheet.sourceRowCount,
            sourceColumnCount: sheet.columnCount,
            bodyStart: header_body_start(sheet.excelFirstRowHeader),
        });
    }
    if (format !== 'csv' && format !== 'tsv') return undefined;
    const { byteLength, digest } = observation;
    if (byteLength === undefined || !Number.isSafeInteger(byteLength) || byteLength < 0) {
        return undefined;
    }
    return Object.freeze({
        kind: 'delimited',
        byteLength,
        digest,
        sourceRowCount: sheet.sourceRowCount,
        sourceColumnCount: sheet.columnCount,
    });
}

const SUPPORTED = Object.freeze({ supported: true as const });

function unsupported(reason: string): WorksheetStructuralSupport {
    const axis = Object.freeze({ supported: false as const, reason });
    return Object.freeze({ rows: axis, columns: axis });
}

/**
 * One axis of a scanned `.xlsx` worksheet, in the menus' words: `reason` for
 * Insert, Delete, and Restore ("Can't insert or delete rows on this sheet:
 * it contains an Excel table."), `moveReason` for Move.
 */
function xlsx_axis(axis: StructuralAxis, support: ScannedAxisSupport): StructuralAxisSupport {
    if (support.supported) return SUPPORTED;
    return Object.freeze({
        supported: false as const,
        reason: structural_refusal_message(axis, support.reason, 'insert-or-delete'),
        moveReason: structural_refusal_message(axis, support.reason, 'move'),
    });
}

/** The snapshot entry for one scanned `.xlsx` worksheet. */
export function xlsx_worksheet_support(
    scanned: ScannedWorksheetSupport,
    basis: StructuralBasis,
): WorksheetStructuralSupport {
    return Object.freeze({
        rows: xlsx_axis('rows', scanned.rows),
        columns: xlsx_axis('columns', scanned.columns),
        basis,
        merges: Object.freeze([...scanned.merges]),
        ...(scanned.autoFilter === undefined ? {} : {
            autoFilter: Object.freeze({
                ref: scanned.autoFilter.ref,
                filteredColumns: Object.freeze([...scanned.autoFilter.filteredColumns]),
            }),
        }),
        relativeRules: Object.freeze(scanned.relativeRules.map((rule) => Object.freeze({
            kind: rule.kind,
            sqref: rule.sqref,
            formulas: Object.freeze([...rule.formulas]),
        }))),
    });
}

/**
 * The snapshot capability for every worksheet, positionally matching
 * `sheets`. CSV and TSV support both axes, except columns on a source wider
 * than `MAX_SHEET_COLUMNS`. `.xlsx` reports the structural support scan's
 * answer per worksheet and axis. A sheet without a computable basis is
 * refused, since the host would refuse its first layout publication.
 */
export function structural_editing_capability(
    format: TableFormatId,
    observation: StructuralBasisObservation | undefined,
    sheets: readonly Pick<SheetMeta, 'sourceRowCount' | 'columnCount'>[],
    /** CSV and TSV: the shortest record's field count, per sheet. */
    shortest_row_widths?: readonly (number | undefined)[],
): StructuralEditingCapability {
    const scanned = observation?.xlsxStructure?.support;
    return Object.freeze({
        sheets: Object.freeze(sheets.map((sheet, sheet_index): WorksheetStructuralSupport => {
            const basis = current_structural_basis(format, observation, sheet, sheet_index);
            if (format === 'xlsx') {
                const support = scanned?.length === sheets.length ? scanned[sheet_index] : undefined;
                if (basis === undefined || support === undefined) {
                    return unsupported(observation?.xlsxStructure === undefined
                        ? STRUCTURE_NOT_AVAILABLE_YET
                        : XLSX_STRUCTURE_UNREADABLE_MESSAGE);
                }
                return xlsx_worksheet_support(support, basis);
            }
            if (basis === undefined) return unsupported(STRUCTURE_NOT_AVAILABLE_YET);
            const columns = sheet.columnCount > MAX_SHEET_COLUMNS
                ? Object.freeze({ supported: false as const, reason: TOO_WIDE_TO_RESTRUCTURE_MESSAGE })
                : SUPPORTED;
            const shortest = shortest_row_widths?.[sheet_index];
            return Object.freeze({
                rows: SUPPORTED,
                columns,
                basis,
                ...(shortest === undefined ? {} : { shortestRowWidth: shortest }),
            });
        })),
    });
}
