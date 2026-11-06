// The table formats Table Viewer opens, and the facts about each that callers
// would otherwise re-derive from a path's extension. Dependency-free on
// purpose: the desktop main process and renderer import it as well as the
// extension host, so parsers stay behind the `id` switch in each caller, where
// an exhaustive `switch` makes adding a format a compile error until every
// dispatch handles it.

export type TableFormatId = 'csv' | 'tsv' | 'xlsx' | 'xls' | 'parquet' | 'dta';

export interface TableFormat {
    readonly id: TableFormatId;
    /** Lower-case extension without the dot. */
    readonly extension: string;
    /** Human name, as shown in OS file-type registrations. */
    readonly description: string;
    /** One table per file, compared as a single unnamed sheet; a workbook
     *  carries named worksheets instead. */
    readonly singleTable: boolean;
    /** Whether Table Viewer can write changes back to this format. `.xls` is
     *  read-only because the writer is an OOXML package splice, and the binary
     *  BIFF container shares nothing with it. */
    readonly editable: boolean;
}

export const TABLE_FORMATS: readonly TableFormat[] = Object.freeze([
    { id: 'csv', extension: 'csv', description: 'Comma-separated values', singleTable: true, editable: true },
    { id: 'tsv', extension: 'tsv', description: 'Tab-separated values', singleTable: true, editable: true },
    { id: 'xlsx', extension: 'xlsx', description: 'Excel workbook', singleTable: false, editable: true },
    { id: 'xls', extension: 'xls', description: 'Legacy Excel workbook', singleTable: false, editable: false },
    { id: 'parquet', extension: 'parquet', description: 'Apache Parquet file', singleTable: true, editable: false },
    { id: 'dta', extension: 'dta', description: 'Stata dataset', singleTable: true, editable: false },
] as const satisfies readonly TableFormat[]);

const XLS_FORMAT = TABLE_FORMATS.find(({ id }) => id === 'xls')!;

/** Every supported extension, lower-case and without the dot. */
export const TABLE_FILE_EXTENSIONS: readonly string[] = Object.freeze(
    TABLE_FORMATS.map(({ extension }) => extension),
);

/** Matches a path ending in a supported extension, dot included, any case. */
export const TABLE_FILE_EXTENSION_PATTERN = new RegExp(
    `\\.(${TABLE_FILE_EXTENSIONS.join('|')})$`,
    'iu',
);

/** The format for an extension given with or without its dot, in any case. */
export function table_format_for_extension(extension: string): TableFormat | undefined {
    const normalized = extension.toLowerCase().replace(/^\./u, '');
    return TABLE_FORMATS.find((format) => format.extension === normalized);
}

/** The format a path's extension names, or undefined for an unsupported one. */
export function table_format_for(file_path: string): TableFormat | undefined {
    const match = TABLE_FILE_EXTENSION_PATTERN.exec(file_path);
    return match ? table_format_for_extension(match[1]) : undefined;
}

/**
 * The format whose parser opens a path. An unsupported extension goes to the
 * BIFF `.xls` parser, which rejects bytes it cannot read; that keeps the
 * historic fallback for paths a host opened anyway.
 */
export function parser_format_for(file_path: string): TableFormat {
    return table_format_for(file_path) ?? XLS_FORMAT;
}
