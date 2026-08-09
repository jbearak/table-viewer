import * as path from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { build } from 'esbuild';

interface WorkerError {
    readonly name: string;
    readonly message: string;
    readonly category?: string;
    readonly operation?: string;
}

type WorkerMessage =
    | { readonly type: 'ready'; readonly pid: number; readonly sessionId?: string }
    | { readonly type: 'event'; readonly name: string; readonly value?: unknown }
    | { readonly type: 'result'; readonly id: number; readonly value: unknown }
    | { readonly type: 'error'; readonly id: number; readonly error: WorkerError };

export interface SqliteWorkerOptions {
    readonly mode?: 'store' | 'raw' | 'recovery';
    readonly maxStoredFiles?: number;
    readonly timeoutMs?: number;
    readonly readyEventName?: string;
    readonly ambiguousCommit?: {
        readonly reconciliationReleasePath: string;
    };
}

export interface SqliteWorkerEvent {
    readonly name: string;
    readonly value?: unknown;
}

export class SqliteWorkerRequestError extends Error {
    readonly category?: string;
    readonly operation?: string;

    constructor(error: WorkerError) {
        super(error.message);
        this.name = error.name;
        this.category = error.category;
        this.operation = error.operation;
    }
}

function withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    description: string,
    onTimeout?: () => void,
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
            onTimeout?.();
            reject(new Error(`Timed out waiting for ${description}.`));
        }, timeoutMs);
        timer.unref();
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}

export async function build_sqlite_process_worker(outputDirectory: string): Promise<string> {
    const outputPath = path.join(outputDirectory, 'sqlite-process-worker.cjs');
    await build({
        entryPoints: [path.resolve(__dirname, '../fixtures/sqlite-process-worker.ts')],
        outfile: outputPath,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node26',
        external: ['node:sqlite'],
        logLevel: 'silent',
    });
    return outputPath;
}

export class SqliteChildProcess {
    readonly pid: number;
    readonly sessionId?: string;
    readonly #child: ChildProcess;
    readonly #timeoutMs: number;
    readonly #pending = new Map<number, {
        resolve(value: unknown): void;
        reject(error: unknown): void;
    }>();
    readonly #events: SqliteWorkerEvent[] = [];
    readonly #eventWaiters: Array<{
        readonly predicate: (event: SqliteWorkerEvent) => boolean;
        resolve(event: SqliteWorkerEvent): void;
        reject(error: unknown): void;
    }> = [];
    #nextId = 1;
    #exited = false;

    private constructor(
        child: ChildProcess,
        ready: { readonly pid: number; readonly sessionId?: string },
        timeoutMs: number,
    ) {
        this.#child = child;
        this.pid = ready.pid;
        this.sessionId = ready.sessionId;
        this.#timeoutMs = timeoutMs;
    }

    static async spawn(
        workerPath: string,
        databasePath: string,
        options: SqliteWorkerOptions = {},
    ): Promise<SqliteChildProcess> {
        const timeoutMs = options.timeoutMs ?? 10_000;
        const child = fork(workerPath, [], {
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            env: {
                ...process.env,
                TABLE_VIEWER_SQLITE_WORKER_DATABASE: databasePath,
                TABLE_VIEWER_SQLITE_WORKER_OPTIONS: JSON.stringify(options),
            },
        });
        let routeMessage: (message: WorkerMessage) => void;
        let worker: SqliteChildProcess | undefined;
        let earlyExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
        let rejectReadiness!: (error: unknown) => void;
        const earlyMessages: WorkerMessage[] = [];
        const readyPromise = new Promise<{ pid: number; sessionId?: string }>((resolve, reject) => {
            rejectReadiness = reject;
            routeMessage = (message) => {
                if (message.type === 'ready') resolve({ pid: message.pid, sessionId: message.sessionId });
                else earlyMessages.push(message);
            };
            child.once('error', reject);
        });
        child.on('message', (message) => routeMessage(message as WorkerMessage));
        child.on('exit', (code, signal) => {
            earlyExit = { code, signal };
            if (worker) worker.#onExit(code, signal);
            else rejectReadiness(new Error(
                `SQLite worker exited before readiness (code ${String(code)}, signal ${String(signal)}).`,
            ));
        });
        let ready: { pid: number; sessionId?: string };
        try {
            ready = await withTimeout(readyPromise, timeoutMs, 'SQLite worker readiness');
        } catch (error) {
            if (child.exitCode === null && child.signalCode === null) {
                await new Promise<void>((resolve) => {
                    child.once('exit', () => resolve());
                    child.kill('SIGKILL');
                });
            }
            throw error;
        }
        worker = new SqliteChildProcess(child, ready, timeoutMs);
        routeMessage = (message) => {
            if (worker) worker.#onMessage(message);
        };
        for (const message of earlyMessages) worker.#onMessage(message);
        if (earlyExit) worker.#onExit(earlyExit.code, earlyExit.signal);
        return worker;
    }

    #onExit(code: number | null, signal: NodeJS.Signals | null): void {
        if (this.#exited) return;
        this.#exited = true;
        const error = new Error(`SQLite worker exited (code ${String(code)}, signal ${String(signal)}).`);
        for (const pending of this.#pending.values()) pending.reject(error);
        this.#pending.clear();
        for (const waiter of this.#eventWaiters.splice(0)) waiter.reject(error);
    }

    #onMessage(message: WorkerMessage): void {
        if (message.type === 'event') {
            const event = { name: message.name, value: message.value };
            const waiterIndex = this.#eventWaiters.findIndex((waiter) => waiter.predicate(event));
            if (waiterIndex >= 0) this.#eventWaiters.splice(waiterIndex, 1)[0].resolve(event);
            else this.#events.push(event);
            return;
        }
        if (message.type !== 'result' && message.type !== 'error') return;
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        if (message.type === 'result') pending.resolve(message.value);
        else pending.reject(new SqliteWorkerRequestError(message.error));
    }

    request<T = unknown>(command: string, payload: unknown = {}): Promise<T> {
        if (this.#exited || !this.#child.connected) {
            return Promise.reject(new Error('SQLite worker is not connected.'));
        }
        const id = this.#nextId++;
        const result = new Promise<T>((resolve, reject) => {
            this.#pending.set(id, {
                resolve: (value) => resolve(value as T),
                reject,
            });
            this.#child.send({ id, command, payload }, (error) => {
                if (!error) return;
                this.#pending.delete(id);
                reject(error);
            });
        });
        return withTimeout(
            result,
            this.#timeoutMs,
            `SQLite worker command ${command}`,
            () => this.#pending.delete(id),
        );
    }

    waitForEvent(name: string): Promise<SqliteWorkerEvent> {
        return this.#waitForMatchingEvent((event) => event.name === name, `SQLite worker event ${name}`);
    }

    waitForBarrier(barrierId: string, name?: string, occurrence?: number): Promise<SqliteWorkerEvent> {
        return this.#waitForMatchingEvent((event) => {
            if (event.name !== 'barrier' || typeof event.value !== 'object' || event.value === null) return false;
            const value = event.value as { barrierId?: unknown; name?: unknown; occurrence?: unknown };
            return value.barrierId === barrierId
                && (name === undefined || value.name === name)
                && (occurrence === undefined || value.occurrence === occurrence);
        }, `SQLite worker barrier ${barrierId}${occurrence === undefined ? '' : ` occurrence ${occurrence}`}`);
    }

    async releaseBarrier(barrierId: string): Promise<void> {
        await this.request('releaseBarrier', { barrierId });
    }

    #waitForMatchingEvent(
        predicate: (event: SqliteWorkerEvent) => boolean,
        description: string,
    ): Promise<SqliteWorkerEvent> {
        const existing = this.#events.findIndex(predicate);
        if (existing >= 0) return Promise.resolve(this.#events.splice(existing, 1)[0]);
        let waiter!: {
            readonly predicate: (event: SqliteWorkerEvent) => boolean;
            resolve(event: SqliteWorkerEvent): void;
            reject(error: unknown): void;
        };
        const result = new Promise<SqliteWorkerEvent>((resolve, reject) => {
            waiter = { predicate, resolve, reject };
            this.#eventWaiters.push(waiter);
        });
        return withTimeout(result, this.#timeoutMs, description, () => {
            const waiterIndex = this.#eventWaiters.indexOf(waiter);
            if (waiterIndex >= 0) this.#eventWaiters.splice(waiterIndex, 1);
        });
    }

    async close(): Promise<void> {
        if (this.#exited) return;
        try {
            await this.request('close');
        } finally {
            if (!this.#exited) this.#child.kill();
        }
    }

    async crash(): Promise<void> {
        if (this.#exited) return;
        await new Promise<void>((resolve) => {
            this.#child.once('exit', () => resolve());
            this.#child.kill('SIGKILL');
        });
    }
}
