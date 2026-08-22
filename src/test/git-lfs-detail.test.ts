/**
 * The banner's failure detail, checked against stderr captured verbatim from
 * git-lfs 3.7.1 driving a real repository.
 *
 * These fixtures are the point of the file. The sanitizer looked correct
 * against invented one-line inputs and was wrong against the real thing: the
 * useful line repeats a 64-character oid four times, git-lfs echoes the pointer
 * stanza to stderr, and the whole message runs well past what a banner can
 * show.
 */
import { describe, expect, it } from 'vitest';
import { sanitized_detail } from '../node-git-lfs';

/** Verbatim `git lfs smudge` stderr for an object missing from the remote. */
const MISSING_OBJECT = [
    'Downloading data.csv (27 B)',
    'version https://git-lfs.github.com/spec/v1',
    `oid sha256:${'f'.repeat(64)}`,
    'size 27',
    `Error downloading object: data.csv (fffffff): Smudge error: Error downloading data.csv (${'f'.repeat(64)}): error transferring "${'f'.repeat(64)}": [0] remote missing object ${'f'.repeat(64)}`,
].join('\n');

/** Verbatim stderr when `git` runs but has no `lfs` subcommand. */
const NO_SUBCOMMAND = "git: 'lfs' is not a git command. See 'git --help'.\n\nThe most similar command is\n\tlog\n";

describe('sanitized_detail', () => {
    it('reduces a real missing-object error to one readable sentence', () => {
        const detail = sanitized_detail(MISSING_OBJECT)!;
        expect(detail).toBe(
            'Error downloading object: data.csv (…): Smudge error: Error downloading data.csv (…): error transferring "…": [0] remote missing object …',
        );
        // The progress line is not the failure, and the echoed pointer stanza
        // is not a reason — quoting either would tell the user nothing.
        expect(detail).not.toContain('Downloading data.csv (27 B)');
        expect(detail).not.toContain('git-lfs.github.com');
        // Long hex runs are collapsed rather than shown four times over.
        expect(detail).not.toContain('fffffff');
    });

    it('keeps a real missing-subcommand message intact', () => {
        expect(sanitized_detail(NO_SUBCOMMAND))
            .toBe("git: 'lfs' is not a git command. See 'git --help'.");
    });

    it('drops any line carrying a path or a URL', () => {
        // The one hard guarantee: this text renders in a webview, and a remote
        // URL is where a token would appear.
        expect(sanitized_detail('https://user:token@git.example.com/repo.git failed'))
            .toBeUndefined();
        expect(sanitized_detail('/Users/someone/private/repo/data.csv is missing'))
            .toBeUndefined();
        // A later clean line is still usable.
        expect(sanitized_detail('https://host/x failed\nAuthentication required'))
            .toBe('Authentication required');
    });

    it('caps an unbounded message and reports nothing for empty stderr', () => {
        expect(sanitized_detail(`${'word '.repeat(200)}`)!.length).toBeLessThanOrEqual(200);
        expect(sanitized_detail('')).toBeUndefined();
        expect(sanitized_detail('\n  \n')).toBeUndefined();
    });
});
