import * as fs from 'fs';
import * as path from 'path';

const OPEN_WINDOWS_FILE_NAME = 'open-windows.json';

function open_windows_file_path(user_data_dir: string): string {
    return path.join(user_data_dir, OPEN_WINDOWS_FILE_NAME);
}

/** Save the viewer files from a completed application quit. */
export function save_open_window_paths(
    user_data_dir: string,
    file_paths: readonly string[],
): void {
    const target = open_windows_file_path(user_data_dir);
    if (file_paths.length === 0) {
        fs.rmSync(target, { force: true });
        return;
    }

    fs.mkdirSync(user_data_dir, { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    try {
        fs.writeFileSync(
            temporary,
            JSON.stringify(file_paths),
            { encoding: 'utf8', mode: 0o600 },
        );
        fs.renameSync(temporary, target);
    } catch (error) {
        try {
            fs.rmSync(temporary, { force: true });
        } catch {
            // Best-effort temp cleanup.
        }
        throw error;
    }
}

/** Consume the last clean quit's viewer files, keeping only paths usable now. */
export function take_open_window_paths(
    user_data_dir: string,
    can_restore: (file_path: string) => boolean,
): string[] {
    const target = open_windows_file_path(user_data_dir);
    let raw: unknown;
    try {
        raw = JSON.parse(fs.readFileSync(target, 'utf8'));
    } catch {
        raw = [];
    }

    try {
        fs.rmSync(target, { force: true });
    } catch {
        // Restoration is a convenience and must never make startup fail. Do not
        // restore when the record cannot be consumed, or it would repeat forever.
        return [];
    }
    if (!Array.isArray(raw)) return [];
    return raw.filter(
        (candidate): candidate is string => typeof candidate === 'string' && can_restore(candidate),
    );
}
