/**
 * Routing for host-issued edit commands (`editCommand` HostMessages).
 *
 * The desktop app's native Edit menu owns Cmd/Ctrl+C and Cmd/Ctrl+A: on macOS
 * an application-menu key equivalent is consumed before the page ever sees the
 * keystroke, so Glide's built-in copy/select-all can never run while those menu
 * items exist. The menu therefore forwards the intent here instead, and the
 * webview decides what "copy" and "select all" mean for whatever currently has
 * focus — the CSV cell editor's text field, or the canvas grid.
 *
 * The VS Code extension never sends these messages (its webview is not behind a
 * native menu), so this path is desktop-only but lives with the rest of the
 * webview logic. Pure except for the small DOM helpers, so the routing rule is
 * unit-testable.
 *
 * Undo and redo take the same route for the same reason, and one that matters
 * more: Cmd/Ctrl+Z inside an open cell editor must remain the browser's own text
 * undo. The OS consumes the accelerator before the page sees it, so the ONLY
 * thing that can tell a text undo from a workbook undo is this focus check,
 * running when the command arrives.
 */

export type EditCommand = 'copy' | 'selectAll' | 'undo' | 'redo';

/** Where an edit command should be applied. */
export type EditCommandTarget = 'text' | 'grid';

/** A focused text field owns the command; anything else falls through to the
 *  grid, which is the canvas the user is almost always looking at. */
export function edit_command_target(active: Element | null): EditCommandTarget {
    if (active instanceof HTMLTextAreaElement) return 'text';
    if (active instanceof HTMLInputElement) return 'text';
    if (active instanceof HTMLElement && active.isContentEditable) return 'text';
    return 'grid';
}

/** The selected substring of a text field, or its whole value when the
 *  selection is empty (matching what a native Copy does for a focused field
 *  with a caret but no range). */
export function text_field_selection(
    field: HTMLInputElement | HTMLTextAreaElement,
): string {
    const { selectionStart, selectionEnd, value } = field;
    if (
        selectionStart === null
        || selectionEnd === null
        || selectionStart === selectionEnd
    ) return value;
    return value.slice(selectionStart, selectionEnd);
}

/**
 * Native text undo/redo for the focused editable element.
 *
 * `execCommand` rather than a synthetic keydown: dispatching a key event does
 * not drive the browser's own undo stack, so a synthetic one would do nothing at
 * all. Deprecated for most purposes and still the only way to reach that stack
 * from script.
 *
 * Best effort, and returns nothing on purpose. There is no fallback to make: the
 * whole point of routing here is that the workbook's history must NOT move for a
 * chord typed inside a cell editor, so a document that declines the command
 * leaves the text as it was and that is the correct outcome. An answer would only
 * advertise a branch no caller can act on.
 */
export function run_native_text_history(command: 'undo' | 'redo'): void {
    try {
        document.execCommand(command);
    } catch {
        // A document that refuses the command leaves the text alone, which is the
        // same outcome as an undo with nothing to undo.
    }
}

/** Just enough of a keyboard event to classify it, so the rule is pure. */
export interface HistoryHotkey {
    readonly key: string;
    readonly metaKey: boolean;
    readonly ctrlKey: boolean;
    readonly shiftKey: boolean;
    readonly altKey: boolean;
}

/**
 * The history command a keystroke asks for, in the VS Code webview.
 *
 * Not needed on the desktop, where the native menu's accelerator gets there
 * first — this is the extension host's webview, which sits behind no native Edit
 * menu of its own.
 *
 * Both platform conventions for redo are accepted regardless of which platform
 * this is running on: a webview cannot tell reliably, and a user who types the
 * other platform's chord means redo either way. `Alt` is rejected because it
 * makes a different chord, not a modified version of this one.
 */
export function history_hotkey_command(
    event: HistoryHotkey,
): 'undo' | 'redo' | undefined {
    if (event.altKey) return undefined;
    // Exactly one of them: Ctrl+Cmd+Z is not the undo chord on either platform.
    if (event.metaKey === event.ctrlKey) return undefined;
    const key = event.key.toLowerCase();
    if (key === 'z') return event.shiftKey ? 'redo' : 'undo';
    if (key === 'y') return event.shiftKey ? undefined : 'redo';
    return undefined;
}
