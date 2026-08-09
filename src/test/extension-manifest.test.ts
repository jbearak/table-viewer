import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CSV_DOCUMENT_BACKUP_V2_MAX_SOURCE_BYTES } from '../csv-document-backup';

interface CustomEditorContribution {
    viewType?: unknown;
    priority?: unknown;
    selector?: Array<{ filenamePattern?: unknown }>;
}

const manifest = JSON.parse(readFileSync(
    resolve(__dirname, '../../package.json'),
    'utf8',
)) as {
    contributes?: {
        commands?: Array<{ command?: unknown }>;
        customEditors?: CustomEditorContribution[];
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
    extensionPack?: unknown;
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

    it('caps the public file-size setting at the immutable CSV backup ceiling', () => {
        const maximum_mib = CSV_DOCUMENT_BACKUP_V2_MAX_SOURCE_BYTES / (1024 * 1024);
        expect(maximum_mib).toBe(256);
        expect(manifest.contributes?.configuration?.properties?.[
            'tableViewer.maxFileSizeMiB'
        ]).toMatchObject({
            type: 'number',
            default: maximum_mib,
            minimum: 1,
            maximum: maximum_mib,
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

    it('packages one extension without retired coordination artifacts', () => {
        expect(manifest.extensionPack).toBeUndefined();
        expect(manifest.contributes?.commands?.map(({ command }) => command)).toEqual([
            'tableViewer.showCsvPreviewToSide',
            'tableViewer.showCsvPreview',
            'tableViewer.openCsvTable',
            'tableViewer.openAsText',
        ]);
        expect(vscodeignore).toEqual(expect.arrayContaining([
            'out/**',
            'dist/runtime-probes/**',
            '.vscode-test.mjs',
            'tsconfig.integration.json',
            'docs/**',
        ]));
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
