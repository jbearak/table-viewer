import {
    openDta,
    type DtaReader,
    type Options,
    type Variable,
} from '@jbearak/dta-parser';
import {
    assert_safe_sheet_shape,
    create_workbook_budget,
} from '../spreadsheet-safety';
import { TableReaderSource, type SourceNaming } from './table-reader-source';

export const STATA_NAMING: SourceNaming = {
    format: 'Stata',
    corrupt: 'Corrupt .dta file',
    failed: 'Could not read Stata file',
};

/** Bytes one observation occupies on disk, from its variables' storage types. */
export function stata_observation_bytes(variables: readonly Variable[]): number {
    let bytes = 0;
    for (const { type } of variables) {
        if (type === 'byte') bytes += 1;
        else if (type === 'int') bytes += 2;
        else if (type === 'long' || type === 'float') bytes += 4;
        else if (type === 'double' || type === 'strL') bytes += 8;
        else if (type.startsWith('str')) bytes += Number(type.slice(3));
    }
    return bytes;
}

/** The table a Stata reader shows: every variable, in file order. */
export function stata_table_shape(reader: DtaReader) {
    return {
        variables: reader.variables,
        estimatedRowBytes: stata_observation_bytes(reader.variables),
        naming: STATA_NAMING,
    };
}

/** Read-only, buffer-backed Stata source with bounded lazy row decoding. */
export class DtaDataSource extends TableReaderSource<DtaReader> {
    static async create(bytes: Uint8Array, options: Options = {}): Promise<DtaDataSource> {
        let reader: DtaReader | undefined;
        try {
            reader = openDta(bytes, options);
            assert_safe_sheet_shape(
                create_workbook_budget(), reader.info.nobs, reader.variables.length, 0,
            );
            return new DtaDataSource(reader, stata_table_shape(reader));
        } catch (error) {
            reader?.close();
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`Could not open Stata file: ${detail}`, { cause: error });
        }
    }
}
