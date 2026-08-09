// Shared reads of the `tableViewer.*` workspace configuration. The viewer
// hosts (viewer-controller and csv-preview) used to declare their own private
// copies of these getters; centralizing them keeps keys and defaults in one place.
import * as vscode from 'vscode';
import { CSV_DOCUMENT_BACKUP_V2_MAX_SOURCE_BYTES } from './csv-document-backup';

const BYTES_PER_MIB = 1024 * 1024;
const MIN_FILE_SIZE_MIB = 1;
const MAX_FILE_SIZE_MIB = CSV_DOCUMENT_BACKUP_V2_MAX_SOURCE_BYTES / BYTES_PER_MIB;

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
    const configured = vscode.workspace.getConfiguration('tableViewer')
        .get<unknown>('maxFileSizeMiB', MAX_FILE_SIZE_MIB);
    if (typeof configured !== 'number' || !Number.isFinite(configured)) {
        return MAX_FILE_SIZE_MIB;
    }
    return Math.min(MAX_FILE_SIZE_MIB, Math.max(MIN_FILE_SIZE_MIB, configured));
}

export function get_csv_max_rows(): number {
    return vscode.workspace.getConfiguration('tableViewer')
        .get<number>('csvMaxRows', 1_000_000)!;
}

export function get_default_orientation(): 'horizontal' | 'vertical' {
    return vscode.workspace.getConfiguration('tableViewer')
        .get<'horizontal' | 'vertical'>('tabOrientation', 'horizontal');
}
