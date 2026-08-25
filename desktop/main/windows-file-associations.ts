import { execFile } from 'node:child_process';

export const WINDOWS_FILE_ASSOCIATIONS = [
    { extension: 'csv', description: 'Comma-separated values' },
    { extension: 'tsv', description: 'Tab-separated values' },
    { extension: 'xlsx', description: 'Excel workbook' },
    { extension: 'xls', description: 'Legacy Excel workbook' },
    { extension: 'dta', description: 'Stata dataset' },
] as const;

export const SUPPORTED_FILE_EXTENSIONS = WINDOWS_FILE_ASSOCIATIONS.map(
    ({ extension }) => extension,
);

export type RegistryCommandRunner = (args: readonly string[]) => Promise<void>;

/** Registry writes used only by electron-builder's portable wrapper.
 *
 * Portable ProgIDs are separate from the installed app's TableViewer.* keys:
 * running one form must not redirect or remove the other form's handler. Like
 * desktop/installer.nsh, OpenWithProgids is populated without changing the
 * extension key's default value, so Excel or another spreadsheet app remains
 * the user's default.
 */
export function portable_file_association_commands(
    portable_executable: string,
): readonly (readonly string[])[] {
    const executable_command = `"${portable_executable}" "%1"`;
    const executable_icon = `"${portable_executable}",0`;
    const commands: string[][] = [];

    for (const { extension, description } of WINDOWS_FILE_ASSOCIATIONS) {
        const prog_id = `TableViewerPortable.${extension}`;
        const prog_id_key = `HKCU\\Software\\Classes\\${prog_id}`;
        commands.push(
            ['add', prog_id_key, '/ve', '/d', description, '/f'],
            ['add', `${prog_id_key}\\DefaultIcon`, '/ve', '/d', executable_icon, '/f'],
            [
                'add',
                `${prog_id_key}\\shell\\open\\command`,
                '/ve',
                '/d',
                executable_command,
                '/f',
            ],
            [
                'add',
                `HKCU\\Software\\Classes\\.${extension}\\OpenWithProgids`,
                '/v',
                prog_id,
                '/t',
                'REG_NONE',
                '/d',
                '',
                '/f',
            ],
        );
    }

    return commands;
}

function run_registry_command(args: readonly string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        execFile('reg.exe', [...args], { windowsHide: true }, (error) => {
            if (error) reject(error);
            else resolve();
        });
    });
}

/** Register the stable outer portable executable, never Electron's temporary
 * extracted executable. Re-running refreshes every command after the portable
 * file has been moved. Registration failure is reported to the caller but must
 * not prevent the viewer from starting. */
export async function register_portable_file_associations(
    portable_executable: string,
    run: RegistryCommandRunner = run_registry_command,
): Promise<boolean> {
    let succeeded = true;
    for (const command of portable_file_association_commands(portable_executable)) {
        try {
            await run(command);
        } catch {
            succeeded = false;
        }
    }
    return succeeded;
}
