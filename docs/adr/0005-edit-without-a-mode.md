# Edit without a mode: the editing session follows unsaved work

A file that can be edited accepts an editing gesture as it is. There is no Edit button and no edit mode: typing, a double click, Delete, a paste, the add-row launcher, and the row and column menus all act on the first use, and the toolbar's Save button writes the result. The editing session the host needs behind those gestures still exists, but nobody sees it. The grid acquires it on the first gesture, holds the gesture until the host grants it, and then runs it. The session is released as soon as it holds nothing: no unsaved change on any worksheet, no open editor, menu, or dialog, and nothing in flight that would add one.

The mode existed to keep stray keystrokes from changing cells. It cost more than it protected: a person who wanted to change a value had to find the button first, and to save had to know that pressing it again was how. Unsaved changes were already drafts, visible, undoable, and discardable, which is the protection that matters.

## Considered options

- **Hold a session whenever an editable file is open.** Every gesture would then work with no hand-off. Rejected because a session is exclusive and changes how viewing behaves: it freezes the row order, locks the Header Row, and leaves every other panel on the same file unable to sort or filter. Those are right while changes are unsaved and wrong for a file that is only being read.
- **Hold a clean session while the panel has focus, and release it on blur.** Fewer hand-offs than acquiring per gesture, but the viewing behaviour above would still depend on which panel was clicked last, for no edit anyone made.
- **Acquire on the gesture and keep the session until the window closes.** Rejected for the same reason: one cancelled editor would change how the file behaves for the rest of the day.

## Consequences

- Viewing an editable file runs the same code as viewing a read-only one. The only difference is that its cells answer an editing gesture, which costs one shared object per painted cell.
- A gesture made before the session exists is held and replayed, so each kind of gesture has one hand-off point: the editor open request, the batch of cell edits, paste admission, the menus (which acquire quietly as they open), row and column drags, the move shortcuts, and the add-row launcher. A new editing gesture needs one too.
- Acquisition happens per burst of editing rather than once per sitting, so its cost is felt. A session that starts with nothing to publish publishes nothing, and the host waits out its own release before answering the next request.
- In a file that can be edited, a letter key edits the selected cell, so `h`/`j`/`k`/`l` navigate only in read-only files.
- Discard is a toolbar button with no confirmation. It is undoable, and the undo has to work on the first press.
- The "Leave edit mode?" dialog and its message pair are gone. Closing a window never asked; drafts persist and come back with the file.
