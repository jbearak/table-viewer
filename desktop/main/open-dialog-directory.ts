// Filesystem-facing policy for native file-picker starting directories. Kept
// outside main.ts so fallback behavior can be tested without loading Electron.
import * as path from 'path';
import { expand_tilde, is_existing_directory } from './compare-path-complete';

/**
 * Pick a usable directory for a native file dialog.
 *
 * A nearby file (the Compare dialog's already-entered path) takes precedence.
 * If it has no usable parent, fall back to the last directory selected in any
 * file picker. Missing folders are ignored so Electron can use its normal
 * platform default instead of receiving a stale `defaultPath`.
 */
export function open_dialog_directory(
    remembered_directory: string,
    nearby_file?: string,
    tilde_home?: string,
): string | undefined {
    if (nearby_file && nearby_file.trim() !== '') {
        const nearby_directory = path.dirname(expand_tilde(nearby_file, tilde_home));
        if (is_existing_directory(nearby_directory)) return nearby_directory;
    }
    return is_existing_directory(remembered_directory)
        ? remembered_directory
        : undefined;
}

/** Directory represented by the first successful file-picker result. */
export function selected_file_directory(file_paths: readonly string[]): string | undefined {
    const selected = file_paths.find((file_path) => file_path.trim() !== '');
    return selected ? path.dirname(selected) : undefined;
}
