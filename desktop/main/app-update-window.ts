// State and interaction model for the non-modal update window. Electron window
// creation stays in main.ts; keeping this module platform-free makes the exact
// close/dismiss semantics testable without launching the GUI.

import type { UpdateProgress } from './app-updates';

export type AppUpdateWindowState =
    | { readonly kind: 'available'; readonly version: string; readonly installUpdates: boolean }
    | { readonly kind: 'downloading'; readonly version: string; readonly progress?: UpdateProgress }
    | { readonly kind: 'ready'; readonly version: string };

export type AppUpdateWindowAction = 'primary' | 'secondary';
export type AppUpdatePromptChoice = 'accept' | 'dismiss' | 'closed';

export interface AppUpdateWindowHost {
    /** Create or update the independent update window. Focus only for a state
     *  that asks for a decision, not for background progress updates. */
    present(state: AppUpdateWindowState, focus: boolean): void;
    close(): void;
}

export interface AppUpdateWindowPresenter {
    readonly state: AppUpdateWindowState | undefined;
    offer_download(
        version: string,
        install_updates: boolean,
        focus?: boolean,
    ): Promise<AppUpdatePromptChoice>;
    show_downloading(version: string): void;
    update_download_progress(progress: UpdateProgress): void;
    offer_restart(version: string): Promise<AppUpdatePromptChoice>;
    show_update_available(): void;
    show_download_in_progress(): void;
    handle_action(action: AppUpdateWindowAction): void;
    /** `dismissed` is false when app shutdown, rather than the user, closed it. */
    handle_window_closed(dismissed: boolean): void;
    dismiss(): void;
}

export function displayed_update_percent(percent: number): number {
    if (!Number.isFinite(percent)) return 0;
    return Math.round(Math.max(0, Math.min(100, percent)));
}

/** A check-only build hands installation off to the browser. Once the user has
 *  accepted, the prompt is settled, so it must close even if the OS rejects the
 *  external-open request. */
export async function open_manual_update_page(
    open: () => Promise<unknown>,
    dismiss: () => void,
): Promise<'dismiss'> {
    try {
        await open();
    } finally {
        dismiss();
    }
    return 'dismiss';
}

export function create_app_update_window_presenter(
    host: AppUpdateWindowHost,
): AppUpdateWindowPresenter {
    let state: AppUpdateWindowState | undefined;
    let visible = false;
    let pending: {
        kind: 'available' | 'ready';
        resolve: (choice: AppUpdatePromptChoice) => void;
    } | undefined;

    const settle = (choice: AppUpdatePromptChoice, close: boolean): void => {
        const current = pending;
        pending = undefined;
        current?.resolve(choice);
        if (close) host.close();
    };

    const replace_prompt = (
        next: AppUpdateWindowState & { kind: 'available' | 'ready' },
        focus = true,
    ): Promise<AppUpdatePromptChoice> => {
        // A coordinator should never overlap prompts, but resolving an obsolete
        // one is safer than leaving a promise permanently pending if it does.
        settle('closed', false);
        state = next;
        visible = true;
        host.present(next, focus);
        return new Promise((resolve) => {
            pending = { kind: next.kind, resolve };
        });
    };

    return {
        get state() { return state; },
        offer_download: (version, installUpdates, focus = true) => replace_prompt({
            kind: 'available', version, installUpdates,
        }, focus),
        show_downloading(version) {
            state = { kind: 'downloading', version };
            visible = true;
            host.present(state, false);
        },
        update_download_progress(progress) {
            if (state?.kind !== 'downloading') return;
            const previous = state.progress;
            state = { ...state, progress };
            // The renderer rounds the displayed percentage. Coalescing at that
            // same boundary bounds both IPC and native window work while still
            // retaining the most recent byte counts for a later reveal.
            if (visible && (!previous
                || displayed_update_percent(previous.percent)
                    !== displayed_update_percent(progress.percent))) {
                host.present(state, false);
            }
        },
        offer_restart: (version) => replace_prompt({ kind: 'ready', version }),
        show_update_available() {
            if (state?.kind === 'available') {
                visible = true;
                host.present(state, true);
            }
        },
        show_download_in_progress() {
            if (state?.kind === 'downloading') {
                visible = true;
                host.present(state, true);
            }
        },
        handle_action(action) {
            if (!pending || pending.kind !== state?.kind) return;
            // Keep the accepted available window in place so its next state can
            // become download progress without a close/reopen flicker.
            const keep_for_download = pending.kind === 'available' && action === 'primary';
            settle(action === 'primary' ? 'accept' : 'dismiss', !keep_for_download);
        },
        handle_window_closed(dismissed) {
            visible = false;
            settle(dismissed ? 'dismiss' : 'closed', false);
        },
        dismiss() {
            visible = false;
            settle('closed', true);
            state = undefined;
        },
    };
}
