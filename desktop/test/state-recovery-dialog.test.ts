import { describe, expect, it, vi } from 'vitest';
import type { SqliteFileStateErrorCategory } from '../../src/sqlite-file-state-errors';
import {
    KIND_BY_CATEGORY,
    REFINED_ONLY_KINDS,
    classify_state_recovery_failure,
    create_state_recovery_flow,
    state_recovery_button_layout,
    state_recovery_choice_at,
    state_recovery_wording,
    type StateRecoveryChoice,
    type StateRecoveryDetail,
    type StateRecoveryDialogs,
    type StateRecoveryFailure,
    type StateRecoveryKind,
    type StateOpenOutcome,
} from '../main/state-recovery-dialog';

/** Stands in for whatever store the integrator binds; the flow never inspects it. */
interface FakeStore {
    readonly id: string;
}

const DIAGNOSTICS_DIRECTORY = '/tmp/table-viewer-diagnostics';

/** Every story the module can tell. Spelled out rather than derived, so a kind
 *  added to the union has to be acknowledged here too. */
const KINDS: readonly StateRecoveryKind[] = [
    'transient', 'environment', 'capacity', 'io', 'corrupt', 'compatibility',
    'unsupported-platform', 'unsupported-location', 'interrupted', 'leftover-setup',
    'obstructed', 'coordination-residue', 'unknown',
];

/** The stage `desktop_state_platform_support` reports for a refusal that held at
 *  the intended location *and* at an unrelated control location. Spelled out
 *  rather than imported so this suite stays free of the backend, and pinned
 *  against the producing constant by its own test below. */
const PLATFORM_DURABILITY_OPERATION = 'platform-durability-unsupported';

/** The whole `SqliteFileStateErrorCategory` union, spelled out for the same
 *  reason: a category added upstream must be given a story deliberately, not by
 *  falling through to `unknown`. */
const ALL_CATEGORIES: readonly SqliteFileStateErrorCategory[] = [
    'contention', 'readonly', 'inaccessible', 'full', 'io', 'corrupt', 'schema',
    'protocol', 'foreign-key', 'malformed-state', 'counter', 'recovery', 'commit',
    'unsupported', 'unknown',
];

function dialogs(
    choices: StateRecoveryChoice[],
    overrides: Partial<StateRecoveryDialogs> = {},
) {
    const seen: StateRecoveryDetail[] = [];
    const remaining = [...choices];
    const base: StateRecoveryDialogs = {
        show_recovery: vi.fn(async (detail: StateRecoveryDetail) => {
            seen.push(detail);
            const next = remaining.shift();
            // A missing scripted answer means the flow looped further than the
            // test expected; failing loudly beats hanging the suite.
            if (!next) throw new Error('unexpected recovery dialog');
            return next;
        }),
        confirm_preserve: vi.fn(async () => true),
        open_folder: vi.fn(async () => {}),
        show_error: vi.fn(async () => {}),
        ...overrides,
    };
    return { ...base, seen };
}

function failed(category: SqliteFileStateErrorCategory): StateOpenOutcome<FakeStore> {
    return { type: 'failed', failure: { category } };
}

function opened(id: string): StateOpenOutcome<FakeStore> {
    return { type: 'opened', opened: { id } };
}

function flow(
    scripted: StateRecoveryDialogs,
    open: () => Promise<StateOpenOutcome<FakeStore>>,
    preserve: () => Promise<void> = async () => {},
) {
    return create_state_recovery_flow<FakeStore>({
        dialogs: scripted,
        open,
        preserve,
        diagnostics_directory: () => DIAGNOSTICS_DIRECTORY,
    });
}

/** The prose with explicit denials of damage removed, so what remains is only
 *  what the text *asserts*. "They are not damaged" must not read as a corruption
 *  claim — it is the opposite of one, and the `compatibility`, `obstructed`, and
 *  `coordination-residue` arms say exactly that on purpose. */
function damage_claims(kind: StateRecoveryKind): string {
    const { message, detail } = state_recovery_wording(kind);
    return `${message} ${detail}`
        .replace(/\b(?:are|is|was|were)\s+not\s+(?:corrupt(?:ed)?|damaged)\b/gi, '');
}

describe('state recovery classification', () => {
    it('never relabels an I/O failure as corruption', () => {
        const io = classify_state_recovery_failure({ category: 'io' });
        const corrupt = classify_state_recovery_failure({ category: 'corrupt' });

        expect(io.kind).toBe('io');
        expect(corrupt.kind).toBe('corrupt');
        expect(io.kind).not.toBe(corrupt.kind);
    });

    it('treats a schema or identity mismatch as compatibility, not corruption', () => {
        expect(classify_state_recovery_failure({ category: 'schema' }).kind).toBe('compatibility');
        expect(classify_state_recovery_failure({ category: 'schema' }).kind)
            .not.toBe(classify_state_recovery_failure({ category: 'corrupt' }).kind);
    });

    it('gives a missing durability primitive its own story, with no preserve offered', () => {
        // Not `compatibility`: nobody else owns this database, and an ownership
        // claim would be a false statement. Not preservable either, and not merely
        // unhelpfully so — `preserve` runs through
        // `acquire_sqlite_exclusive_recovery_gate`, which asserts the very
        // primitive that is missing, so the move throws `unsupported` identically
        // on every attempt. Offering it produced a dialog loop whose only exit was
        // Quit: retry failed the same way, and preserve failed into `show_error`
        // and looped.
        for (const failure of [
            { category: 'unsupported' as const, operation: 'directory-durability' },
            { category: 'unsupported' as const, operation: PLATFORM_DURABILITY_OPERATION },
        ]) {
            const detail = classify_state_recovery_failure(failure);
            expect(detail.canPreserve, failure.operation).toBe(false);
            expect(detail.kind, failure.operation).not.toBe(
                classify_state_recovery_failure({ category: 'schema' }).kind,
            );
            // Retry stays offered — a different location or mount can answer
            // differently — alongside Diagnostics and Quit, and nothing else.
            expect(state_recovery_button_layout(detail.canPreserve).choices)
                .toEqual(['retry', 'open-diagnostics', 'quit']);
        }
    });

    it('separates a declined platform from a location that cannot be flushed', () => {
        // One missing guarantee, two opposite remedies. The location story tells
        // the user to keep the settings on an ordinary local disk, which is right
        // for a network mount and useless on Windows; the platform story tells
        // them to wait for a later build, which is right on Windows and strands
        // someone whose network drive was the whole problem. Getting these
        // backwards is a wrong answer delivered confidently, so the split is
        // pinned here rather than left to prose review.
        const platform = classify_state_recovery_failure({
            category: 'unsupported',
            operation: PLATFORM_DURABILITY_OPERATION,
        });
        const location = classify_state_recovery_failure({
            category: 'unsupported',
            operation: 'directory-durability',
        });

        expect(platform).toMatchObject({ kind: 'unsupported-platform', canPreserve: false });
        expect(location).toMatchObject({ kind: 'unsupported-location', canPreserve: false });
        expect(state_recovery_wording('unsupported-platform'))
            .not.toEqual(state_recovery_wording('unsupported-location'));

        // The platform story must not send the user looking for a location that
        // works, because there is not one on this system.
        const platform_prose = Object.values(state_recovery_wording('unsupported-platform')).join(' ');
        expect(platform_prose).not.toMatch(/local disk|network|another (location|place|drive)/i);
        // And the location story must not tell someone with a fixable problem to
        // wait for a future release.
        const location_prose = Object.values(state_recovery_wording('unsupported-location')).join(' ');
        expect(location_prose).not.toMatch(/still being completed|not yet supported/i);
        expect(location_prose).toMatch(/local disk/i);
    });

    it('pins the platform-declaration stage against the constant that produces it', async () => {
        // The one place the two modules agree on a literal. `state-recovery-dialog`
        // is deliberately free of backend imports, so the string is duplicated —
        // and a duplicated literal that can drift silently is exactly what this
        // assertion exists to prevent: a rename on the producing side would
        // otherwise leave every Windows launch telling the location story, whose
        // advice cannot help there.
        const { DESKTOP_STATE_PLATFORM_DECLARATION_OPERATION } = await import(
            '../main/desktop-state-database'
        );
        expect(DESKTOP_STATE_PLATFORM_DECLARATION_OPERATION)
            .toBe(PLATFORM_DURABILITY_OPERATION);
        expect(classify_state_recovery_failure({
            category: 'unsupported',
            operation: DESKTOP_STATE_PLATFORM_DECLARATION_OPERATION,
        }).kind).toBe('unsupported-platform');
    });

    it('routes real lock contention to the retry-oriented kind', () => {
        expect(classify_state_recovery_failure({ category: 'contention' }).kind).toBe('transient');
        // A genuine SQLITE_PROTOCOL: the locking protocol another process is
        // using. `categorize_sqlite_file_state_error` never synthesizes a
        // `protocol` or `coordinationGeneration` value, so there is none here.
        expect(classify_state_recovery_failure({
            category: 'protocol',
            operation: 'desktop-state-open',
        })).toMatchObject({ kind: 'transient', canPreserve: true });
    });

    it('tells the protocol version fence as ownership, not as another window', () => {
        // The concrete case: the user runs a newer build (which raised the stored
        // reader/writer bounds), then relaunches the older one. Told as
        // `transient` this blamed a window that does not exist, retried forever,
        // and — because `transient` allows preservation — invited the user to move
        // a perfectly valid NEWER database aside, which is exactly what the
        // `compatibility` prose exists to prevent.
        for (const fence of [
            { category: 'protocol' as const, protocol: 3 },
            { category: 'protocol' as const, coordinationGeneration: 2 },
            { category: 'protocol' as const, protocol: 3, coordinationGeneration: 2 },
        ]) {
            expect(classify_state_recovery_failure(fence).kind, JSON.stringify(fence))
                .toBe('compatibility');
        }
        // The two meanings of the one category really do part company.
        expect(classify_state_recovery_failure({ category: 'protocol', protocol: 3 }).kind)
            .not.toBe(classify_state_recovery_failure({ category: 'protocol' }).kind);
    });

    it('distinguishes an orphaned first-run setup from an interrupted move', () => {
        // A force-quit during first-run initialization leaves setup files with no
        // main database beside them. The action is the same fresh preserve, but no
        // move was ever attempted, so the `interrupted` prose — "continuing
        // resumes that unfinished move" — would describe a state machine that
        // never started.
        const leftover = classify_state_recovery_failure({
            category: 'recovery',
            operation: 'absent-main-evidence',
        });
        const interrupted = classify_state_recovery_failure({
            category: 'recovery',
            operation: 'desktop-state-preflight',
        });

        expect(leftover).toMatchObject({ kind: 'leftover-setup', canPreserve: true });
        expect(interrupted).toMatchObject({ kind: 'interrupted', canPreserve: true });
        expect(state_recovery_wording('leftover-setup'))
            .not.toEqual(state_recovery_wording('interrupted'));
        // No claim that a move is being resumed when none was started.
        const prose = Object.values(state_recovery_wording('leftover-setup')).join(' ');
        expect(prose).not.toMatch(/resum/i);
        expect(prose).not.toMatch(/unfinished move|previous attempt/i);
    });

    it('tells a headerless file as damage, not as another product’s property', () => {
        // `read_sqlite_raw_header` throws `schema` for bad magic or a file too
        // short to hold a header, and `schema` defaults to `compatibility` —
        // whose prose says the settings use an unrecognized format, that "they are
        // not damaged", and that another version may need to find them. For a
        // garbage file every clause is false and the last discourages the only
        // action that recovers. This is the mirror of the
        // `io`-must-not-say-corruption rule.
        const headerless = classify_state_recovery_failure({
            category: 'schema',
            operation: 'raw-header',
        });
        // The identity fence is deliberately NOT refined: a well-formed SQLite
        // file carrying another application id is exactly what `compatibility`
        // describes.
        const foreign_identity = classify_state_recovery_failure({
            category: 'schema',
            operation: 'raw-application-id',
        });

        expect(headerless).toMatchObject({ kind: 'corrupt', canPreserve: true });
        expect(foreign_identity.kind).toBe('compatibility');
        expect(headerless.kind).not.toBe(foreign_identity.kind);
    });

    it('tells an obstructed member name as an obstruction, not a resumed move', () => {
        // A folder or link on one of the settings set's own names. `member_for`
        // rejects it with `inventory-member-type`; no move was ever attempted, so
        // the `interrupted` claim that continuing resumes one is precisely the
        // false statement `leftover-setup` was introduced to eliminate.
        const detail = classify_state_recovery_failure({
            category: 'recovery',
            operation: 'inventory-member-type',
        });

        // Not preservable, and provably so rather than as a judgement: the
        // preserve action inventories the same obstructed name and throws the same
        // error before moving anything, so the offer would be a loop out of which
        // only Quit leads.
        expect(detail).toMatchObject({ kind: 'obstructed', canPreserve: false });
        expect(state_recovery_button_layout(detail.canPreserve).choices)
            .toEqual(['retry', 'open-diagnostics', 'quit']);
        const prose = Object.values(state_recovery_wording('obstructed')).join(' ');
        expect(prose).not.toMatch(/resum/i);
        expect(prose).not.toMatch(/unfinished move|previous attempt|did not finish/i);
        // Explicit denials of damage stripped first, exactly as in
        // `damage_claims` below, so what is checked is what the text *asserts*.
        expect(damage_claims('obstructed')).not.toMatch(/corrupt|damaged/i);
    });

    it('tells unrecognized coordination residue as its own refusal to guess', () => {
        // An entry in the private gate directory whose name was never one of our
        // reader tokens. Not damage to the settings, and not an interrupted move —
        // it is a refusal to guess whether a live window still holds them, and the
        // preserve action can now set it aside.
        const detail = classify_state_recovery_failure({
            category: 'recovery',
            operation: 'reader-token-inventory',
        });

        expect(detail).toMatchObject({ kind: 'coordination-residue', canPreserve: true });
        const prose = Object.values(state_recovery_wording('coordination-residue')).join(' ');
        expect(prose).not.toMatch(/resum/i);
        expect(prose).not.toMatch(/unfinished move|previous attempt|did not finish/i);
        expect(damage_claims('coordination-residue')).not.toMatch(/corrupt|damaged/i);
        // It does promise what the quarantine actually guarantees: a set-aside,
        // never a delete.
        expect(prose).toMatch(/never deleting/i);
    });

    it('keeps the generic recovery default for a stage it cannot distinguish', () => {
        // The refinements are additive: a `recovery` failure whose stage is not one
        // of the distinguished ones still gets the interrupted-move story, which is
        // the right default for the preflight's own blockade/intent report.
        expect(classify_state_recovery_failure({
            category: 'recovery',
            operation: 'desktop-state-preflight',
        })).toMatchObject({ kind: 'interrupted', canPreserve: true });
    });

    it('never offers to move state aside for an environment or capacity failure', () => {
        expect(classify_state_recovery_failure({ category: 'readonly' }))
            .toMatchObject({ kind: 'environment', canPreserve: false });
        expect(classify_state_recovery_failure({ category: 'inaccessible' }))
            .toMatchObject({ kind: 'environment', canPreserve: false });
        expect(classify_state_recovery_failure({ category: 'full' }))
            .toMatchObject({ kind: 'capacity', canPreserve: false });
    });

    it('resumes an interrupted preserve rather than starting a new story', () => {
        expect(classify_state_recovery_failure({ category: 'recovery' }))
            .toMatchObject({ kind: 'interrupted', canPreserve: true });
    });

    it('maps every error category to a kind, and every kind is reachable', () => {
        // Exhaustive in both directions. Left to right: a category the union gains
        // must not silently classify as `unknown` — the base table is a total
        // `Record`, so this is the runtime half of that compile-time guarantee.
        // Right to left: a kind that neither the table nor a refinement can produce
        // is prose nothing can ever show.
        for (const category of ALL_CATEGORIES) {
            const detail = classify_state_recovery_failure({ category });
            expect(KINDS, category).toContain(detail.kind);
            expect(Object.keys(KIND_BY_CATEGORY), category).toContain(category);
        }
        expect(new Set([...Object.values(KIND_BY_CATEGORY), ...REFINED_ONLY_KINDS]))
            .toEqual(new Set(KINDS));
    });

    it('falls back to the conservative kind for a category from a skewed build', () => {
        // Not reachable through the type system — that is the point of narrowing
        // `category` to the union — but the value crosses a module boundary at
        // runtime, so a skew between the classifier and this table must land on the
        // conservative story rather than on `undefined`.
        expect(classify_state_recovery_failure({
            category: 'not-a-real-category' as SqliteFileStateErrorCategory,
        })).toMatchObject({ kind: 'unknown', canPreserve: true });
    });

    it('classifies every documented failure into pairwise distinct details', () => {
        // One failure per kind, including the two that only a refinement can
        // reach, so every distinct story is represented exactly once.
        const representatives: StateRecoveryFailure[] = [
            { category: 'contention' },
            { category: 'readonly' },
            { category: 'full' },
            { category: 'io' },
            { category: 'corrupt' },
            { category: 'schema' },
            { category: 'unsupported', operation: 'directory-durability' },
            { category: 'unsupported', operation: PLATFORM_DURABILITY_OPERATION },
            { category: 'recovery' },
            { category: 'recovery', operation: 'absent-main-evidence' },
            { category: 'recovery', operation: 'inventory-member-type' },
            { category: 'recovery', operation: 'reader-token-inventory' },
            { category: 'unknown' },
        ];
        const kinds = representatives.map(
            (failure) => classify_state_recovery_failure(failure).kind,
        );

        expect(new Set(kinds).size).toBe(representatives.length);
        expect(new Set(kinds)).toEqual(new Set(KINDS));
        for (let outer = 0; outer < representatives.length; outer += 1) {
            for (let inner = outer + 1; inner < representatives.length; inner += 1) {
                const first = state_recovery_wording(kinds[outer]);
                const second = state_recovery_wording(kinds[inner]);
                // Pairwise distinct *prose*, not just distinct kind names: a
                // borrowed arm would be a wrong story told confidently.
                expect(first, `${kinds[outer]} vs ${kinds[inner]}`).not.toEqual(second);
            }
        }
    });

    it('exposes exactly the three fields a dialog may see', () => {
        // The failing `operation` stops one boundary earlier — it is not on
        // `StateRecoveryFailure` at all — so there is nothing here for a dialog to
        // accidentally render. main.ts logs it instead.
        const detail = classify_state_recovery_failure({ category: 'corrupt' });

        expect(Object.keys(detail).sort()).toEqual(['canPreserve', 'category', 'kind']);
    });
});

describe('state recovery wording', () => {
    it('covers every kind the classifier or a refinement can produce', () => {
        // So a kind added to the union without an arm here is caught even before
        // the switch's own exhaustiveness would be noticed in review.
        expect(new Set(KINDS))
            .toEqual(new Set([...Object.values(KIND_BY_CATEGORY), ...REFINED_ONLY_KINDS]));
    });

    // The whole reason this prose is exported from an electron-free module. Both
    // arms are a wording *requirement*, not a preference: an I/O error is a
    // statement about the storage device, and a schema or identity mismatch is a
    // statement about ownership. Calling either one corruption would push the user
    // toward discarding data that is very likely intact.
    it('never calls an I/O failure or a compatibility mismatch corruption', () => {
        for (const kind of ['io', 'compatibility'] as const) {
            expect(damage_claims(kind), kind).not.toMatch(/corrupt|damaged/i);
        }
        // The control: `corrupt` is the one kind where the word is honest, so the
        // assertions above are about the wording and not about a vocabulary the
        // module simply never uses — and the denial-stripping above does not
        // silently defuse them.
        expect(damage_claims('corrupt')).toMatch(/damaged/i);
    });

    it('describes compatibility without speculating about another product', () => {
        const prose = Object.values(state_recovery_wording('compatibility')).join(' ');

        expect(prose).not.toMatch(/\bproducts?\b/i);
        expect(prose).toMatch(/format this version of Table Viewer does not recognize/i);
        expect(prose).toMatch(/Updating Table Viewer may restore access/i);
    });

    it('makes no ownership or damage claim for either unsupported kind', () => {
        // Three separate wrongs in the old `compatibility` mapping, and all three
        // are wording: the data does not belong to another product, it does not
        // belong to a newer version, and setting it aside would not leave anyone
        // else without it. Nothing is damaged either. Both unsupported arms are
        // held to it — the location arm is newer and is where a borrowed clause
        // would land.
        for (const kind of ['unsupported-platform', 'unsupported-location'] as const) {
            const prose = damage_claims(kind);

            expect(prose, kind).not.toMatch(/corrupt|damaged/i);
            expect(prose, kind).not.toMatch(/belong/i);
            expect(prose, kind).not.toMatch(/different Table Viewer product|another product/i);
            expect(prose, kind).not.toMatch(/newer version|older version/i);
            expect(prose, kind).not.toMatch(/set(ting)? (these|them|it) aside/i);
            // And each says the honest thing instead: the guarantee is unavailable
            // and nothing was touched while discovering that.
            expect(prose, kind).toMatch(/guarantee/i);
            expect(prose, kind).toMatch(/nothing has been changed or moved/i);
        }
        // The platform arm additionally states that this system's support is
        // unfinished, which is the one honest thing it can offer in place of an
        // action.
        expect(damage_claims('unsupported-platform')).toMatch(/cannot store/i);
        expect(damage_claims('unsupported-platform')).toMatch(/still being completed/i);
    });

    it('gives every kind its own non-empty story', () => {
        const stories = new Set<string>();
        for (const kind of KINDS) {
            const { message, detail } = state_recovery_wording(kind);
            expect(message.trim(), kind).not.toBe('');
            expect(detail.trim(), kind).not.toBe('');
            // A borrowed arm would be a wrong story told confidently, which is the
            // failure mode the per-kind switch exists to prevent.
            stories.add(`${message} ${detail}`);
        }
        expect(stories.size).toBe(KINDS.length);
    });

    it('puts no path, filename, SQL keyword, or storage-engine name in a modal', () => {
        for (const kind of KINDS) {
            const { message, detail } = state_recovery_wording(kind);
            const prose = `${message} ${detail}`;
            // A modal is shown at the moment the app trusts its own state least;
            // echoing any of this back is how a diagnostic becomes a leak.
            expect(prose, kind).not.toMatch(/[/\\]/);
            expect(prose, kind).not.toMatch(/\.(csv|tsv|xlsx?|sqlite3?|db|json|journal|wal|shm)\b/i);
            expect(prose, kind).not.toMatch(/sqlite/i);
            for (const keyword of [
                'SELECT', 'INSERT', 'UPDATE', 'DELETE FROM', 'CREATE', 'PRAGMA', 'ROLLBACK',
            ]) {
                expect(prose, `${kind} / ${keyword}`).not.toContain(keyword);
            }
        }
    });
});

describe('state recovery button layout', () => {
    it('omits the preserve option exactly when preservation is incoherent', () => {
        // Not offering the button *is* the enforcement of `canPreserve`: the flow
        // deliberately does not re-check it, so a layout that offered the button
        // anyway would let a user move state aside for a read-only directory,
        // failing the same way while believing it had been quarantined.
        expect(state_recovery_button_layout(false).choices)
            .toEqual(['retry', 'open-diagnostics', 'quit']);
        expect(state_recovery_button_layout(false).buttons)
            .not.toContain('Set Aside and Start Fresh…');
        expect(state_recovery_button_layout(true).choices)
            .toEqual(['retry', 'open-diagnostics', 'preserve-and-create', 'quit']);
        expect(state_recovery_button_layout(true).buttons)
            .toContain('Set Aside and Start Fresh…');
    });

    it('maps every index to its own button, in both shapes', () => {
        for (const can_preserve of [false, true]) {
            const layout = state_recovery_button_layout(can_preserve);
            expect(layout.buttons, String(can_preserve))
                .toHaveLength(layout.choices.length);
            for (const [index, choice] of layout.choices.entries()) {
                expect(state_recovery_choice_at(layout, index), `${can_preserve} @${index}`)
                    .toBe(choice);
            }
            // No label reused, so no two indices can mean the same thing to a user.
            expect(new Set(layout.buttons).size).toBe(layout.buttons.length);
            expect(new Set(layout.choices).size).toBe(layout.choices.length);
        }
    });

    it('defaults to retry and makes dismissal quit, never a preserve', () => {
        for (const can_preserve of [false, true]) {
            const layout = state_recovery_button_layout(can_preserve);
            expect(state_recovery_choice_at(layout, layout.defaultId), String(can_preserve))
                .toBe('retry');
            // Escape, a closed window, or any index we never offered: the only
            // answer that cannot touch the user's data without them asking.
            expect(state_recovery_choice_at(layout, layout.cancelId), String(can_preserve))
                .toBe('quit');
            for (const response of [-1, layout.choices.length, 99]) {
                expect(state_recovery_choice_at(layout, response), `${can_preserve} @${response}`)
                    .toBe('quit');
            }
        }
    });

    it('offers preservation for exactly the kinds the classifier says it fits', () => {
        // The two halves wired together: whatever `canPreserve` decides is what
        // the button row reflects, for every category the desktop can produce.
        for (const category of Object.keys(KIND_BY_CATEGORY) as SqliteFileStateErrorCategory[]) {
            const detail = classify_state_recovery_failure({ category });
            const layout = state_recovery_button_layout(detail.canPreserve);
            expect(layout.choices.includes('preserve-and-create'), category)
                .toBe(detail.canPreserve);
            expect(layout.choices.includes('quit'), category).toBe(true);
        }
    });
});

describe('state recovery flow', () => {
    it('returns the store when a retry succeeds', async () => {
        const scripted = dialogs(['retry']);
        const open = vi.fn()
            .mockResolvedValueOnce(opened('retried'));

        const outcome = await flow(scripted, open).run({ category: 'contention' });

        expect(outcome).toEqual({ type: 'opened', opened: { id: 'retried' } });
        expect(open).toHaveBeenCalledOnce();
    });

    it('re-presents a failed retry with the new failure, not the original', async () => {
        const scripted = dialogs(['retry', 'quit']);
        const open = vi.fn().mockResolvedValueOnce(failed('corrupt'));

        const outcome = await flow(scripted, open).run({ category: 'contention' });

        expect(outcome).toEqual({ type: 'quit' });
        expect(scripted.seen.map((detail) => detail.category)).toEqual(['contention', 'corrupt']);
        expect(scripted.seen.map((detail) => detail.kind)).toEqual(['transient', 'corrupt']);
    });

    it('re-presents the same dialog after opening the diagnostics folder', async () => {
        const scripted = dialogs(['open-diagnostics', 'quit']);
        const open = vi.fn();

        const outcome = await flow(scripted, open).run({ category: 'io' });

        expect(outcome).toEqual({ type: 'quit' });
        expect(scripted.open_folder).toHaveBeenCalledWith(DIAGNOSTICS_DIRECTORY);
        expect(scripted.show_recovery).toHaveBeenCalledTimes(2);
        expect(open).not.toHaveBeenCalled();
    });

    it('never preserves anything when the user quits', async () => {
        const scripted = dialogs(['quit']);
        const preserve = vi.fn(async () => {});

        const outcome = await flow(scripted, vi.fn(), preserve).run({ category: 'corrupt' });

        expect(outcome).toEqual({ type: 'quit' });
        expect(preserve).not.toHaveBeenCalled();
        expect(scripted.confirm_preserve).not.toHaveBeenCalled();
    });

    it('never preserves anything when the confirmation is declined', async () => {
        const scripted = dialogs(['preserve-and-create', 'quit'], {
            confirm_preserve: vi.fn(async () => false),
        });
        const preserve = vi.fn(async () => {});
        const open = vi.fn();

        const outcome = await flow(scripted, open, preserve).run({ category: 'corrupt' });

        expect(outcome).toEqual({ type: 'quit' });
        expect(scripted.confirm_preserve).toHaveBeenCalledOnce();
        expect(preserve).not.toHaveBeenCalled();
        expect(open).not.toHaveBeenCalled();
        expect(scripted.show_recovery).toHaveBeenCalledTimes(2);
    });

    it('preserves once and opens once on a confirmed preserve-and-create', async () => {
        const calls: string[] = [];
        const scripted = dialogs(['preserve-and-create'], {
            confirm_preserve: vi.fn(async () => {
                calls.push('confirm');
                return true;
            }),
        });
        const preserve = vi.fn(async () => { calls.push('preserve'); });
        const open = vi.fn(async () => {
            calls.push('open');
            return opened('fresh');
        });

        const outcome = await flow(scripted, open, preserve).run({ category: 'corrupt' });

        expect(outcome).toEqual({ type: 'opened', opened: { id: 'fresh' } });
        expect(calls).toEqual(['confirm', 'preserve', 'open']);
        expect(preserve).toHaveBeenCalledOnce();
        expect(open).toHaveBeenCalledOnce();
    });

    it('re-presents with the new failure when the fresh open also fails', async () => {
        const scripted = dialogs(['preserve-and-create', 'quit']);
        const open = vi.fn().mockResolvedValueOnce(failed('readonly'));
        const preserve = vi.fn(async () => {});

        const outcome = await flow(scripted, open, preserve).run({ category: 'corrupt' });

        expect(outcome).toEqual({ type: 'quit' });
        expect(preserve).toHaveBeenCalledOnce();
        expect(open).toHaveBeenCalledOnce();
        expect(scripted.seen.map((detail) => detail.kind)).toEqual(['corrupt', 'environment']);
    });

    it('surfaces an error and re-presents rather than opening after a failed preserve', async () => {
        const scripted = dialogs(['preserve-and-create', 'quit']);
        const preserve = vi.fn(async () => { throw new Error('move failed'); });
        const open = vi.fn();

        const outcome = await flow(scripted, open, preserve).run({ category: 'corrupt' });

        expect(outcome).toEqual({ type: 'quit' });
        expect(scripted.show_error).toHaveBeenCalledOnce();
        expect(open).not.toHaveBeenCalled();
        expect(scripted.show_recovery).toHaveBeenCalledTimes(2);
    });

    it('lets a second attempt resume a preserve that failed partway', async () => {
        // The half-moved case. The flow loops after `show_error` precisely so the
        // user can choose "Set Aside" again, and `preserve` is contracted to
        // resume rather than start a second move — so the same `preserve` port is
        // called twice and the second call is what completes it.
        const scripted = dialogs(['preserve-and-create', 'preserve-and-create']);
        let attempts = 0;
        const preserve = vi.fn(async () => {
            attempts += 1;
            if (attempts === 1) throw new Error('ran out of space partway');
        });
        const open = vi.fn(async () => opened('fresh'));

        const outcome = await flow(scripted, open, preserve).run({ category: 'corrupt' });

        expect(outcome).toEqual({ type: 'opened', opened: { id: 'fresh' } });
        expect(preserve).toHaveBeenCalledTimes(2);
        expect(scripted.show_error).toHaveBeenCalledOnce();
        // Never opened between the two attempts: opening beside a half-moved set
        // would create a second authority.
        expect(open).toHaveBeenCalledOnce();
        expect(scripted.confirm_preserve).toHaveBeenCalledTimes(2);
    });

    it('never offers the preserve that cannot run for an unsupported platform', async () => {
        // The loop this closes: `preserve` also goes through
        // `acquire_sqlite_exclusive_recovery_gate`, which asserts the same missing
        // durability primitive, so every "Set Aside" failed into `show_error` and
        // re-presented, retry failed identically, and Quit was the only exit. The
        // button is simply not there now, so the flow cannot be asked for it.
        for (const [operation, kind] of [
            ['directory-durability', 'unsupported-location'],
            [PLATFORM_DURABILITY_OPERATION, 'unsupported-platform'],
        ] as const) {
            const failure: StateRecoveryFailure = { category: 'unsupported', operation };
            const scripted = dialogs(['retry', 'quit']);
            const preserve = vi.fn(async () => { throw new Error('unsupported'); });
            const open = vi.fn().mockResolvedValueOnce({ type: 'failed', failure });

            const outcome = await flow(scripted, open, preserve).run(failure);

            expect(outcome, operation).toEqual({ type: 'quit' });
            // Retry is still offered and still allowed to fail — a different mount
            // can answer differently — but the preserve was never on the menu.
            expect(open, operation).toHaveBeenCalledOnce();
            expect(preserve, operation).not.toHaveBeenCalled();
            expect(scripted.confirm_preserve, operation).not.toHaveBeenCalled();
            expect(scripted.show_error, operation).not.toHaveBeenCalled();
            for (const detail of scripted.seen) {
                expect(detail, operation).toMatchObject({ kind, canPreserve: false });
                expect(state_recovery_button_layout(detail.canPreserve).choices, operation)
                    .not.toContain('preserve-and-create');
            }
        }
    });

    it('keeps quit reachable after several non-terminal iterations', async () => {
        const scripted = dialogs([
            'retry', 'open-diagnostics', 'retry', 'open-diagnostics', 'quit',
        ]);
        const open = vi.fn()
            .mockResolvedValueOnce(failed('contention'))
            .mockResolvedValueOnce(failed('io'));

        const outcome = await flow(scripted, open).run({ category: 'contention' });

        expect(outcome).toEqual({ type: 'quit' });
        expect(scripted.show_recovery).toHaveBeenCalledTimes(5);
        expect(scripted.open_folder).toHaveBeenCalledTimes(2);
    });

    it('passes no path, filename, SQL text, or payload to any dialog callback', async () => {
        const scripted = dialogs(['preserve-and-create', 'retry', 'quit']);
        const open = vi.fn().mockResolvedValueOnce(failed('io'));
        // Rejecting, so show_error is on the path too — and `show_error` takes no
        // argument at all, which is the strongest form of this guarantee: there is
        // nothing for it to render even if someone wanted to.
        const preserve = vi.fn(async () => { throw new Error('/Users/someone/state.sqlite'); });

        await flow(scripted, open, preserve).run({ category: 'corrupt' });

        const arguments_seen = [
            ...(scripted.show_recovery as ReturnType<typeof vi.fn>).mock.calls,
            ...(scripted.confirm_preserve as ReturnType<typeof vi.fn>).mock.calls,
            ...(scripted.show_error as ReturnType<typeof vi.fn>).mock.calls,
        ].flat();
        expect(scripted.show_error).toHaveBeenCalledOnce();
        expect((scripted.show_error as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([]);
        expect(arguments_seen.length).toBeGreaterThan(0);

        for (const argument of arguments_seen) {
            const serialized = JSON.stringify(argument);
            expect(serialized).not.toMatch(/[/\\]/);
            expect(serialized).not.toMatch(/\.csv|\.sqlite|\.db/i);
            expect(serialized).not.toMatch(/SELECT|INSERT|UPDATE|DELETE/i);
            expect(argument).not.toHaveProperty('operation');
        }
        // open_folder is the one exception: the OS needs the directory to reveal
        // it, and it is never rendered as prose.
        expect(scripted.open_folder).not.toHaveBeenCalled();
    });
});
