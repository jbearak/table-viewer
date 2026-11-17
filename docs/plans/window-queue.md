# One queue per window, and a view that converges

The plan for [ADR 0007](../adr/0007-one-queue-per-window-and-a-converging-view.md). Base: `main` at 6d7d884d. Background: [research note](../research/undo-redo-in-other-editors.md).

## Status

The user decided to build option D. After nine review rounds that did not converge, the user cut the scope on 2026-11-16:

- This plan details the invariants, V1, and V2. Every later stage is a paragraph and an exit test here, and gets its own plan, reviewed by both reviewers, just before it is built.
- Choices on other sheets (V3b) and choices made during other work (V4) are deferred, not dropped. Until they are built, today's refusals stay, so nothing regresses.
- X2 is dropped: edits stay refused during this window's own view request.
- On the full plan's estimates the code grows by about 390 lines. The queue stages move the eight press facts into predicates of one slot over the same refs. What they delete is the slots, the drain, tickets, the header timers, `release_seq`, and the press model.

Build order: V1, V2, then Q1, V3a, V3b, V4, Q2 to Q5, and X1, each planned on its own.

**How this plan is held.** The plan fixes the behaviour, the order of work, what each stage deletes, and the constraints each mechanism must meet. Where a mechanism already exists in the code, the plan names it. Where a stage needs a new one, the plan states the constraints and the files it touches. The stage's PR then settles the mechanism, with tests, under the same two-reviewer loop.

## Why

In a document window each async operation runs on its own path, and Undo and Redo have to be coordinated with every one of them:

- `history_press_gate` (`src/webview/history-press-model.ts:89`) asks eight facts. `read_press_facts` reads them from 21 refs (`src/webview/app.tsx:8304-8335`).
- Two slots, `held_press_ref` and `retry_press_ref` (`app.tsx:1796`), hold presses.
- A drain runs after every render (`drain_history_press`, `app.tsx:8905`, its effect at `9039`).
- One timer enforces the 5 s bound.
- There are 15 calls of `wake_history_press`, plus the prop `on_held_typing_end`.
- Each gesture takes a ticket from the press counter, and GridShell carries tickets through session grants, pastes, and row admissions (`grid-shell.tsx:3671-3720`). `press_admits_ticket` lets through work made before the waiting press.

The undo and redo work in #385 to #394 found its bugs where these paths meet:

- #392: a press while busy, and a restore against a session request;
- #393: a write landing just before a refresh;
- #394: the fence after "Reopen the file";
- #391: a held border while an Undo moved columns, and the header write at shutdown.

Those races are fixed, and the host's checks that fixed them stay. The view stages are justified by N1 to N4. The queue stages are justified by deletion, not by a race they remove: the slots, the drain, tickets, epochs, the header timers, `release_seq`, and the press model, which every new async path has to be coordinated with today. The refs that hold each operation's state stay, and so do the sites that clear them. If a queue stage cannot delete what it lists, the plan stops there (see "Tripwire for the Q stages").

## Requirements

Kept from today, decided with the user:

- **K1.** The desktop Edit menu's Undo and Redo are always enabled. When there is a step, the label names it.
- **K2.** A press that cannot run within 5 s says why.
- **K3.** Pressing the opposite direction while a press waits cancels both. Cancel drops a waiting press silently.
- **K4.** A new view action clears Redo.
- **K5.** After "Reopen the file", edits, Save, and Discard are refused with "This view no longer matches the file. Reopen the file to keep editing." Today Save says "This view no longer matches the file. Reopen the file, then save." (`history-command-model.ts:143`, shipped in #394). This plan changes no message, so Save keeps its wording unless the user asks otherwise.
- **K6.** A column fit needs a real double-click on that column's border.

New, from the user:

- **N1.** Sort, filter, and hide are latest-wins. A new choice replaces or cancels the one in flight, and never waits behind it.
- **N2.** Every long operation can be cancelled. Undoing a step that is still in flight cancels it, instead of queueing after it.
- **N3.** Only operations that must be atomic, such as Save's write, may make other work wait.
- **N4.** The person is never stuck unable to choose more filters or sorts while a long operation runs.

Decided by the user or by default:

- Edits stay refused while this window's own view request is in flight.
- Undoing or redoing a view step still in flight cancels it.
- Redo while a view change is in flight waits for it, as today (I5).
- "Hide" means Hide rows. Hiding a column stays a column write.
- A choice on another sheet stays refused while one is in flight, until V3b is built.

## What the code does today

### Edits, presses, and header gestures

**Edits are one at a time, by refusal.** `base_gestures_admitted`, `history_free`, and `edit_gestures_admitted` (`app.tsx:7332`, `7369`, `7383`) refuse an edit while any of these is in flight:

- a replay;
- a highlight;
- a row height;
- an append;
- a column or width write;
- this window's own sort, on any sheet.

They also refuse a gesture made after a waiting press (`press_admits`), and GridShell says why (`refused_for_history_press`).

**Undo and Redo are held** instead of refused. A held press also waits for:

- a sheet's pending request (`HeldPress.step_wait`, `app.tsx:8158`, `8255`, `8910-8913`);
- a snapshot identity (`refreshing`).

**A header gesture is queued** behind earlier work (`enqueue_excel_header_change`, `app.tsx:9819`).

- Its drain abandons it when the view generation moves (`9604-9608`), and waits for a view request in flight (`9626`).
- All its sheets record one step (`9501`).
- It has its own timers: a publication acknowledgement timeout (`9659`), a wake for a transient retry (`9785`), and an unanswered warning (`9713`).
- `transform_request_blocked` refuses a sort while a header request is pending (`10237`).

### Sort, filter, and hide controls

**`transform_pending`** is true while the active sheet has any request in flight, a replay included (`request_transform` sets `pending_transforms`, `app.tsx:3913-3923`).

These controls read it to stop a sort, filter, or hide choice:

- grid sort and filter items (`grid-shell.tsx:11455`, `11471`, `11502`);
- the keyboard shortcut (`11791`);
- Hide rows in the cell, row, and column menus (`12667`, `13017`);
- the transform sections (`13136`, `13230`);
- the toolbar's SortStrip, FilterStrip, and Unhide all (`state-strip.tsx:66`, `92-95`);
- the compare strip's "Only changed rows" (`filter_pending`, `compare-strip.tsx:143`, `app.tsx:13747`). Its handler already composes onto pending rules (`app.tsx:10658`), and it is not undoable (`view-history-model.ts:200`);
- `open_filter_editor` (`app.tsx:10683`);
- `handle_hide_rows` (`app.tsx:10393`).

Other readers use it to wait or to show state:

- the structure menu's busy message (`grid-shell.tsx:11640-11645`);
- edit arming (`11648`);
- promoting a row to the header (`13045`, `app.tsx:13719`, `13722`, `13195`);
- saved-row focus (`grid-shell.tsx:5217`);
- the source-to-display row query (`2396`, `5328`);
- `body_view_transformed` (`2532`);
- the pending indicator (`state-strip.tsx:118`);
- Auto-fit (`13237`, `13899`, `12522`).

**The controls build their next rules from the installed rules.** GridShell gets `transform_state={visible_transform}` (`app.tsx:13706`), and its handlers spread it (`grid-shell.tsx:11457`, `11473`, `11505`, `11806`, `11823`, `13279-13297`). The state strip's SortStrip, FilterStrip, and "Show all" build from `transform` (`state-strip.tsx:70-110`). The filter editor reads `visible_transform.filters` (`app.tsx:13924`). Only the menu's display reads the pending target (`pending_transform_target`, `app.tsx:13204`; `grid-shell.tsx:11640`).

**Unhide all with a promoted Header Row** queues a header change that turns the header off and restores the rows above it (`app.tsx:10609`).

**App blocks the controls** during Save, a session claim, preview mode, or a header change (`transform_ui_blocked`, `app.tsx:13280`, used at `13707` and `13795`). A context menu shows them disabled through its own claim (`transform_waits_for_claim`).

**The window refuses:**

- a request on another sheet (`view_gesture_may_start`, `app.tsx:10277`), because two in flight could land and be recorded in the other order (`10268-10272`);
- Hide rows during a request on its sheet (`10393`).

`transform_request_blocked` (`app.tsx:10233`) also blocks during Save, a session request, a header change, and everything `history_free` checks, a replay included.

**Only Cancel stays reachable** (`app.tsx:10842`). It is gated by `cancel_blocked` (`10250`), acts on the active sheet, and goes back to the installed rules (`transform_rollback_baseline`).

This fails N4.

### The parts for latest-wins

- **Replacement.** A request replaces the one pending on its sheet, in the window (`request_transform`, `app.tsx:3899`) and on the host. On the host, a newer operation token stops the running computation, which then answers nothing (`panel-core.ts:1890-1906`).
- **Recording.** A step records on install, from the rules last installed. A replaced request and its replacement record as one step (`app.tsx:10360`).
- **Cancel.** A cancel back to the host's installed rules skips the computation, and writes the cancel durably before its answer (`panel-core.ts:1836-1870`, `1908`). A cancel sent after the host has installed, but before the answer arrives, recomputes.
- **Ownership.** The window that owns the editing session may sort (`viewer-controller.ts:6417`).

### View steps of several kinds

View history holds transform steps: sort, filter, and hidden rows. It also holds hidden columns, widths, heights, and Header Row changes (`view-history-model.ts:121`). Only a transform replay goes through `request_transform`.

### Hide rows

- It sends display rows and clears the pending target (`app.tsx:10406-10408`).
- The host maps the rows and composes them onto its installed rules, enforcing `MAX_PERSISTED_HIDDEN_ROWS` with "Too many hidden rows to persist." (`viewer-controller.ts:15043-15060`).
- It checks the core-wide generation and the source generation (`15028`, `15032`).
- Unhide all removes `hiddenRows` (`app.tsx:10621`).

### Generations

- **On the host.** Every install bumps the core-wide generation (`panel-core.ts:1925-1933`). Row requests quoting another generation are dropped silently (`panel-core.ts:2068`), and replies carry the core generation (`2085-2115`).
- **The filter value list** checks the core generation (`panel-core.ts:1148`), though it reads the source column and caches by source generation (`1183`). The window's value-list effect does not retry on a generation change (`app.tsx:10706`, `10749`).
- **In the window,** every install sets the window's generation (`app.tsx:6854`). It reaches the row loader through GridShell (`app.tsx:13598`, `grid-shell.tsx:2033`). The loader clears its cache when the generation changes (`row-loader.ts:165-196`) and drops replies of another generation (`345`, `400`). GridShell's view identity includes it (`grid-shell.tsx:3728`).

### Save and transforms

The host refuses a transform during Save, and Save during transform work (`viewer-controller.ts:12629-12643`). The window refuses Save while one of its view requests is in flight (`app.tsx:4101`).

### Refreshes

- `settle_overtaken_view_requests` (`app.tsx:2381`) decides the requests a refresh overtook, and records a landed one through `record_view_step` (`2434`), in sheet order (`2388`).
- A snapshot that moves the view generation drops every pending view request into it (`app.tsx:5995-6117`), and a late answer is ignored (`6751-6755`).
- The host refuses a header change (`viewer-controller.ts:13947`), Save (`:12651`), and a replay through its lease, from a window that has not acknowledged its latest snapshot.
- It posts a replay's result before the refresh that exposes it (`post_history_replay_outcome`, `17242`).
- A sort's answer is `transformInstalled` or `transformRefused`, not a snapshot.

### Other parts

- **A refused view request of the person's stays refused** (`app.tsx:6646`).
- **The restore** (`app.tsx:7200-7295`) is never sent while a request is pending on its sheet or a replay is out, and has no reopen check. A person's choice composes onto a pending restore's target and replaces it (`10343`).
- **An owed Auto-fit** waits for a free window, no view request on any sheet, and nothing to redo (`app.tsx:12553-12592`).
- **Pastes.**
  - Glide runs them one after another (`src/webview/glide-data-grid/data-editor/data-editor.tsx:4121`).
  - Each has its own ticket (`grid-shell.tsx:3809-3830`).
  - A paste made while a press waits is refused at its first step (`11705-11712`).
  - A failed paste drops the press made after it (`3816`).
- **A write that changes nothing is no failure.** The press behind it runs (`app.tsx:11937-11940`, `9527`).
- **Release.** Width and row-height replays and size gestures do not wait for a session release (`app.tsx:8404`, `12041`).
- **Long work before the irreversible part.**
  - Save stats, reads, digests, and parses before its intent record and `write_file` (`viewer-controller.ts:12942-13158`).
  - A header change plans first (`file-coordinator.ts:1215`).
  - A replay's preparation and commit can digest the file (`18366`, `18387`), and its commit materializes cells before the durable mutation (`17420`, `17456`).
  - The replay coordinator cannot cancel a replay (`history-replay-coordinator.ts:411`, `514-531`).

## Measurements

### Setup

Apple silicon Mac, Node 26.12.1, Electron from `npm run desktop:prepackage` at 6d7d884d. The CSVs are 8 columns, made with a fixed seed: 1M rows (46 MB) and 200k rows (9 MB). These are examples on CSV, not bounds for workbooks. V1 commits the desktop probe as `desktop/test-performance/history-latency.spec.ts`. Raw data: `t3-2652f5c3-probes/desktop-probe-results.jsonl` in the shared temp directory.

### The host's computation

`compute_transform`, in Node, three runs each:

| | 200k cold | 200k warm | 1M cold | 1M warm |
|---|---|---|---|---|
| sort by the number column | 282–286 ms | 183–206 ms | 1854–1952 ms | 1460–1491 ms |
| sort by a text column | 220–231 ms | 141–147 ms | 1203–1261 ms | 856–869 ms |
| filter "contains" | 87–89 ms | 12–16 ms | 412–433 ms | 53–62 ms |
| filter and sort | 171–175 ms | 12 ms | 846–893 ms | 57–61 ms |

A cancelled computation stops at its next checkpoint, under 1 ms after the cancel. That is in Node only: no message loop, durable write, or answer.

### The desktop app

**Method.** Rows marked † end at the grid's accessibility table, read by a MutationObserver. That table is debounced by 200 ms (`useDebouncedMemo(..., 200)`, `glide-data-grid/internal/data-grid/data-grid.tsx:1720-1924`), and a render in between restarts the debounce (`common/utils.tsx:153`). So those rows include up to 200 ms or more that is not work.

**Runs.**

- The sort and Undo rows are from the 00:52 UTC run. The sort ends when the row that must come first after the sort is showing (id 1896). The Undo during a sort ends at the last time the pending indicator (`.toolbar-progress`) goes away, with the natural rows showing.
- An earlier probe ended at the first change to the first row. That change can be an intermediate state after the grid remounts, so its figures are not used.
- Typing and commit are from the 00:06 run.
- Save is from the 23:06 run. It polls the button, so it may be late by one poll.

| | 200k | 1M |
|---|---|---|
| sort, click to the sorted first row † | 454–534 ms | 1941–2053 ms |
| Undo of an installed sort, post to natural order † | 254–264 ms | 249–264 ms |
| Undo posted during the sort, post to the pending indicator's last end (today: held until the install, then undone) | 205–213 ms | 1772–1850 ms |
| sort items disabled while the sort is in flight | yes | yes |
| typing in an open editor, key to the next frame, p50 / p95 / max (86 one-character keys) | 8.1 / 16.6 / 18.4 ms | 11.1 / 16.7 / 18.3 ms |
| commit, Enter to the frame after the cell's text appears in the table † (12 commits) | 219–237 ms | 217–236 ms |
| Save, click to clean (polled) | 235–255 ms | 1015–1053 ms |

A minimal queue costs 0.03–0.06 µs per item when run synchronously, and 0.12–0.17 µs with a microtask hop, over 100,000 items in Node. That supports only one claim: putting work in order costs nothing. There is no React render in it. Q1 keeps an idle press synchronous, and Q1's own test checks it.

### What the numbers say

- **Waiting costs time; queueing does not.** A 1M-row sort is about 1.5 s of work warm and 1.9 s cold, and a 1M-row Save about 1 s.
- **Undo during a 1M-row sort takes about 1.8 s today,** to the pending indicator's last end, on a sheet with no installed rules. The indicator went away once in each run, but its end is one interval, not proof that the replay had settled. If Undo cancels the sort, the cancel skips the computation when the sheet had installed rules and the host has not installed the sort yet. On a sheet with no installed rules, it computes the empty rules, which is cheap. V1 measures each case.
- **Typing does not go through the queue.**

### The latency spec, from V1 on

App emits `performance.mark`s when:

- a press is handled;
- the history store changes;
- a sheet's view request ends, by request id;
- the grid renders a new view generation.

| what | how | budget |
|---|---|---|
| idle Undo of a cell edit | post to the store mark; 40 paired rounds, alternating builds | median of paired differences within 10 ms |
| typing | key to the frame that shows it, one-character keys | at least as many keys shown in the same or next frame as the baseline, less 2 % |
| Undo during a 1M-row sort, before the host installs, on a sheet with installed rules and on one without | post to the request-ended mark | within 500 ms, with no render mark for the sorted generation in between |
| a second sort chosen during the first, on 1M rows | the second's click to its request-ended mark, against the same sort run alone | within 100 ms of the lone run. The spec asserts that the first was still computing when the second was chosen, and that no render mark for the first's generation came |
| a filter composed late in a 1M-row sort | the restart cost | recorded |
| Undo during a 1M-row sort, after the host installs, and after "Only changed rows" was toggled | post to the request-ended mark | recorded: the cancel recomputes |
| Hide rows on 1M rows | both round trips | recorded |

The 500 ms budget is not measured yet. The nearest figure is the 249–264 ms Undo of an installed sort. The "Undo posted during the sort" row is today's behaviour, for comparison only.

The marks are emitted only when the spec sets a test flag in the page, so a production window keeps no mark buffer. The spec compares two builds: the stage's, and a baseline build whose path it takes from `TABLE_VIEWER_BASELINE_DIST`. **Paired comparisons use the same endpoint on both builds.** V1 against `main` uses the † method on both. From V1 on, a stage is compared with V1's build by the marks on both. Q1 also has a unit test that an idle press runs in the task that made it.

### Not measured

The generators here write CSV. V4's and X1's plans measure these first:

- a Header Row change on a large workbook;
- a Save of a large XLSX;
- a replay's preparation and commit on a large file;
- a paste of a large range;
- a session claim on a large file.

## Options

The options are listed A to F, with the chosen one, D, last. A race that "stays" is one a basis check or the host fixes, which no option in the window touches.

**A. A full FIFO for every operation, the view and refresh adoption included.**

- #392 is removed by order.
- #393 cannot be removed: the host refuses a header change, a Save, or a replay until the latest snapshot is acknowledged, so a queued adoption holds them refused.
- #391 stays.
- A second sort waits 1.5 s at 1M rows, Undo during a sort waits about 1.8 s, and a commit during a sort waits up to 1.5 s.
- Fails N1 to N4.

**B. A queue for Undo, Redo, Header Row, and Save only, with the view as desired state.**

- Removes #392's press-while-busy part. The rest stays coordinated by hand.

**C. Keep the paths, and consolidate the gate.**

- Removes nothing.
- Meets none of the new requirements.

**E. Refuse a press while anything runs (VS Code's `UndoRedoService`).**

- Breaks K2.
- A held key gives one dialog per step.
- Does nothing for N1, N2, or N4.

**F. The view only.**

- Removes none of #391 to #394.
- Meets N1, N2 for the view, and N4, with the exceptions below.

**D. Chosen: F with the queue.**

F meets the new requirements, with the exceptions below. The queue removes no race. It removes coordination:

- the slots and the drain;
- the press model's eight facts. Each becomes a predicate of the slot over the same refs, so the refs, and the sites that clear them, stay;
- tickets and epochs, the header timers, and `release_seq`.

These stay, whatever is chosen:

- **#393:** the host's terminal-before-refresh order, and the window's rule that a terminal moves history exactly once. Mapping by worksheet identity, and the floor against older deliveries (`app.tsx:7554`, `7614`, `7632`).
- **#394:** the publication fence in the bridge (`host-bridge.ts:189`, `205`; `app.tsx:3863`).
- **#391:** the basis check at a drag's commit, and the header write at shutdown on the host.

How D settles the conflict between the research verdict and the code:

- **Refreshes** "go through the same order" as events applied first. Each pending item is then decided against them, as ProseMirror's `receiveTransaction` rebases unconfirmed steps.
- **Outside causes** stay outside. The window's items survive them through the lease, the compare-and-swap, and the retry facts.
- **Interactive gestures** stay checks, as Calc routes Undo to an open cell editor. An async gesture (a paste, keys waiting for a session) takes its place when it is made.

## Invariants

The ADR's decision for the view rests on these. V1 builds them, and V2 keeps them for Hide rows.

- **I1. One view action per window.**
  - A **sheet action** is the person's choices on one sheet since that sheet's last install: sort, filter, Hide rows (from V2), and Unhide all.
  - A choice on another sheet while an action is pending stays refused, as today (`view_gesture_may_start`, `app.tsx:10289-10293`). So does a choice during a replay (`history_free`, `7375`). So a window has at most one pending action.
  - A restore and the compare strip's "Only changed rows" are not choices. They make no action, have no label, and are not undone. "Only changed rows" rides along in the requested rules.
- **I2. A step records when its view installs.**
  - An action records at most one step, when it ends (I3), on top of the stack, through `record_view_step` as today. The step comes from what is installed then, whichever message installed it.
  - The step runs from the action's baseline to what is then installed. It records nothing if the two are equal.
  - Nothing records before its view is on screen, and nothing is placed below another step.
- **I3. An action ends when every request it sent is settled.**
  - **The host settles every request once.** V1 adds one host message, `transformSettled`, with the request's id.
    - It carries the sheet's installed projection, read when it is posted: the same payload as `transform_installed_ack` (`panel-core.ts:1766`), with the provenance below. The window applies it through the install handler before it ends the action. So the step does not depend on when a snapshot is delivered, which can be delayed or retried (`panel-session.ts:449-470`).
    - For an installed or refused request, the controller posts it after the answer and after any durable reconciliation that the answer triggers (`reconcile_transform_terminal`, `viewer-controller.ts:13589`). That reconciliation can install an older request's durable rules, for example after a cancel's persistence fails (`csv-edit-session.test.ts:5045`).
    - A request stopped by a newer one for its sheet is settled when the newer one takes the operation token (`panel-core.ts:1844`, `1887`). It cannot install after that, because it checks the token after its last await.
    - **One owner.** The core keeps one unsettled request id per sheet and posts settled for it once. A takeover settles it if it is still unsettled, answered or not. The controller posts after its reconciliation only if the request is still unsettled; after a takeover that reconciliation is moot (`viewer-controller.ts:8228`, `8234`). The window treats settled as idempotent per id.
    - A request the host refuses before it takes the token (`viewer-controller.ts:13549`) settles itself at once. It does not take the sheet's unsettled id, so the older request that still computes stays owed.
    - The preview-mode return (`viewer-controller.ts:13493`) is never reached, because the window sends no transform in preview mode. The schema-mismatch path (`13504`) settles like the others.
  - **Provenance.** Rules equal to a target prove nothing: another window can write the same rules. So the host records, for each sheet's durable rules, which receiver's request committed them. `transformSettled` and every snapshot carry that request id for the sheet when this receiver committed them, and none otherwise. Rules are compared in canonical form (`transform_states_equal`, `panel-core.ts:1828`).
    - Several processes can share the durable state (VS Code and the desktop app, or two windows; `viewer-controller.ts:362-368`), and within one process every panel writes through the same store. So the record lives in the process, per file and sheet, and names the panel whose request committed the rules. Rules that differ from the record are from elsewhere. Another process that writes exactly equal rules between this window's commit and its reconciliation would be taken for this window's own; the step it records is one this window also chose.
    - The record is not keyed by file revision, which every unrelated write bumps (`viewer-controller.ts:7665-7700`). It is kept per sheet as the rules and the request id, set where the request's commit succeeds (`8453-8484`), and the core holds it so that settled and snapshots agree. The PR settles the mechanism. It must handle another receiver committing equal rules (the reconciliation skips equal rules, `panel-core.ts:1262`), and it must update provenance even when nothing is recomputed.
    - Today such a request answers nothing: the returns at `panel-core.ts:1906`, `1916-1919`, and `1852-1858`, and the catch arms that a cancelled computation reaches.
    - A request the host refuses before it takes the token does not stop the older one (`viewer-controller.ts:13549`, `panel-core.ts:1801-1820`), so the older one is still awaited.
  - **Every answer and refresh is applied,** replaced requests included. The window takes an install whole through the existing handler (`app.tsx:6758`, `6877`, `6985`): rules, row count, mapping generation, and row heights. A request is matched by the ids the action keeps, and by document, source, and worksheet identity.
  - **A refusal,** transient or terminal, settles its request, as today: the window does not ask again for a person's choice (`app.tsx:6646`). Only the restore asks again.
  - **A new source** ends the action, as today: the host abandons the computation (`panel-core.ts:1886-1894`), and the window sees the new source generation (`app.tsx:5808`). It is decided by `settle_overtaken_view_requests`. A new receiver is a new window.
  - **Any other refresh never ends the action.** A refresh whose rules for the action's sheet differ from the baseline, and were not committed by one of the action's requests, is a change from elsewhere, such as another window's reconciliation (`panel-core.ts:1328`). It moves the baseline to the adopted rules. The action's request is composed again, its deltas onto the new baseline (a cancel has none), and sent again if it changed, which supersedes the one in flight. A refresh whose rules one of the action's requests committed moves nothing; the step at the end records it.
  - **At settlement** the same test applies to the installed projection. If one of the action's requests committed it, the step runs from the baseline to it. If not, it is from elsewhere: the baseline moves to it, and the action records nothing for it.
  - Today any change of the core generation drops every pending request (`app.tsx:5995-5998`, `6102`) and ignores its later answer (`6751-6755`), although the host still installs it.
  - **No answer is lost while the window lives.** A post fails only when the core is disposed, the receiver changed, or the renderer is gone (`panel-core.ts:2161-2169`, `desktop/main/viewer-windows.ts:910-929`). VS Code keeps hidden webviews (`custom-editor.ts:438`). Each of those makes a new window, with no action.
  - So every install the host makes for this window is either recorded in a step or undone by the action's cancel.
- **I4. The baseline, and cancelling.**
  - The baseline is the rules installed when the action's first choice was made, or the adopted rules after a refresh (I3).
  - Undo of the pending action and the Cancel button both send the baseline, with the requested "Only changed rows" kept. That cancel is the action's newest request.
  - When the action ends, it records a step if what is then installed differs from its baseline (I2), and nothing if it is the baseline. So an answered cancel leaves no step, and a refused one records any earlier request that installed.
  - A choice made before the cancel is answered replaces the cancel, in the same action, with the same baseline.
- **I5. Presses wait for the action, as today.**
  - A Redo press made while the action is pending waits for it, bounded by 5 s with the `updating` reason. The Redo label and the store are unchanged (K1).
  - When the action ends, today's rules decide the waiting press. If the action records, Redo is cleared (K4) and the press finds nothing. If it is refused or overtaken with no step, the press is dropped with today's message (`history_gesture_unrecorded_warning`, `app.tsx:2145-2152`). If it installs with nothing changed, the press runs.
  - K3 comes first: an Undo pressed while that Redo waits drops both, and the action goes on.
  - Undo and Cancel drop presses already waiting behind the action silently, as Cancel does today (`app.tsx:10868-10880`). A press made after the cancel was sent waits for the action to end and then runs, as a press made after Cancel does today.
  - **A new choice drops a press waiting behind the action,** silently, as Cancel does: the press was made for a stack the choice changes. Today the controls are disabled then, so this case cannot arise. Otherwise the enabled control would be refused for up to 5 s.
- **I6. Choices compose onto the requested rules.**
  - Every sort, filter, Unhide all, strip-chip, and filter-editor handler builds its choice as a delta, slice by slice. It composes the delta onto the action's requested rules, not onto the installed ones (`visible_transform`).
  - Sort replaces the sort.
  - A filter add or edit replaces the filter with its id or on its column, as `upsert_filter` does today (`transform-ui-model.ts:300`). `sanitize_transform_state` keeps one filter per id and per column (`sheet-state.ts:179`).
  - Hidden rows combine. The newest choice wins for its slice.
  - The controls show the requested rules too. GridShell and the state strip get a `requested_transform` prop, and `visible_transform` stays for what is installed.

## V1: latest-wins on one sheet

### Controls

- **The sort and filter controls** listed under "What the code does today" stop reading `transform_pending` for the action's own request. They read a new per-sheet flag instead: a hide, a replay, or a restore is in flight on the sheet. A hide is a pending request that is not a sort, filter, or Unhide all choice; V2 deletes that term when Hide rows becomes part of the action. That includes the compare strip's "Only changed rows".
- **They stay disabled for today's other reasons:** Save, a session claim, preview mode, a header change, a replay, inserted rows, and the reopen fence (`transform_ui_blocked`, `transform_request_blocked`). The cases where a control is enabled while its handler refuses are today's, and no more: `transform_request_blocked` refuses through `history_free` during a highlight, size, or column write, and while a press waits (`app.tsx:7369-7380`, `10233-10240`).
- **During a restore,** an open filter editor's Apply is refused with "Wait for the table view to finish updating.", as the disabled controls are. Today it composes onto the restore's target.
- **Hide rows** keeps `transform_pending` in V1, and V2 moves it. Unhide all moves in V1, because it composes like a filter.
- **Readers that wait or show state** keep `transform_pending`.

### The filter value list

The value list reads a source column. From V1, the host admits it by source generation, sheet, and column, not by the view generation. A change of the sheet's columns is a change of source generation. V1 is what lets the filter editor open during a sort, so a sort that installs between opening the editor and the host's admission must not refuse it.

### Undo, Redo, and Cancel

- **Undo while the action is pending** cancels it (I4). The press is used up, and no step is made.
  - The host skips the computation when the baseline equals its installed rules (`panel-core.ts:1836-1870`). Otherwise it recomputes: after an earlier request installed, or when "Only changed rows" was toggled during the action.
  - **The cancel is never blocked.** `cancel_blocked` (`app.tsx:10250`) reads Save, a session claim, preview mode, a header request, and gesture admission. None of them can be in flight while an action is pending: Save is refused during a view request, a session request waits for sent requests, a header change waits for the view request, preview mode refuses transforms, and other gestures are refused. V1 tests that `cancel_blocked` is false whenever an action is pending, one case per term.
- **A second press while the cancel is out** waits for the action to end, with `updating`. V1 narrows the `view_request_in_flight` fact to "a view action, a hide, or a restore in flight".
- **A header run can be newer.** Unhide all with a promoted Header Row queues a header run behind a pending sort (`app.tsx:10609`). An Undo or a Redo then waits for the header run, as today (`applying`). A header run is not a sheet action.
- **Undo of anything else** runs against the newest recorded step, with today's waits: a sheet's pending request (`step_wait`), a restore, a snapshot identity, and, for a replay that needs a session, this window's sent requests.
- **The Cancel button** cancels the active sheet's action, as Undo does (I4). It drops waiting presses silently, except a press held for typed keys, as today (`app.tsx:10876`, `app.test.ts:27306`).
- **The label.** While the action is pending, the Edit menu's Undo names it with today's view-step label function, applied to its baseline and requested rules: "Undo Sort", or "Change view" for several choices. `history_menu_projection` gains the pending action as an input.

### Other cases

- **A replaced document** drops the action silently. Its late answers find no record.
- **The reopen fence** refuses choices, Undo, and Cancel with the edits message, as today.
- **An owed Auto-fit** keeps its waits, including no view request on any sheet. K6 is unchanged.
- **A refusal from the host** of a sent choice stays refused and is said as today (`app.tsx:6646`).

### The V1 stage

- **Adds** (about 300 lines):
  - the sheet action, with its baseline, requested rules, and kept request ids;
  - choices as deltas, and `requested_transform`;
  - Undo and Cancel back to the baseline;
  - the host's `transformSettled` message, and the action ending when every request it sent is settled (I3), with the refresh rule;
  - the narrowed view fact and the hide-replay-or-restore flag;
  - a new choice dropping a press waiting behind the action;
  - the menu projection input;
  - the value list admitted by source generation and schema;
  - `performance.mark`s and the latency spec;
  - the smoke specs that expect the old label, or disabled controls, during a sort, updated.
- **Deletes** (about 40 lines): `transform_pending` in the sort and filter controls; dropping every pending request on a refresh that keeps the source.
- **Visible:** changes 1 to 4.
- **Tests first:**
  - a second sort during the first, from the grid, the menus, the shortcut, and the toolbar; for each control, A, then B during A, then the install shows both;
  - a filter opened, edited, and cleared during a sort; a filter edit composed onto requested rules that hold another filter on the same column: one filter remains, the newest;
  - Undo during a sort, before and after the host installs, with a held key, and over a pending restore;
  - Undo with "Only changed rows" toggled during the sort: the sort is cancelled, and the toggle stays;
  - A, then B replacing it, then A's install applied, then Undo, and the same with Cancel: the view is back at the baseline, and the stack is unchanged;
  - a refused cancel after an earlier request installed: one step records what installed;
  - A computing, then B refused before admission, then A installs: one step, and the same with a cancel refused before admission;
  - a request superseded by a newer one: settled when the newer one takes the token, and the action ends only when the newer one is settled;
  - every host path settles its request, the catch arms and the schema-mismatch path included, and settles it once: a takeover while the older request's reconciliation awaits the disk, and a takeover after its answer;
  - settled arriving before the snapshot that carries the reconciled rules: the step is recorded from settled's projection;
  - from O, the action requests A, then B supersedes A before A commits; another window durably writes rules equal to A; B's persistence fails and the reconciliation installs them: the action records nothing, and the baseline is A;
  - A committed durably, then a cancel whose persistence fails, so the controller reconciles A (extending `csv-edit-session.test.ts:5045`): the action ends after that reconciliation, and Undo undoes A;
  - a choice made before the cancel is answered: same action, same baseline, one step;
  - a refresh about another sheet while a sort computes: the request stays, installs, and records;
  - another window's reconciliation of the same sheet while a sort computes: the request is composed onto the adopted rules and sent again, and records from them;
  - a refresh whose rules equal the action's target, then a different refresh, then the original request's answer: the action ends only on the answer;
  - a reconciliation while a cancel is out: the cancel is sent again for the adopted rules, and no step records;
  - a new source while a sort computes: settled as today;
  - a replaced document with an action pending;
  - Redo pressed during a sort: it waits; it finds nothing after the install; it is dropped with today's message after a refusal; it runs after an install that changed nothing; an Undo pressed while it waits drops both;
  - a second Undo pressed after the first one's cancel was sent: it waits, then undoes the step under the action;
  - a choice made while a Redo waits behind the action: the Redo is dropped silently, and the choice is taken;
  - a sort and filter control during a hide in flight, in V1: disabled, as today;
  - Unhide all with a promoted Header Row queued behind a sort, then Undo: the press waits for the header run;
  - `cancel_blocked` false whenever an action is pending, one case per term;
  - the action's label in the Edit menu;
  - an install between opening the filter editor and the value list's admission;
  - "Only changed rows" during a sort: not recorded, not targeted by Undo;
  - a refused filter editor Apply during a restore;
  - a choice on another sheet during an action: refused as today, and still one action;
  - Hide rows still disabled during a request, as today, until V2;
  - the new smoke spec, `undo-redo-view-latest.spec.ts`: a second sort during the first, then Undo, which cancels it, with the Edit menu's label read;
  - the latency spec against `main`.

## V2: Hide rows through resolution

- **Resolving.** Hide rows asks the host to resolve its display rows to source rows. The request computes nothing. Today `hideRows` sends the core-wide generation, and the host checks `core.generation` (`viewer-controller.ts:15028`). In V2 the window sends the sheet's entry in `mapping_generations_ref`, and the host checks that sheet's mapping generation (`panel-core.ts:418`) and the source generation.
- **While it resolves,** the hide is part of the sheet's action (I1), and one of its requests: the action does not end until the resolution is answered. Later choices are sent at once without it. A choice on another sheet is refused while it resolves, as for any pending action. A resolving hide alone is a pending action: Undo or Cancel drops it with no host request. It counts as a pending request for the edit refusal and for Save's refusal. It does not count for the session rule, because it sends no transform.
- **Unhide all supersedes it.** Unhide all ends every earlier unresolved hide on its sheet, whose answers are then ignored.
- **When the answer comes,** with its action still pending, the hidden source rows compose onto the requested rules and replace the request.
- **If a sort installs before the host resolves the hide,** the host refuses it with "The view changed before this table view request arrived.", because the rows moved. An answer for a hide its action dropped, by Undo, Cancel, or Unhide all, is ignored.
- **Hide during a sort.** The host answers the resolution between the sort's computation checkpoints (`cancellation_checkpoint` yields with `setImmediate`, `table-transform.ts:1302`). So the hide normally composes before the sort installs. That replaces the sort's request, so at 1M rows the sort is computed again with the hide.
- **The row limit.** The window checks `MAX_PERSISTED_HIDDEN_ROWS` with the host's message, "Too many hidden rows to persist." The host's transform admission gains the same check, and both use one shared constant and message.
- **A refused resolution ends only the hide.** The rest of its action goes on. The host's messages are "The view changed before this table view request arrived.", "The source changed before this table view request arrived.", and "Row hiding is unavailable in preview mode." None is tried again.
- **A resolution with no answer after 5 s** ends the hide with "Wait for the current change to finish." The host returns without an answer when it has no core (`viewer-controller.ts:15027`).
- **The label.** A resolving hide is labelled "Hide N rows", N being the display rows chosen. The toolbar shows "Hiding rows…" (`app.tsx:10433`), and the menu shows "Undo Hide N rows". With other choices in the action, the label is "Change view".

### The V2 stage

- **Adds** (about 160 lines): the host's resolution request; the resolving hide in its action, with its label; Unhide all ending resolving hides; the shared row limit; the Hide rows items on the new flag.
- **Deletes** (about 10 lines): `pending_transforms[active]` in `handle_hide_rows`.
- **Visible:** change 5.
- **Tests first:**
  - on the host: a stale mapping, the limit, and a resolution answered while a transform computes;
  - in the window: hide during a sort; a sort during resolution; hide after hide; Unhide all before and after the answer; hide, then sort, then Undo or Cancel, then the late answer; a sort's install before the host resolves the hide: the hide is refused, with the menu's label before and after; an install that moves no display row before it: the hide composes; a choice on another sheet while a hide resolves: refused; each refusal of a resolution ending only the hide; a resolution with no answer; an edit and a Save refused while a hide resolves, and a session request not held by it; Unhide all with a promoted Header Row during a sort and during a resolution; a replaced document;
  - the new smoke spec: Hide rows during a sort.

## Later stages

Each of these gets its own plan, reviewed by both reviewers under the same rules, just before it is built. The text here is the direction and the exit test, not the design. The full drafts reviewed through round 10 are in commit `6768ac2a` (this file, "Design: the queue", "Other sheets", "Choices made during other work", and "Stages"). Findings deferred from review are listed in the ledger for each stage.

- **Q1: the queue core.** Presses become queue items with a direction, a target, and a blocker. Replays hold one exclusive slot. The two press slots, the drain, the two-slot timer, and the coordinator's `busy` refusal go. V1 and V2 build "Undo cancels the pending action" and the Redo wait on today's `hold_history_press` and `drain_history_press`, which Q1 then rewrites; Q1's plan names that rework. **Exit test:** a press made while a replay runs waits as a queue item and runs when it lands, every existing press test passes, and `held_press_ref`, `retry_press_ref`, and `drain_history_press` are gone.
- **V3a: the row basis per sheet.** The row loader, GridShell's view identity, and the host's row requests are keyed by the sheet's source and mapping generations, so another sheet's install does not reload the active grid. **Exit test:** another sheet's install leaves the active grid's rows, selection, scroll, and a held key as they were.
- **V3b: choices on other sheets (deferred).** A choice on another sheet runs beside the one in flight. Its plan must keep I2, so that a step still records when its view installs, and must say what that does to the order of history. **Exit test:** a sort on sheet 1 and a filter on sheet 2, made during it, both install and record, and Undo undoes the one that installed last.
- **V4: choices made during other work (deferred).** A choice made during Save, a header run, a session hand-off, a write, or a replay is applied when that work ends, or dropped with the reason. Its plan measures the work under "Not measured" first, and reads the same blocker function as presses, not a parallel one. **Exit test:** a sort chosen during a 1M-row Save is applied when the Save ends.
- **Q2: Header Row changes, Save, and Discard hold the slot.** `header_change_in_flight`, the header drain tick, and the header timers go. **Exit test:** a press during a header run and during Save waits with today's reasons, and the header drain and its timers are gone.
- **Q3: gestures that write to the host, and async gestures, hold the slot.** Tickets and press epochs go. Its plan must say how a continuation made before a waiting press proves it, once tickets are gone. **Exit test:** a paste, held keys, and a row admission made before a waiting press finish and record before it runs, with `gesture_ticket` and `press_admits_ticket` gone.
- **Q4: session hand-offs.** A session request becomes a phase of its holder. `release_seq` and the transform-wait loops go. **Exit test:** a replay that needs a session waits for this window's sent request, then runs, with `next_window_transform_wait`'s loops gone.
- **Q5: the press model goes.** `history-press-model.ts` is deleted. **Exit test:** every site that clears a channel's refs wakes a waiting press with no further render, and the file is gone.
- **X1: cancel before the irreversible part.** It measures Save, a header change, a replay, a paste, and a claim on large files, and adds cancel points where one is long. **Exit test:** decided by its plan from the measurements.

**Tripwire for the Q stages.** Each Q stage's plan fixes, before it is built, how it counts the facts, the distinct refs read by the press and slot logic, and the sites that notify them. Its PR reports those counts and its net lines. A Q stage must lower the refs or the facts, and raise none, or the plan stops there.

## Exceptions to N1 to N4

Named here. They are part of option D, which the user approved. A later stage's plan may remove one, and may not add one unless it removes one.

1. **A press waits for its blocker, and for the press before it.** A Redo press during a pending action is one (I5).
2. **Work before the irreversible part, which is not atomic, holds the slot** in Save, a header change, and a replay. X1 measures it.
3. **Deferred work.** Until V3b and V4 are built, a choice on another sheet while an action is pending, and a choice during Save, a header run, a session hand-off, a write, or a replay, stay refused or disabled, as today.
4. **A replay that needs a session waits for this window's sent request.**
5. **Edits, structure, column, size, and highlight gestures stay refused** during this window's own view request. This is the user's decision.
6. **Save stays refused while a view request is in flight** (`app.tsx:4101`, `viewer-controller.ts:12629-12643`).
7. **Holders that cannot be cancelled:** a paste run, a session claim, a row admission or append, and a highlight, size, or column write. All but a large paste and a claim on a large file are one short round trip.
8. **A restore.** While the saved-view restore is in flight, the sort and filter controls stay disabled, an open filter editor's Apply is refused, and a press waits for it. A restore is not a choice, and it cannot be cancelled.

For N2, "long" means it can exceed 1 s on a file the app supports.

## User-visible changes

1. **(V1)** Sort and filter controls stay enabled while the person's own request is in flight on their sheet, in the grid, menus, keyboard shortcut, filter editor, toolbar, and the compare strip's "Only changed rows". A new choice replaces the request and keeps what it asked for, as one step.
2. **(V1)** Undo while the person's own request is still in flight cancels it, back to the rules from before it. Today the press waits for the install, then undoes it.
   - Every control shows and builds from the rules asked for, not only those installed.
   - After Cancel, or an Undo that cancels, cells stay held until the host has settled the cancel, as for any view request of this window (exception 5). Today they are editable while the cancel is out. An Undo or Redo pressed after the cancel waits for it.
   - During a restore, an open filter editor's Apply is refused with "Wait for the table view to finish updating."
   - A refresh about another sheet, or another window's change to this sheet, no longer drops the request in flight. Today it is lost silently, though the host installs it. After another window's change to the sheet, the request is sent again onto it.
   - A new choice drops an Undo or Redo press waiting behind the request, silently.
   - If a choice that replaced earlier ones is refused after the host took it up, the earlier ones are lost with it, because the host stopped them for it. The refusal is said, as today.
3. **(V1)** While a request is in flight, the Edit menu names it ("Undo Sort").
4. **(V1)** The filter value list is no longer refused by a sort that installs while the editor opens.
5. **(V2)** Hide rows during a sort, or a sort during Hide rows, keeps both, unless the sort installs before the host resolves the hide. Then the hide is refused, because its rows moved.
   - On a large file it costs a second sort, because the hide replaces the sort's request.
   - A hide whose rows moved before they were resolved says "The view changed before this table view request arrived."
   - Unhide all ends hides still resolving.
   - A hide resolution with no answer after 5 s ends with "Wait for the current change to finish."

Message wording stays the same. Existing messages appear in new places only in changes 2 and 5.

## What each PR must pass

- The unit suite and the typecheck.
- The undo and redo smoke specs, run serially several times, with the desktop left alone: `desktop/test-smoke/undo-redo-*.spec.ts`, `paste-append-rows.spec.ts`, and `header-row-unsaved.spec.ts`.
- The stage's new smoke spec, through the real menu path.
- **Stress evidence, not a pass condition.** Filesystem churn plus three parallel loops of an explicit list of specs that need no focus: those that build their events in the page and do not read the application menu. The menu-path specs read the focused window's projection (`desktop/main/main.ts:1062`), so they run only serially. A failure under load is ruled out as load before it is chased.
- The line counts are estimates. Each PR states its real counts.

## Risks

- **New race surfaces in V1 and V2:** the action's kept requests, the refresh rule, the cancel's answer, and resolving hides. Each has tests above.
- **A request superseded after its durable commit.** The controller's reconciliation installs its durable rules after the replacement fails. I3's settled message waits for that reconciliation, carries what is installed and who committed it, and V1 tests it.
- **Rework.** V1 and V2 build on the press paths that Q1 replaces.
- **The menu changes when an action starts and ends.** `history_menu_projections_equal` limits posts, and the smoke specs that expect the old label during a sort are updated in V1.
- **Holding Undo on a large file** walks back one view step per install: about 1.5 s per step at 1M rows warm, and 1.9 s cold.
- **Load.** FSEvents drops fs.watch events under load.
