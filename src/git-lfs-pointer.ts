/**
 * Recognizing a Git LFS pointer file, so pointer text is never handed to a
 * table parser.
 *
 * A repository cloned without the LFS smudge filter — `GIT_LFS_SKIP_SMUDGE`,
 * or simply no `git-lfs` on the machine — leaves every LFS-tracked file on
 * disk as a small text stanza naming the real object. Read as a table, a
 * `.csv` pointer parses into a plausible-looking three-row grid and an `.xlsx`
 * pointer fails deep inside the ZIP reader; neither outcome tells the user the
 * bytes they wanted were never fetched. The compare path meets the same stanza
 * unavoidably: a `git:`-scheme read returns the *committed* blob, and for an
 * LFS-tracked file that blob is the pointer whether or not the working tree
 * was smudged.
 *
 * So this parser is deliberately strict, and its strictness is load-bearing in
 * one direction only. A false negative degrades to today's behaviour. A false
 * positive replaces a real table with an empty grid and a banner, so every
 * field is validated against the v1 spec
 * (https://github.com/git-lfs/git-lfs/blob/main/docs/spec.md) and anything
 * unexpected refuses:
 *
 * - `version https://git-lfs.github.com/spec/v1` is the required first line.
 * - Remaining keys are `key value` pairs, LF-terminated, in byte order, and
 *   the required `oid`/`size` must both be present.
 * - The oid must be `sha256:` and 64 lowercase hex digits.
 * - `size` is a non-negative decimal integer with no sign, padding, or
 *   separators.
 *
 * `MAX_POINTER_BYTES` is the spec's own ceiling, and the reason a caller may
 * pass any file's bytes here cheaply: a longer input refuses on its length
 * before a single byte is decoded.
 */

/** The spec's hard limit on a pointer file, in bytes. */
const MAX_POINTER_BYTES = 1024;

const VERSION_LINE = 'version https://git-lfs.github.com/spec/v1';
const OID_PATTERN = /^sha256:([0-9a-f]{64})$/u;
const SIZE_PATTERN = /^(?:0|[1-9][0-9]*)$/u;
/** Keys are lowercase letters, digits, hyphen and period per the spec. */
const KEY_PATTERN = /^[a-z0-9.-]+$/u;

/** An unresolved Git LFS object, identified well enough to fetch it. */
export interface GitLfsPointer {
    /** The 64-hex-digit sha256 of the real object (without the `sha256:` prefix). */
    readonly oid: string;
    /** Byte length of the real object, per the pointer. */
    readonly size: number;
}

/**
 * The pointer `raw` describes, or undefined when `raw` is not a pointer file.
 *
 * Undefined is the answer for every ordinary table as well as for a malformed
 * or truncated stanza: this function's job is to recognize a pointer, not to
 * diagnose one. A file that *looks* like a damaged pointer is far more likely
 * to be a small text file that happens to share a prefix.
 */
export function parse_git_lfs_pointer(raw: Uint8Array): GitLfsPointer | undefined {
    if (raw.byteLength === 0 || raw.byteLength > MAX_POINTER_BYTES) return undefined;
    let text: string;
    try {
        // A pointer is UTF-8 (in practice ASCII); binary table formats reject
        // here rather than being decoded lossily into something scannable.
        text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
    } catch {
        return undefined;
    }
    // Exactly LF-terminated lines, including the last: the spec requires the
    // trailing newline, and `split` would otherwise report a phantom final
    // entry that has to be special-cased away.
    if (!text.endsWith('\n')) return undefined;
    const lines = text.slice(0, -1).split('\n');
    if (lines.length < 3 || lines[0] !== VERSION_LINE) return undefined;

    let previous_key: string | undefined;
    let oid: string | undefined;
    let size: number | undefined;
    for (const line of lines.slice(1)) {
        const separator = line.indexOf(' ');
        if (separator <= 0) return undefined;
        const key = line.slice(0, separator);
        const value = line.slice(separator + 1);
        // A value is the rest of the line, so an empty one — or a second space
        // where the key should have ended — is a malformed stanza, not a key
        // carrying whitespace.
        if (value === '' || !KEY_PATTERN.test(key)) return undefined;
        // Byte order over the keys after `version`, which the spec fixes so a
        // pointer has one canonical spelling. Repeated keys fail the same test.
        if (previous_key !== undefined && key <= previous_key) return undefined;
        previous_key = key;
        if (key === 'oid') {
            const matched = OID_PATTERN.exec(value);
            if (!matched) return undefined;
            oid = matched[1];
        } else if (key === 'size') {
            if (!SIZE_PATTERN.test(value)) return undefined;
            const parsed = Number(value);
            if (!Number.isSafeInteger(parsed)) return undefined;
            size = parsed;
        }
        // Unknown keys are permitted by the spec and carry no meaning here.
        // They still have to be well-formed and ordered, which the checks
        // above have already established.
    }
    return oid !== undefined && size !== undefined ? { oid, size } : undefined;
}
