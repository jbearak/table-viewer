/** Public TypeScript boundary for the extraction planned under #240. */
export { apply_worksheet_edits } from './worksheet-edit';
export { OoxmlRefusalError, type OoxmlRefusalCode } from '../ooxml-refusal';
export {
    OOXML_CONFORMANCE_VERSION,
    OOXML_SURGERY_API_VERSION,
} from './version';
export type {
    CellHyperlink,
    CellTextStyle,
    RichTextRun,
    WorksheetEditRequest,
    WorksheetEditResult,
    XlsxCellEdit,
    XlsxHyperlinkEdit,
    XlsxWriteOptions,
} from './types';
