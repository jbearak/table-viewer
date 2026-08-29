import { describe, it, expect } from 'vitest';
import {
    cell_edit_base,
    cell_edit_text,
    cell_edits_equal,
    cell_effective_rich_text,
    cell_whole_style,
    edit_display_text,
    parse_cell_edit,
} from '../cell-edit-model';
import {
    decode_stored_per_file_state,
    dirty_entries_equal,
    sanitized_dirty_entry,
    sanitized_wire_dirty_entry,
    sanitized_wire_save_maps,
    sanitized_wire_string_record,
    type PerFileState,
} from '../types';

describe('cell_whole_style', () => {
    it('is undefined for a plain cell and sparse otherwise', () => {
        expect(cell_whole_style({ raw: 'x' })).toBeUndefined();
        expect(cell_whole_style({ raw: 'x', bold: true, underline: true }))
            .toEqual({ bold: true, underline: true });
    });
});

describe('cell_edit_text', () => {
    it('plain syntax is the raw text verbatim, markup and all', () => {
        expect(cell_edit_text({ raw: 'a *b*' }, 'plain')).toBe('a *b*');
        expect(cell_edit_text({ raw: null }, 'plain')).toBe('');
    });

    it('markdown syntax serializes the effective rich content', () => {
        expect(cell_edit_text({
            raw: 'plain bold',
            richText: { runs: [{ text: 'plain ' }, { text: 'bold', style: { bold: true } }] },
        }, 'markdown')).toBe('plain **bold**');
        // Whole-cell style without runs: the raw text under the cell font.
        expect(cell_edit_text({ raw: 'shout', bold: true }, 'markdown')).toBe('**shout**');
        // A plain cell's markdown is its text with literals escaped.
        expect(cell_edit_text({ raw: '2*3' }, 'markdown')).toBe('2\\*3');
    });

    it('uses a formula as the edit text and conflict base', () => {
        const cell = { raw: '58.5', formula: '=E5*F5' };
        expect(cell_edit_text(cell, 'markdown')).toBe('=E5*F5');
        expect(cell_edit_base(cell)).toEqual({ text: '=E5*F5' });
        expect(parse_cell_edit('=E5*F5', 'markdown')).toEqual({ text: '=E5*F5' });
    });
});

describe('parse_cell_edit / cell_edits_equal', () => {
    it('plain edits carry no rich side', () => {
        expect(parse_cell_edit('**not bold**', 'plain')).toEqual({ text: '**not bold**' });
    });

    it('markdown edits parse to a plain projection plus runs when styled', () => {
        const parsed = parse_cell_edit('a **b**', 'markdown');
        expect(parsed.text).toBe('a b');
        expect(parsed.rich).toEqual({
            runs: [{ text: 'a ' }, { text: 'b', style: { bold: true } }],
        });
        // Unstyled markdown input stays plain-shaped.
        expect(parse_cell_edit('a \\*b\\*', 'markdown')).toEqual({ text: 'a *b*' });
    });

    it('retyping a cell\'s own content compares equal; a formatting-only change does not', () => {
        const cell = {
            raw: 'plain bold',
            richText: { runs: [{ text: 'plain ' }, { text: 'bold', style: { bold: true as const } }] },
        };
        const base = cell_edit_base(cell);
        // The canonical spelling reverts…
        expect(cell_edits_equal(parse_cell_edit('plain **bold**', 'markdown'), base)).toBe(true);
        // …deleting the markup is an edit even though the text is unchanged…
        expect(cell_edits_equal(parse_cell_edit('plain bold', 'markdown'), base)).toBe(false);
        // …and so is adding markup to a plain cell.
        expect(cell_edits_equal(
            parse_cell_edit('**x**', 'markdown'),
            cell_edit_base({ raw: 'x' }),
        )).toBe(false);
    });
});

describe('edit_display_text', () => {
    it('re-derives markdown from a stored edit\'s runs, plain text otherwise', () => {
        expect(edit_display_text({
            text: 'a b',
            rich: { runs: [{ text: 'a ' }, { text: 'b', style: { italic: true } }] },
        }, 'markdown')).toBe('a *b*');
        expect(edit_display_text({ text: '2*3' }, 'markdown')).toBe('2\\*3');
        expect(edit_display_text({ text: '2*3' }, 'plain')).toBe('2*3');
    });
});

describe('cell_effective_rich_text', () => {
    it('prefers the cell\'s resolved runs over the whole-cell style', () => {
        const runs = { runs: [{ text: 'x', style: { bold: true as const } }] };
        expect(cell_effective_rich_text({ raw: 'x', italic: true, richText: runs })).toBe(runs);
        expect(cell_effective_rich_text({ raw: 'x', italic: true })).toEqual({
            runs: [{ text: 'x', style: { italic: true } }],
        });
    });
});

describe('dirty_entries_equal', () => {
    const bold = { runs: [{ text: 'x', style: { bold: true as const } }] };
    it('a formatting-only difference is a difference', () => {
        expect(dirty_entries_equal(
            { value: 'x', base: 'x' },
            { value: 'x', base: 'x', valueRuns: bold },
        )).toBe(false);
        expect(dirty_entries_equal(
            { value: 'x', base: 'x', valueRuns: bold },
            { value: 'x', base: 'x', valueRuns: { runs: [{ text: 'x', style: { bold: true } }] } },
        )).toBe(true);
    });
});

describe('sanitized_dirty_entry', () => {
    it('keeps a run side whose text equals the plain side and drops one that does not', () => {
        const good = { runs: [{ text: 'ab', style: { bold: true as const } }] };
        const evil = { runs: [{ text: 'DIFFERENT', style: { bold: true as const } }] };
        expect(sanitized_dirty_entry({ value: 'ab', base: 'c', valueRuns: good }))
            .toEqual({ value: 'ab', base: 'c', valueRuns: good });
        // Runs spelling different text would smuggle a value past base
        // validation and the string-typed writers — dropped, plain text kept.
        expect(sanitized_dirty_entry({ value: 'ab', base: 'c', valueRuns: evil }))
            .toEqual({ value: 'ab', base: 'c' });
        expect(sanitized_dirty_entry({ value: 'ab', base: 'c', valueRuns: 'junk' }))
            .toEqual({ value: 'ab', base: 'c' });
    });

    it('keeps the link dimension only as a valid pair', () => {
        const link = { kind: 'external' as const, target: 'https://a.test/' };
        const base = { value: 'x', base: 'x' };
        // Both sides present and each a valid hyperlink or null: kept whole.
        expect(sanitized_dirty_entry({ ...base, link, baseLink: null }))
            .toEqual({ ...base, link, baseLink: null });
        expect(sanitized_dirty_entry({ ...base, link: null, baseLink: link }))
            .toEqual({ ...base, link: null, baseLink: link });
        // A change with no recorded base could never be conflict-checked, and a
        // base with no change says nothing — dropped whole either way, which
        // leaves the cell's existing link untouched on save.
        expect(sanitized_dirty_entry({ ...base, link })).toEqual(base);
        expect(sanitized_dirty_entry({ ...base, baseLink: link })).toEqual(base);
        // Malformed on either side drops the pair, not just the bad half.
        expect(sanitized_dirty_entry({ ...base, link: { kind: 'external' }, baseLink: null }))
            .toEqual(base);
        expect(sanitized_dirty_entry({ ...base, link, baseLink: 'junk' })).toEqual(base);
        expect(sanitized_dirty_entry({ ...base, link: { kind: 'nope', target: 'x' }, baseLink: null }))
            .toEqual(base);
    });
});

describe('sanitized_wire_dirty_entry', () => {
    it('drops entries that are not two-string records instead of throwing', () => {
        for (const bad of [null, undefined, 'text', 42, [], { value: 'x' }, { value: 1, base: 'y' }]) {
            expect(sanitized_wire_dirty_entry(bad)).toBeUndefined();
        }
    });

    it('defers to the sanitizer for well-shaped entries', () => {
        const good = { runs: [{ text: 'ab', style: { bold: true as const } }] };
        expect(sanitized_wire_dirty_entry({ value: 'ab', base: 'c', valueRuns: good }))
            .toEqual({ value: 'ab', base: 'c', valueRuns: good });
        expect(sanitized_wire_dirty_entry({ value: 'ab', base: 'c', valueRuns: 'junk' }))
            .toEqual({ value: 'ab', base: 'c' });
    });

    it('carries a valid link pair across the wire and drops a malformed one', () => {
        const link = { kind: 'external' as const, target: 'https://a.test/' };
        expect(sanitized_wire_dirty_entry({ value: 'x', base: 'x', link, baseLink: null }))
            .toEqual({ value: 'x', base: 'x', link, baseLink: null });
        expect(sanitized_wire_dirty_entry({ value: 'x', base: 'x', link: 'junk', baseLink: null }))
            .toEqual({ value: 'x', base: 'x' });
    });

    it('bounds canonical cut provenance at the wire', () => {
        expect(sanitized_wire_dirty_entry({
            value: 'x', base: 'y', movedFrom: { row: 4, col: 3, order: 1 },
        })).toEqual({ value: 'x', base: 'y', movedFrom: { row: 4, col: 3, order: 1 } });
        expect(sanitized_wire_dirty_entry({
            value: 'x', base: 'y', movedFrom: { row: -1, col: 3, order: 1 },
        })).toBeUndefined();
    });
});

describe('sanitized_wire_save_maps', () => {
    it('preserves an own __proto__ key in the generic null-prototype record', () => {
        const input = Object.create(null) as Record<string, unknown>;
        input['__proto__'] = 'saved';

        const record = sanitized_wire_string_record(input);

        expect(record).toBeDefined();
        expect(Object.getPrototypeOf(record)).toBeNull();
        expect(Object.prototype.hasOwnProperty.call(record, '__proto__')).toBe(true);
        expect(record!['__proto__']).toBe('saved');
    });

    it.each(['__proto__', '01:0', '0:9007199254740993'])(
        'rejects the noncanonical cell key %s',
        (key) => {
            expect(sanitized_wire_save_maps(
                { [key]: 'saved' },
                { [key]: { value: 'saved', base: 'base' } },
            )).toBeUndefined();
        },
    );
});

describe('durable pendingEdits with runs', () => {
    const pending = (state: unknown) =>
        (decode_stored_per_file_state(state as object) as PerFileState).pendingEdits;

    it('round-trips a rich entry', () => {
        const entry = {
            value: 'a b',
            base: 'a b',
            valueRuns: { runs: [{ text: 'a ' }, { text: 'b', style: { bold: true } }] },
        };
        const decoded = pending({ pendingEdits: [{ cells: { '0:0': entry } }] });
        expect(decoded?.[0]?.cells['0:0']).toEqual(entry);
    });

    it('rejects runs whose text disagrees with the plain side', () => {
        expect(() => pending({
            pendingEdits: [{
                cells: {
                    '0:0': {
                        value: 'a b',
                        base: 'a b',
                        valueRuns: { runs: [{ text: 'SMUGGLED', style: { bold: true } }] },
                    },
                },
            }],
        })).toThrow();
    });

    it('rejects malformed run structures', () => {
        expect(() => pending({
            pendingEdits: [{
                cells: { '0:0': { value: 'x', base: 'x', valueRuns: { runs: 'nope' } } },
            }],
        })).toThrow();
    });
});
