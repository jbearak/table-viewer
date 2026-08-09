import React, {
    forwardRef,
    useEffect,
    useImperativeHandle,
    useRef,
    useState,
} from 'react';
import { GridCellKind, type GridCell } from '@glideapps/glide-data-grid';
import { editor_key_intent, insert_newline } from './csv-cell-editor-model';

/** Glide movement delta: `[deltaCol, deltaRow]`, each clamped to -1/0/+1. */
type Movement = readonly [-1 | 0 | 1, -1 | 0 | 1];

/**
 * Props Glide passes to a `provideEditor` component (structural subset of
 * `ProvideEditorComponent<GridCell>`, which the package doesn't re-export).
 */
export interface CsvCellEditorProps {
    value: GridCell;
    onChange: (newValue: GridCell) => void;
    onFinishedEditing: (newValue?: GridCell, movement?: Movement) => void;
    onNativeCommand?: (command: 'save' | 'undo' | 'redo') => void;
}

export interface CsvCellEditorHandle {
    /** Replace browser-local overlay text without publishing another document edit. */
    replace_text(value: string): void;
}

function cell_text(cell: GridCell): string {
    return cell.kind === GridCellKind.Text ? cell.data ?? '' : '';
}

function with_text(cell: GridCell, text: string): GridCell {
    return { ...cell, data: text, displayData: text } as GridCell;
}

/**
 * Custom CSV editor overlay (Phase E). Glide portals this into
 * `.gdg-clip-region`; it reproduces the old DOM editor's keyboard contract via
 * {@link editor_key_intent}: Enter commits down, Tab/Shift+Tab commit
 * right/left, Shift/Alt+Enter inserts a newline (growing to a textarea), Escape
 * discards, Cmd/Ctrl+S bubbles to the window save handler, and Shift+S remains
 * native Save As. The grid shell mirrors the committed value into the dirty map
 * via onCellEdited.
 */
export const CsvCellEditor = forwardRef<CsvCellEditorHandle, CsvCellEditorProps>(
function CsvCellEditor({
    value,
    onChange,
    onFinishedEditing,
    onNativeCommand,
}, ref): React.JSX.Element {
    const initial = cell_text(value);
    const [text, set_text] = useState(initial);
    const [is_multiline, set_is_multiline] = useState(initial.includes('\n'));
    const input_ref = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
    const mounted_ref = useRef(false);
    const cursor_pos_ref = useRef<number | null>(null);

    useImperativeHandle(ref, () => ({
        replace_text(next) {
            // Keep the DOM authoritative immediately as well as scheduling React's
            // controlled-state update, so a following key event cannot commit the
            // stale browser value between patch delivery and the next render.
            if (input_ref.current) input_ref.current.value = next;
            cursor_pos_ref.current = null;
            set_text(next);
            set_is_multiline(next.includes('\n'));
        },
    }), []);

    useEffect(() => {
        const el = input_ref.current;
        if (!el) return;
        el.focus();
        if (mounted_ref.current) {
            // Re-focus after switching <input> → <textarea>: restore the caret.
            const pos = cursor_pos_ref.current ?? el.value.length;
            el.setSelectionRange(pos, pos);
            cursor_pos_ref.current = null;
        } else {
            // Initial mount: select all so a keystroke replaces the cell.
            el.select();
            mounted_ref.current = true;
        }
    }, [is_multiline]);

    const commit = (movement: Movement) => {
        const live = input_ref.current?.value ?? text;
        onFinishedEditing(with_text(value, live), movement);
    };

    const handle_key_down = (
        e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => {
        const intent = editor_key_intent(e);
        switch (intent) {
            case 'cancel':
                e.preventDefault();
                e.stopPropagation();
                onFinishedEditing(undefined);
                return;
            case 'commit-right':
                e.preventDefault();
                e.stopPropagation();
                commit([1, 0]);
                return;
            case 'commit-left':
                e.preventDefault();
                e.stopPropagation();
                commit([-1, 0]);
                return;
            case 'commit-down':
                e.preventDefault();
                e.stopPropagation();
                commit([0, 1]);
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
            case 'save-as':
                // The native host owns Save As. Leave both propagation and the
                // browser default untouched so the webview keybinding bridge sees it.
                return;
            case 'save':
                if (!onNativeCommand) {
                    // Self-managed editing uses the window-level save handler.
                    return;
                }
                // Native document lifecycle commands all close the optimistic overlay
                // before VS Code moves the savepoint or history cursor.
                e.preventDefault();
                e.stopPropagation();
                onFinishedEditing(with_text(
                    value,
                    input_ref.current?.value ?? text,
                ));
                onNativeCommand('save');
                return;
            case 'undo':
            case 'redo':
                if (onNativeCommand) {
                    // The CustomDocument owns history in VS Code mode. Commit and
                    // close Glide's optimistic overlay before asking VS Code to move
                    // document history, otherwise the focused input would consume the
                    // shortcut and retain stale browser-local text.
                    e.preventDefault();
                    e.stopPropagation();
                    onFinishedEditing(with_text(
                        value,
                        input_ref.current?.value ?? text,
                    ));
                    onNativeCommand(intent);
                    return;
                }
                // Self-managed desktop editing keeps the browser input's local history.
                e.stopPropagation();
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
                rows={text.split('\n').length}
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
});
