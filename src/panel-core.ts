import type { DataSource, RowWindow } from './data-source/interface';
import type { StoredPerFileState, WebviewMessage } from './types';

/**
 * Minimal structural view of the parts of vscode.WebviewPanel that the core
 * uses. Declared locally (rather than importing `vscode`) so the core stays a
 * pure module — unit-testable with a fake panel and no extension host.
 */
export interface PanelLike {
    webview: {
        postMessage(message: unknown): Thenable<boolean> | Promise<boolean> | boolean;
    };
}

/** Panel-specific fields bundled into each `sheetMeta` send. The panels own
 *  state/config; the core owns meta + generation + the page cache. */
export interface MetaEnvelope {
    state: StoredPerFileState;
    defaultTabOrientation: 'horizontal' | 'vertical';
    previewMode?: boolean;
    csvEditable?: boolean;
    csvEditingSupported?: boolean;
    /** Overrides the source's own truncationMessage when provided. */
    truncationMessage?: string;
}

export interface ReloadEnvelope {
    csvEditable?: boolean;
    csvEditingSupported?: boolean;
    truncationMessage?: string;
}

const DEFAULT_MAX_CACHED_PAGES = 64;

/**
 * Protocol engine shared by the xlsx/xls custom editor and the CSV panel.
 *
 * Owns:
 *  - a monotonic `generation` counter (bumped on every reload) so the webview
 *    can drop row windows belonging to a superseded document version;
 *  - an LRU cache of already-served row windows keyed by sheet/start/count;
 *  - the `requestRows` -> `rowData` handler with a generation guard and
 *    boundary validation.
 *
 * It does NOT own watchers, save/conflict flow, or vscode config — those stay
 * in the format-specific panels, which call `send_meta`/`send_meta_reload` and
 * forward webview messages to `handle_message`.
 */
export class ViewerPanelCore {
    private _generation = 1;
    private readonly cache = new Map<string, RowWindow>();
    private readonly max_cached_pages: number;

    constructor(
        private readonly panel: PanelLike,
        private source: DataSource,
        opts?: { maxCachedPages?: number },
    ) {
        this.max_cached_pages = opts?.maxCachedPages ?? DEFAULT_MAX_CACHED_PAGES;
    }

    get generation(): number {
        return this._generation;
    }

    /** Swap in a freshly-parsed source (reload) without sending a message. */
    set_source(source: DataSource): void {
        this.source = source;
    }

    /** Initial structure send. Generation is left as-is (a fresh panel starts
     *  at generation 1; subsequent reloads bump it via send_meta_reload). */
    async send_meta(envelope: MetaEnvelope): Promise<void> {
        await this.post({
            type: 'sheetMeta',
            meta: this.source.meta(),
            state: envelope.state,
            defaultTabOrientation: envelope.defaultTabOrientation,
            previewMode: envelope.previewMode,
            csvEditable: envelope.csvEditable,
            csvEditingSupported: envelope.csvEditingSupported,
            truncationMessage: envelope.truncationMessage ?? this.source.truncationMessage,
            generation: this._generation,
        });
    }

    /** Reload send: bump generation, drop cached windows, post metaReload. */
    async send_meta_reload(envelope?: ReloadEnvelope): Promise<boolean> {
        this._generation += 1;
        this.cache.clear();
        return this.post({
            type: 'metaReload',
            meta: this.source.meta(),
            csvEditable: envelope?.csvEditable,
            csvEditingSupported: envelope?.csvEditingSupported,
            truncationMessage: envelope?.truncationMessage ?? this.source.truncationMessage,
            generation: this._generation,
        });
    }

    /** Entry point for webview->host messages the core is responsible for. */
    async handle_message(msg: WebviewMessage): Promise<void> {
        if (msg.type === 'requestRows') {
            await this.handle_row_request(msg);
        }
    }

    private async handle_row_request(
        msg: Extract<WebviewMessage, { type: 'requestRows' }>,
    ): Promise<void> {
        // Generation guard: silently drop requests for a superseded version.
        if (msg.generation !== this._generation) return;

        // Boundary validation: clamp a negative startRow to 0. (CSV clamps
        // internally; xlsx/xls pass through to the store — validate here so the
        // contract is uniform regardless of source.)
        const start_row = Math.max(0, msg.startRow);

        const key = `${msg.sheetIndex}:${start_row}:${msg.count}`;
        let window = this.cache.get(key);
        if (window !== undefined) {
            // LRU touch: re-insert to mark most-recently-used.
            this.cache.delete(key);
            this.cache.set(key, window);
        } else {
            window = this.source.read_rows(msg.sheetIndex, start_row, msg.count);
            this.cache.set(key, window);
            this.evict_excess();
        }

        await this.post({
            type: 'rowData',
            sheetIndex: msg.sheetIndex,
            startRow: window.startRow,
            rows: window.rows,
            requestId: msg.requestId,
            generation: this._generation,
        });
    }

    private evict_excess(): void {
        while (this.cache.size > this.max_cached_pages) {
            // Map preserves insertion order; the first key is least-recently-used.
            const oldest = this.cache.keys().next().value;
            if (oldest === undefined) break;
            this.cache.delete(oldest);
        }
    }

    private post(message: unknown): Promise<boolean> {
        return Promise.resolve(this.panel.webview.postMessage(message));
    }
}
