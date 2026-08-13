import { REPOSITORY_URL } from './about-links';

export type AppUpdateFailurePhase = 'check' | 'download';

export type AppUpdateFailureKind =
    | 'internet-unavailable'
    | 'update-service-unavailable'
    | 'release-metadata-missing'
    | 'release-artifact-missing'
    | 'production-release-missing'
    | 'release-information-invalid'
    | 'unknown';

export interface AppUpdateFailure {
    readonly phase: AppUpdateFailurePhase;
    readonly kind: AppUpdateFailureKind;
}

export interface AppUpdateFailureDialog {
    readonly message: string;
    readonly detail: string;
    readonly buttons: readonly string[];
    readonly defaultId: number;
    readonly cancelId: number;
    readonly open_releases_response: number | undefined;
}

const MAX_DIAGNOSTIC_LENGTH = 16_384;
const REPOSITORY_RELEASE_DOWNLOAD_URL = `${REPOSITORY_URL}/releases/download/`;

const MISSING_METADATA_CODES = new Set([
    'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND',
]);

const MISSING_ARTIFACT_CODES = new Set([
    'ERR_UPDATER_ASSET_NOT_FOUND',
]);

const INVALID_RELEASE_CODES = new Set([
    'ERR_CHECKSUM_MISMATCH',
    'ERR_UPDATER_INVALID_RELEASE_FEED',
    'ERR_UPDATER_INVALID_SIGNATURE',
    'ERR_UPDATER_INVALID_UPDATE_INFO',
    'ERR_UPDATER_INVALID_VERSION',
    'ERR_UPDATER_NO_CHECKSUM',
    'ERR_UPDATER_NO_FILES_PROVIDED',
    'ERR_UPDATER_RELEASE_NOT_FOUND',
    'ERR_UPDATER_ZIP_FILE_NOT_FOUND',
]);

const OFFLINE_TOKENS = [
    'ERR_INTERNET_DISCONNECTED',
    'ENETDOWN',
] as const;

const SERVICE_TRANSPORT_TOKENS = [
    'ERR_ADDRESS_UNREACHABLE',
    'ERR_NAME_NOT_RESOLVED',
    'ERR_CONNECTION_CLOSED',
    'ERR_CONNECTION_REFUSED',
    'ERR_CONNECTION_RESET',
    'ERR_CONNECTION_TIMED_OUT',
    'ERR_NETWORK_CHANGED',
    'ERR_PROXY_CONNECTION_FAILED',
    'ERR_TUNNEL_CONNECTION_FAILED',
    'EAI_AGAIN',
    'ECONNREFUSED',
    'ECONNRESET',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ENOTFOUND',
    'ETIMEDOUT',
] as const;

function safe_property(value: unknown, key: string): unknown {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
        return undefined;
    }
    try {
        return Reflect.get(value, key);
    } catch {
        return undefined;
    }
}

function bounded_string(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    return value.slice(0, MAX_DIAGNOSTIC_LENGTH);
}

function error_code(error: unknown): string | undefined {
    return bounded_string(safe_property(error, 'code'));
}

function error_status(error: unknown): number | undefined {
    const status = safe_property(error, 'statusCode');
    return typeof status === 'number' && Number.isSafeInteger(status) ? status : undefined;
}

function diagnostic_text(error: unknown): string {
    const parts: string[] = [];
    let current: unknown = error;
    const visited = new Set<object>();

    for (let depth = 0; depth < 4 && current != null; depth += 1) {
        if ((typeof current === 'object' || typeof current === 'function')) {
            if (visited.has(current)) break;
            visited.add(current);
        }
        for (const key of ['code', 'message', 'name'] as const) {
            const part = bounded_string(safe_property(current, key));
            if (part) parts.push(part);
        }
        current = safe_property(current, 'cause');
    }

    return parts.join('\n').slice(0, MAX_DIAGNOSTIC_LENGTH);
}

function includes_any(text: string, tokens: readonly string[]): boolean {
    return tokens.some((token) => text.includes(token));
}

function http_status_from_code(code: string | undefined): number | undefined {
    const match = /^HTTP_ERROR_(\d{3})$/.exec(code ?? '');
    if (!match) return undefined;
    return Number(match[1]);
}

function is_missing_github_artifact(phase: AppUpdateFailurePhase, text: string): boolean {
    if (phase !== 'download') return false;
    const prefix = `Cannot download "${REPOSITORY_RELEASE_DOWNLOAD_URL}`;
    const start = text.indexOf(prefix);
    if (start < 0) return false;
    const suffix = text.slice(start + prefix.length);
    return /^[^"\s]+", status (?:404|410):/i.test(suffix);
}

function has_service_http_status(text: string): boolean {
    return /(?:HTTP(?: error)?|HttpError:|status(?:Code)?\D{0,3})\s*(?:408|429|5\d\d)\b/i
        .test(text);
}

function has_service_rate_limit(text: string): boolean {
    return /(?:rate limit|too many requests)/i.test(text);
}

function is_missing_production_release(code: string | undefined, text: string): boolean {
    if (code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS') return true;
    if (code === 'ERR_XML_MISSED_ELEMENT'
        && text.includes('No published versions on GitHub')) return true;
    return code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND'
        && /(?:HttpError:\s*404\b|status(?:Code)?\D{0,3}404\b)/i.test(text);
}

export function classify_app_update_failure(
    phase: AppUpdateFailurePhase,
    error: unknown,
    is_online: boolean | undefined,
): AppUpdateFailure {
    const code = error_code(error);
    const text = diagnostic_text(error);

    if (code && MISSING_METADATA_CODES.has(code)) {
        return { phase, kind: 'release-metadata-missing' };
    }
    if (code && MISSING_ARTIFACT_CODES.has(code)) {
        return { phase, kind: 'release-artifact-missing' };
    }
    if (code && INVALID_RELEASE_CODES.has(code)) {
        return { phase, kind: 'release-information-invalid' };
    }
    if (is_missing_github_artifact(phase, text)) {
        return { phase, kind: 'release-artifact-missing' };
    }

    const status = error_status(error) ?? http_status_from_code(code);
    if (status === 408 || status === 429 || (status != null && status >= 500 && status <= 599)) {
        return { phase, kind: 'update-service-unavailable' };
    }
    if (has_service_http_status(text)
        || has_service_rate_limit(text)
        || includes_any(text, SERVICE_TRANSPORT_TOKENS)) {
        return { phase, kind: 'update-service-unavailable' };
    }
    if (includes_any(text, OFFLINE_TOKENS)) {
        return { phase, kind: 'internet-unavailable' };
    }
    if (is_missing_production_release(code, text)) {
        return { phase, kind: 'production-release-missing' };
    }
    if (is_online === false) {
        return { phase, kind: 'internet-unavailable' };
    }

    return { phase, kind: 'unknown' };
}

export function app_update_failure_dialog(
    failure: AppUpdateFailure,
): AppUpdateFailureDialog {
    const message = failure.phase === 'check'
        ? 'Couldn’t check for updates.'
        : 'Couldn’t download the update.';

    switch (failure.kind) {
        case 'internet-unavailable':
            return {
                message,
                detail: 'This device appears to be offline. Connect to the internet, then check again.',
                buttons: ['OK'],
                defaultId: 0,
                cancelId: 0,
                open_releases_response: undefined,
            };
        case 'update-service-unavailable':
            return external_action_dialog(
                message,
                'Table Viewer could not reach GitHub’s update service. Your general internet connection may still be working. Try again later, or check GitHub Releases in your browser.',
            );
        case 'release-metadata-missing':
            return external_action_dialog(
                message,
                'The latest release is missing the update-information file required for this platform. The release page may still offer a manual download.',
            );
        case 'release-artifact-missing':
            return external_action_dialog(
                message,
                'The release’s update information points to a download that is missing from the release page. You can check the release page for another download.',
            );
        case 'production-release-missing':
            return external_action_dialog(
                message,
                'GitHub does not currently have a published production release for Table Viewer. Check GitHub Releases for available downloads.',
            );
        case 'release-information-invalid':
            return external_action_dialog(
                message,
                'The latest release’s update information is incomplete or invalid, so Table Viewer refused to use it. You can check the release page for a manual download.',
            );
        case 'unknown':
            return external_action_dialog(
                message,
                'Table Viewer encountered an unexpected update problem. This does not necessarily mean your internet connection or GitHub is unavailable. Try again later, or check GitHub Releases in your browser.',
            );
    }
}

function external_action_dialog(message: string, detail: string): AppUpdateFailureDialog {
    return {
        message,
        detail,
        buttons: ['Open GitHub Releases', 'OK'],
        defaultId: 1,
        cancelId: 1,
        open_releases_response: 0,
    };
}
