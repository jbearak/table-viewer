# One queue per window for document changes, and a view that converges

Status: decided by the user. The view on one sheet is built first, then the queue, one channel at a time. Choices on other sheets while one is in flight, and choices made during other work, are deferred: they stay refused, as today, until each is planned and reviewed on its own. Cancelling Save, a header change, or a replay before its irreversible part is planned separately. Edits stay refused while this window's own view request is in flight.

## Decision

### The view converges (first)

Sort, filter, and Hide rows are the view the person asked for, which the host converges to. These invariants hold:

- **One view action per window.** A sheet action is the person's choices on one sheet since its last install. A choice on another sheet, or during a replay, stays refused while one is pending, as today.
- **The newest choice wins.** It composes onto the rules already asked for, slice by slice, and replaces the request in flight. Every control builds from, and shows, the rules asked for.
- **A step records when its view installs,** on top, from the rules before the action to what installed. Nothing records before the view is on screen, and nothing is placed below another step.
- **An action ends when the host has settled every request it sent,** after any durable reconciliation that follows. The settlement carries what is installed and which of the window's requests committed it, so rules written by another window are not recorded as the action's. The record of which request committed the rules is kept in the process, which leaves one case. Another process that writes exactly the rules this window committed, between that commit and its reconciliation, is taken for this window. The step it records is then one this window also chose, and its Undo goes back over both. Every answer and refresh is applied, so every install the host makes for the window is either recorded or undone by the action's cancel. A refresh ends the action only when the source is new. A refresh that changes the sheet's rules from elsewhere moves the action's baseline, and its request is sent again onto them.
- **Undo of the pending action, and Cancel, go back to the action's baseline:** the rules from before it, or the rules a refresh from elsewhere moved it onto. That cancel is the action's newest request. A choice made before it is answered stays in the same action.
- **Presses wait for the pending action, as today,** and today's rules decide them when it ends. A new choice drops a press waiting behind it.
- **Hide rows** first asks the host to turn its display rows into source rows. The hide then composes onto the rules asked for, unless a sort installed first and moved its rows, in which case it is refused.

### The queue

The window moves its document writes, one channel at a time, into one queue. The queue keeps the person's actions in the order they were made, and writes to the host one at a time through one exclusive slot. These hold it:

- replays;
- Header Row runs;
- Save and Discard;
- size, column, and highlight writes;
- row admissions and appends;
- a paste run, whose pastes each keep their own outcome;
- keys held for a session or an editor;
- an owed Auto-fit;
- the editing session's request.

A session release does not hold the slot. It blocks only what needs the host's transform or session admission. Size gestures and width and row-height replays pass it, as today.

A gesture made while the slot is held is refused with today's message, as it is today. A Header Row run waits for the slot, as the header queue waits today, and a paste joins its run.

Undo and Redo are queue items. Undo or Cancel of a sheet's pending action goes back to the action's baseline: the rules installed when it began, or those a refresh from elsewhere moved it onto. A press waits for the slot holder, then runs against the stack as it then is. It is removed with a message only if the work it was made for fails. Work that succeeds and changes nothing lets it run. Save, Discard, a session hand-off, and an owed Auto-fit block a press but are never what it was made for.

### Events and drafts

A refresh, a transform answer, or any other host event is applied at once. Each item it overtook is then decided against it, as a collaborative editor rebases its unconfirmed changes over the authority's order.

A held drag, an open editor, and an open menu are drafts with no place in line. A draft's commit checks that what it was made against is still there.

## Why

The undo and redo work in #385 to #394 found its bugs where these paths meet. Every async operation in a window ran on its own path, and Undo and Redo had to be coordinated with each of them:

- `history_press_gate` asks eight facts read from 21 refs.
- Two slots hold presses, and a drain runs after every render.
- Each gesture takes a ticket from the press counter, so that work made before a press can still finish while the press waits.

Most desktop editors we read get that order for free, because Undo never spans an await: LibreOffice's user path, Gnumeric, ProseMirror, and CodeMirror ([research note](../research/undo-redo-in-other-editors.md)). Two have async paths:

- **LibreOffice's UNO undo manager** runs every request through one FIFO.
- **VS Code's `UndoRedoService`** has async undo, and refuses a second press while one runs. VS Code's text-file model, separately, serializes saves through a `TaskSequentializer`.

Table Viewer's changes span host round trips, so the order has to be built.

The research note's verdict is that a queue helps only if saves, external refreshes, and session hand-offs go through the same order. Saves and session hand-offs hold the slot. An external refresh cannot wait in line:

- The host refuses a header change, a Save, and a replay from a window that has not acknowledged its latest snapshot. A sort's own answer is a separate message, not a snapshot.
- An adoption queued behind any of them would therefore hold it refused until its bound.

So a refresh enters the order as an event that is applied first, and each item it overtook is decided against it. That rule exists already for view requests (`settle_overtaken_view_requests`). The queue makes it the rule for replays too, keeping their retry facts.

The host's checks stay:

- a lease;
- a compare-and-swap;
- the terminal posted before the refresh;
- the basis check at a draft's commit.

The note found sort, filter, and hiding undoable in Calc and Gnumeric. None of the tools it read both records them in undo and runs them asynchronously, as Table Viewer does. Calc keeps freeze panes on the view. Gnumeric records zoom. Excel and Sheets keep per-person sorts and filters in separate views. None of them settles what Table Viewer has to settle: a view change that takes seconds on the host, made by a person who may change their mind. This design's answer is its own: the newest request on a sheet wins.

A person must never be stuck unable to choose another sort or filter while a long one runs. The host already stops a computation when a newer request for the same sheet arrives.

The view work comes first because it alone meets the new requirements for sorts and filters. It is new behaviour, not race removal, and it adds places for races of its own: the action's kept requests, the cancel's answer, and resolving hides. The plan's tests name each. The queue stages remove coordination rather than races: the slots, the drain, tickets, epochs, the header timers, `release_seq`, and the press model. The gate's facts become the slot's predicates over the same refs, and the sites that clear those refs still notify. The plan estimates the queue stages delete about 370 lines more than they add. A tripwire on the refs the press and slot logic read, the facts, and the notify sites decides whether each stage goes on. After the last stage, the queue is one exclusive slot plus waiting presses, a header run, a paste run, and, once their stage is built, deferred choices. Other gestures are still refused, not queued.

## Considered options

- **A full FIFO for every operation, the view included.**
  - A second sort waits for the first.
  - An Undo during a sort waits for it: about 1.8 s on 1M rows, to the pending indicator's end.
  - Typing waits behind a running item.
  - An adoption queued behind a header change, a Save, or a replay holds it refused.
- **A queue for Undo, Redo, Header Row, and Save only.** Gestures and session hand-offs keep their own coordination.
- **Keep the separate paths and consolidate the gate.** Least change, but every pair of paths keeps its own coordination, and none of the new requirements is met.
- **Refuse a press while anything runs, as VS Code does.** It has a precedent. But it is the opposite of the decided behaviour, in which a press waits up to 5 s and then says why. A person holding Undo would get a dialog per step.
- **The view only, with no queue.** This is the first part of the decision. On its own it leaves the press machinery as it is.

## Consequences

### What the person sees change

- Sort and filter choices stay enabled while the person's own request is in flight, and a new one replaces it as one step.
- Undo of that request cancels it, back to the rules from before it. While it is in flight the Edit menu names it.
- A refresh about another sheet, or another window's change to this sheet, no longer drops the request in flight.
- During a restore, an open filter editor's Apply is refused.
- Hide rows during a sort, or a sort during Hide rows, keeps both, at the cost of computing the sort again, unless the sort installs before the host resolves the hide. Then the hide is refused, because its rows moved.
- A new choice drops an Undo or Redo press waiting behind the request in flight. If a choice that replaced earlier ones is refused after the host took it up, the earlier ones are lost with it.

### What may wait

A press waits for the slot holder and for the press before it. The [plan](../plans/window-queue.md) names the other exceptions to N1 to N4:

- the work before Save's, a header change's, and a replay's irreversible part, which its stage X1 measures;
- choices on other sheets and during other work stay refused until their stages are built;
- a replay that needs a session waits behind this window's view request;
- edits and other gestures stay refused during this window's own view request (the user's decision);
- Save stays refused while a view request is in flight;
- a paste run, a session claim, a row admission, and a highlight, size, or column write cannot be cancelled;
- a press, and the sort and filter controls, wait for the saved-view restore.

### What stays as it is

- The 5 s bound and the reasons a waiting press gives.
- Cancel drops a waiting press silently, and the opposite direction cancels both.
- The reopen and reload fences. An idle session's release and the saved-view restore still run under the reopen fence, and the bridge's publication fence is unchanged.
- The host's lease, compare-and-swap, and refresh order.
- The wording of every message.

### What goes

The queue's first stage replaces the press slots and the drain with queue items. That removes bookkeeping, not gate conditions. Each condition becomes a predicate of the slot, over the same refs, as its channel moves in. Gesture tickets and press epochs go when gestures and pastes hold the slot. `history-press-model.ts` goes last.
