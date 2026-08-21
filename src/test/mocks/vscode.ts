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
    parse(value: string, strict = false): UriLike {
        const match = /^([A-Za-z][A-Za-z0-9+.-]*):(?:\/\/([^/]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/u
            .exec(value);
        if (!match) {
            if (strict) throw new Error(`Invalid URI: ${value}`);
            return Uri.file(value);
        }
        return make_uri({
            scheme: match[1],
            authority: match[2] ?? '',
            path: match[3] || '/',
            query: match[4] ?? '',
            fragment: match[5] ?? '',
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
    Active: -1,
    Beside: -2,
    One: 1,
    Two: 2,
};

export const env = {
    remoteName: undefined as string | undefined,
    appName: 'Visual Studio Code',
    uriScheme: 'vscode',
};

export const ExtensionKind = {
    UI: 1,
    Workspace: 2,
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
type TabChangeHandler = (event: {
    readonly opened: readonly MockTab[];
    readonly closed: readonly MockTab[];
    readonly changed: readonly MockTab[];
}) => unknown;

export interface MockTab {
    readonly label: string;
    readonly input: unknown;
}

interface MockTabGroup {
    readonly viewColumn: number;
    readonly tabs: MockTab[];
}

export class TabInputCustom {
    constructor(
        public readonly uri: UriLike,
        public readonly viewType: string,
    ) {}
}

export class TabInputTextDiff {
    constructor(
        public readonly original: UriLike,
        public readonly modified: UriLike,
    ) {}
}

interface MockWebviewPanel {
    title: string;
    active: boolean;
    readonly viewColumn: number;
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
    __reveals: number;
    __disposeCount: number;
    __autoAckSnapshots: boolean;
    __receive(message: unknown): Promise<void>;
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
const tab_change_handlers: TabChangeHandler[] = [];
const tabs: MockTab[] = [];
const tab_groups: MockTabGroup[] = [{ viewColumn: ViewColumn.One, tabs }];
let active_tab_group = tab_groups[0];
const closed_tabs: MockTab[] = [];
const tab_panels = new Map<MockTab, Set<MockWebviewPanel>>();
const configuration_values = new Map<string, unknown>();
const custom_editor_registrations: {
    viewType: string;
    provider: unknown;
    options: unknown;
}[] = [];

let stat_impl: ((uri: UriLike) => Promise<{ size: number; mtime: number }>) | undefined;
let read_file_impl: ((uri: UriLike) => Promise<Uint8Array>) | undefined;
let write_file_impl: ((uri: UriLike, content: Uint8Array) => Promise<void>) | undefined;
let create_directory_impl: ((uri: UriLike) => Promise<void>) | undefined;
let watcher_registration_failure: 'change' | 'create' | 'delete' | undefined;
let watcher_dispose_failure = false;
let close_tab_impl: ((tab: MockTab) => Promise<boolean>) | undefined;

function disposable<T>(handlers?: T[], handler?: T): { dispose(): void } {
    return {
        dispose() {
            if (!handlers || handler === undefined) return;
            const index = handlers.indexOf(handler);
            if (index >= 0) handlers.splice(index, 1);
        },
    };
}

function make_panel(title: string, view_column: number): MockWebviewPanel {
    const message_handlers: MessageHandler[] = [];
    const dispose_handlers: (() => unknown)[] = [];
    let protocol_sequence = 0;
    let disposed = false;
    const pending_edit_sequences = new Map<string, number>();
    const panel: MockWebviewPanel = {
        title,
        active: false,
        viewColumn: view_column,
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
        reveal() {
            for (const candidate of panels) candidate.active = candidate === panel;
            panel.__reveals += 1;
        },
        dispose() {
            panel.__disposeCount += 1;
            if (disposed) return;
            disposed = true;
            for (const associated of tab_panels.values()) associated.delete(panel);
            for (const handler of dispose_handlers.splice(0)) handler();
        },
        __messages: [],
        __reveals: 0,
        __disposeCount: 0,
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
                        editSessionId: legacy.editSessionId ?? latest_grant()?.editSessionId ?? '',
                        saveRequestId: legacy.saveRequestId ?? `test-save-request:${++protocol_sequence}`,
                        worksheets: [{
                            sheetIndex: 0,
                            edits,
                            dirtyEdits: Object.fromEntries(
                                Object.entries(edits).map(([key, value]) => [
                                    key,
                                    { value, base: 'a' },
                                ]),
                            ),
                        }],
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
    tabGroups: {
        get all() {
            return tab_groups.map((group) => ({
                viewColumn: group.viewColumn,
                tabs: group.tabs,
                activeTab: group.tabs.at(-1),
            }));
        },
        get activeTabGroup() {
            return {
                viewColumn: active_tab_group.viewColumn,
                tabs: active_tab_group.tabs,
                activeTab: active_tab_group.tabs.at(-1),
            };
        },
        onDidChangeTabs(handler: TabChangeHandler) {
            tab_change_handlers.push(handler);
            return disposable(tab_change_handlers, handler);
        },
        async close(tab: MockTab): Promise<boolean> {
            const closed = close_tab_impl ? await close_tab_impl(tab) : true;
            if (!closed) return false;
            closed_tabs.push(tab);
            for (const group of tab_groups) {
                const index = group.tabs.indexOf(tab);
                if (index >= 0) group.tabs.splice(index, 1);
            }
            for (const panel of [...(tab_panels.get(tab) ?? [])]) panel.dispose();
            tab_panels.delete(tab);
            return true;
        },
    },
    registerCustomEditorProvider(
        viewType: string,
        provider: unknown,
        options?: unknown,
    ) {
        const registration = { viewType, provider, options };
        custom_editor_registrations.push(registration);
        return disposable(custom_editor_registrations, registration);
    },
    createWebviewPanel(
        _viewType: string,
        title: string,
        show_options?: number | { viewColumn?: number },
    ): MockWebviewPanel {
        const requested = typeof show_options === 'number'
            ? show_options
            : show_options?.viewColumn;
        let view_column = requested === undefined || requested === ViewColumn.Active
            ? active_tab_group.viewColumn
            : requested;
        if (view_column === ViewColumn.Beside) {
            const adjacent_group = tab_groups
                .filter((group) => group.viewColumn > active_tab_group.viewColumn)
                .sort((left, right) => left.viewColumn - right.viewColumn)[0];
            view_column = adjacent_group?.viewColumn
                ?? Math.max(0, ...tab_groups.map((group) => group.viewColumn)) + 1;
            if (!adjacent_group) tab_groups.push({ viewColumn: view_column, tabs: [] });
        }
        const panel = make_panel(title, view_column);
        panels.push(panel);
        const group = tab_groups.find((candidate) => candidate.viewColumn === view_column);
        const tab = group?.tabs.at(-1);
        if (tab) {
            const associated = tab_panels.get(tab) ?? new Set<MockWebviewPanel>();
            associated.add(panel);
            tab_panels.set(tab, associated);
        }
        return panel;
    },
    showErrorMessage(..._args: unknown[]): unknown {
        return undefined;
    },
    showWarningMessage(..._args: unknown[]): unknown {
        return undefined;
    },
    showInformationMessage(..._args: unknown[]): unknown {
        return undefined;
    },
    showQuickPick(..._args: unknown[]): unknown {
        return undefined;
    },
    showSaveDialog(..._args: unknown[]): unknown {
        return undefined;
    },
    showOpenDialog(..._args: unknown[]): unknown {
        return undefined;
    },
    onDidChangeTextEditorVisibleRanges() {
        return disposable();
    },
    async showTextDocument(document: unknown) {
        return { document, revealRange() {} };
    },
    visibleTextEditors: [],
    activeTextEditor: undefined as unknown,
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
    workspaceFile: undefined as UriLike | undefined,
    workspaceFolders: undefined as readonly { uri: UriLike }[] | undefined,
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

const command_handlers = new Map<string, (...args: unknown[]) => unknown>();
const extension_registry = new Map<string, unknown>();

export const commands = {
    registerCommand(command: string, handler: (...args: unknown[]) => unknown) {
        command_handlers.set(command, handler);
        return { dispose: () => { command_handlers.delete(command); } };
    },
    async executeCommand(command: string, ...args: unknown[]): Promise<unknown> {
        const handler = command_handlers.get(command);
        return handler?.(...args);
    },
};

export const extensions = {
    getExtension(id: string) {
        return extension_registry.get(id);
    },
};

export function __setExtension(id: string, extension: unknown): void {
    extension_registry.set(id, extension);
}

export function __setCommand(command: string, handler: (...args: unknown[]) => unknown): void {
    command_handlers.set(command, handler);
}

export function __hasCommand(command: string): boolean {
    return command_handlers.has(command);
}

export function __reset(): void {
    panels.length = 0;
    watchers.length = 0;
    configuration_change_handlers.length = 0;
    tab_change_handlers.length = 0;
    tabs.length = 0;
    tab_groups.splice(0, tab_groups.length, { viewColumn: ViewColumn.One, tabs });
    active_tab_group = tab_groups[0];
    tab_panels.clear();
    closed_tabs.length = 0;
    configuration_values.clear();
    custom_editor_registrations.length = 0;
    command_handlers.clear();
    extension_registry.clear();
    stat_impl = undefined;
    create_directory_impl = undefined;
    read_file_impl = undefined;
    write_file_impl = undefined;
    workspace.workspaceFile = undefined;
    workspace.workspaceFolders = undefined;
    window.activeTextEditor = undefined;
    watcher_registration_failure = undefined;
    watcher_dispose_failure = false;
    close_tab_impl = undefined;
}

export function __setCreateDirectoryImplementation(
    impl: (uri: UriLike) => Promise<void>,
): void {
    create_directory_impl = impl;
}

export function __getRegisteredCommands(): string[] {
    return [...command_handlers.keys()];
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

export function __setWriteFileImplementation(
    impl: (uri: UriLike, content: Uint8Array) => Promise<void>,
): void {
    write_file_impl = impl;
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

export async function __fireTabChange(event: {
    readonly opened?: readonly MockTab[];
    readonly closed?: readonly MockTab[];
    readonly changed?: readonly MockTab[];
}): Promise<void> {
    const opened = [...(event.opened ?? [])];
    for (const tab of opened) {
        if (!active_tab_group.tabs.includes(tab)) active_tab_group.tabs.push(tab);
    }
    await Promise.all([...tab_change_handlers].map((handler) => handler({
        opened,
        closed: event.closed ?? [],
        changed: event.changed ?? [],
    })));
    for (let index = 0; index < 100; index += 1) await Promise.resolve();
}

export function __setTabGroups(
    groups: readonly { readonly viewColumn: number; readonly tabs: readonly MockTab[] }[],
    active_view_column: number,
): void {
    tab_groups.splice(0, tab_groups.length, ...groups.map((group) => ({
        viewColumn: group.viewColumn,
        tabs: [...group.tabs],
    })));
    const active = tab_groups.find((group) => group.viewColumn === active_view_column);
    if (!active) throw new Error(`No mock tab group for view column ${active_view_column}.`);
    active_tab_group = active;
}

export function __setCloseTabImplementation(
    impl: ((tab: MockTab) => Promise<boolean>) | undefined,
): void {
    close_tab_impl = impl;
}

export function __getClosedTabs(): readonly MockTab[] {
    return closed_tabs;
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
