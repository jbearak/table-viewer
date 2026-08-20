// Public surface of the vendored glide-data-grid fork — deliberately narrow.
// Unlike upstream src/index.ts (a library entry point exporting every
// renderer and helper), this facade exports only what Table Viewer and the
// ported test suite consume: the DataEditor component, the grid type
// universe (data-grid-types), the mouse/key event types, and the theme.
// Internals stay importable by path for tests. See UPSTREAM.json.
export * from "./internal/data-grid/data-grid-types.js";
export type {
    CellClickedEventArgs,
    GridKeyEventArgs,
    GridMouseEventArgs,
    HeaderClickedEventArgs,
} from "./internal/data-grid/event-args.js";
export type { Theme, FullTheme } from "./common/styles.js";
export { getDataEditorTheme as getDefaultTheme } from "./common/styles.js";
// Custom-renderer surface: the renderer contract plus the text-metric helpers
// a renderer needs to draw consistently with the built-in text cell.
export type { CustomRenderer } from "./cells/cell-types.js";
export {
    clearTextMetricsCache,
    getTextMetricsGeneration,
    measureTextCached,
    getEmHeight,
    getMiddleCenterBias,
} from "./internal/data-grid/render/data-grid-lib.js";
export { direction } from "./common/utils.js";

export type { DataEditorRef } from "./data-editor/data-editor.js";
export { DataEditorAll as DataEditor } from "./data-editor-all.js";
export type { DataEditorAllProps as DataEditorProps } from "./data-editor-all.js";
