// Shared reads of the `tableViewer.*` workspace configuration. The viewer
// hosts (viewer-controller and csv-preview) used to declare their own private
// copies of these getters; centralizing them keeps keys and defaults in one place.
import * as vscode from 'vscode';

export function get_font_family(): string | null {
    const configured = vscode.workspace.getConfiguration('tableViewer')
        .get<string>('fontFamily', '');
    return configured?.trim() || null;
}

/** Configured font size in px, or null for "follow the editor font size"
 *  (the setting's 0 default, which the webview resolves from
 *  `--vscode-editor-font-size`). */
export function get_font_size(): number | null {
    const configured = vscode.workspace.getConfiguration('tableViewer')
        .get<number>('fontSize', 0);
    if (typeof configured !== 'number' || !Number.isFinite(configured)) return null;
    return configured > 0 ? configured : null;
}

export function get_max_file_size_mib(): number {
    return vscode.workspace.getConfiguration('tableViewer')
        .get<number>('maxFileSizeMiB', 256)!;
}

export function get_csv_max_rows(): number {
    return vscode.workspace.getConfiguration('tableViewer')
        .get<number>('csvMaxRows', 1_000_000)!;
}

export function get_default_orientation(): 'horizontal' | 'vertical' {
    return vscode.workspace.getConfiguration('tableViewer')
        .get<'horizontal' | 'vertical'>('tabOrientation', 'horizontal');
}

export function get_diff_on_by_default(): boolean {
    return vscode.workspace.getConfiguration('tableViewer')
        .get<boolean>('diffOnByDefault', false);
}
