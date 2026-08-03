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
    contributes?: { customEditors?: CustomEditorContribution[]; commands?: Array<{ command?: unknown }> };
    engines?: { node?: unknown; vscode?: unknown };
    extensionKind?: unknown;
    extensionDependencies?: unknown;
    extensionPack?: unknown;
    scripts?: Record<string, unknown>;
    devDependencies?: { electron?: unknown; '@types/node'?: unknown };
};
const companion_manifest = JSON.parse(readFileSync(
    resolve(__dirname, '../../companion/package.json'),
    'utf8',
)) as {
    version?: unknown;
    engines?: { vscode?: unknown };
    extensionKind?: unknown;
    api?: unknown;
    main?: unknown;
    activationEvents?: unknown;
    contributes?: { commands?: Array<{ command?: unknown }> };
};
const custom_editors = manifest.contributes?.customEditors ?? [];
const vscodeignore = readFileSync(resolve(__dirname, '../../.vscodeignore'), 'utf8')
    .split(/\r?\n/u)
    .filter((line) => line.length > 0 && !line.startsWith('#'));
const companion_vscodeignore = readFileSync(resolve(__dirname, '../../companion/.vscodeignore'), 'utf8')
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

    it('excludes build, integration, and separately packaged companion artifacts from the main VSIX', () => {
        expect(vscodeignore).toEqual(expect.arrayContaining([
            'out/**',
            'dist/runtime-probes/**',
            '.vscode-test.mjs',
            'tsconfig.integration.json',
            'companion/**',
        ]));
    });

    it('offers the separately packaged UI companion without hard-blocking unsupported browser UI hosts', () => {
        expect(manifest.extensionDependencies).toBeUndefined();
        expect(manifest.extensionPack).toEqual(['jbearak.table-viewer-companion']);
        expect(companion_manifest.version).toBe(manifest.version);
        expect(companion_manifest.engines).toEqual({ vscode: '^1.127.0' });
        expect(companion_manifest.extensionKind).toEqual(['ui']);
        expect(companion_manifest.api).toBe('none');
        expect(companion_manifest.main).toBe('./dist/extension.js');
        expect(companion_vscodeignore).toEqual(expect.arrayContaining([
            'src/**',
            'test/**',
            'tsconfig.json',
            'dist-types/**',
            '*.vsix',
        ]));
    });

    it('keeps bridge commands callable but exposes only explicit recovery and retirement UI', () => {
        const contributed = companion_manifest.contributes?.commands?.map((entry) => entry.command) ?? [];
        expect(contributed).toEqual([
            'tableViewerCompanion.openRecovery',
            'tableViewerCompanion.retireCapsule',
        ]);
        const activation = companion_manifest.activationEvents;
        expect(Array.isArray(activation)).toBe(true);
        expect(activation).toEqual(expect.arrayContaining([
            'onCommand:tableViewerCompanion.hostCapabilities.v1',
            'onCommand:tableViewerCompanion.namespace.v1',
            'onCommand:tableViewerCompanion.preparePendingEditRecovery.v1',
            'onCommand:tableViewerCompanion.openRecovery',
        ]));
        expect(contributed.some((command) => typeof command === 'string' && command.endsWith('.v1'))).toBe(false);
    });

    it('builds independent bundles while externalizing the host-provided SQLite runtime', () => {
        expect(manifest.scripts?.bundle).toContain('--external:node:sqlite');
        expect(manifest.scripts?.['bundle:companion']).toContain('companion/dist/extension.js');
        expect(manifest.scripts?.['bundle:companion']).toContain('--external:node:sqlite');
        expect(manifest.scripts?.package).toBe('vsce package --no-dependencies');
        expect(manifest.scripts?.['package:companion']).toBe('npm --prefix companion run package');
        expect(manifest.scripts?.['probe:sqlite:bundles']).toContain('npm run bundle:companion');
        expect(manifest.scripts?.['probe:vsix:packages']).toBe('node scripts/check-vsix-packages.mjs');
        expect(manifest.scripts?.['package:release']).toBe(
            'npm run package && npm run package:companion && npm run probe:vsix:packages',
        );
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
