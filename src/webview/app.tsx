import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { PerFileState, HostMessage } from '../types';
import type { WorkbookMeta } from '../data-source/interface';
import { Toolbar } from './toolbar';
import { SheetTabs } from './sheet-tabs';
import { GridShell } from './grid-shell';
import {
    clamp_sheet_index,
    normalize_per_file_state,
    trim_sheet_state_array,
} from './sheet-state';
import { vscode_api, use_state_sync } from './use-state-sync';
import './styles.css';

const NOOP = (): void => {};

/**
 * Webview root (Phase C). Consumes the paginated `sheetMeta`/`metaReload`
 * protocol (structure only — cells stream in later via the row loader inside
 * {@link GridShell}) and mounts the Glide canvas grid keyed by sheet index so a
 * sheet switch remounts (and clears) the loader. Editing, selection, row
 * resize, and canvas-measured auto-fit are restored in Phases D/E; here the grid
 * is read-only plain text + bold/italic.
 */
export function App(): React.JSX.Element {
    const [meta, set_meta] = useState<WorkbookMeta | null>(null);
    const [generation, set_generation] = useState(0);
    // Bumped on every `sheetMeta` (a fresh document load — including the preview
    // pane reusing its panel for a different file). Folded into the GridShell key
    // so the row loader remounts clean; a new file can otherwise collide with the
    // previous one's generation (both start at 1) and surface stale cached pages.
    const [load_epoch, set_load_epoch] = useState(0);
    const [active_sheet_index, set_active_sheet_index] = useState(0);
    const [show_formatting, set_show_formatting] = useState(true);
    const [vertical_tabs, set_vertical_tabs] = useState(false);
    const [column_widths, set_column_widths] = useState<
        (Record<number, number> | undefined)[]
    >([]);
    const [auto_fit_active, set_auto_fit_active] = useState<boolean[]>([]);
    const [auto_fit_snapshot, set_auto_fit_snapshot] = useState<
        (Record<number, number> | undefined)[]
    >([]);
    const [truncation_message, set_truncation_message] = useState<string | null>(null);
    const [preview_mode, set_preview_mode] = useState(false);
    const [csv_editable, set_csv_editable] = useState(false);
    const [csv_editing_supported, set_csv_editing_supported] = useState(false);

    const state_ref = useRef<PerFileState>({});
    const auto_fit_active_ref = useRef<boolean[]>([]);
    const auto_fit_snapshot_ref = useRef<
        (Record<number, number> | undefined)[]
    >([]);

    const { persist_immediate } = use_state_sync(state_ref);

    useEffect(() => {
        auto_fit_active_ref.current = auto_fit_active;
    }, [auto_fit_active]);

    useEffect(() => {
        auto_fit_snapshot_ref.current = auto_fit_snapshot;
    }, [auto_fit_snapshot]);

    useEffect(() => {
        const handler = (event: MessageEvent) => {
            const msg = event.data as HostMessage;

            if (msg.type === 'sheetMeta') {
                set_meta(msg.meta);
                set_generation(msg.generation);
                set_load_epoch((n) => n + 1);
                auto_fit_active_ref.current = [];
                auto_fit_snapshot_ref.current = [];
                set_auto_fit_active([]);
                set_auto_fit_snapshot([]);
                const s = normalize_per_file_state(
                    msg.state,
                    msg.meta.sheets.map((sheet) => sheet.name)
                );
                set_active_sheet_index(s.activeSheetIndex ?? 0);
                set_column_widths(s.columnWidths ?? []);

                const tab_orient = s.tabOrientation ?? null;
                set_vertical_tabs(
                    tab_orient !== null
                        ? tab_orient === 'vertical'
                        : msg.defaultTabOrientation === 'vertical'
                );
                state_ref.current = s;
                set_truncation_message(msg.truncationMessage ?? null);
                set_preview_mode(msg.previewMode ?? false);
                set_csv_editable(msg.csvEditable ?? false);
                set_csv_editing_supported(msg.csvEditingSupported ?? false);
            }

            if (msg.type === 'metaReload') {
                set_meta(msg.meta);
                set_generation(msg.generation);
                auto_fit_active_ref.current = [];
                auto_fit_snapshot_ref.current = [];
                set_auto_fit_active([]);
                set_auto_fit_snapshot([]);
                const sheet_count = msg.meta.sheets.length;

                set_column_widths((prev) =>
                    trim_sheet_state_array(prev, sheet_count)
                );

                const next_active_sheet_index = clamp_sheet_index(
                    active_sheet_index,
                    sheet_count
                );
                set_active_sheet_index(next_active_sheet_index);

                state_ref.current = {
                    ...state_ref.current,
                    columnWidths: trim_sheet_state_array(
                        state_ref.current.columnWidths,
                        sheet_count
                    ),
                    rowHeights: trim_sheet_state_array(
                        state_ref.current.rowHeights,
                        sheet_count
                    ),
                    scrollPosition: trim_sheet_state_array(
                        state_ref.current.scrollPosition,
                        sheet_count
                    ),
                    activeSheetIndex: next_active_sheet_index,
                };
                set_truncation_message(msg.truncationMessage ?? null);
                if (msg.csvEditable !== undefined) {
                    set_csv_editable(msg.csvEditable);
                }
                if (msg.csvEditingSupported !== undefined) {
                    set_csv_editing_supported(msg.csvEditingSupported);
                }
                persist_immediate();
            }
        };

        window.addEventListener('message', handler);
        return () => window.removeEventListener('message', handler);
    }, [active_sheet_index, persist_immediate]);

    useEffect(() => {
        vscode_api.postMessage({ type: 'ready' });
    }, []);

    const handle_sheet_select = useCallback(
        (sheet_index: number) => {
            set_active_sheet_index(sheet_index);
            state_ref.current = {
                ...state_ref.current,
                activeSheetIndex: sheet_index,
            };
            persist_immediate();
        },
        [persist_immediate]
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

    const deactivate_auto_fit_for_sheet = useCallback((sheet_index: number) => {
        const is_active = auto_fit_active_ref.current[sheet_index];
        const has_snapshot =
            auto_fit_snapshot_ref.current[sheet_index] !== undefined;

        if (!is_active && !has_snapshot) return;

        if (is_active) {
            set_auto_fit_active((prev) => {
                if (!prev[sheet_index]) return prev;
                const next = [...prev];
                next[sheet_index] = false;
                auto_fit_active_ref.current = next;
                return next;
            });
        }

        if (has_snapshot) {
            set_auto_fit_snapshot((prev) => {
                if (prev[sheet_index] === undefined) return prev;
                const next = [...prev];
                next[sheet_index] = undefined;
                auto_fit_snapshot_ref.current = next;
                return next;
            });
        }
    }, []);

    const handle_column_resize = useCallback(
        (col: number, width: number) => {
            set_column_widths((prev) => {
                const next = [...prev];
                const sheet_widths = { ...(next[active_sheet_index] ?? {}) };
                sheet_widths[col] = width;
                next[active_sheet_index] = sheet_widths;
                state_ref.current = {
                    ...state_ref.current,
                    columnWidths: [...next],
                };
                persist_immediate();
                return next;
            });
            // Deactivate auto-fit if it was active (keep current widths, discard snapshot)
            deactivate_auto_fit_for_sheet(active_sheet_index);
        },
        [active_sheet_index, persist_immediate, deactivate_auto_fit_for_sheet]
    );

    const handle_toggle_auto_fit = useCallback(() => {
        if (auto_fit_active[active_sheet_index]) {
            // Deactivate: restore snapshotted widths.
            const snapshot = auto_fit_snapshot[active_sheet_index];
            set_column_widths((prev) => {
                const next = [...prev];
                next[active_sheet_index] = snapshot;
                state_ref.current = {
                    ...state_ref.current,
                    columnWidths: [...next],
                };
                persist_immediate();
                return next;
            });
            set_auto_fit_active((prev) => {
                const next = [...prev];
                next[active_sheet_index] = false;
                auto_fit_active_ref.current = next;
                return next;
            });
            set_auto_fit_snapshot((prev) => {
                const next = [...prev];
                next[active_sheet_index] = undefined;
                auto_fit_snapshot_ref.current = next;
                return next;
            });
        } else {
            // Activate: snapshot current widths. Canvas-measured auto-fit lands in
            // Phase E (offscreen measureText over loaded rows); for now this is a
            // state-only toggle so the toolbar control stays consistent.
            const current_widths = column_widths[active_sheet_index];
            set_auto_fit_snapshot((prev) => {
                const next = [...prev];
                next[active_sheet_index] = current_widths
                    ? { ...current_widths }
                    : undefined;
                auto_fit_snapshot_ref.current = next;
                return next;
            });
            set_auto_fit_active((prev) => {
                const next = [...prev];
                next[active_sheet_index] = true;
                auto_fit_active_ref.current = next;
                return next;
            });
        }
    }, [
        active_sheet_index,
        auto_fit_active,
        auto_fit_snapshot,
        column_widths,
        persist_immediate,
    ]);

    if (!meta) {
        return <div className="loading">Loading...</div>;
    }
    const current_sheet = meta.sheets[active_sheet_index];

    if (!current_sheet) {
        return <div className="loading">No sheets found</div>;
    }

    const sheet_names = meta.sheets.map((s) => s.name);
    const has_multiple_sheets = meta.sheets.length > 1;
    const effective_vertical_tabs = vertical_tabs && has_multiple_sheets;

    const grid = (
        <GridShell
            key={`${active_sheet_index}:${load_epoch}`}
            sheet_meta={current_sheet}
            sheet_index={active_sheet_index}
            generation={generation}
            show_formatting={show_formatting}
            column_widths={column_widths[active_sheet_index] ?? {}}
            on_column_resize={handle_column_resize}
            preview_mode={preview_mode}
        />
    );

    return (
        <div className={`viewer ${effective_vertical_tabs ? 'vertical-tabs' : ''}`}>
            <Toolbar
                show_formatting={show_formatting}
                on_toggle_formatting={handle_toggle_formatting}
                show_formatting_button={meta.hasFormatting}
                vertical_tabs={vertical_tabs}
                on_toggle_tab_orientation={handle_toggle_tab_orientation}
                show_vertical_tabs_button={has_multiple_sheets}
                auto_fit_active={auto_fit_active[active_sheet_index] ?? false}
                on_toggle_auto_fit={handle_toggle_auto_fit}
                edit_mode={false}
                is_dirty={false}
                on_toggle_edit_mode={NOOP}
                show_edit_button={false}
            />
            {truncation_message && (
                <div className="truncation-banner">{truncation_message}{csv_editing_supported && !csv_editable ? '. Editing is disabled for truncated files.' : ''}</div>
            )}
            {effective_vertical_tabs ? (
                <div className="content-area">
                    <SheetTabs
                        sheets={sheet_names}
                        active_sheet_index={active_sheet_index}
                        on_select={handle_sheet_select}
                        vertical={true}
                    />
                    {grid}
                </div>
            ) : (
                <>
                    <SheetTabs
                        sheets={sheet_names}
                        active_sheet_index={active_sheet_index}
                        on_select={handle_sheet_select}
                        vertical={false}
                    />
                    {grid}
                </>
            )}
        </div>
    );
}
