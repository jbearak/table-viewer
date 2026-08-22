// Path completion for the Compare dialog, against a real temp directory: the
// question is what the filesystem says, so a mocked one would test nothing.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    expand_tilde,
    is_existing_directory,
    unique_completion,
} from '../main/compare-path-complete';

let dir: string;

beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-complete-'));
    fs.writeFileSync(path.join(dir, 'merp.xlsx'), '');
    fs.writeFileSync(path.join(dir, 'zebra.csv'), '');
    fs.writeFileSync(path.join(dir, 'zebu.csv'), '');
    fs.mkdirSync(path.join(dir, 'nested'));
});

afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('unique_completion', () => {
    it('completes a prefix that only one file matches', () => {
        expect(unique_completion(path.join(dir, 'me')))
            .toBe(path.join(dir, 'merp.xlsx'));
    });

    it('refuses an ambiguous prefix rather than picking one', () => {
        // 'zebra.csv' and 'zebu.csv' both match. Choosing either would silently
        // open a file the user did not name.
        expect(unique_completion(path.join(dir, 'zeb'))).toBeUndefined();
    });

    it('completes a directory with a trailing separator, so typing continues', () => {
        expect(unique_completion(path.join(dir, 'nes')))
            .toBe(path.join(dir, 'nested') + path.sep);
    });

    it('offers nothing for a path that is already complete', () => {
        expect(unique_completion(path.join(dir, 'merp.xlsx'))).toBeUndefined();
    });

    it('offers nothing for a prefix nothing matches, or an unreadable parent', () => {
        expect(unique_completion(path.join(dir, 'qqq'))).toBeUndefined();
        expect(unique_completion(path.join(dir, 'no-such-dir', 'x'))).toBeUndefined();
    });

    it('offers nothing once the path already names a folder', () => {
        // A trailing separator means there is no partial segment to finish.
        expect(unique_completion(path.join(dir, 'nested') + path.sep)).toBeUndefined();
    });

    it('expands ~ against the supplied home before looking', () => {
        expect(unique_completion(`~${path.sep}me`, dir))
            .toBe(path.join(dir, 'merp.xlsx'));
    });
});

describe('is_existing_directory', () => {
    it('separates a folder from a file and from nothing at all', () => {
        expect(is_existing_directory(dir)).toBe(true);
        expect(is_existing_directory(path.join(dir, 'merp.xlsx'))).toBe(false);
        expect(is_existing_directory(path.join(dir, 'nope'))).toBe(false);
        expect(is_existing_directory('   ')).toBe(false);
    });

    it('recognizes ~ itself as the home directory', () => {
        expect(is_existing_directory('~', dir)).toBe(true);
    });
});

describe('expand_tilde', () => {
    it('leaves a path alone when there is no home to expand against', () => {
        expect(expand_tilde('~/x')).toBe('~/x');
        // A tilde inside the path is part of a filename, not a home reference.
        expect(expand_tilde('/tmp/~x', '/home/j')).toBe('/tmp/~x');
    });

    it('expands a forward-slash tilde path on every platform', () => {
        // `~/x` is what people type, and what every shell takes, on Windows as
        // much as anywhere. Matching only `path.sep` left it unexpanded there,
        // so the dialog validated and then opened the literal path.
        expect(expand_tilde('~/x', path.join(path.sep, 'home', 'j')))
            .toBe(path.join(path.sep, 'home', 'j', 'x'));
        expect(expand_tilde(`~${path.sep}x`, path.join(path.sep, 'home', 'j')))
            .toBe(path.join(path.sep, 'home', 'j', 'x'));
        // Still only a leading `~` followed by a separator: `~other` is a name.
        expect(expand_tilde('~other/x', '/home/j')).toBe('~other/x');
    });
});
