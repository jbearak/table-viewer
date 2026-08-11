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

function selector_patterns(editor: CustomEditorContribution): Set<unknown> {
    return new Set(editor.selector?.map((selector) => selector.filenamePattern) ?? []);
}

function expect_required_selectors(
    editor: CustomEditorContribution,
    required_patterns: readonly string[],
): void {
    const patterns = selector_patterns(editor);
    for (const pattern of required_patterns) {
        expect(patterns.has(pattern)).toBe(true);
    }
}

describe('extension runtime manifest', () => {
    it('pins the approved runtime floor and embedded desktop runtime', () => {
        expect(manifest.engines).toEqual({
            node: '>=26.5.1',
            vscode: '^1.127.0',
        });
        expect(manifest.extensionKind).toEqual(['workspace']);
        expect(manifest.devDependencies?.electron).toBe('43.2.0');
        expect(manifest.devDependencies?.['@types/node']).toBe('26.1.2');
    });

    it('excludes build and integration artifacts from the VSIX', () => {
        expect(vscodeignore).toEqual(expect.arrayContaining([
            'out/**',
            'dist/runtime-probes/**',
            '.vscode-test.mjs',
            'tsconfig.integration.json',
        ]));
        expect(vscodeignore).not.toContain('companion/**');
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
        ]);
        expect(manifest.contributes?.menus?.commandPalette).toContainEqual({
            command: 'tableViewer.openWorkbookAtSheet',
            when: 'false',
        });
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

    it('keeps the Excel viewer default for its current selector set', () => {
        const editor = contribution('tableViewer.excelViewer');
        expect(editor.priority).toBe('default');
        expect_required_selectors(editor, [
            '*.xlsx',
            '*.XLSX',
            '*.xls',
            '*.XLS',
        ]);
    });

    it('makes the CSV and TSV viewer the default for each supported case', () => {
        const editor = contribution('tableViewer.editor');
        expect(editor.priority).toBe('default');
        expect_required_selectors(editor, [
            '*.csv',
            '*.CSV',
            '*.tsv',
            '*.TSV',
        ]);
    });
});
