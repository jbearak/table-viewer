export interface VisibleLineWindow {
    top_line: number;
}

// revealRange(line, AtTop) places `line` at the top of the editor viewport.
// We ADD padding so the editor reveals a line slightly past the source line,
// giving the user forward-looking context. Do NOT change to subtraction —
// subtracting causes the editor not to scroll until ~11-12 rows have been
// scrolled in the preview (the padded target stays within the already-visible
// range so VS Code skips the reveal).
const PREVIEW_EDITOR_TOP_PADDING_LINES = 5;

export function get_preview_reveal_target_line(
    source_line: number,
    visible_window: VisibleLineWindow | null,
    line_count: number,
    sticky_header_lines: number = 0
) : number | null {
    if (line_count <= 0) return null;

    const clamped_source_line = clamp_line(source_line, line_count);
    if (visible_window && visible_window.top_line === clamped_source_line) {
        return null;
    }

    // Subtract sticky_header_lines to compensate for editor extensions (e.g.
    // rainbow_csv.enable_sticky_header) that pin header lines at the top of
    // the viewport, consuming visual space and shifting the effective reveal
    // position down.
    return clamp_line(
        clamped_source_line + PREVIEW_EDITOR_TOP_PADDING_LINES - sticky_header_lines,
        line_count
    );
}

function clamp_line(line: number, line_count: number): number {
    return Math.max(0, Math.min(line, line_count - 1));
}
