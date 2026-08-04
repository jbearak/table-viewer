import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    original_file_resource_path,
    UnsafeRecoveryExportTargetError,
    write_recovery_export_safely,
} from '../src/recovery-export-safety';

const roots: string[] = [];

function fixture(): { root: string; state: string; source: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-recovery-export-'));
    roots.push(root);
    const state = path.join(root, 'global-storage', 'state');
    fs.mkdirSync(state, { recursive: true });
    const source = path.join(root, 'source.csv');
    fs.writeFileSync(source, 'source bytes');
    return { root, state, source };
}

function write(targetPath: string, stateRootPath: string, originalSourcePath?: string): void {
    write_recovery_export_safely({
        targetPath,
        stateRootPath,
        originalSourcePath,
        contents: '{"safe":true}',
    });
}

afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('real-filesystem recovery export safety', () => {
    it('writes an ordinary export outside state and the original resource', () => {
        const { root, state, source } = fixture();
        const target = path.join(root, 'exports', 'bundle.json');
        fs.mkdirSync(path.dirname(target));

        write(target, state, source);

        expect(fs.readFileSync(target, 'utf8')).toBe('{"safe":true}');
        expect(fs.readFileSync(source, 'utf8')).toBe('source bytes');
    });

    it('creates a new ordinary export safely when no-follow open is unavailable', () => {
        const { root, state, source } = fixture();
        const target = path.join(root, 'windows-style-export.json');

        write_recovery_export_safely({
            targetPath: target,
            stateRootPath: state,
            originalSourcePath: source,
            contents: '{"safe":true}',
            forceNoFollowUnavailable: true,
        });

        expect(fs.readFileSync(target, 'utf8')).toBe('{"safe":true}');
        expect(fs.readFileSync(source, 'utf8')).toBe('source bytes');
    });

    it('treats a zero-valued no-follow flag as unavailable', () => {
        const { root, state, source } = fixture();
        const target = path.join(root, 'zero-no-follow-export.json');
        fs.writeFileSync(target, 'existing bytes');

        expect(() => write_recovery_export_safely({
            targetPath: target,
            stateRootPath: state,
            originalSourcePath: source,
            contents: '{"safe":true}',
            noFollowFlagForTest: 0,
        })).toThrow(UnsafeRecoveryExportTargetError);
        expect(fs.readFileSync(target, 'utf8')).toBe('existing bytes');
    });

    it('fails closed on an existing destination when no-follow open is unavailable', () => {
        const { root, state, source } = fixture();
        const target = path.join(root, 'existing-windows-style-export.json');
        fs.writeFileSync(target, 'existing bytes');

        expect(() => write_recovery_export_safely({
            targetPath: target,
            stateRootPath: state,
            originalSourcePath: source,
            contents: '{"safe":true}',
            forceNoFollowUnavailable: true,
        })).toThrow(UnsafeRecoveryExportTargetError);
        expect(fs.readFileSync(target, 'utf8')).toBe('existing bytes');
    });

    it('does not overwrite an ordinary leaf created after absent-target validation', () => {
        const { root, state, source } = fixture();
        const target = path.join(root, 'raced-ordinary-export.json');

        expect(() => write_recovery_export_safely({
            targetPath: target,
            stateRootPath: state,
            originalSourcePath: source,
            contents: '{"safe":true}',
            beforeOpen: () => fs.writeFileSync(target, 'raced bytes'),
        })).toThrow(UnsafeRecoveryExportTargetError);
        expect(fs.readFileSync(target, 'utf8')).toBe('raced bytes');
        expect(fs.readFileSync(source, 'utf8')).toBe('source bytes');
    });

    it.runIf(process.platform !== 'win32')('does not overwrite a replacement for the validated existing file', () => {
        const { root, state, source } = fixture();
        const selectedDirectory = path.join(root, 'selected');
        const replacementDirectory = path.join(root, 'replacement');
        fs.mkdirSync(selectedDirectory);
        fs.mkdirSync(replacementDirectory);
        const target = path.join(selectedDirectory, 'bundle.json');
        const replacement = path.join(replacementDirectory, 'bundle.json');
        fs.writeFileSync(target, 'selected bytes');
        fs.writeFileSync(replacement, 'replacement bytes');

        expect(() => write_recovery_export_safely({
            targetPath: target,
            stateRootPath: state,
            originalSourcePath: source,
            contents: '{"safe":true}',
            beforeOpen: () => {
                fs.renameSync(selectedDirectory, `${selectedDirectory}-away`);
                fs.renameSync(replacementDirectory, selectedDirectory);
            },
        })).toThrow(UnsafeRecoveryExportTargetError);
        expect(fs.readFileSync(path.join(selectedDirectory, 'bundle.json'), 'utf8'))
            .toBe('replacement bytes');
        expect(fs.readFileSync(path.join(`${selectedDirectory}-away`, 'bundle.json'), 'utf8'))
            .toBe('selected bytes');
    });

    it.runIf(process.platform !== 'win32')('does not recreate a validated existing target removed before open', () => {
        const { root, state, source } = fixture();
        const target = path.join(root, 'removed-before-open.json');
        fs.writeFileSync(target, 'selected bytes');

        expect(() => write_recovery_export_safely({
            targetPath: target,
            stateRootPath: state,
            originalSourcePath: source,
            contents: '{"safe":true}',
            beforeOpen: () => fs.unlinkSync(target),
        })).toThrow();
        expect(fs.existsSync(target)).toBe(false);
    });

    it.runIf(process.platform !== 'win32')('makes an overwritten recovery export private before writing sensitive data', () => {
        const { root, state, source } = fixture();
        const target = path.join(root, 'existing-bundle.json');
        fs.writeFileSync(target, 'old public bytes', { mode: 0o644 });
        fs.chmodSync(target, 0o644);

        write(target, state, source);

        expect(fs.statSync(target).mode & 0o777).toBe(0o600);
        expect(fs.readFileSync(target, 'utf8')).toBe('{"safe":true}');
    });

    it.each([
        'namespace-recovery.sqlite3',
        'namespace-recovery.sqlite3-journal',
        'namespace-recovery.sqlite3-wal',
        'namespace-recovery.sqlite3-shm',
        'namespace-recovery.sqlite3.init-candidate.00000000-0000-4000-8000-000000000000',
        '.namespace-recovery.sqlite3.recovery-gate/readers/export.json',
        'namespace-recovery.sqlite3.recovery.00000000-0000-4000-8000-000000000000/export.json',
    ])('rejects a state-owned target: %s', (relative) => {
        const { state, source } = fixture();
        const target = path.join(state, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, 'state evidence');
        const before = fs.readFileSync(target);

        expect(() => write(target, state, source)).toThrow(UnsafeRecoveryExportTargetError);

        expect(fs.readFileSync(target)).toEqual(before);
    });

    it.runIf(process.platform !== 'win32')('rejects an authority-qualified file URI naming the original POSIX resource', () => {
        const { state, source } = fixture();
        const [, authority, ...segments] = source.split(path.sep);
        const reconstructed = original_file_resource_path({
            scheme: 'file',
            authority,
            path: `/${segments.join('/')}`,
        });

        expect(() => write(source, state, reconstructed)).toThrow(UnsafeRecoveryExportTargetError);
        expect(fs.readFileSync(source, 'utf8')).toBe('source bytes');
    });

    it('rejects the original native resource without truncating it', () => {
        const { state, source } = fixture();

        expect(() => write(source, state, source)).toThrow(UnsafeRecoveryExportTargetError);
        expect(fs.readFileSync(source, 'utf8')).toBe('source bytes');
    });

    it('rejects every original resource protected by a frozen capsule export', () => {
        const { root, state, source } = fixture();
        const secondSource = path.join(root, 'second-source.csv');
        fs.writeFileSync(secondSource, 'second source bytes');

        expect(() => write_recovery_export_safely({
            targetPath: secondSource,
            stateRootPath: state,
            originalSourcePaths: [source, secondSource],
            contents: '{"safe":true}',
        })).toThrow(UnsafeRecoveryExportTargetError);
        expect(fs.readFileSync(secondSource, 'utf8')).toBe('second source bytes');
    });

    it('rejects a hardlink alias to the original native resource', () => {
        const { root, state, source } = fixture();
        const alias = path.join(root, 'source-hardlink.json');
        fs.linkSync(source, alias);

        expect(() => write(alias, state, source)).toThrow(UnsafeRecoveryExportTargetError);
        expect(fs.readFileSync(alias, 'utf8')).toBe('source bytes');
    });

    it.runIf(process.platform !== 'win32')('rechecks the opened inode against state files created during open', () => {
        const { root, state, source } = fixture();
        const target = path.join(root, 'raced-export.json');
        const protectedFile = path.join(state, 'created-during-open.sqlite3');
        fs.writeFileSync(target, 'selected bytes');

        expect(() => write_recovery_export_safely({
            targetPath: target,
            stateRootPath: state,
            originalSourcePath: source,
            contents: '{"safe":true}',
            beforeOpen: () => {
                fs.writeFileSync(protectedFile, 'new protected evidence');
                fs.unlinkSync(target);
                fs.linkSync(protectedFile, target);
            },
        })).toThrow(UnsafeRecoveryExportTargetError);
        expect(fs.readFileSync(protectedFile, 'utf8')).toBe('new protected evidence');
    });

    it('rejects hardlinks to companion files outside the state subtree', () => {
        const { root, state, source } = fixture();
        const database = path.join(state, 'namespace-recovery.sqlite3');
        fs.writeFileSync(database, 'database evidence');
        const alias = path.join(root, 'database-hardlink.json');
        fs.linkSync(database, alias);

        expect(() => write(alias, state, source)).toThrow(UnsafeRecoveryExportTargetError);
        expect(fs.readFileSync(database, 'utf8')).toBe('database evidence');
    });

    it.runIf(process.platform !== 'win32')('rejects a symlinked parent alias into companion state', () => {
        const { root, state, source } = fixture();
        const stateAlias = path.join(root, 'state-alias');
        fs.symlinkSync(state, stateAlias, 'dir');

        expect(() => write(path.join(stateAlias, 'export.json'), state, source))
            .toThrow(UnsafeRecoveryExportTargetError);
    });

    it.runIf(process.platform !== 'win32')('rejects a symlink alias to the original native resource', () => {
        const { root, state, source } = fixture();
        const sourceAlias = path.join(root, 'source-alias.json');
        fs.symlinkSync(source, sourceAlias, 'file');

        expect(() => write(sourceAlias, state, source)).toThrow(UnsafeRecoveryExportTargetError);
        expect(fs.readFileSync(source, 'utf8')).toBe('source bytes');
    });

    it.runIf(process.platform !== 'win32')('rejects the physical path of a missing source beneath a symlinked parent', () => {
        const { root, state } = fixture();
        const physicalParent = path.join(root, 'physical-source-parent');
        const aliasedParent = path.join(root, 'source-parent-alias');
        fs.mkdirSync(physicalParent);
        fs.symlinkSync(physicalParent, aliasedParent, 'dir');
        const originalSource = path.join(aliasedParent, 'missing-source.csv');
        const target = path.join(physicalParent, 'missing-source.csv');

        expect(() => write(target, state, originalSource)).toThrow(UnsafeRecoveryExportTargetError);
        expect(fs.existsSync(target)).toBe(false);
    });
});
