// Update policy for the packaged desktop app. Electron wiring stays in main.ts;
// this state machine only sees injected updater, dialog, and quit ports so its
// user-visible behavior is testable without launching a GUI.

import {
    classify_app_update_failure,
    type AppUpdateFailure,
    type AppUpdateFailurePhase,
} from './app-update-failure';

export type UpdateCheckSource = 'automatic' | 'manual';

export interface UpdateInfo {
    readonly version: string;
}

export interface AppUpdateEngine {
    check_for_updates(): Promise<void>;
    download_update(): Promise<void>;
    quit_and_install(): void;
    is_online(): boolean | undefined;
    on_update_available(listener: (info: UpdateInfo) => void): void;
    on_update_not_available(listener: () => void): void;
    on_update_downloaded(listener: (info: UpdateInfo) => void): void;
    on_error(listener: (error: unknown) => void): void;
}

export interface AppUpdateDialogs {
    offer_download(version: string, install_updates: boolean): Promise<boolean>;
    offer_restart(version: string): Promise<boolean>;
    show_up_to_date(): Promise<void>;
    show_failure(failure: AppUpdateFailure): Promise<void>;
    show_download_in_progress(): Promise<void>;
}

export type AppUpdateInstallResult = 'not-requested' | 'started' | 'failed';

export interface AppUpdateCoordinator {
    check_automatically(): void;
    check_manually(): void;
    install_if_requested(): AppUpdateInstallResult;
}

export interface AppUpdatePolicy {
    readonly install_updates: boolean;
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
    let prompt_generation = 0;
    let operation_generation = 0;
    let active_operation: {
        generation: number;
        phase: AppUpdateFailurePhase;
        ignored_errors: WeakSet<object>;
    } | undefined;

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
        if (downloaded_version) {
            if (source === 'manual' && !offering_restart) void offer_restart(downloaded_version);
            return;
        }
        if (offering_download || downloading) {
            if (source === 'manual' && (downloading || policy.install_updates)) {
                void dialogs.show_download_in_progress().catch(() => {});
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
        let accepted = false;
        try {
            accepted = await dialogs.offer_restart(version);
        } catch {
            return;
        } finally {
            if (generation === prompt_generation) offering_restart = false;
        }
        if (!accepted || generation !== prompt_generation) return;
        install_requested = true;
        request_quit();
    };

    engine.on_update_available((info) => {
        if (!checking) return;
        checking = false;
        offering_download = true;
        const generation = ++prompt_generation;
        void dialogs.offer_download(info.version, policy.install_updates).then((accepted) => {
            if (generation !== prompt_generation) return;
            offering_download = false;
            if (!policy.install_updates || !accepted || downloading) {
                check_source = undefined;
                clear_operation();
                return;
            }
            downloading = true;
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

    engine.on_error((error) => finish_error(error));

    return {
        check_automatically: () => run_check('automatic'),
        check_manually: () => run_check('manual'),
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
