# Table Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a read-only VS Code extension that renders `.xlsx` and `.xls` files with merged cells, bold/italic, number formatting toggle, persistent UI state, and live reload.

**Architecture:** Custom readonly editor provider (like Sight) with two parser adapters (ExcelJS for `.xlsx`, SheetJS for `.xls`) normalizing to a shared `WorkbookData` model. React webview renders an HTML `<table>` with theme integration. State persisted in VS Code `globalState` keyed by file path.

**Tech Stack:** TypeScript, React 18, ExcelJS, SheetJS (xlsx), esbuild, VS Code Custom Editor API.

**Reference codebase:** `~/repos/sight/client/` — follow its patterns for custom editor registration, webview HTML generation, state persistence, and theme integration.

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `LICENSE`
- Create: `.gitignore`
- Create: `.vscodeignore`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "table-viewer",
  "displayName": "Table Viewer",
  "description": "Read-only viewer for Excel files with merged cells, formatting, and persistent UI state",
  "version": "0.1.0",
  "publisher": "jbearak",
  "license": "GPL-3.0",
  "author": "Jonathan Marc Bearak",
  "engines": {
    "vscode": "^1.75.0"
  },
  "categories": ["Other"],
  "activationEvents": [],
  "main": "./dist/extension.js",
  "contributes": {
    "customEditors": [
      {
        "viewType": "tableViewer.editor",
        "displayName": "Table Viewer",
        "selector": [
          { "filenamePattern": "*.xlsx" },
          { "filenamePattern": "*.XLSX" },
          { "filenamePattern": "*.xls" },
          { "filenamePattern": "*.XLS" }
        ],
        "priority": "default"
      }
    ],
    "configuration": {
      "title": "Table Viewer",
      "properties": {
        "tableViewer.tabOrientation": {
          "type": "string",
          "enum": ["horizontal", "vertical"],
          "default": "horizontal",
          "description": "Default worksheet tab orientation. Can be overridden per file."
        }
      }
    }
  },
  "scripts": {
    "vscode:prepublish": "npm run bundle && npm run bundle:webview",
    "bundle": "esbuild src/extension.ts --bundle --outfile=dist/extension.js --external:vscode --platform=node --format=cjs --minify",
    "bundle:webview": "esbuild src/webview/index.tsx --bundle --outfile=dist/webview/index.js --platform=browser --format=iife --loader:.css=css --minify",
    "watch": "tsc -watch -p ./",
    "package": "vsce package --no-dependencies"
  },
  "dependencies": {
    "exceljs": "^4.4.0",
    "xlsx": "^0.18.5",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/node": "^18.19.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@types/vscode": "^1.75.0",
    "esbuild": "^0.21.0",
    "typescript": "^5.4.0",
    "@vscode/vsce": "^2.26.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022", "DOM"],
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "dist",
    "rootDir": "src",
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": true,
    "types": ["vscode", "node"]
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create `LICENSE`**

Copy the GPL-3.0 license text. Use the same license file as Sight (`~/repos/sight/client/LICENSE`):

```bash
cp ~/repos/sight/client/LICENSE ./LICENSE
```

- [ ] **Step 4: Create `.gitignore`**

```
node_modules/
dist/
*.vsix
.superpowers/
```

- [ ] **Step 5: Create `.vscodeignore`**

```
src/**
node_modules/**
tsconfig.json
.gitignore
.superpowers/**
docs/**
```

- [ ] **Step 6: Install dependencies**

Run: `npm install`
Expected: `node_modules/` created, `package-lock.json` generated.

- [ ] **Step 7: Verify build tooling works**

Run: `npx tsc --noEmit`
Expected: No errors (no source files yet, should exit cleanly).

- [ ] **Step 8: Commit**

```bash
git add package.json tsconfig.json LICENSE .gitignore .vscodeignore package-lock.json
git commit -m "scaffold: project structure with dependencies"
```

---

### Task 2: Shared Types

**Files:**
- Create: `src/types.ts`

- [ ] **Step 1: Create `src/types.ts`**

```typescript
export interface WorkbookData {
    sheets: SheetData[];
}

export interface SheetData {
    name: string;
    rows: (CellData | null)[][];
    merges: MergeRange[];
    columnCount: number;
    rowCount: number;
}

export interface CellData {
    raw: string | number | boolean | null;
    formatted: string;
    bold: boolean;
    italic: boolean;
}

export interface MergeRange {
    startRow: number;
    startCol: number;
    endRow: number;
    endCol: number;
}

export interface PerFileState {
    columnWidths?: Record<string, Record<number, number>>;
    rowHeights?: Record<string, Record<number, number>>;
    scrollPosition?: Record<string, { top: number; left: number }>;
    activeSheet?: string;
    tabOrientation?: 'horizontal' | 'vertical' | null;
}

/** Messages from extension host to webview */
export type HostMessage =
    | { type: 'workbookData'; data: WorkbookData; state: PerFileState; defaultTabOrientation: 'horizontal' | 'vertical' }
    | { type: 'reload'; data: WorkbookData };

/** Messages from webview to extension host */
export type WebviewMessage =
    | { type: 'ready' }
    | { type: 'stateChanged'; state: PerFileState };
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat: add shared type definitions"
```

---

### Task 3: XLSX Parser (ExcelJS)

**Files:**
- Create: `src/parse-xlsx.ts`

- [ ] **Step 1: Create `src/parse-xlsx.ts`**

```typescript
import ExcelJS from 'exceljs';
import type { WorkbookData, SheetData, CellData, MergeRange } from './types';

export async function parse_xlsx(buffer: Buffer): Promise<WorkbookData> {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);

    const sheets: SheetData[] = [];

    workbook.eachSheet((worksheet) => {
        const merges: MergeRange[] = [];
        const merged_cells = new Set<string>();

        // Collect merge ranges
        for (const [, model] of Object.entries(worksheet.model.merges ?? [])) {
            const range = parse_merge_range(model as string);
            if (!range) continue;
            merges.push(range);
            // Mark all cells in this range except the anchor
            for (let r = range.startRow; r <= range.endRow; r++) {
                for (let c = range.startCol; c <= range.endCol; c++) {
                    if (r === range.startRow && c === range.startCol) continue;
                    merged_cells.add(`${r}:${c}`);
                }
            }
        }

        const row_count = worksheet.rowCount;
        const col_count = worksheet.columnCount;
        const rows: (CellData | null)[][] = [];

        for (let r = 1; r <= row_count; r++) {
            const row_data: (CellData | null)[] = [];
            const ws_row = worksheet.getRow(r);

            for (let c = 1; c <= col_count; c++) {
                if (merged_cells.has(`${r}:${c}`)) {
                    row_data.push(null);
                    continue;
                }

                const cell = ws_row.getCell(c);
                row_data.push(extract_cell_data(cell));
            }

            rows.push(row_data);
        }

        sheets.push({
            name: worksheet.name,
            rows,
            merges,
            columnCount: col_count,
            rowCount: row_count,
        });
    });

    return { sheets };
}

function extract_cell_data(cell: ExcelJS.Cell): CellData {
    const font = cell.font ?? {};
    const bold = font.bold === true;
    const italic = font.italic === true;

    const raw = normalize_value(cell.value);
    const formatted = format_cell_value(cell);

    return { raw, formatted, bold, italic };
}

function normalize_value(value: ExcelJS.CellValue): string | number | boolean | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return value;
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (typeof value === 'object') {
        // ExcelJS rich text: { richText: [{ text: '...' }, ...] }
        if ('richText' in value && Array.isArray(value.richText)) {
            return value.richText.map((seg: { text: string }) => seg.text).join('');
        }
        // ExcelJS formula result
        if ('result' in value) {
            return normalize_value(value.result as ExcelJS.CellValue);
        }
        // ExcelJS error
        if ('error' in value) {
            return String(value.error);
        }
        // ExcelJS shared string
        if ('sharedString' in value) {
            return String(value.sharedString);
        }
    }
    return String(value);
}

function format_cell_value(cell: ExcelJS.Cell): string {
    // ExcelJS stores the formatted text in cell.text for simple values.
    // For rich text, cell.text concatenates segments.
    const text = cell.text;
    if (text !== undefined && text !== null && text !== '') {
        return text;
    }

    const raw = normalize_value(cell.value);
    if (raw === null) return '';
    return String(raw);
}

function parse_merge_range(range_str: string): MergeRange | null {
    // Format: "A1:C3" — decode column letters + row numbers
    const match = range_str.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
    if (!match) return null;

    return {
        startCol: col_letter_to_index(match[1]),
        startRow: parseInt(match[2], 10) - 1,
        endCol: col_letter_to_index(match[3]),
        endRow: parseInt(match[4], 10) - 1,
    };
}

function col_letter_to_index(letters: string): number {
    let index = 0;
    for (let i = 0; i < letters.length; i++) {
        index = index * 26 + (letters.charCodeAt(i) - 64);
    }
    return index - 1; // 0-based
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/parse-xlsx.ts
git commit -m "feat: add ExcelJS parser adapter for .xlsx files"
```

---

### Task 4: XLS Parser (SheetJS)

**Files:**
- Create: `src/parse-xls.ts`

- [ ] **Step 1: Create `src/parse-xls.ts`**

```typescript
import XLSX from 'xlsx';
import type { WorkbookData, SheetData, CellData, MergeRange } from './types';

export function parse_xls(buffer: Buffer): WorkbookData {
    const workbook = XLSX.read(buffer, {
        type: 'buffer',
        cellStyles: true,
        cellDates: true,
        cellNF: true,
    });

    const sheets: SheetData[] = [];

    for (const sheet_name of workbook.SheetNames) {
        const worksheet = workbook.Sheets[sheet_name];
        if (!worksheet) continue;

        const ref = worksheet['!ref'];
        if (!ref) {
            sheets.push({
                name: sheet_name,
                rows: [],
                merges: [],
                columnCount: 0,
                rowCount: 0,
            });
            continue;
        }

        const range = XLSX.utils.decode_range(ref);
        const row_count = range.e.r - range.s.r + 1;
        const col_count = range.e.c - range.s.c + 1;

        // Collect merge ranges
        const merges: MergeRange[] = [];
        const merged_cells = new Set<string>();

        for (const merge of worksheet['!merges'] ?? []) {
            const m: MergeRange = {
                startRow: merge.s.r - range.s.r,
                startCol: merge.s.c - range.s.c,
                endRow: merge.e.r - range.s.r,
                endCol: merge.e.c - range.s.c,
            };
            merges.push(m);
            for (let r = m.startRow; r <= m.endRow; r++) {
                for (let c = m.startCol; c <= m.endCol; c++) {
                    if (r === m.startRow && c === m.startCol) continue;
                    merged_cells.add(`${r}:${c}`);
                }
            }
        }

        const rows: (CellData | null)[][] = [];

        for (let r = 0; r < row_count; r++) {
            const row_data: (CellData | null)[] = [];
            for (let c = 0; c < col_count; c++) {
                if (merged_cells.has(`${r}:${c}`)) {
                    row_data.push(null);
                    continue;
                }

                const cell_addr = XLSX.utils.encode_cell({
                    r: r + range.s.r,
                    c: c + range.s.c,
                });
                const cell = worksheet[cell_addr];
                row_data.push(extract_cell_data(cell));
            }
            rows.push(row_data);
        }

        sheets.push({
            name: sheet_name,
            rows,
            merges,
            columnCount: col_count,
            rowCount: row_count,
        });
    }

    return { sheets };
}

function extract_cell_data(cell: XLSX.CellObject | undefined): CellData {
    if (!cell) {
        return { raw: null, formatted: '', bold: false, italic: false };
    }

    const raw = normalize_value(cell);
    const formatted = cell.w ?? (raw !== null ? String(raw) : '');

    // SheetJS community edition has limited style access
    const style = cell.s as { font?: { bold?: boolean; italic?: boolean } } | undefined;
    const bold = style?.font?.bold === true;
    const italic = style?.font?.italic === true;

    return { raw, formatted, bold, italic };
}

function normalize_value(cell: XLSX.CellObject): string | number | boolean | null {
    if (cell.v === null || cell.v === undefined) return null;
    if (cell.t === 'n') return cell.v as number;
    if (cell.t === 'b') return cell.v as boolean;
    if (cell.t === 'd' && cell.v instanceof Date) return cell.v.toISOString();
    if (cell.t === 'e') return String(cell.w ?? cell.v);
    return String(cell.v);
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/parse-xls.ts
git commit -m "feat: add SheetJS parser adapter for .xls files"
```

---

### Task 5: State Persistence

**Files:**
- Create: `src/state.ts`

- [ ] **Step 1: Create `src/state.ts`**

```typescript
import type { ExtensionContext } from 'vscode';
import type { PerFileState } from './types';

const STATE_KEY = 'tableViewer.fileState';
const MAX_STORED_FILES = 10_000;

type StoredStateMap = Record<string, PerFileState>;

export interface FileStateStore {
    get(file_path: string): PerFileState;
    set(file_path: string, state: PerFileState): Promise<void>;
}

function get_all_state(
    context: ExtensionContext
): StoredStateMap {
    const stored = context.globalState.get<unknown>(STATE_KEY, {});
    if (!stored || typeof stored !== 'object') return {};
    return stored as StoredStateMap;
}

function evict_excess(
    map: StoredStateMap,
    max: number
): void {
    const keys = Object.keys(map);
    const evict_count = keys.length - max;
    for (let i = 0; i < evict_count; i++) {
        delete map[keys[i]];
    }
}

export function create_file_state_store(
    context: ExtensionContext
): FileStateStore {
    let pending_write: Promise<void> = Promise.resolve();

    return {
        get(file_path: string): PerFileState {
            const all = get_all_state(context);
            return all[file_path] ?? {};
        },

        async set(
            file_path: string,
            state: PerFileState
        ): Promise<void> {
            pending_write = pending_write
                .catch(() => {})
                .then(async () => {
                    const all = get_all_state(context);

                    // LRU touch: delete before reinserting
                    delete all[file_path];
                    all[file_path] = state;

                    evict_excess(all, MAX_STORED_FILES);

                    await context.globalState.update(
                        STATE_KEY,
                        all
                    );
                });
            await pending_write;
        },
    };
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/state.ts
git commit -m "feat: add globalState persistence with LRU eviction"
```

---

### Task 6: Webview HTML Shell

**Files:**
- Create: `src/webview-html.ts`

- [ ] **Step 1: Create `src/webview-html.ts`**

Follow Sight's `webview-html.ts` pattern exactly:

```typescript
import * as crypto from 'crypto';
import * as vscode from 'vscode';

export function generate_nonce(): string {
    return crypto.randomBytes(16).toString('hex');
}

export function build_webview_html(
    webview: vscode.Webview,
    extension_uri: vscode.Uri,
    nonce: string
): string {
    const js_uri = webview.asWebviewUri(
        vscode.Uri.joinPath(
            extension_uri,
            'dist',
            'webview',
            'index.js'
        )
    );
    const css_uri = webview.asWebviewUri(
        vscode.Uri.joinPath(
            extension_uri,
            'dist',
            'webview',
            'index.css'
        )
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none';
               style-src ${webview.cspSource} 'nonce-${nonce}';
               script-src 'nonce-${nonce}';
               font-src ${webview.cspSource};">
<title>Table Viewer</title>
<link nonce="${nonce}" rel="stylesheet" href="${css_uri}">
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${js_uri}"></script>
</body>
</html>`;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/webview-html.ts
git commit -m "feat: add webview HTML shell generator"
```

---

### Task 7: Custom Editor Provider & Viewer Panel

**Files:**
- Create: `src/custom-editor.ts`

- [ ] **Step 1: Create `src/custom-editor.ts`**

```typescript
import * as vscode from 'vscode';
import * as fs from 'fs';
import { parse_xlsx } from './parse-xlsx';
import { parse_xls } from './parse-xls';
import type { FileStateStore } from './state';
import type { WorkbookData, PerFileState, WebviewMessage } from './types';
import { build_webview_html, generate_nonce } from './webview-html';

export const VIEW_TYPE = 'tableViewer.editor';

class TableViewerDocument implements vscode.CustomDocument {
    constructor(public readonly uri: vscode.Uri) {}
    dispose(): void {}
}

export class TableViewerEditorProvider
    implements vscode.CustomReadonlyEditorProvider<TableViewerDocument> {

    constructor(
        private readonly extension_uri: vscode.Uri,
        private readonly state_store: FileStateStore
    ) {}

    async openCustomDocument(
        uri: vscode.Uri
    ): Promise<TableViewerDocument> {
        return new TableViewerDocument(uri);
    }

    async resolveCustomEditor(
        document: TableViewerDocument,
        webview_panel: vscode.WebviewPanel
    ): Promise<void> {
        webview_panel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(
                    this.extension_uri,
                    'dist',
                    'webview'
                ),
            ],
        };

        const nonce = generate_nonce();
        webview_panel.webview.html = build_webview_html(
            webview_panel.webview,
            this.extension_uri,
            nonce
        );

        const panel = new ViewerPanel(
            webview_panel,
            document.uri,
            this.state_store
        );

        webview_panel.onDidDispose(() => panel.dispose());
    }
}

class ViewerPanel implements vscode.Disposable {
    private disposables: vscode.Disposable[] = [];
    private file_path: string;
    private watcher: vscode.FileSystemWatcher;

    constructor(
        private readonly panel: vscode.WebviewPanel,
        private readonly uri: vscode.Uri,
        private readonly state_store: FileStateStore
    ) {
        this.file_path = uri.fsPath;

        this.disposables.push(
            panel.webview.onDidReceiveMessage(
                (msg: WebviewMessage) => this.handle_message(msg)
            )
        );

        // Live reload: watch for file changes
        this.watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(uri, '*')
        );

        // The pattern above matches all files in the directory.
        // Filter to our specific file in the handler.
        const on_file_change = async (changed_uri: vscode.Uri) => {
            if (changed_uri.fsPath === this.file_path) {
                await this.send_reload();
            }
        };

        this.disposables.push(
            this.watcher.onDidChange(on_file_change)
        );
        this.disposables.push(
            this.watcher.onDidCreate(on_file_change)
        );
        this.disposables.push(this.watcher);
    }

    dispose(): void {
        for (const d of this.disposables) {
            d.dispose();
        }
    }

    private async handle_message(msg: WebviewMessage): Promise<void> {
        switch (msg.type) {
            case 'ready':
                await this.send_initial_data();
                break;
            case 'stateChanged':
                await this.state_store.set(
                    this.file_path,
                    msg.state
                );
                break;
        }
    }

    private async parse_file(): Promise<WorkbookData> {
        const buffer = Buffer.from(
            await vscode.workspace.fs.readFile(this.uri)
        );
        const ext = this.file_path.toLowerCase();
        if (ext.endsWith('.xlsx')) {
            return parse_xlsx(buffer);
        }
        return parse_xls(buffer);
    }

    private async send_initial_data(): Promise<void> {
        try {
            const data = await this.parse_file();
            const state = this.state_store.get(this.file_path);
            const config = vscode.workspace.getConfiguration('tableViewer');
            const default_orientation = config.get<'horizontal' | 'vertical'>(
                'tabOrientation',
                'horizontal'
            );

            this.panel.webview.postMessage({
                type: 'workbookData',
                data,
                state,
                defaultTabOrientation: default_orientation,
            });
        } catch (err) {
            vscode.window.showErrorMessage(
                `Failed to open file: ${err}`
            );
        }
    }

    private async send_reload(): Promise<void> {
        try {
            const data = await this.parse_file();
            this.panel.webview.postMessage({
                type: 'reload',
                data,
            });
        } catch {
            // File may be mid-write; ignore transient errors
        }
    }
}

export function register_table_viewer(
    context: vscode.ExtensionContext,
    state_store: FileStateStore
): void {
    context.subscriptions.push(
        vscode.window.registerCustomEditorProvider(
            VIEW_TYPE,
            new TableViewerEditorProvider(
                context.extensionUri,
                state_store
            ),
            { supportsMultipleEditorsPerDocument: true }
        )
    );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/custom-editor.ts
git commit -m "feat: add custom editor provider with file watcher"
```

---

### Task 8: Extension Entry Point

**Files:**
- Create: `src/extension.ts`

- [ ] **Step 1: Create `src/extension.ts`**

```typescript
import * as vscode from 'vscode';
import { register_table_viewer } from './custom-editor';
import { create_file_state_store } from './state';

export function activate(context: vscode.ExtensionContext): void {
    const state_store = create_file_state_store(context);
    register_table_viewer(context, state_store);
}

export function deactivate(): void {}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/extension.ts
git commit -m "feat: add extension entry point"
```

---

### Task 9: Webview — React Entry Point & Styles

**Files:**
- Create: `src/webview/index.tsx`
- Create: `src/webview/styles.css`

- [ ] **Step 1: Create `src/webview/index.tsx`**

```tsx
import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';

const container = document.getElementById('root');
if (!container) {
    throw new Error('Root element not found');
}

createRoot(container).render(<App />);
```

- [ ] **Step 2: Create `src/webview/styles.css`**

```css
*,
*::before,
*::after {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
}

html, body, #root {
    height: 100%;
    overflow: hidden;
    color-scheme: light dark;
}

body {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 13px;
    color: var(--vscode-editor-foreground, #ccc);
    background: var(--vscode-editor-background, #1e1e1e);
}

/* Layout */

.viewer {
    display: flex;
    flex-direction: column;
    height: 100%;
}

.viewer.vertical-tabs {
    flex-direction: column;
}

.viewer.vertical-tabs .content-area {
    display: flex;
    flex-direction: row;
    flex: 1;
    overflow: hidden;
}

/* Toolbar */

.toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    border-bottom: 1px solid var(--vscode-panel-border, #444);
    background: var(--vscode-editorGroupHeader-tabsBackground, #252526);
    flex-shrink: 0;
}

.toggle {
    padding: 3px 10px;
    border: 1px solid var(--vscode-panel-border, #444);
    border-radius: 3px;
    background: transparent;
    color: var(--vscode-foreground, #ccc);
    cursor: pointer;
    font-size: 12px;
    font-family: inherit;
}

.toggle:hover {
    background: var(--vscode-list-hoverBackground, #2a2d2e);
}

.toggle.active {
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
    border-color: var(--vscode-button-background, #0e639c);
}

/* Sheet Tabs — Horizontal */

.sheet-tabs-horizontal {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--vscode-panel-border, #444);
    background: var(--vscode-editorGroupHeader-tabsBackground, #252526);
    flex-shrink: 0;
    overflow-x: auto;
}

.sheet-tab {
    padding: 6px 14px;
    border-right: 1px solid var(--vscode-panel-border, #444);
    cursor: pointer;
    font-size: 12px;
    white-space: nowrap;
    color: var(--vscode-foreground, #ccc);
    opacity: 0.6;
    background: transparent;
    border-top: none;
    border-bottom: none;
    border-left: none;
    font-family: inherit;
}

.sheet-tab:hover {
    background: var(--vscode-list-hoverBackground, #2a2d2e);
    opacity: 1;
}

.sheet-tab.active {
    opacity: 1;
    background: var(--vscode-editor-background, #1e1e1e);
    font-weight: bold;
}

/* Sheet Tabs — Vertical */

.sheet-tabs-vertical {
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--vscode-panel-border, #444);
    background: var(--vscode-editorGroupHeader-tabsBackground, #252526);
    overflow-y: auto;
    flex-shrink: 0;
    min-width: 100px;
    max-width: 200px;
}

.sheet-tabs-vertical .sheet-tab {
    border-right: none;
    border-bottom: 1px solid var(--vscode-panel-border, #444);
    text-align: left;
}

/* Table Container */

.table-container {
    flex: 1;
    overflow: auto;
}

/* Table */

.data-table {
    border-collapse: collapse;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 13px;
}

.data-table td {
    border: 1px solid var(--vscode-panel-border, #444);
    padding: 3px 6px;
    white-space: pre-wrap;
    word-break: break-word;
    vertical-align: top;
    min-width: 40px;
}

/* Column resize handle */

.col-resize-handle {
    position: absolute;
    top: 0;
    right: 0;
    width: 5px;
    height: 100%;
    cursor: col-resize;
    z-index: 1;
}

.col-resize-handle:hover,
.col-resize-handle.dragging {
    background: var(--vscode-focusBorder, #007acc);
}

/* Row resize handle */

.row-resize-handle {
    position: absolute;
    bottom: 0;
    left: 0;
    width: 100%;
    height: 5px;
    cursor: row-resize;
    z-index: 1;
}

.row-resize-handle:hover,
.row-resize-handle.dragging {
    background: var(--vscode-focusBorder, #007acc);
}

/* Resizable cells need position:relative for handles */

.data-table td.resizable {
    position: relative;
}

/* First row cells get column resize handles */
.data-table tr:first-child td {
    position: relative;
}

/* Last column in each row gets row resize on parent */

/* Selection highlight */

.data-table td:focus {
    outline: 1px solid var(--vscode-focusBorder, #007acc);
    outline-offset: -1px;
}

/* Loading state */

.loading {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--vscode-foreground, #ccc);
    opacity: 0.6;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/webview/index.tsx src/webview/styles.css
git commit -m "feat: add webview entry point and theme-aware styles"
```

---

### Task 10: Webview — Toolbar Component

**Files:**
- Create: `src/webview/toolbar.tsx`

- [ ] **Step 1: Create `src/webview/toolbar.tsx`**

```tsx
import React from 'react';

interface ToolbarProps {
    show_formatting: boolean;
    on_toggle_formatting: () => void;
    vertical_tabs: boolean;
    on_toggle_tab_orientation: () => void;
}

export function Toolbar({
    show_formatting,
    on_toggle_formatting,
    vertical_tabs,
    on_toggle_tab_orientation,
}: ToolbarProps): React.JSX.Element {
    return (
        <div className="toolbar">
            <button
                className={`toggle ${show_formatting ? 'active' : ''}`}
                onClick={on_toggle_formatting}
                title={show_formatting ? 'Show raw values' : 'Show formatted values'}
            >
                Formatting
            </button>
            <button
                className={`toggle ${vertical_tabs ? 'active' : ''}`}
                onClick={on_toggle_tab_orientation}
                title={vertical_tabs ? 'Horizontal tabs' : 'Vertical tabs'}
            >
                Vertical Tabs
            </button>
        </div>
    );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/webview/toolbar.tsx
git commit -m "feat: add toolbar with formatting and tab orientation toggles"
```

---

### Task 11: Webview — Sheet Tabs Component

**Files:**
- Create: `src/webview/sheet-tabs.tsx`

- [ ] **Step 1: Create `src/webview/sheet-tabs.tsx`**

```tsx
import React from 'react';

interface SheetTabsProps {
    sheets: string[];
    active_sheet: string;
    on_select: (name: string) => void;
    vertical: boolean;
}

export function SheetTabs({
    sheets,
    active_sheet,
    on_select,
    vertical,
}: SheetTabsProps): React.JSX.Element {
    if (sheets.length <= 1) return <></>;

    const class_name = vertical
        ? 'sheet-tabs-vertical'
        : 'sheet-tabs-horizontal';

    return (
        <div className={class_name}>
            {sheets.map((name) => (
                <button
                    key={name}
                    className={`sheet-tab ${name === active_sheet ? 'active' : ''}`}
                    onClick={() => on_select(name)}
                >
                    {name}
                </button>
            ))}
        </div>
    );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/webview/sheet-tabs.tsx
git commit -m "feat: add sheet tabs with horizontal/vertical modes"
```

---

### Task 12: Webview — Table Renderer

**Files:**
- Create: `src/webview/table.tsx`

- [ ] **Step 1: Create `src/webview/table.tsx`**

This is the core rendering component — HTML table with merged cells, bold/italic, line breaks, column/row resizing.

```tsx
import React, { useCallback, useRef } from 'react';
import type { SheetData, CellData, MergeRange } from '../types';

interface TableProps {
    sheet: SheetData;
    show_formatting: boolean;
    column_widths: Record<number, number>;
    row_heights: Record<number, number>;
    on_column_resize: (col: number, width: number) => void;
    on_row_resize: (row: number, height: number) => void;
    scroll_ref: React.RefObject<HTMLDivElement | null>;
}

export function Table({
    sheet,
    show_formatting,
    column_widths,
    row_heights,
    on_column_resize,
    on_row_resize,
    scroll_ref,
}: TableProps): React.JSX.Element {
    const merge_map = build_merge_map(sheet.merges);

    return (
        <div className="table-container" ref={scroll_ref}>
            <table className="data-table">
                <tbody>
                    {sheet.rows.map((row, r) => (
                        <tr
                            key={r}
                            style={
                                row_heights[r]
                                    ? { height: `${row_heights[r]}px` }
                                    : undefined
                            }
                        >
                            {row.map((cell, c) => {
                                const key = `${r}:${c}`;
                                const merge_info = merge_map.get(key);

                                // Skip cells that are covered by a merge
                                if (merge_info === 'hidden') return null;

                                const span_props: {
                                    rowSpan?: number;
                                    colSpan?: number;
                                } = {};
                                if (
                                    merge_info
                                    && merge_info !== 'hidden'
                                ) {
                                    span_props.rowSpan =
                                        merge_info.rowSpan;
                                    span_props.colSpan =
                                        merge_info.colSpan;
                                }

                                return (
                                    <td
                                        key={c}
                                        {...span_props}
                                        style={
                                            column_widths[c]
                                                ? {
                                                      width: `${column_widths[c]}px`,
                                                      minWidth: `${column_widths[c]}px`,
                                                  }
                                                : undefined
                                        }
                                    >
                                        {r === 0 && (
                                            <ColumnResizeHandle
                                                col={c}
                                                on_resize={on_column_resize}
                                            />
                                        )}
                                        <CellContent
                                            cell={cell}
                                            show_formatting={show_formatting}
                                        />
                                    </td>
                                );
                            })}
                            <RowResizeHandle
                                row={r}
                                on_resize={on_row_resize}
                            />
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function CellContent({
    cell,
    show_formatting,
}: {
    cell: CellData | null;
    show_formatting: boolean;
}): React.JSX.Element {
    if (!cell) return <></>;

    const text = show_formatting
        ? cell.formatted
        : (cell.raw !== null ? String(cell.raw) : '');

    let content: React.ReactNode = text;

    if (cell.bold && cell.italic) {
        content = <b><i>{text}</i></b>;
    } else if (cell.bold) {
        content = <b>{text}</b>;
    } else if (cell.italic) {
        content = <i>{text}</i>;
    }

    return <>{content}</>;
}

interface ColumnResizeHandleProps {
    col: number;
    on_resize: (col: number, width: number) => void;
}

function ColumnResizeHandle({
    col,
    on_resize,
}: ColumnResizeHandleProps): React.JSX.Element {
    const dragging_ref = useRef(false);

    const handle_mouse_down = useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            dragging_ref.current = true;

            const start_x = e.clientX;
            const td = (e.target as HTMLElement).parentElement!;
            const start_width = td.offsetWidth;

            const handle_mouse_move = (move_e: MouseEvent) => {
                const new_width = Math.max(
                    40,
                    start_width + move_e.clientX - start_x
                );
                td.style.width = `${new_width}px`;
                td.style.minWidth = `${new_width}px`;
            };

            const handle_mouse_up = (up_e: MouseEvent) => {
                dragging_ref.current = false;
                document.removeEventListener('mousemove', handle_mouse_move);
                document.removeEventListener('mouseup', handle_mouse_up);
                const final_width = Math.max(
                    40,
                    start_width + up_e.clientX - start_x
                );
                on_resize(col, final_width);
            };

            document.addEventListener('mousemove', handle_mouse_move);
            document.addEventListener('mouseup', handle_mouse_up);
        },
        [col, on_resize]
    );

    return (
        <div
            className="col-resize-handle"
            onMouseDown={handle_mouse_down}
        />
    );
}

interface RowResizeHandleProps {
    row: number;
    on_resize: (row: number, height: number) => void;
}

function RowResizeHandle({
    row,
    on_resize,
}: RowResizeHandleProps): React.JSX.Element {
    const handle_mouse_down = useCallback(
        (e: React.MouseEvent) => {
            e.preventDefault();
            const tr = (e.target as HTMLElement).closest('tr')!;
            const start_y = e.clientY;
            const start_height = tr.offsetHeight;

            const handle_mouse_move = (move_e: MouseEvent) => {
                const new_height = Math.max(
                    20,
                    start_height + move_e.clientY - start_y
                );
                tr.style.height = `${new_height}px`;
            };

            const handle_mouse_up = (up_e: MouseEvent) => {
                document.removeEventListener('mousemove', handle_mouse_move);
                document.removeEventListener('mouseup', handle_mouse_up);
                const final_height = Math.max(
                    20,
                    start_height + up_e.clientY - start_y
                );
                on_resize(row, final_height);
            };

            document.addEventListener('mousemove', handle_mouse_move);
            document.addEventListener('mouseup', handle_mouse_up);
        },
        [row, on_resize]
    );

    return (
        <td style={{ padding: 0, width: 0, border: 'none', position: 'relative' }}>
            <div
                className="row-resize-handle"
                onMouseDown={handle_mouse_down}
            />
        </td>
    );
}

type MergeMapEntry =
    | 'hidden'
    | { rowSpan: number; colSpan: number };

function build_merge_map(
    merges: MergeRange[]
): Map<string, MergeMapEntry> {
    const map = new Map<string, MergeMapEntry>();

    for (const m of merges) {
        // Anchor cell gets span attributes
        map.set(`${m.startRow}:${m.startCol}`, {
            rowSpan: m.endRow - m.startRow + 1,
            colSpan: m.endCol - m.startCol + 1,
        });

        // All other cells in the range are hidden
        for (let r = m.startRow; r <= m.endRow; r++) {
            for (let c = m.startCol; c <= m.endCol; c++) {
                if (r === m.startRow && c === m.startCol) continue;
                map.set(`${r}:${c}`, 'hidden');
            }
        }
    }

    return map;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/webview/table.tsx
git commit -m "feat: add HTML table renderer with merges, formatting, and resize"
```

---

### Task 13: Webview — State Sync Hook

**Files:**
- Create: `src/webview/use-state-sync.ts`

- [ ] **Step 1: Create `src/webview/use-state-sync.ts`**

```typescript
import { useRef, useCallback } from 'react';
import type { PerFileState } from '../types';

declare function acquireVsCodeApi(): {
    postMessage(msg: unknown): void;
    getState(): unknown;
    setState(state: unknown): void;
};

export const vscode_api = acquireVsCodeApi();

const DEBOUNCE_MS = 150;

export function use_state_sync(
    current_state: React.MutableRefObject<PerFileState>
) {
    const timer_ref = useRef<ReturnType<typeof setTimeout> | null>(null);

    const persist = useCallback(() => {
        vscode_api.postMessage({
            type: 'stateChanged',
            state: current_state.current,
        });
    }, [current_state]);

    const persist_debounced = useCallback(() => {
        if (timer_ref.current) {
            clearTimeout(timer_ref.current);
        }
        timer_ref.current = setTimeout(persist, DEBOUNCE_MS);
    }, [persist]);

    const persist_immediate = useCallback(() => {
        if (timer_ref.current) {
            clearTimeout(timer_ref.current);
            timer_ref.current = null;
        }
        persist();
    }, [persist]);

    return { persist_debounced, persist_immediate };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/webview/use-state-sync.ts
git commit -m "feat: add debounced state sync hook for webview"
```

---

### Task 14: Webview — Main App Component

**Files:**
- Create: `src/webview/app.tsx`

- [ ] **Step 1: Create `src/webview/app.tsx`**

```tsx
import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { WorkbookData, PerFileState, HostMessage } from '../types';
import { Toolbar } from './toolbar';
import { SheetTabs } from './sheet-tabs';
import { Table } from './table';
import { vscode_api, use_state_sync } from './use-state-sync';
import './styles.css';

export function App(): React.JSX.Element {
    const [workbook, set_workbook] = useState<WorkbookData | null>(null);
    const [active_sheet, set_active_sheet] = useState<string>('');
    const [show_formatting, set_show_formatting] = useState(true);
    const [vertical_tabs, set_vertical_tabs] = useState(false);
    const [column_widths, set_column_widths] = useState<
        Record<string, Record<number, number>>
    >({});
    const [row_heights, set_row_heights] = useState<
        Record<string, Record<number, number>>
    >({});

    const scroll_ref = useRef<HTMLDivElement | null>(null);
    const state_ref = useRef<PerFileState>({});
    const scroll_positions_ref = useRef<
        Record<string, { top: number; left: number }>
    >({});

    const { persist_debounced, persist_immediate } =
        use_state_sync(state_ref);

    // Listen for messages from extension host
    useEffect(() => {
        const handler = (event: MessageEvent) => {
            const msg = event.data as HostMessage;

            if (msg.type === 'workbookData') {
                set_workbook(msg.data);

                // Restore persisted state
                const s = msg.state;
                const first_sheet =
                    msg.data.sheets[0]?.name ?? '';
                const sheet_name = s.activeSheet ?? first_sheet;
                set_active_sheet(sheet_name);
                set_column_widths(s.columnWidths ?? {});
                set_row_heights(s.rowHeights ?? {});
                scroll_positions_ref.current =
                    s.scrollPosition ?? {};

                const tab_orient =
                    s.tabOrientation ?? null;
                set_vertical_tabs(
                    tab_orient !== null
                        ? tab_orient === 'vertical'
                        : msg.defaultTabOrientation === 'vertical'
                );

                state_ref.current = s;

                // Restore scroll after render
                requestAnimationFrame(() => {
                    const pos =
                        scroll_positions_ref.current[sheet_name];
                    if (pos && scroll_ref.current) {
                        scroll_ref.current.scrollTop = pos.top;
                        scroll_ref.current.scrollLeft = pos.left;
                    }
                });
            }

            if (msg.type === 'reload') {
                set_workbook(msg.data);

                // If active sheet was removed, fall back
                set_active_sheet((prev) => {
                    const names = msg.data.sheets.map(
                        (s) => s.name
                    );
                    if (names.includes(prev)) return prev;
                    return names[0] ?? '';
                });
            }
        };

        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, []);

    // Send ready message on mount
    useEffect(() => {
        vscode_api.postMessage({ type: 'ready' });
    }, []);

    // Scroll persistence
    useEffect(() => {
        const el = scroll_ref.current;
        if (!el) return;

        const on_scroll = () => {
            scroll_positions_ref.current[active_sheet] = {
                top: el.scrollTop,
                left: el.scrollLeft,
            };
            state_ref.current = {
                ...state_ref.current,
                scrollPosition: { ...scroll_positions_ref.current },
            };
            persist_debounced();
        };

        el.addEventListener('scroll', on_scroll, { passive: true });
        return () => el.removeEventListener('scroll', on_scroll);
    }, [active_sheet, persist_debounced]);

    const handle_sheet_select = useCallback(
        (name: string) => {
            // Save current scroll position before switching
            if (scroll_ref.current) {
                scroll_positions_ref.current[active_sheet] = {
                    top: scroll_ref.current.scrollTop,
                    left: scroll_ref.current.scrollLeft,
                };
            }

            set_active_sheet(name);
            state_ref.current = {
                ...state_ref.current,
                activeSheet: name,
                scrollPosition: { ...scroll_positions_ref.current },
            };
            persist_immediate();

            // Restore scroll for new sheet after render
            requestAnimationFrame(() => {
                const pos = scroll_positions_ref.current[name];
                if (pos && scroll_ref.current) {
                    scroll_ref.current.scrollTop = pos.top;
                    scroll_ref.current.scrollLeft = pos.left;
                } else if (scroll_ref.current) {
                    scroll_ref.current.scrollTop = 0;
                    scroll_ref.current.scrollLeft = 0;
                }
            });
        },
        [active_sheet, persist_immediate]
    );

    const handle_toggle_formatting = useCallback(() => {
        set_show_formatting((prev) => !prev);
    }, []);

    const handle_toggle_tab_orientation = useCallback(() => {
        set_vertical_tabs((prev) => {
            const next = !prev;
            state_ref.current = {
                ...state_ref.current,
                tabOrientation: next ? 'vertical' : 'horizontal',
            };
            persist_immediate();
            return next;
        });
    }, [persist_immediate]);

    const handle_column_resize = useCallback(
        (col: number, width: number) => {
            set_column_widths((prev) => {
                const sheet_widths = { ...(prev[active_sheet] ?? {}) };
                sheet_widths[col] = width;
                const next = { ...prev, [active_sheet]: sheet_widths };
                state_ref.current = {
                    ...state_ref.current,
                    columnWidths: next,
                };
                persist_immediate();
                return next;
            });
        },
        [active_sheet, persist_immediate]
    );

    const handle_row_resize = useCallback(
        (row: number, height: number) => {
            set_row_heights((prev) => {
                const sheet_heights = { ...(prev[active_sheet] ?? {}) };
                sheet_heights[row] = height;
                const next = { ...prev, [active_sheet]: sheet_heights };
                state_ref.current = {
                    ...state_ref.current,
                    rowHeights: next,
                };
                persist_immediate();
                return next;
            });
        },
        [active_sheet, persist_immediate]
    );

    if (!workbook) {
        return <div className="loading">Loading...</div>;
    }

    const current_sheet = workbook.sheets.find(
        (s) => s.name === active_sheet
    );

    if (!current_sheet) {
        return <div className="loading">No sheets found</div>;
    }

    const sheet_names = workbook.sheets.map((s) => s.name);

    return (
        <div className={`viewer ${vertical_tabs ? 'vertical-tabs' : ''}`}>
            <Toolbar
                show_formatting={show_formatting}
                on_toggle_formatting={handle_toggle_formatting}
                vertical_tabs={vertical_tabs}
                on_toggle_tab_orientation={
                    handle_toggle_tab_orientation
                }
            />
            {vertical_tabs ? (
                <div className="content-area">
                    <SheetTabs
                        sheets={sheet_names}
                        active_sheet={active_sheet}
                        on_select={handle_sheet_select}
                        vertical={true}
                    />
                    <Table
                        sheet={current_sheet}
                        show_formatting={show_formatting}
                        column_widths={
                            column_widths[active_sheet] ?? {}
                        }
                        row_heights={
                            row_heights[active_sheet] ?? {}
                        }
                        on_column_resize={handle_column_resize}
                        on_row_resize={handle_row_resize}
                        scroll_ref={scroll_ref}
                    />
                </div>
            ) : (
                <>
                    <SheetTabs
                        sheets={sheet_names}
                        active_sheet={active_sheet}
                        on_select={handle_sheet_select}
                        vertical={false}
                    />
                    <Table
                        sheet={current_sheet}
                        show_formatting={show_formatting}
                        column_widths={
                            column_widths[active_sheet] ?? {}
                        }
                        row_heights={
                            row_heights[active_sheet] ?? {}
                        }
                        on_column_resize={handle_column_resize}
                        on_row_resize={handle_row_resize}
                        scroll_ref={scroll_ref}
                    />
                </>
            )}
        </div>
    );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/webview/app.tsx
git commit -m "feat: add main app component with state management"
```

---

### Task 15: Build & Manual Test

**Files:**
- No new files; verify build and runtime

- [ ] **Step 1: Bundle the extension**

Run: `npm run bundle`
Expected: `dist/extension.js` created without errors.

- [ ] **Step 2: Bundle the webview**

Run: `npm run bundle:webview`
Expected: `dist/webview/index.js` and `dist/webview/index.css` created without errors.

- [ ] **Step 3: Manual smoke test**

1. Open VS Code in the `table-viewer` directory
2. Press F5 to launch Extension Development Host
3. Open any `.xlsx` file
4. Verify:
   - Table renders with cell data
   - Merged cells show correctly (rowspan/colspan)
   - Bold and italic cells are styled
   - Line breaks render within cells
   - Word wrap works (resize a column narrower — text should wrap)
   - Formatting toggle switches between formatted and raw values
   - Sheet tabs appear and switch between worksheets
   - Tab orientation toggle works (horizontal ↔ vertical)
   - Column resize works (drag right edge of first-row cells)
   - Row resize works (drag bottom edge of rows)
5. Close and reopen the file — verify column widths, row heights, scroll position, active sheet, and tab orientation are restored
6. Modify the `.xlsx` file externally — verify the viewer reloads automatically

- [ ] **Step 4: Fix any issues found during testing**

Address bugs found in smoke test. Re-bundle and re-test.

- [ ] **Step 5: Test with `.xls` file**

Open a `.xls` file and verify it renders correctly through the SheetJS parser path.

- [ ] **Step 6: Commit any fixes**

```bash
git add -A
git commit -m "fix: address issues from smoke testing"
```

---

### Task 16: Final Cleanup

**Files:**
- Possibly modify: `package.json` (version, description tweaks)

- [ ] **Step 1: Verify `.gitignore` covers all generated files**

Run: `git status`
Expected: No untracked generated files (dist/, node_modules/, etc.)

- [ ] **Step 2: Package the extension**

Run: `npm run package`
Expected: `table-viewer-0.1.0.vsix` created.

- [ ] **Step 3: Install and verify the packaged extension**

Run: `code --install-extension table-viewer-0.1.0.vsix`
Open a `.xlsx` file in a normal VS Code window (not Extension Development Host). Verify it works.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: final cleanup for v0.1.0"
```
