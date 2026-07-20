import { describe, expect, it } from 'vitest';
import * as vscode_mock from './mocks/vscode';
import {
    canonical_file_key,
    create_resource_identity,
    resource_identity_matches,
} from '../resource-identity';

describe('resource identity', () => {
    it('keeps file state keys backward-compatible with canonical paths', () => {
        const identity = create_resource_identity(
            vscode_mock.Uri.file('C:\\Data\\Book.xlsx'),
            'win32',
        );
        expect(identity.stateKey).toBe(canonical_file_key('C:\\Data\\Book.xlsx', 'win32'));
        expect(create_resource_identity(
            vscode_mock.Uri.file('c:\\data\\book.xlsx'),
            'win32',
        ).key).toBe(identity.key);
    });

    it('includes provider scheme, authority, path, and query but ignores fragment', () => {
        const base = vscode_mock.Uri.from({
            scheme: 'memfs',
            authority: 'workspace-a',
            path: '/reports/book.xlsx',
            query: 'branch=main',
            fragment: 'view-a',
            fsPath: '/same/book.xlsx',
        });
        const identity = create_resource_identity(base);
        expect(resource_identity_matches(identity, base.with({ fragment: 'view-b' }))).toBe(true);
        expect(resource_identity_matches(identity, vscode_mock.Uri.from({
            scheme: 'memfs', authority: 'workspace-b', path: '/reports/book.xlsx',
            query: 'branch=main', fragment: '', fsPath: '/same/book.xlsx',
        }))).toBe(false);
        expect(resource_identity_matches(identity, vscode_mock.Uri.from({
            scheme: 'otherfs', authority: 'workspace-a', path: '/reports/book.xlsx',
            query: 'branch=main', fragment: '', fsPath: '/same/book.xlsx',
        }))).toBe(false);
        expect(resource_identity_matches(identity, base.with({ query: 'branch=other' }))).toBe(false);
    });
});
