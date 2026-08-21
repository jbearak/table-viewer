import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface CustomEditorContribution {
    viewType?: unknown;
    priority?: unknown;
    selector?: Array<{ filenamePattern?: unknown }>;
}

const manifest = JSON.parse(readFileSync(
    resolve(__dirname, '../../package.json'),
    'utf8',
)) as {
    version?: unknown;
    contributes?: {
        customEditors?: CustomEditorContribution[];
        commands?: Array<{ command?: unknown }>;
        menus?: { commandPalette?: Array<{ command?: unknown; when?: unknown }> };
        configuration?: {
            properties?: Record<string, {
                type?: unknown;
                default?: unknown;
                minimum?: unknown;
                maximum?: unknown;
                description?: unknown;
            }>;
        };
    };
    engines?: { node?: unknown; vscode?: unknown };
    extensionKind?: unknown;
    extensionDependencies?: unknown;
    extensionPack?: unknown;
    scripts?: Record<string, unknown>;
    devDependencies?: { electron?: unknown; '@types/node'?: unknown };
};
const custom_editors = manifest.contributes?.customEditors ?? [];
const vscodeignore = readFileSync(resolve(__dirname, '../../.vscodeignore'), 'utf8')
    .split(/\r?\n/u)
    .filter((line) => line.length > 0 && !line.startsWith('#'));
function contribution(view_type: string): CustomEditorContribution {
    const matches = custom_editors.filter((editor) => editor.viewType === view_type);
    expect(matches).toHaveLength(1);
    return matches[0];
}

describe('extension runtime manifest', () => {
    it('pins the approved runtime floor and embedded desktop runtime', () => {
        expect(manifest.engines).toEqual({
            node: '>=26.5.1',
            vscode: '^1.127.0',
        });
        expect(manifest.extensionKind).toEqual(['workspace']);
        expect(manifest.devDependencies?.electron).toBe('43.4.0');
        expect(manifest.devDependencies?.['@types/node']).toBe('26.1.2');
    });

    it('excludes build and integration artifacts from the VSIX', () => {
        expect(vscodeignore).toEqual(expect.arrayContaining([
            'out/**',
            'dist/desktop-packages/**',
            'dist/mac*/**',
            'dist/*-unpacked/**',
            'dist/runtime-probes/**',
            '.vscode-test.mjs',
            'tsconfig.integration.json',
        ]));
        expect(vscodeignore).not.toContain('companion/**');
    });

    it('describes the file-size limit as a confirmation threshold', () => {
        expect(manifest.contributes?.configuration?.properties?.[
            'tableViewer.maxFileSizeMiB'
        ]).toMatchObject({
            type: 'number',
            default: 256,
            minimum: 1,
            description: 'File-size threshold in MiB above which Table Viewer asks for confirmation before opening an xlsx, xls, csv, or tsv file.',
        });
    });

    it('defaults Diff off when entering Edit mode', () => {
        expect(manifest.contributes?.configuration?.properties?.[
            'tableViewer.diffOnByDefault'
        ]).toMatchObject({
            type: 'boolean',
            default: false,
            description: expect.stringMatching(/Diff.*Edit mode/u),
        });
    });

    it('bounds the retention setting so a large value cannot disable eviction', () => {
        expect(manifest.contributes?.configuration?.properties?.[
            'tableViewer.maxStoredFiles'
        ]).toMatchObject({
            type: 'integer',
            default: 10_000,
            minimum: 1,
            maximum: 100_000,
        });
    });

    it('packages one extension with no companion or retired coordination commands', () => {
        expect(manifest.extensionDependencies).toBeUndefined();
        expect(manifest.extensionPack).toBeUndefined();
        expect(manifest.contributes?.commands?.map(({ command }) => command)).toEqual([
            'tableViewer.showCsvPreviewToSide',
            'tableViewer.showCsvPreview',
            'tableViewer.openCsvTable',
            'tableViewer.openAsText',
            'tableViewer.openWorkbookAtSheet',
            'tableViewer.manageStoredFileState',
            'tableViewer.openTableDiff',
        ]);
        expect(manifest.contributes?.menus?.commandPalette).toContainEqual({
            command: 'tableViewer.openWorkbookAtSheet',
            when: 'false',
        });
    });

    it('offers the table diff on git SCM resources for every supported format', () => {
        // The custom-editor selector is the authority on supported formats;
        // decode its casing-class pattern (e.g. `[cC][sS][vV]` -> `csv`) so the
        // SCM menu cannot silently drift from it.
        const selector_pattern = String(
            custom_editors[0]?.selector?.[0]?.filenamePattern,
        );
        const supported_extensions = selector_pattern
            .replace(/^\*\.\{|\}$/gu, '')
            .split(',')
            .map((extension) =>
                extension.replace(/\[(.)(.)\]/gu, (_, lower: string) => lower));
        expect(supported_extensions.length).toBeGreaterThan(0);
        const entries = (manifest.contributes?.menus as Record<string, unknown[]>)[
            'scm/resourceState/context'
        ] as { command: string; when: string; group: string }[];
        const diff_entries = entries.filter(
            (entry) => entry.command === 'tableViewer.openTableDiff',
        );
        expect(diff_entries.map((entry) => entry.group).sort()).toEqual(
            ['inline', 'navigation'],
        );
        for (const entry of diff_entries) {
            expect(entry.when).toContain('scmProvider == git');
            expect(entry.when).toContain('scmResourceGroup == workingTree');
            for (const extension of supported_extensions) {
                // The full alternation token, not the bare text — `csv` alone
                // would also match inside an unrelated part of the clause.
                expect(entry.when).toMatch(
                    new RegExp(`[(|]${extension}[)|]`, 'u'),
                );
            }
        }
    });

    it('externalizes the host-provided SQLite runtime from the one bundle it builds', () => {
        expect(manifest.scripts?.bundle).toContain('--external:node:sqlite');
        expect(manifest.scripts?.package).toBe('vsce package --no-dependencies');
        for (const retired of [
            'bundle:companion',
            'package:companion',
            'package:release',
            'probe:vsix:packages',
            'typecheck:companion',
        ]) {
            expect(manifest.scripts?.[retired]).toBeUndefined();
        }
        for (const script of ['typecheck:all', 'pretest:integration', 'probe:sqlite:bundles']) {
            expect(manifest.scripts?.[script]).not.toContain('companion');
        }
    });
});

describe('extension custom-editor manifest', () => {
    it('uses unique view types', () => {
        const view_types = custom_editors.map((editor) => editor.viewType);
        expect(view_types.every((view_type) => typeof view_type === 'string')).toBe(true);
        expect(new Set(view_types).size).toBe(view_types.length);
    });

    it('registers one default viewer for every supported format', () => {
        const editor = contribution('tableViewer.editor');
        expect(editor.priority).toBe('default');
        expect(editor.selector).toEqual([
            {
                filenamePattern:
                    '*.{[xX][lL][sS][xX],[xX][lL][sS],[cC][sS][vV],[tT][sS][vV]}',
            },
        ]);
        expect(custom_editors).toHaveLength(1);
    });
});
