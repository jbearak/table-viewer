import * as vscode from 'vscode';

export const TABLE_DIFF_SCHEME = 'table-viewer-diff';
export const TABLE_FILE_EXTENSION_PATTERN = /\.(csv|tsv|xlsx|xls)$/iu;

interface GitUriQuery {
    readonly path: string;
    readonly ref: string;
}

function git_uri_query(uri: vscode.Uri): GitUriQuery | undefined {
    if (uri.scheme !== 'git' || !uri.query) return undefined;
    try {
        const parsed: unknown = JSON.parse(uri.query);
        return typeof parsed === 'object' && parsed !== null
            && 'path' in parsed && typeof parsed.path === 'string'
            && 'ref' in parsed && typeof parsed.ref === 'string'
            ? { path: parsed.path, ref: parsed.ref }
            : undefined;
    } catch {
        return undefined;
    }
}

function same_git_resource(query: GitUriQuery, uri: vscode.Uri): boolean {
    const normalize = (value: string) => process.platform === 'win32'
        ? value.replaceAll('/', '\\').toLocaleLowerCase('en-US')
        : value;
    return normalize(query.path) === normalize(uri.fsPath);
}

export interface TableDiffUris {
    readonly modified: vscode.Uri;
    readonly original: vscode.Uri;
}

/** A Git SCM diff shape that Table Viewer can collapse into one compare panel. */
export function table_diff_uris(
    original: vscode.Uri,
    modified: vscode.Uri,
): TableDiffUris | undefined {
    if (!TABLE_FILE_EXTENSION_PATTERN.test(modified.path)) return undefined;
    if (original.authority !== modified.authority || original.path !== modified.path) {
        return undefined;
    }
    const original_query = git_uri_query(original);
    if (
        original_query?.ref === '~'
        && modified.scheme === 'file'
        && same_git_resource(original_query, modified)
    ) {
        return { original, modified };
    }
    const modified_query = git_uri_query(modified);
    if (
        original_query?.ref === 'HEAD'
        && modified_query?.ref === ''
        && same_git_resource(original_query, modified)
        && same_git_resource(modified_query, modified)
    ) {
        return { original, modified };
    }
    return undefined;
}

type SerializedUri = readonly [string, string, string, string, string];

interface SerializedTableDiff {
    readonly version: 1;
    readonly original: SerializedUri;
    readonly modified: SerializedUri;
}

function serialize_uri(uri: vscode.Uri): SerializedUri {
    return [uri.scheme, uri.authority, uri.path, uri.query, uri.fragment];
}

function parse_uri(value: unknown): vscode.Uri | undefined {
    if (!Array.isArray(value) || value.length !== 5) return undefined;
    if (!value.every((component) => typeof component === 'string')) return undefined;
    const [scheme, authority, path, query, fragment] = value as unknown as SerializedUri;
    if (!scheme || !path) return undefined;
    return vscode.Uri.from({ scheme, authority, path, query, fragment });
}

/** A stable custom-document identity for one Table Viewer Git comparison. */
export function table_diff_document_uri(diff: TableDiffUris): vscode.Uri {
    const payload: SerializedTableDiff = {
        version: 1,
        original: serialize_uri(diff.original),
        modified: serialize_uri(diff.modified),
    };
    return diff.modified.with({
        scheme: TABLE_DIFF_SCHEME,
        query: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url'),
        fragment: '',
    });
}

/** Decode and revalidate a Table Viewer comparison custom-document URI. */
export function table_diff_document_uris(uri: vscode.Uri): TableDiffUris | undefined {
    if (uri.scheme !== TABLE_DIFF_SCHEME || !uri.query) return undefined;
    try {
        const payload: unknown = JSON.parse(
            Buffer.from(uri.query, 'base64url').toString('utf8'),
        );
        if (
            typeof payload !== 'object'
            || payload === null
            || !('version' in payload)
            || payload.version !== 1
            || !('original' in payload)
            || !('modified' in payload)
        ) {
            return undefined;
        }
        const original = parse_uri(payload.original);
        const modified = parse_uri(payload.modified);
        if (!original || !modified) return undefined;
        if (uri.authority !== modified.authority || uri.path !== modified.path) {
            return undefined;
        }
        return table_diff_uris(original, modified);
    } catch {
        return undefined;
    }
}

/** The editable working-tree resource associated with a recognized Git comparison. */
export function table_diff_working_tree_uri(diff: TableDiffUris): vscode.Uri {
    if (diff.modified.scheme === 'file') return diff.modified;
    const query = git_uri_query(diff.modified);
    return query
        ? vscode.Uri.file(query.path)
        : diff.modified.with({ scheme: 'file', query: '', fragment: '' });
}
