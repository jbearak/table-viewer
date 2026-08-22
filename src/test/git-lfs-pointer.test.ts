/**
 * Recognizing Git LFS pointer files.
 *
 * The asymmetry in these tests is deliberate and mirrors the parser's: a false
 * negative degrades to the old behaviour, while a false positive replaces a
 * real table with an empty grid. So the refusal cases carry the weight, and the
 * ones that matter most are the near-misses — a small CSV whose first cell
 * happens to mention LFS, a truncated stanza, a pointer with the right keys in
 * the wrong order.
 */
import { describe, expect, it } from 'vitest';
import { parse_git_lfs_pointer } from '../git-lfs-pointer';

const OID = 'a'.repeat(64);
const enc = (text: string) => new TextEncoder().encode(text);

function pointer(body = `oid sha256:${OID}\nsize 12345\n`): Uint8Array {
    return enc(`version https://git-lfs.github.com/spec/v1\n${body}`);
}

describe('parse_git_lfs_pointer', () => {
    it('reads the oid and size from a canonical pointer', () => {
        expect(parse_git_lfs_pointer(pointer())).toEqual({ oid: OID, size: 12345 });
    });

    it('accepts a size of zero, which is a legal empty object', () => {
        expect(parse_git_lfs_pointer(pointer(`oid sha256:${OID}\nsize 0\n`)))
            .toEqual({ oid: OID, size: 0 });
    });

    it('accepts unknown keys, which the spec permits', () => {
        // Ordered: `ext-0` sorts before `oid` before `size`.
        expect(parse_git_lfs_pointer(
            pointer(`ext-0 something\noid sha256:${OID}\nsize 7\n`),
        )).toEqual({ oid: OID, size: 7 });
    });

    it('refuses a CSV that merely mentions Git LFS', () => {
        // The false positive that would matter: a real, readable table whose
        // content is about LFS. Nothing here is a pointer stanza.
        expect(parse_git_lfs_pointer(enc(
            'tool,note\ngit-lfs,version https://git-lfs.github.com/spec/v1\n',
        ))).toBeUndefined();
    });

    it('refuses a file whose first line is the version but which is not a stanza', () => {
        expect(parse_git_lfs_pointer(enc(
            'version https://git-lfs.github.com/spec/v1\nsome,csv,row\nanother,csv,row\n',
        ))).toBeUndefined();
    });

    it('refuses a pointer missing the oid or the size', () => {
        expect(parse_git_lfs_pointer(pointer('size 5\n'))).toBeUndefined();
        expect(parse_git_lfs_pointer(pointer(`oid sha256:${OID}\n`))).toBeUndefined();
    });

    it('refuses keys that are out of order or repeated', () => {
        expect(parse_git_lfs_pointer(pointer(`size 5\noid sha256:${OID}\n`)))
            .toBeUndefined();
        expect(parse_git_lfs_pointer(
            pointer(`oid sha256:${OID}\noid sha256:${OID}\nsize 5\n`),
        )).toBeUndefined();
    });

    it('refuses a non-sha256 or malformed oid', () => {
        expect(parse_git_lfs_pointer(pointer(`oid sha1:${'a'.repeat(40)}\nsize 5\n`)))
            .toBeUndefined();
        expect(parse_git_lfs_pointer(pointer(`oid sha256:${'a'.repeat(63)}\nsize 5\n`)))
            .toBeUndefined();
        // Uppercase hex is not the canonical spelling git-lfs writes.
        expect(parse_git_lfs_pointer(pointer(`oid sha256:${'A'.repeat(64)}\nsize 5\n`)))
            .toBeUndefined();
    });

    it('refuses a size that is not a bare non-negative integer', () => {
        for (const size of ['-1', '+5', '5 ', '0x10', '1_000', '1.5', '007', '']) {
            expect(parse_git_lfs_pointer(pointer(`oid sha256:${OID}\nsize ${size}\n`)))
                .toBeUndefined();
        }
    });

    it('requires the trailing newline and rejects CRLF', () => {
        expect(parse_git_lfs_pointer(enc(
            `version https://git-lfs.github.com/spec/v1\noid sha256:${OID}\nsize 5`,
        ))).toBeUndefined();
        expect(parse_git_lfs_pointer(enc(
            `version https://git-lfs.github.com/spec/v1\r\noid sha256:${OID}\r\nsize 5\r\n`,
        ))).toBeUndefined();
    });

    it('refuses empty input and anything over the 1 KiB spec ceiling', () => {
        expect(parse_git_lfs_pointer(new Uint8Array(0))).toBeUndefined();
        const padded = pointer(
            `oid sha256:${OID}\nsize 5\nz-pad ${'x'.repeat(1024)}\n`,
        );
        expect(padded.byteLength).toBeGreaterThan(1024);
        expect(parse_git_lfs_pointer(padded)).toBeUndefined();
    });

    it('refuses binary input without decoding it lossily', () => {
        // An .xlsx begins `PK\x03\x04`; invalid UTF-8 must not become
        // scannable text. 0xff/0xfe are not valid UTF-8 in any position.
        expect(parse_git_lfs_pointer(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe])))
            .toBeUndefined();
    });
});
