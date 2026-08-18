/**
 * The canonical `row:col` cell key, in one place.
 *
 * Every store that maps cells — pending edits, highlights, the repaint set — keys
 * on the same string, and every reader of one has to agree on exactly which
 * strings are well formed. It was spelled out separately in each of them, so a
 * writer could produce a key a reader would silently skip. One definition makes
 * that a compile-time impossibility instead of a convention.
 *
 * Canonical means no leading zeros and no negatives: keys are compared and
 * de-duplicated as strings, so two spellings of one coordinate would be two cells.
 */

/** Non-negative, no leading zeros — one spelling per coordinate. */
const CANONICAL_CELL_KEY = /^(0|[1-9]\d*):(0|[1-9]\d*)$/;

export interface CellKeyCoordinates {
    readonly sourceRow: number;
    readonly sourceColumn: number;
}

/**
 * Whether a string is a well-formed key, without paying for the coordinates.
 *
 * For validators, which reject the leaf and never look at the numbers. Callers
 * that need the coordinates should use {@link parse_cell_key} and get both from
 * one pass.
 */
export function is_canonical_cell_key(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    const match = CANONICAL_CELL_KEY.exec(value);
    return match !== null
        && Number.isSafeInteger(Number(match[1]))
        && Number.isSafeInteger(Number(match[2]));
}

/** The coordinates a key names, or undefined if it names none. */
export function parse_cell_key(key: unknown): CellKeyCoordinates | undefined {
    if (typeof key !== 'string') return undefined;
    const match = CANONICAL_CELL_KEY.exec(key);
    if (match === null) return undefined;
    const source_row = Number(match[1]);
    const source_column = Number(match[2]);
    // The pattern bounds the spelling, not the magnitude: a long enough run of
    // digits parses past the safe-integer range, and a coordinate that cannot
    // round-trip is not a cell anyone can address.
    if (!Number.isSafeInteger(source_row) || !Number.isSafeInteger(source_column)) {
        return undefined;
    }
    return { sourceRow: source_row, sourceColumn: source_column };
}

/**
 * The key for a coordinate pair.
 *
 * Throws rather than returning a sentinel: a caller with a fractional or negative
 * coordinate has a bug upstream, and a key built from one would address a cell
 * that cannot exist.
 */
export function cell_key(source_row: number, source_column: number): string {
    if (
        !Number.isSafeInteger(source_row)
        || source_row < 0
        || !Number.isSafeInteger(source_column)
        || source_column < 0
    ) {
        throw new RangeError('Cell coordinates must be non-negative safe integers.');
    }
    return `${source_row}:${source_column}`;
}
