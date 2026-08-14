/**
 * The inspector's stylesheet, as a string.
 *
 * Kept in TypeScript rather than a `.css` file because the two hosts deliver it
 * differently — the desktop page inlines it, and the VS Code webview serves it
 * under a nonce — and a single exported constant is the only way both get the
 * same bytes without one of them drifting.
 *
 * Colours come from `--vscode-*` custom properties, which VS Code sets itself
 * and the desktop shell already injects for the viewer window. The fallbacks
 * exist so the page is still legible if a host sets neither.
 */
export const STATE_INSPECTOR_CSS = `
:root {
  color-scheme: light dark;
  --inspector-gap: 12px;
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
  font-size: var(--vscode-font-size, 13px);
  color: var(--vscode-foreground, #3b3b3b);
  background: var(--vscode-editor-background, #ffffff);
}
#root { display: flex; flex-direction: column; height: 100%; }

header {
  padding: 16px 20px 12px;
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
}
.heading-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
h1 { margin: 0; font-size: 1.15em; font-weight: 600; }
.header-refresh {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-left: auto;
  width: 24px;
  height: 24px;
  padding: 3px;
  border-color: transparent;
  background: transparent;
  color: var(--vscode-foreground, #3b3b3b);
}
.header-refresh:hover:not(:disabled) {
  background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.18));
}
.header-refresh svg {
  width: 17px;
  height: 17px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.header-refresh.loading svg { animation: inspector-refresh-spin 0.8s linear infinite; }
@keyframes inspector-refresh-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .header-refresh.loading svg { animation: none; }
}
.summary { color: var(--vscode-descriptionForeground, #717171); }
.explanation {
  margin: 6px 0 8px;
  max-width: 78ch;
  line-height: 1.45;
  color: var(--vscode-descriptionForeground, #717171);
}
.size-note {
  margin: 4px 0 0;
  max-width: 78ch;
  font-size: 0.9em;
  line-height: 1.45;
  color: var(--vscode-descriptionForeground, #717171);
}
.database-path {
  margin-top: 6px;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 0.9em;
  color: var(--vscode-descriptionForeground, #717171);
  word-break: break-all;
}

.toolbars {
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--inspector-gap);
  padding: 12px 20px;
}
.toolbar.view-controls {
  padding-top: 0;
}
.toolbar .spacer { flex: 1 1 auto; }
.filter-input { min-width: 180px; flex: 0 1 260px; }

button {
  font: inherit;
  padding: 4px 12px;
  border-radius: 4px;
  border: 1px solid var(--vscode-button-border, transparent);
  background: var(--vscode-button-secondaryBackground, #e4e6eb);
  color: var(--vscode-button-secondaryForeground, inherit);
  cursor: pointer;
}
button.primary {
  background: var(--vscode-button-background, #0078d4);
  color: var(--vscode-button-foreground, #ffffff);
}
button.danger {
  background: var(--vscode-inputValidation-errorBackground, #f2dede);
  color: var(--vscode-errorForeground, #a1260d);
  border-color: var(--vscode-inputValidation-errorBorder, #be1100);
}
button:disabled { opacity: 0.45; cursor: default; }
button:focus-visible, input:focus-visible {
  outline: 1px solid var(--vscode-focusBorder, #0078d4);
  outline-offset: 1px;
}

input[type="text"], input[type="number"] {
  font: inherit;
  padding: 3px 7px;
  border-radius: 4px;
  border: 1px solid var(--vscode-input-border, #cecece);
  background: var(--vscode-input-background, #ffffff);
  color: var(--vscode-input-foreground, inherit);
}
input[type="number"] { width: 64px; }
label { display: inline-flex; align-items: center; gap: 6px; }

button.chip { border-radius: 999px; }
/* Pressed = this chip's rows are what the table is showing. The accent colour
   marks view state, not danger: a chip never deletes anything. */
button.chip[aria-pressed="true"] {
  background: var(--vscode-button-background, #0078d4);
  color: var(--vscode-button-foreground, #ffffff);
}
.stale-editor { color: var(--vscode-descriptionForeground, #717171); }

.review-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--inspector-gap);
  padding: 8px 20px;
  border-top: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
  background: var(--vscode-editor-inactiveSelectionBackground, rgba(64, 128, 224, 0.12));
}
.review-bar[hidden] { display: none; }
.review-summary { font-variant-numeric: tabular-nums; }

.table-scroll { flex: 1 1 auto; overflow: auto; }
table { border-collapse: collapse; width: 100%; }
th, td {
  text-align: left;
  padding: 5px 10px;
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.2));
  white-space: nowrap;
}
th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--vscode-editor-background, #ffffff);
  font-weight: 600;
  cursor: pointer;
  user-select: none;
}
th[aria-sort="ascending"]::after { content: ' \\2191'; }
th[aria-sort="descending"]::after { content: ' \\2193'; }
td.numeric, th.numeric { text-align: right; font-variant-numeric: tabular-nums; }
td.path {
  white-space: normal;
  word-break: break-all;
  font-family: var(--vscode-editor-font-family, monospace);
  min-width: 240px;
}
tbody tr:hover { background: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.12)); }
tr.protected td.path { opacity: 0.75; }

.badge {
  display: inline-block;
  padding: 0 6px;
  border-radius: 8px;
  font-size: 0.85em;
  border: 1px solid currentColor;
}
.badge.unsaved { color: var(--vscode-editorWarning-foreground, #bf8803); }
.badge.open { color: var(--vscode-descriptionForeground, #717171); }
/* The informational hue, not the error one: a file the user moved or deleted
   themselves is the ordinary reason to clear an entry, not a fault. Red would
   also compete with the destructive buttons. This token is themed (it maps to
   each palette's info role), which a literal colour would not be. */
.badge.absent { color: var(--vscode-charts-blue, #3060c0); }

.empty, .status {
  padding: 24px 20px;
  color: var(--vscode-descriptionForeground, #717171);
}
.status-bar {
  padding: 8px 20px;
  border-top: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.35));
  min-height: 34px;
  color: var(--vscode-descriptionForeground, #717171);
}
.status-bar.error { color: var(--vscode-errorForeground, #a1260d); }

.scrim {
  position: fixed;
  inset: 0;
  /* Above the sticky table header, which has a z-index of its own and would
     otherwise paint over a confirmation asking about deleting unsaved work. */
  z-index: 10;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.dialog {
  max-width: 520px;
  width: 100%;
  max-height: 100%;
  overflow: auto;
  border-radius: 6px;
  padding: 20px;
  background: var(--vscode-editorWidget-background, var(--vscode-editor-background, #ffffff));
  border: 1px solid var(--vscode-widget-border, rgba(128, 128, 128, 0.35));
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
}
.dialog h2 { margin: 0 0 10px; font-size: 1.05em; }
.dialog p { margin: 0 0 10px; white-space: pre-wrap; }
.dialog .file-list {
  margin: 0 0 12px;
  padding: 8px 10px;
  max-height: 180px;
  overflow: auto;
  border-radius: 4px;
  background: var(--vscode-textCodeBlock-background, rgba(128, 128, 128, 0.12));
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: 0.92em;
}
.dialog .file-list div { word-break: break-all; padding: 1px 0; }
.dialog .actions { display: flex; justify-content: flex-end; gap: 8px; }
`;
