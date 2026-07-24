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
 */

export type EditCommand = 'copy' | 'selectAll';

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
