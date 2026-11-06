import * as fs from 'node:fs';
import { createHash } from 'node:crypto';

const FILE_DIGEST_CHUNK_BYTES = 4 * 1024 * 1024;

/** A file-backed source, with what was observed of its file when it opened. */
export interface ObservedFileSource<S> {
    readonly source: S;
    /** sha256 of the bytes read through the source's descriptor; empty when not asked for. */
    readonly digest: string;
    readonly size: number;
    readonly mtime: number;
}

function abort_error(format: string): Error {
    const error = new Error(`${format} source open was cancelled.`);
    error.name = 'AbortError';
    return error;
}

function same_descriptor(left: fs.Stats, right: fs.Stats): boolean {
    return left.dev === right.dev
        && left.ino === right.ino
        && left.size === right.size
        && left.mtimeMs === right.mtimeMs;
}

/**
 * The descriptor a file-backed source reads through. The source hashes the
 * bytes behind this descriptor, not the path, so what the view shows is what
 * was hashed; `physical_content_matches` checks the descriptor against the
 * path again.
 */
export class SourceFile {
    private fd: number | null;

    constructor(
        fd: number,
        private readonly file_path: string,
        private readonly format: string,
    ) {
        this.fd = fd;
    }

    get descriptor(): number {
        if (this.fd === null) throw new Error(`${this.format} source is closed`);
        return this.fd;
    }

    close(): void {
        if (this.fd === null) return;
        const fd = this.fd;
        this.fd = null;
        fs.closeSync(fd);
    }

    async physical_content_matches(
        expected_digest: string,
        is_cancelled: () => boolean,
    ): Promise<boolean> {
        const fd = this.descriptor;
        const before = fs.fstatSync(fd);
        const digest = await this.digest(fd, before.size, is_cancelled);
        const after = fs.fstatSync(fd);
        const path_stat = fs.statSync(this.file_path);
        return digest === expected_digest
            && same_descriptor(before, after)
            && same_descriptor(after, path_stat);
    }

    /** The descriptor's size, mtime and (when asked) digest, checked against the path. */
    async observe(
        include_digest: boolean,
        is_cancelled: () => boolean,
    ): Promise<{ digest: string; size: number; mtime: number }> {
        const fd = this.descriptor;
        const before = fs.fstatSync(fd);
        const digest = include_digest ? await this.digest(fd, before.size, is_cancelled) : '';
        const after = include_digest ? fs.fstatSync(fd) : before;
        const path_stat = fs.statSync(this.file_path);
        if (!same_descriptor(before, after) || !same_descriptor(after, path_stat)) {
            throw new Error('The file changed while it was being opened.');
        }
        return { digest, size: after.size, mtime: after.mtime.getTime() };
    }

    private async digest(
        fd: number,
        size: number,
        is_cancelled: () => boolean,
    ): Promise<string> {
        const digest = createHash('sha256');
        const chunk = Buffer.allocUnsafe(Math.min(FILE_DIGEST_CHUNK_BYTES, Math.max(1, size)));
        let position = 0;
        while (position < size) {
            if (is_cancelled()) throw abort_error(this.format);
            const length = Math.min(chunk.byteLength, size - position);
            const bytes_read = await new Promise<number>((resolve, reject) => {
                fs.read(fd, chunk, 0, length, position, (error, read) => {
                    if (error) reject(error);
                    else resolve(read);
                });
            });
            if (bytes_read === 0) {
                throw new Error(`Unexpected EOF while hashing ${this.format} file`);
            }
            digest.update(chunk.subarray(0, bytes_read));
            position += bytes_read;
        }
        if (is_cancelled()) throw abort_error(this.format);
        return digest.digest('hex');
    }
}

/**
 * Open `file_path`, build a source over its descriptor with `build` (which
 * takes ownership of the `SourceFile` once it returns), and observe the file.
 * Any failure closes what was opened and is reported as "Could not open
 * <format> file", except cancellation, which stays an AbortError.
 */
export async function open_file_source<S extends { close(): void }>(
    file_path: string,
    format: string,
    include_digest: boolean,
    is_cancelled: () => boolean,
    build: (file: SourceFile) => S,
): Promise<ObservedFileSource<S>> {
    let file: SourceFile | undefined;
    let source: S | undefined;
    try {
        if (is_cancelled()) throw abort_error(format);
        file = new SourceFile(fs.openSync(file_path, 'r'), file_path, format);
        source = build(file);
        if (is_cancelled()) throw abort_error(format);
        const observed = await file.observe(include_digest, is_cancelled);
        return { source, ...observed };
    } catch (error) {
        if (source !== undefined) source.close();
        else file?.close();
        if (error instanceof Error && error.name === 'AbortError') throw error;
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not open ${format} file: ${detail}`, { cause: error });
    }
}
