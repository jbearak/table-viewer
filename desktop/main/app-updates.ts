// Update policy for the packaged desktop app. Electron wiring stays in main.ts;
// this state machine only sees injected updater, dialog, and quit ports so its
// user-visible behavior is testable without launching a GUI.

export type UpdateCheckSource = 'automatic' | 'manual';

export interface UpdateInfo {
    readonly version: string;
}

export interface AppUpdateEngine {
    check_for_updates(): Promise<void>;
    download_update(): Promise<void>;
    quit_and_install(): void;
    on_update_available(listener: (info: UpdateInfo) => void): void;
    on_update_not_available(listener: () => void): void;
    on_update_downloaded(listener: (info: UpdateInfo) => void): void;
    on_error(listener: () => void): void;
}

export interface AppUpdateDialogs {
    offer_download(version: string): Promise<boolean>;
    offer_restart(version: string): Promise<boolean>;
    show_up_to_date(): Promise<void>;
    show_check_error(): Promise<void>;
    show_download_in_progress(): Promise<void>;
}

export interface AppUpdateCoordinator {
    check_automatically(): void;
    check_manually(): void;
    install_if_requested(): boolean;
}

export function create_app_update_coordinator(
    engine: AppUpdateEngine,
    dialogs: AppUpdateDialogs,
    request_quit: () => void,
): AppUpdateCoordinator {
    let check_source: UpdateCheckSource | undefined;
    let checking = false;
    let offering_download = false;
    let downloading = false;
    let downloaded_version: string | undefined;
    let offering_restart = false;
    let install_requested = false;
    let prompt_generation = 0;

    const run_check = (source: UpdateCheckSource): void => {
        if (downloaded_version) {
            if (source === 'manual' && !offering_restart) void offer_restart(downloaded_version);
            return;
        }
        if (offering_download || downloading) {
            if (source === 'manual') void dialogs.show_download_in_progress();
            return;
        }
        if (checking) {
            // A manual request upgrades a silent automatic check so its terminal
            // no-update/error result gets the feedback the user asked for.
            if (source === 'manual') check_source = 'manual';
            return;
        }
        checking = true;
        check_source = source;
        void engine.check_for_updates().catch(() => finish_error());
    };

    const finish_error = (): void => {
        if (!checking && !offering_download && !downloading) return;
        const show = check_source === 'manual';
        checking = false;
        offering_download = false;
        downloading = false;
        check_source = undefined;
        prompt_generation += 1;
        if (show) void dialogs.show_check_error();
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
        void dialogs.offer_download(info.version).then((accepted) => {
            offering_download = false;
            if (!accepted || generation !== prompt_generation || downloading) {
                check_source = undefined;
                return;
            }
            downloading = true;
            void engine.download_update().catch(() => finish_error());
        }).catch(() => {
            offering_download = false;
            if (generation !== prompt_generation) return;
            check_source = undefined;
        });
    });

    engine.on_update_not_available(() => {
        if (!checking) return;
        const show = check_source === 'manual';
        checking = false;
        check_source = undefined;
        prompt_generation += 1;
        if (show) void dialogs.show_up_to_date();
    });

    engine.on_update_downloaded((info) => {
        if (!downloading) return;
        downloading = false;
        check_source = undefined;
        downloaded_version = info.version;
        void offer_restart(info.version);
    });

    engine.on_error(() => finish_error());

    return {
        check_automatically: () => run_check('automatic'),
        check_manually: () => run_check('manual'),
        install_if_requested: () => {
            if (!install_requested) return false;
            install_requested = false;
            engine.quit_and_install();
            return true;
        },
    };
}
