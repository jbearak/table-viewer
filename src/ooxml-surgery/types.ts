import type { CellHyperlink, CellTextStyle, RichTextRun } from '../cell-content';
import type { XlsxCellEdit, XlsxWriteOptions } from '../xlsx-cell-write';
import type { XlsxHyperlinkEdit } from '../xlsx-hyperlink-write';

/** One pure worksheet-part edit, independent of ZIP/package routing. */
export interface WorksheetEditRequest {
    readonly worksheet_xml: Uint8Array;
    readonly relationships_xml: string | null;
    readonly cell_edits: readonly XlsxCellEdit[];
    readonly hyperlink_edits?: readonly XlsxHyperlinkEdit[];
    readonly write_options: XlsxWriteOptions;
}

/** Replacement parts and package-level facts produced by one worksheet edit. */
export interface WorksheetEditResult {
    readonly worksheet_xml: Uint8Array;
    /** Replacement relationships text, or null when that part is unchanged. */
    readonly relationships_xml: string | null;
    /** True when an edit removed at least one worksheet formula. */
    readonly formula_removed: boolean;
    /** True when calcChain no longer describes the worksheet formulas. */
    readonly calculation_chain_stale: boolean;
}

export type {
    CellHyperlink,
    CellTextStyle,
    RichTextRun,
    XlsxCellEdit,
    XlsxHyperlinkEdit,
    XlsxWriteOptions,
};
