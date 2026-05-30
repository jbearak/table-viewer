// Shared reads of the `tableViewer.*` workspace configuration. The viewer
// hosts (viewer-controller and csv-preview) used to declare their own private
// copies of these getters; centralizing them keeps keys and defaults in one place.
import * as vscode from 'vscode';

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

/** ',' for .csv (and anything else), '\t' for .tsv — chosen by extension. */
export function get_delimiter(file_path: string): ',' | '\t' {
    return file_path.toLowerCase().endsWith('.tsv') ? '\t' : ',';
}
