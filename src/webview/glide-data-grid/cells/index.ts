import { type InnerGridCell } from "../internal/data-grid/data-grid-types.js";
import { booleanCellRenderer } from "./boolean-cell.js";
import type { InternalCellRenderer } from "./cell-types.js";
import { loadingCellRenderer } from "./loading-cell.js";
import { markerCellRenderer } from "./marker-cell.js";
import { newRowCellRenderer } from "./new-row-cell.js";
import { textCellRenderer } from "./text-cell.js";

// Trimmed from upstream: this fork keeps only the cell kinds Table Viewer
// renders (Text/Loading/Boolean plus the internal Marker/NewRow cells).
// Image, markdown, number, bubble, drilldown, uri and row-id renderers were
// dropped along with their dependencies (marked, react-number-format,
// react-responsive-carousel).
export const AllCellRenderers = [
    markerCellRenderer,
    newRowCellRenderer,
    booleanCellRenderer,
    loadingCellRenderer,
    textCellRenderer,
] as InternalCellRenderer<InnerGridCell>[];
