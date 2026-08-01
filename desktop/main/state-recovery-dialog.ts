// The desktop app's response to a file-state database that will not open.
//
// A viewer without its state authority is not a degraded viewer — it is a
// different, silently wrong one, so there is no automatic fallback here. Every
// outcome is a choice the user makes in a modal: retry, look at the diagnostics
// folder, quit, or preserve the existing database and start a fresh one. In
// particular nothing in this module ever deletes, truncates, or resets state;
// the destructive-sounding option is a *preserve* (move aside) followed by a
// fresh open, and it is gated behind a second, explicit confirmation.
//
// Electron-free on purpose, following the injected-port pattern in
// desktop-host-ports.ts: the flow is a pure state machine over injected dialog
// callbacks, so it is unit-testable without a display, and main.ts binds the
// callbacks to electron `dialog` / `shell`.
//
// The user-facing prose and the button layout live here too, next to the kind
// union they are derived from, rather than in main.ts: the plan's requirements
// are *about that prose* (an I/O error must never be called corruption, a
// schema/identity mismatch must never be called corruption), and a string that
// only exists inside a module which imports electron is a string no test can
// read.
import type { SqliteFileStateErrorCategory } from '../../src/sqlite-file-state-errors';

/** What the user chose in the recovery modal. Only `quit` and a successful open
 *  end the flow; the rest loop. */
export type StateRecoveryChoice = 'retry' | 'open-diagnostics' | 'quit' | 'preserve-and-create';

/**
 * The failure reduced to the shape the dialog layer is allowed to word. Kinds
 * are coarser than error categories on purpose: they are the distinct *stories*
 * we can honestly tell a user, and several of them exist specifically to stop
 * one story being told in place of another.
 *
 * - `transient`   the database is busy or locked, or a coordination invariant
 *                 this build asserts did not hold on this attempt.
 *                 Retry-oriented; never quarantine or reset.
 * - `environment` the path is read-only or unreachable. Nothing is wrong with
 *                 the data, so we must not offer an empty authority as a fix.
 * - `capacity`    storage is full. The attempted change was rolled back and is
 *                 not durable — say so rather than implying data loss.
 * - `io`          a device-level read/write failure. Preserve and fail closed.
 *                 The wording must NOT relabel this as corruption: an I/O error
 *                 is a statement about the device, and calling it corruption
 *                 would push the user toward discarding intact data.
 * - `corrupt`     the file really is not a well-formed database. This is the
 *                 one kind where "corrupt" is the honest word.
 * - `compatibility` the schema or application identity is not ours, or the
 *                 stored protocol/coordination fence is outside what this build
 *                 negotiates. An ownership/version error, NOT corruption — the
 *                 file may be perfectly valid and belong to another product or
 *                 a newer build.
 * - `unsupported-platform` this build cannot store its view settings here at
 *                 all, because a durability guarantee it requires is not
 *                 available on this system or location. Nothing is wrong with
 *                 any data and nobody else owns it: the app simply refuses to
 *                 pretend a flush happened. Preservation is *impossible* here,
 *                 not merely unhelpful — see `can_preserve`.
 * - `interrupted` a previous preserve/move did not finish. The preserve action
 *                 resumes that state machine rather than starting a new one.
 * - `leftover-setup` a first-run initialization did not finish, leaving setup
 *                 files with no database beside them. No move was ever started,
 *                 so this must not be told as a resumed one; the preserve action
 *                 sets the leftovers aside and starts fresh.
 * - `unknown`     unclassified. Conservative wording; preservation is offered
 *                 only behind the confirmation, like everything else.
 */
export type StateRecoveryKind =
    | 'transient'
    | 'environment'
    | 'capacity'
    | 'io'
    | 'corrupt'
    | 'compatibility'
    | 'unsupported-platform'
    | 'interrupted'
    | 'leftover-setup'
    | 'unknown';

/**
 * Everything the dialog layer gets. Deliberately three scalars: no path, no
 * filename, no SQL, no digest, no persisted payload. A recovery modal is shown
 * at the moment the app trusts its own state the least, and echoing any of that
 * back is how a diagnostic string becomes a leak or a phishing surface. The
 * dialog layer composes user-facing prose from `kind` alone.
 */
export interface StateRecoveryDetail {
    /** The raw failure category, for wording within a kind. Narrowed to the
     *  concrete SQLite category union rather than `string`: the desktop's only
     *  producer is `categorize_sqlite_file_state_error`, and a `string` here let
     *  a caller invent a category that silently classified as `unknown`. */
    readonly category: SqliteFileStateErrorCategory;
    readonly kind: StateRecoveryKind;
    /** Whether preserve-and-create is a coherent offer for this failure. False
     *  where the data is fine and only the environment is wrong: moving a file
     *  aside cannot fix a read-only directory, and trying would fail the same
     *  way while making the user believe their state was quarantined. */
    readonly canPreserve: boolean;
}

export interface StateRecoveryDialogs {
    show_recovery(detail: StateRecoveryDetail): Promise<StateRecoveryChoice>;
    /** Second, explicit modal. True only on an affirmative all-processes-closed attestation. */
    confirm_preserve(detail: StateRecoveryDetail): Promise<boolean>;
    open_folder(directory: string): Promise<void>;
    /** Takes no detail on purpose: its prose is fixed, and the honest invariants
     *  it states (the move did not complete, nothing was deleted, the next
     *  attempt resumes it) hold for every kind that can reach it. A parameter no
     *  implementation reads would only invite one to start rendering it. */
    show_error(): Promise<void>;
}

/** The structural shape of a failure this flow accepts.
 *
 *  The category, plus the three already-sanitized discriminators that decide
 *  *which* story a category gets when one category carries two meanings. They
 *  reach the classifier and stop there: `StateRecoveryDetail` is still only the
 *  three scalars a dialog may see, so `operation` — which names an internal SQL
 *  or coordination step — belongs to the log (main.ts logs it on every attempt,
 *  including retries) and never to a modal.
 *
 *  Every field here is provably non-sensitive: `operation` is narrowed upstream
 *  to `[A-Za-z][A-Za-z0-9_-]{0,63}`, and `protocol` / `coordinationGeneration`
 *  are non-negative safe integers (see `sanitize_metadata` in
 *  src/sqlite-file-state-errors.ts). No path, filename, SQL, or digest. */
export interface StateRecoveryFailure {
    readonly category: SqliteFileStateErrorCategory;
    /** The sanitized failing stage. Distinguishes an orphaned first-run setup
     *  (`absent-main-evidence`) from a genuinely interrupted preserve. */
    readonly operation?: string;
    /** Set only by the version/ownership fence throws — a stored reader/writer
     *  protocol bound outside what this build negotiates. */
    readonly protocol?: number;
    /** Set only by the coordination-generation fence throws, for the same
     *  reason. */
    readonly coordinationGeneration?: number;
}

/** The headline and body of one recovery modal. */
export interface StateRecoveryWording {
    readonly message: string;
    readonly detail: string;
}

/**
 * The headline and body for one recovery kind.
 *
 * Written as one switch rather than a lookup table so a new `StateRecoveryKind`
 * is a compile error here: the whole point of the kinds is that each gets its
 * own honest story, and a missing arm would silently borrow the wrong one. Every
 * string is composed from `kind` alone — no path, no filename, no SQL, no
 * digest, no persisted value ever reaches a modal.
 *
 * Exported and electron-free so the prose itself is under test (see
 * desktop/test/state-recovery-dialog.test.ts). Two of the arms exist purely to
 * stop one story being told in place of another, and only a test can hold that:
 * `io` must never be relabeled corruption, and neither must `compatibility`.
 */
export function state_recovery_wording(kind: StateRecoveryKind): StateRecoveryWording {
    switch (kind) {
        case 'transient':
            return {
                message: 'Table Viewer could not open its saved view settings right now.',
                detail: 'Another Table Viewer window or process is probably still using them.'
                    + ' Close any other Table Viewer window and try again. Nothing is wrong'
                    + ' with the saved data.',
            };
        case 'environment':
            return {
                message: 'Table Viewer cannot reach the place it keeps its saved view settings.',
                detail: 'The location is unreadable, unwritable, or not currently available —'
                    + ' for example on a disconnected network volume, or under permissions that'
                    + ' no longer allow writing. The saved data itself is intact, so there is'
                    + ' nothing here to repair: restore access to the location and try again.',
            };
        case 'capacity':
            return {
                message: 'There is not enough free storage for Table Viewer to open its saved'
                    + ' view settings.',
                detail: 'The change it was making has been rolled back, so nothing was saved'
                    + ' and nothing was lost. Free some space and try again.',
            };
        case 'io':
            // Deliberately never called corruption: an I/O error is a statement
            // about the device, and naming it corruption would push the user
            // toward discarding data that is very likely still intact.
            return {
                message: 'The disk reported an error while Table Viewer was reading its saved'
                    + ' view settings.',
                detail: 'This is a problem with the storage device or its connection, not'
                    + ' necessarily with the saved data. Table Viewer has stopped rather than'
                    + ' write anything further. Check the drive, then try again.',
            };
        case 'corrupt':
            return {
                message: 'Table Viewer’s saved view settings are damaged and cannot be read.',
                detail: 'The file is no longer a well-formed database. If you continue by'
                    + ' setting it aside, Table Viewer keeps the damaged copy for'
                    + ' troubleshooting and starts a new empty one — but any unsaved CSV edits'
                    + ' it was holding would not carry over. Your CSV, TSV, and spreadsheet'
                    + ' files on disk are untouched either way.',
            };
        case 'compatibility':
            // An ownership/version problem. The file may be perfectly valid and
            // simply belong to another product or a newer build, so this arm must
            // not borrow the `corrupt` story either.
            return {
                message: 'This copy of Table Viewer cannot use the saved view settings it found.',
                detail: 'They belong to a different Table Viewer product or to a newer version'
                    + ' of the app, so this version has no safe way to read or write them. They'
                    + ' are not damaged. Installing the newer version, or pointing this one at'
                    + ' its own location, is the fix; setting these aside would leave the other'
                    + ' product without them.',
            };
        case 'unsupported-platform':
            // Neither corruption nor ownership: the durability primitive this
            // build requires in order to promise that a saved setting survived a
            // power loss is simply not available here, and the app refuses to
            // pretend otherwise rather than storing settings it cannot stand
            // behind. Saying "another product owns them" here would be a false
            // statement about ownership, and offering to set them aside would
            // offer an action that cannot even run — moving files needs the same
            // guarantee that is missing.
            return {
                message: 'This build of Table Viewer cannot store its view settings on this'
                    + ' system.',
                detail: 'Saving them safely needs a guarantee from the operating system that'
                    + ' this build cannot get here, and Table Viewer will not save settings it'
                    + ' cannot promise to keep. Nothing is wrong with any of your data, and'
                    + ' nothing has been changed or moved. Support for viewing on this system is'
                    + ' still being completed. Your CSV, TSV, and spreadsheet files are'
                    + ' unaffected.',
            };
        case 'interrupted':
            return {
                message: 'A previous attempt to set Table Viewer’s saved view settings aside'
                    + ' did not finish.',
                detail: 'Table Viewer will not guess which half is current, so it has stopped'
                    + ' instead. Continuing resumes that unfinished move rather than starting a'
                    + ' new one. Any unsaved CSV edits the settings were holding may not carry'
                    + ' over; your files on disk are untouched.',
            };
        case 'leftover-setup':
            // The orphaned-first-run case. No move was ever attempted, so the
            // `interrupted` prose ("continuing resumes that unfinished move")
            // would describe a state machine that never started. The action is
            // the same fresh preserve, and its member set includes the leftover
            // setup files, so this arm says exactly that instead.
            return {
                message: 'Table Viewer did not finish setting up its saved view settings the'
                    + ' first time it ran.',
                detail: 'Some setup files were left behind with no finished settings beside'
                    + ' them, so Table Viewer has stopped rather than read a half-built set.'
                    + ' Continuing sets the leftover files aside — keeping them for'
                    + ' troubleshooting, never deleting them — and starts a fresh set. There'
                    + ' were no saved settings to lose, and your files on disk are untouched.',
            };
        case 'unknown':
            return {
                message: 'Table Viewer could not make sense of its saved view settings.',
                detail: 'The cause could not be identified, so nothing has been changed. If you'
                    + ' continue by setting them aside, the existing copy is kept for'
                    + ' troubleshooting and a new empty one is started — but any unsaved CSV'
                    + ' edits it was holding would not carry over. Your files on disk are'
                    + ' untouched.',
            };
    }
}

/** A recovery modal's buttons, and which choice each index answers with. */
export interface StateRecoveryButtonLayout {
    readonly buttons: readonly string[];
    readonly choices: readonly StateRecoveryChoice[];
    /** Retry: the one safe default. */
    readonly defaultId: number;
    /** Dismissal. Always `quit` — never a preserve. */
    readonly cancelId: number;
}

/**
 * Build the button row and the index → choice mapping together.
 *
 * One function so the mapping cannot drift from the button order, which is what
 * makes the conditional Preserve button *safe*: the flow deliberately does not
 * re-check `canPreserve`, so omitting the button here is the whole enforcement
 * of it. Electron-free, so both shapes are under test.
 */
export function state_recovery_button_layout(can_preserve: boolean): StateRecoveryButtonLayout {
    const choices: StateRecoveryChoice[] = ['retry', 'open-diagnostics'];
    const buttons = ['Try Again', 'Open Diagnostics Folder'];
    if (can_preserve) {
        choices.push('preserve-and-create');
        buttons.push('Set Aside and Start Fresh…');
    }
    choices.push('quit');
    buttons.push('Quit Table Viewer');
    return {
        buttons,
        choices,
        // Retry is the safe default; closing the dialog quits rather than
        // silently continuing without a state authority.
        defaultId: 0,
        cancelId: choices.length - 1,
    };
}

/** The choice a button index means. An index outside the row — a platform that
 *  answers with something we did not offer — is read as `quit`, the only answer
 *  that cannot act on the user's data without them having asked. */
export function state_recovery_choice_at(
    layout: StateRecoveryButtonLayout,
    response: number,
): StateRecoveryChoice {
    return layout.choices[response] ?? 'quit';
}

export type StateOpenOutcome<TStore> =
    | { type: 'opened'; opened: TStore }
    | { type: 'failed'; failure: StateRecoveryFailure };

export type StateRecoveryOutcome<TStore> =
    | { type: 'opened'; opened: TStore }
    | { type: 'quit' };

export interface StateRecoveryFlowDependencies<TStore> {
    readonly dialogs: StateRecoveryDialogs;
    /** Re-attempt the open. Failures come back as values, not throws, so a
     *  retry loop never has to distinguish a classified failure from a bug. */
    readonly open: () => Promise<StateOpenOutcome<TStore>>;
    /** Move the existing database (and its sidecars) aside, preserving them.
     *  Never a delete: see the module comment.
     *
     *  Required to be *resumable*: because the flow loops after a failure, a
     *  second call following a mid-move failure must continue that same move
     *  rather than start a new one — otherwise the retry the user is invited to
     *  make would leave two half-moved sets. */
    readonly preserve: () => Promise<void>;
    /** Where the user is sent by `open-diagnostics`. Resolved lazily so the
     *  directory is read at the moment it is opened. */
    readonly diagnostics_directory: () => string;
}

export interface StateRecoveryFlow<TStore> {
    run(failure: StateRecoveryFailure): Promise<StateRecoveryOutcome<TStore>>;
}

// The `TStore` generic is kept — unlike `category`, which is now the concrete
// SQLite union — because it earns its keep in the tests. The flow genuinely never
// inspects the store: it only receives one from `open` and hands the same value
// back, so the tests instantiate it with a one-field marker object and can then
// assert *which* open call's result came out. A signature pinned to
// `OpenedSqliteFileStateStore` would force every test in this file to construct a
// real SQLite connection to check control flow that has nothing to do with one.

/**
 * Map an error category onto the story we tell about it, before refinement.
 *
 * Total over `SqliteFileStateErrorCategory`, so adding a category to that union
 * is a compile error here rather than a silent demotion to `unknown`. Two
 * categories carry two meanings each and are refined afterwards from the
 * sanitized discriminators — see `refine_state_recovery_kind`. This table holds
 * the meaning that is safe to assume when no discriminator says otherwise.
 */
export const KIND_BY_CATEGORY: Readonly<
    Record<SqliteFileStateErrorCategory, StateRecoveryKind>
> = {
    // Busy/locked. `protocol` defaults here too, because the genuine
    // SQLITE_PROTOCOL contention throw carries no metadata beyond the stage —
    // "try again, possibly after closing the other window", never a reason to
    // touch the file. Its *other* meaning (a version fence) is refined below.
    contention: 'transient',
    protocol: 'transient',
    // The file is fine; the filesystem is not cooperating.
    readonly: 'environment',
    inaccessible: 'environment',
    full: 'capacity',
    io: 'io',
    corrupt: 'corrupt',
    // Schema/identity mismatch: "this database is not this build's", which is an
    // ownership statement, not a data problem.
    schema: 'compatibility',
    // A durability primitive this build requires is absent. Its own story: no
    // ownership claim is true here, and preservation cannot even run — the move
    // needs the same missing guarantee.
    unsupported: 'unsupported-platform',
    // Defaults to a genuinely interrupted preserve; an orphaned first-run setup
    // is refined out below.
    recovery: 'interrupted',
    // The remaining categories describe state we wrote and can no longer make
    // sense of. That is a real integrity problem, but not necessarily file
    // corruption, and we cannot prove which — so conservative wording.
    'foreign-key': 'unknown',
    'malformed-state': 'unknown',
    counter: 'unknown',
    commit: 'unknown',
    unknown: 'unknown',
};

/** The sanitized `operation` a preflight uses when the basename has setup
 *  leftovers but no finished database. Thrown by `assert_preflight_inventory`
 *  in src/sqlite-open-recovery.ts. */
const ABSENT_MAIN_EVIDENCE_OPERATION = 'absent-main-evidence';

/**
 * Every kind a refinement can produce that no category defaults to.
 *
 * Exported so the exhaustiveness test can assert that the base table's values
 * *plus* these cover the whole `StateRecoveryKind` union: a kind reachable by
 * neither route would be prose nothing can ever show, and a kind in the union
 * with no arm at all is already a compile error in `state_recovery_wording`.
 */
export const REFINED_ONLY_KINDS: readonly StateRecoveryKind[] = [
    'compatibility',
    'leftover-setup',
];

/**
 * Resolve the two categories whose single name covers two different stories.
 *
 * - `protocol` is thrown both for real SQLITE_PROTOCOL contention (another
 *   process's locking protocol) and for this build's own version/ownership
 *   fence: a stored reader/writer protocol bound, or a coordination generation,
 *   outside what this build negotiates. Only the fence throws carry `protocol`
 *   or `coordinationGeneration` metadata (see `sqlite_file_state_protocol_error`
 *   call sites in src/sqlite-file-state-validation.ts and src/sqlite-runtime.ts;
 *   `categorize_sqlite_file_state_error` never synthesizes either field). Told
 *   as `transient` the fence would blame a window that does not exist, retry
 *   forever, and — because `transient` allows preservation — invite the user to
 *   move a perfectly valid *newer* database aside. That is exactly what the
 *   `compatibility` prose exists to prevent, so the fence gets it.
 * - `recovery` is thrown both for a preserve that stopped partway and for a
 *   first run that was killed during initialization, leaving setup files with no
 *   database beside them (`absent-main-evidence`). The action is the same, but
 *   the second is not a resumed move — no move was ever attempted — so it gets
 *   its own story rather than a confident claim about one that never happened.
 */
export function refine_state_recovery_kind(
    failure: StateRecoveryFailure,
    base: StateRecoveryKind,
): StateRecoveryKind {
    if (failure.category === 'protocol'
        && (failure.protocol !== undefined || failure.coordinationGeneration !== undefined)) {
        return 'compatibility';
    }
    if (failure.category === 'recovery'
        && failure.operation === ABSENT_MAIN_EVIDENCE_OPERATION) {
        return 'leftover-setup';
    }
    return base;
}

/** Only kind decides this, so the offer cannot drift per category. */
function can_preserve(kind: StateRecoveryKind): boolean {
    // `environment` is excluded because with an unwritable or unreachable
    // location the move itself cannot succeed, and offering it would promise a
    // quarantine that never happened. `capacity` is excluded for the mirror
    // reason — a move needs room, and the honest message is that the change was
    // rolled back and nothing was lost. `unsupported-platform` is the strongest
    // case of the same rule: preservation runs through
    // `acquire_sqlite_exclusive_recovery_gate`, which asserts the very
    // durability primitive that is missing, so the move would fail identically
    // on every attempt — offering it produces a dialog loop whose only exit is
    // Quit. Retry stays offered for all three: a different location or mount can
    // answer differently, and the failure table treats an unsupported primitive
    // as an explicit refusal, never as corruption or as someone else's ownership.
    return kind !== 'environment' && kind !== 'capacity' && kind !== 'unsupported-platform';
}

/** Reduce a failure to exactly what a dialog may see. */
export function classify_state_recovery_failure(
    failure: StateRecoveryFailure,
): StateRecoveryDetail {
    // The `??` is not dead despite the total record above: the category crosses a
    // module boundary from a runtime classifier, so a build skew between the two
    // must land on the conservative story rather than on `undefined`.
    const base = KIND_BY_CATEGORY[failure.category] ?? 'unknown';
    const kind = refine_state_recovery_kind(failure, base);
    return { category: failure.category, kind, canPreserve: can_preserve(kind) };
}

/**
 * Drive the recovery conversation until the user either has a working store or
 * asks to quit.
 *
 * A loop rather than recursion: the user can retry and re-open the diagnostics
 * folder as many times as they like, and every iteration is driven by a fresh
 * modal, so an unbounded stack is the only thing a retry cap would actually be
 * protecting against. `quit` is offered in every single iteration, so the loop
 * always has a reachable exit.
 */
export function create_state_recovery_flow<TStore>(
    deps: StateRecoveryFlowDependencies<TStore>,
): StateRecoveryFlow<TStore> {
    const { dialogs, open, preserve, diagnostics_directory } = deps;

    return {
        async run(failure: StateRecoveryFailure): Promise<StateRecoveryOutcome<TStore>> {
            // Rebound on every failed attempt, so the dialog always describes the
            // failure the user is actually looking at rather than the first one.
            let current = failure;

            for (;;) {
                const detail = classify_state_recovery_failure(current);
                const choice = await dialogs.show_recovery(detail);

                if (choice === 'quit') return { type: 'quit' };

                if (choice === 'open-diagnostics') {
                    // Not a terminal choice: the user is going to look at the logs
                    // and come back, so re-present the same dialog unchanged.
                    // `open_folder` is the one callback that receives a path, and
                    // only because the OS needs it to reveal the folder — it is
                    // never rendered as text.
                    await dialogs.open_folder(diagnostics_directory());
                    continue;
                }

                if (choice === 'retry') {
                    const outcome = await open();
                    if (outcome.type === 'opened') return outcome;
                    current = outcome.failure;
                    continue;
                }

                // preserve-and-create. Destructive-looking and irreversible from
                // the user's point of view, so it needs the second attestation
                // that every other process holding this database is closed.
                const confirmed = await dialogs.confirm_preserve(detail);
                if (!confirmed) continue;

                try {
                    await preserve();
                } catch {
                    // Never fall through into `open()` here. A failed move can
                    // leave the original in place, and opening afterwards would
                    // either reopen the same broken database while the user
                    // believes it was replaced, or create a second authority
                    // beside a half-moved one.
                    //
                    // Looping rather than ending is what makes the half-moved
                    // case recoverable: `preserve` is required to *resume* an
                    // unfinished move rather than start a new one, so choosing
                    // "Set Aside" again from the re-presented dialog continues
                    // the same state machine. The error dialog must therefore not
                    // claim nothing was moved — see `show_error` in main.ts.
                    await dialogs.show_error();
                    continue;
                }

                const outcome = await open();
                if (outcome.type === 'opened') return outcome;
                current = outcome.failure;
            }
        },
    };
}
