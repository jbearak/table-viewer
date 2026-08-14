// Update policy for the packaged desktop app. Electron wiring stays in main.ts;
// this state machine only sees injected updater, dialog, and quit ports so its
// user-visible behavior is testable without launching a GUI.

import {
    classify_app_update_failure,
    type AppUpdateFailure,
    type AppUpdateFailurePhase,
} from './app-update-failure';
import type { AppUpdatePromptChoice } from './app-update-window';

export type UpdateCheckSource = 'automatic' | 'manual';

export interface UpdateInfo {
    readonly version: string;
}

export interface UpdateProgress {
    readonly percent: number;
    readonly transferred: number;
    readonly total: number;
    readonly bytesPerSecond?: number;
}

export interface AppUpdateEngine {
    check_for_updates(): Promise<void>;
    download_update(): Promise<void>;
    quit_and_install(): void;
    is_online(): boolean | undefined;
    on_update_available(listener: (info: UpdateInfo) => void): void;
    on_update_not_available(listener: () => void): void;
    on_update_downloaded(listener: (info: UpdateInfo) => void): void;
    on_download_progress(listener: (progress: UpdateProgress) => void): void;
    on_error(listener: (error: unknown) => void): void;
}

export interface AppUpdateDialogs {
    offer_download(
        version: string,
        install_updates: boolean,
        focus: boolean,
    ): Promise<AppUpdatePromptChoice>;
    show_downloading(version: string): void;
    update_download_progress(progress: UpdateProgress): void;
    offer_restart(version: string): Promise<AppUpdatePromptChoice>;
    show_update_available(): void;
    show_up_to_date(): Promise<void>;
    show_failure(failure: AppUpdateFailure): Promise<void>;
    show_download_in_progress(): void;
    dismiss(): void;
}

export type AppUpdateInstallResult = 'not-requested' | 'started' | 'failed';

export interface AppUpdateCoordinator {
    check_automatically(): void;
    check_manually(): void;
    begin_shutdown(): void;
    cancel_install_request(): void;
    install_if_requested(): AppUpdateInstallResult;
}

export interface AppUpdatePolicy {
    readonly install_updates: boolean;
    readonly dismissed_version?: () => string;
    readonly dismiss_version?: (version: string) => void;
}

/** Release versions are numeric triples in both updater feeds. Keep equality as
 *  a safe fallback if a future updater returns an unfamiliar version string. */
export function update_is_already_dismissed(candidate: string, dismissed: string): boolean {
    if (candidate === dismissed) return true;
    const parse = (version: string): [number, number, number] | undefined => {
        const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
        if (!match) return undefined;
        return [Number(match[1]), Number(match[2]), Number(match[3])];
    };
    const left = parse(candidate);
    const right = parse(dismissed);
    if (!left || !right) return false;
    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) return left[index] < right[index];
    }
    return true;
}

export function create_app_update_coordinator(
    engine: AppUpdateEngine,
    dialogs: AppUpdateDialogs,
    request_quit: () => void,
    policy: AppUpdatePolicy = { install_updates: true },
): AppUpdateCoordinator {
    let check_source: UpdateCheckSource | undefined;
    let checking = false;
    let offering_download = false;
    let downloading = false;
    let downloaded_version: string | undefined;
    let offering_restart = false;
    let install_requested = false;
    let shutting_down = false;
    let prompt_generation = 0;
    let operation_generation = 0;
    let active_operation: {
        generation: number;
        phase: AppUpdateFailurePhase;
        ignored_errors: WeakSet<object>;
    } | undefined;

    const ignore_dialog_error = (show: () => void): void => {
        try {
            show();
        } catch {
            // Update UI is advisory. A failed window operation must not take the
            // main process down or cancel an updater operation already underway.
        }
    };

    const clear_operation = (): void => {
        active_operation = undefined;
    };

    const finish_error = (error: unknown, expected_generation?: number): void => {
        const operation = active_operation;
        const generation = expected_generation ?? operation?.generation;
        if (generation == null || operation == null) return;
        if (expected_generation != null && operation.generation !== expected_generation) return;
        if ((typeof error === 'object' && error !== null) || typeof error === 'function') {
            if (operation.ignored_errors.has(error)) return;
        }
        if (!checking && !offering_download && !downloading) return;

        const source = check_source;
        const phase = active_operation?.phase ?? (downloading ? 'download' : 'check');
        checking = false;
        offering_download = false;
        downloading = false;
        check_source = undefined;
        clear_operation();
        prompt_generation += 1;
        ignore_dialog_error(() => dialogs.dismiss());

        if (source === 'manual') {
            let is_online: boolean | undefined;
            try {
                is_online = engine.is_online();
            } catch {
                is_online = undefined;
            }
            void dialogs.show_failure(
                classify_app_update_failure(phase, error, is_online),
            ).catch(() => {});
        }
    };

    const start_check = (source: UpdateCheckSource): void => {
        checking = true;
        check_source = source;
        const generation = ++operation_generation;
        const ignored_errors = new WeakSet<object>();
        active_operation = { generation, phase: 'check', ignored_errors };
        try {
            void engine.check_for_updates().then(() => {
                // Updater events are the normal terminal signal. If an engine
                // resolves without one, fail closed instead of leaving every
                // later manual check coalesced into a permanently "checking" state.
                if (checking && active_operation?.generation === generation) {
                    finish_error(undefined, generation);
                }
            }).catch((error: unknown) => {
                finish_error(error, generation);
                if ((typeof error === 'object' && error !== null) || typeof error === 'function') {
                    ignored_errors.add(error);
                }
            });
        } catch (error) {
            finish_error(error, generation);
        }
    };

    const run_check = (source: UpdateCheckSource): void => {
        if (shutting_down) return;
        if (downloaded_version) {
            if (source === 'manual' && !offering_restart) void offer_restart(downloaded_version);
            return;
        }
        if (offering_download || downloading) {
            if (source === 'manual') {
                ignore_dialog_error(() => {
                    if (offering_download) dialogs.show_update_available();
                    else dialogs.show_download_in_progress();
                });
            }
            return;
        }
        if (checking) {
            // A manual request upgrades a silent automatic check so its terminal
            // no-update/error result gets the feedback the user asked for.
            if (source === 'manual') check_source = 'manual';
            return;
        }
        start_check(source);
    };

    const offer_restart = async (version: string): Promise<void> => {
        offering_restart = true;
        const generation = ++prompt_generation;
        let choice: AppUpdatePromptChoice = 'closed';
        try {
            choice = await dialogs.offer_restart(version);
        } catch {
            return;
        } finally {
            if (generation === prompt_generation) offering_restart = false;
        }
        if (generation !== prompt_generation) return;
        if (choice === 'dismiss') {
            install_requested = false;
            return;
        }
        if (choice !== 'accept') return;
        install_requested = true;
        request_quit();
    };

    engine.on_update_available((info) => {
        if (!checking) return;
        const source = check_source;
        const dismissed = policy.dismissed_version?.() ?? '';
        if (source === 'automatic' && dismissed
            && update_is_already_dismissed(info.version, dismissed)) {
            checking = false;
            check_source = undefined;
            clear_operation();
            return;
        }
        checking = false;
        offering_download = true;
        const generation = ++prompt_generation;
        void dialogs.offer_download(
            info.version,
            policy.install_updates,
            source === 'manual',
        ).then((choice) => {
            if (generation !== prompt_generation) return;
            offering_download = false;
            if (choice === 'dismiss') {
                const already_dismissed = policy.dismissed_version?.() ?? '';
                // A manual check can surface an older feed version. Skipping it
                // must never lower the remembered high-water mark and resurrect
                // a newer version the user had already skipped.
                if (!already_dismissed
                    || !update_is_already_dismissed(info.version, already_dismissed)) {
                    policy.dismiss_version?.(info.version);
                }
            }
            if (!policy.install_updates || choice !== 'accept' || downloading) {
                check_source = undefined;
                clear_operation();
                return;
            }
            downloading = true;
            ignore_dialog_error(() => dialogs.show_downloading(info.version));
            const operation = ++operation_generation;
            const ignored_errors = new WeakSet<object>();
            active_operation = { generation: operation, phase: 'download', ignored_errors };
            try {
                void engine.download_update().catch((error: unknown) => {
                    finish_error(error, operation);
                    if ((typeof error === 'object' && error !== null)
                        || typeof error === 'function') {
                        ignored_errors.add(error);
                    }
                });
            } catch (error) {
                finish_error(error, operation);
            }
        }).catch(() => {
            if (generation !== prompt_generation) return;
            offering_download = false;
            check_source = undefined;
            clear_operation();
        });
    });

    engine.on_update_not_available(() => {
        if (!checking) return;
        const show = check_source === 'manual';
        checking = false;
        check_source = undefined;
        clear_operation();
        prompt_generation += 1;
        if (show) void dialogs.show_up_to_date().catch(() => {});
    });

    engine.on_update_downloaded((info) => {
        if (!downloading) return;
        downloading = false;
        check_source = undefined;
        clear_operation();
        downloaded_version = info.version;
        void offer_restart(info.version);
    });

    engine.on_download_progress((progress) => {
        if (downloading) {
            ignore_dialog_error(() => dialogs.update_download_progress(progress));
        }
    });

    engine.on_error((error) => finish_error(error));

    return {
        check_automatically: () => run_check('automatic'),
        check_manually: () => run_check('manual'),
        begin_shutdown: () => { shutting_down = true; },
        cancel_install_request: () => {
            shutting_down = false;
            install_requested = false;
        },
        install_if_requested: () => {
            if (!install_requested) return 'not-requested';
            try {
                engine.quit_and_install();
            } catch {
                return 'failed';
            }
            install_requested = false;
            return 'started';
        },
    };
}
