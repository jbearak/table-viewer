# Undo and redo in other editors

## Question

We are deciding whether to restructure Table Viewer's undo and redo. Today each gesture records before/after deltas. Replay goes through an async host prepare and commit with a lease and a compare-and-swap (`src/history-replay-protocol.ts`). Undo and Redo also wait separately on every other async operation in the window: sorts and filters installing, header-row changes, saves, external-file refreshes and editing-session hand-offs (`history_press_gate` in `src/webview/history-press-model.ts`). Most recent bugs were races between those paths.

The proposal is one ordered queue per window. Every document-changing operation would go through it, Undo and Redo included, and run one at a time.

For LibreOffice Calc, Excel, Google Sheets, Gnumeric, VS Code's `UndoRedoService`, ProseMirror and CodeMirror 6, this note asks:

1. Which actions are undoable, especially sorts, filters, hidden rows and columns, sizes, header or freeze settings, and pure view state?
2. Is history a stack of commands, inverse operations, snapshots or transactions, and how are actions grouped?
3. How does undo interact with work still in flight? Is it refused, queued or held, and what serializes document mutations?
4. Does Save keep history, and what happens to history when the file changes on disk?
5. In collaborative models, are operations ordered by one log or coordinated per path?

Source code links are pinned to the commits read on 2026-11-16:

- VS Code `50105fed42c1`
- LibreOffice core `52423fad8a95`
- Gnumeric `bddd13a9cbc8`
- prosemirror-history `445409bc99c8`, prosemirror-collab `7736c6c9ad44`
- @codemirror/commands `5b9bac974f2c`, @codemirror/collab `886bed4e1c1d`

## Short answer

Every desktop editor here runs Undo synchronously on one thread. LibreOffice dispatches it from the main thread's slot handler. Gnumeric calls the command's undo function and returns when it is done. ProseMirror and CodeMirror build one transaction and dispatch it. A press of Undo can't land in the middle of another document change, because no document change in these tools spans an await. In effect the event loop is the queue.

The one async undo design here is VS Code's `UndoRedoService`, and it is the one that has to deal with our problem. It does not queue a second press. It locks the resource's stack while an async undo or redo runs and refuses another undo or redo with a warning. Its multi-file undo re-checks the stack after every await, which is close to our compare-and-swap.

LibreOffice's UNO undo manager, used by extensions and scripts, does use an explicit FIFO. Every request to the undo manager (undo, redo, add action, enter or leave a context, clear) goes through one queue and runs one at a time. When one fails, it cancels the rest.

The collaborative systems (Google Docs and Sheets, ProseMirror collab, CodeMirror collab) all use one ordered log held by a central authority. None coordinates per path. Clients keep their unconfirmed local changes and rebase them when the authority's order arrives. The history plugins record remote changes as mappings that can't be undone, not as entries that block undo.

## LibreOffice Calc

### What is undoable

Calc records sort, standard filter and autofilter, column width, row height, and hiding or showing rows and columns as undo actions.

- Sort records an `sc::UndoSort` holding a `ReorderParam`, the permutation that `ScDocument::Sort` fills in. Undo runs the reorder backwards; nothing is snapshotted. See [`SortOperation.cxx` L203-L260](https://github.com/LibreOffice/core/blob/52423fad8a952deb9160f1c0ed73af5d567441c4/sc/source/ui/operation/SortOperation.cxx#L203-L260) and [`undosort.cxx` `UndoSort::Undo`/`Execute` L27-L41](https://github.com/LibreOffice/core/blob/52423fad8a952deb9160f1c0ed73af5d567441c4/sc/source/ui/undo/undosort.cxx#L27-L41).
- A filter (`QueryOperation`) copies the affected sheet's row and column flags into an undo document (`ScDocument(SCDOCMODE_UNDO)`) and records an `ScUndoQuery`. That is a snapshot. See [`QueryOperation.cxx` L176-L201 and L360-L364](https://github.com/LibreOffice/core/blob/52423fad8a952deb9160f1c0ed73af5d567441c4/sc/source/ui/operation/QueryOperation.cxx#L176-L201). `ScUndoAutoFilter` is a separate action class ([`undodat.hxx` L286](https://github.com/LibreOffice/core/blob/52423fad8a952deb9160f1c0ed73af5d567441c4/sc/source/ui/inc/undodat.hxx#L286)).
- Widths, heights and hiding share one path. `ScDocFunc::SetWidthOrHeight` treats a size of 0 in `SC_SIZE_DIRECT` mode as hide (`bool bShow = nSizeTwips > 0 || eMode != SC_SIZE_DIRECT`) and records one `ScUndoWidthOrHeight`. See [`docfunc.cxx` L1622, L1678, L1776](https://github.com/LibreOffice/core/blob/52423fad8a952deb9160f1c0ed73af5d567441c4/sc/source/ui/docshell/docfunc.cxx#L1622-L1780) and the mode comments in [`global.hxx` L377-L381](https://github.com/LibreOffice/core/blob/52423fad8a952deb9160f1c0ed73af5d567441c4/sc/inc/global.hxx#L377-L381) ("set size or hide if value is 0").
- Freeze panes is view state. `ScTabView::FreezeSplitters` reads and writes split modes on `aViewData` (`ScViewData`, the per-view object) and creates no undo action ([`tabview.cxx` L2130-L2145](https://github.com/LibreOffice/core/blob/52423fad8a952deb9160f1c0ed73af5d567441c4/sc/source/ui/view/tabview.cxx#L2130-L2145)). I found no source comment saying why. The state lives on the view, not the document, and Calc's undo manager belongs to the document.
- I did not find zoom, scroll or selection in any Calc undo action. No source comment explains this.

### Structure and grouping

`SfxUndoManager` ([`svl/source/undo/undo.cxx`](https://github.com/LibreOffice/core/blob/52423fad8a952deb9160f1c0ed73af5d567441c4/svl/source/undo/undo.cxx)) keeps an array of `SfxUndoAction` command objects with a current index. Each action implements `Undo()` and `Redo()`. Calc's actions mix inverse operations (sort) and snapshots (filter flags, undo documents for cell ranges).

Grouping works two ways. `EnterListAction`/`LeaveListAction` nest actions into one list action ([L1011-L1089](https://github.com/LibreOffice/core/blob/52423fad8a952deb9160f1c0ed73af5d567441c4/svl/source/undo/undo.cxx#L1011-L1089)). `AddUndoAction(..., bTryMerge)` can merge a new action into the top one through `SfxUndoAction::Merge` ([L619-L650](https://github.com/LibreOffice/core/blob/52423fad8a952deb9160f1c0ed73af5d567441c4/svl/source/undo/undo.cxx#L619-L650)).

### Concurrency

`SfxUndoManager::ImplUndo` runs synchronously ([L753-L830](https://github.com/LibreOffice/core/blob/52423fad8a952deb9160f1c0ed73af5d567441c4/svl/source/undo/undo.cxx#L753-L830)). It sets `mbDoing`, asserts `!IsDoing() && "SfxUndoManager::Undo: *nested* Undo/Redo actions? How this?"`, and disables recording with a `LockGuard`, so actions created while undoing are dropped. It refuses to undo inside an open list action (`"SfxUndoManager::Undo: not possible when within a list action!"`). A request to clear the redo stack that arrives during an undo is held and run afterwards: "cannot clear redo while undo/redo is in process. Delay ClearRedo until safe to clear" ([L543-L555](https://github.com/LibreOffice/core/blob/52423fad8a952deb9160f1c0ed73af5d567441c4/svl/source/undo/undo.cxx#L543-L555)).

If an action throws, the manager clears the whole undo stack: "assume the error is a permanent failure, and clear the Undo stack" ([L803-L819](https://github.com/LibreOffice/core/blob/52423fad8a952deb9160f1c0ed73af5d567441c4/svl/source/undo/undo.cxx#L803-L819)). Calc's Undo slot relies on that: "By definition, the UndoManager handled this by clearing the Undo/Redo stacks" ([`tabvwshb.cxx` L839-L843](https://github.com/LibreOffice/core/blob/52423fad8a952deb9160f1c0ed73af5d567441c4/sc/source/ui/view/tabvwshb.cxx#L839-L843)).

The user's Undo key goes through `ScTabViewShell::ExecuteUndo`, which calls `UndoWithContext` in a plain loop ([L746-L854](https://github.com/LibreOffice/core/blob/52423fad8a952deb9160f1c0ed73af5d567441c4/sc/source/ui/view/tabvwshb.cxx#L746-L854)). It takes the undo manager from the top shell on the dispatcher stack (`GetShell(0)`). While a cell is being edited that is the edit shell, so Undo goes to the in-cell text editor's history, not the sheet's. In LibreOfficeKit (Collabora Online, several views on one document), it refuses to undo another view's action unless that action is independent of this view: "If another view created the undo action, prevent undoing it from this view."

Threads are coordinated by the SolarMutex, "the Solar Mutex that prevents other threads from accessing VCL concurrently" ([`svapp.hxx` L513-L523](https://github.com/LibreOffice/core/blob/52423fad8a952deb9160f1c0ed73af5d567441c4/include/vcl/svapp.hxx#L513-L523)). UI slots, including Undo, run on the main thread.

The UNO-facing undo manager (`framework/source/fwe/helper/undomanagerhelper.cxx`), used by scripts and extensions, adds an explicit queue. `impl_processRequest` pushes every request onto `m_aEventQueue`. If another thread is already draining the queue, the caller waits for its own request to finish. Otherwise it drains requests one by one ([L465-L524](https://github.com/LibreOffice/core/blob/52423fad8a952deb9160f1c0ed73af5d567441c4/framework/source/fwe/helper/undomanagerhelper.cxx#L465-L524)). `undo`, `redo`, `addUndoAction`, `enterUndoContext`, `leaveUndoContext`, `clear`, `clearRedo` and `reset` all go through it ([L381-L434](https://github.com/LibreOffice/core/blob/52423fad8a952deb9160f1c0ed73af5d567441c4/framework/source/fwe/helper/undomanagerhelper.cxx#L381-L434), [L913-L927](https://github.com/LibreOffice/core/blob/52423fad8a952deb9160f1c0ed73af5d567441c4/framework/source/fwe/helper/undomanagerhelper.cxx#L913-L927)). When one request fails, the rest are cancelled: "no chance to process further requests, if the current one failed => discard them". Each cancelled caller gets `"Concurrency error: an earlier operation on the stack failed."` ([L176-L183](https://github.com/LibreOffice/core/blob/52423fad8a952deb9160f1c0ed73af5d567441c4/framework/source/fwe/helper/undomanagerhelper.cxx#L176-L183)). An undo through this path throws `UndoContextNotClosedException` if a context is still open ([L632-L633](https://github.com/LibreOffice/core/blob/52423fad8a952deb9160f1c0ed73af5d567441c4/framework/source/fwe/helper/undomanagerhelper.cxx#L622-L640)).

### Save and reload

An ordinary Calc save does not clear history. `ScDocShell` calls `GetUndoManager()->Clear()` in three places only. `Load` (ODF) and `ConvertFrom` (imports such as CSV and XLSX) clear on load ([`docsh.cxx` L654-L676](https://github.com/LibreOffice/core/blob/52423fad8a952deb9160f1c0ed73af5d567441c4/sc/source/ui/docshell/docsh.cxx#L654-L676), [L1241-L1250](https://github.com/LibreOffice/core/blob/52423fad8a952deb9160f1c0ed73af5d567441c4/sc/source/ui/docshell/docsh.cxx#L1241-L1250)). The `SaveDoc` handler clears only for a shared (legacy multi-user) document, after it merges and stores ([L879-L882, L1032](https://github.com/LibreOffice/core/blob/52423fad8a952deb9160f1c0ed73af5d567441c4/sc/source/ui/docshell/docsh.cxx#L879-L1033)). Whether the rest of the sfx2 save path clears history, I did not trace.

File > Reload is a manual command. `SfxViewFrame::ExecReload_Impl` returns early if a reload is already running or the document is in a modal state (`if( m_pImpl->bReloading || pSh->IsInModalMode() ) return;`). If the document is modified, it asks "Cancel all changes?" ([`viewfrm.cxx` L633-L672](https://github.com/LibreOffice/core/blob/52423fad8a952deb9160f1c0ed73af5d567441c4/sfx2/source/view/viewfrm.cxx#L633-L672), [`strings.hrc` L104](https://github.com/LibreOffice/core/blob/52423fad8a952deb9160f1c0ed73af5d567441c4/include/sfx2/strings.hrc#L104)). It then creates a new document shell (`SfxObjectShell::CreateObject`, [L806](https://github.com/LibreOffice/core/blob/52423fad8a952deb9160f1c0ed73af5d567441c4/sfx2/source/view/viewfrm.cxx#L806)). The new shell's `Load` clears its undo manager, so reload starts with empty history. In the code I read, Calc does not watch the file for outside changes.

## Microsoft Excel

Excel is closed source. Everything below comes from Microsoft's own help pages and developer docs.

### What is undoable

Microsoft's undo page says: "You can't undo some actions, such as selecting commands on the File tab or saving a file. If you can't undo an action, the Undo command changes to Can't Undo." It also says "running a macro in Excel will clear the undo stack" ([Undo, redo, or repeat an action](https://support.microsoft.com/en-us/office/foundations-experiences/undo-redo-or-repeat-an-action)).

I found no first-party page that lists whether sort, filter, hide, width, height, freeze panes or zoom are undoable in Excel desktop. The co-authoring docs do treat sort and filter as document changes, not view changes: "In Excel, when one person changes the sort order or filters data, the view changes for everyone who is editing the workbook" ([Work together on Office documents](https://support.microsoft.com/en-us/office/work-together-on-office-documents-ea3807bc-2b73-406f-a8c9-a493de18258b)).

Excel's fix for that is Sheet Views, per-user views that hold their own sort, filter and hidden rows and columns ([Create and manage Sheet Views](https://support.microsoft.com/en-us/excel/create-and-manage-sheet-views-in-excel)). The page says that during co-authoring Excel "asks if you want to apply that sort or filter for just you, or everyone". Cell edits made in a Sheet View still go to the shared workbook.

### Structure and grouping

Microsoft doesn't document the internal structure. The add-in API exposes grouping. `Excel.run({ mergeUndoGroup: true }, ...)` merges a batch into one undo entry. If any API in the group lacks undo support, Excel throws `UndoNotSupported` ([Undo capabilities with the Excel JavaScript API](https://learn.microsoft.com/en-us/office/dev/add-ins/excel/excel-add-ins-undo-capabilities)). The same page says undo is kept "in the *undo stack* for an individual user".

### Concurrency

Microsoft doesn't document how a user's Undo interacts with work in flight. The add-in model does show one ordering rule. Add-in calls are "simply added to a queue of pending commands", and `context.sync()` dispatches the queued batch to Excel ([application-specific API model](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/application-specific-api-model)). When an add-in calls an API without undo support, Excel clears the stack instead of trying to coordinate: "If a particular API doesn't support undo, the application's undo stack is cleared. This means that you won't be able to undo the effects of that API or anything prior to calling that API." The undo-capabilities page lists `Workbook.save`, `Worksheet.delete`, `LinkedWorkbook.refresh` and `DataConnectionCollection.refreshAll` among the APIs without undo support.

### Save and reload

Save keeps history: "You can undo changes, even after you have saved, and then save again, as long as you are within the undo limits (By default Office saves the last 100 undoable actions)". The limit can be raised with the `UndoHistory` registry value ([same undo page](https://support.microsoft.com/en-us/office/foundations-experiences/undo-redo-or-repeat-an-action)).

For co-authoring, Microsoft says only: "Because Microsoft 365 automatically saves everyone's changes, the Undo and Redo commands might not work the way you expect" ([Work together on Office documents](https://support.microsoft.com/en-us/office/work-together-on-office-documents-ea3807bc-2b73-406f-a8c9-a493de18258b)). I found no first-party description of what Excel desktop does when a local file changes on disk while open.

## Google Sheets

### What is undoable

I found no Google help page that says which Sheets actions Undo covers or whether Undo reverses only your own edits. The help pages do separate shared filters from personal ones. "When you add a filter, anyone with access to your spreadsheet will find the filter too." A filter view, by contrast, "only applies to your view of the spreadsheet" ([Sort & filter your data](https://support.google.com/docs/answer/3540681?hl=en&co=GENIE.Platform%3DDesktop)). So a plain filter is a document change and a filter view is per-user view state, the same split as Excel's Sheet Views.

### Ordering

Google's 2010 posts on the then-new editors, which covered "documents and spreadsheets" ([Working together, even apart](https://cloud.googleblog.com/2010/09/whats-different-about-new-google-docs.html)), describe one revision log per document. "We save your document as a revision log consisting of a list of these changes. When someone edits a document, they're not modifying the underlying characters that represents the document. Instead they are appending their change to the end of the revision log" ([Conflict resolution](https://drive.googleblog.com/2010/09/whats-different-about-new-google-docs_22.html)).

The protocol post says the server keeps "The complete history of all processed changes (called the revision log)". Each client keeps its pending and sent-but-unacknowledged changes, and "we never send more than one pending change at a time. Until Luiz recieves an acknowledgement of his first change, his client will keep all new changes in the pending list" ([Making collaboration fast](https://drive.googleblog.com/2010/09/whats-different-about-new-google-docs.html)). The examples are text edits. These posts describe the 2010 design and may not match Sheets today.

The current Sheets API has the same shape. In `spreadsheets.batchUpdate`, "Requests will be applied in the order they are specified", and the updates are "applied together atomically". Because spreadsheets are collaborative, "it is not guaranteed that the spreadsheet will reflect exactly your changes after this completes", and "Your changes may be altered with respect to collaborator changes" ([batchUpdate reference](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets/batchUpdate)). The Docs API makes the server's role explicit. With `targetRevisionId`, a write is applied against later collaborator changes, "with the Docs server resolving conflicting changes". With `requiredRevisionId`, a stale write is rejected with a 400 ([Docs batchUpdate](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/batchUpdate)).

Save is automatic. Version history restores whole versions ([Find what's changed in a file](https://support.google.com/docs/answer/190843?hl=en&co=GENIE.Platform%3DDesktop)). There is no external-file reload case.

## Gnumeric

### What is undoable

Every user change goes through a `cmd_*` constructor in [`src/commands.c`](https://gitlab.gnome.org/GNOME/gnumeric/-/blob/bddd13a9cbc8b23c67da2036b5db1116eadaabe5/src/commands.c).

- Sort: `CmdSort` stores the permutation and a copy of the old range contents. The first run copies the range and computes the permutation. Redo replays the permutation. Undo pastes the old contents back ([L2234-L2298](https://gitlab.gnome.org/GNOME/gnumeric/-/blob/bddd13a9cbc8b23c67da2036b5db1116eadaabe5/src/commands.c#L2234-2298)).
- Autofilter: `cmd_autofilter_add_remove` and `cmd_autofilter_set_condition` record generic undo/redo closures ([L8546](https://gitlab.gnome.org/GNOME/gnumeric/-/blob/bddd13a9cbc8b23c67da2036b5db1116eadaabe5/src/commands.c#L8546), [L8688-L8713](https://gitlab.gnome.org/GNOME/gnumeric/-/blob/bddd13a9cbc8b23c67da2036b5db1116eadaabe5/src/commands.c#L8688-8713)).
- Hide and show: `CmdColRowHide` ([L2335-L2447](https://gitlab.gnome.org/GNOME/gnumeric/-/blob/bddd13a9cbc8b23c67da2036b5db1116eadaabe5/src/commands.c#L2335-2447)).
- Width and height: `cmd_resize_colrow` saves a `ColRowStateGroup` ([L2120](https://gitlab.gnome.org/GNOME/gnumeric/-/blob/bddd13a9cbc8b23c67da2036b5db1116eadaabe5/src/commands.c#L2110-2135)).
- Zoom is undoable. `CmdZoom` stores each sheet's old zoom factor ([L4939-L5049](https://gitlab.gnome.org/GNOME/gnumeric/-/blob/bddd13a9cbc8b23c67da2036b5db1116eadaabe5/src/commands.c#L4939-5049)), and the View menu's zoom in and zoom out call it ([`wbc-gtk-actions.c` L665-L685](https://gitlab.gnome.org/GNOME/gnumeric/-/blob/bddd13a9cbc8b23c67da2036b5db1116eadaabe5/src/wbc-gtk-actions.c#L665-685)). Zoom is a sheet property here (`g_object_set (sheet, "zoom-factor", ...)`), not a view property.
- Freeze panes is not undoable. A `CmdFreezePanes` exists but sits inside `#if 0` and doesn't compile as written ([L7254-L7317](https://gitlab.gnome.org/GNOME/gnumeric/-/blob/bddd13a9cbc8b23c67da2036b5db1116eadaabe5/src/commands.c#L7254-7317)). The menu action calls `gnm_sheet_view_freeze_panes` directly ([`wbc-gtk-actions.c` L697-L760](https://gitlab.gnome.org/GNOME/gnumeric/-/blob/bddd13a9cbc8b23c67da2036b5db1116eadaabe5/src/wbc-gtk-actions.c#L697-760)). No comment says why.

### Structure and grouping

The workbook holds two singly linked lists of `GnmCommand` objects, `wb->undo_commands` and `wb->redo_commands`. `gnm_command_push_undo` performs a command by calling its `redo_cmd`. If that succeeds, it registers the command, which frees the redo list ([L692-L774](https://gitlab.gnome.org/GNOME/gnumeric/-/blob/bddd13a9cbc8b23c67da2036b5db1116eadaabe5/src/commands.c#L692-774)). Each command carries a size, and `truncate_undo_info` trims the list by total size, not by count ([L602-L680](https://gitlab.gnome.org/GNOME/gnumeric/-/blob/bddd13a9cbc8b23c67da2036b5db1116eadaabe5/src/commands.c#L602-680)). Gnumeric has no time-based merging. A compound command builds its undo by combining `GOUndo` closures (`go_undo_combine`) and registers one `cmd_generic`.

### Concurrency

`command_undo` takes the head of the undo list and calls `klass->undo_cmd (cmd, wbc)` synchronously. If it returns failure, "Leave the command where it is". On success the command moves to the redo list ([L405-L455](https://gitlab.gnome.org/GNOME/gnumeric/-/blob/bddd13a9cbc8b23c67da2036b5db1116eadaabe5/src/commands.c#L405-455)). Choosing an entry deep in the toolbar's undo drop-down just calls `command_undo` that many times in a loop ([`wbc-gtk-actions.c` L4071-L4087](https://gitlab.gnome.org/GNOME/gnumeric/-/blob/bddd13a9cbc8b23c67da2036b5db1116eadaabe5/src/wbc-gtk-actions.c#L4071-4087)). There are no in-flight states to wait on.

### Save and reload

Each command records `state_before_do`, and undo restores it with `go_doc_set_state`. Undoing back to the saved state therefore makes the workbook clean again, and saving doesn't touch the lists ([L433](https://gitlab.gnome.org/GNOME/gnumeric/-/blob/bddd13a9cbc8b23c67da2036b5db1116eadaabe5/src/commands.c#L433), [L759](https://gitlab.gnome.org/GNOME/gnumeric/-/blob/bddd13a9cbc8b23c67da2036b5db1116eadaabe5/src/commands.c#L759)). The lists are freed only when the workbook is disposed ([`workbook.c` L176-L179](https://gitlab.gnome.org/GNOME/gnumeric/-/blob/bddd13a9cbc8b23c67da2036b5db1116eadaabe5/src/workbook.c#L176-179)). A reopened file is a new workbook with empty history. I didn't trace a revert-in-place path.

## VS Code `UndoRedoService`

### What is undoable

The service is generic. Any `IUndoRedoElement` with `undo()` and `redo()` can be pushed for a resource ([`undoRedo.ts` L17-L71](https://github.com/microsoft/vscode/blob/50105fed42c1c4c3c17e90e0accb6f2a8fc58b46/src/vs/platform/undoRedo/common/undoRedo.ts#L17-L71)). Text editors push edit-stack elements. Custom editors push one element per `pushEdit` from the extension ([`mainThreadCustomEditors.ts` L745-L763](https://github.com/microsoft/vscode/blob/50105fed42c1c4c3c17e90e0accb6f2a8fc58b46/src/vs/workbench/api/browser/mainThreadCustomEditors.ts#L745-L763)). That is the path Table Viewer's VS Code build would use if it handed undo to VS Code.

### Structure and grouping

Each resource has a `ResourceEditStack` with `_past`, `_future`, a `locked` flag and a `versionId` ([`undoRedoService.ts` L197-L212](https://github.com/microsoft/vscode/blob/50105fed42c1c4c3c17e90e0accb6f2a8fc58b46/src/vs/platform/undoRedo/common/undoRedoService.ts#L197-L212)). `pushElement` clears the future and bumps `versionId` ([L284-L294](https://github.com/microsoft/vscode/blob/50105fed42c1c4c3c17e90e0accb6f2a8fc58b46/src/vs/platform/undoRedo/common/undoRedoService.ts#L284-L294)). Elements are command objects.

A workspace element spans several resources, may be split into per-resource elements, and may provide `prepareUndoRedo()`: "This is a good place to prepare everything such that the calls to `undo()` or `redo()` are synchronous" ([`undoRedo.ts` L60-L70](https://github.com/microsoft/vscode/blob/50105fed42c1c4c3c17e90e0accb6f2a8fc58b46/src/vs/platform/undoRedo/common/undoRedo.ts#L60-L70)). `UndoRedoGroup` ties elements across resources so they undo in order ([L91-L110](https://github.com/microsoft/vscode/blob/50105fed42c1c4c3c17e90e0accb6f2a8fc58b46/src/vs/platform/undoRedo/common/undoRedo.ts#L91-L110), [`_undo` L1079-L1116](https://github.com/microsoft/vscode/blob/50105fed42c1c4c3c17e90e0accb6f2a8fc58b46/src/vs/platform/undoRedo/common/undoRedoService.ts#L1079-L1116)).

### Concurrency

`undo()` and `redo()` on an element may return a promise. While one runs, the service locks every affected stack ([`_acquireLocks` and `_safeInvokeWithLocks`, L719-L772](https://github.com/microsoft/vscode/blob/50105fed42c1c4c3c17e90e0accb6f2a8fc58b46/src/vs/platform/undoRedo/common/undoRedoService.ts#L719-L772)). A second undo on a locked single-resource stack is refused, not queued ([`_resourceUndo` L1012-L1030](https://github.com/microsoft/vscode/blob/50105fed42c1c4c3c17e90e0accb6f2a8fc58b46/src/vs/platform/undoRedo/common/undoRedoService.ts#L1012-L1030)):

```ts
if (editStack.locked) {
    const message = nls.localize(
        { key: 'cannotResourceUndoDueToInProgressUndoRedo', ... },
        "Could not undo '{0}' because there is already an undo or redo operation running.", element.label
    );
    this._notificationService.warn(message);
    return;
}
```

Redo has the same check with "Could not redo '{0}' because there is already an undo or redo operation running." ([L1300-L1303](https://github.com/microsoft/vscode/blob/50105fed42c1c4c3c17e90e0accb6f2a8fc58b46/src/vs/platform/undoRedo/common/undoRedoService.ts#L1296-L1311)).

The lock blocks only other undo and redo calls. `pushElement` doesn't check it, so new edits can land while an async undo runs.

Multi-resource undo validates before and again after every await, using the stacks' `versionId`s ([`_checkWorkspaceUndo` L829-L904](https://github.com/microsoft/vscode/blob/50105fed42c1c4c3c17e90e0accb6f2a8fc58b46/src/vs/platform/undoRedo/common/undoRedoService.ts#L829-L904), [L982-L1009](https://github.com/microsoft/vscode/blob/50105fed42c1c4c3c17e90e0accb6f2a8fc58b46/src/vs/platform/undoRedo/common/undoRedoService.ts#L982-L1009)). The source comments read "At this point, it is possible that the element has been made invalid in the meantime (due to the confirmation await)" and "(due to the prepare await)". If anything moved, it either splits the element and undoes only this file, with a warning such as "Could not undo '{0}' across all files because an undo or redo operation occurred in the meantime", or it flushes the stacks.

Errors are not retried. "An error occurred while undoing or redoing => drop the undo/redo stack for all affected resources" ([`_onError` L710-L717](https://github.com/microsoft/vscode/blob/50105fed42c1c4c3c17e90e0accb6f2a8fc58b46/src/vs/platform/undoRedo/common/undoRedoService.ts#L710-L717)).

For custom editors, the bridge moves its edit index before it awaits the extension (`--this._currentEditIndex; await this._proxy.$undo(...)`, [`mainThreadCustomEditors.ts` L771-L803](https://github.com/microsoft/vscode/blob/50105fed42c1c4c3c17e90e0accb6f2a8fc58b46/src/vs/workbench/api/browser/mainThreadCustomEditors.ts#L771-L803)). The service's lock is the only thing that stops a second press while the extension works.

Text files serialize saves with a `TaskSequentializer`: "Never ever must 2 saves execute at the same time because this can lead to dirty writes and race conditions." A save requested while one runs is queued as the next save ([`textFileEditorModel.ts` L896-L916](https://github.com/microsoft/vscode/blob/50105fed42c1c4c3c17e90e0accb6f2a8fc58b46/src/vs/workbench/services/textfile/common/textFileEditorModel.ts#L896-L916)).

### Save and external changes

Save keeps history. The text model records the saved alternative version id. When undo returns to it, the model goes clean: "The contents changed as a matter of Undo and the version reached matches the saved one" ([L707-L725](https://github.com/microsoft/vscode/blob/50105fed42c1c4c3c17e90e0accb6f2a8fc58b46/src/vs/workbench/services/textfile/common/textFileEditorModel.ts#L707-L725)).

When a text file changes on disk and the model is not dirty, VS Code reloads it as an undoable edit. `doUpdateTextModel(content.value, EditSources.reloadFromDisk())` reaches `ModelService.updateModel`, which diffs old against new and applies the diff with `pushEditOperations` between two `pushStackElement()` calls ([`textFileEditorModel.ts` L634-L637](https://github.com/microsoft/vscode/blob/50105fed42c1c4c3c17e90e0accb6f2a8fc58b46/src/vs/workbench/services/textfile/common/textFileEditorModel.ts#L634-L637), [`modelService.ts` L365-L387](https://github.com/microsoft/vscode/blob/50105fed42c1c4c3c17e90e0accb6f2a8fc58b46/src/vs/editor/common/services/modelService.ts#L365-L387)). The reload becomes one entry on the same stack, so the user can undo past it.

A dirty model or one being saved is not reloaded: "it is important that we do not resolve a model that is dirty or is in the process of saving to prevent data loss" ([L306-L313](https://github.com/microsoft/vscode/blob/50105fed42c1c4c3c17e90e0accb6f2a8fc58b46/src/vs/workbench/services/textfile/common/textFileEditorModel.ts#L306-L313)). The conflict surfaces at the next save.

When a file is closed, its stack is kept, within a 20 MB budget, together with a SHA-1 of the content. On reopen, VS Code restores the stack only if the hash matches. Otherwise it restores the initial snapshot, which drops the stale elements ([`modelService.ts` L86, L316-L346, L523-L542](https://github.com/microsoft/vscode/blob/50105fed42c1c4c3c17e90e0accb6f2a8fc58b46/src/vs/editor/common/services/modelService.ts#L316-L346)). Disposing a custom editor document removes its elements ([`mainThreadCustomEditors.ts` L674-L677](https://github.com/microsoft/vscode/blob/50105fed42c1c4c3c17e90e0accb6f2a8fc58b46/src/vs/workbench/api/browser/mainThreadCustomEditors.ts#L674-L677)). Revert moves the custom editor's edit index back to the save point ([L828-L847](https://github.com/microsoft/vscode/blob/50105fed42c1c4c3c17e90e0accb6f2a8fc58b46/src/vs/workbench/api/browser/mainThreadCustomEditors.ts#L828-L847)).

## ProseMirror

### What is undoable and structure

History holds steps, which are inverse operations, not snapshots. The source explains why: "ProseMirror's history isn't simply a way to roll back to a previous state, because ProseMirror supports applying changes without adding them to the history (for example during collaboration)." Each branch keeps items that "can optionally hold a step (an actual undoable change), and always hold a position map" ([`history.ts` L5-L19](https://github.com/ProseMirror/prosemirror-history/blob/445409bc99c88550c2312f5610829ecb25105a5f/src/history.ts#L5-L19)).

A transaction with `addToHistory: false` adds only its maps, so earlier steps are mapped over it when undone ([`applyTransaction` L259-L298](https://github.com/ProseMirror/prosemirror-history/blob/445409bc99c88550c2312f5610829ecb25105a5f/src/history.ts#L259-L298)). The guide calls this "selective undo, which is more complicated than just rolling back to a previous state" ([ProseMirror guide](https://prosemirror.net/docs/guide/)).

Selection is restored on undo through a bookmark stored with the first item of each event. Selection changes alone are not undo events. Scroll and zoom are outside the document model.

Grouping is by time and adjacency. "The delay between changes after which a new group should be started. Defaults to 500 (milliseconds). Note that when changes aren't adjacent, a new group is always started." Depth defaults to 100 ([L373-L393](https://github.com/ProseMirror/prosemirror-history/blob/445409bc99c88550c2312f5610829ecb25105a5f/src/history.ts#L373-L393)). `closeHistory(tr)` forces a boundary.

### Concurrency

`undo` is a command that builds one transaction from the history state and dispatches it synchronously ([`buildCommand` L423-L433](https://github.com/ProseMirror/prosemirror-history/blob/445409bc99c88550c2312f5610829ecb25105a5f/src/history.ts#L423-L433), [`histTransaction` L331-L343](https://github.com/ProseMirror/prosemirror-history/blob/445409bc99c88550c2312f5610829ecb25105a5f/src/history.ts#L331-L343)). State is immutable, and every change, including undo, is a transaction applied in dispatch order. There is no in-flight state for undo to wait on. Anything async, such as network sync, finishes by dispatching a transaction.

### Collaboration

ProseMirror's collab "employs a central authority which determines in which order changes are applied. If two editors make changes concurrently, they will both go to this authority with their changes. The authority will accept the changes from one of them, and broadcast these changes to all editors." The other editor must "rebase its local changes on top of those from the other editor, and try to submit them again" ([guide, Collaborative editing](https://prosemirror.net/docs/guide/#collab)). The sample authority rejects any submission not based on its current version: `if (version != this.steps.length) return`.

On the client, `receiveTransaction` confirms its own steps, rebases the rest over the remote steps, and marks the transaction `rebased` and `addToHistory: false` ([`collab.ts` L102-L151](https://github.com/ProseMirror/prosemirror-collab/blob/7736c6c9ad4407af2678112a1cad82c1d3c53dcf/src/collab.ts#L102-L151)). The collab plugin sets `historyPreserveItems: true` "to notify the history plugin to not merge steps, so that the history can be rebased" ([L93-L95](https://github.com/ProseMirror/prosemirror-collab/blob/7736c6c9ad4407af2678112a1cad82c1d3c53dcf/src/collab.ts#L93-L95)). The history then rewrites its own items to match ([`Branch.rebased`, history.ts L128-L165](https://github.com/ProseMirror/prosemirror-history/blob/445409bc99c88550c2312f5610829ecb25105a5f/src/history.ts#L128-L165)). Undo only ever reverts this client's changes, mapped through everyone else's.

## CodeMirror 6

### What is undoable and structure

`@codemirror/commands` history is a state field. Each `HistEvent` stores the inverted change set, any inverted effects, the start selection and later selections ([`history.ts` L156-L212](https://github.com/codemirror/commands/blob/5b9bac974f2c4af3e20b045adef949667872ecad/src/history.ts#L156-L212)). Non-document state joins undo only when a plugin opts in through `invertedEffects`, a facet of functions that "provide a set of effects that the history should store when inverting the transaction" ([L16-L21](https://github.com/codemirror/commands/blob/5b9bac974f2c4af3e20b045adef949667872ecad/src/history.ts#L16-L21)). So view or UI state is out of undo unless a plugin opts in.

Selection gets its own commands. `undo` skips selection-only events, and `undoSelection` (Mod-u) steps through them ([L129-L140](https://github.com/codemirror/commands/blob/5b9bac974f2c4af3e20b045adef949667872ecad/src/history.ts#L129-L140), [`pop` L355-L382](https://github.com/codemirror/commands/blob/5b9bac974f2c4af3e20b045adef949667872ecad/src/history.ts#L355-L382), [keymap L387-L399](https://github.com/codemirror/commands/blob/5b9bac974f2c4af3e20b045adef949667872ecad/src/history.ts#L387-L399)).

Grouping uses `newGroupDelay` (500 ms), `joinToEvent` (adjacency by default), `minDepth` (100) and the `isolateHistory` annotation ("before", "after" or "full") ([L10-L45](https://github.com/codemirror/commands/blob/5b9bac974f2c4af3e20b045adef949667872ecad/src/history.ts#L10-L45)). A transaction annotated `Transaction.addToHistory.of(false)` only adds a mapping ([L71-L72](https://github.com/codemirror/commands/blob/5b9bac974f2c4af3e20b045adef949667872ecad/src/history.ts#L55-L83)).

### Concurrency

Like ProseMirror, undo builds one transaction and dispatches it synchronously ([`cmd` L118-L127](https://github.com/codemirror/commands/blob/5b9bac974f2c4af3e20b045adef949667872ecad/src/history.ts#L118-L127)). Read-only state blocks it (`if (!selection && state.readOnly) return false`). Nothing is held or queued.

### Collaboration

CodeMirror's collab uses "operational transformation with a central authority (server) that assigns a definite order to the changes". A peer sends its unconfirmed changes with its synced version: "If that version matches the server's version, the server accepts the changes as-is and adds them to its history. Otherwise, the server can ... either reject the updates, or rebase and accept them." The guide warns that a peer which keeps getting rejected can starve, "Thus, it is recommended to rebase updates whenever practical" ([collab example](https://codemirror.net/examples/collab/)). On the client, `receiveUpdates` confirms its own updates, rebases unconfirmed ones, and tags remote changes `Transaction.addToHistory.of(false)` and `Transaction.remote.of(true)` ([`collab.ts` L84-L131](https://github.com/codemirror/collab/blob/886bed4e1c1d77e77a12bfc3004bf4d08d96cc85/src/collab.ts#L84-L131)).

## Summary table

"Not documented" means I found no first-party source, not that the feature is missing.

| | Sort, filter, hide, size undoable? | Freeze, zoom, selection | Undo pressed while busy | Undo fails | Save | File changes outside |
|---|---|---|---|---|---|---|
| Calc | Yes. Sort as inverse, filter as snapshot | Freeze on the view, not recorded. No zoom undo found | Can't happen, Undo is synchronous on the main thread. UNO path queues FIFO | Undo stack cleared | Keeps history. Shared-document save clears | Manual reload builds a new document with empty history |
| Excel | Not documented. Sort and filter change the sheet for all co-authors. Sheet Views hold per-user sort, filter, hide | Not documented | Not documented | Unsupported add-in API clears the stack | Keeps history, undo past save works | Not documented |
| Sheets | Not documented. Filters are shared, filter views are per-user | Not documented | Server log orders all edits | Not documented | Autosave | Not applicable |
| Gnumeric | Yes. Sort as permutation plus old contents | Zoom recorded. Freeze not recorded | Can't happen, Undo is synchronous | Command stays on the undo list | Keeps history. Undo to the saved state marks clean | Reopen gives a new workbook with empty history |
| VS Code service | Whatever the editor pushes | Text undo restores the selection, no separate entry | Second undo or redo refused with a warning. Multi-file undo re-checks after each await | Stacks of affected resources dropped | Keeps history. Undo to the saved version marks clean | Clean text model: reload is one undoable edit. Dirty model: not reloaded |
| ProseMirror | Not applicable | Selection restored, no separate entry | Can't happen, dispatch is synchronous | Not applicable | Not applicable | Remote changes mapped through history, not undoable |
| CodeMirror | Not applicable | Selection has its own undo commands. Other state only through `invertedEffects` | Can't happen, dispatch is synchronous | Not applicable | Not applicable | Same as ProseMirror |

## What this means for Table Viewer

The evidence supports one serialized queue per window. Every desktop tool here gets that property for free, because Undo and every other document change run to completion on one thread. Table Viewer can't, because a sort, a save, a header change or a replay spans awaits on the host. A queue rebuilds that guarantee across the await. The closest precedents are LibreOffice's UNO undo manager, which runs undo, redo, add-action and clear requests through one FIFO, and VS Code's text-file saves, which are serialized "because this can lead to dirty writes and race conditions."

The queue only helps if it is the single path. In LibreOffice, VS Code text, ProseMirror and CodeMirror, external changes (remote steps, reload from disk) don't bypass the history. They enter the same order as ordinary changes and are recorded either as undoable edits (VS Code's reload) or as non-undoable mappings (ProseMirror, CodeMirror). If Table Viewer's refreshes, session hand-offs and saves stay outside the queue, `history_press_gate` will still need its separate waits.

On a press of Undo while something runs, the tools split three ways. Synchronous tools never face the case. VS Code refuses a second undo or redo with a warning. LibreOffice's UNO path queues and blocks the caller. Table Viewer's 5-second hold-then-message sits between those. A queue makes holding the natural behaviour, since the press is simply the next item. The bound still matters, and VS Code's refuse-with-warning is the precedent for answering instead of waiting.

What the other tools do that Table Viewer doesn't:

- **Failure clears the history.** When an undo throws, LibreOffice clears the undo stack and VS Code drops the stacks of every affected resource. Excel clears the stack whenever an add-in calls an API without undo support. None of them retries or partially recovers. That's cruder than our lease and compare-and-swap, but it leaves no state where history and document disagree.
- **Each external change has one fixed fate.** VS Code turns a clean reload into one undoable edit, and declines to reload a dirty model. LibreOffice and Gnumeric start a new document with empty history. ProseMirror and CodeMirror map history over remote changes. None tries to keep history valid across an outside change by checking the file's bytes at undo time, as our lease's "physical currency" check does.
- **View state is kept separate.** Calc keeps freeze panes on the view and never records it. Gnumeric records zoom but not freeze. CodeMirror keeps selection on its own commands. Excel and Sheets treat plain sort and filter as shared document changes, and for per-user arrangements they add a separate object (Sheet Views, filter views) rather than per-user undo. Table Viewer records sort, filter and hide as view steps inside the same history. That's defensible for a single-user app, but it is the one category none of these tools mixes into the document's undo stack and also runs asynchronously.
- **Grouping is explicit.** Calc has list actions and `Merge`, VS Code has `UndoRedoGroup`, Excel has `mergeUndoGroup`, and ProseMirror and CodeMirror group by a 500 ms delay plus adjacency, with `closeHistory` and `isolateHistory` to force a boundary.
- **Undo during a list action or in-cell edit is redirected or refused.** Calc refuses to undo inside an open list action, and routes Undo to the cell editor's own history while a cell is being edited.

What Table Viewer does that they don't:

- It holds a press for a bounded time and tells the user which operation it waits on. None of the tools names a reason except VS Code's "already an undo or redo operation running".
- It re-verifies the file on disk before a replay commits. None of the tools does this at undo time. VS Code's nearest equivalent is the SHA-1 check when it restores a closed file's stack.
- It replays undo across a process boundary with a prepare/commit lease. VS Code's `prepareUndoRedo` plus re-validation after the await is the only comparable design, and VS Code limits it to multi-file elements.

The collaborative systems point the same way. Google, ProseMirror and CodeMirror order every change through one log per document and make clients rebase, never coordinating per path. Google's 2010 client also kept at most one unacknowledged batch in flight. That is the same discipline a per-window queue would give Table Viewer between the webview and the host.
