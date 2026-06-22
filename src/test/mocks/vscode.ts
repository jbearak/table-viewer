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
    fsPath: string;
    toString(): string;
}

function make_uri(path: string): UriLike {
    return {
        path,
        fsPath: path,
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

export const ViewColumn = {
    Active: 1,
    Beside: 2,
};

export class RelativePattern {
    constructor(
        public readonly base: UriLike,
        public readonly pattern: string,
    ) {}
}

type MessageHandler = (message: unknown) => unknown;
type WatchHandler = () => unknown;

interface MockWebviewPanel {
    title: string;
    webview: {
        html: string;
        asWebviewUri(uri: UriLike): UriLike;
        postMessage(message: unknown): Promise<boolean>;
        onDidReceiveMessage(handler: MessageHandler): { dispose(): void };
    };
    onDidDispose(handler: () => unknown): { dispose(): void };
    reveal(): void;
    dispose(): void;
    __messages: unknown[];
    __receive(message: unknown): Promise<void>;
}

interface MockWatcher {
    onDidChange(handler: WatchHandler): { dispose(): void };
    onDidCreate(handler: WatchHandler): { dispose(): void };
    dispose(): void;
    __fireChange(): Promise<void>;
    __fireCreate(): Promise<void>;
}

const panels: MockWebviewPanel[] = [];
const watchers: MockWatcher[] = [];
const custom_editor_registrations: {
    viewType: string;
    provider: unknown;
    options: unknown;
}[] = [];

let stat_impl: ((uri: UriLike) => Promise<{ size: number; mtime: number }>) | undefined;
let read_file_impl: ((uri: UriLike) => Promise<Uint8Array>) | undefined;

function disposable<T>(handlers?: T[], handler?: T): { dispose(): void } {
    return {
        dispose() {
            if (!handlers || handler === undefined) return;
            const index = handlers.indexOf(handler);
            if (index >= 0) handlers.splice(index, 1);
        },
    };
}

function make_panel(title: string): MockWebviewPanel {
    const message_handlers: MessageHandler[] = [];
    const dispose_handlers: (() => unknown)[] = [];
    const panel: MockWebviewPanel = {
        title,
        webview: {
            html: '',
            asWebviewUri(uri: UriLike): UriLike {
                return uri;
            },
            async postMessage(message: unknown): Promise<boolean> {
                panel.__messages.push(message);
                return true;
            },
            onDidReceiveMessage(handler: MessageHandler): { dispose(): void } {
                message_handlers.push(handler);
                return disposable(message_handlers, handler);
            },
        },
        onDidDispose(handler: () => unknown): { dispose(): void } {
            dispose_handlers.push(handler);
            return disposable(dispose_handlers, handler);
        },
        reveal() {},
        dispose() {
            for (const handler of dispose_handlers) handler();
        },
        __messages: [],
        async __receive(message: unknown): Promise<void> {
            await Promise.all(message_handlers.map((handler) => handler(message)));
        },
    };
    return panel;
}

function make_watcher(): MockWatcher {
    const change_handlers: WatchHandler[] = [];
    const create_handlers: WatchHandler[] = [];
    let disposed = false;
    return {
        onDidChange(handler: WatchHandler): { dispose(): void } {
            change_handlers.push(handler);
            return disposable(change_handlers, handler);
        },
        onDidCreate(handler: WatchHandler): { dispose(): void } {
            create_handlers.push(handler);
            return disposable(create_handlers, handler);
        },
        dispose() {
            disposed = true;
        },
        async __fireChange(): Promise<void> {
            if (disposed) return;
            await Promise.all(change_handlers.map((handler) => handler()));
        },
        async __fireCreate(): Promise<void> {
            if (disposed) return;
            await Promise.all(create_handlers.map((handler) => handler()));
        },
    };
}

export const window = {
    registerCustomEditorProvider(
        viewType: string,
        provider: unknown,
        options?: unknown,
    ) {
        custom_editor_registrations.push({ viewType, provider, options });
        return disposable();
    },
    createWebviewPanel(_viewType: string, title: string): MockWebviewPanel {
        const panel = make_panel(title);
        panels.push(panel);
        return panel;
    },
    showErrorMessage() {},
    showWarningMessage() {},
    onDidChangeTextEditorVisibleRanges() {
        return disposable();
    },
    async showTextDocument(document: unknown) {
        return { document, revealRange() {} };
    },
    visibleTextEditors: [],
};

export class Range {
    constructor(
        public readonly startLine: number,
        public readonly startCharacter: number,
        public readonly endLine: number,
        public readonly endCharacter: number,
    ) {}
}

export const TextEditorRevealType = {
    AtTop: 1,
};

export const workspace = {
    fs: {
        async stat(uri: UriLike): Promise<{ size: number; mtime: number }> {
            if (!stat_impl) return { size: 0, mtime: 0 };
            return stat_impl(uri);
        },
        async readFile(uri: UriLike): Promise<Uint8Array> {
            if (!read_file_impl) return new Uint8Array();
            return read_file_impl(uri);
        },
        async writeFile(): Promise<void> {},
    },
    createFileSystemWatcher(): MockWatcher {
        const watcher = make_watcher();
        watchers.push(watcher);
        return watcher;
    },
    getConfiguration() {
        return { get: (_key: string, fallback: unknown) => fallback };
    },
};

export const extensions = {
    getExtension() {
        return undefined;
    },
};

export function __reset(): void {
    panels.length = 0;
    watchers.length = 0;
    custom_editor_registrations.length = 0;
    stat_impl = undefined;
    read_file_impl = undefined;
}

export function __setStatImplementation(
    impl: (uri: UriLike) => Promise<{ size: number; mtime: number }>,
): void {
    stat_impl = impl;
}

export function __setReadFileImplementation(
    impl: (uri: UriLike) => Promise<Uint8Array>,
): void {
    read_file_impl = impl;
}

export function __getPanels(): MockWebviewPanel[] {
    return panels;
}

export function __getWatchers(): MockWatcher[] {
    return watchers;
}

export function __getCustomEditorRegistrations() {
    return custom_editor_registrations;
}
