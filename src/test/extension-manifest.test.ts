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
    contributes?: { customEditors?: CustomEditorContribution[] };
};
const custom_editors = manifest.contributes?.customEditors ?? [];

function contribution(view_type: string): CustomEditorContribution {
    const matches = custom_editors.filter((editor) => editor.viewType === view_type);
    expect(matches).toHaveLength(1);
    return matches[0];
}

function selector_patterns(editor: CustomEditorContribution): Set<unknown> {
    return new Set(editor.selector?.map((selector) => selector.filenamePattern) ?? []);
}

describe('extension custom-editor manifest', () => {
    it('uses unique view types', () => {
        const view_types = custom_editors.map((editor) => editor.viewType);
        expect(view_types.every((view_type) => typeof view_type === 'string')).toBe(true);
        expect(new Set(view_types).size).toBe(view_types.length);
    });

    it('keeps the Excel viewer default for its current selector set', () => {
        const editor = contribution('tableViewer.excelViewer');
        expect(editor.priority).toBe('default');
        expect(selector_patterns(editor)).toEqual(new Set([
            '*.xlsx',
            '*.XLSX',
            '*.xls',
            '*.XLS',
        ]));
    });

    it('makes the CSV and TSV viewer the default for each supported case', () => {
        const editor = contribution('tableViewer.editor');
        expect(editor.priority).toBe('default');
        expect(selector_patterns(editor)).toEqual(new Set([
            '*.csv',
            '*.CSV',
            '*.tsv',
            '*.TSV',
        ]));
    });
});
