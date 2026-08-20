import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import {
    apply_worksheet_edits,
    OOXML_CONFORMANCE_VERSION,
    OOXML_SURGERY_API_VERSION,
    OoxmlRefusalError,
    type CellTextStyle,
    type OoxmlRefusalCode,
    type RichTextRun,
    type XlsxCellEdit,
    type XlsxWriteOptions,
} from '../ooxml-surgery';
import { OOXML_REFUSAL_CODES } from '../ooxml-refusal';

const CORPUS_ROOT = resolve(__dirname, '../../conformance');

type DateSystem = '1900' | '1904';

interface CorpusDateStyleMatch {
    readonly style_index: number;
    readonly serial: number;
}

interface CorpusFontStyle extends CellTextStyle {
    readonly style_index: number;
}

interface CorpusRunFontBase {
    readonly style_index: number;
    readonly xml: string;
}

interface CorpusContext {
    readonly date_system: DateSystem;
    readonly date_style_matches: readonly CorpusDateStyleMatch[];
    readonly font_styles: readonly CorpusFontStyle[];
    readonly run_font_bases: readonly CorpusRunFontBase[];
}

interface CorpusEdit {
    readonly row: number;
    readonly column: number;
    readonly value: string;
    readonly runs?: readonly RichTextRun[];
    readonly force_text?: boolean;
}

type CorpusExpectation =
    | { readonly kind: 'output'; readonly golden: string }
    | { readonly kind: 'refusal'; readonly code: OoxmlRefusalCode }
    | { readonly kind: 'no-authoritative-sheet-data' };

interface CorpusCase {
    readonly id: string;
    readonly description: string;
    readonly input: string;
    readonly edits: readonly CorpusEdit[];
    readonly context: CorpusContext;
    readonly expected: CorpusExpectation;
}

interface CorpusManifest {
    readonly $schema: string;
    readonly format_version: number;
    readonly corpus: string;
    readonly corpus_version: string;
    readonly api_version: number;
    readonly operation: string;
    readonly encoding: string;
    readonly coordinate_base: number;
    readonly refusal_codes: readonly OoxmlRefusalCode[];
    readonly cases: readonly CorpusCase[];
}

interface ImplementationPin {
    readonly implementation: string;
    readonly api_version: number;
    readonly corpus_version: string;
}

const manifest = JSON.parse(
    readFileSync(join(CORPUS_ROOT, 'manifest.json'), 'utf8'),
) as CorpusManifest;
const implementation_pin = JSON.parse(
    readFileSync(join(CORPUS_ROOT, 'pins/typescript.json'), 'utf8'),
) as ImplementationPin;

function corpus_path(path: string): string {
    const resolved = resolve(CORPUS_ROOT, path);
    if (resolved !== CORPUS_ROOT && !resolved.startsWith(`${CORPUS_ROOT}${sep}`)) {
        throw new Error(`Corpus path escapes its root: ${path}`);
    }
    return resolved;
}

function write_options(context: CorpusContext): XlsxWriteOptions {
    const font_styles = new Map<number, CellTextStyle>();
    for (const { style_index, ...style } of context.font_styles) {
        font_styles.set(style_index, style);
    }
    const run_font_bases = new Map(
        context.run_font_bases.map(({ style_index, xml }) => [style_index, xml]),
    );
    return {
        datemode: context.date_system === '1904' ? 1 : 0,
        is_date_style: (style_index, serial) => context.date_style_matches.some(
            (match) => match.style_index === style_index && match.serial === serial,
        ),
        cell_font_style: (style_index) => font_styles.get(style_index),
        run_font_base: (style_index) => run_font_bases.get(style_index) ?? '',
    };
}

function cell_edits(edits: readonly CorpusEdit[]): XlsxCellEdit[] {
    return edits.map(({ column, ...edit }) => ({ ...edit, col: column }));
}

function listed_files(directory: string): string[] {
    return readdirSync(join(CORPUS_ROOT, directory))
        .filter((name) => name.endsWith('.xml'))
        .map((name) => `${directory}/${name}`)
        .sort();
}

describe('OOXML conformance corpus metadata', () => {
    it('pins one API, corpus revision, schema, and refusal vocabulary', () => {
        expect(readFileSync(join(CORPUS_ROOT, 'VERSION'), 'utf8').trim())
            .toBe(OOXML_CONFORMANCE_VERSION);
        expect(manifest).toMatchObject({
            $schema: 'schema-v1.json',
            format_version: 1,
            corpus: 'ooxml-worksheet-edit',
            corpus_version: OOXML_CONFORMANCE_VERSION,
            api_version: OOXML_SURGERY_API_VERSION,
            operation: 'apply-worksheet-edits',
            encoding: 'utf-8',
            coordinate_base: 0,
        });
        expect(implementation_pin).toEqual({
            implementation: '@jbearak/ooxml-surgery',
            api_version: OOXML_SURGERY_API_VERSION,
            corpus_version: OOXML_CONFORMANCE_VERSION,
        });
        expect(manifest.refusal_codes).toEqual(OOXML_REFUSAL_CODES);
        expect(corpus_path(manifest.$schema)).toBe(join(CORPUS_ROOT, 'schema-v1.json'));
        expect(readFileSync(corpus_path(manifest.$schema), 'utf8')).not.toHaveLength(0);
    });

    it('has stable unique IDs and an exact fixture/golden inventory', () => {
        expect(manifest.cases).toHaveLength(41);
        const ids = manifest.cases.map(({ id }) => id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const item of manifest.cases) {
            expect(item.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
            expect(item.input).toBe(`fixtures/${item.id}.xml`);
            expect(relative(CORPUS_ROOT, corpus_path(item.input))).toBe(item.input);
            if (item.expected.kind === 'output') {
                expect(item.expected.golden).toBe(`goldens/${item.id}.xml`);
            }
        }
        expect(listed_files('fixtures')).toEqual(
            manifest.cases.map(({ input }) => input).sort(),
        );
        expect(listed_files('goldens')).toEqual(
            manifest.cases.flatMap(({ expected }) => (
                expected.kind === 'output' ? [expected.golden] : []
            )).sort(),
        );
    });
});

describe('OOXML conformance cases', () => {
    for (const item of manifest.cases) {
        it(`${item.id}: ${item.description}`, () => {
            const source = readFileSync(corpus_path(item.input));
            let caught: unknown;
            let output: Uint8Array | undefined;
            try {
                output = apply_worksheet_edits({
                    worksheet_xml: source,
                    relationships_xml: null,
                    cell_edits: cell_edits(item.edits),
                    write_options: write_options(item.context),
                }).worksheet_xml;
            } catch (error) {
                caught = error;
            }

            if (item.expected.kind === 'output') {
                if (caught !== undefined) throw caught;
                expect(Buffer.from(output!)).toEqual(
                    readFileSync(corpus_path(item.expected.golden)),
                );
                return;
            }
            if (item.expected.kind === 'refusal') {
                expect(caught).toBeInstanceOf(OoxmlRefusalError);
                expect((caught as OoxmlRefusalError).code).toBe(item.expected.code);
                return;
            }

            // This normalizes the legacy plain Error into a portable outcome;
            // neither its prose nor its TypeScript class appears in corpus data.
            expect(caught).toBeInstanceOf(Error);
            expect(caught).not.toBeInstanceOf(OoxmlRefusalError);
            expect((caught as Error).message).toMatch(/no <sheetData>/);
        });
    }
});
