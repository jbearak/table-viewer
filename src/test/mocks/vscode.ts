/**
 * Minimal `vscode` stand-in for vitest unit tests.
 *
 * The real `vscode` module is injected by the VS Code extension host and cannot
 * be resolved under vitest/node. Modules that only touch a tiny slice of the API
 * (e.g. `webview-html.ts` uses `Uri.joinPath`) can be unit-tested by aliasing
 * `vscode` to this file in `vitest.config.ts`. Add to it as more surface is
 * exercised by unit tests; integration tests use the real module.
 */

export interface UriLike {
    path: string;
    toString(): string;
}

function make_uri(path: string): UriLike {
    return {
        path,
        toString() {
            return path;
        },
    };
}

export const Uri = {
    joinPath(base: UriLike, ...segments: string[]): UriLike {
        return make_uri([base.path, ...segments].join('/'));
    },
    file(path: string): UriLike {
        return make_uri(path);
    },
};
