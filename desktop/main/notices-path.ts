// Where the generated npm third-party notices file lives, which differs between
// a dev run and a packaged app: electron-builder EXCLUDES
// dist/desktop/THIRD_PARTY_NOTICES.txt from `files` and ships it via
// extraResources into Contents/Resources instead (desktop/electron-builder.yml).
//
// Pure module taking its inputs as arguments (no electron, no fs) so both
// branches are unit-testable — this is easy to get backwards, and getting it
// backwards only shows up as a dead link in a packaged build.
import * as path from 'path';

export const NOTICES_FILE_NAME = 'THIRD_PARTY_NOTICES.txt';

export function notices_file_path(
    is_packaged: boolean,
    resources_path: string,
    desktop_dist_dir: string,
): string {
    return path.join(is_packaged ? resources_path : desktop_dist_dir, NOTICES_FILE_NAME);
}
