export interface VisibleLineWindow {
    top_line: number;
}

const PREVIEW_EDITOR_TOP_PADDING_LINES = 5;

export function get_preview_reveal_target_line(
    source_line: number,
    visible_window: VisibleLineWindow | null,
    line_count: number
) : number | null {
    if (line_count <= 0) return null;

    const clamped_source_line = clamp_line(source_line, line_count);
    if (visible_window && visible_window.top_line === clamped_source_line) {
        return null;
    }

    return clamp_line(
        clamped_source_line + PREVIEW_EDITOR_TOP_PADDING_LINES,
        line_count
    );
}

function clamp_line(line: number, line_count: number): number {
    return Math.max(0, Math.min(line, line_count - 1));
}
