import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { GridCellKind, type GridCell } from './glide-data-grid';
import {
    apply_held_keys,
    editor_key_intent,
    insert_newline,
    type EditorCommitNavigation,
    type EditorKeyEvent,
    type EditorPlatform,
    type HeldKeysTarget,
} from './csv-cell-editor-model';
import { count_lines, has_line_break } from './line-breaks';
import type { RichCellData } from './rich-text-layout';

/** Glide movement delta: `[deltaCol, deltaRow]`, each clamped to -1/0/+1. */
type Movement = readonly [-1 | 0 | 1, -1 | 0 | 1];

/**
 * Props Glide passes to a `provideEditor` component (structural subset of
 * `ProvideEditorComponent<GridCell>`, which the package doesn't re-export).
 */
export interface CsvCellEditorProps {
    value: GridCell;
    onChange: (newValue: GridCell) => void;
    onFinishedEditing: (newValue?: GridCell, movement?: Movement) => boolean | void;
    onCommitNavigation?: (navigation: EditorCommitNavigation) => void;
    initialValue?: string;
    /**
     * Set while the editor is mounted to commit it as Enter, Tab, or Shift+Tab
     * would. The grid uses it for one of those keys typed before the editor
     * could open.
     */
    commitRef?: React.MutableRefObject<((navigation: EditorCommitNavigation) => void) | null>;
    /**
     * Keys typed for this editor before it could open. It opens as if they
     * had been typed into it.
     */
    heldKeys?: readonly EditorKeyEvent[];
}

// The caret keys of an input differ by platform: Chromium leaves the caret
// alone on Up and Down in a single line on Windows, and macOS moves by word
// with Alt and by line with Cmd.
const PLATFORM: EditorPlatform = typeof navigator === 'undefined' ? 'linux'
    : /^Mac/.test(navigator.platform) ? 'mac'
    : /^Win/.test(navigator.platform) ? 'windows'
    : 'linux';

/**
 * The editor's input as somewhere to apply held keys. The browser applies
 * its own caret rules through the document's selection, which follows the
 * focused input.
 */
function input_target(el: HTMLInputElement | HTMLTextAreaElement): HeldKeysTarget {
    return {
        read: () => ({
            text: el.value,
            start: el.selectionStart ?? el.value.length,
            end: el.selectionEnd ?? el.value.length,
        }),
        write: ({ text, start, end }) => {
            if (el.value !== text) {
                el.value = text;
                // A line per line, as the render after each key typed gives
                // it, so whether the text overflows is measured as it would be.
                if (el instanceof HTMLTextAreaElement) el.rows = count_lines(text);
            }
            el.setSelectionRange(start, end);
        },
        select: (moves) => {
            const selection = el.ownerDocument.getSelection();
            if (typeof selection?.modify !== 'function') return;
            for (const [alter, direction, granularity] of moves) selection.modify(alter, direction, granularity);
        },
        overflows: () => el.scrollHeight > el.clientHeight,
        holds_line_breaks: el instanceof HTMLTextAreaElement,
    };
}

function cell_text(cell: GridCell): string {
    if (cell.kind === GridCellKind.Text) return cell.data ?? '';
    if (cell.kind === GridCellKind.Custom) {
        return (cell.data as Partial<RichCellData>).edit_value ?? '';
    }
    return '';
}

function with_text(cell: GridCell, text: string): GridCell {
    if (cell.kind === GridCellKind.Custom) {
        return {
            ...cell,
            data: { ...(cell.data as RichCellData), edit_value: text },
        } as GridCell;
    }
    return { ...cell, data: text, displayData: text } as GridCell;
}

/**
 * Custom CSV editor overlay (Phase E). Glide portals this into
 * `.gdg-clip-region`; it reproduces the old DOM editor's keyboard contract via
 * {@link editor_key_intent}: Enter commits down, Tab/Shift+Tab commit for
 * forward/backward traversal, Shift/Alt+Enter inserts a newline (growing to a
 * textarea), Escape discards, and Cmd/Ctrl+S bubbles to the window save handler.
 * The grid shell
 * mirrors the committed value into the dirty map via onCellEdited.
 */
export function CsvCellEditor({
    value,
    onChange,
    onFinishedEditing,
    onCommitNavigation,
    initialValue,
    commitRef,
    heldKeys,
}: CsvCellEditorProps): React.JSX.Element {
    // Glide rewrites built-in Text cells with the type-to-edit seed before it
    // opens the overlay, but Custom cells are passed through unchanged. Rich
    // Markdown cells use Custom so the canvas can keep painting their runs;
    // prefer the explicit seed for both kinds to give them identical behavior.
    const initial = initialValue ?? cell_text(value);
    const [text, set_text] = useState(initial);
    const [is_multiline, set_is_multiline] = useState(has_line_break(initial));
    const input_ref = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
    const mounted_ref = useRef(false);
    const cursor_pos_ref = useRef<number | null>(null);
    // Held keys not yet applied, or null once the editor has applied them.
    const held_ref = useRef<readonly EditorKeyEvent[] | null>(heldKeys && heldKeys.length > 0 ? heldKeys : null);

    // A layout effect, so the held keys are applied before the grid that
    // opened this editor looks at it again, as it does to commit a held Enter.
    useLayoutEffect(() => {
        const el = input_ref.current;
        if (!el) return;
        el.focus();
        if (mounted_ref.current) {
            // Re-focus after switching <input> → <textarea>: restore the caret.
            const pos = cursor_pos_ref.current ?? el.value.length;
            el.setSelectionRange(pos, pos);
            cursor_pos_ref.current = null;
        } else {
            if (initialValue === undefined) {
                // Mouse/Enter activation starts with the existing cell selected.
                el.select();
            } else {
                // The initiating text is `initial` (for built-in Text Glide has
                // also placed it in `value`; for rich Custom it has not). Leave
                // it intact so the next character appends instead of replacing
                // it through the browser's selected-text behavior.
                el.setSelectionRange(el.value.length, el.value.length);
            }
            mounted_ref.current = true;
        }
        const held = held_ref.current;
        if (held === null) return;
        // Apply the keys typed before the editor could open to the input
        // itself, so the browser's own caret rules apply as they would have.
        const target = input_target(el);
        const applied = apply_held_keys(target, held, PLATFORM);
        if (applied < held.length) {
            // A line break, which only a textarea holds: switch, as Shift+Enter
            // does, and apply the rest there.
            const { start, end } = target.read();
            const { value: next, cursor } = insert_newline(el.value, start, end);
            held_ref.current = held.slice(applied + 1);
            cursor_pos_ref.current = cursor;
            set_text(next);
            set_is_multiline(true);
            return;
        }
        held_ref.current = null;
        if (el.value !== text) set_text(el.value);
        // Glide commits its own copy of the value on a click away.
        if (el.value !== initial) onChange(with_text(value, el.value));
    }, [is_multiline]);

    const commit = (navigation: EditorCommitNavigation) => {
        const live = input_ref.current?.value ?? text;
        // GridShell owns post-commit selection, including row wrapping. Glide only
        // commits the value and closes its overlay.
        if (onFinishedEditing(with_text(value, live), [0, 0]) === false) return;
        onCommitNavigation?.(navigation);
    };
    const commit_latest_ref = useRef(commit);
    commit_latest_ref.current = commit;
    useEffect(() => {
        if (!commitRef) return undefined;
        const handle = (navigation: EditorCommitNavigation) => commit_latest_ref.current(navigation);
        commitRef.current = handle;
        return () => {
            if (commitRef.current === handle) commitRef.current = null;
        };
    }, [commitRef]);

    const handle_key_down = (
        e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => {
        switch (editor_key_intent(e)) {
            case 'cancel':
                e.preventDefault();
                e.stopPropagation();
                onFinishedEditing(undefined);
                return;
            case 'commit-tab-forward':
                e.preventDefault();
                e.stopPropagation();
                commit('next');
                return;
            case 'commit-tab-backward':
                e.preventDefault();
                e.stopPropagation();
                commit('previous');
                return;
            case 'commit-down':
                e.preventDefault();
                e.stopPropagation();
                commit('below');
                return;
            case 'newline': {
                e.preventDefault();
                e.stopPropagation();
                const el = e.currentTarget;
                const start = el.selectionStart ?? el.value.length;
                const end = el.selectionEnd ?? start;
                const { value: next, cursor } = insert_newline(el.value, start, end);
                cursor_pos_ref.current = cursor;
                set_text(next);
                set_is_multiline(true);
                onChange(with_text(value, next));
                return;
            }
            case 'save':
                // Let Cmd/Ctrl+S bubble to the window-level save handler.
                return;
            default:
                // Keep the grid's own keyboard handlers from firing while typing.
                e.stopPropagation();
        }
    };

    const handle_change = (
        e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => {
        set_text(e.target.value);
        onChange(with_text(value, e.target.value));
    };

    const shared = {
        className: 'cell-editor-input',
        onKeyDown: handle_key_down,
        onChange: handle_change,
        value: text,
    };

    if (is_multiline) {
        return (
            <textarea
                ref={input_ref as React.RefObject<HTMLTextAreaElement>}
                rows={count_lines(text)}
                {...shared}
            />
        );
    }
    return (
        <input
            ref={input_ref as React.RefObject<HTMLInputElement>}
            type="text"
            {...shared}
        />
    );
}
