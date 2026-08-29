/** Display spelling stored in a Header Row cell and used in rewritten formulas. */
export function committed_column_name(value: string): string {
    return value.trim().replace(/\s+/gu, ' ');
}

/** Case-insensitive spelling used to reject blank and duplicate column names. */
export function normalized_column_name(value: string): string {
    return committed_column_name(value).normalize('NFKC').toLocaleLowerCase();
}
