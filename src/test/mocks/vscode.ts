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
    readonly scheme: string;
    readonly authority: string;
    readonly path: string;
    readonly query: string;
    readonly fragment: string;
    readonly fsPath: string;
    with(change: Partial<UriComponents>): UriLike;
    toString(): string;
}

interface UriComponents {
    scheme: string;
    authority: string;
    path: string;
    query: string;
    fragment: string;
    fsPath?: string;
}

function file_path_from_uri_path(path: string): string {
    if (/^\/[A-Za-z]:\//.test(path)) return path.slice(1).replaceAll('/', '\\');
    return path;
}

function file_uri_path(fs_path: string): string {
    if (/^[A-Za-z]:[\\/]/.test(fs_path)) {
        return `/${fs_path.replaceAll('\\', '/')}`;
    }
    return fs_path;
}

function make_uri(components: UriComponents): UriLike {
    const normalized = {
        scheme: components.scheme,
        authority: components.authority,
        path: components.path,
        query: components.query,
        fragment: components.fragment,
        fsPath: components.fsPath ?? (
            components.scheme === 'file'
                ? file_path_from_uri_path(components.path)
                : components.path
        ),
    };
    return {
        ...normalized,
        with(change): UriLike {
            const next_path = change.path ?? normalized.path;
            return make_uri({
                scheme: change.scheme ?? normalized.scheme,
                authority: change.authority ?? normalized.authority,
                path: next_path,
                query: change.query ?? normalized.query,
                fragment: change.fragment ?? normalized.fragment,
                fsPath: change.fsPath ?? (
                    (change.scheme ?? normalized.scheme) === 'file'
                        ? file_path_from_uri_path(next_path)
                        : next_path
                ),
            });
        },
        toString() {
            if (normalized.scheme === 'file') return normalized.fsPath;
            const authority = normalized.authority ? `//${normalized.authority}` : '';
            const query = normalized.query ? `?${normalized.query}` : '';
            const fragment = normalized.fragment ? `#${normalized.fragment}` : '';
            return `${normalized.scheme}:${authority}${normalized.path}${query}${fragment}`;
        },
    };
}

export const Uri = {
    parse(value: string): UriLike {
        if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) {
            return this.file(value);
        }
        const parsed = new URL(value);
        return make_uri({
            scheme: parsed.protocol.slice(0, -1),
            authority: parsed.host,
            path: parsed.pathname,
            query: parsed.search.slice(1),
            fragment: parsed.hash.slice(1),
        });
    },
    joinPath(base: UriLike, ...segments: string[]): UriLike {
        const joined = [base.path.replace(/\/$/, ''), ...segments].join('/');
        if (typeof base.with === 'function') return base.with({ path: joined });
        return make_uri({
            scheme: base.scheme ?? 'file',
            authority: base.authority ?? '',
            path: joined,
            query: base.query ?? '',
            fragment: base.fragment ?? '',
            fsPath: [(base.fsPath ?? base.path).replace(/[\\/]$/, ''), ...segments].join('/'),
        });
    },
    file(path: string): UriLike {
        return make_uri({
            scheme: 'file', authority: '', path: file_uri_path(path),
            query: '', fragment: '', fsPath: path,
        });
    },
    from(components: Partial<UriComponents> & Pick<UriComponents, 'scheme' | 'path'>): UriLike {
        return make_uri({
            authority: '', query: '', fragment: '', ...components,
        });
    },
};

export const ViewColumn = {
    Active: 1,
    Beside: 2,
};

export class CancellationError extends Error {
    constructor() {
        super('Cancelled');
        this.name = 'Canceled';
    }
}

export class EventEmitter<T> {
    private readonly listeners: ((event: T) => unknown)[] = [];
    readonly event = (listener: (event: T) => unknown): { dispose(): void } => {
        this.listeners.push(listener);
        return disposable(this.listeners, listener);
    };

    fire(event: T): void {
        for (const listener of [...this.listeners]) listener(event);
    }

    dispose(): void {
        this.listeners.length = 0;
    }
}

export const env = {
    remoteName: undefined as string | undefined,
};

export class RelativePattern {
    readonly baseUri: UriLike;
    readonly base: UriLike;

    constructor(base: UriLike, public readonly pattern: string) {
        this.baseUri = base;
        this.base = base;
    }
}

type MessageHandler = (message: unknown) => unknown;
type WatchHandler = (uri: UriLike) => unknown;
type ConfigurationChangeHandler = (
    event: { affectsConfiguration(section: string): boolean },
) => unknown;

interface MockWebviewPanel {
    title: string;
    readonly active: boolean;
    readonly visible: boolean;
    webview: {
        html: string;
        asWebviewUri(uri: UriLike): UriLike;
        postMessage(message: unknown): Promise<boolean>;
        onDidReceiveMessage(handler: MessageHandler): { dispose(): void };
    };
    onDidDispose(handler: () => unknown): { dispose(): void };
    onDidChangeViewState(
        handler: (event: { readonly webviewPanel: MockWebviewPanel }) => unknown,
    ): { dispose(): void };
    reveal(): void;
    dispose(): void;
    __messages: unknown[];
    __autoAckSnapshots: boolean;
    __receive(message: unknown): Promise<void>;
    __setActive(active: boolean): void;
}

export interface MockWatcher {
    readonly __pattern: unknown;
    readonly __disposed: boolean;
    onDidChange(handler: WatchHandler): { dispose(): void };
    onDidCreate(handler: WatchHandler): { dispose(): void };
    onDidDelete(handler: WatchHandler): { dispose(): void };
    dispose(): void;
    __fireChange(uri?: UriLike): Promise<void>;
    __fireCreate(uri?: UriLike): Promise<void>;
    __fireDelete(uri?: UriLike): Promise<void>;
}

const panels: MockWebviewPanel[] = [];
const watchers: MockWatcher[] = [];
const configuration_change_handlers: ConfigurationChangeHandler[] = [];
const configuration_values = new Map<string, unknown>();
const custom_editor_registrations: {
    viewType: string;
    provider: unknown;
    options: unknown;
}[] = [];

let stat_impl: ((uri: UriLike) => Promise<{ size: number; mtime: number }>) | undefined;
let save_impl: ((uri: UriLike) => Promise<UriLike | undefined>) | undefined;
let read_file_impl: ((uri: UriLike) => Promise<Uint8Array>) | undefined;
let write_file_impl: ((uri: UriLike, content: Uint8Array) => Promise<void>) | undefined;
let delete_impl: ((uri: UriLike) => Promise<void>) | undefined;
let create_directory_impl: ((uri: UriLike) => Promise<void>) | undefined;
let watcher_registration_failure: 'change' | 'create' | 'delete' | undefined;
let watcher_dispose_failure = false;
const executed_commands: { command: string; args: unknown[] }[] = [];
const registered_commands = new Map<string, (...args: unknown[]) => unknown>();
const warning_messages: string[] = [];
const error_messages: string[] = [];
const information_messages: string[] = [];

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
    const view_state_handlers: ((event: {
        readonly webviewPanel: MockWebviewPanel;
    }) => unknown)[] = [];
    let protocol_sequence = 0;
    let active = false;
    let visible = true;
    let disposed = false;
    const pending_edit_sequences = new Map<string, number>();
    const panel: MockWebviewPanel = {
        title,
        get active() { return active; },
        get visible() { return visible; },
        webview: {
            html: '',
            asWebviewUri(uri: UriLike): UriLike {
                return uri;
            },
            async postMessage(message: unknown): Promise<boolean> {
                panel.__messages.push(message);
                if (
                    panel.__autoAckSnapshots
                    && typeof message === 'object'
                    && message !== null
                    && 'type' in message
                    && message.type === 'workbookSnapshot'
                    && 'snapshot' in message
                ) {
                    const snapshot = message.snapshot as { identity: unknown };
                    queueMicrotask(() => {
                        void panel.__receive({
                            type: 'snapshotApplied',
                            identity: snapshot.identity,
                            disposition: 'applied',
                        });
                    });
                }
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
        onDidChangeViewState(
            handler: (event: { readonly webviewPanel: MockWebviewPanel }) => unknown,
        ): { dispose(): void } {
            view_state_handlers.push(handler);
            return disposable(view_state_handlers, handler);
        },
        reveal() {
            if (disposed) return;
            const visibility_changed = !visible;
            const activity_changed = !active;
            visible = true;
            panel.__setActive(true);
            if (visibility_changed && !activity_changed) {
                const event = { webviewPanel: panel };
                for (const handler of [...view_state_handlers]) handler(event);
            }
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            const view_state_changed = active || visible;
            active = false;
            visible = false;
            if (view_state_changed) {
                const event = { webviewPanel: panel };
                for (const handler of [...view_state_handlers]) handler(event);
            }
            for (const handler of [...dispose_handlers]) handler();
        },
        __messages: [],
        __autoAckSnapshots: true,
        async __receive(message: unknown): Promise<void> {
            let forwarded = message;
            if (
                typeof forwarded === 'object'
                && forwarded !== null
                && 'type' in forwarded
                && forwarded.type === 'requestEditSession'
                && !('requestId' in forwarded)
            ) {
                forwarded = {
                    ...forwarded,
                    requestId: `test-edit-request:${++protocol_sequence}`,
                };
            }
            const latest_grant = () => [...panel.__messages].reverse().find((candidate) => (
                typeof candidate === 'object'
                && candidate !== null
                && 'type' in candidate
                && candidate.type === 'editSessionResult'
                && 'granted' in candidate
                && candidate.granted === true
                && 'editSessionId' in candidate
            )) as { editSessionId?: string } | undefined;
            const latest_snapshot_identity = () => {
                const snapshot = [...panel.__messages].reverse().find((candidate) => (
                    typeof candidate === 'object'
                    && candidate !== null
                    && 'type' in candidate
                    && candidate.type === 'workbookSnapshot'
                )) as { snapshot?: { identity?: unknown } } | undefined;
                return snapshot?.snapshot?.identity;
            };
            if (
                typeof forwarded === 'object'
                && forwarded !== null
                && 'type' in forwarded
                && (forwarded.type === 'saveCsv' || forwarded.type === 'pendingEditsChanged')
                && !('editSessionId' in forwarded)
            ) {
                const grant = latest_grant();
                if (grant?.editSessionId) {
                    forwarded = { ...forwarded, editSessionId: grant.editSessionId };
                }
            }
            if (
                typeof forwarded === 'object'
                && forwarded !== null
                && 'type' in forwarded
                && forwarded.type === 'pendingEditsChanged'
                && !('sequence' in forwarded)
            ) {
                const session_id = 'editSessionId' in forwarded
                    && typeof forwarded.editSessionId === 'string'
                    ? forwarded.editSessionId
                    : '';
                const sequence = (pending_edit_sequences.get(session_id) ?? 0) + 1;
                pending_edit_sequences.set(session_id, sequence);
                forwarded = { ...forwarded, sequence };
            }
            if (
                typeof forwarded === 'object'
                && forwarded !== null
                && 'type' in forwarded
                && forwarded.type === 'saveCsv'
                && !('saveRequestId' in forwarded)
            ) {
                forwarded = {
                    ...forwarded,
                    saveRequestId: `test-save-request:${++protocol_sequence}`,
                };
            }
            if (
                typeof forwarded === 'object'
                && forwarded !== null
                && 'type' in forwarded
                && forwarded.type === 'saveCsv'
                && !('operation' in forwarded)
            ) {
                const legacy = forwarded as {
                    editSessionId?: string;
                    saveRequestId?: string;
                    edits?: Record<string, string>;
                };
                const edits = legacy.edits ?? {};
                forwarded = {
                    type: 'saveCsv',
                    operation: {
                        editSessionId: legacy.editSessionId ?? '',
                        saveRequestId: legacy.saveRequestId ?? '',
                        edits,
                        dirtyEdits: Object.fromEntries(
                            Object.entries(edits).map(([key, value]) => [
                                key,
                                { value, base: 'a' },
                            ]),
                        ),
                    },
                };
            }
            if (
                typeof forwarded === 'object'
                && forwarded !== null
                && 'type' in forwarded
                && (
                    forwarded.type === 'releaseEditSession'
                    || forwarded.type === 'discardEditSession'
                    || forwarded.type === 'showSaveDialog'
                )
                && !('editSessionId' in forwarded)
            ) {
                const editSessionId = latest_grant()?.editSessionId;
                if (editSessionId) forwarded = { ...forwarded, editSessionId };
            }
            if (
                typeof forwarded === 'object'
                && forwarded !== null
                && 'type' in forwarded
                && forwarded.type === 'showSaveDialog'
                && !('requestId' in forwarded)
            ) {
                forwarded = {
                    ...forwarded,
                    requestId: `test-dialog-request:${++protocol_sequence}`,
                };
            }
            if (
                typeof forwarded === 'object'
                && forwarded !== null
                && 'type' in forwarded
                && forwarded.type === 'setColumnVisibility'
                && !('snapshotIdentity' in forwarded)
            ) {
                const snapshotIdentity = latest_snapshot_identity();
                if (snapshotIdentity) forwarded = { ...forwarded, snapshotIdentity };
            }
            await Promise.all(message_handlers.map((handler) => handler(forwarded)));
        },
        __setActive(next_active: boolean): void {
            if (disposed || active === next_active) return;
            if (next_active) {
                for (const other of panels) {
                    if (other !== panel) other.__setActive(false);
                }
            }
            active = next_active;
            const event = { webviewPanel: panel };
            for (const handler of [...view_state_handlers]) handler(event);
        },
    };
    return panel;
}

function default_watcher_uri(pattern: unknown): UriLike {
    if (!(pattern instanceof RelativePattern)) return Uri.file('');
    const base = pattern.baseUri.path;
    const joined = base.endsWith('/')
        ? `${base}${pattern.pattern}`
        : `${base}/${pattern.pattern}`;
    return pattern.baseUri.with({ path: joined });
}

async function flush_watcher_dispatch(): Promise<void> {
    // The production coordinator coalesces raw watcher signals in a microtask,
    // then starts subscriber work without awaiting it. Give ordinary async
    // controller work a deterministic chance to settle while preserving hangs.
    for (let index = 0; index < 100; index += 1) await Promise.resolve();
}

function make_watcher(pattern: unknown): MockWatcher {
    const change_handlers: WatchHandler[] = [];
    const create_handlers: WatchHandler[] = [];
    const delete_handlers: WatchHandler[] = [];
    let disposed = false;
    return {
        __pattern: pattern,
        get __disposed() { return disposed; },
        onDidChange(handler: WatchHandler): { dispose(): void } {
            if (watcher_registration_failure === 'change') throw new Error('watch change registration failed');
            change_handlers.push(handler);
            return disposable(change_handlers, handler);
        },
        onDidCreate(handler: WatchHandler): { dispose(): void } {
            if (watcher_registration_failure === 'create') throw new Error('watch create registration failed');
            create_handlers.push(handler);
            return disposable(create_handlers, handler);
        },
        onDidDelete(handler: WatchHandler): { dispose(): void } {
            if (watcher_registration_failure === 'delete') throw new Error('watch delete registration failed');
            delete_handlers.push(handler);
            return disposable(delete_handlers, handler);
        },
        dispose() {
            disposed = true;
            if (watcher_dispose_failure) throw new Error('watch dispose failed');
        },
        async __fireChange(uri = default_watcher_uri(pattern)): Promise<void> {
            if (disposed) return;
            await Promise.all([...change_handlers].map((handler) => handler(uri)));
            await flush_watcher_dispatch();
        },
        async __fireCreate(uri = default_watcher_uri(pattern)): Promise<void> {
            if (disposed) return;
            await Promise.all([...create_handlers].map((handler) => handler(uri)));
            await flush_watcher_dispatch();
        },
        async __fireDelete(uri = default_watcher_uri(pattern)): Promise<void> {
            if (disposed) return;
            await Promise.all([...delete_handlers].map((handler) => handler(uri)));
            await flush_watcher_dispatch();
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
        panel.__setActive(true);
        return panel;
    },
    showErrorMessage(message: string, ..._args: unknown[]): unknown {
        error_messages.push(message);
        return undefined;
    },
    showWarningMessage(message: string, ..._args: unknown[]): unknown {
        warning_messages.push(message);
        return undefined;
    },
    showInformationMessage(message: string, ..._args: unknown[]): unknown {
        information_messages.push(message);
        return undefined;
    },
    onDidChangeTextEditorVisibleRanges() {
        return disposable();
    },
    async showTextDocument(document: unknown) {
        return { document, revealRange() {} };
    },
    visibleTextEditors: [],
    activeTextEditor: undefined as { document: { uri: UriLike } } | undefined,
    tabGroups: {
        activeTabGroup: {
            activeTab: undefined as { input: unknown } | undefined,
        },
    },
};

export class TabInputCustom {
    constructor(readonly uri: UriLike, readonly viewType = '') {}
}

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
    async save(uri: UriLike): Promise<UriLike | undefined> {
        return save_impl ? save_impl(uri) : uri;
    },
    fs: {
        async stat(uri: UriLike): Promise<{ size: number; mtime: number }> {
            if (!stat_impl) return { size: 0, mtime: 0 };
            return stat_impl(uri);
        },
        async readFile(uri: UriLike): Promise<Uint8Array> {
            if (!read_file_impl) return new Uint8Array();
            return read_file_impl(uri);
        },
        async writeFile(uri: UriLike, content: Uint8Array): Promise<void> {
            await write_file_impl?.(uri, content);
        },
        async delete(uri: UriLike): Promise<void> {
            await delete_impl?.(uri);
        },
        async createDirectory(uri: UriLike): Promise<void> {
            await create_directory_impl?.(uri);
        },
    },
    createFileSystemWatcher(pattern?: unknown): MockWatcher {
        const watcher = make_watcher(pattern);
        watchers.push(watcher);
        return watcher;
    },
    getConfiguration(section?: string) {
        return {
            get: (key: string, fallback: unknown) => {
                const full_key = section ? `${section}.${key}` : key;
                return configuration_values.has(full_key)
                    ? configuration_values.get(full_key)
                    : fallback;
            },
        };
    },
    onDidChangeConfiguration(handler: ConfigurationChangeHandler) {
        configuration_change_handlers.push(handler);
        return disposable(configuration_change_handlers, handler);
    },
};

export const commands = {
    registerCommand(command: string, handler: (...args: unknown[]) => unknown) {
        registered_commands.set(command, handler);
        return {
            dispose() {
                if (registered_commands.get(command) === handler) {
                    registered_commands.delete(command);
                }
            },
        };
    },
    async executeCommand(command: string, ...args: unknown[]): Promise<unknown> {
        executed_commands.push({ command, args });
        return registered_commands.get(command)?.(...args);
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
    configuration_change_handlers.length = 0;
    configuration_values.clear();
    custom_editor_registrations.length = 0;
    stat_impl = undefined;
    save_impl = undefined;
    read_file_impl = undefined;
    write_file_impl = undefined;
    delete_impl = undefined;
    create_directory_impl = undefined;
    watcher_registration_failure = undefined;
    watcher_dispose_failure = false;
    executed_commands.length = 0;
    registered_commands.clear();
    warning_messages.length = 0;
    error_messages.length = 0;
    information_messages.length = 0;
    window.activeTextEditor = undefined;
    window.tabGroups.activeTabGroup.activeTab = undefined;
}

export function __setStatImplementation(
    impl: (uri: UriLike) => Promise<{ size: number; mtime: number }>,
): void {
    stat_impl = impl;
}

export function __setSaveImplementation(
    impl: (uri: UriLike) => Promise<UriLike | undefined>,
): void {
    save_impl = impl;
}

export function __setReadFileImplementation(
    impl: (uri: UriLike) => Promise<Uint8Array>,
): void {
    read_file_impl = impl;
}

export function __setWriteFileImplementation(
    impl: (uri: UriLike, content: Uint8Array) => Promise<void>,
): void {
    write_file_impl = impl;
}

export function __setDeleteImplementation(
    impl: (uri: UriLike) => Promise<void>,
): void {
    delete_impl = impl;
}

export function __setCreateDirectoryImplementation(
    impl: (uri: UriLike) => Promise<void>,
): void {
    create_directory_impl = impl;
}

export function __setConfigurationValue(key: string, value: unknown): void {
    configuration_values.set(key, value);
}

export async function __fireConfigurationChange(
    event: Parameters<ConfigurationChangeHandler>[0],
): Promise<void> {
    await Promise.all(
        [...configuration_change_handlers].map((handler) => handler(event)),
    );
}

export function __setWatcherRegistrationFailure(
    phase: 'change' | 'create' | 'delete' | undefined,
): void {
    watcher_registration_failure = phase;
}

export function __setWatcherDisposeFailure(fail: boolean): void {
    watcher_dispose_failure = fail;
}

export function __getPanels(): MockWebviewPanel[] {
    return panels;
}

export function __getWatchers(): MockWatcher[] {
    return watchers;
}

export function __getWatcherHistory(): MockWatcher[] {
    return watchers;
}

export function __getActiveWatchers(): MockWatcher[] {
    return watchers.filter((watcher) => !watcher.__disposed);
}

export function __getCustomEditorRegistrations() {
    return custom_editor_registrations;
}

export function __getExecutedCommands() {
    return executed_commands;
}

export function __getRegisteredCommands(): string[] {
    return [...registered_commands.keys()];
}

export function __getWarningMessages(): string[] {
    return warning_messages;
}

export function __getErrorMessages(): string[] {
    return error_messages;
}

export function __getInformationMessages(): string[] {
    return information_messages;
}
