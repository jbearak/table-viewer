import * as fs from 'node:fs';
import type { ParquetReader } from '@jbearak/dta-parser';
import { openParquetFile } from '@jbearak/dta-parser/node';
import { assert_value_label_limits } from './file-dta-source';
import {
    ParquetReaderSource,
    assert_parquet_footer_length,
    assert_parquet_limits,
    parquet_open_error,
    parquet_reader_options,
    type ParquetSourceOptions,
} from './parquet-source';
import { open_file_source, type ObservedFileSource, type SourceFile } from './source-file';

export type ObservedFileParquetSource = ObservedFileSource<FileParquetDataSource>;

/** The file's last 8 bytes, read through its descriptor. */
function read_tail(fd: number): { tail: Uint8Array; size: number } {
    const size = fs.fstatSync(fd).size;
    const tail = new Uint8Array(Math.min(8, size));
    if (tail.length > 0) fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    return { tail, size };
}

/**
 * Parquet source for a file on disk. The reader reads through the
 * descriptor this source holds, page by page as windows need them, and the
 * source hashes the same descriptor when it opens.
 */
export class FileParquetDataSource extends ParquetReaderSource {
    private constructor(
        reader: ParquetReader,
        private readonly file: SourceFile | null,
    ) {
        super(reader);
    }

    static async open(
        file_path: string,
        options: ParquetSourceOptions = {},
    ): Promise<FileParquetDataSource> {
        return (await FileParquetDataSource.open_observed(file_path, false, undefined, options)).source;
    }

    static async open_observed(
        file_path: string,
        include_digest = true,
        is_cancelled: () => boolean = () => false,
        options: ParquetSourceOptions = {},
    ): Promise<ObservedFileParquetSource> {
        try {
            return await open_file_source(file_path, 'Parquet', include_digest, is_cancelled, (file) => {
                const { tail, size } = read_tail(file.descriptor);
                assert_parquet_footer_length(tail, size);
                const reader = openParquetFile(file.descriptor, parquet_reader_options(options));
                try {
                    assert_parquet_limits(reader);
                    assert_value_label_limits(
                        reader,
                        reader.variables.filter((variable) => variable.columnKind !== null),
                        'Parquet',
                    );
                    return new FileParquetDataSource(reader, file);
                } catch (error) {
                    reader.close();
                    throw error;
                }
            });
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') throw error;
            // open_file_source says "Could not open Parquet file"; keep the
            // package's code visible so a damaged file is called corrupt.
            throw parquet_open_error((error as Error).cause ?? error);
        }
    }

    close(): void {
        super.close();
        this.file?.close();
    }

    async physical_content_matches(
        expected_digest: string,
        is_cancelled: () => boolean,
    ): Promise<boolean> {
        this.open_reader();
        if (this.file === null) throw new Error('Parquet source is closed');
        return this.file.physical_content_matches(expected_digest, is_cancelled);
    }
}
