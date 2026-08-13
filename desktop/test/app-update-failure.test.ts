import { describe, expect, it } from 'vitest';
import {
    app_update_failure_dialog,
    classify_app_update_failure,
    type AppUpdateFailure,
} from '../main/app-update-failure';

describe('desktop app update failures', () => {
    it.each([
        'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND',
    ])('classifies missing release metadata from %s', (code) => {
        expect(classify_app_update_failure('check', { code }, true)).toEqual({
            phase: 'check',
            kind: 'release-metadata-missing',
        });
    });

    it.each([
        'ERR_UPDATER_ASSET_NOT_FOUND',
    ])('classifies missing release downloads from %s', (code) => {
        expect(classify_app_update_failure('download', { code }, true)).toEqual({
            phase: 'download',
            kind: 'release-artifact-missing',
        });
    });

    it.each([
        'ERR_CHECKSUM_MISMATCH',
        'ERR_UPDATER_INVALID_RELEASE_FEED',
        'ERR_UPDATER_INVALID_SIGNATURE',
        'ERR_UPDATER_INVALID_UPDATE_INFO',
        'ERR_UPDATER_INVALID_VERSION',
        'ERR_UPDATER_NO_CHECKSUM',
        'ERR_UPDATER_NO_FILES_PROVIDED',
        'ERR_UPDATER_RELEASE_NOT_FOUND',
        'ERR_UPDATER_ZIP_FILE_NOT_FOUND',
    ])('classifies invalid release information from %s', (code) => {
        expect(classify_app_update_failure('check', { code }, true)).toEqual({
            phase: 'check',
            kind: 'release-information-invalid',
        });
    });

    it('keeps definitive publication errors ahead of a later offline snapshot', () => {
        expect(classify_app_update_failure(
            'check',
            { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' },
            false,
        ).kind).toBe('release-metadata-missing');
    });

    it('recognizes only a missing Table Viewer GitHub release download', () => {
        const missing = 'Cannot download "https://github.com/jbearak/table-viewer/releases/download/v2.0.0/table-viewer-2.0.0-arm64.zip", status 404: Not Found';
        expect(classify_app_update_failure('download', new Error(missing), true).kind)
            .toBe('release-artifact-missing');
        expect(classify_app_update_failure('check', new Error(missing), true).kind)
            .toBe('unknown');
        expect(classify_app_update_failure(
            'download',
            new Error('Cannot download "https://example.com/releases/download/v2/app.zip", status 404: Not Found'),
            true,
        ).kind).toBe('unknown');
        expect(classify_app_update_failure(
            'download',
            new Error('Cannot download "https://github.com/another/repo/releases/download/v2/app.zip", status 410: Gone'),
            true,
        ).kind).toBe('unknown');
    });

    it.each([
        { error: new Error('net::ERR_INTERNET_DISCONNECTED'), online: true },
        { error: { code: 'ENETDOWN' }, online: true },
        { error: new Error('anything'), online: false },
    ])('identifies strong offline evidence', ({ error, online }) => {
        expect(classify_app_update_failure('check', error, online).kind)
            .toBe('internet-unavailable');
    });

    it.each([
        { statusCode: 408 },
        { statusCode: 429 },
        { statusCode: 503 },
        { code: 'HTTP_ERROR_502' },
        { code: 'ENOTFOUND' },
        { code: 'ENETUNREACH' },
        { message: 'net::ERR_ADDRESS_UNREACHABLE' },
        { message: 'net::ERR_CONNECTION_TIMED_OUT' },
        {
            code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND',
            cause: { message: 'net::ERR_NAME_NOT_RESOLVED' },
        },
        { message: 'HttpError: 503 Service Unavailable' },
        { message: 'Cannot download "https://github.com/jbearak/table-viewer/releases/download/v2/app.zip", status 503: Service Unavailable' },
    ])('identifies an unavailable update service from $error', (error) => {
        expect(classify_app_update_failure('check', error, true).kind)
            .toBe('update-service-unavailable');
    });

    it.each([
        { code: 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' },
        {
            code: 'ERR_XML_MISSED_ELEMENT',
            message: 'No published versions on GitHub',
        },
        {
            code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND',
            message: 'Unable to find latest version on GitHub: HttpError: 404 Not Found',
        },
    ])('identifies a missing production release from $code', (error) => {
        expect(classify_app_update_failure('check', error, true).kind)
            .toBe('production-release-missing');
        expect(classify_app_update_failure('check', error, false).kind)
            .toBe('production-release-missing');
    });

    it('does not mistake a wrapped GitHub rejection for a missing release', () => {
        expect(classify_app_update_failure('check', {
            code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND',
            message: 'Unable to find latest version on GitHub: HttpError: 403 rate limit exceeded',
        }, true).kind).toBe('update-service-unavailable');
        expect(classify_app_update_failure('check', {
            code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND',
            message: 'Unable to find latest version on GitHub: HttpError: 403 Forbidden',
        }, true).kind).toBe('unknown');
    });

    it('preserves explicit offline evidence wrapped by a latest-release error', () => {
        expect(classify_app_update_failure('check', {
            code: 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND',
            message: 'wrapped: net::ERR_INTERNET_DISCONNECTED',
        }, true).kind).toBe('internet-unavailable');
    });

    it('keeps definitive service responses ahead of a later offline snapshot', () => {
        expect(classify_app_update_failure('check', { statusCode: 503 }, false).kind)
            .toBe('update-service-unavailable');
    });

    it.each([
        null,
        undefined,
        'net::ERR_INTERNET_DISCONNECTED',
        503,
        { statusCode: 404 },
        { code: 'HTTP_ERROR_403' },
        new Error('/Users/person/private/latest-mac.yml failed'),
        { message: 'Request has been aborted by the server' },
    ])('uses an unknown fallback for an unclassified value', (error) => {
        expect(classify_app_update_failure('check', error, true).kind).toBe('unknown');
    });

    it('does not invoke hostile accessors or follow an unbounded cause chain', () => {
        let reads = 0;
        const hostile = {
            get code() { reads += 1; throw new Error('secret'); },
            get message() { reads += 1; throw new Error('secret'); },
            cause: { cause: { cause: { cause: { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' } } } },
        };
        expect(classify_app_update_failure('check', hostile, true).kind).toBe('unknown');
        expect(reads).toBeGreaterThan(0);
    });

    it('caps diagnostic strings before searching them', () => {
        const error = new Error(`${'x'.repeat(20_000)}net::ERR_INTERNET_DISCONNECTED`);
        expect(classify_app_update_failure('check', error, true).kind).toBe('unknown');
    });

    it('generates fixed phase-specific wording without source diagnostics', () => {
        const failures: AppUpdateFailure[] = [
            { phase: 'check', kind: 'internet-unavailable' },
            { phase: 'check', kind: 'update-service-unavailable' },
            { phase: 'check', kind: 'release-metadata-missing' },
            { phase: 'download', kind: 'release-artifact-missing' },
            { phase: 'check', kind: 'production-release-missing' },
            { phase: 'check', kind: 'release-information-invalid' },
            { phase: 'download', kind: 'unknown' },
        ];
        const dialogs = failures.map(app_update_failure_dialog);

        expect(dialogs[0]).toMatchObject({
            message: 'Couldn’t check for updates.',
            buttons: ['OK'],
            defaultId: 0,
            cancelId: 0,
            open_releases_response: undefined,
        });
        expect(dialogs[3].message).toBe('Couldn’t download the update.');
        for (const wording of dialogs) {
            const text = `${wording.message}\n${wording.detail}`;
            expect(text).not.toMatch(/https?:\/\//i);
            expect(text).not.toMatch(/latest-(?:mac|arm64)\.yml|\/Users\/|Authorization|secret/i);
            if (wording.buttons.length === 2) {
                expect(wording).toMatchObject({
                    buttons: ['Open GitHub Releases', 'OK'],
                    defaultId: 1,
                    cancelId: 1,
                    open_releases_response: 0,
                });
            }
        }
    });
});
